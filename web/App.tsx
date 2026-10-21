import { useEffect, useState } from 'react';
import type { Direction, User } from '../shared/types';
import { api, ApiError } from './api';
import { Login } from './Login';

export function App() {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	async function load() {
		setLoading(true);
		setError('');
		try { setUser(await api<User>('/session')); }
		catch (error) {
			if (error instanceof ApiError && error.status === 401) setUser(null);
			else setError('Не удалось загрузить аккаунт. Проверьте подключение и повторите.');
		} finally { setLoading(false); }
	}
	useEffect(() => { void load(); }, []);

	async function saveDirection(direction: Direction) {
		setBusy(true);
		setError('');
		try { setUser(await api<User>('/me', { method: 'PATCH', body: JSON.stringify({ direction }) })); }
		catch (error) {
			if (error instanceof ApiError && error.status === 401) setUser(null);
			else setError('Не удалось сохранить направление. Попробуйте снова.');
		} finally { setBusy(false); }
	}

	async function logout() {
		setBusy(true);
		setError('');
		try {
			await api<void>('/session', { method: 'DELETE' });
			setUser(null);
		} catch { setError('Не удалось выйти. Проверьте подключение и повторите.'); }
		finally { setBusy(false); }
	}

	return <main className="app">
		<header className="brand"><span lang="pl">Jak tam to słowo?</span></header>
		{loading ? <p role="status">Загрузка…</p> : user ? <>
			<div className="account"><span>{user.displayName}</span><button className="quiet" onClick={logout} disabled={busy}>Выйти</button></div>
			<section className="card" aria-labelledby="direction-title">
				<h1 id="direction-title">Направление перевода</h1>
				<p className="intro">Выберите, какие слова хотите вспомнить.</p>
				<div className="directions" role="group" aria-label="Направление перевода">
					<button aria-label="RU -> PL" aria-pressed={user.direction === 'ru-pl'} disabled={busy} onClick={() => saveDirection('ru-pl')}>{'RU -> PL'}</button>
					<button aria-label="PL -> RU" aria-pressed={user.direction === 'pl-ru'} disabled={busy} onClick={() => saveDirection('pl-ru')}>{'PL -> RU'}</button>
				</div>
				<p className="translation">{user.direction === 'ru-pl' ? 'С русского на польский' : 'С польского на русский'}</p>
				<p className="saved" role="status">{busy ? 'Сохранение…' : 'Направление сохранено в вашем аккаунте.'}</p>
			</section>
		</> : !error && <Login onLogin={setUser} />}
		{error && <div className="notice"><p className="error" role="alert">{error}</p>{!user && <button onClick={load}>Повторить</button>}</div>}
	</main>;
}
