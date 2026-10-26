import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import type { Competition } from '../shared/types';
import { login, request } from './client';
import { USER_A, USER_B, testAccountSecret } from './fixtures';

const roundId = '33333333-3333-4333-8333-333333333333';
const previousId = '55555555-5555-4555-8555-555555555555';

it('returns one waiting round for concurrent invitations', async () => {
	const cookieA = await login(USER_A.id), cookieB = await login(USER_B.id);
	const responses = await Promise.all([
		request('/api/competitions', { method: 'POST', cookie: cookieA, body: { id: crypto.randomUUID() } }),
		request('/api/competitions', { method: 'POST', cookie: cookieB, body: { id: crypto.randomUUID() } }),
	]);
	const rounds = await Promise.all(responses.map(response => response.json<Competition>()));
	expect(responses.map(response => response.status)).toEqual([200, 200]);
	expect(rounds[0].id).toBe(rounds[1].id);
	expect(rounds[0]).toEqual(rounds[1]);
	expect(rounds[0]).toMatchObject({ status: 'waiting', target: 20, version: 1, winnerId: null, startedAt: null, finishedAt: null });
	expect(rounds[0].participants).toEqual([
		{ id: USER_A.id, displayName: USER_A.displayName, score: 0 },
		{ id: USER_B.id, displayName: USER_B.displayName, score: 0 },
	]);
	expect(await env.DB.prepare("SELECT count(*) FROM competitions WHERE status IN ('waiting', 'active')").first('count(*)')).toBe(1);
	expect(responses.map(response => response.headers.get('Cache-Control'))).toEqual(['private, no-store', 'private, no-store']);
});

it('replays an invitation ID', async () => {
	const cookie = await login(USER_A.id);
	await login(USER_B.id);
	const first = await (await request('/api/competitions', { method: 'POST', cookie, body: { id: roundId } })).json<Competition>();
	const replay = await (await request('/api/competitions', { method: 'POST', cookie, body: { id: roundId } })).json<Competition>();
	expect(replay).toEqual(first);
	expect(await env.DB.prepare('SELECT count(*) FROM competitions').first('count(*)')).toBe(1);
	await env.DB.prepare("UPDATE competitions SET status = 'finished', score_a = 20, winner_id = ?, started_at = 100, finished_at = 200, version = 22 WHERE id = ?")
		.bind(USER_A.id, roundId).run();
	const finished = await (await request('/api/competitions/current', { cookie })).json<Competition>();
	const finishedReplay = await request('/api/competitions', { method: 'POST', cookie, body: { id: roundId } });
	expect(finishedReplay.status).toBe(200);
	expect(await finishedReplay.json()).toEqual(finished);
	expect(await env.DB.prepare('SELECT count(*) FROM competitions').first('count(*)')).toBe(1);
	expect((await request('/api/competitions', { method: 'POST', cookie, body: { id: previousId } })).status).toBe(200);
	expect(await (await request('/api/competitions', { method: 'POST', cookie, body: { id: roundId } })).json()).toEqual(finished);
});

it('starts only after the invited learner accepts', async () => {
	const cookieA = await login(USER_A.id), cookieB = await login(USER_B.id);
	const waiting = await (await request('/api/competitions', { method: 'POST', cookie: cookieB, body: { id: roundId } })).json<Competition>();
	expect(waiting).toMatchObject({ createdBy: USER_B.id, status: 'waiting', version: 1 });
	expect((await request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie: cookieB })).status).toBe(403);
	expect(await (await request('/api/competitions/current', { cookie: cookieA })).json()).toEqual(waiting);
	const before = Date.now();
	const response = await request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie: cookieA });
	expect(response.status).toBe(200);
	const active = await response.json<Competition>();
	expect(active).toMatchObject({ status: 'active', version: 2, winnerId: null, finishedAt: null });
	expect(active.participants.map(person => person.score)).toEqual([0, 0]);
	expect(active.startedAt).toBeGreaterThanOrEqual(before);
	expect(active.startedAt).toBeLessThanOrEqual(Date.now());
	const replay = await request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie: cookieA });
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(active);
	await env.DB.prepare("UPDATE competitions SET status = 'finished', score_b = 20, winner_id = ?, finished_at = ?, version = 22 WHERE id = ?")
		.bind(USER_B.id, Date.now(), roundId).run();
	const finished = await (await request('/api/competitions/current', { cookie: cookieA })).json<Competition>();
	const finishedReplay = await request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie: cookieA });
	expect(finishedReplay.status).toBe(200);
	expect(await finishedReplay.json()).toEqual(finished);
});

