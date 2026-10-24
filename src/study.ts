import type { StudyBatch, User } from '../shared/types';
import type { Env } from './index';
import { type CardRow, columns, fromRow } from './cards';
import { methods } from './http';

// The time a card is ready again: 10 minutes after a miss. After a correct answer, the wait depends on the score
// (correct answers minus 2 for each miss, from 0 to 6): 4 hours, then 1, 3, 7, 14, 30 and 60 days.
const withProgress = `WITH progress AS (SELECT card_id, correct, incorrect, last_correct_at, last_incorrect_at, version,
	CASE WHEN last_incorrect_at >= coalesce(last_correct_at, 0) THEN last_incorrect_at + 600000
	ELSE last_correct_at + 3600000 * CASE max(0, min(6, correct - 2 * incorrect))
		WHEN 0 THEN 4 WHEN 1 THEN 24 WHEN 2 THEN 72 WHEN 3 THEN 168 WHEN 4 THEN 336 WHEN 5 THEN 720 ELSE 1440 END END AS due_at
	FROM card_progress WHERE user_id = ?1)`;

export async function getStudyBatch(env: Env, userId: string, now: number): Promise<StudyBatch> {
	const [queue, future] = await env.DB.batch([
		// Cards with more misses per correct answer come first. A new card counts as one miss per correct answer.
		env.DB.prepare(`${withProgress} SELECT ${columns},
			CASE WHEN p.version IS NULL THEN NULL ELSE json_object('correct', p.correct, 'incorrect', p.incorrect,
				'lastCorrectAt', p.last_correct_at, 'lastIncorrectAt', p.last_incorrect_at, 'version', p.version) END AS progress
			FROM cards LEFT JOIN progress p ON p.card_id = cards.id
			WHERE cards.archived = 0 AND coalesce(p.due_at, 0) <= ?2
			ORDER BY (coalesce(p.incorrect, 0) + 1.0) / (coalesce(p.correct, 0) + 1) DESC, coalesce(p.due_at, cards.created_at), cards.id LIMIT 10`)
			.bind(userId, now),
		env.DB.prepare(`${withProgress} SELECT count(*) FILTER (WHERE coalesce(p.due_at, 0) <= ?2) AS dueCount,
			min(p.due_at) FILTER (WHERE p.due_at > ?2) AS nextDueAt
			FROM cards LEFT JOIN progress p ON p.card_id = cards.id WHERE cards.archived = 0`).bind(userId, now),
	]);
	const cards = (queue.results as (CardRow & { progress: string | null })[]).map(({ progress, ...row }) => ({
		card: fromRow(row),
		progress: progress === null ? null : JSON.parse(progress),
	}));
	const { dueCount, nextDueAt } = future.results[0] as { dueCount: number; nextDueAt: number | null };
	return { cards, dueCount, serverTime: now, nextDueAt };
}

export async function handleStudy(request: Request, env: Env, user: User): Promise<Response> {
	methods(request, ['GET']);
	return Response.json(await getStudyBatch(env, user.id, Date.now()));
}
