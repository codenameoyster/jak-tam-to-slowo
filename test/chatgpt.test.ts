import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { login, request } from './client';
import { USER_A, USER_B } from './fixtures';
import { CALLBACK, createOpenAI, SCOPE } from './openai';

let provider: Awaited<ReturnType<typeof createOpenAI>>;
beforeEach(async () => { provider = await createOpenAI(); vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch); });

async function start(cookie: string) {
	const response = await request('/api/ai/connection/start', { method: 'POST', cookie });
	expect(response.status).toBe(200);
	return new URL((await response.json<{ url: string }>()).url);
}
function address(url: URL, account = 'a', clientId: string | null = `oaiapp_${account}`) {
	const callback = new URL(CALLBACK);
	callback.search = new URLSearchParams({ code: `${account}:${url.searchParams.get('nonce')}`, state: url.searchParams.get('state')!, ...(clientId === null ? {} : { client_id: clientId }) }).toString();
	return callback;
}
function finish(cookie: string, address: URL) { return request('/api/ai/connection/finish', { method: 'POST', cookie, body: { address: address.href } }); }
async function connect(cookie: string, account = 'a') {
	const response = await finish(cookie, address(await start(cookie), account));
	expect(response.status).toBe(200);
	expect(Object.keys(await response.json()).sort()).toEqual(['accountLabel', 'connected', 'model', 'models']);
}
const record = (id = USER_A.id) => env.DB.prepare('SELECT * FROM ai_connections WHERE user_id = ?').bind(id).first<Record<string, string | number | null>>();
const view = (cookie: string) => request('/api/ai/connection', { cookie }).then(response => response.json());

