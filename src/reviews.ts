import type { GradeResult, ReviewInput, ReviewResult, User } from '../shared/types';
import type { Env } from './index';
import { type CardRow, columns, fromRow } from './cards';
import { gradeAnswer } from './grade';
import { HttpError, methods, object, readJson, uuidPattern } from './http';
import { advance } from './schedule';

interface ReviewRow { input_json: string; result_json: string }
interface StateRow { stage: number; version: number }

function identity(input: ReviewInput): string {
	return JSON.stringify({
		cardId: input.cardId, cardVersion: input.cardVersion, progressVersion: input.progressVersion,
		direction: input.direction, action: input.action, ...(input.action === 'answer' ? { answer: input.answer } : {}),
	});
}

function replay(row: ReviewRow | undefined, input: ReviewInput): ReviewResult | null {
	if (!row) return null;
	if (row.input_json !== identity(input)) throw new HttpError(409, 'review_conflict', 'Эта попытка уже сохранена с другим ответом.');
	return JSON.parse(row.result_json);
}

export async function commitReview(env: Env, userId: string, input: ReviewInput, current: StateRow | undefined, grade: GradeResult, source: ReviewResult['source'], now: number): Promise<ReviewResult> {
	const progress = { ...advance(current?.stage ?? 0, grade.grade, now), version: input.progressVersion + 1, lastReviewedAt: now };
	const result: ReviewResult = { ...grade, attemptId: input.attemptId, cardId: input.cardId, direction: input.direction, source, progress };
	const [, , saved] = await env.DB.batch<ReviewRow>([
		env.DB.prepare(`INSERT INTO review_state (user_id, card_id, direction, stage, due_at, version, last_reviewed_at)
			SELECT ?1, ?2, ?3, ?6, ?7, ?5 + 1, ?8
			WHERE ?10 = ?5
			AND EXISTS (SELECT 1 FROM cards WHERE id = ?2 AND version = ?4 AND archived = 0)
			AND NOT EXISTS (SELECT 1 FROM reviews WHERE user_id = ?1 AND attempt_id = ?9)
			AND (?5 = 0 OR EXISTS (SELECT 1 FROM review_state WHERE user_id = ?1 AND card_id = ?2 AND direction = ?3))
			ON CONFLICT (user_id, card_id, direction) DO UPDATE SET stage = excluded.stage, due_at = excluded.due_at,
				version = excluded.version, last_reviewed_at = excluded.last_reviewed_at
			WHERE review_state.version = ?5`)
			.bind(userId, input.cardId, input.direction, input.cardVersion, input.progressVersion,
				progress.stage, progress.dueAt, now, input.attemptId, current?.version ?? 0),
		// changes() reads the preceding write count: https://www.sqlite.org/lang_corefunc.html#changes
		env.DB.prepare(`INSERT INTO reviews (user_id, attempt_id, input_json, result_json)
			SELECT ?1, ?2, ?3, ?4 WHERE changes() = 1`).bind(userId, input.attemptId, identity(input), JSON.stringify(result)),
		env.DB.prepare('SELECT input_json, result_json FROM reviews WHERE user_id = ? AND attempt_id = ?').bind(userId, input.attemptId),
	]);
	const stored = replay(saved.results[0], input);
	if (!stored) throw new HttpError(409, 'version_conflict', 'Карточка или результат уже изменены. Откройте следующую карточку.');
	return stored;
}

export async function handleReview(request: Request, env: Env, user: User): Promise<Response> {
	methods(request, ['POST']);
	const data = object(await readJson(request), ['attemptId', 'cardId', 'cardVersion', 'progressVersion', 'direction', 'action', 'answer']);
	const { attemptId, cardId, cardVersion, progressVersion, direction, action, answer } = data;
	if (typeof attemptId !== 'string' || !uuidPattern.test(attemptId) || typeof cardId !== 'string' || !uuidPattern.test(cardId)
		|| typeof cardVersion !== 'number' || !Number.isSafeInteger(cardVersion) || cardVersion < 1
		|| typeof progressVersion !== 'number' || !Number.isSafeInteger(progressVersion) || progressVersion < 0
		|| (direction !== 'ru-pl' && direction !== 'pl-ru')) throw new HttpError(400, 'invalid_input', 'Проверьте карточку, версию и направление.');
	const base = { attemptId, cardId, cardVersion, progressVersion };
	let input: ReviewInput;
	if (action === 'answer' && typeof answer === 'string' && answer.length <= 500) input = { ...base, direction, action, answer };
	else if (action === 'reveal' && !('answer' in data)) input = { ...base, direction, action };
	else throw new HttpError(400, 'invalid_input', 'Укажите ответ или выберите показ ответа.');
	const [review, row, state] = await env.DB.batch([
		env.DB.prepare('SELECT input_json, result_json FROM reviews WHERE user_id = ? AND attempt_id = ?').bind(user.id, attemptId),
		env.DB.prepare(`SELECT ${columns} FROM cards WHERE id = ?`).bind(cardId),
		env.DB.prepare('SELECT stage, version FROM review_state WHERE user_id = ? AND card_id = ? AND direction = ?').bind(user.id, cardId, direction),
	]);
	const saved = replay(review.results[0] as ReviewRow | undefined, input);
	if (saved) return Response.json(saved);
	if (!row.results[0]) throw new HttpError(404, 'not_found', 'Карточка не найдена.');
	const card = fromRow(row.results[0] as CardRow);
	if (card.archived || card.version !== cardVersion) throw new HttpError(409, 'version_conflict', 'Карточка уже изменена. Откройте следующую карточку.');
	let graded: { result: GradeResult; source: ReviewResult['source'] };
	try {
		graded = input.action === 'answer' ? await gradeAnswer(env, card, direction, input.answer) : {
			result: { grade: 'again', correction: direction === 'ru-pl' ? card.pl : card.ru, explanationRu: 'Повторите слово.' }, source: 'reveal',
		};
	} catch (error) {
		if (!(error instanceof HttpError)) throw error;
		return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'X-Review-Recovery': 'editable' } });
	}
	return Response.json(await commitReview(env, user.id, input, state.results[0] as StateRow | undefined, graded.result, graded.source, Date.now()));
}