it('serializes acceptance and cancellation', async () => {
	const cookieA = await login(USER_A.id), cookieB = await login(USER_B.id);
	expect((await request('/api/competitions', { method: 'POST', cookie: cookieA, body: { id: roundId } })).status).toBe(200);
	const responses = await Promise.all([
		request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie: cookieB }),
		request(`/api/competitions/${roundId}/cancel`, { method: 'POST', cookie: cookieA }),
	]);
	expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
	const row = await env.DB.prepare('SELECT status, version FROM competitions WHERE id = ?').bind(roundId).first<{ status: string; version: number }>();
	expect(['active', 'cancelled']).toContain(row?.status);
	expect(row?.version).toBe(2);
	expect(await responses.find(response => response.status === 409)!.json()).toMatchObject({ code: 'competition_conflict' });
});

it.each([
	{ name: 'creator', userId: USER_A.id },
	{ name: 'invitee', userId: USER_B.id },
])('cancels from either account: $name', async ({ userId }) => {
	const cookieA = await login(USER_A.id), cookieB = await login(USER_B.id);
	expect((await request('/api/competitions', { method: 'POST', cookie: cookieA, body: { id: roundId } })).status).toBe(200);
	const cookie = userId === USER_A.id ? cookieA : cookieB;
	const response = await request(`/api/competitions/${roundId}/cancel`, { method: 'POST', cookie });
	expect(response.status).toBe(200);
	const cancelled = await response.json<Competition>();
	expect(cancelled).toMatchObject({ status: 'cancelled', version: 2, startedAt: null, winnerId: null });
	const replay = await request(`/api/competitions/${roundId}/cancel`, { method: 'POST', cookie });
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(cancelled);
	const accept = await request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie: cookieB });
	expect(accept.status).toBe(409);
	expect(await accept.json()).toMatchObject({ code: 'competition_conflict' });
	expect(await (await request('/api/competitions/current', { cookie })).json()).toBeNull();
});

it('rejects cancellation after acceptance', async () => {
	const cookieA = await login(USER_A.id), cookieB = await login(USER_B.id);
	expect((await request('/api/competitions', { method: 'POST', cookie: cookieA, body: { id: roundId } })).status).toBe(200);
	expect((await request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie: cookieB })).status).toBe(200);
	const before = await env.DB.prepare('SELECT * FROM competitions WHERE id = ?').bind(roundId).first();
	const response = await request(`/api/competitions/${roundId}/cancel`, { method: 'POST', cookie: cookieA });
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'competition_conflict' });
	const after = await env.DB.prepare('SELECT * FROM competitions WHERE id = ?').bind(roundId).first();
	expect(after).toEqual(before);
});

it.each([
	{ name: 'no history', previous: false, status: null, finishedAt: null, expectedId: null },
	{ name: 'waiting over finished', previous: true, status: 'waiting', finishedAt: null, expectedId: roundId },
	{ name: 'active over finished', previous: true, status: 'active', finishedAt: null, expectedId: roundId },
	{ name: 'a cancelled invitation after a finished round', previous: true, status: 'cancelled', finishedAt: 300, expectedId: previousId },
	{ name: 'the latest finish time', previous: true, status: 'finished', finishedAt: 300, expectedId: roundId },
	{ name: 'the highest ID at the same finish time', previous: true, status: 'finished', finishedAt: 200, expectedId: previousId },
])('selects the current result: $name', async ({ previous, status, finishedAt, expectedId }) => {
	const cookie = await login(USER_A.id);
	await login(USER_B.id);
	if (previous) await env.DB.prepare(`INSERT INTO competitions
		(id, participant_a_id, participant_b_id, score_a, score_b, target, created_by, status, winner_id, created_at, started_at, finished_at, version)
		VALUES (?, ?, ?, 20, 7, 20, ?, 'finished', ?, 50, 100, 200, 29)`)
		.bind(previousId, USER_A.id, USER_B.id, USER_A.id, USER_A.id).run();
	if (status) await env.DB.prepare(`INSERT INTO competitions
		(id, participant_a_id, participant_b_id, score_a, score_b, target, created_by, status, winner_id, created_at, started_at, finished_at, version)
		VALUES (?, ?, ?, ?, 0, 20, ?, ?, ?, 250, ?, ?, ?)`)
		.bind(roundId, USER_A.id, USER_B.id, status === 'finished' ? 20 : 0, USER_B.id, status,
			status === 'finished' ? USER_A.id : null, status === 'active' || status === 'finished' ? 260 : null, finishedAt, status === 'waiting' ? 1 : 2).run();
	const response = await request('/api/competitions/current', { cookie });
	expect(response.status).toBe(200);
	expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	const current = await response.json<Competition | null>();
	expect(current?.id ?? null).toBe(expectedId);
});

