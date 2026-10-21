import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { readCard } from '../src/cards';
import { login, request } from './client';
import { CARD_A, CARD_B, USER_A, USER_B } from './fixtures';

const { id: cardId, ...content } = CARD_A;
const now = Date.parse('2026-10-21T10:00:00.000Z');

it('shares cards and rejects a stale edit without losing the other learner’s text', async () => {
	vi.spyOn(Date, 'now').mockReturnValue(now);
	const a = await login(USER_A.id);
	const b = await login(USER_B.id);
	const created = await request('/api/cards', { method: 'POST', cookie: a, body: CARD_A });
	expect(created.status).toBe(201);
	expect(await created.json()).toEqual({ ...CARD_A, version: 1, archived: false, createdBy: USER_A.id, createdAt: now, updatedAt: now });
	const list = await request('/api/cards', { cookie: b });
	expect(await list.json()).toMatchObject({ cards: [{ ...CARD_A, version: 1 }] });
	vi.spyOn(Date, 'now').mockReturnValue(now + 1000);
	const updated = await request(`/api/cards/${cardId}`, { method: 'PATCH', cookie: b, body: { ...content, ru: 'Словечко', version: 1 } });
	expect(updated.status).toBe(200);
	expect(await updated.json()).toMatchObject({ version: 2, ru: 'Словечко', alternativesRu: [], alternativesPl: ['Wyraz'], createdAt: now, updatedAt: now + 1000 });
	const response = await request(`/api/cards/${cardId}`, { method: 'PATCH', cookie: a, body: { ...content, ru: 'Мой вариант', version: 1 } });
	expect(response.status).toBe(409);
	expect(await readCard(env, cardId)).toMatchObject({ version: 2, ru: 'Словечко' });
});

it('archives for both learners and rejects an edit of the archived card', async () => {
	const a = await login(USER_A.id);
	const b = await login(USER_B.id);
	expect((await request('/api/cards', { method: 'POST', cookie: a, body: CARD_A })).status).toBe(201);
	const archived = await request(`/api/cards/${cardId}`, { method: 'PATCH', cookie: b, body: { version: 1, archived: true } });
	expect(archived.status).toBe(200);
	expect(await archived.json()).toMatchObject({ id: cardId, version: 2, archived: true, pl: 'Słowo' });
	expect(await (await request('/api/cards', { cookie: a })).json()).toEqual({ cards: [], nextCursor: null });
	expect(await (await request('/api/cards', { cookie: b })).json()).toEqual({ cards: [], nextCursor: null });
	expect((await request(`/api/cards/${cardId}`, { method: 'PATCH', cookie: a, body: { ...content, version: 2 } })).status).toBe(409);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(1);
});

it('saves identical concurrent create retries once and rejects different content for that ID', async () => {
	const cookie = await login(USER_A.id);
	const responses = await Promise.all([
		request('/api/cards', { method: 'POST', cookie, body: CARD_A }),
		request('/api/cards', { method: 'POST', cookie, body: CARD_A }),
	]);
	expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
	expect(await responses[0].json()).toEqual(await responses[1].json());
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards WHERE id=?').bind(cardId).first('n')).toBe(1);
	const conflict = await request('/api/cards', { method: 'POST', cookie, body: { ...CARD_A, ru: 'Другая запись' } });
	expect(conflict.status).toBe(409);
	expect(await env.DB.prepare('SELECT ru FROM cards WHERE id = ?').bind(cardId).first('ru')).toBe('Слово');
});

it('recognizes a create retry after the other learner has edited the card', async () => {
	const a = await login(USER_A.id);
	const b = await login(USER_B.id);
	expect((await request('/api/cards', { method: 'POST', cookie: a, body: CARD_A })).status).toBe(201);
	expect((await request(`/api/cards/${cardId}`, { method: 'PATCH', cookie: b, body: { ...content, ru: 'Словечко', version: 1 } })).status).toBe(200);
	const retry = await request('/api/cards', { method: 'POST', cookie: a, body: CARD_A });
	expect(retry.status).toBe(200);
	expect(await retry.json()).toMatchObject({ id: cardId, ru: 'Словечко', version: 2 });
	const different = await request('/api/cards', { method: 'POST', cookie: a, body: { ...CARD_A, ru: 'Словечко', alternativesRu: [] } });
	expect(different.status).toBe(409);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards WHERE id=?').bind(cardId).first('n')).toBe(1);
});

