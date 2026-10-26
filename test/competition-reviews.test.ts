import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Competition, GradeResult, ReviewInput, ReviewResult } from '../shared/types';
import { commitReview } from '../src/reviews';
import { login, request } from './client';
import { CARD_A, CARD_B, USER_A, USER_B } from './fixtures';

const now = Date.parse('2026-10-26T10:00:00.000Z');
const roundId = '33333333-3333-4333-8333-333333333333';
const nextId = '55555555-5555-4555-8555-555555555555';
const input: ReviewInput = {
	attemptId: '10000000-0000-4000-8000-000000000001', cardId: CARD_A.id,
	cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Słowo', competitionId: roundId,
};
const correct: GradeResult = { grade: 'correct', correction: 'Słowo', explanation: 'Dobrze.' };
let cookieA: string, cookieB: string;

beforeEach(async () => {
	vi.spyOn(Date, 'now').mockReturnValue(now);
	cookieA = await login(USER_A.id);
	cookieB = await login(USER_B.id);
	expect((await request('/api/cards', { method: 'POST', cookie: cookieA, body: CARD_A })).status).toBe(201);
	expect((await request('/api/cards', { method: 'POST', cookie: cookieA, body: CARD_B })).status).toBe(201);
});

async function invite(id = roundId) {
	const response = await request('/api/competitions', { method: 'POST', cookie: cookieA, body: { id } });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ id, status: 'waiting', version: 1 });
}

async function startRound(id = roundId) {
	await invite(id);
	const response = await request(`/api/competitions/${id}/accept`, { method: 'POST', cookie: cookieB });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ id, status: 'active', version: 2 });
}

async function currentRound() {
	const response = await request('/api/competitions/current', { cookie: cookieA });
	expect(response.status).toBe(200);
	return response.json<Competition>();
}

async function tables() {
	return {
		progress: (await env.DB.prepare('SELECT * FROM card_progress ORDER BY user_id, card_id').all()).results,
		reviews: (await env.DB.prepare('SELECT * FROM reviews ORDER BY user_id, attempt_id').all()).results,
		rounds: (await env.DB.prepare('SELECT * FROM competitions ORDER BY id').all()).results,
		events: (await env.DB.prepare('SELECT * FROM competition_events ORDER BY version').all()).results,
	};
}

it.each([
	{ name: 'exact correct', grade: 'correct', source: 'exact', before: 8, after: 9, delta: 1 },
	{ name: 'AI correct', grade: 'correct', source: 'ai', before: 8, after: 9, delta: 1 },
	{ name: 'incorrect', grade: 'again', source: 'ai', before: 8, after: 7, delta: -1 },
	{ name: 'almost', grade: 'almost', source: 'ai', before: 8, after: 7, delta: -1 },
	{ name: 'reveal', grade: 'again', source: 'reveal', before: 8, after: 7, delta: -1 },
	{ name: 'zero floor', grade: 'again', source: 'exact', before: 0, after: 0, delta: 0 },
	{ name: 'winning answer', grade: 'correct', source: 'exact', before: 19, after: 20, delta: 1 },
] satisfies { name: string; grade: GradeResult['grade']; source: ReviewResult['source']; before: number; after: number; delta: number }[])
('scores $name', async ({ grade, source, before, after, delta }) => {
	await startRound();
	await env.DB.prepare('UPDATE competitions SET score_a = ? WHERE id = ?').bind(before, roundId).run();
	const attempt: ReviewInput = source === 'reveal' ? {
		attemptId: input.attemptId, cardId: CARD_A.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'reveal', competitionId: roundId,
	} : input;
	const result = await commitReview(env, USER_A.id, attempt, undefined, { ...correct, grade }, source, now);
	expect(result.competition).toEqual({ competitionId: roundId, delta, scoreAfter: after, version: 3 });
	const saved = await tables();
	expect(saved.events).toEqual([{ competition_id: roundId, user_id: USER_A.id, attempt_id: input.attemptId, delta, score_after: after, version: 3 }]);
	expect(saved.reviews).toHaveLength(1);
	expect(JSON.parse(String(saved.reviews[0].result_json))).toEqual({ ...result, competition: null });
	const round = await currentRound();
	expect(round.participants.map(person => person.score)).toEqual([after, 0]);
	expect(round.status).toBe(after === 20 ? 'finished' : 'active');
	expect(round.winnerId).toBe(after === 20 ? USER_A.id : null);
	expect(round.finishedAt).toBe(after === 20 ? now : null);
	expect(round.version).toBe(3);
});

it('replays the saved contribution after later reviews', async () => {
	await startRound();
	await env.DB.prepare('UPDATE competitions SET score_a = 8 WHERE id = ?').bind(roundId).run();
	const first = await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	const event = (await tables()).events;
	const later = await commitReview(env, USER_A.id, { ...input, attemptId: crypto.randomUUID(), progressVersion: 1 }, first.progress, correct, 'exact', now + 1000);
	expect(later.competition).toEqual({ competitionId: roundId, delta: 1, scoreAfter: 10, version: 4 });
	const before = await tables();
	const retry = await commitReview(env, USER_A.id, input, undefined, { ...correct, grade: 'again' }, 'ai', now + 2000);
	expect(retry).toEqual(first);
	const response = await request('/api/reviews', { method: 'POST', cookie: cookieA, body: input });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(first);
	expect((await tables()).events[0]).toEqual(event[0]);
	expect(await tables()).toEqual(before);
});

