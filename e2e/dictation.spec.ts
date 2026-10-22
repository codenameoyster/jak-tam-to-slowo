import { expect, test, type Page } from '@playwright/test';
import type { CardPage, ReviewInput } from '../shared/types';
import { CARD_A, CARD_B, USER_A } from '../test/fixtures';

interface AudioTest {
	checked: string[]; selected: string[]; activeTracks: number; stopCalls: number; requests: number;
	upload?: { fields: string[]; language: FormDataEntryValue | null; type: string; bytes: number[] };
	grant(): void; fail(): void; oversize(): void;
}
declare global { interface Window { audioTest: AudioTest } }

async function media(page: Page, options: { supported?: string[]; denied?: boolean; delayed?: boolean; constructorError?: boolean; startError?: boolean; size?: number; bytes?: number[] } = {}) {
	await page.addInitScript(options => {
		const state: AudioTest = window.audioTest = { checked: [], selected: [], activeTracks: 0, stopCalls: 0, requests: 0, grant() {}, fail() {}, oversize() {} };
		const fetch = window.fetch;
		Object.defineProperty(window, 'fetch', { value: async (url: RequestInfo | URL, init?: RequestInit) => {
			if (String(url).endsWith('/dictation')) {
				const form = await new Response(init?.body, { headers: init?.headers }).formData();
				const clip = form.get('clip');
				if (!(clip instanceof File)) throw new Error('Missing clip.');
				state.upload = { fields: [...form.keys()].sort(), language: form.get('language'), type: clip.type, bytes: [...new Uint8Array(await clip.arrayBuffer())] };
			}
			return fetch(url, init);
		} });
		function stream() {
			state.activeTracks += 2;
			const tracks = Array.from({ length: 2 }, () => {
				let stopped = false;
				return { stop() { if (!stopped) { stopped = true; state.activeTracks--; } } };
			});
			return { getTracks: () => tracks };
		}
		Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
			state.requests++;
			if (options.denied) throw new DOMException('Denied', 'NotAllowedError');
			if (options.delayed) return new Promise(resolve => { state.grant = () => resolve(stream()); });
			return stream();
		} });
		class Recorder extends EventTarget {
			state = 'inactive';
			mimeType: string;
			ondataavailable: ((event: { data: Blob }) => void) | null = null;
			onstop: (() => void) | null = null;
			onerror: (() => void) | null = null;
			static isTypeSupported(type: string) {
				state.checked.push(type);
				return (options.supported ?? ['audio/webm;codecs=opus']).includes(type);
			}
			constructor(_stream: unknown, options: MediaRecorderOptions) {
				super();
				this.mimeType = options.mimeType!;
				if (!state.checked.includes(this.mimeType)) throw new Error('The format was not checked.');
				state.selected.push(this.mimeType);
				state.fail = () => this.onerror?.();
				state.oversize = () => this.ondataavailable?.({ data: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]) });
			}
			start() { this.state = 'recording'; }
			stop() {
				if (this.state === 'inactive') throw new Error('Already stopped.');
				this.state = 'inactive';
				state.stopCalls++;
				queueMicrotask(() => {
					this.ondataavailable?.({ data: new Blob([options.size === undefined ? new Uint8Array(options.bytes ?? [0, 1, 254, 255]) : new Uint8Array(options.size)], { type: this.mimeType }) });
					this.onstop?.();
				});
			}
		}
		if (options.startError) Recorder.prototype.start = () => { throw new Error('Recorder start failed.'); };
		Object.defineProperty(window, 'MediaRecorder', { value: options.constructorError ? class extends Recorder {
			constructor(stream: unknown, options: MediaRecorderOptions) { super(stream, options); throw new Error('Recorder construction failed.'); }
		} : Recorder });
	}, options);
}

let headers: Record<string, string>;
test.beforeEach(async ({ page, baseURL }) => {
	headers = { Origin: baseURL!, 'CF-Connecting-IP': `dictation-${crypto.randomUUID()}` };
	await page.setExtraHTTPHeaders(headers);
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await page.request.patch('/api/me', { headers, data: { direction: 'ru-pl' } })).status()).toBe(200);
	const list: CardPage = await (await page.request.get('/api/cards')).json();
	for (const card of list.cards) expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { version: card.version, archived: true } })).status()).toBe(200);
	expect((await page.request.post('/api/cards', { headers, data: { ...CARD_A, id: crypto.randomUUID() } })).status()).toBe(201);
	expect((await page.request.post('/api/cards', { headers, data: { ...CARD_B, id: crypto.randomUUID() } })).status()).toBe(201);
});

