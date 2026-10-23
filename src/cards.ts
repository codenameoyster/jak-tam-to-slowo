import type { Card, CardContent, CardPage, User } from '../shared/types';
import type { Env } from './index';
import { HttpError, methods, object, readJson, text, uuidPattern } from './http';

const contentKeys: (keyof CardContent)[] = ['pl', 'ru', 'examplePl', 'exampleRu', 'meaningRu', 'alternativesPl', 'alternativesRu'];
export const columns = `cards.id, cards.pl, cards.ru, cards.example_pl AS examplePl, cards.example_ru AS exampleRu, cards.meaning_ru AS meaningRu,
	cards.alternatives_pl AS alternativesPl, cards.alternatives_ru AS alternativesRu, cards.version, cards.archived,
	cards.created_by AS createdBy, cards.created_at AS createdAt, cards.updated_at AS updatedAt`;
export type CardRow = Omit<Card, 'archived' | 'alternativesPl' | 'alternativesRu'> & { archived: number; alternativesPl: string; alternativesRu: string };

export function fromRow(row: CardRow): Card {
	return { ...row, archived: row.archived === 1, alternativesPl: JSON.parse(row.alternativesPl), alternativesRu: JSON.parse(row.alternativesRu) };
}

function alternatives(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 8) throw new HttpError(400, 'invalid_input', 'Укажите не больше восьми других ответов для каждого языка.');
	return value.map(item => text(item, 200).trim());
}

export function parseCard(value: unknown): CardContent {
	const data = object(value, contentKeys);
	return {
		pl: text(data.pl, 200).trim(), ru: text(data.ru, 200).trim(),
		examplePl: text(data.examplePl, 500).trim(), exampleRu: text(data.exampleRu, 500).trim(),
		meaningRu: text(data.meaningRu, 200).trim(),
		alternativesPl: alternatives(data.alternativesPl), alternativesRu: alternatives(data.alternativesRu),
	};
}

function searchKey(value: string): string { return value.trim().normalize('NFC').toLowerCase(); }

export async function readCard(env: Env, id: string): Promise<Card> {
	const row = await env.DB.prepare(`SELECT ${columns} FROM cards WHERE id = ?`).bind(id).first<CardRow>();
	if (!row) throw new HttpError(404, 'not_found', 'Карточка не найдена.');
	return fromRow(row);
}

async function listCards(url: URL, env: Env): Promise<CardPage> {
	const query = url.searchParams.get('q') ?? '';
	if (query.length > 200) throw new HttpError(400, 'invalid_input', 'Поисковый запрос слишком длинный.');
	let time: number | null = null;
	let id: string | null = null;
	const cursor = url.searchParams.get('cursor');
	if (cursor !== null) {
		const parts = cursor.split(':');
		if (parts.length !== 2 || !/^\d{1,16}$/.test(parts[0]) || !Number.isSafeInteger(Number(parts[0])) || !uuidPattern.test(parts[1])) {
			throw new HttpError(400, 'invalid_input', 'Неверный указатель страницы. Повторите поиск.');
		}
		time = Number(parts[0]);
		id = parts[1];
	}
	const { results } = await env.DB.prepare(`SELECT ${columns} FROM cards
		WHERE archived = 0 AND (instr(search_pl, ?1) > 0 OR instr(search_ru, ?1) > 0)
		AND (?2 IS NULL OR (created_at, id) < (?2, ?3)) ORDER BY created_at DESC, id DESC LIMIT 31`)
		.bind(searchKey(query), time, id).all<CardRow>();
	const cards = results.slice(0, 30).map(fromRow);
	const last = cards.at(-1);
	return { cards, nextCursor: results.length > 30 && last ? `${last.createdAt}:${last.id}` : null };
}

export async function handleCards(request: Request, env: Env, user: User): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname === '/api/cards') {
		methods(request, ['GET', 'POST']);
		if (request.method === 'GET') return Response.json(await listCards(url, env));
		const { id, ...value } = object(await readJson(request, 32_768), ['id', ...contentKeys]);
		if (typeof id !== 'string' || !uuidPattern.test(id)) throw new HttpError(400, 'invalid_input', 'Неверный идентификатор карточки.');
		const content = parseCard(value);
		const now = Date.now();
		const row = await env.DB.prepare(`INSERT INTO cards
			(id, pl, ru, example_pl, example_ru, meaning_ru, alternatives_pl, alternatives_ru, search_pl, search_ru, create_content, created_by, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING ${columns}`)
			.bind(id, content.pl, content.ru, content.examplePl, content.exampleRu, content.meaningRu,
				JSON.stringify(content.alternativesPl), JSON.stringify(content.alternativesRu), searchKey(content.pl), searchKey(content.ru), JSON.stringify(content), user.id, now, now).first<CardRow>();
		if (row) return Response.json(fromRow(row), { status: 201 });
		const original = await env.DB.prepare('SELECT create_content FROM cards WHERE id = ?').bind(id).first<string>('create_content');
		if (original !== JSON.stringify(content)) {
			throw new HttpError(409, 'card_conflict', 'Карточка с этим идентификатором уже содержит другой текст.');
		}
		return Response.json(await readCard(env, id));
	}
	const match = /^\/api\/cards\/([^/]+)$/.exec(url.pathname);
	if (!match || !uuidPattern.test(match[1])) return null;
	methods(request, ['PATCH']);
	const id = match[1];
	const data = object(await readJson(request, 32_768), ['version', 'archived', ...contentKeys]);
	const { version, ...value } = data;
	if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new HttpError(400, 'invalid_input', 'Укажите версию карточки.');
	let row: CardRow | null;
	if ('archived' in value) {
		object(value, ['archived']);
		if (value.archived !== true) throw new HttpError(400, 'invalid_input', 'Выберите карточку для архива.');
		await readCard(env, id);
		row = await env.DB.prepare(`UPDATE cards SET archived = 1, version = version + 1, updated_at = ?
			WHERE id = ? AND version = ? AND archived = 0 RETURNING ${columns}`).bind(Date.now(), id, version).first<CardRow>();
	} else {
		const content = parseCard(value);
		await readCard(env, id);
		row = await env.DB.prepare(`UPDATE cards SET pl = ?, ru = ?, example_pl = ?, example_ru = ?, meaning_ru = ?,
			alternatives_pl = ?, alternatives_ru = ?, search_pl = ?, search_ru = ?, version = version + 1, updated_at = ?
			WHERE id = ? AND version = ? AND archived = 0 RETURNING ${columns}`)
			.bind(content.pl, content.ru, content.examplePl, content.exampleRu, content.meaningRu,
				JSON.stringify(content.alternativesPl), JSON.stringify(content.alternativesRu), searchKey(content.pl), searchKey(content.ru), Date.now(), id, version).first<CardRow>();
	}
	if (!row) throw new HttpError(409, 'version_conflict', 'Карточка уже изменена, возможно вашим прошлым сохранением. Скопируйте текст, откройте карточку снова и проверьте его.');
	return Response.json(fromRow(row));
}
