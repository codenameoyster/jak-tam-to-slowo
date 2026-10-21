import { useEffect, useState, type FormEvent } from 'react';
import type { ConnectionView } from '../shared/types';
import { api, ApiError } from './api';

export function Settings() {
	const [connection, setConnection] = useState<ConnectionView | null>(null);
	const [url, setUrl] = useState('');
	const [address, setAddress] = useState('');
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');

	async function run(action: () => Promise<void>) {
		setBusy(true); setError(''); setNotice('');
		try { await action(); }
		catch (error) { setError(error instanceof ApiError ? error.message : 'Нет связи с сервером. Попробуйте снова.'); }
		finally { setBusy(false); }
	}
	function load() { return run(async () => setConnection(await api<ConnectionView>('/ai/connection'))); }
	useEffect(() => { void load(); }, []);

	function start() { return run(async () => {
		setAddress(''); setUrl('');
		setUrl((await api<{ url: string }>('/ai/connection/start', { method: 'POST' })).url);
	}); }
	function finish(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const submitted = address;
		setAddress(''); setUrl('');
		void run(async () => setConnection(await api<ConnectionView>('/ai/connection/finish', { method: 'POST', body: JSON.stringify({ address: submitted }) })));
	}
	function disconnect() { return run(async () => {
		setUrl(''); setAddress('');
		const result = await api<ConnectionView>('/ai/connection', { method: 'DELETE' });
		setConnection(result);
		setNotice(result.revocationConfirmed ? 'ChatGPT отключён.' : 'ChatGPT не подтвердил отключение. Удалите доступ приложения в настройках ChatGPT.');
	}); }
	function select(model: string) { return run(async () => {
		setConnection(await api<ConnectionView>('/ai/connection', { method: 'PATCH', body: JSON.stringify({ model }) }));
		setNotice('Модель сохранена.');
	}); }

	return <section className="card" aria-labelledby="settings-title" aria-busy={busy}>
		<h1 id="settings-title">Настройки</h1>
		<h2>Личный ChatGPT</h2>
		<p>Приложение использует вашу подписку ChatGPT. Тексты карточек и ответы отправляются в OpenAI. У каждого ученика своё подключение.</p>
		<p className="hint">В Plus общий лимит за пять часов действует для всех подключённых приложений. Этот лимит не действует для Pro. Возможны другие ограничения.</p>
		<p><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Использование ChatGPT</a></p>
		{connection && <>
			<p>{connection.connected ? 'ChatGPT подключён.' : 'ChatGPT не подключён.'}</p>
			{connection.accountLabel && <p className="hint">{connection.accountLabel}</p>}
			{connection.connected && <><label htmlFor="chatgpt-model">Модель</label>
				<select id="chatgpt-model" value={connection.model ?? ''} disabled={busy} onChange={event => void select(event.target.value)}>
					{connection.models.map(model => <option key={model.slug} value={model.slug}>{model.name}</option>)}
				</select></>}
			<div className="edit-actions">
				<button disabled={busy} onClick={() => void start()}>{connection.connected ? 'Подключить заново' : 'Продолжить с ChatGPT'}</button>
				{connection.connected && <button disabled={busy} onClick={() => void disconnect()}>Отключить</button>}
			</div>
		</>}
		{url && <form onSubmit={finish}>
			<ol>
				<li><a href={url} target="_blank" rel="noopener noreferrer">Открыть страницу входа ChatGPT</a></li>
				<li>Разрешите доступ. После этого браузер покажет страницу ошибки для 127.0.0.1.</li>
				<li>Скопируйте полный адрес со страницы ошибки. Вставьте его в поле ниже.</li>
			</ol>
			<label htmlFor="chatgpt-address">Адрес со страницы ошибки</label>
			<input id="chatgpt-address" type="url" autoComplete="off" spellCheck={false} maxLength={4000} required value={address} disabled={busy} onChange={event => setAddress(event.target.value)} />
			<button className="primary" disabled={busy}>Подключить</button>
		</form>}
		{busy && <p role="status">Загрузка…</p>}
		{error && <p className="error" role="alert">{error}</p>}
		{error && !connection && <button disabled={busy} onClick={() => void load()}>Повторить</button>}
		{notice && <p role="status">{notice}</p>}
	</section>;
}