it('serializes identical attempts', async () => {
	await startRound();
	await env.DB.prepare('UPDATE competitions SET score_a = 8 WHERE id = ?').bind(roundId).run();
	const results = await Promise.all([
		commitReview(env, USER_A.id, input, undefined, correct, 'exact', now),
		commitReview(env, USER_A.id, input, undefined, correct, 'exact', now),
	]);
	expect(results[0]).toEqual(results[1]);
	expect(results[0].competition).toEqual({ competitionId: roundId, delta: 1, scoreAfter: 9, version: 3 });
	const saved = await tables();
	expect(saved.reviews).toHaveLength(1);
	expect(saved.progress).toMatchObject([{ correct: 1, version: 1 }]);
	expect(saved.events).toHaveLength(1);
	expect((await currentRound()).participants[0].score).toBe(9);
});

it('keeps both contributions from different cards', async () => {
	await startRound();
	await env.DB.prepare('UPDATE competitions SET score_a = 8 WHERE id = ?').bind(roundId).run();
	await Promise.all([
		commitReview(env, USER_A.id, input, undefined, correct, 'exact', now),
		commitReview(env, USER_A.id, { ...input, cardId: CARD_B.id, attemptId: crypto.randomUUID(), answer: 'Dom' }, undefined, { ...correct, correction: 'Dom' }, 'exact', now),
	]);
	const saved = await tables();
	expect((await currentRound()).participants[0].score).toBe(10);
	expect(saved.events.map(event => Number(event.score_after)).sort((a, b) => a - b)).toEqual([9, 10]);
	expect(saved.events.map(event => event.version)).toEqual([3, 4]);
	expect(saved.reviews).toHaveLength(2);
	expect(saved.progress).toHaveLength(2);
});

it('selects one winner from simultaneous finishes', async () => {
	await startRound();
	await env.DB.prepare('UPDATE competitions SET score_a = 19, score_b = 19 WHERE id = ?').bind(roundId).run();
	const results = await Promise.all([
		commitReview(env, USER_A.id, input, undefined, correct, 'exact', now),
		commitReview(env, USER_B.id, input, undefined, correct, 'exact', now),
	]);
	const round = await currentRound(), saved = await tables();
	expect(saved.reviews).toHaveLength(2);
	expect(saved.progress).toHaveLength(2);
	expect(round.participants.map(person => person.score).sort()).toEqual([19, 20]);
	expect(results.filter(result => result.competition !== null)).toHaveLength(1);
	expect(results.filter(result => result.competition === null)).toHaveLength(1);
	expect(saved.events).toEqual([{ competition_id: roundId, user_id: round.winnerId, attempt_id: input.attemptId, delta: 1, score_after: 20, version: 3 }]);
	expect(round.winnerId).toBe(round.participants.find(person => person.score === 20)!.id);
	expect(round).toMatchObject({ status: 'finished', version: 3, finishedAt: now });
});

it('keeps an old attempt out of a rematch', async () => {
	await startRound();
	await env.DB.prepare('UPDATE competitions SET score_b = 19 WHERE id = ?').bind(roundId).run();
	const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
		ready.resolve();
		await release.promise;
		return batch(statements);
	});
	const pending = commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	await Promise.race([ready.promise, Promise.allSettled([pending])]);
	try {
		const winner = await commitReview(env, USER_B.id, input, undefined, correct, 'exact', now);
		expect(winner.competition).toEqual({ competitionId: roundId, delta: 1, scoreAfter: 20, version: 3 });
		await startRound(nextId);
	} finally { release.resolve(); }
	expect(await pending).toMatchObject({ competition: null, progress: { correct: 1, version: 1 } });
	const round = await currentRound(), saved = await tables();
	expect(round.id).toBe(nextId);
	expect(round.participants.map(person => person.score)).toEqual([0, 0]);
	expect(round.version).toBe(2);
	expect(saved.reviews).toHaveLength(2);
	expect(saved.events).toHaveLength(1);
	expect(saved.events[0]).toMatchObject({ competition_id: roundId, user_id: USER_B.id });
});

it('counts repeated cards and both directions', async () => {
	await startRound();
	const first = await commitReview(env, USER_A.id, input, undefined, correct, 'exact', now);
	const reverse: ReviewInput = { ...input, attemptId: crypto.randomUUID(), progressVersion: 1, direction: 'pl-ru', answer: 'Слово' };
	const second = await commitReview(env, USER_A.id, reverse, first.progress, { ...correct, correction: 'Слово' }, 'exact', now + 1000);
	expect(first.competition).toEqual({ competitionId: roundId, delta: 1, scoreAfter: 1, version: 3 });
	expect(second.competition).toEqual({ competitionId: roundId, delta: 1, scoreAfter: 2, version: 4 });
	expect(second.progress).toMatchObject({ correct: 2, incorrect: 0, version: 2 });
	expect((await currentRound()).participants[0].score).toBe(2);
	expect((await tables()).events.map(event => event.score_after)).toEqual([1, 2]);
});

