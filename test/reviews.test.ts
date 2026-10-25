import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReviewInput, ReviewResult } from '../shared/types';
import { login, request } from './client';
import { CARD_A, USER_A, USER_B } from './fixtures';
import { apiError, createProvider, message } from './provider';

const now = Date.parse('2026-10-21T10:00:00.000Z');
const input: ReviewInput = { attemptId: '10000000-0000-4000-8000-000000000001', cardId: CARD_A.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'wyraz' };
const correct = { grade: 'correct', explanation: 'Poprawne tłumaczenie w tym znaczeniu.' };
let provider: ReturnType<typeof createProvider>, cookie: string;
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now);
	provider = createProvider();
	vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch);
	cookie = await login(USER_A.id);
	provider.messages = () => message(correct);
	expect((await request('/api/cards', { method: 'POST', cookie, body: { ...CARD_A, alternativesPl: [] } })).status).toBe(201);
});
afterEach(() => vi.useRealTimers());
const review = (body: unknown = input) => request('/api/reviews', { method: 'POST', cookie, body });
async function tables() {
	return {
		state: (await env.DB.prepare('SELECT * FROM card_progress ORDER BY user_id, card_id').all()).results,
		reviews: (await env.DB.prepare('SELECT * FROM reviews ORDER BY user_id, attempt_id').all()).results,
	};
}

it('replays a saved attempt after its response is lost with one interval update', async () => {
	expect((await review()).status).toBe(200);
	const saved = (await tables()).reviews;
	expect(saved).toHaveLength(1);
	const savedResult = JSON.parse(String(saved[0].result_json));
	expect(savedResult).toMatchObject({ ...correct, source: 'ai', progress: { correct: 1, incorrect: 0, lastCorrectAt: now, lastIncorrectAt: null, version: 1 } });
	const retry = await review({ answer: 'wyraz', action: 'answer', direction: 'ru-pl', progressVersion: 0, cardVersion: 1, cardId: CARD_A.id, attemptId: input.attemptId });
	expect(retry.status).toBe(200);
	expect(await retry.json()).toEqual(savedResult);
	expect(await tables()).toMatchObject({ reviews: saved, state: [{ user_id: USER_A.id, version: 1, correct: 1, incorrect: 0 }] });
	expect(provider.calls).toHaveLength(1);
});

it.each([
	{ name: 'answer case', change: { answer: 'Wyraz' } },
	{ name: 'progress version', change: { progressVersion: 1 } },
])('rejects changed $name under a saved attempt ID before inference', async ({ change }) => {
	expect((await review()).status).toBe(200);
	const before = await tables();
	const response = await review({ ...input, ...change });
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'review_conflict' });
	expect(await tables()).toEqual(before);
	expect(provider.calls).toHaveLength(1);
});

it.each([
	{ name: 'edit', change: { ...CARD_A, id: undefined, version: 1, pl: 'Wyraz' } },
	{ name: 'archive', change: { version: 1, archived: true } },
])('replays the original result after a later review, card $name, and a missing key', async ({ change }) => {
	const first = await review();
	expect(first.status).toBe(200);
	const original = await first.json<ReviewResult>();
	expect((await review({ ...input, attemptId: crypto.randomUUID(), progressVersion: 1, action: 'reveal', answer: undefined })).status).toBe(200);
	expect((await request(`/api/cards/${CARD_A.id}`, { method: 'PATCH', cookie, body: change })).status).toBe(200);
	Reflect.deleteProperty(env, 'ANTHROPIC_API_KEY');
	const before = await tables();
	const retry = await review();
	expect(retry.status).toBe(200);
	expect(await retry.json()).toEqual(original);
	expect(await tables()).toEqual(before);
	expect(before.state).toMatchObject([{ version: 2, correct: 1, incorrect: 1 }]);
	expect(provider.calls).toHaveLength(1);
});

it.each([
	{ name: 'non-JSON reply', response: () => message(null, 'end_turn', [{ type: 'text', text: 'not JSON' }]), code: 'ai_invalid_response' },
	{ name: 'provider overload', response: () => apiError(529, 'overloaded_error'), code: 'ai_unavailable' },
])('keeps an exact success and a failed semantic check separate for $name in one session', async ({ response, code }) => {
	expect((await review({ ...input, attemptId: crypto.randomUUID(), answer: ' Słowo ' })).status).toBe(200);
	expect(provider.calls).toHaveLength(0);
	const before = await tables();
	provider.messages = response;
	const semantic = { ...input, progressVersion: 1 };
	const failed = await review(semantic);
	expect(failed.status).toBe(503);
	expect(failed.headers.get('X-Review-Recovery')).toBe('editable');
	expect(await failed.json()).toMatchObject({ code, error: expect.any(String) });
	expect(await tables()).toEqual(before);
	provider.messages = () => message(correct);
	const retry = await review(semantic);
	expect(retry.status).toBe(200);
	expect(await retry.json()).toMatchObject({ grade: 'correct', source: 'ai', progress: { version: 2, correct: 2, incorrect: 0 } });
	expect((await tables()).reviews).toHaveLength(2);
});

