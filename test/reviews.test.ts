import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReviewInput, ReviewResult } from '../shared/types';
import { login, request } from './client';
import { CARD_A, USER_A, USER_B } from './fixtures';
import { CALLBACK, createOpenAI, responseStream } from './openai';

const now = Date.parse('2026-10-21T10:00:00.000Z');
const input: ReviewInput = { attemptId: '10000000-0000-4000-8000-000000000001', cardId: CARD_A.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'wyraz' };
const correct = { grade: 'correct', correction: 'Słowo', explanationRu: 'Верный перевод для этого значения.' };
let provider: Awaited<ReturnType<typeof createOpenAI>>, cookie: string;
async function connect(id: string, account: string) {
	const cookie = await login(id);
	const start = await request('/api/ai/connection/start', { method: 'POST', cookie });
	const url = new URL((await start.json<{ url: string }>()).url);
	const address = `${CALLBACK}?${new URLSearchParams({ code: `${account}:${url.searchParams.get('nonce')}`, state: url.searchParams.get('state')!, client_id: `oaiapp_${account}` })}`;
	expect((await request('/api/ai/connection/finish', { method: 'POST', cookie, body: { address } })).status).toBe(200);
	return cookie;
}
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now);
	provider = await createOpenAI();
	vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch);
	cookie = await connect(USER_A.id, 'a');
	provider.responses = () => responseStream(correct);
	expect((await request('/api/cards', { method: 'POST', cookie, body: { ...CARD_A, alternativesPl: [] } })).status).toBe(201);
});
afterEach(() => vi.useRealTimers());
const review = (body: unknown = input) => request('/api/reviews', { method: 'POST', cookie, body });
const calls = () => provider.calls.filter(call => call.url.endsWith('/responses'));
async function tables() {
	return {
		state: (await env.DB.prepare('SELECT * FROM review_state ORDER BY user_id, card_id, direction').all()).results,
		reviews: (await env.DB.prepare('SELECT * FROM reviews ORDER BY user_id, attempt_id').all()).results,
	};
}

it('replays a saved attempt after its response is lost with one interval update', async () => {
	expect((await review()).status).toBe(200);
	const saved = (await tables()).reviews;
	expect(saved).toHaveLength(1);
	const savedResult = JSON.parse(String(saved[0].result_json));
	expect(savedResult).toMatchObject({ ...correct, source: 'ai', progress: { version: 1, stage: 1, dueAt: now + 86_400_000, lastReviewedAt: now } });
	const retry = await review({ answer: 'wyraz', action: 'answer', direction: 'ru-pl', progressVersion: 0, cardVersion: 1, cardId: CARD_A.id, attemptId: input.attemptId });
	expect(retry.status).toBe(200);
	expect(await retry.json()).toEqual(savedResult);
	expect(await tables()).toMatchObject({ reviews: saved, state: [{ user_id: USER_A.id, version: 1, stage: 1, due_at: now + 86_400_000 }] });
	expect(calls()).toHaveLength(1);
});

it.each([
	{ name: 'answer whitespace', change: { answer: ' wyraz ' } },
	{ name: 'answer case', change: { answer: 'Wyraz' } },
	{ name: 'direction', change: { direction: 'pl-ru' } },
	{ name: 'card version', change: { cardVersion: 2 } },
	{ name: 'progress version', change: { progressVersion: 1 } },
	{ name: 'action', change: { action: 'reveal', answer: undefined } },
])('rejects changed $name under a saved attempt ID before inference', async ({ change }) => {
	expect((await review()).status).toBe(200);
	const before = await tables();
	const response = await review({ ...input, ...change });
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'review_conflict' });
	expect(await tables()).toEqual(before);
	expect(calls()).toHaveLength(1);
});

