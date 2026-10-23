import { useState, type FormEvent } from 'react';
import type { User } from '../shared/types';
import { api, ApiError } from './api';

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setBusy(true);
		setError('');
		try {
			onLogin(await api<User>('/session', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }));
		} catch (error) {
			setError(error instanceof ApiError ? error.message : 'Нет связи с сервером. Проверьте подключение и повторите вход.');
		} finally { setBusy(false); }
	}

	return <section className="login" aria-labelledby="login-title">
		<span className="app-icon" aria-hidden="true">Ł</span>
		<h1 id="login-title">Польские слова</h1>
		<p className="intro">Войдите в свой аккаунт, чтобы продолжить.</p>
		<form onSubmit={submit}>
			<label htmlFor="username">Имя пользователя</label>
			<input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={40} required />
			<label htmlFor="password">Пароль</label>
			<input id="password" name="password" type="password" autoComplete="current-password" maxLength={256} required />
			{error && <p className="error" role="alert">{error}</p>}
			<button className="primary" type="submit" disabled={busy}>{busy ? 'Вход…' : 'Войти'}</button>
		</form>
	</section>;
}