it.each([
	{ name: 'Polish lowercase', query: 'słowo', ids: [cardId] },
	{ name: 'Russian uppercase', query: 'СЛОВО', ids: [cardId] },
	{ name: 'Polish uppercase with spaces', query: ' SŁOWO ', ids: [cardId] },
	{ name: 'substring', query: 'łow', ids: [cardId] },
	{ name: 'diacritics retained', query: 'slowo', ids: [] },
	{ name: 'literal percent', query: '%', ids: [] },
	{ name: 'SQL text', query: "' OR 1=1 --", ids: [] },
])('searches shared terms with $name', async ({ query, ids }) => {
	const cookie = await login(USER_A.id);
	expect((await request('/api/cards', { method: 'POST', cookie, body: CARD_A })).status).toBe(201);
	const response = await request(`/api/cards?q=${encodeURIComponent(query)}`, { cookie: await login(USER_B.id) });
	expect(response.status).toBe(200);
	expect((await response.json() as { cards: { id: string }[] }).cards.map(card => card.id)).toEqual(ids);
});

it('updates Unicode search keys and clears only the changed language’s alternatives', async () => {
	const cookie = await login(USER_A.id);
	expect((await request('/api/cards', { method: 'POST', cookie, body: CARD_A })).status).toBe(201);
	const response = await request(`/api/cards/${cardId}`, { method: 'PATCH', cookie, body: { ...content, pl: 'Żółw', version: 1 } });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ alternativesPl: [], alternativesRu: ['Словечко'] });
	const found = await request(`/api/cards?q=${encodeURIComponent('Z\u0307O\u0301ŁW')}`, { cookie });
	expect(await found.json()).toMatchObject({ cards: [{ id: cardId, pl: 'Żółw' }] });
	expect(await (await request('/api/cards?q=słowo', { cookie })).json()).toEqual({ cards: [], nextCursor: null });
});

it.each([
	{ name: 'empty Polish term', change: { pl: '  ' } },
	{ name: 'empty Russian term', change: { ru: '' } },
	{ name: 'oversized Polish term', change: { pl: 'a'.repeat(201) } },
	{ name: 'oversized Russian term', change: { ru: 'я'.repeat(201) } },
	{ name: 'oversized meaning', change: { meaningRu: 'я'.repeat(201) } },
	{ name: 'oversized Polish sentence', change: { examplePl: 'a'.repeat(501) } },
	{ name: 'oversized Russian sentence', change: { exampleRu: 'я'.repeat(501) } },
	{ name: 'too many Polish alternatives', change: { alternativesPl: Array(9).fill('Wyraz') } },
	{ name: 'too many Russian alternatives', change: { alternativesRu: Array(9).fill('Словечко') } },
	{ name: 'oversized alternative', change: { alternativesPl: ['a'.repeat(201)] } },
	{ name: 'empty alternative', change: { alternativesRu: [' '] } },
	{ name: 'invalid alternatives type', change: { alternativesPl: 'Wyraz' } },
	{ name: 'missing sentence', change: { exampleRu: undefined } },
	{ name: 'forged creator', change: { createdBy: USER_B.id } },
	{ name: 'invalid card ID', change: { id: '../invalid' } },
])('rejects $name before a write', async ({ change }) => {
	const cookie = await login(USER_A.id);
	const response = await request('/api/cards', { method: 'POST', cookie, body: { ...CARD_A, ...change } });
	expect(response.status).toBe(400);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
});

