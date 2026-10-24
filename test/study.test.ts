import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { StudyBatch } from '../shared/types';
import { getStudyBatch } from '../src/study';
import { login, request } from './client';
import { CARD_A, CARD_B, USER_A, USER_B } from './fixtures';

const now = Date.parse('2026-10-21T10:00:00.000Z');
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const d = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
let cookie: string;

beforeEach(async () => {
	vi.spyOn(Date, 'now').mockReturnValue(now);
	cookie = await login(USER_A.id);
	await login(USER_B.id);
	const cards = [
		{ name: 'first', card: CARD_A, createdAt: now - 100 },
		{ name: 'second', card: CARD_B, createdAt: now - 300 },
		{ name: 'third', card: { ...CARD_A, id: c }, createdAt: now - 200 },
		{ name: 'fourth', card: { ...CARD_A, id: d }, createdAt: now - 400 },
	];
	for (const { createdAt, card } of cards) {
		vi.spyOn(Date, 'now').mockReturnValue(createdAt);
		expect((await request('/api/cards', { method: 'POST', cookie, body: card })).status).toBe(201);
	}
	vi.spyOn(Date, 'now').mockReturnValue(now);
});

async function answered(cardId: string, correct: number, incorrect: number, lastCorrectAt: number | null, lastIncorrectAt: number | null) {
	await env.DB.prepare(`INSERT INTO card_progress (user_id, card_id, correct, incorrect, last_correct_at, last_incorrect_at, version)
		VALUES (?, ?, ?, ?, ?, ?, 3)`).bind(USER_A.id, cardId, correct, incorrect, lastCorrectAt, lastIncorrectAt).run();
}

const ids = (batch: StudyBatch) => batch.cards.map(item => item.card.id);

it.each([
	{ name: 'miss', correct: 0, incorrect: 1, lastCorrectAt: null, lastIncorrectAt: now - 1000, readyAt: now - 1000 + 10 * minute },
	{ name: 'miss after correct answers', correct: 5, incorrect: 1, lastCorrectAt: now - day, lastIncorrectAt: now - 1000, readyAt: now - 1000 + 10 * minute },
	{ name: 'correct answer after many misses', correct: 1, incorrect: 10, lastCorrectAt: now - 1000, lastIncorrectAt: now - hour, readyAt: now - 1000 + 4 * hour },
	{ name: 'correct answer at score 0', correct: 2, incorrect: 1, lastCorrectAt: now - 1000, lastIncorrectAt: now - hour, readyAt: now - 1000 + 4 * hour },
	{ name: 'correct answer at score 1', correct: 1, incorrect: 0, lastCorrectAt: now - 1000, lastIncorrectAt: null, readyAt: now - 1000 + day },
	{ name: 'correct answer at score 2', correct: 2, incorrect: 0, lastCorrectAt: now - 1000, lastIncorrectAt: null, readyAt: now - 1000 + 3 * day },
	{ name: 'correct answer at score 3', correct: 3, incorrect: 0, lastCorrectAt: now - 1000, lastIncorrectAt: null, readyAt: now - 1000 + 7 * day },
	{ name: 'correct answer at score 4 after a miss', correct: 6, incorrect: 1, lastCorrectAt: now - 1000, lastIncorrectAt: now - day, readyAt: now - 1000 + 14 * day },
	{ name: 'correct answer at score 5', correct: 5, incorrect: 0, lastCorrectAt: now - 1000, lastIncorrectAt: null, readyAt: now - 1000 + 30 * day },
	{ name: 'correct answer at score 6', correct: 6, incorrect: 0, lastCorrectAt: now - 1000, lastIncorrectAt: null, readyAt: now - 1000 + 60 * day },
	{ name: 'correct answer above score 6', correct: 9, incorrect: 0, lastCorrectAt: now - 1000, lastIncorrectAt: null, readyAt: now - 1000 + 60 * day },
])('holds a card back after a $name', async ({ correct, incorrect, lastCorrectAt, lastIncorrectAt, readyAt }) => {
	await answered(CARD_A.id, correct, incorrect, lastCorrectAt, lastIncorrectAt);
	const waiting = await getStudyBatch(env, USER_A.id, readyAt - 1);
	expect(ids(waiting)).toEqual([d, CARD_B.id, c]);
	expect(waiting).toMatchObject({ dueCount: 3, nextDueAt: readyAt });
	const ready = await getStudyBatch(env, USER_A.id, readyAt);
	expect(ids(ready)).toContain(CARD_A.id);
	expect(ready).toMatchObject({ dueCount: 4, nextDueAt: null });
});

