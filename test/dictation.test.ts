import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { login } from './client';
import { USER_A } from './fixtures';

let cookie: string;
beforeEach(async () => { cookie = await login(USER_A.id); });

function clip(language = 'pl', type = 'audio/webm;codecs=opus', size = 4): FormData {
	const body = new FormData();
	body.set('language', language);
	body.set('clip', new File([size === 4 ? new Uint8Array([0, 1, 254, 255]) : new Uint8Array(size)], 'clip', { type }));
	return body;
}

function send(body: BodyInit = clip(), headers: Record<string, string> = {}, method = 'POST') {
	return worker.fetch(new Request('https://learn.rustatian.me/api/dictation', {
		method, headers: { Origin: 'https://learn.rustatian.me', Cookie: cookie, ...headers }, body: method === 'GET' ? undefined : body,
	}), env);
}

it.each([
	{ name: 'Polish WebM/Opus', language: 'pl', type: 'audio/webm;codecs=opus', recognized: '  Słowo. \n', text: 'Słowo.' },
	{ name: 'Russian MP4/AAC', language: 'ru', type: 'audio/mp4;codecs=mp4a.40.2', recognized: '  Слово. \n', text: 'Слово.' },
	{ name: 'MP4 browser default codec', language: 'ru', type: 'audio/mp4', recognized: 'Слово.', text: 'Слово.' },
	{ name: 'WebM browser default codec', language: 'pl', type: 'audio/webm', recognized: 'Słowo.', text: 'Słowo.' },
])('transcribes $name without an answer prompt or database writes', async ({ language, type, recognized, text }) => {
	const run = vi.spyOn(env.AI, 'run').mockResolvedValue({ text: recognized });
	const prepare = vi.spyOn(env.DB, 'prepare');
	const response = await send(clip(language, type));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ text });
	expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	expect(run).toHaveBeenCalledExactlyOnceWith('@cf/openai/whisper-large-v3-turbo', {
		audio: 'AAH+/w==', language, task: 'transcribe', vad_filter: true,
	});
	expect(run.mock.calls[0][1]).not.toHaveProperty('initial_prompt');
	expect(prepare.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
});

it.each<{ name: string; headers: Record<string, string>; method: string; status: number }>([
	{ name: 'missing authentication', headers: { Cookie: '' }, method: 'POST', status: 401 },
	{ name: 'foreign origin', headers: { Origin: 'https://elsewhere.test' }, method: 'POST', status: 403 },
	{ name: 'wrong method', headers: {}, method: 'GET', status: 405 },
])('rejects $name before inference', async ({ headers, method, status }) => {
	const run = vi.spyOn(env.AI, 'run').mockRejectedValue(new Error('Inference must not run.'));
	expect((await send(clip(), headers, method)).status).toBe(status);
	expect(run).not.toHaveBeenCalled();
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
	const run = vi.spyOn(env.AI, 'run').mockRejectedValue(new Error('Inference must not run.'));
	const response = await send(body());
	expect(response.status).toBe(status);
	expect(await response.json()).toMatchObject({ error: expect.any(String), code: status === 413 ? 'too_large' : 'invalid_input' });
	expect(run).not.toHaveBeenCalled();
});

it.each([
	{ name: 'JSON upload', body: '{}', type: 'application/json' },
	{ name: 'malformed multipart', body: 'broken', type: 'multipart/form-data; boundary=missing' },
])('rejects $name', async ({ body, type }) => {
	const run = vi.spyOn(env.AI, 'run').mockRejectedValue(new Error('Inference must not run.'));
	expect((await send(body, { 'Content-Type': type })).status).toBe(400);
	expect(run).not.toHaveBeenCalled();
});

it.each([
	{ name: 'exact 2 MiB multipart body', bytes: 2 * 1024 * 1024, status: 200, calls: 1 },
	{ name: 'one byte over 2 MiB without Content-Length', bytes: 2 * 1024 * 1024 + 1, status: 413, calls: 0 },
])('bounds the $name', async ({ bytes, status, calls }) => {
	const run = vi.spyOn(env.AI, 'run').mockResolvedValue({ text: 'Słowo' });
	const start = '--bound\r\nContent-Disposition: form-data; name="language"\r\n\r\npl\r\n--bound\r\nContent-Disposition: form-data; name="clip"; filename="clip"\r\nContent-Type: audio/webm\r\n\r\n';
	const end = '\r\n--bound--\r\n';
	const body = new Blob([start, new Uint8Array(bytes - start.length - end.length), end]);
	const response = await send(body.stream(), { 'Content-Type': 'multipart/form-data; boundary=bound' });
	expect(response.status).toBe(status);
	expect(run).toHaveBeenCalledTimes(calls);
});

it.each([
	{ name: 'no recognized speech', result: { text: ' \n ' }, status: 422, code: 'no_speech' },
	{ name: 'invalid upstream response', result: {}, status: 503, code: 'dictation_unavailable' },
	{ name: 'upstream failure', result: null, status: 503, code: 'dictation_unavailable' },
])('returns an actionable error for $name and stores no audio', async ({ result, status, code }) => {
	const run = vi.spyOn(env.AI, 'run');
	if (result) run.mockResolvedValue(result);
	else run.mockRejectedValue(new Error('Provider audio error with private details'));
	const prepare = vi.spyOn(env.DB, 'prepare');
	const response = await send();
	expect(response.status).toBe(status);
	expect(await response.json()).toEqual({ code, error: expect.stringMatching(/Повторите|Попробуйте/) });
	expect(prepare.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
});