it.each([
	{ name: 'omitted ID', competitionId: undefined, state: 'active' },
	{ name: 'unknown valid UUID', competitionId: nextId, state: 'active' },
	{ name: 'waiting round', competitionId: roundId, state: 'waiting' },
	{ name: 'cancelled round', competitionId: roundId, state: 'cancelled' },
	{ name: 'finished round', competitionId: roundId, state: 'finished' },
	{ name: 'a round for other IDs', competitionId: roundId, state: 'other' },
])('saves study without a contribution: $name', async ({ competitionId, state }) => {
	if (state === 'waiting' || state === 'cancelled') await invite();
	else await startRound();
	if (state === 'cancelled') expect((await request(`/api/competitions/${roundId}/cancel`, { method: 'POST', cookie: cookieA })).status).toBe(200);
	if (state === 'finished') await env.DB.prepare("UPDATE competitions SET status = 'finished', score_b = 20, winner_id = ?, finished_at = ?, version = 3 WHERE id = ?")
		.bind(USER_B.id, now, roundId).run();
	if (state === 'other') {
		const otherA = '66666666-6666-4666-8666-666666666666', otherB = '77777777-7777-4777-8777-777777777777';
		await env.DB.prepare("INSERT INTO users (id, username, display_name, created_at) VALUES (?, 'other-a', 'Other A', 1), (?, 'other-b', 'Other B', 1)").bind(otherA, otherB).run();
		await env.DB.prepare('UPDATE competitions SET participant_a_id = ?1, participant_b_id = ?2, created_by = ?1 WHERE id = ?3').bind(otherA, otherB, roundId).run();
	}
	const before = await tables(), attempt = { ...input, competitionId };
	const result = await commitReview(env, USER_A.id, attempt, undefined, correct, 'exact', now);
	expect(result.competition).toBeNull();
	expect(await commitReview(env, USER_A.id, attempt, undefined, correct, 'exact', now + 1000)).toEqual(result);
	const saved = await tables();
	expect(saved.progress).toEqual([{ user_id: USER_A.id, card_id: CARD_A.id, correct: 1, incorrect: 0, last_correct_at: now, last_incorrect_at: null, version: 1 }]);
	expect(saved.reviews).toHaveLength(1);
	expect(saved.rounds).toEqual(before.rounds);
	expect(saved.events).toEqual([]);
	if (competitionId === undefined) expect(saved.reviews[0].input_json).toBe(JSON.stringify({ cardId: CARD_A.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Słowo' }));
});

it('replays a historical review', async () => {
	const canonical = JSON.stringify({ cardId: CARD_A.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Słowo' });
	const historical = { ...correct, attemptId: input.attemptId, cardId: CARD_A.id, direction: 'ru-pl', source: 'exact',
		progress: { correct: 1, incorrect: 0, lastCorrectAt: now - 1000, lastIncorrectAt: null, version: 1 } };
	await env.DB.prepare('INSERT INTO reviews (user_id, attempt_id, input_json, result_json) VALUES (?, ?, ?, ?)').bind(USER_A.id, input.attemptId, canonical, JSON.stringify(historical)).run();
	await env.DB.prepare('INSERT INTO card_progress (user_id, card_id, correct, incorrect, last_correct_at, version) VALUES (?, ?, 1, 0, ?, 1)').bind(USER_A.id, CARD_A.id, now - 1000).run();
	await startRound();
	const before = await tables(), attempt = { ...input, competitionId: undefined };
	const response = await request('/api/reviews', { method: 'POST', cookie: cookieA, body: attempt });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ...historical, competition: null });
	expect(await commitReview(env, USER_A.id, attempt, undefined, correct, 'exact', now)).toEqual({ ...historical, competition: null });
	expect(await tables()).toEqual(before);
	expect(before.events).toEqual([]);
});

it('rolls back all writes on a database failure', async () => {
	await startRound();
	await env.DB.prepare('UPDATE competitions SET score_a = 8 WHERE id = ?').bind(roundId).run();
	const current = { correct: 2, incorrect: 1, lastCorrectAt: now - 1000, lastIncorrectAt: now - 2000, version: 3 };
	await env.DB.prepare('INSERT INTO card_progress (user_id, card_id, correct, incorrect, last_correct_at, last_incorrect_at, version) VALUES (?, ?, 2, 1, ?, ?, 3)')
		.bind(USER_A.id, CARD_A.id, now - 1000, now - 2000).run();
	const before = await tables(), batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(statements => batch([
		...statements.slice(0, 4),
		env.DB.prepare('UPDATE competitions SET score_a = -1 WHERE id = ?').bind(roundId),
		...statements.slice(4),
	]));
	await expect(commitReview(env, USER_A.id, { ...input, progressVersion: 3 }, current, correct, 'exact', now)).rejects.toThrow('CHECK constraint failed');
	expect(await tables()).toEqual(before);
});
