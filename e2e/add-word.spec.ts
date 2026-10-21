import { expect, test, type Page } from '@playwright/test';
import type { CardPage } from '../shared/types';
import { USER_A, USER_B, WORD_DRAFT } from '../test/fixtures';

let createdIds: string[];
test.beforeEach(async ({ page, baseURL }) => {
	createdIds = [];
	const headers = { Origin: baseURL!, 'CF-Connecting-IP': `add-${crypto.randomUUID()}` };
	await page.setExtraHTTPHeaders(headers);
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	const start = await page.request.post('/api/ai/connection/start', { headers });
	const url = new URL((await start.json()).url);
	const callback = new URL(url.searchParams.get('redirect_uri')!);
	callback.search = new URLSearchParams({ code: `a:${url.searchParams.get('nonce')}`, state: url.searchParams.get('state')!, client_id: 'oaiapp_a' }).toString();
	expect((await page.request.post('/api/ai/connection/finish', { headers, data: { address: callback.href } })).status()).toBe(200);
	await page.goto('/');
});

test.afterEach(async ({ page, baseURL }) => {
	const headers = { Origin: baseURL! };
	const list: CardPage = await (await page.request.get('/api/cards')).json();
	for (const card of list.cards.filter(card => createdIds.includes(card.id))) {
		expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { version: card.version, archived: true } })).status()).toBe(200);
	}
	expect((await page.request.delete('/api/ai/connection', { headers })).status()).toBe(200);
});

