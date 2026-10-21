import { useCallback, useEffect, useState } from 'react';
import type { Card, Direction, User } from '../shared/types';
import { api, ApiError } from './api';
import { Login } from './Login';
import { Words } from './Words';
import { Settings } from './Settings';
import { AddWord } from './AddWord';
import { Study } from './Study';

export function App() {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [screen, setScreen] = useState<'study' | 'words' | 'settings' | 'add'>('study');
	const [selectedCard, setSelectedCard] = useState<Card | null>(null);
	const expired = useCallback(() => {
		setUser(null);
		setBusy(false);
		setError('');
		setScreen('study');
		setSelectedCard(null);
	}, []);
	const directionSaved = useCallback((direction: Direction) => {
		setUser(current => current && current.direction !== direction ? { ...current, direction } : current);
	}, []);

	async function load() {
		setLoading(true);
		setError('');
		try { setUser(await api<User>('/session')); }
		catch (error) {
			if (error instanceof ApiError && error.code === 'unauthorized') setUser(null);
			else setError('Не удалось загрузить аккаунт. Проверьте подключение и повторите.');
		} finally { setLoading(false); }
	}
	useEffect(() => { void load(); }, []);

	async function logout() {
		setBusy(true);
		setError('');
		try {
			await api<void>('/session', { method: 'DELETE' });
			if (user) {
				sessionStorage.removeItem(`card-draft:${user.id}`);
				sessionStorage.removeItem(`study-draft:${user.id}`);
			}
			setUser(null);
			setScreen('study');
			setSelectedCard(null);
		} catch { setError('Не удалось выйти. Проверьте подключение и повторите.'); }
		finally { setBusy(false); }
	}

	return <main className="app">
		<header className="brand"><span lang="pl">Jak tam to słowo?</span></header>
		{loading ? <p role="status">Загрузка…</p> : user ? <>
			<div className="account"><span>{user.displayName}</span><button className="quiet" onClick={logout} disabled={busy}>Выйти</button></div>
			<nav className="tabs" aria-label="Разделы">
				<button aria-pressed={screen === 'study'} disabled={busy} onClick={() => setScreen('study')}>Учить</button>
				<button aria-pressed={screen === 'words'} disabled={busy} onClick={() => { setSelectedCard(null); setScreen('words'); }}>Слова</button>
				<button aria-pressed={screen === 'add'} disabled={busy} onClick={() => setScreen('add')}>Добавить</button>
				<button aria-pressed={screen === 'settings'} disabled={busy} onClick={() => setScreen('settings')}>Настройки</button>
			</nav>
			{screen === 'settings' ? <Settings key={user.id} /> : screen === 'add' ? <AddWord key={user.id} userId={user.id} busy={busy} onBusy={setBusy} onExpired={expired} onOpen={card => { setSelectedCard(card); setScreen('words'); }} /> : screen === 'words' ? <Words key={user.id} initialCard={selectedCard} /> : <Study key={user.id} user={user} onDirection={directionSaved} onBusy={setBusy} onExpired={expired} />}
		</> : !error && <Login onLogin={setUser} />}
		{error && <div className="notice"><p className="error" role="alert">{error}</p>{!user && <button onClick={load}>Повторить</button>}</div>}
	</main>;
}
