import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { ConnectionView, User } from '../shared/types';
import type { Env } from './index';
import { requireSession } from './auth';
import { HttpError, methods, object, readJson, text } from './http';

// Registration and token checks: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const ISSUER = 'https://auth.openai.com';
const API = 'https://api.openai.com/v1';
const CALLBACK = 'http://127.0.0.1:47319/auth/callback';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const failed = () => new HttpError(400, 'sign_in_failed', 'Вход в ChatGPT не удался. Начните заново.');
const unavailable = () => new HttpError(503, 'ai_unavailable', 'ChatGPT сейчас недоступен. Попробуйте снова.');
const notEligible = () => new HttpError(403, 'ai_not_eligible', 'Аккаунт не предоставил доступ к моделям по подписке ChatGPT.');
const disconnected = () => new HttpError(409, 'ai_disconnected', 'Подключите ChatGPT в настройках.');

interface Connection {
	user_id: string; client_id: string; host_id: string; issuer: string; subject: string; account_label: string;
	access_token: string | null; refresh_token: string | null; id_token: string | null; scopes: string | null;
	expires_at: number | null; refresh_after: number | null; model: string | null; models: string; version: number;
}
interface Attempt {
	state: string; user_id: string; session_hash: string; nonce: string; verifier: string; redirect_uri: string;
	client_id: string | null; subject: string | null; connection_version: number;
}
const readConnection = (env: Env, userId: string) => env.DB.prepare('SELECT * FROM ai_connections WHERE user_id=?').bind(userId).first<Connection>();
const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const base64url = (value: Uint8Array) => base64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const encode = (value: string) => new TextEncoder().encode(value);

