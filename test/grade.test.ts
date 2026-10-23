import { beforeEach, expect, it, vi } from 'vitest';
import type { Card, CardContent, Direction, Grade, ReviewResult } from '../shared/types';
import { login, request } from './client';
import { CARD_A, USER_A, WORD_DRAFT } from './fixtures';
import { createProvider, message } from './provider';

const turtle: CardContent = { pl: 'Żółw', ru: 'Черепаха', meaningRu: 'Животное', examplePl: 'Żółw ma skorupę.', exampleRu: 'У черепахи есть панцирь.', alternativesPl: [], alternativesRu: [] };
const aiGrade = { grade: 'almost', explanation: 'Sprawdzono znaczenie i formę słowa.' };
let provider: ReturnType<typeof createProvider>, cookie: string;
beforeEach(async () => {
	provider = createProvider();
	provider.messages = () => message(aiGrade);
	vi.spyOn(globalThis, 'fetch').mockImplementation(provider.fetch);
	cookie = await login(USER_A.id);
});

it.each([
	{ name: 'Polish case and surrounding spaces', card: WORD_DRAFT, direction: 'ru-pl', answer: ' słowo ', grade: 'correct', correction: 'Słowo', explanation: 'Dobrze.', source: 'exact' },
	{ name: 'Russian case and surrounding spaces', card: WORD_DRAFT, direction: 'pl-ru', answer: '  СЛОВО  ', grade: 'correct', correction: 'Слово', explanation: 'Dobrze.', source: 'exact' },
	{ name: 'decomposed Polish Unicode', card: turtle, direction: 'ru-pl', answer: 'z\u0307o\u0301łw', grade: 'correct', correction: 'Żółw', explanation: 'Dobrze.', source: 'exact' },
	{ name: 'repeated whitespace in an expression', card: { ...WORD_DRAFT, pl: 'Zielona herbata' }, direction: 'ru-pl', answer: ' ZIELONA \n HERBATA ', grade: 'correct', correction: 'Zielona herbata', explanation: 'Dobrze.', source: 'exact' },
	{ name: 'saved Polish alternative', card: CARD_A, direction: 'ru-pl', answer: ' WYRAZ ', grade: 'correct', correction: 'Słowo', explanation: 'Dobrze.', source: 'exact' },
	{ name: 'saved Russian alternative', card: CARD_A, direction: 'pl-ru', answer: 'словечко', grade: 'correct', correction: 'Слово', explanation: 'Dobrze.', source: 'exact' },
	{ name: 'Russian е for ё', card: { ...WORD_DRAFT, pl: 'Zielony', ru: 'Зелёный' }, direction: 'pl-ru', answer: 'зеленый', grade: 'correct', correction: 'Зелёный', explanation: 'Dobrze.', source: 'exact' },
	{ name: 'missing ł', card: WORD_DRAFT, direction: 'ru-pl', answer: 'slowo', grade: 'almost', correction: 'Słowo', explanation: 'Prawie dobrze. Sprawdź polskie litery: Słowo.', source: 'exact' },
	{ name: 'missing ż, ó, and ł', card: turtle, direction: 'ru-pl', answer: 'zolw', grade: 'almost', correction: 'Żółw', explanation: 'Prawie dobrze. Sprawdź polskie litery: Żółw.', source: 'exact' },
	{ name: 'missing ó in a Polish alternative', card: { ...WORD_DRAFT, alternativesPl: ['Słówko'] }, direction: 'ru-pl', answer: 'słowko', grade: 'almost', correction: 'Słowo', explanation: 'Prawie dobrze. Sprawdź polskie litery: Słówko.', source: 'exact' },
	{ name: 'Russian и for й', card: { ...WORD_DRAFT, pl: 'Mój', ru: 'Мой' }, direction: 'pl-ru', answer: 'мои', correction: 'Мой', source: 'ai' },
	{ name: 'Russian answer in the Polish direction', card: CARD_A, direction: 'ru-pl', answer: 'Слово', correction: 'Słowo', source: 'ai' },
	{ name: 'Polish alternative in the Russian direction', card: CARD_A, direction: 'pl-ru', answer: 'Wyraz', correction: 'Слово', source: 'ai' },
	{ name: 'empty answer', card: WORD_DRAFT, direction: 'ru-pl', answer: '', grade: 'again', correction: 'Słowo', explanation: 'Brak odpowiedzi. Powtórz słowo.', source: 'exact' },
	{ name: 'whitespace-only answer', card: WORD_DRAFT, direction: 'pl-ru', answer: ' \t\n ', grade: 'again', correction: 'Слово', explanation: 'Brak odpowiedzi. Powtórz słowo.', source: 'exact' },
] satisfies { name: string; card: CardContent; direction: Direction; answer: string; grade?: Grade; correction: string; explanation?: string; source: 'exact' | 'ai' }[])
('grades $name against the saved meaning and direction', async ({ card, direction, answer, grade, correction, explanation, source }) => {
	const created = await request('/api/cards', { method: 'POST', cookie, body: { ...card, id: CARD_A.id } });
	expect(created.status).toBe(201);
	const { pl, ru, examplePl, exampleRu, meaningRu, alternativesPl, alternativesRu } = await created.json<Card>();
	const response = await request('/api/reviews', { method: 'POST', cookie, body: {
		attemptId: crypto.randomUUID(), cardId: CARD_A.id, cardVersion: 1, progressVersion: 0, direction, action: 'answer', answer,
	} });
	expect(response.status).toBe(200);
	expect(await response.json<ReviewResult>()).toMatchObject({ ...(source === 'ai' ? aiGrade : { grade, explanation }), correction, source, direction });
	expect(provider.calls).toHaveLength(source === 'ai' ? 1 : 0);
	if (source === 'ai') {
		expect(provider.calls[0].headers.get('Authorization')).toBe('Bearer test-anthropic-key');
		const sent = await provider.calls[0].json<{ model: string; output_config: unknown; messages: { content: string }[] }>();
		expect(sent.model).toBe('claude-sonnet-5-5');
		expect(sent.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: {
			type: 'object', properties: { grade: { type: 'string', enum: ['correct', 'almost', 'again'] }, explanation: { type: 'string' } },
			required: ['grade', 'explanation'], additionalProperties: false,
		} } });
		expect(JSON.parse(sent.messages[0].content)).toEqual({ card: { pl, ru, examplePl, exampleRu, meaningRu, alternativesPl, alternativesRu }, direction, answer });
	}
});