test.afterEach(async ({ page }) => {
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	const list: CardPage = await (await page.request.get('/api/cards')).json();
	for (const card of list.cards) expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { version: card.version, archived: true } })).status()).toBe(200);
});

async function start(page: Page) {
	await expect(page.getByRole('button', { name: 'Диктовать', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Диктовать', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Завершить запись', exact: true })).toBeVisible();
}

for (const scenario of [
	{ name: 'Add selected retry', screen: 'add', initial: 'Żyla', edited: null, start: 0, end: 4, transcript: 'źle', expected: 'źle' },
	{ name: 'Study selected retry', screen: 'study', initial: 'Żyla', edited: null, start: 0, end: 4, transcript: 'źle', expected: 'źle' },
	{ name: 'Add delayed partial selection', screen: 'add', initial: 'Żyla', edited: 'To Żyla słowo.', start: 3, end: 7, transcript: 'źle', expected: 'To źle słowo.' },
	{ name: 'Study delayed partial selection', screen: 'study', initial: 'Żyla', edited: 'To Żyla słowo.', start: 3, end: 7, transcript: 'źle', expected: 'To źle słowo.' },
	{ name: 'Add delayed collapsed selection', screen: 'add', initial: 'typed', edited: 'typed during transcription', start: 2, end: 2, transcript: 'słowo', expected: 'typed during transcription słowo' },
	{ name: 'Study delayed collapsed selection', screen: 'study', initial: 'typed', edited: 'typed during transcription', start: 2, end: 2, transcript: 'słowo', expected: 'typed during transcription słowo' },
]) test(`uses the current field for ${scenario.name} and submits the displayed text`, async ({ page }) => {
	await media(page);
	await page.route('**/api/dictation', route => route.fulfill({ json: { text: scenario.initial } }));
	await page.goto('/');
	if (scenario.screen === 'add') await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	const input = page.getByLabel(scenario.screen === 'add' ? 'Слово или выражение' : 'Ответ по-польски');
	await start(page);
	await page.getByRole('button', { name: 'Завершить запись', exact: true }).click();
	await expect(input).toHaveValue(scenario.initial);
	await input.selectText();
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/dictation', async route => { received.resolve(); await release.promise; await route.fulfill({ json: { text: scenario.transcript } }); });
	await start(page);
	await page.getByRole('button', { name: 'Завершить запись', exact: true }).click();
	await received.promise;
	try {
		await expect(input).toBeEnabled();
		if (scenario.edited !== null) {
			await input.fill(scenario.edited);
			await input.evaluate((field, range) => (field as HTMLInputElement).setSelectionRange(range.start, range.end), scenario);
		}
	} finally { release.resolve(); }
	await expect(input).toHaveValue(scenario.expected);
	const submitted = page.waitForRequest(request => request.url().endsWith(scenario.screen === 'add' ? '/api/cards/draft' : '/api/reviews'));
	await page.getByRole('button', { name: scenario.screen === 'add' ? 'Подготовить карточку' : 'Проверить', exact: true }).click();
	expect((await submitted).postDataJSON()).toMatchObject(scenario.screen === 'add'
		? { text: scenario.expected, language: 'auto' }
		: { action: 'answer', answer: scenario.expected, direction: 'ru-pl' });
});