it.each([
	{ name: 'edit', change: { ...CARD_A, id: undefined, version: 1, pl: 'Wyraz' } },
	{ name: 'archive', change: { version: 1, archived: true } },
])('replays the original result after a later review, card $name, and disconnect', async ({ change }) => {
	const first = await review();
	expect(first.status).toBe(200);
	const original = await first.json<ReviewResult>();
	expect((await review({ ...input, attemptId: crypto.randomUUID(), progressVersion: 1, action: 'reveal', answer: undefined })).status).toBe(200);
	expect((await request(`/api/cards/${CARD_A.id}`, { method: 'PATCH', cookie, body: change })).status).toBe(200);
	expect((await request('/api/ai/connection', { method: 'DELETE', cookie })).status).toBe(200);
	const before = await tables();
	const retry = await review();
	expect(retry.status).toBe(200);
	expect(await retry.json()).toEqual(original);
	expect(await tables()).toEqual(before);
	expect(before.state).toMatchObject([{ version: 2, stage: 0, due_at: now + 60_000 }]);
	expect(calls()).toHaveLength(1);
});

it.each([
	{ name: 'malformed stream', response: () => new Response('data: invalid\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), status: 503, code: 'ai_invalid_response' },
	{ name: 'interrupted stream', response: () => new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), status: 503, code: 'ai_interrupted' },
	{ name: 'usage limit', response: () => Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 }), status: 429, code: 'subscription_sharing_usage_limit_exceeded' },
	{ name: 'provider authentication failure', response: () => Response.json({ error: { code: 'subscription_sharing_invalid_user' } }, { status: 401 }), status: 401, code: 'subscription_sharing_invalid_user' },
])('keeps an exact success and a failed semantic check separate for $name in one session', async ({ response, status, code }) => {
	expect((await review({ ...input, attemptId: crypto.randomUUID(), answer: ' Słowo ' })).status).toBe(200);
	expect(calls()).toHaveLength(0);
	const before = await tables();
	await env.DB.prepare('UPDATE ai_connections SET refresh_after=NULL WHERE user_id=?').bind(USER_A.id).run();
	provider.responses = response;
	const semantic = { ...input, progressVersion: 1 };
	const failed = await review(semantic);
	expect(failed.status).toBe(status);
	expect(await failed.json()).toMatchObject({ code, error: expect.any(String) });
	expect(await tables()).toEqual(before);
	provider.responses = () => responseStream(correct);
	const retry = await review(semantic);
	expect(retry.status).toBe(200);
	expect(await retry.json()).toMatchObject({ grade: 'correct', source: 'ai', progress: { version: 2, stage: 2, dueAt: now + 259_200_000 } });
	expect((await tables()).reviews).toHaveLength(2);
});

it.each([
	{ name: 'unknown grade', result: { ...correct, grade: 'good' } },
	{ name: 'missing grade', result: { ...correct, grade: undefined } },
	{ name: 'missing correction', result: { ...correct, correction: undefined } },
	{ name: 'blank correction', result: { ...correct, correction: ' ' } },
	{ name: 'oversized correction', result: { ...correct, correction: 'a'.repeat(201) } },
	{ name: 'missing explanation', result: { ...correct, explanationRu: undefined } },
	{ name: 'non-string explanation', result: { ...correct, explanationRu: 1 } },
	{ name: 'blank explanation', result: { ...correct, explanationRu: ' ' } },
	{ name: 'oversized explanation', result: { ...correct, explanationRu: 'я'.repeat(501) } },
	{ name: 'unexpected result field', result: { ...correct, stage: 6 } },
])('rejects an AI result with $name before storage', async ({ result }) => {
	provider.responses = () => responseStream(result);
	const response = await review();
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({ code: 'ai_invalid_response' });
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it('returns the stored target term even when a valid model correction uses a synonym', async () => {
	provider.responses = () => responseStream({ ...correct, correction: 'Wyraz' });
	const response = await review();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ grade: 'correct', correction: 'Słowo' });
});

