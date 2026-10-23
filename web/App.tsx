import { useCallback, useEffect, useState } from 'react';
import type { Card, Direction, User } from '../shared/types';
import { api, ApiError, setApiAccount } from './api';
import { Login } from './Login';
import { Words } from './Words';
import { AddWord } from './AddWord';
import { Study } from './Study';
import { Icon } from './Icon';

export function App() {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [screen, setScreen] = useState<'study' | 'words' | 'add'>('study');
	const [selectedCard, setSelectedCard] = useState<Card | null>(null);
	const expired = useCallback(() => {
		setApiAccount(null);
		setUser(null);
		setBusy(false);
		setError('');
		setScreen('study');
		setSelectedCard(null);
	}, []);
	function signedIn(user: User) {
		setApiAccount(user.id);
		setUser(user);
	}
	const directionSaved = useCallback((direction: Direction) => {
		setUser(current => current && current.direction !== direction ? { ...current, direction } : current);
	}, []);

	async function load() {
		setLoading(true);
		setError('');
		try { signedIn(await api<User>('/session')); }
		catch (error) {
			if (error instanceof ApiError && error.code === 'unauthorized') setUser(null);
			else setError('Не удалось загрузить аккаунт. Проверьте подключение и повторите.');
		} finally { setLoading(false); }
	}
	useEffect(() => {
		window.addEventListener('account-mismatch', expired);
		void load();
		return () => window.removeEventListener('account-mismatch', expired);
	}, [expired]);
	useEffect(() => { window.scrollTo(0, 0); }, [screen]);
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const root = document.documentElement;
		let frame = 0;
		function update() {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const keyboard = viewport!.scale === 1 && innerHeight - viewport!.height > 120;
				root.dataset.keyboard = String(keyboard);
				root.style.setProperty('--keyboard-inset', `${keyboard ? Math.max(0, innerHeight - viewport!.height - viewport!.offsetTop) : 0}px`);
				const field = document.activeElement;
				if (!keyboard || !(field instanceof HTMLElement) || !field.matches('input, textarea, select')) return;
				const rect = field.getBoundingClientRect();
				const top = viewport!.offsetTop + 12;
				const bottom = Math.max(top + rect.height, viewport!.offsetTop + viewport!.height - 180);
				if (rect.bottom > bottom) window.scrollBy(0, rect.bottom - bottom);
				else if (rect.top < top) window.scrollBy(0, rect.top - top);
			});
		}
		viewport.addEventListener('resize', update);
		viewport.addEventListener('scroll', update);
		document.addEventListener('focusin', update);
		return () => {
			cancelAnimationFrame(frame);
			viewport.removeEventListener('resize', update);
			viewport.removeEventListener('scroll', update);
			document.removeEventListener('focusin', update);
			delete root.dataset.keyboard;
			root.style.removeProperty('--keyboard-inset');
		};
	}, []);

	async function logout() {
		setBusy(true);
		setError('');
		try {
			await api<void>('/session', { method: 'DELETE' });
			if (user) {
				sessionStorage.removeItem(`card-draft:${user.id}`);
				sessionStorage.removeItem(`study-draft:${user.id}`);
				sessionStorage.removeItem(`word-edit:${user.id}`);
			}
			expired();
		} catch (error) {
			if (error instanceof ApiError && (error.code === 'unauthorized' || error.code === 'account_mismatch')) expired();
			else setError('Не удалось выйти. Проверьте подключение и повторите.');
		}
		finally { setBusy(false); }
	}

	return <main className={`app${user ? ' signed-in' : ''}`}>
		<header className="brand"><span lang="pl">Jak tam to słowo?</span>{user && <div className="account"><span>{user.displayName}</span><button className="quiet" aria-label="Выйти" onClick={logout} disabled={busy}><Icon name="exit" /></button></div>}</header>
		{loading ? <p role="status">Загрузка…</p> : user ? <>
			<nav className="tabs" aria-label="Разделы">
				<button aria-pressed={screen === 'study'} disabled={busy} onClick={() => setScreen('study')}><Icon name="study" />Учить</button>
				<button aria-pressed={screen === 'words'} disabled={busy} onClick={() => { setSelectedCard(null); setScreen('words'); }}><Icon name="words" />Слова</button>
				<button aria-pressed={screen === 'add'} disabled={busy} onClick={() => setScreen('add')}><Icon name="add" />Добавить</button>
			</nav>
			{screen === 'add' ? <AddWord key={user.id} userId={user.id} busy={busy} onBusy={setBusy} onExpired={expired} onOpen={card => { setSelectedCard(card); setScreen('words'); }} /> : screen === 'words' ? <Words key={user.id} userId={user.id} initialCard={selectedCard} onBusy={setBusy} onExpired={expired} /> : <Study key={user.id} user={user} onDirection={directionSaved} onBusy={setBusy} onExpired={expired} />}
		</> : !error && <Login onLogin={signedIn} />}
		{error && <div className="notice"><p className="error" role="alert">{error}</p>{!user && <button onClick={load}>Повторить</button>}</div>}
	</main>;
}
