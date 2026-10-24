import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { GradeResult, ReviewInput, ReviewResult } from '../shared/types';
import { readCard } from '../src/cards';
import { commitReview } from '../src/reviews';
import { getStudyBatch } from '../src/study';
import { login, request } from './client';
import { CARD_A, CARD_B, USER_A, USER_B } from './fixtures';

const now = Date.parse('2026-10-21T10:00:00.000Z');
const input: ReviewInput = {
	attemptId: '10000000-0000-4000-8000-000000000001', cardId: CARD_A.id,
	cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Słowo',
};
const correct: GradeResult = { grade: 'correct', correction: 'Słowo', explanation: 'Dobrze.' };
const almost: GradeResult = { grade: 'almost', correction: 'Słowo', explanation: 'Popraw literę.' };
const again: GradeResult = { grade: 'again', correction: 'Słowo', explanation: 'Powtórz słowo.' };
const firstResult: ReviewResult = {
	...correct, attemptId: input.attemptId, cardId: CARD_A.id, direction: 'ru-pl', source: 'exact',
	progress: { correct: 1, incorrect: 0, lastCorrectAt: now, lastIncorrectAt: null, version: 1 },
};
// The card_progress row that handleReview reads after firstResult is stored.
const reviewed = firstResult.progress;

beforeEach(async () => {
	vi.spyOn(Date, 'now').mockReturnValue(now);
	const cookie = await login(USER_A.id);
	await login(USER_B.id);
	expect((await request('/api/cards', { method: 'POST', cookie, body: CARD_A })).status).toBe(201);
	expect((await request('/api/cards', { method: 'POST', cookie, body: CARD_B })).status).toBe(201);
});

async function state() {
	return (await env.DB.prepare('SELECT * FROM card_progress ORDER BY user_id, card_id').all()).results;
}

async function reviews() {
	return (await env.DB.prepare('SELECT * FROM reviews ORDER BY user_id, attempt_id').all()).results;
}

// Hold real D1 batches so the test can act before any commit writes.
function holdBatches() {
	const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementation(async statements => {
		ready.resolve();
		await release.promise;
		return batch(statements);
	});
	return { ready: ready.promise, release: release.resolve };
}

it('stores a first review once and replays its full result across property order and candidate changes', async () => {
	expect(await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now)).toEqual(firstResult);
	const reordered: ReviewInput = {
		answer: 'Słowo', action: 'answer', direction: 'ru-pl', progressVersion: 0, cardVersion: 1,
		cardId: CARD_A.id, attemptId: input.attemptId,
	};
	expect(await commitReview(env, USER_A.id, reordered, undefined, again, 'ai', now + 2000)).toEqual(firstResult);
	expect(await state()).toEqual([{
		user_id: USER_A.id, card_id: CARD_A.id, correct: 1, incorrect: 0,
		last_correct_at: now, last_incorrect_at: null, version: 1,
	}]);
	expect(await reviews()).toHaveLength(1);
});

it('shares progress between directions, keeps other learners unseen, and permits the same attempt ID for another learner', async () => {
	await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	expect((await getStudyBatch(env, USER_B.id, now)).cards.every(item => item.progress === null)).toBe(true);
	expect(await commitReview(env, USER_B.id, input, undefined, correct, 'exact', now)).toEqual(firstResult);
	const reverse: ReviewInput = { ...input, attemptId: crypto.randomUUID(), direction: 'pl-ru', progressVersion: 1, answer: 'Слово' };
	expect((await commitReview(env, USER_A.id, reverse, reviewed, correct, 'exact', now + 1000)).progress)
		.toEqual({ correct: 2, incorrect: 0, lastCorrectAt: now + 1000, lastIncorrectAt: null, version: 2 });
	expect(await reviews()).toHaveLength(3);
	expect(await state()).toMatchObject([{ user_id: USER_A.id, correct: 2, version: 2 }, { user_id: USER_B.id, correct: 1, version: 1 }]);
});

it.each([
	{ name: 'correct answer', grade: correct, expected: { correct: 3, incorrect: 1, lastCorrectAt: now, lastIncorrectAt: now - 2000 } },
	{ name: 'almost correct answer', grade: almost, expected: { correct: 2, incorrect: 2, lastCorrectAt: now - 1000, lastIncorrectAt: now } },
	{ name: 'wrong answer or reveal', grade: again, expected: { correct: 2, incorrect: 2, lastCorrectAt: now - 1000, lastIncorrectAt: now } },
])('adds a $name to the stored counts', async ({ grade, expected }) => {
	await env.DB.prepare(`INSERT INTO card_progress (user_id, card_id, correct, incorrect, last_correct_at, last_incorrect_at, version)
		VALUES (?, ?, 2, 1, ?, ?, 7)`).bind(USER_A.id, CARD_A.id, now - 1000, now - 2000).run();
	const current = { correct: 2, incorrect: 1, lastCorrectAt: now - 1000, lastIncorrectAt: now - 2000, version: 7 };
	const result = await commitReview(env, USER_A.id, { ...input, progressVersion: 7 }, current, grade, 'ai', now);
	expect(result.progress).toEqual({ ...expected, version: 8 });
	expect(await state()).toEqual([{ user_id: USER_A.id, card_id: CARD_A.id, correct: expected.correct, incorrect: expected.incorrect,
		last_correct_at: expected.lastCorrectAt, last_incorrect_at: expected.lastIncorrectAt, version: 8 }]);
	expect(await reviews()).toHaveLength(1);
});

