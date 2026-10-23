import { useEffect, useState, type FormEvent } from 'react';
import type { Card, CardContent, CardPage } from '../shared/types';
import { api, ApiError } from './api';
import { CardFields } from './CardFields';

interface Edit { card: Pick<Card, 'id' | 'version'>; value: CardContent }

export function Words({ userId, onBusy, initialCard = null }: { userId: string; onBusy(busy: boolean): void; initialCard?: Card | null }) {
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
		} catch { setStorageError('Przeglądarka nie zapisała zmian. Skopiuj tekst i zwolnij miejsce przed ponowną próbą.'); return false; }
	}
	function changeEdit(value: Edit | null) { setEdit(value); persist(value); }
	function failed(error: unknown, fallback: string) {
		setError(error instanceof ApiError ? error.message : fallback);
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
		} catch (error) { failed(error, 'Brak połączenia z serwerem. Wyszukaj ponownie.'); }
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
		} catch (error) { failed(error, 'Brak połączenia z serwerem. Zmiany zostały w formularzu. Spróbuj zapisać ponownie.'); }
		finally { setBusy(false); onBusy(false); }
	}

	function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void save(); }

	return <section className="page words" aria-labelledby="words-title" aria-busy={busy}>
		<h1 id="words-title">Słówka</h1>
		{edit ? <>
			<p>Zmiany będą widoczne dla obu osób.</p>
			<p className="hint">Zachowaj znaczenie fiszki. Dla innego znaczenia użyj „Dodaj”.</p>
			<form onSubmit={submit}>
				<fieldset disabled={busy}><CardFields value={edit.value} onChange={value => changeEdit({ ...edit, value })} /></fieldset>
				{error && <p className="error" role="alert">{error}</p>}
				<button className="primary" disabled={busy} type="submit">Zapisz</button>
				<div className="edit-actions">
					<button type="button" disabled={busy} onClick={() => { changeEdit(null); void load(search); }}>Odrzuć zmiany</button>
					<button type="button" disabled={busy} onClick={() => void save(true)}>Do archiwum</button>
				</div>
				<p className="hint">Archiwizacja ukryje fiszkę u obu osób.</p>
			</form>
		</> : <>
			<p className="intro">Wspólna kolekcja polskich i rosyjskich słówek.</p>
			<form className="search" onSubmit={event => { event.preventDefault(); void load(query); }}>
				<label htmlFor="word-search">Szukaj słówek</label>
				<input id="word-search" type="search" placeholder="Szukaj słówek" maxLength={200} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
				<button disabled={busy}>Szukaj</button>
			</form>
			{error && <p className="error" role="alert">{error}</p>}
			{!busy && !error && !page.cards.length && <p role="status">{search ? 'Nic nie znaleziono.' : 'Nie ma jeszcze słówek.'}</p>}
			<ul className="words-list">{page.cards.map(card => <li key={card.id}>
				<button className="word" disabled={busy} onClick={() => select(card)}><span lang="pl">{card.pl}</span> / <span lang="ru">{card.ru}</span></button>
				<p className="hint" lang="ru">{card.meaningRu}</p>
			</li>)}</ul>
			{page.nextCursor && <button disabled={busy} onClick={() => void load(search, page.nextCursor!)}>Więcej słówek</button>}
		</>}
		{storageError && <p className="error" role="alert">{storageError}</p>}
		{busy && <p role="status">Wczytywanie…</p>}
	</section>;
}
