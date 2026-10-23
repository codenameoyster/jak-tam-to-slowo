import type { Env } from './index';

export const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export class HttpError extends Error {
	constructor(public status: number, public code: string, message: string) { super(message); }
}

export function localHttp(request: Request, env: Env): boolean {
	const url = new URL(request.url);
	return env.LOCAL_HTTP === '1' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function protectRequest(request: Request, env: Env): void {
	const url = new URL(request.url);
	if (url.protocol !== 'https:' && !localHttp(request, env)) throw new HttpError(403, 'https_required', 'Откройте приложение через HTTPS.');
	if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('Origin') !== url.origin) {
		throw new HttpError(403, 'foreign_origin', 'Откройте приложение и повторите действие.');
	}
}

export function methods(request: Request, allowed: string[]): void {
	if (!allowed.includes(request.method)) throw new HttpError(405, 'method_not_allowed', 'Этот метод запроса недоступен.');
}

export function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
		throw new HttpError(400, 'invalid_input', 'Проверьте поля запроса.');
	}
	return value as Record<string, unknown>;
}

export function text(value: unknown, max: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, 'invalid_input', 'Проверьте текстовые поля.');
	return value;
}

export async function readBody(request: Request, maxBytes: number, tooLarge: string): Promise<Blob> {
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, 'too_large', tooLarge); }
			chunks.push(value);
		}
	}
	return new Blob(chunks);
}

export async function readJson(request: Request, maxBytes = 4096): Promise<unknown> {
	if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new HttpError(400, 'invalid_input', 'Отправьте запрос в формате JSON.');
	const bytes = await (await readBody(request, maxBytes, 'Запрос слишком большой.')).arrayBuffer();
	try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
	catch { throw new HttpError(400, 'invalid_input', 'Неверный JSON в запросе.'); }
}
