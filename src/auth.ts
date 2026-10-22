import type { Env } from './index';
import type { User } from '../shared/types';
import { HttpError, localHttp, methods, object, readJson, text } from './http';

interface Account { id: string; username: string; displayName: string; passwordHash: string }

function accounts(env: Env): Account[] {
	try {
		const value: unknown = JSON.parse(env.ACCOUNTS);
		if (!Array.isArray(value) || !value.length) throw new Error();
		const parsed = value.map(item => {
			const record = object(item, ['id', 'username', 'displayName', 'passwordHash']);
			const account = { id: text(record.id, 36), username: text(record.username, 40), displayName: text(record.displayName, 80), passwordHash: text(record.passwordHash, 64) };
			if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(account.id) || !/^[A-Za-z0-9._-]{3,40}$/.test(account.username) || !/^[a-f0-9]{64}$/.test(account.passwordHash)) throw new Error();
			return account;
		});
		if (new Set(parsed.map(account => account.id)).size !== parsed.length || new Set(parsed.map(account => account.username)).size !== parsed.length) throw new Error();
		return parsed;
	} catch { throw new HttpError(503, 'setup_required', 'Аккаунты не настроены. Обратитесь к владельцу приложения.'); }
}

function hex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
async function hash(value: string): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
function fingerprint(account: Account): Promise<string> { return hash(JSON.stringify([account.id, account.username, account.passwordHash])); }
function cookieName(request: Request, env: Env): string { return localHttp(request, env) ? 'polish-cards-dev' : '__Host-polish-cards'; }
function token(request: Request, env: Env): string | null {
	const prefix = `${cookieName(request, env)}=`;
	const value = request.headers.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
	return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function cookie(request: Request, env: Env, value: string, seconds: number): string {
	return `${cookieName(request, env)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${localHttp(request, env) ? '' : '; Secure'}`;
}

export async function requireSession(request: Request, env: Env): Promise<{ user: User; sessionHash: string }> {
	const value = token(request, env);
	if (value) {
		const sessionHash = await hash(value);
		const row = await env.DB.prepare(`SELECT u.id, u.username, u.display_name AS displayName, u.direction, s.credential_fingerprint
			FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
			.bind(sessionHash, Date.now()).first<User & { credential_fingerprint: string }>();
		const account = row && accounts(env).find(account => account.id === row.id);
		if (row && account && row.credential_fingerprint === await fingerprint(account)) {
			const displayedAccount = request.headers.get('X-Account-ID');
			if (displayedAccount !== null && displayedAccount !== row.id) throw new HttpError(409, 'account_mismatch', 'Аккаунт изменился в другой вкладке. Войдите снова.');
			return { user: { id: row.id, username: row.username, displayName: row.displayName, direction: row.direction }, sessionHash };
		}
	}
	throw new HttpError(401, 'unauthorized', 'Войдите, чтобы продолжить.');
}

export async function requireUser(request: Request, env: Env): Promise<User> { return (await requireSession(request, env)).user; }

export async function handleSession(request: Request, env: Env): Promise<Response> {
	methods(request, ['GET', 'POST', 'DELETE']);
	if (request.method === 'POST') {
		if (!(await env.LOGIN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success) throw new HttpError(429, 'rate_limited', 'Слишком много попыток входа. Попробуйте снова через минуту.');
		const data = object(await readJson(request), ['username', 'password']);
		const username = text(data.username, 40);
		const password = text(data.password, 256);
		const account = accounts(env).find(account => account.username === username);
		const digest = await hash(password);
		const matches = crypto.subtle.timingSafeEqual(new TextEncoder().encode(digest), new TextEncoder().encode(account?.passwordHash ?? '0'.repeat(64)));
		if (!account || !matches) throw new HttpError(401, 'invalid_credentials', 'Неверное имя пользователя или пароль.');
		const value = hex(crypto.getRandomValues(new Uint8Array(32)));
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
			env.DB.prepare(`INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name`)
				.bind(account.id, account.username, account.displayName, now),
			env.DB.prepare('INSERT INTO sessions (token_hash, user_id, credential_fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
				.bind(await hash(value), account.id, await fingerprint(account), now, now + 604_800_000),
		]);
		const user = await env.DB.prepare('SELECT id, username, display_name AS displayName, direction FROM users WHERE id = ?').bind(account.id).first<User>();
		return Response.json(user, { headers: { 'Set-Cookie': cookie(request, env, value, 604_800) } });
	}
	if (request.method === 'DELETE') {
		try {
			const { sessionHash } = await requireSession(request, env);
			await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(sessionHash).run();
		} catch (error) {
			if (!(error instanceof HttpError) || error.code !== 'unauthorized') throw error;
		}
		return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie(request, env, '', 0) } });
	}
	return Response.json(await requireUser(request, env));
}

export async function handleMe(request: Request, env: Env, user: User): Promise<Response> {
	methods(request, ['PATCH']);
	const data = object(await readJson(request), ['direction']);
	if (data.direction !== 'ru-pl' && data.direction !== 'pl-ru') throw new HttpError(400, 'invalid_input', 'Выберите направление перевода.');
	await env.DB.prepare('UPDATE users SET direction = ? WHERE id = ?').bind(data.direction, user.id).run();
	return Response.json({ ...user, direction: data.direction });
}
