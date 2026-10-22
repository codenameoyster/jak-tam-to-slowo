import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import worker from '../src/index';
import { login, request } from './client';
import { USER_A, USER_B, testAccountSecret } from './fixtures';

it.each([
	{ name: 'wrong password', method: 'POST', body: { username: USER_A.username, password: 'wrong-password' }, status: 401 },
	{ name: 'unknown username', method: 'POST', body: { username: 'unknown', password: USER_A.password }, status: 401 },
	{ name: 'missing cookie', method: 'GET', body: undefined, status: 401 },
	{ name: 'foreign-origin login', method: 'POST', body: { username: USER_A.username, password: USER_A.password }, origin: 'https://other.example', status: 403 },
	{ name: 'null-origin login', method: 'POST', body: { username: USER_A.username, password: USER_A.password }, origin: 'null', status: 403 },
])('rejects $name', async ({ method, body, origin, status }) => {
	const response = await request('/api/session', { method, body, origin });
	expect(response.status).toBe(status);
	expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(0);
});

it('stores a hashed seven-day session and retains the stable user ID', async () => {
	const before = Date.now();
	const response = await request('/api/session', { method: 'POST', body: { username: USER_A.username, password: USER_A.password } });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ id: USER_A.id, username: USER_A.username, displayName: USER_A.displayName, direction: 'ru-pl' });
	const cookie = response.headers.get('Set-Cookie')!;
	expect(cookie).toMatch(/^__Host-polish-cards=[a-f0-9]{64};/);
	expect(cookie).toContain('HttpOnly');
	expect(cookie).toContain('Secure');
	expect(cookie).toContain('SameSite=Lax');
	expect(cookie).toContain('Path=/');
	expect(cookie).toContain('Max-Age=604800');
	expect(cookie).not.toMatch(/Domain=/i);
	const token = cookie.split(';')[0].split('=')[1];
	const row = await env.DB.prepare('SELECT * FROM sessions').first<{ token_hash: string; user_id: string; created_at: number; expires_at: number }>();
	expect(row?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
	expect(row?.user_id).toBe(USER_A.id);
	expect(row!.expires_at - row!.created_at).toBe(604_800_000);
	expect(row!.created_at).toBeGreaterThanOrEqual(before);
	expect(row!.created_at).toBeLessThanOrEqual(Date.now());
	const current = await request('/api/session', { cookie: cookie.split(';')[0] });
	expect(current.status).toBe(200);
	expect(await current.json()).toMatchObject({ id: USER_A.id });
	expect(current.headers.get('Cache-Control')).toBe('private, no-store');
});

it.each([
	{ name: 'expired session', change: async () => { await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(Date.now() - 1).run(); } },
	{ name: 'rotated password', change: async () => { env.ACCOUNTS = testAccountSecret.replace(createHash('sha256').update(USER_A.password).digest('hex'), 'a'.repeat(64)); } },
	{ name: 'changed username', change: async () => { env.ACCOUNTS = testAccountSecret.replace(USER_A.username, 'anna-new'); } },
	{ name: 'removed account', change: async () => { env.ACCOUNTS = JSON.stringify(JSON.parse(testAccountSecret).filter((user: { id: string }) => user.id !== USER_A.id)); } },
])('rejects a valid cookie after $name', async ({ change }) => {
	const cookie = await login(USER_A.id);
	await change();
	expect((await request('/api/session', { cookie })).status).toBe(401);
	expect((await request('/api/me', { method: 'PATCH', cookie, body: { direction: 'pl-ru' } })).status).toBe(401);
});

it('updates account metadata on login without losing direction or changing identity', async () => {
	const cookie = await login(USER_A.id);
	const updated = await request('/api/me', { method: 'PATCH', cookie, body: { direction: 'pl-ru' } });
	expect(updated.status).toBe(200);
	expect(await updated.json()).toMatchObject({ id: USER_A.id, direction: 'pl-ru' });
	env.ACCOUNTS = testAccountSecret.replace(USER_A.username, 'anna-new').replace(USER_A.displayName, 'Аня');
	const response = await request('/api/session', { method: 'POST', body: { username: 'anna-new', password: USER_A.password } });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ id: USER_A.id, username: 'anna-new', displayName: 'Аня', direction: 'pl-ru' });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(1);
	const other = await request('/api/session', { cookie: await login(USER_B.id) });
	expect(await other.json()).toMatchObject({ id: USER_B.id, direction: 'ru-pl' });
});