for (const scenario of [
	{ name: 'Add Polish with WebM/Opus', screen: 'add', language: 'auto', legacy: null, bytes: [0, 1, 254, 255], type: 'audio/webm;codecs=opus', label: 'Слово или выражение', transcript: 'słowo' },
	{ name: 'Add Russian with MP4/AAC', screen: 'add', language: 'auto', legacy: null, bytes: [1, 2, 253, 254], type: 'audio/mp4;codecs=mp4a.40.2', label: 'Слово или выражение', transcript: 'слово' },
	{ name: 'Add with the MP4 default codec', screen: 'add', language: 'auto', legacy: null, bytes: [0, 1, 254, 255], type: 'audio/mp4', label: 'Слово или выражение', transcript: 'słowo' },
	{ name: 'Add Russian with a restored Polish draft', screen: 'add', language: 'auto', legacy: 'pl', bytes: [1, 2, 253, 254], type: 'audio/webm;codecs=opus', label: 'Слово или выражение', transcript: 'слово' },
	{ name: 'Add Polish with a restored Russian draft', screen: 'add', language: 'auto', legacy: 'ru', bytes: [0, 1, 254, 255], type: 'audio/mp4', label: 'Слово или выражение', transcript: 'słowo' },
	{ name: 'Study Polish target', screen: 'study', language: 'pl', legacy: null, bytes: [0, 1, 254, 255], type: 'audio/webm;codecs=opus', label: 'Ответ по-польски', transcript: 'słowo' },
	{ name: 'Study Russian target independent of Add', screen: 'study', language: 'ru', legacy: null, bytes: [0, 1, 254, 255], type: 'audio/webm;codecs=opus', label: 'Ответ по-русски', transcript: 'слово' },
]) test(`inserts editable text for ${scenario.name} and sends only the language mode and clip`, async ({ page }) => {
	await media(page, { supported: [scenario.type], bytes: scenario.bytes });
	await page.goto('/');
	if (scenario.screen === 'add') {
		if (scenario.legacy) await page.evaluate(({ key, language }) => sessionStorage.setItem(key, JSON.stringify({ id: crypto.randomUUID(), text: 'restored', language, choices: [] })), { key: `card-draft:${USER_A.id}`, language: scenario.legacy });
		await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	} else if (scenario.language === 'ru') await page.getByLabel('PL -> RU', { exact: true }).click();
	const input = page.getByLabel(scenario.label);
	await input.fill('typed');
	await start(page);
	await input.fill('typed while recording');
	const uploaded = page.waitForResponse(response => response.url().endsWith('/api/dictation'));
	await page.getByRole('button', { name: 'Завершить запись', exact: true }).click();
	const response = await uploaded;
	expect(await page.evaluate(() => window.audioTest.upload)).toEqual({ fields: ['clip', 'language'], language: scenario.language, type: scenario.type, bytes: scenario.bytes });
	expect(response.status()).toBe(200);
	await expect(input).toHaveValue(`typed while recording ${scenario.transcript}`);
	await expect(input).toBeEnabled();
	await input.fill(`${scenario.transcript} edited`);
	expect(await page.evaluate(() => ({ selected: window.audioTest.selected, activeTracks: window.audioTest.activeTracks }))).toEqual({ selected: [scenario.type], activeTracks: 0 });
	if (scenario.screen === 'add') {
		await expect(page.getByLabel('Язык ввода')).toHaveCount(0);
		const generated = page.waitForRequest(request => request.url().endsWith('/api/cards/draft'));
		await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
		expect((await generated).postDataJSON()).toMatchObject({ text: `${scenario.transcript} edited`, language: scenario.language });
	} else {
		await page.getByRole('button', { name: 'Добавить', exact: true }).click();
		await expect(page.getByLabel('Язык ввода')).toHaveCount(0);
	}
});

test('stops at 30 seconds, releases all tracks, and prevents overlapping transcription', async ({ page }) => {
	await media(page);
	await page.clock.install();
	await page.goto('/');
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/dictation', async route => { received.resolve(); await release.promise; await route.fulfill({ json: { text: 'słowo' } }); });
	await start(page);
	await page.clock.fastForward(30_000);
	await received.promise;
	try {
		expect(await page.evaluate(() => ({ stops: window.audioTest.stopCalls, tracks: window.audioTest.activeTracks }))).toEqual({ stops: 1, tracks: 0 });
		await expect(page.getByRole('button', { name: 'Диктовать', exact: true })).toBeDisabled();
		await expect(page.getByLabel('Ответ по-польски')).toBeEnabled();
		await page.getByLabel('Ответ по-польски').fill('typed during transcription');
	} finally { release.resolve(); }
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('typed during transcription słowo');
});

test('keeps an overlong dictated Study answer editable across reload until it is corrected', async ({ page }) => {
	await media(page);
	const reviews: ReviewInput[] = [];
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) reviews.push(request.postDataJSON()); });
	await page.goto('/');
	await page.getByLabel('PL -> RU', { exact: true }).click();
	const input = page.getByLabel('Ответ по-русски');
	const typed = 'слово '.repeat(83), combined = `${typed} слово`;
	await input.fill(typed);
	await start(page);
	await page.getByRole('button', { name: 'Завершить запись', exact: true }).click();
	await expect(input).toHaveValue(combined);
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await expect(page.getByRole('alert')).toBeVisible();
	expect(reviews).toEqual([]);
	await expect(page.getByRole('alert')).toContainText('Сократите ответ до 500 символов');
	await expect(input).toBeEnabled();
	await expect(input).toHaveValue(combined);
	expect(await page.evaluate(id => JSON.parse(sessionStorage.getItem(`study-draft:${id}`)!), USER_A.id)).toMatchObject({ answer: combined, pending: null });
	await page.reload();
	await expect(input).toHaveValue(combined);
	await expect(input).toBeEnabled();
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Сократите ответ до 500 символов');
	expect(reviews).toEqual([]);
	await input.fill('Слово');
	const saved = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	expect((await saved).status()).toBe(200);
	expect(reviews).toHaveLength(1);
	expect(reviews[0]).toMatchObject({ action: 'answer', answer: 'Слово' });
	await expect(page.getByTestId('study-correction')).toHaveText('Слово');
	await expect(page.getByRole('status').filter({ hasText: 'Верно' })).toBeVisible();
});

