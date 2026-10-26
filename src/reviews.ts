import type { CompetitionContribution, GradeResult, Progress, ReviewInput, ReviewResult, User } from '../shared/types';
import type { Env } from './index';
import { type CardRow, columns, fromRow } from './cards';
import { gradeAnswer } from './grade';
import { HttpError, methods, object, readJson, uuidPattern } from './http';

type ReviewRow = { input_json: string; result_json: string } & (CompetitionContribution | { competitionId: null });

const selectReview = `SELECT r.input_json, r.result_json, e.competition_id AS competitionId, e.delta, e.score_after AS scoreAfter, e.version
	FROM reviews r LEFT JOIN competition_events e ON e.user_id = r.user_id AND e.attempt_id = r.attempt_id
	WHERE r.user_id = ? AND r.attempt_id = ?`;

function identity(input: ReviewInput): string {
	return JSON.stringify({
		cardId: input.cardId, cardVersion: input.cardVersion, progressVersion: input.progressVersion,
		direction: input.direction, action: input.action, ...(input.action === 'answer' ? { answer: input.answer } : {}),
		...(input.competitionId === undefined ? {} : { competitionId: input.competitionId }),
	});
}

function replay(row: ReviewRow | undefined, input: ReviewInput): ReviewResult | null {
	if (!row) return null;
	if (row.input_json !== identity(input)) throw new HttpError(409, 'review_conflict', 'Ta próba jest już zapisana z inną odpowiedzią.');
	return { ...JSON.parse(row.result_json), competition: row.competitionId === null ? null : {
		competitionId: row.competitionId, delta: row.delta, scoreAfter: row.scoreAfter, version: row.version,
	} };
}

export async function commitReview(env: Env, userId: string, input: ReviewInput, current: Progress | undefined, grade: GradeResult, source: ReviewResult['source'], now: number): Promise<ReviewResult> {
	// "Prawie dobrze" counts as a miss.
	const correct = grade.grade === 'correct';
	const progress: Progress = {
		correct: (current?.correct ?? 0) + Number(correct), incorrect: (current?.incorrect ?? 0) + Number(!correct),
		lastCorrectAt: correct ? now : current?.lastCorrectAt ?? null, lastIncorrectAt: correct ? current?.lastIncorrectAt ?? null : now,
		version: input.progressVersion + 1,
	};
	const result: ReviewResult = { ...grade, attemptId: input.attemptId, cardId: input.cardId, direction: input.direction, source, progress, competition: null };
	const [, , , , saved] = await env.DB.batch<ReviewRow>([
		env.DB.prepare(`INSERT INTO card_progress (user_id, card_id, correct, incorrect, last_correct_at, last_incorrect_at, version)
			SELECT ?1, ?2, ?5, ?6, ?7, ?8, ?4 + 1
			WHERE ?10 = ?4
			AND EXISTS (SELECT 1 FROM cards WHERE id = ?2 AND version = ?3 AND archived = 0)
			AND NOT EXISTS (SELECT 1 FROM reviews WHERE user_id = ?1 AND attempt_id = ?9)
			AND (?4 = 0 OR EXISTS (SELECT 1 FROM card_progress WHERE user_id = ?1 AND card_id = ?2))
			ON CONFLICT (user_id, card_id) DO UPDATE SET correct = excluded.correct, incorrect = excluded.incorrect,
				last_correct_at = excluded.last_correct_at, last_incorrect_at = excluded.last_incorrect_at, version = excluded.version
			WHERE card_progress.version = ?4`)
			.bind(userId, input.cardId, input.cardVersion, input.progressVersion,
				progress.correct, progress.incorrect, progress.lastCorrectAt, progress.lastIncorrectAt, input.attemptId, current?.version ?? 0),
		// Keep dependent writes adjacent. changes() reads the preceding write count: https://www.sqlite.org/lang_corefunc.html#changes
		env.DB.prepare(`INSERT INTO reviews (user_id, attempt_id, input_json, result_json)
			SELECT ?1, ?2, ?3, ?4 WHERE changes() = 1`).bind(userId, input.attemptId, identity(input), JSON.stringify(result)),
		env.DB.prepare(`INSERT INTO competition_events (competition_id, user_id, attempt_id, delta, score_after, version)
			SELECT id, ?1, ?2, max(0, min(target, score + ?4)) - score, max(0, min(target, score + ?4)), version + 1
			FROM (SELECT id, target, version, CASE WHEN participant_a_id = ?1 THEN score_a ELSE score_b END AS score
				FROM competitions WHERE id = ?3 AND status = 'active' AND ?1 IN (participant_a_id, participant_b_id))
			WHERE changes() = 1`).bind(userId, input.attemptId, input.competitionId ?? null, correct ? 1 : -1),
		env.DB.prepare(`UPDATE competitions SET
			score_a = CASE WHEN participant_a_id = ?1 THEN e.score_after ELSE score_a END,
			score_b = CASE WHEN participant_b_id = ?1 THEN e.score_after ELSE score_b END,
			version = e.version,
			status = CASE WHEN e.score_after = target THEN 'finished' ELSE status END,
			winner_id = CASE WHEN e.score_after = target THEN ?1 ELSE winner_id END,
			finished_at = CASE WHEN e.score_after = target THEN ?3 ELSE finished_at END
			FROM competition_events e WHERE competitions.id = e.competition_id AND e.user_id = ?1 AND e.attempt_id = ?2
			AND changes() = 1`).bind(userId, input.attemptId, now),
		env.DB.prepare(selectReview).bind(userId, input.attemptId),
	]);
	const stored = replay(saved.results[0], input);
	if (!stored) throw new HttpError(409, 'version_conflict', 'Fiszka lub wynik zostały już zmienione. Otwórz następną fiszkę.');
	return stored;
}