it('starts a rematch without changing the finished round', async () => {
	const cookieA = await login(USER_A.id), cookieB = await login(USER_B.id);
	await env.DB.prepare(`INSERT INTO competitions
		(id, participant_a_id, participant_b_id, score_a, score_b, target, created_by, status, winner_id, created_at, started_at, finished_at, version)
		VALUES (?, ?, ?, 20, 7, 20, ?, 'finished', ?, 50, 100, 200, 29)`)
		.bind(previousId, USER_A.id, USER_B.id, USER_A.id, USER_A.id).run();
	const previous = await env.DB.prepare('SELECT * FROM competitions WHERE id = ?').bind(previousId).first();
	expect((await request('/api/competitions', { method: 'POST', cookie: cookieB, body: { id: roundId } })).status).toBe(200);
	const response = await request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie: cookieA });
	expect(response.status).toBe(200);
	const rematch = await response.json<Competition>();
	expect(rematch).toMatchObject({ id: roundId, status: 'active', version: 2, createdBy: USER_B.id });
	expect(rematch.participants.map(person => person.score)).toEqual([0, 0]);
	expect(await env.DB.prepare('SELECT * FROM competitions WHERE id = ?').bind(previousId).first()).toEqual(previous);
});

it('requires the other account to sign in', async () => {
	const cookie = await login(USER_A.id);
	const response = await request('/api/competitions', { method: 'POST', cookie, body: { id: roundId } });
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ code: 'opponent_not_ready', error: 'Druga osoba musi najpierw zalogować się do aplikacji.' });
	expect(await env.DB.prepare('SELECT count(*) FROM competitions').first('count(*)')).toBe(0);
});

it.each([
	{ name: 'one configured account', count: 1 },
	{ name: 'three configured accounts', count: 3 },
])('requires two accounts with $name', async ({ count }) => {
	const cookie = await login(USER_A.id);
	const accounts = JSON.parse(testAccountSecret);
	env.ACCOUNTS = JSON.stringify(count === 1 ? accounts.slice(0, 1) : [...accounts, { ...accounts[0], id: previousId, username: 'other-test' }]);
	const response = await request('/api/competitions', { method: 'POST', cookie, body: { id: roundId } });
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({ code: 'competition_unavailable' });
	expect(await env.DB.prepare('SELECT count(*) FROM competitions').first('count(*)')).toBe(0);
});

it.each([
	{ name: 'missing read session', path: '/api/competitions/current', method: 'GET', anonymous: true, status: 401 },
	{ name: 'missing invitation session', path: '/api/competitions', method: 'POST', anonymous: true, body: { id: roundId }, status: 401 },
	{ name: 'missing acceptance session', path: `/api/competitions/${roundId}/accept`, method: 'POST', anonymous: true, status: 401 },
	{ name: 'missing cancellation session', path: `/api/competitions/${roundId}/cancel`, method: 'POST', anonymous: true, status: 401 },
	{ name: 'wrong origin', path: '/api/competitions', method: 'POST', origin: 'https://other.example', body: { id: roundId }, status: 403 },
	{ name: 'account mismatch', path: '/api/competitions', method: 'POST', accountId: USER_B.id, body: { id: roundId }, status: 409 },
	{ name: 'wrong invitation method', path: '/api/competitions', method: 'GET', status: 405 },
	{ name: 'wrong current method', path: '/api/competitions/current', method: 'POST', status: 405 },
	{ name: 'wrong acceptance method', path: `/api/competitions/${roundId}/accept`, method: 'GET', status: 405 },
	{ name: 'wrong cancellation method', path: `/api/competitions/${roundId}/cancel`, method: 'GET', status: 405 },
	{ name: 'invalid invitation UUID', path: '/api/competitions', method: 'POST', body: { id: 'invalid' }, status: 400 },
	{ name: 'invalid acceptance UUID', path: '/api/competitions/invalid/accept', method: 'POST', status: 400 },
	{ name: 'invalid cancellation UUID', path: '/api/competitions/invalid/cancel', method: 'POST', status: 400 },
	{ name: 'client-supplied score', path: '/api/competitions', method: 'POST', body: { id: roundId, score: 20 }, status: 400 },
	{ name: 'client-supplied participants', path: '/api/competitions', method: 'POST', body: { id: roundId, participants: [USER_A.id, USER_B.id] }, status: 400 },
	{ name: 'client-supplied acceptance score', path: `/api/competitions/${roundId}/accept`, method: 'POST', body: { score: 20 }, status: 400 },
	{ name: 'client-supplied cancellation winner', path: `/api/competitions/${roundId}/cancel`, method: 'POST', body: { winnerId: USER_A.id }, status: 400 },
])('protects competition endpoints: $name', async ({ path, method, anonymous, origin, accountId, body, status }) => {
	const cookie = await login(USER_A.id);
	await login(USER_B.id);
	const response = await request(path, { method, cookie: anonymous ? undefined : cookie, origin, accountId, body });
	expect(response.status).toBe(status);
	expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	expect(await env.DB.prepare('SELECT count(*) FROM competitions').first('count(*)')).toBe(0);
});