it.each([
	{ name: 'foreign-origin direction change', path: '/api/me', method: 'PATCH', origin: 'https://other.example', body: { direction: 'pl-ru' }, status: 403 },
	{ name: 'foreign-origin logout', path: '/api/session', method: 'DELETE', origin: 'https://other.example', body: undefined, status: 403 },
	{ name: 'invalid direction', path: '/api/me', method: 'PATCH', body: { direction: 'en-pl' }, status: 400 },
	{ name: 'user ID in body', path: '/api/me', method: 'PATCH', body: { direction: 'pl-ru', userId: USER_B.id }, status: 400 },
	{ name: 'missing direction', path: '/api/me', method: 'PATCH', body: {}, status: 400 },
])('rejects $name without changing the account', async ({ path, method, origin, body, status }) => {
	const cookie = await login(USER_A.id);
	expect((await request(path, { method, origin, body, cookie })).status).toBe(status);
	const current = await request('/api/session', { cookie });
	expect(current.status).toBe(200);
	expect(await current.json()).toMatchObject({ direction: 'ru-pl' });
});

it('revokes only the current session at logout', async () => {
	const cookie = await login(USER_A.id);
	const other = await login(USER_B.id);
	const response = await request('/api/session', { method: 'DELETE', cookie });
	expect(response.status).toBe(204);
	expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
	expect((await request('/api/session', { cookie })).status).toBe(401);
	expect((await request('/api/session', { cookie: other })).status).toBe(200);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(1);
});

it.each([
	{ name: 'expired session', cookiePresent: true },
	{ name: 'missing cookie', cookiePresent: false },
])('confirms deliberate logout with $name', async ({ cookiePresent }) => {
	const cookie = await login(USER_A.id);
	await env.DB.prepare('UPDATE sessions SET expires_at=0').run();
	const response = await request('/api/session', { method: 'DELETE', cookie: cookiePresent ? cookie : undefined, accountId: USER_A.id });
	expect(response.status).toBe(204);
	expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
});

it('returns 429 without creating a session when the login limit is reached', async () => {
	vi.spyOn(env.LOGIN_LIMITER, 'limit').mockResolvedValue({ success: false });
	const response = await request('/api/session', { method: 'POST', body: { username: USER_A.username, password: USER_A.password } });
	expect(response.status).toBe(429);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(0);
});

it('uses the cookie as authority and permits bootstrap and explicit login', async () => {
	const cookie = await login(USER_B.id);
	expect(await (await request('/api/session', { cookie })).json()).toMatchObject({ id: USER_B.id });
	const mismatch = await request('/api/me', { cookie, accountId: USER_A.id, method: 'PATCH', body: { direction: 'pl-ru' } });
	expect(mismatch.status).toBe(409);
	const matching = await request('/api/me', { cookie, accountId: USER_B.id, method: 'PATCH', body: { direction: 'pl-ru' } });
	expect(await matching.json()).toMatchObject({ id: USER_B.id, direction: 'pl-ru' });
	const explicit = await request('/api/session', { cookie, accountId: USER_A.id, method: 'POST', body: { username: USER_A.username, password: USER_A.password } });
	expect(explicit.status).toBe(200);
	expect(await explicit.json()).toMatchObject({ id: USER_A.id });
});

it.each([
	{ name: 'loopback HTTP with explicit opt-in', origin: 'http://127.0.0.1', local: '1', status: 200, cookieName: 'polish-cards-dev=', secure: false },
	{ name: 'localhost HTTP with explicit opt-in', origin: 'http://localhost', local: '1', status: 200, cookieName: 'polish-cards-dev=', secure: false },
	{ name: 'loopback HTTP without opt-in', origin: 'http://127.0.0.1', local: undefined, status: 403, cookieName: '', secure: false },
	{ name: 'non-loopback HTTP with opt-in', origin: 'http://learn.rustatian.me', local: '1', status: 403, cookieName: '', secure: false },
	{ name: 'HTTPS with local opt-in', origin: 'https://learn.rustatian.me', local: '1', status: 200, cookieName: '__Host-polish-cards=', secure: true },
])('uses the correct transport policy for $name', async ({ origin, local, status, cookieName, secure }) => {
	env.LOCAL_HTTP = local;
	const response = await worker.fetch(new Request(`${origin}/api/session`, {
		method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: USER_A.username, password: USER_A.password }),
	}), env);
	expect(response.status).toBe(status);
	if (status === 200) {
		expect(response.headers.get('Set-Cookie')!.startsWith(cookieName)).toBe(true);
		expect(response.headers.get('Set-Cookie')!.includes('; Secure')).toBe(secure);
	} else {
		expect(response.headers.get('Set-Cookie')).toBeNull();
	}
});