it('binds fresh state, nonce and PKCE to each real application session', async () => {
	const a = await login(USER_A.id), b = await login(USER_B.id);
	const first = await start(a), second = await start(b);
	const rows = await env.DB.prepare('SELECT * FROM oauth_attempts ORDER BY user_id').all<{ state: string; nonce: string; verifier: string; session_hash: string; expires_at: number }>();
	expect(rows.results).toHaveLength(2);
	const [one, two] = rows.results;
	expect(one.state).not.toBe(two.state);
	expect(one.nonce).not.toBe(two.nonce);
	expect(one.verifier).not.toBe(two.verifier);
	expect(one.session_hash).toBe(createHash('sha256').update(a.split('=')[1]).digest('hex'));
	expect(one.expires_at).toBeGreaterThan(Date.now());
	expect(one.expires_at).toBeLessThanOrEqual(Date.now() + 600_000);
	expect(first.origin + first.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
	expect(Object.fromEntries(first.searchParams)).toMatchObject({ client_id: 'dynamic_agent_client', agent_name_hint: 'Jak tam to słowo?', ext_agent_host_id: env.CHATGPT_HOST_ID, resource: 'https://api.openai.com/v1', redirect_uri: CALLBACK, response_type: 'code', scope: SCOPE, code_challenge_method: 'S256', state: one.state, nonce: one.nonce, code_challenge: createHash('sha256').update(one.verifier).digest('base64url') });
	expect(second.searchParams.get('state')).toBe(two.state);
	expect(first.href).not.toContain(one.verifier);
});

it.each([
	{ name: 'another learner', otherUser: USER_B.id },
	{ name: 'another session of the same learner', otherUser: USER_A.id },
])('rejects a callback submitted by $name without consuming the owner attempt', async ({ otherUser }) => {
	const cookie = await login(USER_A.id), callback = address(await start(cookie));
	expect((await finish(await login(otherUser), callback)).status).toBe(400);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM ai_connections WHERE user_id=?').bind(USER_B.id).first('n')).toBe(0);
	expect((await finish(cookie, callback)).status).toBe(200);
});

it.each([
	{ name: 'wrong state', change: (url: URL) => url.searchParams.set('state', 'wrong') },
	{ name: 'duplicate state', change: (url: URL) => url.searchParams.append('state', 'wrong') },
	{ name: 'missing issued client', change: (url: URL) => url.searchParams.delete('client_id') },
	{ name: 'dynamic client placeholder', change: (url: URL) => url.searchParams.set('client_id', 'dynamic_agent_client') },
	{ name: 'duplicate client', change: (url: URL) => url.searchParams.append('client_id', 'oaiapp_a') },
	{ name: 'missing code', change: (url: URL) => url.searchParams.delete('code') },
	{ name: 'duplicate code', change: (url: URL) => url.searchParams.append('code', 'other') },
	{ name: 'OAuth denial with a code', change: (url: URL) => url.searchParams.set('error', 'access_denied') },
	{ name: 'other callback port', change: (url: URL) => { url.port = '1455'; } },
	{ name: 'localhost callback', change: (url: URL) => { url.hostname = 'localhost'; } },
	{ name: 'other callback path', change: (url: URL) => { url.pathname = '/callback'; } },
	{ name: 'callback fragment', change: (url: URL) => { url.hash = '#unexpected'; } },
])('rejects $name before provider exchange', async ({ change }) => {
	const cookie = await login(USER_A.id), callback = address(await start(cookie));
	change(callback);
	expect((await finish(cookie, callback)).status).toBe(400);
	expect(await record()).toBeNull();
	expect(provider.calls).toHaveLength(0);
});

it('rejects expired state and consumes a callback only once across concurrent requests', async () => {
	const cookie = await login(USER_A.id), old = address(await start(cookie));
	await env.DB.prepare('UPDATE oauth_attempts SET expires_at=?').bind(Date.now() - 1).run();
	expect((await finish(cookie, old)).status).toBe(400);
	const current = address(await start(cookie));
	const responses = await Promise.all([finish(cookie, current), finish(cookie, current)]);
	expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
	expect((await finish(cookie, current)).status).toBe(400);
	expect(provider.calls.filter(call => call.url.endsWith('/oauth/token'))).toHaveLength(1);
});

it.each([
	{ name: 'invalid signature', change: () => { provider.badSignature = true; }, status: 400 },
	{ name: 'invalid issuer', change: () => { provider.claims.iss = 'https://other.example'; }, status: 400 },
	{ name: 'invalid audience', change: () => { provider.claims.aud = 'oaiapp_other'; }, status: 400 },
	{ name: 'invalid authorized party', change: () => { provider.claims.azp = 'oaiapp_other'; }, status: 400 },
	{ name: 'expired ID token', change: () => { provider.claims.exp = 1; }, status: 400 },
	{ name: 'missing ID token expiry', change: () => { provider.claims.exp = undefined; }, status: 400 },
	{ name: 'missing subject', change: () => { provider.claims.sub = undefined; }, status: 400 },
	{ name: 'wrong nonce', change: () => { provider.claims.nonce = 'wrong'; }, status: 400 },
	{ name: 'missing nonce', change: () => { provider.claims.nonce = undefined; }, status: 400 },
	{ name: 'missing plan grant', change: () => { provider.scope = 'openid profile email offline_access'; }, status: 403 },
	{ name: 'failed code exchange', change: () => { provider.tokenStatus = 400; }, status: 400 },
	{ name: 'unavailable catalog', change: () => { provider.modelsStatus = 503; }, status: 503 },
	{ name: 'empty catalog', change: () => { provider.emptyModels = true; }, status: 403 },
])('keeps the valid connection after $name during replacement', async ({ change, status }) => {
	const cookie = await login(USER_A.id);
	await connect(cookie);
	const before = await record();
	const callback = address(await start(cookie));
	change();
	expect((await finish(cookie, callback)).status).toBe(status);
	const after = await record();
	expect(after?.access_token).toBe(before?.access_token);
	expect(after?.refresh_token).toBe(before?.refresh_token);
	expect(after).toEqual(before);
	expect((await finish(cookie, callback)).status).toBe(400);
});

it('isolates identities and visible models and encrypts all retained tokens', async () => {
	const a = await login(USER_A.id), b = await login(USER_B.id);
	await connect(a);
	await connect(b, 'b');
	expect(await view(a)).toEqual({ connected: true, accountLabel: 'a@example.test', model: 'a-first', models: [{ slug: 'a-first', name: 'a first' }, { slug: 'a-second', name: 'a second' }] });
	expect(await view(b)).toEqual({ connected: true, accountLabel: 'b@example.test', model: 'b-first', models: [{ slug: 'b-first', name: 'b first' }, { slug: 'b-second', name: 'b second' }] });
	const row = (await record())!;
	expect(row).toMatchObject({ issuer: 'https://auth.openai.com', subject: 'subject-a', client_id: 'oaiapp_a', host_id: env.CHATGPT_HOST_ID, scopes: SCOPE });
	expect(row.expires_at).toBeGreaterThan(Date.now() + 3_500_000);
	expect(row.refresh_after).toBeGreaterThan(Date.now());
	const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(env.AI_TOKEN_KEY), char => char.charCodeAt(0)), 'AES-GCM', false, ['decrypt']);
	for (const { name, expected } of [
		{ name: 'access_token', expected: 'access-a' },
		{ name: 'refresh_token', expected: 'refresh-a' },
		{ name: 'id_token', expected: '"sub":"subject-a"' },
	]) {
		const encrypted = String(row[name]);
		expect(encrypted).not.toContain(expected);
		const bytes = Uint8Array.from(atob(encrypted), char => char.charCodeAt(0));
		const plain = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(`${USER_A.id}:${name}`) }, key, bytes.subarray(12)));
		expect(name === 'id_token' ? atob(plain.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')) : plain).toContain(expected);
	}
	const tokenCall = provider.calls.find(call => call.url.endsWith('/oauth/token'))!;
	expect(Object.fromEntries(await tokenCall.formData())).toMatchObject({ grant_type: 'authorization_code', client_id: 'oaiapp_a', resource: 'https://api.openai.com/v1', redirect_uri: CALLBACK });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM oauth_attempts').first('n')).toBe(0);
});

