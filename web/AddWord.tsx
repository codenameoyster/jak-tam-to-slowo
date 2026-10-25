import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Card, CardContent, CardPage, DraftResult } from '../shared/types';
import { api, ApiError } from './api';
import { CardFields } from './CardFields';
import { Dictation, dictatedValue } from './Dictation';

interface Draft {
	id: string;
	text: string;
	meaningRu?: string;
	choices: string[];
	card?: CardContent;
	submission?: string;
}

export function AddWord({ userId, onOpen, busy, onBusy: setBusy }: { userId: string; onOpen(card: Card): void; busy: boolean; onBusy(busy: boolean): void }) {
	const key = `card-draft:${userId}`;
	const [draft, setDraft] = useState<Draft | null>(() => {
		try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; }
	});
	const [error, setError] = useState('');
	const [storageError, setStorageError] = useState('');
	const [saved, setSaved] = useState<Card | null>(null);
	// null until the search for the current text ends.
	const [matches, setMatches] = useState<Card[] | null>(null);
	const [searchError, setSearchError] = useState('');
	const [dictationId, setDictationId] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	// Set when a new card or a meaning list arrives, so the page scrolls to it once.
	const reveal = useRef(false);
	const query = draft?.text.trim() ?? '';
	const locked = busy || !!draft?.submission;

	useEffect(() => {
		try {
			if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
			else sessionStorage.removeItem(key);
			setStorageError('');
		} catch { setStorageError('Przeglądarka nie zapisała szkicu. Skopiuj tekst przed zamknięciem strony.'); }
	}, [draft, key]);

	useEffect(() => {
		let cancelled = false;
		setSearchError('');
		// The previous matches stay until the next search ends, so the list does not blink on each key.
		if (!query) { setMatches(null); return; }
		const timer = setTimeout(() => {
			void api<CardPage>(`/cards?${new URLSearchParams({ q: query })}`).then(page => {
				if (!cancelled) setMatches(page.cards);
			}).catch(() => {
				if (cancelled) return;
				setMatches(null);
				setSearchError('Nie udało się wyszukać podobnych słówek. Sprawdź kolekcję w sekcji „Słówka”.');
			});
		}, 250);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [query]);

	useEffect(() => {
		if (!reveal.current) return;
		reveal.current = false;
		document.getElementById('draft-result')?.scrollIntoView({ block: 'start' });
	}, [draft?.card, draft?.choices]);

	function change(value: Partial<Draft>) {
		setDraft(current => ({ ...(current ?? { id: crypto.randomUUID(), text: '', choices: [] }), ...value }));
		setError('');
		setSaved(null);
	}

	async function generate(meaningRu = draft?.meaningRu) {
		if (!draft || draft.submission) return;
		setBusy(true);
		setError('');
		setSaved(null);
		change({ meaningRu });
		try {
			const result = await api<DraftResult>('/cards/draft', { method: 'POST', body: JSON.stringify({ text: draft.text, meaningRu }) });
			reveal.current = true;
			change(result.kind === 'draft' ? { card: result.card, choices: [] } : { choices: result.choices, card: undefined });
		} catch (error) {
			setError(error instanceof ApiError ? error.message : 'Brak połączenia z serwerem. Szkic został w formularzu. Spróbuj ponownie.');
		}
		finally { setBusy(false); }
	}

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!draft?.card) return;
		const pending = { ...draft, submission: draft.submission ?? JSON.stringify({ id: draft.id, ...draft.card,
			alternativesPl: draft.card.alternativesPl.filter(value => value.trim()),
			alternativesRu: draft.card.alternativesRu.filter(value => value.trim()),
		}) };
		try {
			sessionStorage.setItem(key, JSON.stringify(pending));
			setStorageError('');
		} catch { setStorageError('Przeglądarka nie zapisała szkicu. Zwolnij miejsce i zapisz ponownie.'); return; }
		setDraft(pending);
		setBusy(true);
		setError('');
		try {
			const card = await api<Card>('/cards', { method: 'POST', body: pending.submission });
			setDraft(null);
			setSaved(card);
		} catch (error) {
			if (error instanceof ApiError && error.code === 'card_conflict') setDraft({ ...pending, id: crypto.randomUUID(), submission: undefined });
			else if (error instanceof ApiError && (error.status === 400 || error.status === 413)) setDraft({ ...pending, submission: undefined });
			setError(error instanceof ApiError ? error.message : 'Brak połączenia z serwerem. Zapis nie został potwierdzony. Spróbuj zapisać ponownie.');
		}
		finally { setBusy(false); }
	}

	return <section className="page add" aria-labelledby="add-title" aria-busy={busy}>
		<h1 id="add-title">Dodaj słówko</h1>
		<p className="intro">Wpisz lub podyktuj słowo po polsku albo po rosyjsku.</p>
		<form onSubmit={event => { event.preventDefault(); void generate(); }}>
			<fieldset disabled={locked}>
				<label htmlFor="draft-text">Słowo lub wyrażenie</label>
				<div className="dictation">
					<input ref={input} id="draft-text" value={draft?.text ?? ''} maxLength={200} required onChange={event => change({ text: event.target.value, meaningRu: undefined, choices: [], card: undefined })} />
					{!draft?.card && <Dictation key={dictationId} language="auto" disabled={locked} onText={text => { if (input.current) change({ text: dictatedValue(input.current, text), meaningRu: undefined, choices: [], card: undefined }); }} />}
				</div>
			</fieldset>
			<aside className="similar" aria-label="Podobne słówka">{searchError ? <p className="hint" role="status">{searchError}</p>
				: !query ? <p className="hint">Tu pojawią się podobne słówka z kolekcji.</p>
				: !matches ? <p className="hint">Szukanie podobnych słówek…</p>
				: !matches.length ? <p className="hint">Brak podobnych słówek.</p>
				: <><span className="hint">Już w kolekcji:</span><ul>{matches.map(card => <li key={card.id}>
					<a href="#words" aria-disabled={busy} onClick={event => { event.preventDefault(); if (!busy) onOpen(card); }}><span lang="pl">{card.pl}</span> / <span lang="ru">{card.ru}</span></a>
				</li>)}</ul></>}</aside>
			<button className="primary" disabled={locked || !query}>Przygotuj fiszkę</button>
		</form>
		{!!draft?.choices.length && <fieldset id="draft-result" className="meaning-choices" disabled={locked}>
			<legend>Wybierz znaczenie</legend>
			{draft.choices.map(meaning => <button key={meaning} lang="ru" onClick={() => void generate(meaning)}>{meaning}</button>)}
		</fieldset>}
		{draft?.meaningRu && <p className="hint">Wybrane znaczenie: <span lang="ru">{draft.meaningRu}</span></p>}
		{draft?.submission && <p className="hint">Zapis nie został potwierdzony. Zapisz ponownie. Po potwierdzeniu fiszkę można zmienić w sekcji „Słówka”.</p>}
		{draft?.card && <form id="draft-result" onSubmit={save}>
			<h2>Sprawdź fiszkę</h2>
			<p className="hint">Po zapisaniu fiszka pojawi się u obu osób.</p>
			<fieldset disabled={locked}><CardFields value={draft.card} onChange={card => change({ card })} /></fieldset>
			<button className="primary" disabled={busy} type="submit">Zapisz</button>
		</form>}
		{error && <p className="error" role="alert">{error}</p>}
		{storageError && <p className="error" role="alert">{storageError}</p>}
		{busy && <p role="status">Proszę czekać…</p>}
		{saved && <><p role="status">Fiszka zapisana.</p><a className="word" href="#words" onClick={event => { event.preventDefault(); onOpen(saved); }}>Otwórz w „Słówkach”</a></>}
		{draft && <button className="discard" disabled={locked} onClick={() => { setDraft(null); setDictationId(value => value + 1); setError(''); setSaved(null); }}>Usuń szkic</button>}
	</section>;
}
