import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export const CALLBACK = 'http://127.0.0.1:47319/auth/callback';
export const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export function responseStream(value: unknown): Response {
	const event = { type: 'response.completed', response: { id: 'resp_test', status: 'completed', error: null, incomplete_details: null,
		output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }],
	} };
	return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

export async function createOpenAI() {
	const keys = await generateKeyPair('RS256');
	const other = await generateKeyPair('RS256');
	const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
	const provider = {
		claims: {} as JWTPayload,
		badSignature: false, scope: SCOPE, tokenStatus: 200, modelsStatus: 200, emptyModels: false, revokeStatus: 200,
		refreshStatus: 200, refreshBody: {} as Record<string, unknown>, refreshTokens: [] as string[],
		responses: null as ((request: Request) => Response | Promise<Response>) | null,
		calls: [] as Request[],
		fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const request = new Request(input, init);
			provider.calls.push(request.clone());
			const url = request.url;
			if (url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
			if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] });
			if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
				const form = await request.formData();
				const refreshing = form.get('grant_type') === 'refresh_token';
				if (refreshing) {
					provider.refreshTokens.push(String(form.get('refresh_token')));
					if (provider.refreshStatus !== 200) return Response.json(provider.refreshBody, { status: provider.refreshStatus });
				}
				if (provider.tokenStatus !== 200 || form.get('code') === 'denied') return Response.json({ error: 'invalid_grant' }, { status: provider.tokenStatus === 200 ? 400 : provider.tokenStatus });
				const [account, nonce] = refreshing ? [String(form.get('client_id')).replace('oaiapp_', '')] : String(form.get('code') ?? '').split(':');
				const now = Math.floor(Date.now() / 1000);
				const idToken = await new SignJWT({ iss: 'https://auth.openai.com', sub: `subject-${account}`, aud: String(form.get('client_id') ?? ''), exp: now + 3600, iat: now, nonce, email: `${account}@example.test`, ...provider.claims })
					.setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(provider.badSignature ? other.privateKey : keys.privateKey);
				return Response.json({ access_token: `access-${account}${refreshing ? '-renewed' : ''}`, refresh_token: `refresh-${account}${refreshing ? '-renewed' : ''}`, id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: provider.scope, earliest_refresh_at: now + 300, ...(refreshing ? provider.refreshBody : {}) });
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
			if (url === 'https://api.openai.com/v1/responses' && provider.responses) return provider.responses(request);
			throw new Error('Unexpected provider request.');
		},
	};
	return provider;
}