it.each([
	{ name: 'edit', change: { ...CARD_A, id: undefined, version: 1, pl: 'Wyraz' } },
	{ name: 'archive', change: { version: 1, archived: true } },
])('rejects a card $name while AI grading is pending', async ({ change }) => {
	const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	provider.responses = async () => { ready.resolve(); await release.promise; return responseStream(correct); };
	const pending = review();
	await Promise.race([ready.promise, pending]);
	try {
		expect(calls()).toHaveLength(1);
		expect(await tables()).toEqual({ state: [], reviews: [] });
		expect((await request(`/api/cards/${CARD_A.id}`, { method: 'PATCH', cookie, body: change })).status).toBe(200);
	} finally { release.resolve(); }
	const response = await pending;
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'version_conflict' });
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it.each([
	{ name: 'exact answer', body: { ...input, answer: ' Słowo ' }, grade: 'correct', correction: 'Słowo', source: 'exact', stage: 1, delay: 86_400_000 },
	{ name: 'empty answer', body: { ...input, answer: '' }, grade: 'again', correction: 'Słowo', source: 'exact', stage: 0, delay: 60_000 },
	{ name: 'reveal', body: { ...input, action: 'reveal', answer: undefined }, grade: 'again', correction: 'Słowo', source: 'reveal', stage: 0, delay: 60_000 },
	{ name: 'Russian reveal', body: { ...input, action: 'reveal', answer: undefined, direction: 'pl-ru' }, grade: 'again', correction: 'Слово', source: 'reveal', stage: 0, delay: 60_000 },
])('saves a disconnected learner’s $name without provider access', async ({ body, grade, correction, source, stage, delay }) => {
	expect((await request('/api/ai/connection', { method: 'DELETE', cookie })).status).toBe(200);
	const count = provider.calls.length;
	const response = await review(body);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ grade, correction, source, progress: { stage, version: 1, dueAt: now + delay } });
	expect((await tables()).reviews).toHaveLength(1);
	expect(provider.calls).toHaveLength(count);
});

it.each([
	{ name: 'client expected answer', change: { expectedAnswer: 'wyraz' } },
	{ name: 'client card content', change: { card: CARD_A } },
	{ name: 'client learner', change: { userId: USER_B.id } },
	{ name: 'invalid attempt ID', change: { attemptId: 'invalid' } },
	{ name: 'invalid card ID', change: { cardId: 'invalid' } },
	{ name: 'zero card version', change: { cardVersion: 0 } },
	{ name: 'negative progress version', change: { progressVersion: -1 } },
	{ name: 'fractional version', change: { progressVersion: 0.5 } },
	{ name: 'missing version', change: { cardVersion: undefined } },
	{ name: 'invalid direction', change: { direction: 'pl-en' } },
	{ name: 'missing action', change: { action: undefined } },
	{ name: 'missing answer', change: { answer: undefined } },
	{ name: 'non-string answer', change: { answer: 1 } },
	{ name: 'oversized answer', change: { answer: 'a'.repeat(501) } },
	{ name: 'answer on reveal', change: { action: 'reveal' } },
])('rejects $name before grading', async ({ change }) => {
	const response = await review({ ...input, ...change });
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ code: 'invalid_input' });
	expect(calls()).toHaveLength(0);
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it.each([
	{ name: 'stale card version', archived: 0 },
	{ name: 'archived card', archived: 1 },
])('rejects a new attempt for a $name before inference', async ({ archived }) => {
	await env.DB.prepare('UPDATE cards SET version=2, archived=? WHERE id=?').bind(archived, CARD_A.id).run();
	const response = await review({ ...input, cardVersion: archived ? 2 : 1 });
	expect(response.status).toBe(409);
	expect(calls()).toHaveLength(0);
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it('uses the signed-in learner’s model and credentials when another learner is connected', async () => {
	await connect(USER_B.id, 'b');
	expect((await request('/api/ai/connection', { method: 'PATCH', cookie, body: { model: 'a-second' } })).status).toBe(200);
	expect((await review()).status).toBe(200);
	expect(calls()[0].headers.get('Authorization')).toBe('Bearer access-a');
	expect(await calls()[0].json()).toMatchObject({ model: 'a-second', store: false, stream: true });
	expect((await tables()).state).toMatchObject([{ user_id: USER_A.id }]);
});

it('requires an authenticated same-origin POST', async () => {
	expect((await request('/api/reviews', { method: 'POST', body: input })).status).toBe(401);
	expect((await request('/api/reviews', { method: 'POST', cookie, origin: 'https://elsewhere.test', body: input })).status).toBe(403);
	expect((await request('/api/reviews', { cookie })).status).toBe(405);
	expect(calls()).toHaveLength(0);
	expect(await tables()).toEqual({ state: [], reviews: [] });
});
