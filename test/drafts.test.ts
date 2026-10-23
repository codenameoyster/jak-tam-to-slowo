import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { login, request } from './client';
import { ONION_DRAFT, USER_A, USER_B, WORD_DRAFT } from './fixtures';
import { createProvider, message } from './provider';

const string = { type: 'string' }, strings = { type: 'array', items: string };
const schema = { type: 'object', properties: { result: { anyOf: [
	{ type: 'object', properties: { kind: { type: 'string', enum: ['choices'] }, choices: strings }, required: ['kind', 'choices'], additionalProperties: false },
	{ type: 'object', properties: { kind: { type: 'string', enum: ['draft'] }, card: {
		type: 'object', properties: { pl: string, ru: string, examplePl: string, exampleRu: string, meaningRu: string, alternativesPl: strings, alternativesRu: strings },
		required: ['pl', 'ru', 'examplePl', 'exampleRu', 'meaningRu', 'alternativesPl', 'alternativesRu'], additionalProperties: false,
	} }, required: ['kind', 'card'], additionalProperties: false },
] } }, required: ['result'], additionalProperties: false };
let provider: ReturnType<typeof createProvider>, cookie: string;
beforeEach(async () => {
	provider = createProvider();
	vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch);
	cookie = await login(USER_A.id);
	provider.messages = () => message({ result: { kind: 'draft', card: WORD_DRAFT } });
});
const generate = (body: unknown = { text: 'słowo' }) => request('/api/cards/draft', { method: 'POST', cookie, body });

it('prepares the exact Polish example for either learner with the server key and writes no card', async () => {
	cookie = await login(USER_B.id);
	const response = await generate();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ kind: 'draft', card: WORD_DRAFT });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
	expect(provider.calls).toHaveLength(1);
	expect(provider.calls[0].headers.get('Authorization')).toBe('Bearer test-anthropic-key');
	const sent = await provider.calls[0].json<{ model: string; output_config: unknown; messages: unknown }>();
	expect(sent.model).toBe('claude-sonnet-5-5');
	expect(sent.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema } });
	expect(sent.messages).toEqual([{ role: 'user', content: '{"text":"słowo"}' }]);
});

it('returns Russian meaning choices before preparing the selected onion meaning', async () => {
	provider.messages = () => message({ result: { kind: 'choices', choices: ['Овощ', 'Оружие для стрельбы стрелами'] } });
	const choices = await generate({ text: 'лук' });
	expect(choices.status).toBe(200);
	expect(await choices.json()).toEqual({ kind: 'choices', choices: ['Овощ', 'Оружие для стрельбы стрелами'] });
	provider.messages = () => message({ result: { kind: 'draft', card: ONION_DRAFT } });
	const draft = await generate({ text: 'лук', meaningRu: 'Овощ' });
	expect(draft.status).toBe(200);
	expect(await draft.json()).toEqual({ kind: 'draft', card: ONION_DRAFT });
	expect(await provider.calls[1].json()).toMatchObject({ messages: [{ role: 'user', content: '{"text":"лук","meaningRu":"Овощ"}' }] });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
});

it.each([
	{ name: 'empty text', body: { text: ' ' } },
	{ name: 'oversized text', body: { text: 'a'.repeat(201) } },
	{ name: 'missing text', body: {} },
	{ name: 'a language field', body: { text: 'słowo', language: 'pl' } },
	{ name: 'empty selected meaning', body: { text: 'лук', meaningRu: ' ' } },
	{ name: 'oversized selected meaning', body: { text: 'лук', meaningRu: 'я'.repeat(201) } },
	{ name: 'client-selected account', body: { text: 'słowo', userId: USER_B.id } },
])('rejects $name before inference', async ({ body }) => {
	const response = await generate(body);
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ code: 'invalid_input', error: expect.any(String) });
	expect(provider.calls).toHaveLength(0);
});

it('accepts the 200-character boundary and sends the input as the user message', async () => {
	const body = { text: 'a'.repeat(200), meaningRu: 'я'.repeat(200) };
	expect((await generate(body)).status).toBe(200);
	expect(await provider.calls[0].json()).toMatchObject({ messages: [{ role: 'user', content: JSON.stringify(body) }] });
});

it.each([
	{ name: 'unknown result kind', result: { kind: 'other', card: WORD_DRAFT } },
	{ name: 'mixed result fields', result: { kind: 'draft', card: WORD_DRAFT, choices: ['Овощ', 'Оружие'] } },
	{ name: 'blank term', result: { kind: 'draft', card: { ...WORD_DRAFT, pl: ' ' } } },
	{ name: 'empty choices', result: { kind: 'choices', choices: [] } },
	{ name: 'one choice', result: { kind: 'choices', choices: ['Овощ'] } },
	{ name: 'blank choice', result: { kind: 'choices', choices: ['Овощ', ' '] } },
	{ name: 'duplicate choices', result: { kind: 'choices', choices: ['Овощ', ' Овощ '] } },
	{ name: 'oversized choice', result: { kind: 'choices', choices: ['Овощ', 'я'.repeat(201)] } },
	{ name: 'non-string choice', result: { kind: 'choices', choices: ['Овощ', 1] } },
])('returns a service error for $name and creates no card', async ({ result }) => {
	provider.messages = () => message({ result });
	const response = await generate();
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ code: 'ai_invalid_response', error: 'ИИ вернул неверную карточку. Попробуйте снова.' });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
});

it('requires a final draft after the learner selects a meaning', async () => {
	provider.messages = () => message({ result: { kind: 'choices', choices: ['Овощ', 'Оружие'] } });
	const response = await generate({ text: 'лук', meaningRu: 'Овощ' });
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({ code: 'ai_invalid_response' });
});

it('returns 503 for a missing key before inference', async () => {
	Reflect.deleteProperty(env, 'ANTHROPIC_API_KEY');
	const result = await generate();
	expect(result.status).toBe(503);
	expect(await result.json()).toEqual({ code: 'ai_unavailable', error: 'ИИ не настроен. Попросите владельца проверить ключ API.' });
	expect(provider.calls).toHaveLength(0);
});

it('requires an authenticated same-origin POST', async () => {
	expect((await request('/api/cards/draft', { method: 'POST', body: { text: 'słowo' } })).status).toBe(401);
	expect((await request('/api/cards/draft', { method: 'POST', cookie, origin: 'https://elsewhere.test', body: { text: 'słowo' } })).status).toBe(403);
	expect((await request('/api/cards/draft', { cookie })).status).toBe(405);
	expect(provider.calls).toHaveLength(0);
});