it('accepts the content limits including eight alternatives per language', async () => {
	const cookie = await login(USER_A.id);
	const body = { ...CARD_A, pl: 'ą'.repeat(200), ru: 'я'.repeat(200), meaningRu: 'я'.repeat(200), examplePl: 'ą'.repeat(500), exampleRu: 'я'.repeat(500), alternativesPl: Array(8).fill('ą'.repeat(200)), alternativesRu: Array(8).fill('я'.repeat(200)) };
	const response = await request('/api/cards', { method: 'POST', cookie, body });
	expect(response.status).toBe(201);
	expect(await response.json()).toMatchObject(body);
});

it.each([
	{ name: 'absent version', change: { version: undefined } },
	{ name: 'zero version', change: { version: 0 } },
	{ name: 'fractional version', change: { version: 1.5 } },
	{ name: 'invalid edited term', change: { ru: '' } },
	{ name: 'content mixed with archive', change: { archived: true } },
])('rejects an edit with $name without changing content', async ({ change }) => {
	const cookie = await login(USER_A.id);
	expect((await request('/api/cards', { method: 'POST', cookie, body: CARD_A })).status).toBe(201);
	const response = await request(`/api/cards/${cardId}`, { method: 'PATCH', cookie, body: { ...content, version: 1, ...change } });
	expect(response.status).toBe(400);
	expect(await env.DB.prepare('SELECT version, ru FROM cards WHERE id = ?').bind(cardId).first()).toEqual({ version: 1, ru: 'Слово' });
});

it('accepts only one simultaneous edit of the same content version', async () => {
	const a = await login(USER_A.id);
	const b = await login(USER_B.id);
	expect((await request('/api/cards', { method: 'POST', cookie: a, body: CARD_A })).status).toBe(201);
	const responses = await Promise.all([
		request(`/api/cards/${cardId}`, { method: 'PATCH', cookie: a, body: { ...content, exampleRu: 'Первый пример.', version: 1 } }),
		request(`/api/cards/${cardId}`, { method: 'PATCH', cookie: b, body: { ...content, exampleRu: 'Второй пример.', version: 1 } }),
	]);
	expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
	const saved = await responses.find(response => response.status === 200)!.json() as { exampleRu: string };
	expect(await env.DB.prepare('SELECT version, example_ru FROM cards WHERE id = ?').bind(cardId).first()).toEqual({ version: 2, example_ru: saved.exampleRu });
});

it('pages 30 cards in descending creation and ID order without repeats after an insertion', async () => {
	vi.spyOn(Date, 'now').mockReturnValue(now);
	const cookie = await login(USER_A.id);
	const ids = Array.from({ length: 31 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
	for (const id of ids) expect((await request('/api/cards', { method: 'POST', cookie, body: { ...CARD_A, id } })).status).toBe(201);
	const first = await (await request('/api/cards', { cookie })).json() as { cards: { id: string }[]; nextCursor: string };
	expect(first.cards).toHaveLength(30);
	expect(first.cards.map(card => card.id)).toEqual(ids.slice(1).reverse());
	expect(first.nextCursor).toBeTypeOf('string');
	vi.spyOn(Date, 'now').mockReturnValue(now + 1);
	expect((await request('/api/cards', { method: 'POST', cookie, body: CARD_B })).status).toBe(201);
	const second = await (await request(`/api/cards?cursor=${encodeURIComponent(first.nextCursor)}`, { cookie })).json();
	expect(second).toMatchObject({ cards: [{ id: ids[0] }], nextCursor: null });
	expect((second as { cards: unknown[] }).cards).toHaveLength(1);
});

it.each([
	{ name: 'invalid cursor', query: 'cursor=bad' },
	{ name: 'oversized search', query: `q=${'a'.repeat(201)}` },
])('rejects $name', async ({ query }) => {
	expect((await request(`/api/cards?${query}`, { cookie: await login(USER_A.id) })).status).toBe(400);
});

it('requires a session and a same-origin write for shared cards', async () => {
	expect((await request('/api/cards')).status).toBe(401);
	expect((await request('/api/cards', { method: 'POST', body: CARD_A })).status).toBe(401);
	const response = await request('/api/cards', { method: 'POST', cookie: await login(USER_A.id), origin: 'https://other.example', body: CARD_A });
	expect(response.status).toBe(403);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM cards').first('n')).toBe(0);
});
