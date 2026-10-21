import { handleMe, handleSession, requireUser } from './auth';
import { handleCards } from './cards';
import { handleChatgpt } from './chatgpt';
import { handleDraft } from './drafts';
import { HttpError, protectRequest } from './http';

export interface Env extends Bindings { LOCAL_HTTP?: string }

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== '/api' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
		let response: Response;
		try {
			protectRequest(request, env);
			if (pathname === '/api/session') response = await handleSession(request, env);
			else {
				const user = await requireUser(request, env);
				if (pathname === '/api/me') response = await handleMe(request, env, user);
				else if (pathname === '/api/cards/draft') response = await handleDraft(request, env, user);
				else {
					const result = await handleCards(request, env, user) ?? await handleChatgpt(request, env, user);
					if (!result) throw new HttpError(404, 'not_found', 'Страница не найдена.');
					response = result;
				}
			}
		} catch (error) {
			if (error instanceof HttpError) response = Response.json({ error: error.message, code: error.code }, { status: error.status });
			else {
				console.error(JSON.stringify({ event: 'request_failed', path: pathname, message: error instanceof Error ? error.message : 'Unknown error' }));
				response = Response.json({ error: 'Не удалось выполнить запрос. Попробуйте снова.', code: 'internal_error' }, { status: 500 });
			}
		}
		response.headers.set('Cache-Control', 'private, no-store');
		response.headers.set('X-Content-Type-Options', 'nosniff');
		return response;
	},
} satisfies ExportedHandler<Env>;