it.each([
	{ name: 'a different returning client', client: 'oaiapp_other', subject: 'subject-a' },
	{ name: 'a different returning subject', client: 'oaiapp_a', subject: 'subject-other' },
])('rejects $name and retains the verified registration', async ({ client, subject }) => {
	const cookie = await login(USER_A.id);
	await connect(cookie);
	const before = await record();
	const url = await start(cookie);
	expect(url.searchParams.get('client_id')).toBe('oaiapp_a');
	expect(url.searchParams.has('agent_name_hint')).toBe(false);
	expect(url.searchParams.has('id_token_hint')).toBe(false);
	provider.claims.sub = subject;
	expect((await finish(cookie, address(url, 'a', client))).status).toBe(400);
	expect(await record()).toEqual(before);
});

it('accepts an omitted returning client and preserves an available model selection', async () => {
	const cookie = await login(USER_A.id);
	await connect(cookie);
	expect((await request('/api/ai/connection', { method: 'PATCH', cookie, body: { model: 'a-second' } })).status).toBe(200);
	const url = await start(cookie);
	const verifier = await env.DB.prepare('SELECT verifier FROM oauth_attempts WHERE state=?').bind(url.searchParams.get('state')).first('verifier');
	expect((await finish(cookie, address(url, 'a', null))).status).toBe(200);
	const tokenCall = provider.calls.filter(call => call.url.endsWith('/oauth/token')).at(-1)!;
	expect((await tokenCall.formData()).get('code_verifier')).toBe(verifier);
	expect(await view(cookie)).toMatchObject({ model: 'a-second' });
	expect((await request('/api/ai/connection', { method: 'PATCH', cookie, body: { model: 'b-first' } })).status).toBe(400);
	expect((await request('/api/ai/connection', { method: 'PATCH', cookie, body: { model: 'a-first', userId: USER_B.id } })).status).toBe(400);
	expect(await view(cookie)).toMatchObject({ model: 'a-second' });
});

