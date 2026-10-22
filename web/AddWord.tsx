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

export function AddWord({ userId, onOpen, busy, onBusy: setBusy, onExpired }: { userId: string; onOpen(card: Card): void; busy: boolean; onBusy(busy: boolean): void; onExpired(): void }) {
	const key = `card-draft:${userId}`;
	const [draft, setDraft] = useState<Draft | null>(() => {
		try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; }
	});
	const [error, setError] = useState('');
	const [storageError, setStorageError] = useState('');
	const [saved, setSaved] = useState<Card | null>(null);
	const [matches, setMatches] = useState<Card[]>([]);
	const [searchError, setSearchError] = useState('');
	const [dictationId, setDictationId] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const query = draft?.text.trim() ?? '';
	const locked = busy || !!draft?.submission;

	useEffect(() => {
		try {
			if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
			else sessionStorage.removeItem(key);
			setStorageError('');
		} catch { setStorageError('Браузер не сохранил черновик. Скопируйте текст перед закрытием страницы.'); }
	}, [draft, key]);

	useEffect(() => {
		let cancelled = false;
		setMatches([]);
		setSearchError('');
		if (!query) return;
		const timer = setTimeout(() => {
			void api<CardPage>(`/cards?${new URLSearchParams({ q: query })}`).then(page => {
				if (!cancelled) setMatches(page.cards);
			}).catch(() => { if (!cancelled) setSearchError('Не удалось найти похожие слова. Проверьте коллекцию в разделе «Слова».'); });
		}, 250);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [query]);

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
			const result = await api<DraftResult>('/cards/draft', { method: 'POST', body: JSON.stringify({ text: draft.text, language: 'auto', meaningRu }) });
			change(result.kind === 'draft' ? { card: result.card, choices: [] } : { choices: result.choices, card: undefined });
		} catch (error) {
			if (error instanceof ApiError && error.code === 'unauthorized') onExpired();
			else setError(error instanceof ApiError ? error.message : 'Нет связи с сервером. Черновик остался в форме. Попробуйте снова.');
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
		} catch { setStorageError('Браузер не сохранил черновик. Освободите место и повторите сохранение.'); return; }
		setDraft(pending);
		setBusy(true);
		setError('');
		try {
			const card = await api<Card>('/cards', { method: 'POST', body: pending.submission });
			setDraft(null);
			setSaved(card);
		} catch (error) {
			if (error instanceof ApiError && error.code === 'unauthorized') { onExpired(); return; }
			if (error instanceof ApiError && (error.status === 400 || error.status === 413)) setDraft({ ...pending, submission: undefined });
			setError(error instanceof ApiError ? error.message : 'Нет связи с сервером. Сохранение не подтверждено. Попробуйте сохранить ещё раз.');
		}
		finally { setBusy(false); }
	}

	return <section className="card" aria-labelledby="add-title" aria-busy={busy}>
		<h1 id="add-title">Добавить слово</h1>
		<p className="intro">Введите или продиктуйте слово по-польски или по-русски.</p>
		<p className="intro">Подготовьте карточку, проверьте текст и сохраните её в общей коллекции.</p>
		<form onSubmit={event => { event.preventDefault(); void generate(); }}>
			<fieldset disabled={locked}>
				<label htmlFor="draft-text">Слово или выражение</label>
				<input ref={input} id="draft-text" value={draft?.text ?? ''} maxLength={200} required onChange={event => change({ text: event.target.value, meaningRu: undefined, choices: [], card: undefined })} />
			</fieldset>
			<Dictation key={dictationId} language="auto" disabled={locked} onExpired={onExpired} onText={text => { if (input.current) change({ text: dictatedValue(input.current, text), meaningRu: undefined, choices: [], card: undefined }); }} />
			<button disabled={locked || !query}>Подготовить карточку</button>
		</form>
		{searchError && <p className="hint" role="status">{searchError}</p>}
		{!!matches.length && <aside aria-label="Похожие слова">
			<h2>Похожие слова</h2>
			<ul className="words-list">{matches.map(card => <li key={card.id}>
				<a className="word" href="#words" aria-disabled={busy} onClick={event => { event.preventDefault(); if (!busy) onOpen(card); }}><span lang="pl">{card.pl}</span> / <span lang="ru">{card.ru}</span></a>
				<p className="hint">{card.meaningRu}</p>
			</li>)}</ul>
		</aside>}
		{!!draft?.choices.length && <fieldset className="meaning-choices" disabled={locked}>
			<legend>Выберите значение</legend>
			{draft.choices.map(meaning => <button key={meaning} onClick={() => void generate(meaning)}>{meaning}</button>)}
		</fieldset>}
		{draft?.meaningRu && <p className="hint">Выбрано значение: {draft.meaningRu}</p>}
		{draft?.submission && <p className="hint">Сохранение не подтверждено. Повторите сохранение. После подтверждения карточку можно изменить в разделе «Слова».</p>}
		{draft?.card && <form onSubmit={save}>
			<h2>Проверьте карточку</h2>
			<p className="hint">Карточка появится у обоих учеников после сохранения.</p>
			<fieldset disabled={locked}><CardFields value={draft.card} onChange={card => change({ card })} /></fieldset>
			<button className="primary" disabled={busy} type="submit">Сохранить</button>
		</form>}
		{error && <p className="error" role="alert">{error}</p>}
		{storageError && <p className="error" role="alert">{storageError}</p>}
		{busy && <p role="status">Подождите…</p>}
		{saved && <><p role="status">Карточка сохранена.</p><a className="word" href="#words" onClick={event => { event.preventDefault(); onOpen(saved); }}>Открыть в «Словах»</a></>}
		{draft && <button className="discard" disabled={locked} onClick={() => { setDraft(null); setDictationId(value => value + 1); setError(''); setSaved(null); }}>Удалить черновик</button>}
	</section>;
}