it.each([
	{ name: 'nonzero version without progress', existing: false, version: 3 },
	{ name: 'zero version with progress', existing: true, version: 0 },
	{ name: 'future progress version', existing: true, version: 2 },
])('rejects $name', async ({ existing, version }) => {
	if (existing) await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	const before = { state: await state(), reviews: await reviews() };
	await env.DB.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').bind(now + 1, CARD_B.id).run();
	await expect(commitReview(env, USER_A.id, { ...input, attemptId: crypto.randomUUID(), progressVersion: version }, existing ? reviewed : undefined, correct, 'exact', now))
		.rejects.toMatchObject({ status: 409 });
	expect({ state: await state(), reviews: await reviews() }).toEqual(before);
});

it.each([
	{ name: 'edit during unseen grading', existing: false, archived: 0 },
	{ name: 'archive during unseen grading', existing: false, archived: 1 },
	{ name: 'edit during reviewed grading', existing: true, archived: 0 },
	{ name: 'archive during reviewed grading', existing: true, archived: 1 },
])('rejects an $name at the write boundary', async ({ existing, archived }) => {
	if (existing) await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	expect(await readCard(env, CARD_A.id)).toMatchObject({ version: 1, archived: false });
	const before = { state: await state(), reviews: await reviews() };
	const held = holdBatches();
	const pending = commitReview(env, USER_A.id, { ...input, attemptId: crypto.randomUUID(), progressVersion: existing ? 1 : 0 }, existing ? reviewed : undefined, correct, 'ai', now);
	const settled = Promise.allSettled([pending]);
	await Promise.race([held.ready, settled]);
	try { await env.DB.prepare('UPDATE cards SET version = 2, archived = ? WHERE id = ?').bind(archived, CARD_A.id).run(); }
	finally { held.release(); }
	await expect(pending).rejects.toMatchObject({ status: 409 });
	expect({ state: await state(), reviews: await reviews() }).toEqual(before);
});

it('replays the original progress after a later review, edit, and archive', async () => {
	await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	const reveal: ReviewInput = { attemptId: crypto.randomUUID(), cardId: CARD_A.id, cardVersion: 1, progressVersion: 1, direction: 'ru-pl', action: 'reveal' };
	const later = await commitReview(env, USER_A.id, reveal, reviewed, again, 'reveal', now + 1000);
	expect(later).toEqual({ ...again, attemptId: reveal.attemptId, cardId: CARD_A.id, direction: 'ru-pl', source: 'reveal', progress: { correct: 1, incorrect: 1, lastCorrectAt: now, lastIncorrectAt: now + 1000, version: 2 } });
	await env.DB.prepare('UPDATE cards SET version = 2, pl = ? WHERE id = ?').bind('Wyraz', CARD_A.id).run();
	expect(await commitReview(env, USER_A.id, input, undefined, again, 'ai', now + 2000)).toEqual(firstResult);
	await env.DB.prepare('UPDATE cards SET version = 3, archived = 1 WHERE id = ?').bind(CARD_A.id).run();
	expect(await commitReview(env, USER_A.id, input, undefined, again, 'ai', now + 3000)).toEqual(firstResult);
	expect(await commitReview(env, USER_A.id, reveal, reviewed, again, 'reveal', now + 4000)).toEqual(later);
	expect(await state()).toMatchObject([{ version: 2, correct: 1, incorrect: 1 }]);
	expect(await reviews()).toHaveLength(2);
});

it.each([
	{ name: 'unseen', existing: false },
	{ name: 'reviewed', existing: true },
])('rejects an archived $name card even when the content version matches', async ({ existing }) => {
	if (existing) await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	await env.DB.prepare('UPDATE cards SET version = 2, archived = 1 WHERE id = ?').bind(CARD_A.id).run();
	const before = { state: await state(), reviews: await reviews() };
	await expect(commitReview(env, USER_A.id, { ...input, attemptId: crypto.randomUUID(), cardVersion: 2, progressVersion: existing ? 1 : 0 }, existing ? reviewed : undefined, correct, 'exact', now))
		.rejects.toMatchObject({ status: 409 });
	expect({ state: await state(), reviews: await reviews() }).toEqual(before);
});