async function key(env: Env): Promise<CryptoKey> {
	try {
		const raw = bytes(env.AI_TOKEN_KEY);
		if (raw.length === 32) return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
	} catch { /* Invalid key format. */ }
	throw new HttpError(503, 'setup_required', 'Подключение ChatGPT не настроено. Обратитесь к владельцу приложения.');
}
async function seal(secret: CryptoKey, value: string, userId: string, field: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encode(`${userId}:${field}`) }, secret, encode(value));
	return base64(new Uint8Array([...iv, ...new Uint8Array(encrypted)]));
}
async function unseal(secret: CryptoKey, value: string, userId: string, field: string): Promise<string> {
	const raw = bytes(value);
	return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: encode(`${userId}:${field}`) }, secret, raw.subarray(12)));
}
function view(row: Connection | null): ConnectionView {
	const connected = Boolean(row?.refresh_token);
	return { connected, accountLabel: row?.account_label ?? null, model: connected ? row!.model : null, models: connected ? JSON.parse(row!.models) : [] };
}
async function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
	try { return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'manual' }); }
	catch { throw unavailable(); }
}
async function json(response: Response): Promise<Record<string, unknown>> {
	const value: unknown = await response.json().catch(() => null);
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function start(request: Request, env: Env, user: User): Promise<Response> {
	await key(env);
	if (!env.CHATGPT_HOST_ID?.trim()) throw new HttpError(503, 'setup_required', 'Не настроен идентификатор подключения ChatGPT.');
	const { sessionHash } = await requireSession(request, env);
	const row = await readConnection(env, user.id);
	const state = random(), nonce = random(), verifier = random(), now = Date.now();
	await env.DB.batch([
		env.DB.prepare('DELETE FROM oauth_attempts WHERE expires_at<=?').bind(now),
		env.DB.prepare(`INSERT INTO oauth_attempts (state,user_id,session_hash,nonce,verifier,redirect_uri,client_id,subject,connection_version,expires_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(state, user.id, sessionHash, nonce, verifier, CALLBACK, row?.client_id ?? null, row?.subject ?? null, row?.version ?? 0, now + 600_000),
	]);
	const params = new URLSearchParams({
		client_id: row?.client_id ?? 'dynamic_agent_client', ...(row ? {} : { agent_name_hint: 'Jak tam to słowo?' }),
		ext_agent_host_id: row?.host_id ?? env.CHATGPT_HOST_ID, response_type: 'code', redirect_uri: CALLBACK, scope: SCOPE, resource: API,
		state, nonce, code_challenge_method: 'S256', code_challenge: base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(verifier)))),
	});
	return Response.json({ url: `${ISSUER}/api/accounts/authorize?${params}` });
}

async function finish(request: Request, env: Env, user: User): Promise<Response> {
	const data = object(await readJson(request), ['address']);
	const callback = URL.parse(text(data.address, 4000));
	if (!callback || callback.origin + callback.pathname !== CALLBACK || callback.hash || callback.username || callback.password) {
		throw new HttpError(400, 'invalid_address', `Вставьте полный адрес, который начинается с ${CALLBACK}.`);
	}
	const params = callback.searchParams, states = params.getAll('state');
	if (states.length !== 1) throw failed();
	const secret = await key(env), { sessionHash } = await requireSession(request, env);
	const attempt = await env.DB.prepare(`UPDATE oauth_attempts SET used_at=? WHERE state=? AND user_id=? AND session_hash=? AND expires_at>? AND used_at IS NULL RETURNING *`)
		.bind(Date.now(), states[0], user.id, sessionHash, Date.now()).first<Attempt>();
	if (!attempt) throw failed();
	try {
		if (params.has('error')) throw new HttpError(400, 'not_approved', 'Доступ к ChatGPT не подтверждён. Начните заново.');
		const ids = params.getAll('client_id'), codes = params.getAll('code');
		if (ids.length > 1 || (attempt.client_id ? ids.length === 1 && ids[0] !== attempt.client_id : ids.length !== 1 || !/^[A-Za-z0-9_-]{1,200}$/.test(ids[0]) || ids[0] === 'dynamic_agent_client')) throw failed();
		if (codes.length !== 1 || !codes[0]) throw failed();
		const clientId = attempt.client_id ?? ids[0];
		const response = await providerFetch(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: codes[0], code_verifier: attempt.verifier, redirect_uri: attempt.redirect_uri, resource: API }) });
		if (response.status >= 500 || response.status === 429) throw unavailable();
		const body = await json(response);
		if (response.status !== 200 || typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token || typeof body.id_token !== 'string' || !body.id_token || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') throw failed();
		let identity;
		try {
			const { payload } = await jwtVerify(body.id_token, createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`)), { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'nonce'] });
			if (!payload.sub || payload.nonce !== attempt.nonce || (payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) || (attempt.subject && payload.sub !== attempt.subject)) throw failed();
			identity = payload;
		} catch { throw failed(); }
		if (typeof body.scope !== 'string' || !body.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) throw notEligible();
		const catalog = await providerFetch(`${API}/models`, { headers: { Authorization: `Bearer ${body.access_token}` } });
		if (catalog.status >= 500 || catalog.status === 429) throw unavailable();
		const listing = await json(catalog);
		const models: ConnectionView['models'] = [];
		if (catalog.ok && Array.isArray(listing.models)) for (const entry of listing.models) {
			if (entry && entry.visibility === 'list' && typeof entry.slug === 'string' && entry.slug && typeof entry.display_name === 'string' && entry.display_name) models.push({ slug: entry.slug, name: entry.display_name });
		}
		if (!models.length) throw notEligible();
		const row = await readConnection(env, user.id), now = Date.now();
		const refreshAfter = typeof body.earliest_refresh_at === 'number' ? body.earliest_refresh_at * 1000 : typeof body.earliest_refresh_at === 'string' ? Date.parse(body.earliest_refresh_at) : NaN;
		const saved = await env.DB.prepare(`INSERT INTO ai_connections (user_id,client_id,host_id,issuer,subject,account_label,access_token,refresh_token,id_token,scopes,expires_at,refresh_after,model,models,version,updated_at)
			SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,? WHERE EXISTS (SELECT 1 FROM oauth_attempts a JOIN sessions s ON s.token_hash=a.session_hash WHERE a.state=? AND a.expires_at>? AND s.expires_at>?)
			ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,id_token=excluded.id_token,scopes=excluded.scopes,expires_at=excluded.expires_at,refresh_after=excluded.refresh_after,account_label=excluded.account_label,model=excluded.model,models=excluded.models,version=ai_connections.version+1,updated_at=excluded.updated_at
			WHERE ai_connections.version=? AND ai_connections.client_id=excluded.client_id AND ai_connections.subject=excluded.subject`)
			.bind(user.id, clientId, row?.host_id ?? env.CHATGPT_HOST_ID, ISSUER, identity.sub!, typeof identity.email === 'string' && identity.email ? identity.email : identity.sub!,
				await seal(secret, body.access_token, user.id, 'access_token'), await seal(secret, body.refresh_token, user.id, 'refresh_token'), await seal(secret, body.id_token, user.id, 'id_token'),
				body.scope, now + body.expires_in * 1000, Number.isFinite(refreshAfter) ? refreshAfter : null, models.some(model => model.slug === row?.model) ? row!.model : models[0].slug, JSON.stringify(models), now, attempt.state, now, now, attempt.connection_version).run();
		if (!saved.meta.changes) throw failed();
		return Response.json(view(await readConnection(env, user.id)));
	} finally { await env.DB.prepare('DELETE FROM oauth_attempts WHERE state=?').bind(attempt.state).run(); }
}

