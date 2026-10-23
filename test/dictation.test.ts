import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { login } from './client';
import { testBindings, USER_A, USER_B } from './fixtures';
import { createProvider } from './provider';

let cookie: string;
let provider: ReturnType<typeof createProvider>;
beforeEach(async () => {
	cookie = await login(USER_A.id);
	env.OPENAI_TRANSCRIPTION_API_KEY = testBindings.OPENAI_TRANSCRIPTION_API_KEY;
	provider = createProvider();
	provider.transcriptions = () => Response.json({ text: 'Słowo.', languages: [{ code: 'pl' }] });
	vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch);
});

function clip(language = 'pl', type = 'audio/webm;codecs=opus', size = 4): FormData {
	const body = new FormData();
	body.set('language', language);
	body.set('clip', new File([size === 4 ? new Uint8Array([0, 1, 254, 255]) : new Uint8Array(size)], 'private-answer', { type }));
	return body;
}

function send(body: BodyInit = clip(), headers: Record<string, string> = {}, method = 'POST') {
	return worker.fetch(new Request('https://learn.rustatian.me/api/dictation', {
		method, headers: { Origin: 'https://learn.rustatian.me', Cookie: cookie, ...headers }, body: method === 'GET' ? undefined : body,
	}), env);
}

function observe() {
	return {
		prepare: vi.spyOn(env.DB, 'prepare'),
		logs: [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {})],
	};
}

async function expectFailure(response: Response, status: number, code: string, action: RegExp, observed: ReturnType<typeof observe>) {
	expect(response.status).toBe(status);
	const body = await response.json<{ code: string; error: string }>();
	expect(body).toEqual({ code, error: expect.stringMatching(action) });
	expect(body.code).not.toBe('unauthorized');
	expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	expect(response.headers.get('Set-Cookie')).toBeNull();
	expect(JSON.stringify([body, observed.logs.map(log => log.mock.calls)]))
		.not.toMatch(/private provider message|test-transcription-key/);
	expect(observed.prepare.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
}

it.each([
	{ name: 'Polish WebM/Opus for the owner', user: USER_A.id, language: 'pl', hints: ['pl'], detected: 'pl', type: 'audio/webm;codecs=opus', filename: 'recording.webm', recognized: '  Słowo. \n', text: 'Słowo.' },
	{ name: 'Russian MP4/AAC for the other learner', user: USER_B.id, language: 'ru', hints: ['ru'], detected: 'ru', type: 'audio/mp4;codecs=mp4a.40.2', filename: 'recording.m4a', recognized: '  Слово. \n', text: 'Слово.' },
	{ name: 'Russian MP4 browser default codec', user: USER_A.id, language: 'ru', hints: ['ru'], detected: 'ru', type: 'audio/mp4', filename: 'recording.m4a', recognized: 'Слово.', text: 'Слово.' },
	{ name: 'Polish WebM browser default codec', user: USER_B.id, language: 'pl', hints: ['pl'], detected: 'pl', type: 'audio/webm', filename: 'recording.webm', recognized: 'Słowo.', text: 'Słowo.' },
	{ name: 'automatic Polish WebM/Opus', user: USER_A.id, language: 'auto', hints: ['pl', 'ru'], detected: 'pl', type: 'audio/webm;codecs=opus', filename: 'recording.webm', recognized: '  Słowo. \n', text: 'Słowo.' },
	{ name: 'automatic Russian MP4/AAC with incorrect language metadata', user: USER_B.id, language: 'auto', hints: ['pl', 'ru'], detected: 'pl', type: 'audio/mp4;codecs=mp4a.40.2', filename: 'recording.m4a', recognized: '  Слово. \n', text: 'Слово.' },
])('transcribes $name without an answer prompt or database writes', async ({ user, language, hints, detected, type, filename, recognized, text }) => {
	cookie = await login(user);
	provider.transcriptions = () => Response.json({ text: recognized, languages: [{ code: detected }] });
	const prepare = vi.spyOn(env.DB, 'prepare');
	const response = await send(clip(language, type));
	expect(response.status).toBe(200);
	expect(provider.calls).toHaveLength(1);
	const call = provider.calls[0];
	expect(call.url).toBe('https://api.openai.com/v1/audio/transcriptions');
	expect(call.method).toBe('POST');
	expect(call.redirect).toBe('manual');
	expect(call.headers.get('Authorization')).toBe('Bearer test-transcription-key');
	expect(call.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
	const form = await call.formData();
	expect([...form.keys()].sort()).toEqual(['file', ...hints.map(() => 'languages[]'), 'model']);
	expect(form.get('model')).toBe('gpt-transcribe');
	expect(form.getAll('languages[]')).toEqual(hints);
	const file = form.get('file');
	expect(file).toBeInstanceOf(File);
	if (!(file instanceof File)) throw new Error('Missing audio file.');
	expect(file.name).toBe(filename);
	expect(file.type).toBe(type);
	expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 1, 254, 255]);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ text });
	expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	expect(prepare.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
});

