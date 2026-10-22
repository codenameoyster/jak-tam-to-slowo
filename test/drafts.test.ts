import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { login, request } from './client';
import { ONION_DRAFT, USER_A, USER_B, WORD_DRAFT } from './fixtures';
import { CALLBACK, createOpenAI, responseStream } from './openai';

let provider: Awaited<ReturnType<typeof createOpenAI>>, cookie: string;
async function connect(id: string, account: string) {
	const cookie = await login(id);
	const start = await request('/api/ai/connection/start', { method: 'POST', cookie });
	const url = new URL((await start.json<{ url: string }>()).url);
	const address = `${CALLBACK}?${new URLSearchParams({ code: `${account}:${url.searchParams.get('nonce')}`, state: url.searchParams.get('state')!, client_id: `oaiapp_${account}` })}`;
	expect((await request('/api/ai/connection/finish', { method: 'POST', cookie, body: { address } })).status).toBe(200);
	return cookie;
}
beforeEach(async () => {
	provider = await createOpenAI();
	vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch);
	cookie = await connect(USER_A.id, 'a');
	provider.responses = () => responseStream({ kind: 'draft', card: WORD_DRAFT });
});
const generate = (body: unknown = { text: 'słowo', language: 'pl' }) => request('/api/cards/draft', { method: 'POST', cookie, body });
const calls = () => provider.calls.filter(call => call.url.endsWith('/responses'));

it('prepares the exact Polish example with the owner credentials for another learner and writes no card', async () => {
	await request('/api/ai/connection', { method: 'PATCH', cookie, body: { model: 'a-second' } });
	cookie = await login(USER_B.id);
	const response = await generate();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ kind: 'draft', card: {
		pl: 'Słowo', ru: 'Слово', examplePl: 'Nie znam tego słowa.', exampleRu: 'Я не знаю этого слова.',
	} });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
	expect(calls()).toHaveLength(1);
	expect(calls()[0].headers.get('Authorization')).toBe('Bearer access-a');
	expect(await calls()[0].json()).toMatchObject({ model: 'a-second', store: false, stream: true, input: [{ role: 'user', content: '{"text":"słowo","language":"pl"}' }] });
});

it('returns Russian meaning choices before preparing the selected onion meaning', async () => {
	provider.responses = () => responseStream({ kind: 'choices', choices: ['Овощ', 'Оружие для стрельбы стрелами'] });
	const choices = await generate({ text: 'лук', language: 'ru' });
	expect(choices.status).toBe(200);
	expect(await choices.json()).toEqual({ kind: 'choices', choices: ['Овощ', 'Оружие для стрельбы стрелами'] });
	provider.responses = () => responseStream({ kind: 'draft', card: ONION_DRAFT });
	const draft = await generate({ text: 'лук', language: 'ru', meaningRu: 'Овощ' });
	expect(draft.status).toBe(200);
	expect(await draft.json()).toMatchObject({ kind: 'draft', card: { pl: 'Cebula', ru: 'Лук', examplePl: 'Kroję cebulę.', exampleRu: 'Я режу лук.' } });
	expect(await calls()[1].json()).toMatchObject({ input: [{ role: 'user', content: '{"text":"лук","language":"ru","meaningRu":"Овощ"}' }] });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
});

it.each([
	{ name: 'Russian wish', input: { text: 'спокойной ночи', language: 'ru' }, card: { pl: 'Dobranoc', ru: 'Спокойной ночи', examplePl: 'Dobranoc, mamo!', exampleRu: 'Спокойной ночи, мама!', meaningRu: 'Пожелание перед сном', alternativesPl: [], alternativesRu: [] } },
	{ name: 'selected bow meaning', input: { text: 'лук', language: 'ru', meaningRu: 'Оружие для стрельбы стрелами' }, card: { pl: 'Łuk', ru: 'Лук', examplePl: 'Strzelam z łuku.', exampleRu: 'Я стреляю из лука.', meaningRu: 'Оружие для стрельбы стрелами', alternativesPl: [], alternativesRu: [] } },
	{ name: 'multiword term casing', input: { text: 'zielona herbata', language: 'pl' }, card: { pl: 'Zielona herbata', ru: 'Зелёный чай', examplePl: 'Piję zieloną herbatę.', exampleRu: 'Я пью зелёный чай.', meaningRu: 'Напиток', alternativesPl: [], alternativesRu: [] } },
])('preserves the independent $name reference in a preview', async ({ input, card }) => {
	provider.responses = () => responseStream({ kind: 'draft', card });
	const response = await generate(input);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ kind: 'draft', card });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
});

it.each([
	{ name: 'empty text', body: { text: ' ', language: 'pl' } },
	{ name: 'oversized text', body: { text: 'a'.repeat(201), language: 'pl' } },
	{ name: 'missing text', body: { language: 'pl' } },
	{ name: 'unsupported language', body: { text: 'word', language: 'en' } },
	{ name: 'missing language', body: { text: 'słowo' } },
	{ name: 'empty selected meaning', body: { text: 'лук', language: 'ru', meaningRu: ' ' } },
	{ name: 'oversized selected meaning', body: { text: 'лук', language: 'ru', meaningRu: 'я'.repeat(201) } },
	{ name: 'client-selected account', body: { text: 'słowo', language: 'pl', userId: USER_B.id } },
])('rejects $name before inference', async ({ body }) => {
	const response = await generate(body);
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ code: 'invalid_input', error: expect.any(String) });
	expect(calls()).toHaveLength(0);
});