for (const scenario of [
	{ name: 'cancel', change: 'cancel' },
	{ name: 'tab unmount', change: 'tab' },
	{ name: 'Study direction change', change: 'direction' },
	{ name: 'draft removal', change: 'discard' },
	{ name: 'page hidden', change: 'hidden' },
	{ name: 'page exit', change: 'pagehide' },
	{ name: 'logout', change: 'logout' },
]) test(`releases recording tracks on ${scenario.name} without uploading`, async ({ page }) => {
	await media(page);
	await page.goto('/');
	if (scenario.change !== 'direction') await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel(scenario.change === 'direction' ? 'Ответ по-польски' : 'Слово или выражение').fill('typed');
	let uploads = 0;
	page.on('request', request => { if (request.url().endsWith('/api/dictation')) uploads++; });
	await start(page);
	if (scenario.change === 'cancel') await page.getByRole('button', { name: 'Отменить диктовку', exact: true }).click();
	if (scenario.change === 'tab') await page.getByRole('button', { name: 'Учить', exact: true }).click();
	if (scenario.change === 'direction') { page.once('dialog', dialog => dialog.accept()); await page.getByLabel('PL -> RU', { exact: true }).click(); }
	if (scenario.change === 'discard') await page.getByRole('button', { name: 'Удалить черновик', exact: true }).click();
	if (scenario.change === 'hidden') await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
	if (scenario.change === 'pagehide') await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
	if (scenario.change === 'logout') { await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible(); }
	expect(await page.evaluate(() => ({ stops: window.audioTest.stopCalls, tracks: window.audioTest.activeTracks }))).toEqual({ stops: 1, tracks: 0 });
	expect(uploads).toBe(0);
});

test('releases permission granted after a Study direction change and does not start an old recording', async ({ page }) => {
	await media(page, { delayed: true });
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Диктовать', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Диктовать', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Диктовать', exact: true })).toBeDisabled();
	await page.getByLabel('PL -> RU', { exact: true }).click();
	await page.evaluate(() => window.audioTest.grant());
	expect(await page.evaluate(() => ({ tracks: window.audioTest.activeTracks, selected: window.audioTest.selected, requests: window.audioTest.requests }))).toEqual({ tracks: 0, selected: [], requests: 1 });
	await expect(page.getByRole('button', { name: 'Диктовать', exact: true })).toBeEnabled();
});

