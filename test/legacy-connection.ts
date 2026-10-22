import { env } from 'cloudflare:workers';
import { USER_B } from './fixtures';
import { SCOPE } from './openai';

export async function seedLegacyConnection() {
	const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(env.AI_TOKEN_KEY), char => char.charCodeAt(0)), 'AES-GCM', false, ['encrypt']);
	async function encrypt(field: string, value: string) {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${USER_B.id}:${field}`) }, key, new TextEncoder().encode(value));
		return btoa(String.fromCharCode(...iv, ...new Uint8Array(cipher)));
	}
	await env.DB.prepare(`INSERT INTO ai_connections (user_id, client_id, host_id, issuer, subject, account_label, access_token, refresh_token, scopes, expires_at, model, models, updated_at)
		VALUES (?, 'oaiapp_b', ?, 'https://auth.openai.com', 'subject-b', 'b@example.test', ?, ?, ?, ?, 'b-first', ?, ?)`)
		.bind(USER_B.id, env.CHATGPT_HOST_ID, await encrypt('access_token', 'access-b'), await encrypt('refresh_token', 'refresh-b'), SCOPE, Date.now() + 3_600_000, JSON.stringify([{ slug: 'b-first', name: 'b first' }]), Date.now()).run();
}
