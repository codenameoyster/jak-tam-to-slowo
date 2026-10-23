import type { Direction, StudyBatch, User } from '../shared/types';
import type { Env } from './index';
import { type CardRow, columns, fromRow } from './cards';
import { HttpError, methods, uuidPattern } from './http';

export async function getStudyBatch(env: Env, userId: string, direction: Direction, exclude: string[], limit: number, now: number): Promise<StudyBatch> {
	if (exclude.length > 10 || exclude.some(id => !uuidPattern.test(id))) {
		throw new HttpError(400, 'invalid_input', 'Укажите не больше десяти идентификаторов карточек.');
	}
	const excluded = JSON.stringify(exclude);
	const [queue, future] = await env.DB.batch([
		env.DB.prepare(`SELECT ${columns},
			CASE WHEN s.version IS NULL THEN NULL ELSE json_object('stage', s.stage, 'dueAt', s.due_at,
				'version', s.version, 'lastReviewedAt', s.last_reviewed_at) END AS progress
			FROM cards LEFT JOIN review_state s ON s.card_id = cards.id AND s.user_id = ?1 AND s.direction = ?2
			WHERE cards.archived = 0 AND cards.id NOT IN (SELECT value FROM json_each(?4)) AND (s.version IS NULL OR s.due_at <= ?3)
			ORDER BY CASE WHEN s.version IS NULL THEN 2 WHEN s.stage = 0 THEN 0 ELSE 1 END,
				coalesce(s.due_at, cards.created_at), cards.id LIMIT ?5`)
			.bind(userId, direction, now, excluded, Math.max(1, Math.min(10, limit))),
		env.DB.prepare(`SELECT min(s.due_at) AS nextDueAt FROM review_state s JOIN cards c ON c.id = s.card_id
			WHERE s.user_id = ?1 AND s.direction = ?2 AND s.due_at > ?3
			AND c.archived = 0 AND c.id NOT IN (SELECT value FROM json_each(?4))`)
			.bind(userId, direction, now, excluded),
	]);
	const cards = (queue.results as (CardRow & { progress: string | null })[]).map(({ progress, ...row }) => ({
		card: fromRow(row),
		progress: progress === null ? null : JSON.parse(progress),
	}));
	const { nextDueAt } = future.results[0] as { nextDueAt: number | null };
	return { cards, serverTime: now, nextDueAt };
}

export async function handleStudy(request: Request, env: Env, user: User): Promise<Response> {
	methods(request, ['GET']);
	const params = new URL(request.url).searchParams;
	const direction = params.get('direction') ?? user.direction;
	const limitText = params.get('limit');
	const limit = limitText === null ? 10 : Number(limitText);
	if ((direction !== 'ru-pl' && direction !== 'pl-ru') || limitText?.trim() === '' || !Number.isSafeInteger(limit)) {
		throw new HttpError(400, 'invalid_input', 'Проверьте направление и число карточек.');
	}
	const exclude = params.get('exclude');
	return Response.json(await getStudyBatch(env, user.id, direction, exclude ? exclude.split(',') : [], limit, Date.now()));
}