it.each<{ name: string; headers: Record<string, string>; method: string; status: number }>([
	{ name: 'missing authentication', headers: { Cookie: '' }, method: 'POST', status: 401 },
	{ name: 'foreign origin', headers: { Origin: 'https://elsewhere.test' }, method: 'POST', status: 403 },
	{ name: 'wrong method', headers: {}, method: 'GET', status: 405 },
])('rejects $name before inference', async ({ headers, method, status }) => {
	expect((await send(clip(), headers, method)).status).toBe(status);
	expect(provider.calls).toHaveLength(0);
});

it.each([
	{ name: 'unsupported language', body: () => clip('en'), status: 400 },
	{ name: 'unsupported media type', body: () => clip('pl', 'video/webm'), status: 400 },
	{ name: 'empty clip', body: () => clip('pl', 'audio/webm', 0), status: 400 },
	{ name: 'missing clip', body: () => { const body = clip(); body.delete('clip'); return body; }, status: 400 },
	{ name: 'missing language', body: () => { const body = clip(); body.delete('language'); return body; }, status: 400 },
	{ name: 'text in place of a file', body: () => { const body = clip(); body.set('clip', 'audio'); return body; }, status: 400 },
	{ name: 'answer prompt', body: () => { const body = clip(); body.set('initial_prompt', 'Dom'); return body; }, status: 400 },
	{ name: 'duplicate language', body: () => { const body = clip(); body.append('language', 'ru'); return body; }, status: 400 },
	{ name: 'duplicate clip', body: () => { const body = clip(); body.append('clip', new File(['audio'], 'extra', { type: 'audio/mp4' })); return body; }, status: 400 },
	{ name: 'oversized clip', body: () => clip('pl', 'audio/webm', 2 * 1024 * 1024 + 1), status: 413 },
	{ name: 'oversized multipart body with a small clip', body: () => { const body = clip(); body.set('language', 'x'.repeat(2 * 1024 * 1024)); return body; }, status: 413 },
])('rejects $name without inference', async ({ body, status }) => {
	const response = await send(body());
	expect(response.status).toBe(status);
	expect(await response.json()).toMatchObject({ error: expect.any(String), code: status === 413 ? 'too_large' : 'invalid_input' });
	expect(provider.calls).toHaveLength(0);
});

it.each([
	{ name: 'JSON upload', body: '{}', type: 'application/json' },
	{ name: 'malformed multipart', body: 'broken', type: 'multipart/form-data; boundary=missing' },
])('rejects $name', async ({ body, type }) => {
	expect((await send(body, { 'Content-Type': type })).status).toBe(400);
	expect(provider.calls).toHaveLength(0);
});

it.each([
	{ name: 'exact 2 MiB multipart body', bytes: 2 * 1024 * 1024, status: 200, calls: 1 },
	{ name: 'one byte over 2 MiB without Content-Length', bytes: 2 * 1024 * 1024 + 1, status: 413, calls: 0 },
])('bounds the $name', async ({ bytes, status, calls }) => {
	const start = '--bound\r\nContent-Disposition: form-data; name="language"\r\n\r\npl\r\n--bound\r\nContent-Disposition: form-data; name="clip"; filename="clip"\r\nContent-Type: audio/webm\r\n\r\n';
	const end = '\r\n--bound--\r\n';
	const body = new Blob([start, new Uint8Array(bytes - start.length - end.length), end]);
	const response = await send(body.stream(), { 'Content-Type': 'multipart/form-data; boundary=bound' });
	expect(response.status).toBe(status);
	expect(provider.calls).toHaveLength(calls);
});

