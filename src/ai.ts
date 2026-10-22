import type { Env } from './index';
import { accessToken, logProviderError, providerError, providerFetch } from './chatgpt';
import { HttpError } from './http';

const invalid = () => new HttpError(503, 'ai_invalid_response', 'ChatGPT вернул неверный ответ. Попробуйте снова.');
const interrupted = () => new HttpError(503, 'ai_interrupted', 'Ответ ChatGPT прервался. Попробуйте снова.');
const refused = () => new HttpError(503, 'ai_refused', 'ChatGPT отказался отвечать. Измените запрос.');
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
	return value as Record<string, unknown>;
}

function completed(value: unknown): unknown {
	const response = object(value);
	if (response.status !== 'completed' || response.error || response.incomplete_details || !Array.isArray(response.output)) throw invalid();
	let text = '';
	for (const value of response.output) {
		const item = object(value);
		if (item.type === 'reasoning') continue;
		if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) throw invalid();
		for (const value of item.content) {
			const part = object(value);
			if (part.type === 'refusal') throw refused();
			if (part.type !== 'output_text' || typeof part.text !== 'string') throw invalid();
			text += part.text;
		}
	}
	if (new TextEncoder().encode(text).byteLength > 16 * 1024) throw invalid();
	try { return JSON.parse(text); } catch { throw invalid(); }
}

async function readStream(response: Response): Promise<unknown> {
	if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'text/event-stream' || !response.body) throw invalid();
	const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	let buffer = '', data = '', name = '', skipLF = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) throw interrupted();
			buffer += decoder.decode(value, { stream: true });
			while (buffer.length) {
				if (skipLF) { if (buffer[0] === '\n') buffer = buffer.slice(1); skipLF = false; }
				const end = buffer.search(/[\r\n]/);
				if (end === -1) break;
				const line = buffer.slice(0, end);
				skipLF = buffer[end] === '\r';
				buffer = buffer.slice(end + 1);
				if (line === '') {
					if (data) {
						if (data.trim() === '[DONE]') throw interrupted();
						let event: Record<string, unknown>;
						try { event = object(JSON.parse(data)); } catch { throw invalid(); }
						if (typeof event.type !== 'string' || (name && name !== event.type)) throw invalid();
						if (event.type === 'response.failed') throw providerError(200, object(event.response));
						if (event.type === 'error') throw providerError(200, event);
						if (event.type === 'response.incomplete') throw new HttpError(503, 'ai_incomplete', 'ChatGPT не завершил ответ. Попробуйте снова.');
						if (event.type.startsWith('response.refusal.')) throw refused();
						if (event.type === 'response.completed') return completed(event.response);
					}
					data = ''; name = '';
				} else if (!line.startsWith(':')) {
					const colon = line.indexOf(':'), field = colon === -1 ? line : line.slice(0, colon);
					const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
					if (field === 'data') data += `${value}\n`;
					if (field === 'event') name = value;
				}
				if (data.length > 256 * 1024) throw invalid();
			}
			if (buffer.length > 256 * 1024) throw invalid();
		}
	} finally { await reader.cancel().catch(() => {}); }
}

export async function requestAiJson(env: Env, instructions: string, input: unknown): Promise<unknown> {
	let token = await accessToken(env), response: Response | undefined;
	const signal = AbortSignal.timeout(45_000);
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			signal.throwIfAborted();
			response = await providerFetch('https://api.openai.com/v1/responses', { method: 'POST', signal, headers: { Authorization: `Bearer ${token.access}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ model: token.model, instructions, input: [{ role: 'user', content: JSON.stringify(input) }], store: false, stream: true }) });
			if (response.ok) return await readStream(response);
			const body = await response.json().catch(() => ({}));
			const error = providerError(response.status, body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {});
			if (response.status !== 401 || attempt) throw error;
			logProviderError(error.status, error.code, response.headers.get('x-request-id'));
			token = await accessToken(env, token.version);
		}
		throw interrupted();
	} catch (cause) {
		const error = signal.aborted ? new HttpError(503, 'ai_timeout', 'ChatGPT не ответил вовремя. Попробуйте снова.') : cause instanceof HttpError ? cause : interrupted();
		logProviderError(error.status, error.code, response?.headers.get('x-request-id') ?? null);
		throw error;
	}
}