it.each([
	{ name: 'unknown grade', result: { ...correct, grade: 'good' } },
	{ name: 'missing grade', result: { ...correct, grade: undefined } },
	{ name: 'oversized explanation', result: { ...correct, explanation: 'я'.repeat(501) } },
	{ name: 'unexpected result field', result: { ...correct, stage: 6 } },
])('rejects an AI result with $name before storage', async ({ result }) => {
	provider.messages = () => message(result);
	const response = await review();
	expect(response.status).toBe(503);
	expect(response.headers.get('X-Review-Recovery')).toBe('editable');
	expect(await response.json()).toEqual({ code: 'ai_invalid_response', error: 'Model AI zwrócił nieprawidłową ocenę. Spróbuj ponownie.' });
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it.each([
	{ name: 'edit', change: { ...CARD_A, id: undefined, version: 1, pl: 'Wyraz' } },
	{ name: 'archive', change: { version: 1, archived: true } },
])('rejects a card $name while AI grading is pending', async ({ change }) => {
	const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	provider.messages = async () => { ready.resolve(); await release.promise; return message(correct); };
	const pending = review();
	await Promise.race([ready.promise, pending]);
	try {
		expect(provider.calls).toHaveLength(1);
		expect(await tables()).toEqual({ state: [], reviews: [] });
		expect((await request(`/api/cards/${CARD_A.id}`, { method: 'PATCH', cookie, body: change })).status).toBe(200);
	} finally { release.resolve(); }
	const response = await pending;
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'version_conflict' });
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it.each([
	{ name: 'exact answer', body: { ...input, answer: ' Słowo ' }, grade: 'correct', correction: 'Słowo', explanation: 'Dobrze.', source: 'exact', correct: 1, incorrect: 0 },
	{ name: 'empty answer', body: { ...input, answer: '' }, grade: 'again', correction: 'Słowo', explanation: 'Brak odpowiedzi. Powtórz słowo.', source: 'exact', correct: 0, incorrect: 1 },
	{ name: 'reveal', body: { ...input, action: 'reveal', answer: undefined }, grade: 'again', correction: 'Słowo', explanation: 'Powtórz słowo.', source: 'reveal', correct: 0, incorrect: 1 },
	{ name: 'Russian reveal', body: { ...input, action: 'reveal', answer: undefined, direction: 'pl-ru' }, grade: 'again', correction: 'Слово', explanation: 'Powtórz słowo.', source: 'reveal', correct: 0, incorrect: 1 },
])('saves the $name without the AI key and provider access', async ({ body, grade, correction, explanation, source, correct, incorrect }) => {
	Reflect.deleteProperty(env, 'ANTHROPIC_API_KEY');
	const count = provider.calls.length;
	const response = await review(body);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ grade, correction, explanation, source, progress: { correct, incorrect, version: 1 } });
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
	expect(provider.calls).toHaveLength(0);
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it.each([
	{ name: 'stale card version', archived: 0 },
	{ name: 'archived card', archived: 1 },
])('rejects a new attempt for a $name before inference', async ({ archived }) => {
	await env.DB.prepare('UPDATE cards SET version=2, archived=? WHERE id=?').bind(archived, CARD_A.id).run();
	const response = await review({ ...input, cardVersion: archived ? 2 : 1 });
	expect(response.status).toBe(409);
	expect(provider.calls).toHaveLength(0);
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it.each([
	{ name: 'an available provider', response: () => message(correct) },
	{ name: 'a provider outage', response: () => apiError(529, 'overloaded_error') },
])('rejects stale progress before inference with $name', async ({ response }) => {
	expect((await review({ ...input, attemptId: crypto.randomUUID(), answer: 'Słowo' })).status).toBe(200);
	const before = await tables();
	provider.messages = response;
	const rejected = await review();
	expect(rejected.status).toBe(409);
	expect(await rejected.json()).toMatchObject({ code: 'version_conflict' });
	expect(provider.calls).toHaveLength(0);
	expect(await tables()).toEqual(before);
});

it('uses the server key for the other learner’s semantic review of the same attempt', async () => {
	expect((await review()).status).toBe(200);
	cookie = await login(USER_B.id);
	const response = await review();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ progress: { version: 1 } });
	expect(provider.calls).toHaveLength(2);
	expect(provider.calls[1].headers.get('Authorization')).toBe('Bearer test-anthropic-key');
	expect(await provider.calls[1].json()).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'high' } });
	expect((await tables()).state).toMatchObject([{ user_id: USER_A.id }, { user_id: USER_B.id }]);
	expect((await tables()).reviews).toMatchObject([{ user_id: USER_A.id }, { user_id: USER_B.id }]);
});

it('requires an authenticated same-origin POST', async () => {
	expect((await request('/api/reviews', { method: 'POST', body: input })).status).toBe(401);
	expect((await request('/api/reviews', { method: 'POST', cookie, origin: 'https://elsewhere.test', body: input })).status).toBe(403);
	expect((await request('/api/reviews', { cookie })).status).toBe(405);
	expect(provider.calls).toHaveLength(0);
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it('marks grading without the AI key as editable without writing a review', async () => {
	Reflect.deleteProperty(env, 'ANTHROPIC_API_KEY');
	const response = await review();
	expect(response.status).toBe(503);
	expect(response.headers.get('X-Review-Recovery')).toBe('editable');
	expect(await response.json()).toMatchObject({ code: 'ai_unavailable' });
	expect(provider.calls).toHaveLength(0);
	expect(await tables()).toEqual({ state: [], reviews: [] });
});

it('keeps a storage outcome uncertain when the batch commits and then throws', async () => {
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(batch).mockImplementationOnce(async statements => { await batch(statements); throw new Error('Lost database response.'); });
	const response = await review({ ...input, answer: 'Słowo' });
	expect(response.status).toBe(500);
	expect(response.headers.get('X-Review-Recovery')).toBeNull();
	expect((await tables()).reviews).toHaveLength(1);
	expect((await review({ ...input, answer: 'Słowo' })).status).toBe(200);
	expect((await tables()).reviews).toHaveLength(1);
});