it.each([
	{ name: 'confirmed revocation', status: 200, confirmed: true },
	{ name: 'unconfirmed revocation', status: 503, confirmed: false },
])('clears only the signed-in learner credentials after $name', async ({ status, confirmed }) => {
	const a = await login(USER_A.id), b = await login(USER_B.id);
	await connect(a); await connect(b, 'b');
	const other = await record(USER_B.id), pending = address(await start(a));
	provider.revokeStatus = status;
	const response = await request('/api/ai/connection', { method: 'DELETE', cookie: a });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ connected: false, accountLabel: 'a@example.test', model: null, models: [], revocationConfirmed: confirmed });
	expect(await record()).toMatchObject({ client_id: 'oaiapp_a', subject: 'subject-a', host_id: env.CHATGPT_HOST_ID, access_token: null, refresh_token: null, id_token: null });
	expect(await record(USER_B.id)).toEqual(other);
	expect((await finish(a, pending)).status).toBe(400);
	const revoke = provider.calls.find(call => call.url.endsWith('/oauth/revoke'))!;
	expect(Object.fromEntries(await revoke.formData())).toEqual({ token: 'refresh-a', token_type_hint: 'refresh_token', client_id: 'oaiapp_a' });
	expect((await start(a)).searchParams.get('client_id')).toBe('oaiapp_a');
});

it.each([
	{ name: 'confirmed replacement revocation', status: 200, confirmed: true, tokens: ['refresh-a-replacement'] },
	{ name: 'unconfirmed replacement revocation', status: 503, confirmed: false, tokens: ['refresh-a-replacement', 'refresh-a-replacement'] },
])('revokes the credentials cleared by disconnect after $name', async ({ status, confirmed, tokens }) => {
	const a = await login(USER_A.id), b = await login(USER_B.id);
	await connect(a); await connect(b, 'b');
	const other = await record(USER_B.id), replacement = address(await start(a));
	vi.mocked(fetch).mockImplementation(async (input, init) => {
		const response = await provider.fetch(input, init);
		if (String(input) === 'https://auth.openai.com/api/accounts/oauth/token') {
			return Response.json({ ...await response.json<Record<string, unknown>>(), refresh_token: 'refresh-a-replacement' });
		}
		if (String(input) === 'https://auth.openai.com/api/accounts/oauth/revoke') {
			const form = await new Request(input, init).formData();
			return new Response(null, { status: form.get('token') === 'refresh-a-replacement' ? status : 200 });
		}
		return response;
	});
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => {
		entered.resolve();
		await release.promise;
		return batch(statements);
	});
	const pending = request('/api/ai/connection', { method: 'DELETE', cookie: a });
	await entered.promise;
	try { expect((await finish(a, replacement)).status).toBe(200); }
	finally { release.resolve(); }
	const response = await pending;
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ connected: false, accountLabel: 'a@example.test', model: null, models: [], revocationConfirmed: confirmed });
	expect(await record()).toMatchObject({ access_token: null, refresh_token: null, id_token: null });
	expect(await record(USER_B.id)).toEqual(other);
	const revocations = await Promise.all(provider.calls.filter(call => call.url.endsWith('/oauth/revoke')).map(async call => (await call.formData()).get('token')));
	expect(revocations).toEqual(tokens);
});

it('requires an application session and same-origin mutations', async () => {
	expect((await request('/api/ai/connection')).status).toBe(401);
	const cookie = await login(USER_A.id);
	expect((await request('/api/ai/connection/start', { method: 'POST', cookie, origin: 'https://other.example' })).status).toBe(403);
	expect((await request('/api/ai/connection', { method: 'PATCH', cookie, body: { model: 'a-first' } })).status).toBe(409);
});

it.each([
	{ name: 'disconnect', path: '/api/ai/connection' },
	{ name: 'application logout', path: '/api/session' },
])('cancels an in-flight first connection after $name', async ({ path }) => {
	const cookie = await login(USER_A.id), callback = address(await start(cookie));
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	vi.mocked(fetch).mockImplementation(async (input, init) => {
		if (String(input) === 'https://api.openai.com/v1/models') { entered.resolve(); await release.promise; }
		return provider.fetch(input, init);
	});
	const pending = finish(cookie, callback);
	await entered.promise;
	try { expect((await request(path, { method: 'DELETE', cookie })).ok).toBe(true); }
	finally { release.resolve(); }
	expect((await pending).status).toBe(400);
	expect(await record()).toBeNull();
});

it('keeps the first verified registration when two new sign-ins finish', async () => {
	const cookie = await login(USER_A.id);
	const first = address(await start(cookie)), second = address(await start(cookie), 'b');
	expect((await finish(cookie, first)).status).toBe(200);
	const before = await record();
	expect((await finish(cookie, second)).status).toBe(400);
	expect(await record()).toEqual(before);
});