it('accepts the 200-character boundary and keeps input out of fixed instructions', async () => {
	const body = { text: 'a'.repeat(200), language: 'ru', meaningRu: 'я'.repeat(200) };
	expect((await generate(body)).status).toBe(200);
	const sent = await calls()[0].json<{ instructions: string; input: unknown }>();
	expect(sent.input).toEqual([{ role: 'user', content: JSON.stringify(body) }]);
	expect(sent.instructions).not.toContain(body.text);
	expect(sent.instructions).not.toContain(body.meaningRu);
	expect(sent.instructions.length).toBeGreaterThan(0);
});

it.each([
	{ name: 'unknown result kind', result: { kind: 'other', card: WORD_DRAFT } },
	{ name: 'mixed result fields', result: { kind: 'draft', card: WORD_DRAFT, choices: ['Овощ', 'Оружие'] } },
	{ name: 'missing Polish term', result: { kind: 'draft', card: { ...WORD_DRAFT, pl: undefined } } },
	{ name: 'missing Russian term', result: { kind: 'draft', card: { ...WORD_DRAFT, ru: undefined } } },
	{ name: 'missing Polish sentence', result: { kind: 'draft', card: { ...WORD_DRAFT, examplePl: undefined } } },
	{ name: 'missing Russian sentence', result: { kind: 'draft', card: { ...WORD_DRAFT, exampleRu: undefined } } },
	{ name: 'missing meaning', result: { kind: 'draft', card: { ...WORD_DRAFT, meaningRu: undefined } } },
	{ name: 'missing Polish alternatives', result: { kind: 'draft', card: { ...WORD_DRAFT, alternativesPl: undefined } } },
	{ name: 'missing Russian alternatives', result: { kind: 'draft', card: { ...WORD_DRAFT, alternativesRu: undefined } } },
	{ name: 'blank term', result: { kind: 'draft', card: { ...WORD_DRAFT, pl: ' ' } } },
	{ name: 'non-string sentence', result: { kind: 'draft', card: { ...WORD_DRAFT, exampleRu: 1 } } },
	{ name: 'oversized sentence', result: { kind: 'draft', card: { ...WORD_DRAFT, examplePl: 'a'.repeat(501) } } },
	{ name: 'oversized term', result: { kind: 'draft', card: { ...WORD_DRAFT, ru: 'я'.repeat(201) } } },
	{ name: 'invalid alternatives', result: { kind: 'draft', card: { ...WORD_DRAFT, alternativesRu: [''] } } },
	{ name: 'extra card field', result: { kind: 'draft', card: { ...WORD_DRAFT, id: 'invented' } } },
	{ name: 'empty choices', result: { kind: 'choices', choices: [] } },
	{ name: 'one choice', result: { kind: 'choices', choices: ['Овощ'] } },
	{ name: 'blank choice', result: { kind: 'choices', choices: ['Овощ', ' '] } },
	{ name: 'duplicate choices', result: { kind: 'choices', choices: ['Овощ', ' Овощ '] } },
	{ name: 'oversized choice', result: { kind: 'choices', choices: ['Овощ', 'я'.repeat(201)] } },
	{ name: 'non-string choice', result: { kind: 'choices', choices: ['Овощ', 1] } },
])('returns a service error for $name and creates no card', async ({ result }) => {
	provider.responses = () => responseStream(result);
	const response = await generate();
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({ code: 'ai_invalid_response', error: expect.any(String) });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
});

it('requires a final draft after the learner selects a meaning', async () => {
	provider.responses = () => responseStream({ kind: 'choices', choices: ['Овощ', 'Оружие'] });
	const response = await generate({ text: 'лук', language: 'ru', meaningRu: 'Овощ' });
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({ code: 'ai_invalid_response' });
});

it.each([
	{ name: 'missing completed event', response: () => new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{}"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), status: 503, code: 'ai_interrupted' },
	{ name: 'provider rejection', response: () => Response.json({ error: { code: 'subscription_sharing_invalid_user' } }, { status: 401 }), status: 401, code: 'subscription_sharing_invalid_user' },
])('preserves the $name error contract', async ({ response, status, code }) => {
	await env.DB.prepare('UPDATE ai_connections SET refresh_after=NULL WHERE user_id=?').bind(USER_A.id).run();
	provider.responses = response;
	const result = await generate();
	expect(result.status).toBe(status);
	expect(await result.json()).toMatchObject({ code, error: expect.any(String) });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
});

it('requires an authenticated same-origin POST', async () => {
	expect((await request('/api/cards/draft', { method: 'POST', body: { text: 'słowo', language: 'pl' } })).status).toBe(401);
	expect((await request('/api/cards/draft', { method: 'POST', cookie, origin: 'https://elsewhere.test', body: { text: 'słowo', language: 'pl' } })).status).toBe(403);
	expect((await request('/api/cards/draft', { cookie })).status).toBe(405);
	expect(calls()).toHaveLength(0);
});