async function disconnect(env: Env, user: User): Promise<Response> {
	const [selected] = await env.DB.batch<Connection>([
		env.DB.prepare('SELECT * FROM ai_connections WHERE user_id=?').bind(user.id),
		env.DB.prepare('DELETE FROM oauth_attempts WHERE user_id=?').bind(user.id),
		env.DB.prepare(`UPDATE ai_connections SET access_token=NULL,refresh_token=NULL,id_token=NULL,scopes=NULL,expires_at=NULL,refresh_after=NULL,model=NULL,models='[]',version=version+1,updated_at=? WHERE user_id=?`).bind(Date.now(), user.id),
	]);
	const row = selected.results[0];
	let revocationConfirmed = !row?.refresh_token;
	if (row?.refresh_token) {
		try {
			const discovery = await json(await providerFetch(`${ISSUER}/.well-known/openid-configuration`));
			const endpoint = typeof discovery.revocation_endpoint === 'string' ? URL.parse(discovery.revocation_endpoint) : null;
			if (discovery.issuer !== ISSUER || endpoint?.origin !== ISSUER) throw unavailable();
			const token = await unseal(await key(env), row.refresh_token, user.id, 'refresh_token');
			for (let attempt = 0; attempt < 2; attempt++) {
				const response = await providerFetch(endpoint.href, { method: 'POST', body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: row.client_id }) }).catch(() => null);
				if (response?.status === 200) { revocationConfirmed = true; break; }
				if (response && response.status < 500) break;
				if (!attempt) await scheduler.wait(200);
			}
		} catch { /* The user can remove access in ChatGPT Settings. */ }
	}
	return Response.json({ ...view(await readConnection(env, user.id)), revocationConfirmed });
}

export async function handleChatgpt(request: Request, env: Env, user: User): Promise<Response | null> {
	const match = /^\/api\/ai\/connection(?:\/(start|finish))?$/.exec(new URL(request.url).pathname);
	if (!match) return null;
	methods(request, match[1] ? ['POST'] : ['GET', 'PATCH', 'DELETE']);
	if (match[1] === 'start') return start(request, env, user);
	if (match[1] === 'finish') return finish(request, env, user);
	if (request.method === 'DELETE') return disconnect(env, user);
	if (request.method === 'PATCH') {
		const data = object(await readJson(request), ['model']), row = await readConnection(env, user.id);
		if (!row?.refresh_token) throw disconnected();
		if (!view(row).models.some(model => model.slug === data.model)) throw new HttpError(400, 'invalid_model', 'Выберите доступную модель.');
		await env.DB.prepare('UPDATE ai_connections SET model=?,updated_at=? WHERE user_id=? AND version=?').bind(data.model, Date.now(), user.id, row.version).run();
	}
	return Response.json(view(await readConnection(env, user.id)));
}