async function loginForm(page: Page, user: typeof USER_A) {
	await page.getByLabel('Имя пользователя').fill(user.username);
	await page.getByLabel('Пароль', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

test('keeps an uncertain Save retry-only across reload and opens confirmed edits in Words', async ({ page, baseURL }) => {
	const seedId = crypto.randomUUID();
	expect((await page.request.post('/api/cards', { headers: { Origin: baseURL! }, data: { id: seedId, ...WORD_DRAFT } })).status()).toBe(201);
	createdIds.push(seedId);
	const before = (await (await page.request.get('/api/cards')).json()).cards.length;
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel('Язык ввода').selectOption('pl');
	await page.getByLabel('Слово или выражение').fill('słowo');
	await page.getByRole('link', { name: 'Słowo / Слово', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Слова', exact: true })).toBeVisible();
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveValue('Słowo');
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('słowo');
	await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('Nie znam tego słowa.');
	await expect(page.getByLabel('Пример по-русски')).toHaveValue('Я не знаю этого слова.');
	expect((await (await page.request.get('/api/cards')).json()).cards).toHaveLength(before);
	await page.getByLabel('По-русски', { exact: true }).fill('Моё слово');
	await page.getByLabel('Пример по-польски').fill('To moje słowo.');
	await page.getByLabel('Другие ответы по-польски').fill('Wyraz\n\n');
	let savedId = '';
	let submittedBody = '', storedBody: string | undefined;
	await page.route('**/api/cards', async route => {
		savedId = route.request().postDataJSON().id;
		submittedBody = route.request().postData()!;
		storedBody = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).submission, `card-draft:${USER_A.id}`);
		createdIds.push(savedId);
		expect((await route.fetch()).status()).toBe(201);
		await route.abort();
	});
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Нет связи с сервером');
	await expect(page.getByLabel('По-русски', { exact: true })).toHaveValue('Моё слово');
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('To moje słowo.');
	await expect(page.getByLabel('По-русски', { exact: true })).toBeDisabled();
	await expect(page.getByLabel('Пример по-польски')).toBeDisabled();
	await expect(page.getByLabel('Другие ответы по-польски')).toBeDisabled();
	await expect(page.getByLabel('Слово или выражение')).toBeDisabled();
	await expect(page.getByLabel('Язык ввода')).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Подготовить карточку', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Удалить черновик', exact: true })).toBeDisabled();
	expect(storedBody).toBe(submittedBody);
	await page.unroute('**/api/cards');
	await page.reload();
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('По-русски', { exact: true })).toHaveValue('Моё слово');
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('To moje słowo.');
	await expect(page.getByLabel('По-русски', { exact: true })).toBeDisabled();
	await expect(page.getByLabel('Пример по-польски')).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Подготовить карточку', exact: true })).toBeDisabled();
	const retry = page.waitForResponse(response => response.url().endsWith('/api/cards') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	expect((await retry).status()).toBe(200);
	expect((await retry).request().postDataJSON().id).toBe(savedId);
	expect((await retry).request().postData()).toBe(submittedBody);
	await expect(page.getByRole('status')).toContainText('Карточка сохранена.');
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('');
	const cards = (await (await page.request.get('/api/cards')).json()).cards;
	expect(cards).toHaveLength(before + 1);
	expect(cards.find((card: { id: string }) => card.id === savedId)).toMatchObject({ ru: 'Моё слово', examplePl: 'To moje słowo.', alternativesPl: ['Wyraz'], version: 1, createdBy: USER_A.id });
	expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
	await page.getByRole('link', { name: 'Открыть в «Словах»', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Слова', exact: true })).toBeVisible();
	await page.getByLabel('Пример по-польски').fill('Znam to słowo.');
	const edit = page.waitForResponse(response => response.url().endsWith(`/api/cards/${savedId}`) && response.request().method() === 'PATCH');
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	expect((await edit).status()).toBe(200);
	const updated: CardPage = await (await page.request.get('/api/cards')).json();
	expect(updated.cards).toHaveLength(before + 1);
	expect(updated.cards.find(card => card.id === savedId)).toMatchObject({ examplePl: 'Znam to słowo.', version: 2 });
});

test('recovers the selected meaning until logout and keeps input language separate from study direction', async ({ page }) => {
	await page.getByRole('button', { name: 'PL -> RU', exact: true }).click();
	await page.getByRole('button', { name: 'Слова', exact: true }).click();
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel('Язык ввода').selectOption('ru');
	await page.getByLabel('Слово или выражение').fill('лук');
	await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Овощ', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Оружие для стрельбы стрелами', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Овощ', exact: true }).click();
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveValue('Cebula');
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('Kroję cebulę.');
	await page.getByRole('button', { name: 'Учить', exact: true }).click();
	await page.getByRole('button', { name: 'RU -> PL', exact: true }).click();
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Язык ввода')).toHaveValue('ru');
	await page.reload();
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveValue('Cebula');
	await expect(page.getByText('Выбрано значение: Овощ', { exact: true })).toBeVisible();
	await page.screenshot({ path: '.wrangler/playwright/add-preview-mobile.png', fullPage: true });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.getByRole('button', { name: 'Выйти', exact: true }).click();
	await loginForm(page, USER_B);
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('');
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveCount(0);
	await page.getByLabel('Слово или выражение').fill('dom');
	await page.reload();
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('dom');
	await page.getByRole('button', { name: 'Выйти', exact: true }).click();
	await loginForm(page, USER_A);
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('');
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveCount(0);
	await page.reload();
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveCount(0);
	const keys = await page.evaluate(() => Object.keys(sessionStorage));
	expect(keys.some(key => key.includes(USER_A.id))).toBe(false);
	expect(keys.some(key => key.includes(USER_B.id))).toBe(false);
});

test('retains an Add draft after session expiry only for the original account', async ({ page, baseURL }) => {
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel('Слово или выражение').fill('личный черновик');
	expect((await page.request.delete('/api/session', { headers: { Origin: baseURL! } })).status()).toBe(204);
	await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
	await loginForm(page, USER_B);
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('');
	await page.getByRole('button', { name: 'Выйти', exact: true }).click();
	await loginForm(page, USER_A);
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('личный черновик');
});

test('retains input on provider authentication failure and retains edits on a rejected Save', async ({ page }) => {
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel('Язык ввода').selectOption('ru');
	await page.getByLabel('Слово или выражение').fill('ошибка подключения');
	const rejected = page.waitForResponse(response => response.url().endsWith('/api/cards/draft'));
	await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
	expect((await rejected).status()).toBe(401);
	await expect(page.getByRole('alert')).toContainText('ChatGPT не принял подключение');
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('ошибка подключения');
	await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
	await page.getByLabel('Язык ввода').selectOption('pl');
	await page.getByLabel('Слово или выражение').fill('słowo');
	await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
	await page.getByLabel('Значение', { exact: true }).fill(' ');
	await page.getByLabel('Пример по-русски').fill('Я не знаю этого слова.');
	const save = page.waitForResponse(response => response.url().endsWith('/api/cards') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	expect((await save).status()).toBe(400);
	await expect(page.getByRole('alert')).toContainText('Проверьте текстовые поля.');
	await expect(page.getByLabel('Значение', { exact: true })).toHaveValue(' ');
	await expect(page.getByLabel('Пример по-русски')).toHaveValue('Я не знаю этого слова.');
	await expect(page.getByLabel('Значение', { exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Подготовить карточку', exact: true })).toBeEnabled();
	await page.reload();
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Значение', { exact: true })).toHaveValue(' ');
	await page.getByLabel('Значение', { exact: true }).fill('Единица речи');
	const corrected = page.waitForResponse(response => response.url().endsWith('/api/cards') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	const result = await corrected;
	createdIds.push(result.request().postDataJSON().id);
	expect(result.status()).toBe(201);
	expect(result.request().postDataJSON().id).toBe((await save).request().postDataJSON().id);
	await expect(page.getByRole('status')).toContainText('Карточка сохранена.');
	const cards: CardPage = await (await page.request.get('/api/cards')).json();
	expect(cards.cards).toHaveLength(1);
	expect(cards.cards[0]).toMatchObject({ meaningRu: 'Единица речи', exampleRu: 'Я не знаю этого слова.', version: 1 });
});

test('keeps the preview editable and sends no create when recovery storage fails', async ({ page }) => {
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel('Слово или выражение').fill('słowo');
	await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveValue('Słowo');
	page.on('request', request => {
		if (request.url().endsWith('/api/cards') && request.method() === 'POST') createdIds.push(request.postDataJSON().id);
	});
	await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage is full.', 'QuotaExceededError'); }; });
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Браузер не сохранил черновик');
	await expect(page.getByLabel('По-польски', { exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Подготовить карточку', exact: true })).toBeEnabled();
	expect(createdIds).toEqual([]);
	expect((await (await page.request.get('/api/cards')).json()).cards).toEqual([]);
});

test('keeps the draft mounted until Save confirms and clears recovery data', async ({ page }) => {
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel('Слово или выражение').fill('słowo');
	await page.getByRole('button', { name: 'Подготовить карточку', exact: true }).click();
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveValue('Słowo');
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/cards', async route => {
		createdIds.push(route.request().postDataJSON().id);
		const response = await route.fetch();
		received.resolve();
		await release.promise;
		await route.fulfill({ response });
	});
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	await received.promise;
	try {
		await expect(page.getByRole('button', { name: 'Учить', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Слова', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Настройки', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeDisabled();
	} finally { release.resolve(); }
	await expect(page.getByRole('status')).toContainText('Карточка сохранена.');
	await page.getByRole('button', { name: 'Учить', exact: true }).click();
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('');
	expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
});
