import { beforeEach, expect, it, vi } from 'vitest';
import type { Card, CardContent, Direction, Grade, ReviewResult } from '../shared/types';
import { login, request } from './client';
import { CARD_A, ONION_DRAFT, USER_A, WORD_DRAFT } from './fixtures';
import { CALLBACK, createOpenAI, responseStream } from './openai';

const car: CardContent = { pl: 'Samochód', ru: 'Автомобиль', meaningRu: 'Легковой автомобиль', examplePl: 'Samochód stoi przed domem.', exampleRu: 'Автомобиль стоит перед домом.', alternativesPl: [], alternativesRu: [] };
const turtle: CardContent = { pl: 'Żółw', ru: 'Черепаха', meaningRu: 'Животное', examplePl: 'Żółw ma skorupę.', exampleRu: 'У черепахи есть панцирь.', alternativesPl: [], alternativesRu: [] };
let provider: Awaited<ReturnType<typeof createOpenAI>>, cookie: string;
beforeEach(async () => {
	provider = await createOpenAI();
	vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch);
	cookie = await login(USER_A.id);
	const start = await request('/api/ai/connection/start', { method: 'POST', cookie });
	const url = new URL((await start.json<{ url: string }>()).url);
	const address = `${CALLBACK}?${new URLSearchParams({ code: `a:${url.searchParams.get('nonce')}`, state: url.searchParams.get('state')!, client_id: 'oaiapp_a' })}`;
	expect((await request('/api/ai/connection/finish', { method: 'POST', cookie, body: { address } })).status).toBe(200);
});

it.each([
	{ name: 'Polish case and surrounding spaces', card: WORD_DRAFT, direction: 'ru-pl', answer: ' słowo ', grade: 'correct', correction: 'Słowo', source: 'exact' },
	{ name: 'Russian case and surrounding spaces', card: WORD_DRAFT, direction: 'pl-ru', answer: '  СЛОВО  ', grade: 'correct', correction: 'Слово', source: 'exact' },
	{ name: 'decomposed Polish Unicode', card: turtle, direction: 'ru-pl', answer: 'z\u0307o\u0301łw', grade: 'correct', correction: 'Żółw', source: 'exact' },
	{ name: 'repeated whitespace in an expression', card: { ...WORD_DRAFT, pl: 'Zielona herbata' }, direction: 'ru-pl', answer: ' ZIELONA \n HERBATA ', grade: 'correct', correction: 'Zielona herbata', source: 'exact' },
	{ name: 'saved Polish alternative', card: CARD_A, direction: 'ru-pl', answer: ' WYRAZ ', grade: 'correct', correction: 'Słowo', source: 'exact' },
	{ name: 'saved Russian alternative', card: CARD_A, direction: 'pl-ru', answer: 'словечко', grade: 'correct', correction: 'Слово', source: 'exact' },
	{ name: 'missing ł', card: WORD_DRAFT, direction: 'ru-pl', answer: 'slowo', grade: 'almost', correction: 'Słowo', source: 'ai' },
	{ name: 'wrong term', card: WORD_DRAFT, direction: 'ru-pl', answer: 'książka', grade: 'again', correction: 'Słowo', source: 'ai' },
	{ name: 'Polish same-meaning synonym', card: car, direction: 'ru-pl', answer: 'auto', grade: 'correct', correction: 'Samochód', source: 'ai' },
	{ name: 'Russian same-meaning synonym', card: car, direction: 'pl-ru', answer: 'авто', grade: 'correct', correction: 'Автомобиль', source: 'ai' },
	{ name: 'missing ż, ó, and ł', card: turtle, direction: 'ru-pl', answer: 'zolw', grade: 'almost', correction: 'Żółw', source: 'ai' },
	{ name: 'wrong homonym meaning', card: ONION_DRAFT, direction: 'ru-pl', answer: 'łuk', grade: 'again', correction: 'Cebula', source: 'ai' },
	{ name: 'isolated inflected term from the example', card: WORD_DRAFT, direction: 'ru-pl', answer: 'słowa', grade: 'almost', correction: 'Słowo', source: 'ai' },
	{ name: 'Russian answer in the Polish direction', card: CARD_A, direction: 'ru-pl', answer: 'Слово', grade: 'again', correction: 'Słowo', source: 'ai' },
	{ name: 'Polish alternative in the Russian direction', card: CARD_A, direction: 'pl-ru', answer: 'Wyraz', grade: 'again', correction: 'Слово', source: 'ai' },
	{ name: 'empty answer', card: WORD_DRAFT, direction: 'ru-pl', answer: '', grade: 'again', correction: 'Słowo', source: 'exact' },
	{ name: 'whitespace-only answer', card: WORD_DRAFT, direction: 'pl-ru', answer: ' \t\n ', grade: 'again', correction: 'Слово', source: 'exact' },
] satisfies { name: string; card: CardContent; direction: Direction; answer: string; grade: Grade; correction: string; source: 'exact' | 'ai' }[])
('grades $name against the saved meaning and direction', async ({ card, direction, answer, grade, correction, source }) => {
	const created = await request('/api/cards', { method: 'POST', cookie, body: { ...card, id: CARD_A.id } });
	expect(created.status).toBe(201);
	const stored = await created.json<Card>();
	provider.responses = () => responseStream({ grade, correction, explanationRu: 'Проверено значение и форма слова.' });
	const response = await request('/api/reviews', { method: 'POST', cookie, body: {
		attemptId: crypto.randomUUID(), cardId: stored.id, cardVersion: 1, progressVersion: 0, direction, action: 'answer', answer,
	} });
	expect(response.status).toBe(200);
	expect(await response.json<ReviewResult>()).toMatchObject({ grade, correction, source, direction, explanationRu: expect.any(String) });
	const calls = provider.calls.filter(call => call.url.endsWith('/responses'));
	expect(calls).toHaveLength(source === 'ai' ? 1 : 0);
	if (source === 'ai') {
		expect(calls[0].headers.get('Authorization')).toBe('Bearer access-a');
		const sent = await calls[0].json<{ instructions: string; input: { content: string }[] }>();
		expect(JSON.parse(sent.input[0].content)).toEqual({ card: stored, direction, answer });
		expect(sent.instructions.length).toBeGreaterThan(0);
	}
});