for (const scenario of [
	{ name: 'microphone denial', options: { denied: true }, event: '', message: /микрофон/ },
	{ name: 'unsupported recording formats', options: { supported: [] }, event: '', message: /формат/ },
	{ name: 'recorder construction failure', options: { constructorError: true }, event: '', message: /запис/ },
	{ name: 'recorder start failure', options: { startError: true }, event: '', message: /запис/ },
	{ name: 'recorder error', options: {}, event: 'error', message: /запис/ },
	{ name: 'oversized recording', options: {}, event: 'oversize', message: /коротк/ },
	{ name: 'oversized multipart envelope', options: { size: 2 * 1024 * 1024 - 1 }, event: 'finish', message: /коротк/ },
	{ name: 'empty recording', options: { size: 0 }, event: 'finish', message: /пустая/ },
]) test(`keeps typing available and releases tracks after ${scenario.name}`, async ({ page }) => {
	await media(page, scenario.options);
	await page.goto('/');
	const input = page.getByLabel('Ответ по-польски');
	await input.fill('typed');
	await expect(page.getByRole('button', { name: 'Диктовать', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Диктовать', exact: true }).click();
	if (scenario.event) {
		await expect(page.getByRole('button', { name: 'Завершить запись', exact: true })).toBeVisible();
		if (scenario.event === 'finish') await page.getByRole('button', { name: 'Завершить запись', exact: true }).click();
		else await page.evaluate(event => { if (event === 'error') window.audioTest.fail(); else window.audioTest.oversize(); }, scenario.event);
	}
	await expect(page.getByRole('alert')).toContainText(scenario.message);
	await expect(input).toHaveValue('typed');
	await input.fill('still typing');
	expect(await page.evaluate(() => window.audioTest.activeTracks)).toBe(0);
});

for (const scenario of [
	{ name: 'Add draft is removed', screen: 'add', change: 'discard' },
	{ name: 'Add generation locks and unlocks the input', screen: 'add', change: 'generate' },
	{ name: 'Study direction changes', screen: 'study', change: 'direction' },
	{ name: 'Study submission is frozen', screen: 'study', change: 'check' },
	{ name: 'Study advances to a different card', screen: 'study', change: 'next' },
]) test(`discards a late transcript when ${scenario.name}`, async ({ page }) => {
	await media(page);
	await page.goto('/');
	if (scenario.screen === 'add') await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	const input = page.getByLabel(scenario.screen === 'add' ? 'Слово или выражение' : 'Ответ по-польски');
	await input.fill('typed');
	await input.selectText();
	// Complete the old response even if cancellation aborts its fetch.
	await page.evaluate(() => {
		const fetch = window.fetch;
		Object.defineProperty(window, 'fetch', { value: (url: RequestInfo | URL, init?: RequestInit) => fetch(url, String(url).endsWith('/dictation') ? { ...init, signal: undefined } : init) });
	});
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/dictation', async route => { received.resolve(); await release.promise; await route.fulfill({ json: { text: 'late transcript' } }); });
	await start(page);
	await page.getByRole('button', { name: 'Завершить запись', exact: true }).click();
	await received.promise;
	try {
		if (scenario.change === 'discard') await page.getByRole('button', { name: 'Удалить черновик', exact: true }).click();
		if (scenario.change === 'generate') {
			await page.route('**/api/cards/draft', route => route.fulfill({ status: 503, json: { error: 'Повторите запрос.', code: 'ai_interrupted' } }));
			await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
			await expect(page.getByRole('alert')).toContainText('Повторите запрос.');
		}
		if (scenario.change === 'direction') { page.once('dialog', dialog => dialog.accept()); await page.getByLabel('PL -> RU', { exact: true }).click(); await expect(page.getByLabel('Ответ по-русски')).toBeVisible(); }
		if (scenario.change === 'check') {
			await page.route('**/api/reviews', route => route.abort());
			await page.getByRole('button', { name: 'Проверить', exact: true }).click();
			await expect(input).toBeDisabled();
			await expect(page.getByRole('alert')).toContainText('не подтверждено');
		}
		if (scenario.change === 'next') {
			await page.getByRole('button', { name: 'Показать ответ', exact: true }).click();
			await page.getByRole('button', { name: 'Дальше', exact: true }).click();
			await expect(page.getByTestId('study-term')).toHaveText('Дом');
		}
	} finally { release.resolve(); }
	await page.waitForResponse(response => response.url().endsWith('/api/dictation'));
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	const resultInput = scenario.change === 'direction' ? page.getByLabel('Ответ по-русски') : input;
	await expect(resultInput).toHaveValue(['discard', 'direction', 'next'].includes(scenario.change) ? '' : 'typed');
	if (scenario.change === 'check') {
		const stored = await page.evaluate(id => JSON.parse(sessionStorage.getItem(`study-draft:${id}`)!).pending, USER_A.id);
		expect((JSON.parse(stored) as ReviewInput)).toMatchObject({ action: 'answer', answer: 'typed' });
	}
});

test('keeps text editable after a transcription service error', async ({ page }) => {
	await media(page);
	await page.route('**/api/dictation', route => route.fulfill({ status: 422, json: { code: 'no_speech', error: 'Речь не распознана. Повторите запись или введите текст.' } }));
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill('typed');
	await start(page);
	await page.getByRole('button', { name: 'Завершить запись', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Повторите запись');
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('typed');
	await page.getByLabel('Ответ по-польски').fill('corrected');
	expect(await page.evaluate(() => window.audioTest.activeTracks)).toBe(0);
});

for (const scenario of [
	{ name: 'Add', label: 'Слово или выражение', key: 'card-draft' },
	{ name: 'Study', label: 'Ответ по-польски', key: 'study-draft' },
]) test(`returns to login on session expiry and retains ${scenario.name} text`, async ({ page }) => {
	await media(page);
	await page.goto('/');
	if (scenario.name === 'Add') await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel(scenario.label).fill('typed');
	await start(page);
	expect((await page.request.delete('/api/session', { headers })).status()).toBe(204);
	await page.getByRole('button', { name: 'Завершить запись', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
	expect(await page.evaluate(key => sessionStorage.getItem(key), `${scenario.key}:${USER_A.id}`)).toContain('typed');
	expect(await page.evaluate(() => window.audioTest.activeTracks)).toBe(0);
});