it.each([
	{ name: 'absent configuration', key: undefined },
	{ name: 'empty configuration', key: '' },
])('rejects $name before inference', async ({ key }) => {
	if (key === undefined) Reflect.deleteProperty(env, 'OPENAI_TRANSCRIPTION_API_KEY');
	else env.OPENAI_TRANSCRIPTION_API_KEY = key;
	const observed = observe();
	const response = await send();
	await expectFailure(response, 503, 'dictation_unavailable', /właściciela.*ustawień/, observed);
	expect(provider.calls).toHaveLength(0);
});

it.each([
	{ name: 'no recognized speech', reply: () => Response.json({ text: ' \n ', languages: [] }), status: 422, code: 'no_speech', action: /Nagraj ponownie/ },
	{ name: 'empty transcript', reply: () => Response.json({ text: '', languages: [] }), status: 422, code: 'no_speech', action: /Nagraj ponownie/ },
	{ name: 'missing transcript', reply: () => Response.json({}), status: 503, code: 'dictation_unavailable', action: /Spróbuj ponownie/ },
	{ name: 'non-string transcript', reply: () => Response.json({ text: 42 }), status: 503, code: 'dictation_unavailable', action: /Spróbuj ponownie/ },
	{ name: 'null result', reply: () => Response.json(null), status: 503, code: 'dictation_unavailable', action: /Spróbuj ponownie/ },
	{ name: 'malformed JSON', reply: () => new Response('private provider message test-transcription-key'), status: 503, code: 'dictation_unavailable', action: /Spróbuj ponownie/ },
	{ name: 'empty result', reply: () => new Response(null), status: 503, code: 'dictation_unavailable', action: /Spróbuj ponownie/ },
	{ name: 'provider authentication failure', reply: () => Response.json({ error: { message: 'private provider message test-transcription-key' } }, { status: 401 }), status: 503, code: 'dictation_unavailable', action: /właściciela.*ustawień/ },
	{ name: 'provider permission failure', reply: () => Response.json({ error: { message: 'private provider message test-transcription-key' } }, { status: 403 }), status: 503, code: 'dictation_unavailable', action: /właściciela.*ustawień/ },
	{ name: 'provider rate limit', reply: () => Response.json({ error: { message: 'private provider message test-transcription-key' } }, { status: 429 }), status: 503, code: 'dictation_unavailable', action: /Spróbuj później/ },
	{ name: 'provider server failure', reply: () => Response.json({ error: { message: 'private provider message test-transcription-key' } }, { status: 500 }), status: 503, code: 'dictation_unavailable', action: /Spróbuj ponownie/ },
	{ name: 'provider redirect', reply: () => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.test' } }), status: 503, code: 'dictation_unavailable', action: /Spróbuj ponownie/ },
	{ name: 'network failure', reply: () => { throw new Error('private provider message test-transcription-key'); }, status: 503, code: 'dictation_unavailable', action: /Spróbuj ponownie/ },
])('returns an actionable error for $name without a retry or audio storage', async ({ reply, status, code, action }) => {
	provider.transcriptions = reply;
	const observed = observe();
	await expectFailure(await send(), status, code, action, observed);
	expect(provider.calls).toHaveLength(1);
});

it.each([
	{ name: 'network timeout before headers', body: false },
	{ name: 'network timeout during the response body', body: true },
])('stops at 30 seconds for $name without a retry or audio storage', async ({ body }) => {
	const timer = new AbortController();
	const timeouts = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal);
	provider.transcriptions = request => body
		? new Response(new ReadableStream({ start(controller) { request.signal.addEventListener('abort', () => controller.error(request.signal.reason)); } }))
		: new Promise((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason)); });
	const observed = observe();
	const response = send();
	try { await vi.waitFor(() => expect(provider.calls).toHaveLength(1)); }
	finally { timer.abort(new DOMException('private provider message test-transcription-key', 'TimeoutError')); }
	await expectFailure(await response, 503, 'dictation_unavailable', /na czas.*Nagraj ponownie/, observed);
	expect(timeouts).toHaveBeenCalledExactlyOnceWith(30_000);
	expect(provider.calls).toHaveLength(1);
});
