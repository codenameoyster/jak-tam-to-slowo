import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { login, request } from './client';
import { CARD_A, USER_A, USER_B, WORD_DRAFT } from './fixtures';
import { seedLegacyConnection } from './legacy-connection';
import { CALLBACK, createOpenAI, responseStream } from './openai';

let provider: Awaited<ReturnType<typeof createOpenAI>>, owner: string, learner: string;
async function start() {
	const response = await request('/api/ai/connection/start', { method: 'POST', cookie: owner });
	expect(response.status).toBe(200);
	const url = new URL((await response.json<{ url: string }>()).url);
	return `${CALLBACK}?${new URLSearchParams({ code: `a:${url.searchParams.get('nonce')}`, state: url.searchParams.get('state')!, client_id: 'oaiapp_a' })}`;
}
beforeEach(async () => {
	provider = await createOpenAI();
	vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch);
	owner = await login(USER_A.id); learner = await login(USER_B.id);
	expect((await request('/api/ai/connection/finish', { method: 'POST', cookie: owner, body: { address: await start() } })).status).toBe(200);
	expect((await request('/api/ai/connection', { method: 'PATCH', cookie: owner, body: { model: 'a-second' } })).status).toBe(200);
	provider.responses = async request => {
		const body = await request.json<{ input: { content: string }[] }>();
		return responseStream('answer' in JSON.parse(body.input[0].content)
			? { grade: 'almost', correction: 'Słowo', explanationRu: 'Используйте словарную форму.' }
			: { kind: 'draft', card: WORD_DRAFT });
	};
});

it('uses only the owner connection for another learner’s draft and semantic review, with requester-owned writes', async () => {
	const draft = await request('/api/cards/draft', { method: 'POST', cookie: learner, body: { text: 'słowo', language: 'pl' } });
	expect(draft.status).toBe(200);
	expect(await draft.json()).toEqual({ kind: 'draft', card: WORD_DRAFT });
	expect((await request('/api/cards', { method: 'POST', cookie: learner, body: { ...WORD_DRAFT, id: CARD_A.id } })).status).toBe(201);
	const input = { attemptId: crypto.randomUUID(), cardId: CARD_A.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'słowa' };
	const reviewed = await request('/api/reviews', { method: 'POST', cookie: learner, body: input });
	expect(reviewed.status).toBe(200);
	expect(await reviewed.json()).toMatchObject({ grade: 'almost', source: 'ai', progress: { version: 1 } });
	const calls = provider.calls.filter(call => call.url.endsWith('/responses'));
	expect(calls).toHaveLength(2);
	for (const call of calls) {
		expect(call.headers.get('Authorization')).toBe('Bearer access-a');
		expect(await call.json()).toMatchObject({ model: 'a-second' });
	}
	expect(await env.DB.prepare('SELECT created_by FROM cards WHERE id=?').bind(CARD_A.id).first('created_by')).toBe(USER_B.id);
	expect((await env.DB.prepare('SELECT user_id, attempt_id, input_json FROM reviews').all<{ user_id: string; attempt_id: string; input_json: string }>()).results.map(row => ({ userId: row.user_id, input: { ...JSON.parse(row.input_json), attemptId: row.attempt_id } }))).toEqual([{ userId: USER_B.id, input }]);
	expect((await env.DB.prepare('SELECT user_id, version FROM review_state').all()).results).toEqual([{ user_id: USER_B.id, version: 1 }]);
	expect((await env.DB.prepare('SELECT user_id FROM ai_connections').all()).results).toEqual([{ user_id: USER_A.id }]);
});

it.each([
	{ name: 'start', path: '/api/ai/connection/start', method: 'POST' },
	{ name: 'finish with the copied owner callback', path: '/api/ai/connection/finish', method: 'POST' },
	{ name: 'model change', path: '/api/ai/connection', method: 'PATCH' },
	{ name: 'disconnect', path: '/api/ai/connection', method: 'DELETE' },
])('rejects non-owner $name without changing the connection or pending callback', async ({ path, method }) => {
	await seedLegacyConnection();
	const address = await start();
	const before = await env.DB.prepare('SELECT * FROM ai_connections').all();
	const pending = await env.DB.prepare('SELECT * FROM oauth_attempts').all();
	const count = provider.calls.length;
	const response = await request(path, { method, cookie: learner, accountId: USER_B.id, body: path.endsWith('/finish') ? { address } : method === 'PATCH' ? { model: 'a-first' } : undefined });
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ error: expect.any(String), code: expect.any(String) });
	expect((await env.DB.prepare('SELECT * FROM ai_connections').all()).results).toEqual(before.results);
	expect((await env.DB.prepare('SELECT * FROM oauth_attempts').all()).results).toEqual(pending.results);
	expect(provider.calls).toHaveLength(count);
	expect((await request('/api/ai/connection/finish', { method: 'POST', cookie: owner, body: { address } })).status).toBe(200);
});

it('rejects a forged owner header on a copied callback before consuming the owner attempt', async () => {
	const address = await start();
	const before = await env.DB.prepare('SELECT * FROM ai_connections').all();
	const pending = await env.DB.prepare('SELECT * FROM oauth_attempts').all();
	const count = provider.calls.length;
	const response = await request('/api/ai/connection/finish', { method: 'POST', cookie: learner, accountId: USER_A.id, body: { address } });
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'account_mismatch' });
	expect((await env.DB.prepare('SELECT * FROM ai_connections').all()).results).toEqual(before.results);
	expect((await env.DB.prepare('SELECT * FROM oauth_attempts').all()).results).toEqual(pending.results);
	expect(provider.calls).toHaveLength(count);
	expect((await request('/api/ai/connection/finish', { method: 'POST', cookie: owner, body: { address } })).status).toBe(200);
});

it.each([
	{ name: 'missing owner row', state: 'missing' },
	{ name: 'disconnected owner', state: 'disconnected' },
	{ name: 'revoked owner refresh token', state: 'revoked' },
])('does not fall back to a legacy learner credential after $name', async ({ state }) => {
	await seedLegacyConnection();
	const before = await env.DB.prepare('SELECT * FROM ai_connections WHERE user_id=?').bind(USER_B.id).first();
	if (state === 'missing') await env.DB.prepare('DELETE FROM ai_connections WHERE user_id=?').bind(USER_A.id).run();
	else if (state === 'disconnected') expect((await request('/api/ai/connection', { method: 'DELETE', cookie: owner })).status).toBe(200);
	else {
		await env.DB.prepare('UPDATE ai_connections SET expires_at=0, refresh_after=NULL WHERE user_id=?').bind(USER_A.id).run();
		provider.refreshStatus = 400; provider.refreshBody = { error: 'invalid_grant' };
	}
	const response = await request('/api/cards/draft', { method: 'POST', cookie: learner, body: { text: 'słowo', language: 'pl' } });
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'ai_disconnected' });
	expect(provider.calls.filter(call => call.url.endsWith('/responses'))).toHaveLength(0);
	expect(provider.refreshTokens).toEqual(state === 'revoked' ? ['refresh-a'] : []);
	expect(await env.DB.prepare('SELECT * FROM ai_connections WHERE user_id=?').bind(USER_B.id).first()).toEqual(before);
});
