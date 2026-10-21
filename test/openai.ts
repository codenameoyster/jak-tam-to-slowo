import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export const CALLBACK = 'http://127.0.0.1:47319/auth/callback';
export const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export async function createOpenAI() {
	const keys = await generateKeyPair('RS256');
	const other = await generateKeyPair('RS256');
	const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
	const provider = {
		claims: {} as JWTPayload,
		badSignature: false, scope: SCOPE, tokenStatus: 200, modelsStatus: 200, emptyModels: false, revokeStatus: 200,
		calls: [] as Request[],
		fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const request = new Request(input, init);
			provider.calls.push(request.clone());
			const url = request.url;
			if (url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
			if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] });
			if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
				const form = await request.formData();
				if (provider.tokenStatus !== 200 || form.get('code') === 'denied') return Response.json({ error: 'invalid_grant' }, { status: provider.tokenStatus === 200 ? 400 : provider.tokenStatus });
				const [account, nonce] = String(form.get('code') ?? '').split(':');
				const now = Math.floor(Date.now() / 1000);
				const idToken = await new SignJWT({ iss: 'https://auth.openai.com', sub: `subject-${account}`, aud: String(form.get('client_id') ?? ''), exp: now + 3600, iat: now, nonce, email: `${account}@example.test`, ...provider.claims })
					.setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(provider.badSignature ? other.privateKey : keys.privateKey);
				return Response.json({ access_token: `access-${account}`, refresh_token: `refresh-${account}`, id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: provider.scope, earliest_refresh_at: now + 300 });
			}
			if (url === 'https://api.openai.com/v1/models') {
				if (provider.modelsStatus !== 200) return Response.json({ error: 'unavailable' }, { status: provider.modelsStatus });
				const account = request.headers.get('Authorization')?.replace('Bearer access-', '');
				return Response.json({ models: provider.emptyModels ? [] : [
					{ slug: `${account}-hidden`, display_name: 'Hidden', visibility: 'hidden' },
					{ slug: `${account}-first`, display_name: `${account} first`, visibility: 'list' },
					{ slug: `${account}-second`, display_name: `${account} second`, visibility: 'list' },
				] });
			}
			if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') return new Response(null, { status: provider.revokeStatus });
			throw new Error('Unexpected provider request.');
		},
	};
	return provider;
}