it.each([
	{ name: 'waiting round', status: 'waiting', finishedAt: null },
	{ name: 'finished round', status: 'finished', finishedAt: 200 },
])('restricts reads and mutations to participants of a $name', async ({ status, finishedAt }) => {
	const cookie = await login(USER_A.id);
	const otherA = '66666666-6666-4666-8666-666666666666', otherB = '77777777-7777-4777-8777-777777777777';
	await env.DB.prepare("INSERT INTO users (id, username, display_name, created_at) VALUES (?, 'other-a', 'Other A', 1), (?, 'other-b', 'Other B', 1)")
		.bind(otherA, otherB).run();
	await env.DB.prepare(`INSERT INTO competitions
		(id, participant_a_id, participant_b_id, target, created_by, status, created_at, finished_at)
		VALUES (?, ?, ?, 20, ?, ?, 100, ?)`)
		.bind(roundId, otherA, otherB, otherA, status, finishedAt).run();
	const before = await env.DB.prepare('SELECT * FROM competitions WHERE id = ?').bind(roundId).first();
	const current = await request('/api/competitions/current', { cookie });
	expect(current.status).toBe(200);
	expect(await current.json()).toBeNull();
	expect((await request(`/api/competitions/${roundId}/accept`, { method: 'POST', cookie })).status).toBe(404);
	expect((await request(`/api/competitions/${roundId}/cancel`, { method: 'POST', cookie })).status).toBe(404);
	expect(await env.DB.prepare('SELECT * FROM competitions WHERE id = ?').bind(roundId).first()).toEqual(before);
});

it.each([
	{ name: 'acceptance', action: 'accept' },
	{ name: 'cancellation', action: 'cancel' },
])('returns 404 for $name of a missing round', async ({ action }) => {
	const cookie = await login(USER_A.id);
	expect((await request(`/api/competitions/${roundId}/${action}`, { method: 'POST', cookie })).status).toBe(404);
});

it.each([
	{ name: 'duplicate participants', assignment: 'participant_b_id = participant_a_id' },
	{ name: 'non-participant creator', assignment: `created_by = '${previousId}'` },
	{ name: 'non-participant winner', assignment: `winner_id = '${previousId}'` },
	{ name: 'zero target', assignment: 'target = 0' },
	{ name: 'zero version', assignment: 'version = 0' },
	{ name: 'unknown status', assignment: "status = 'unknown'" },
	{ name: 'negative first score', assignment: 'score_a = -1' },
	{ name: 'negative second score', assignment: 'score_b = -1' },
	{ name: 'first score above the target', assignment: 'score_a = 21' },
	{ name: 'second score above the target', assignment: 'score_b = 21' },
])('rejects stored rounds with $name', async ({ assignment }) => {
	const cookie = await login(USER_A.id);
	await login(USER_B.id);
	await env.DB.prepare("INSERT INTO users (id, username, display_name, created_at) VALUES (?, 'other', 'Other', 1)").bind(previousId).run();
	expect((await request('/api/competitions', { method: 'POST', cookie, body: { id: roundId } })).status).toBe(200);
	const before = await env.DB.prepare('SELECT * FROM competitions WHERE id = ?').bind(roundId).first();
	await expect(env.DB.prepare(`UPDATE competitions SET ${assignment} WHERE id = ?`).bind(roundId).run()).rejects.toThrow('CHECK constraint failed');
	expect(await env.DB.prepare('SELECT * FROM competitions WHERE id = ?').bind(roundId).first()).toEqual(before);
});

it('links each competition event to one saved review', async () => {
	const cookie = await login(USER_A.id);
	await login(USER_B.id);
	expect((await request('/api/competitions', { method: 'POST', cookie, body: { id: roundId } })).status).toBe(200);
	const attemptId = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO reviews (user_id, attempt_id, input_json, result_json) VALUES (?, ?, '{}', '{}'), (?, ?, '{}', '{}')")
		.bind(USER_A.id, attemptId, USER_B.id, attemptId).run();
	const insert = env.DB.prepare('INSERT INTO competition_events (competition_id, user_id, attempt_id, delta, score_after, version) VALUES (?, ?, ?, 1, 1, 3)');
	await insert.bind(roundId, USER_A.id, attemptId).run();
	await expect(insert.bind(roundId, USER_A.id, attemptId).run()).rejects.toThrow('UNIQUE constraint failed');
	await expect(insert.bind(roundId, USER_B.id, crypto.randomUUID()).run()).rejects.toThrow('FOREIGN KEY constraint failed');
	await expect(insert.bind(previousId, USER_B.id, attemptId).run()).rejects.toThrow('FOREIGN KEY constraint failed');
	await insert.bind(roundId, USER_B.id, attemptId).run();
	expect(await env.DB.prepare('SELECT count(*) FROM competition_events').first('count(*)')).toBe(2);
});
