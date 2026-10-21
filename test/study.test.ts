import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Direction, StudyBatch } from '../shared/types';
import { getStudyBatch } from '../src/study';
import { login, request } from './client';
import { CARD_A, CARD_B, USER_A, USER_B } from './fixtures';

const now = Date.parse('2026-10-21T10:00:00.000Z');
const c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const d = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const e = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
let cookie: string;

beforeEach(async () => {
	vi.spyOn(Date, 'now').mockReturnValue(now);
	cookie = await login(USER_A.id);
	await login(USER_B.id);
	const cards = [
		{ name: 'retry', card: CARD_A, createdAt: now - 100 },
		{ name: 'overdue', card: CARD_B, createdAt: now - 300 },
		{ name: 'unseen', card: { ...CARD_A, id: c }, createdAt: now - 200 },
		{ name: 'future', card: { ...CARD_A, id: d }, createdAt: now - 400 },
		{ name: 'archived', card: { ...CARD_A, id: e }, createdAt: now - 500 },
	];
	for (const { createdAt, card } of cards) {
		vi.spyOn(Date, 'now').mockReturnValue(createdAt);
		expect((await request('/api/cards', { method: 'POST', cookie, body: card })).status).toBe(201);
	}
	vi.spyOn(Date, 'now').mockReturnValue(now);
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO review_state (user_id, card_id, direction, stage, due_at, version, last_reviewed_at)
			VALUES (?1, ?2, 'ru-pl', 0, ?3, 2, ?4), (?1, ?5, 'ru-pl', 3, ?6, 4, ?4),
			(?1, ?7, 'ru-pl', 1, ?8, 1, ?4), (?1, ?9, 'ru-pl', 0, ?10, 1, ?4)`)
			.bind(USER_A.id, CARD_A.id, now, now - 1000, CARD_B.id, now - 10_000, d, now + 60_000, e, now + 1000),
		env.DB.prepare('UPDATE cards SET archived = 1 WHERE id = ?').bind(e),
	]);
});

it('orders due retries, overdue reviews, then unseen cards without creating progress', async () => {
	const batch = await getStudyBatch(env, USER_A.id, 'ru-pl', [], 10, now);
	expect(batch.cards.map(item => item.card.id)).toEqual([CARD_A.id, CARD_B.id, c]);
	expect(batch).toMatchObject({ serverTime: now, nextDueAt: now + 60_000 });
	expect(batch.cards[0]).toEqual({
		card: { ...CARD_A, version: 1, archived: false, createdBy: USER_A.id, createdAt: now - 100, updatedAt: now - 100 },
		progress: { stage: 0, dueAt: now, version: 2, lastReviewedAt: now - 1000 },
	});
	expect(batch.cards[2].progress).toBeNull();
	expect(await env.DB.prepare('SELECT count(*) AS n FROM review_state').first('n')).toBe(4);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM reviews').first('n')).toBe(0);
});

it.each([
	{ name: 'retry due times', stage: 0, secondDue: now - 1, expected: [CARD_B.id, CARD_A.id, c] },
	{ name: 'retry ID ties', stage: 0, secondDue: now, expected: [CARD_A.id, CARD_B.id, c] },
	{ name: 'review due times', stage: 2, secondDue: now - 1, expected: [CARD_B.id, CARD_A.id, c] },
	{ name: 'review ID ties', stage: 2, secondDue: now, expected: [CARD_A.id, CARD_B.id, c] },
])('orders $name', async ({ stage, secondDue, expected }) => {
	await env.DB.prepare('UPDATE review_state SET stage = ?1, due_at = CASE card_id WHEN ?2 THEN ?3 ELSE ?4 END WHERE card_id IN (?2, ?5)')
		.bind(stage, CARD_A.id, now, secondDue, CARD_B.id).run();
	expect((await getStudyBatch(env, USER_A.id, 'ru-pl', [], 10, now)).cards.map(item => item.card.id)).toEqual(expected);
});

it('orders unseen creation times and breaks equal times by ID', async () => {
	await env.DB.prepare('UPDATE cards SET created_at = ? WHERE id IN (?, ?)').bind(now - 300, CARD_A.id, CARD_B.id).run();
	const batch = await getStudyBatch(env, USER_B.id, 'ru-pl', [], 10, now);
	expect(batch.cards.map(item => item.card.id)).toEqual([d, CARD_A.id, CARD_B.id, c]);
	expect(batch.cards.every(item => item.progress === null)).toBe(true);
	expect(batch.nextDueAt).toBeNull();
});

it.each([
	{ name: 'other learner', userId: USER_B.id, direction: 'ru-pl' },
	{ name: 'other direction', userId: USER_A.id, direction: 'pl-ru' },
] satisfies { name: string; userId: string; direction: Direction }[])('keeps the $name unseen', async ({ userId, direction }) => {
	const batch = await getStudyBatch(env, userId, direction, [], 10, now);
	expect(batch.cards.map(item => item.card.id)).toEqual([d, CARD_B.id, c, CARD_A.id]);
	expect(batch.cards.every(item => item.progress === null)).toBe(true);
	expect(batch.nextDueAt).toBeNull();
});

it('excludes buffered cards from both the queue and the next future due time', async () => {
	const batch = await getStudyBatch(env, USER_A.id, 'ru-pl', [CARD_A.id, d], 10, now);
	expect(batch.cards.map(item => item.card.id)).toEqual([CARD_B.id, c]);
	expect(batch.nextDueAt).toBeNull();
});

it('returns the next future time when the queue is empty', async () => {
	const batch = await getStudyBatch(env, USER_A.id, 'ru-pl', [CARD_A.id, CARD_B.id, c], 10, now);
	expect(batch).toEqual({ cards: [], serverTime: now, nextDueAt: now + 60_000 });
});

it.each([
	{ name: 'zero', limit: 0, length: 1 },
	{ name: 'negative', limit: -4, length: 1 },
	{ name: 'requested size', limit: 2, length: 2 },
	{ name: 'maximum size', limit: 50, length: 10 },
])('clamps a $name limit', async ({ limit, length }) => {
	const cards = Array.from({ length: 9 }, (_, index) => ({ name: `extra ${index}`, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
	for (const card of cards) expect((await request('/api/cards', { method: 'POST', cookie, body: { ...CARD_A, id: card.id } })).status).toBe(201);
	expect((await getStudyBatch(env, USER_A.id, 'ru-pl', [], limit, now)).cards).toHaveLength(length);
});

it('serves the authenticated direction, buffer exclusions, and limit', async () => {
	const response = await request(`/api/study?direction=ru-pl&exclude=${CARD_A.id},${d}&limit=1`, { cookie });
	expect(response.status).toBe(200);
	const batch = await response.json<StudyBatch>();
	expect(batch.cards.map(item => item.card.id)).toEqual([CARD_B.id]);
	expect(batch).toMatchObject({ serverTime: now, nextDueAt: null });
	expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	await request('/api/me', { method: 'PATCH', cookie, body: { direction: 'pl-ru' } });
	const savedDirection = await (await request('/api/study', { cookie })).json<StudyBatch>();
	expect(savedDirection.cards.every(item => item.progress === null)).toBe(true);
	expect(savedDirection.cards.map(item => item.card.id)).toEqual([d, CARD_B.id, c, CARD_A.id]);
});

it.each([
	{ name: 'unknown direction', query: 'direction=en-pl' },
	{ name: 'non-numeric limit', query: 'limit=no' },
	{ name: 'fractional limit', query: 'limit=1.5' },
	{ name: 'empty limit', query: 'limit=' },
	{ name: 'invalid excluded ID', query: 'exclude=not-an-id' },
	{ name: 'oversized buffer', query: `exclude=${Array(11).fill(CARD_A.id).join(',')}` },
])('rejects $name', async ({ query }) => {
	expect((await request(`/api/study?${query}`, { cookie })).status).toBe(400);
});

it('requires a session and accepts only GET', async () => {
	expect((await request('/api/study')).status).toBe(401);
	expect((await request('/api/study', { method: 'POST', cookie })).status).toBe(405);
});
