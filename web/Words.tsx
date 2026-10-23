import { useEffect, useState, type FormEvent } from 'react';
import type { Card, CardContent, CardPage } from '../shared/types';
import { api, ApiError } from './api';
import { CardFields } from './CardFields';

interface Edit { card: Pick<Card, 'id' | 'version'>; value: CardContent }

export function Words({ userId, onBusy, onExpired, initialCard = null }: { userId: string; onBusy(busy: boolean): void; onExpired(): void; initialCard?: Card | null }) {
	const key = `word-edit:${userId}`;
	const [page, setPage] = useState<CardPage>({ cards: [], nextCursor: null });
	const [query, setQuery] = useState('');
	const [search, setSearch] = useState('');
	const [edit, setEdit] = useState<Edit | null>(() => {
		try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; }
	});
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState('');
	const [storageError, setStorageError] = useState('');

	function persist(value: Edit | null): boolean {
		try {
			if (value) sessionStorage.setItem(key, JSON.stringify(value));
			else sessionStorage.removeItem(key);
			setStorageError('');
			return true;
		} catch { setStorageError('Браузер не сохранил правки. Скопируйте текст и освободите место перед повтором.'); return false; }
	}
	function changeEdit(value: Edit | null) { setEdit(value); persist(value); }
	function failed(error: unknown, fallback: string) {
		if (error instanceof ApiError && error.code === 'unauthorized') onExpired();
		else setError(error instanceof ApiError ? error.message : fallback);
	}

	async function load(query: string, cursor?: string) {
		setBusy(true);
		setError('');
		try {
			const params = new URLSearchParams({ q: query });
			if (cursor) params.set('cursor', cursor);
			const result = await api<CardPage>(`/cards?${params}`);
			setPage(current => ({ cards: cursor ? [...current.cards, ...result.cards] : result.cards, nextCursor: result.nextCursor }));
			setSearch(query);
		} catch (error) { failed(error, 'Нет связи с сервером. Повторите поиск.'); }
		finally { setBusy(false); }
	}
	useEffect(() => { void load(''); if (initialCard && !edit) select(initialCard); }, [initialCard]);

	function select(card: Card) {
		const { pl, ru, meaningRu, examplePl, exampleRu, alternativesPl, alternativesRu } = card;
		setEdit({ card: { id: card.id, version: card.version }, value: { pl, ru, meaningRu, examplePl, exampleRu, alternativesPl, alternativesRu } });
		setError('');
	}

	async function save(archive = false) {
		if (!edit || !persist(edit)) return;
		setBusy(true);
		onBusy(true);
		setError('');
		try {
			const body = archive ? { version: edit.card.version, archived: true } : {
				...edit.value, version: edit.card.version,
				alternativesPl: edit.value.alternativesPl.filter(value => value.trim()),
				alternativesRu: edit.value.alternativesRu.filter(value => value.trim()),
			};
			await api<Card>(`/cards/${edit.card.id}`, { method: 'PATCH', body: JSON.stringify(body) });
			changeEdit(null);
			await load(search);
		} catch (error) { failed(error, 'Нет связи с сервером. Правки остались в форме. Попробуйте сохранить ещё раз.'); }
		finally { setBusy(false); onBusy(false); }
	}

	function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void save(); }

	return <section className="page words" aria-labelledby="words-title" aria-busy={busy}>
		<h1 id="words-title">Слова</h1>
		{edit ? <>
			<p>Изменения видны обоим ученикам.</p>
			<p className="hint">Сохраняйте значение карточки. Для другого значения используйте «Добавить».</p>
			<form onSubmit={submit}>
				<fieldset disabled={busy}><CardFields value={edit.value} onChange={value => changeEdit({ ...edit, value })} /></fieldset>
				{error && <p className="error" role="alert">{error}</p>}
				<button className="primary" disabled={busy} type="submit">Сохранить</button>
				<div className="edit-actions">
					<button type="button" disabled={busy} onClick={() => { changeEdit(null); void load(search); }}>Отменить правки</button>
					<button type="button" disabled={busy} onClick={() => void save(true)}>В архив</button>
				</div>
				<p className="hint">Архив скроет карточку у обоих учеников.</p>
			</form>
		</> : <>
			<p className="intro">Общая коллекция польских и русских слов.</p>
			<form onSubmit={event => { event.preventDefault(); void load(query); }}>
				<label htmlFor="word-search">Поиск слов</label>
				<input id="word-search" type="search" maxLength={200} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
				<button disabled={busy}>Найти</button>
			</form>
			{error && <p className="error" role="alert">{error}</p>}
			{!busy && !error && !page.cards.length && <p role="status">{search ? 'Ничего не найдено.' : 'Слов пока нет.'}</p>}
			<ul className="words-list">{page.cards.map(card => <li key={card.id}>
				<button className="word" disabled={busy} onClick={() => select(card)}><span lang="pl">{card.pl}</span> / <span lang="ru">{card.ru}</span></button>
				<p className="hint">{card.meaningRu}</p>
			</li>)}</ul>
			{page.nextCursor && <button disabled={busy} onClick={() => void load(search, page.nextCursor!)}>Ещё слова</button>}
		</>}
		{storageError && <p className="error" role="alert">{storageError}</p>}
		{busy && <p role="status">Загрузка…</p>}
	</section>;
}