it('rejects a candidate calculated from a different progress version even if that version becomes current', async () => {
	await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	const held = holdBatches();
	const pending = commitReview(env, USER_A.id, { ...input, attemptId: crypto.randomUUID(), progressVersion: 2 }, reviewed, correct, 'exact', now);
	await Promise.race([held.ready, Promise.allSettled([pending])]);
	let before;
	try {
		await env.DB.prepare('UPDATE card_progress SET correct = 2, version = 2, last_correct_at = ? WHERE user_id = ? AND card_id = ?')
			.bind(now + 1000, USER_A.id, CARD_A.id).run();
		before = { state: await state(), reviews: await reviews() };
	} finally { held.release(); }
	await expect(pending).rejects.toMatchObject({ status: 409 });
	expect({ state: await state(), reviews: await reviews() }).toEqual(before);
});

it.each([
	{ name: 'new attempts at version zero', second: { ...input, attemptId: '10000000-0000-4000-8000-000000000002' }, successes: 1 },
	{ name: 'identical attempts', second: input, successes: 2 },
	{ name: 'same attempt with a different card', second: { ...input, cardId: CARD_B.id }, successes: 1 },
	{ name: 'same attempt with a different direction', second: { ...input, direction: 'pl-ru' }, successes: 1 },
] satisfies { name: string; second: ReviewInput; successes: number }[])('serializes concurrent $name through D1', async ({ second, successes }) => {
	const results = await Promise.allSettled([
		commitReview(env, USER_A.id, input, undefined, correct, 'exact', now),
		commitReview(env, USER_A.id, second, undefined, again, 'ai', now + 1000),
	]);
	const accepted = results.filter(result => result.status === 'fulfilled');
	expect(accepted).toHaveLength(successes);
	for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 });
	if (successes === 2) expect(accepted[0].value).toEqual(accepted[1].value);
	expect(await state()).toHaveLength(1);
	expect(await state()).toMatchObject([{ version: 1 }]);
	expect(await reviews()).toHaveLength(1);
	expect(JSON.parse(String((await reviews())[0].result_json))).toEqual(accepted[0].value);
});

it('replays a review stored before migration 0007 with the renamed explanation field', async () => {
	const stored = { grade: 'correct', correction: 'Słowo', explanationRu: 'Верно.', attemptId: input.attemptId, cardId: CARD_A.id, direction: 'ru-pl', source: 'exact', progress: firstResult.progress };
	await env.DB.prepare('INSERT INTO reviews (user_id, attempt_id, input_json, result_json) VALUES (?, ?, ?, ?)').bind(USER_A.id, input.attemptId,
		JSON.stringify({ cardId: CARD_A.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Słowo' }), JSON.stringify(stored)).run();
	const migration = env.TEST_MIGRATIONS.find(migration => migration.name === '0007_review_explanation.sql')!;
	await env.DB.batch(migration.queries.map(query => env.DB.prepare(query)));
	const response = await request('/api/reviews', { method: 'POST', cookie: await login(USER_A.id), body: input });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ...firstResult, explanation: 'Верно.' });
});

it('counts the saved reviews of both directions when migration 0008 runs', async () => {
	const saved = [
		{ userId: USER_A.id, cardId: CARD_A.id, direction: 'ru-pl', grade: 'correct', at: now - 3000 },
		{ userId: USER_A.id, cardId: CARD_A.id, direction: 'pl-ru', grade: 'almost', at: now - 2000 },
		{ userId: USER_A.id, cardId: CARD_A.id, direction: 'ru-pl', grade: 'again', at: now - 1000 },
		{ userId: USER_A.id, cardId: CARD_A.id, direction: 'pl-ru', grade: 'correct', at: now },
		{ userId: USER_B.id, cardId: CARD_A.id, direction: 'ru-pl', grade: 'again', at: now - 500 },
	];
	await env.DB.batch(saved.map(({ userId, cardId, direction, grade, at }) => env.DB.prepare('INSERT INTO reviews (user_id, attempt_id, input_json, result_json) VALUES (?, ?, ?, ?)')
		.bind(userId, crypto.randomUUID(), JSON.stringify({ cardId, cardVersion: 1, progressVersion: 0, direction, action: 'reveal' }),
			JSON.stringify({ grade, correction: 'Słowo', explanation: 'Powtórz słowo.', cardId, direction, source: 'reveal', progress: { stage: 0, dueAt: at, version: 1, lastReviewedAt: at } }))));
	await env.DB.prepare('DROP TABLE card_progress').run();
	const migration = env.TEST_MIGRATIONS.find(migration => migration.name === '0008_card_progress.sql')!;
	await env.DB.batch(migration.queries.map(query => env.DB.prepare(query)));
	expect(await state()).toEqual([
		{ user_id: USER_A.id, card_id: CARD_A.id, correct: 2, incorrect: 2, last_correct_at: now, last_incorrect_at: now - 1000, version: 4 },
		{ user_id: USER_B.id, card_id: CARD_A.id, correct: 0, incorrect: 1, last_correct_at: null, last_incorrect_at: now - 500, version: 1 },
	]);
});