it('orders ready cards by misses per correct answer without creating progress', async () => {
	await answered(CARD_A.id, 1, 3, now - 2 * day, now - hour);
	await answered(CARD_B.id, 2, 0, now - 4 * day, null);
	const batch = await getStudyBatch(env, USER_A.id, now);
	expect(ids(batch)).toEqual([CARD_A.id, d, c, CARD_B.id]);
	expect(batch).toEqual({ cards: expect.any(Array), dueCount: 4, serverTime: now, nextDueAt: null });
	expect(batch.cards[0]).toEqual({
		card: { ...CARD_A, version: 1, archived: false, createdBy: USER_A.id, createdAt: now - 100, updatedAt: now - 100 },
		progress: { correct: 1, incorrect: 3, lastCorrectAt: now - 2 * day, lastIncorrectAt: now - hour, version: 3 },
	});
	expect(batch.cards[1].progress).toBeNull();
	expect(await env.DB.prepare('SELECT count(*) AS n FROM card_progress').first('n')).toBe(2);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM reviews').first('n')).toBe(0);
});

it('breaks equal weights by ready time and then by ID', async () => {
	await env.DB.prepare('UPDATE cards SET created_at = ? WHERE id IN (?, ?)').bind(now - 400, c, CARD_B.id).run();
	await answered(CARD_A.id, 1, 1, now - day, now - hour);
	expect(ids(await getStudyBatch(env, USER_A.id, now))).toEqual([CARD_A.id, CARD_B.id, c, d]);
});

it('counts every ready card beyond the batch of 10', async () => {
	for (let index = 0; index < 9; index++) {
		expect((await request('/api/cards', { method: 'POST', cookie, body: { ...CARD_A, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` } })).status).toBe(201);
	}
	await answered(CARD_A.id, 1, 0, now, null);
	const batch = await getStudyBatch(env, USER_A.id, now);
	expect(batch.cards).toHaveLength(10);
	expect(ids(batch)).not.toContain(CARD_A.id);
	expect(batch.dueCount).toBe(12);
});

it('leaves archived cards out of the queue, the count, and the next ready time', async () => {
	await answered(d, 0, 1, null, now);
	await env.DB.prepare('UPDATE cards SET archived = 1 WHERE id IN (?, ?)').bind(c, d).run();
	expect(await getStudyBatch(env, USER_A.id, now)).toMatchObject({ dueCount: 2, nextDueAt: null });
	expect(ids(await getStudyBatch(env, USER_A.id, now))).toEqual([CARD_B.id, CARD_A.id]);
});

it('keeps the progress of one learner away from the other learner', async () => {
	await answered(CARD_A.id, 1, 0, now, null);
	const other = await getStudyBatch(env, USER_B.id, now);
	expect(ids(other)).toEqual([d, CARD_B.id, c, CARD_A.id]);
	expect(other.cards.every(item => item.progress === null)).toBe(true);
	expect(other).toMatchObject({ dueCount: 4, nextDueAt: null });
});

it('serves the batch of the session learner without caching', async () => {
	await answered(CARD_A.id, 1, 0, now, null);
	const response = await request('/api/study', { cookie });
	expect(response.status).toBe(200);
	expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	expect(await response.json()).toEqual(await getStudyBatch(env, USER_A.id, now));
});

it('requires a session and accepts only GET', async () => {
	expect((await request('/api/study')).status).toBe(401);
	expect((await request('/api/study', { method: 'POST', cookie })).status).toBe(405);
});