export async function handleReview(request: Request, env: Env, user: User): Promise<Response> {
	methods(request, ['POST']);
	const data = object(await readJson(request), ['attemptId', 'cardId', 'cardVersion', 'progressVersion', 'direction', 'action', 'answer', 'competitionId']);
	const { attemptId, cardId, cardVersion, progressVersion, direction, action, answer, competitionId } = data;
	if (typeof attemptId !== 'string' || !uuidPattern.test(attemptId) || typeof cardId !== 'string' || !uuidPattern.test(cardId)
		|| typeof cardVersion !== 'number' || !Number.isSafeInteger(cardVersion) || cardVersion < 1
		|| typeof progressVersion !== 'number' || !Number.isSafeInteger(progressVersion) || progressVersion < 0
		|| (competitionId !== undefined && (typeof competitionId !== 'string' || !uuidPattern.test(competitionId)))
		|| (direction !== 'ru-pl' && direction !== 'pl-ru')) throw new HttpError(400, 'invalid_input', 'Sprawdź fiszkę, wersję i kierunek.');
	const base = { attemptId, cardId, cardVersion, progressVersion, ...(competitionId === undefined ? {} : { competitionId }) };
	let input: ReviewInput;
	if (action === 'answer' && typeof answer === 'string' && answer.length <= 500) input = { ...base, direction, action, answer };
	else if (action === 'reveal' && !('answer' in data)) input = { ...base, direction, action };
	else throw new HttpError(400, 'invalid_input', 'Podaj odpowiedź lub wybierz „Pokaż odpowiedź”.');
	const [review, row, state] = await env.DB.batch([
		env.DB.prepare(selectReview).bind(user.id, attemptId),
		env.DB.prepare(`SELECT ${columns} FROM cards WHERE id = ?`).bind(cardId),
		env.DB.prepare(`SELECT correct, incorrect, last_correct_at AS lastCorrectAt, last_incorrect_at AS lastIncorrectAt, version
			FROM card_progress WHERE user_id = ? AND card_id = ?`).bind(user.id, cardId),
	]);
	const saved = replay(review.results[0] as ReviewRow | undefined, input);
	if (saved) return Response.json(saved);
	if (!row.results[0]) throw new HttpError(404, 'not_found', 'Nie znaleziono fiszki.');
	const card = fromRow(row.results[0] as CardRow);
	if (card.archived || card.version !== cardVersion) throw new HttpError(409, 'version_conflict', 'Fiszka została już zmieniona. Otwórz następną fiszkę.');
	const current = state.results[0] as Progress | undefined;
	if ((current?.version ?? 0) !== progressVersion) throw new HttpError(409, 'version_conflict', 'Fiszka lub wynik zostały już zmienione. Otwórz następną fiszkę.');
	let graded: { result: GradeResult; source: ReviewResult['source'] };
	try {
		graded = input.action === 'answer' ? await gradeAnswer(env, card, direction, input.answer) : {
			result: { grade: 'again', correction: direction === 'ru-pl' ? card.pl : card.ru, explanation: 'Powtórz słowo.' }, source: 'reveal',
		};
	} catch (error) {
		if (!(error instanceof HttpError)) throw error;
		return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'X-Review-Recovery': 'editable' } });
	}
	return Response.json(await commitReview(env, user.id, input, current, graded.result, graded.source, Date.now()));
}
