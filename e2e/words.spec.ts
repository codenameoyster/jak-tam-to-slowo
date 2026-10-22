import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { CARD_A, CARD_B, USER_A, USER_B } from '../test/fixtures';
import type { CardPage } from '../shared/types';

let cardId: string;
test.beforeEach(async ({ context }) => {
	cardId = crypto.randomUUID();
	await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `words-${crypto.randomUUID()}` });
});
test.afterEach(async ({ page, baseURL }) => {
	expect((await page.request.post('/api/session', { headers: { Origin: baseURL! }, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	const list: CardPage = await (await page.request.get('/api/cards')).json();
	const card = list.cards.find(card => card.id === cardId);
	if (card) expect((await page.request.patch(`/api/cards/${card.id}`, { headers: { Origin: baseURL! }, data: { version: card.version, archived: true } })).status()).toBe(200);
});

async function login(page: Page, user = USER_A) {
	await page.getByLabel('Имя пользователя').fill(user.username);
	await page.getByLabel('Пароль', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await expect(page.getByText(user.displayName, { exact: true })).toBeVisible();
}

for (const scenario of [
	{ name: 'same-account recovery', other: false, conflict: false },
	{ name: 'another account before recovery', other: true, conflict: false },
	{ name: 'a shared edit before recovery', other: false, conflict: true },
]) test(`keeps unsaved Words fields and their original version after expiry: ${scenario.name}`, async ({ page, baseURL }) => {
	const headers = { Origin: baseURL! };
	await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } });
	await page.request.post('/api/cards', { headers, data: { ...CARD_B, id: cardId } });
	await page.goto('/');
	await page.getByRole('button', { name: 'Слова', exact: true }).click();
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await page.getByLabel('По-польски', { exact: true }).fill('Domek');
	await page.getByLabel('Пример по-польски').fill('To mój nowy dom.');
	await page.getByLabel('Другие ответы по-польски').fill('Dom\nBudynek');
	const expired = spawnSync('bun', ['x', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.wrangler/playwright/state', '--command', `UPDATE sessions SET expires_at=0 WHERE user_id='${USER_A.id}'`], { encoding: 'utf8' });
	expect(expired.status, expired.stderr).toBe(0);
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
	await page.reload();
	if (scenario.other || scenario.conflict) {
		await login(page, USER_B);
		await page.getByRole('button', { name: 'Слова', exact: true }).click();
		await expect(page.getByLabel('Пример по-польски')).toHaveCount(0);
		if (scenario.conflict) expect((await page.request.patch(`/api/cards/${cardId}`, { headers, data: { ...CARD_B, id: undefined, version: 1, examplePl: 'To dom innego ucznia.' } })).status()).toBe(200);
		await page.getByRole('button', { name: 'Выйти', exact: true }).click();
	}
	await login(page);
	await page.getByRole('button', { name: 'Слова', exact: true }).click();
	await expect(page.getByLabel('По-польски', { exact: true })).toHaveValue('Domek');
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('To mój nowy dom.');
	await expect(page.getByLabel('Другие ответы по-польски')).toHaveValue('Dom\nBudynek');
	const saved = page.waitForResponse(response => response.url().endsWith(`/api/cards/${cardId}`) && response.request().method() === 'PATCH');
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	expect((await saved).request().postDataJSON().version).toBe(1);
	expect((await saved).status()).toBe(scenario.conflict ? 409 : 200);
	if (scenario.conflict) {
		await expect(page.getByLabel('Пример по-польски')).toHaveValue('To mój nowy dom.');
		const list: CardPage = await (await page.request.get('/api/cards')).json();
		expect(list.cards.find(card => card.id === cardId)).toMatchObject({ version: 2, examplePl: 'To dom innego ucznia.' });
	} else {
		await expect(page.getByRole('button', { name: 'Domek / Дом', exact: true })).toBeVisible();
		await page.reload();
		await page.getByRole('button', { name: 'Слова', exact: true }).click();
		await expect(page.getByLabel('Пример по-польски')).toHaveCount(0);
	}
});

for (const scenario of [
	{ name: 'Cancel', action: 'Отменить правки', expired: false },
	{ name: 'deliberate logout', action: 'Выйти', expired: false },
	{ name: 'deliberate logout after session loss', action: 'Выйти', expired: true },
]) test(`clears Words recovery after ${scenario.name}`, async ({ page, baseURL }) => {
	const headers = { Origin: baseURL! };
	await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } });
	await page.request.post('/api/cards', { headers, data: { ...CARD_B, id: cardId } });
	await page.goto('/');
	await page.getByRole('button', { name: 'Слова', exact: true }).click();
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await page.getByLabel('Пример по-польски').fill('To mój nowy dom.');
	await page.reload();
	await page.getByRole('button', { name: 'Слова', exact: true }).click();
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('To mój nowy dom.');
	if (scenario.expired) await page.context().clearCookies();
	await page.getByRole('button', { name: scenario.action, exact: true }).click();
	if (scenario.action === 'Выйти') await login(page);
	await page.reload();
	await page.getByRole('button', { name: 'Слова', exact: true }).click();
	await expect(page.getByLabel('Пример по-польски')).toHaveCount(0);
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('To nasz dom.');
});

test('keeps an unsaved shared edit after another learner saves first', async ({ page, playwright, baseURL }) => {
	const headers = { Origin: baseURL! };
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await page.request.post('/api/cards', { headers, data: { ...CARD_A, id: cardId } })).status()).toBe(201);
	const other = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { ...headers, 'CF-Connecting-IP': `words-${crypto.randomUUID()}` } });
	try {
		expect((await other.post('/api/session', { data: { username: USER_B.username, password: USER_B.password } })).status()).toBe(200);
		await page.goto('/');
		await page.getByRole('button', { name: 'Слова', exact: true }).click();
		await page.getByLabel('Поиск слов').fill('СЛОВО');
		await page.getByRole('button', { name: 'Найти', exact: true }).click();
		await page.getByRole('button', { name: 'Słowo / Слово', exact: true }).click();
		await expect(page.getByText('Изменения видны обоим ученикам.', { exact: true })).toBeVisible();
		await page.getByLabel('По-русски', { exact: true }).fill('Мой вариант');
		await expect(page.getByLabel('Другие ответы по-русски')).toHaveValue('');
		const { id, ...content } = { ...CARD_A, id: cardId };
		expect((await other.patch(`/api/cards/${id}`, { data: { ...content, ru: 'Словечко', alternativesRu: [], version: 1 } })).status()).toBe(200);
		const saved = page.waitForResponse(response => response.url().endsWith(`/api/cards/${id}`) && response.request().method() === 'PATCH');
		await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
		expect((await saved).status()).toBe(409);
		await expect(page.getByRole('alert')).toContainText('Карточка уже изменена');
		await expect(page.getByLabel('По-русски', { exact: true })).toHaveValue('Мой вариант');
		await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled();
		const list = await (await other.get('/api/cards?q=Словечко')).json();
		expect(list.cards).toMatchObject([{ id, ru: 'Словечко', version: 2 }]);
		await page.screenshot({ path: '.wrangler/playwright/words-conflict-mobile.png', fullPage: true });
		await page.getByRole('button', { name: 'Отменить правки', exact: true }).click();
		await page.getByLabel('Поиск слов').fill('Словечко');
		await page.getByRole('button', { name: 'Найти', exact: true }).click();
		await page.getByRole('button', { name: 'Słowo / Словечко', exact: true }).click();
		await expect(page.getByLabel('По-русски', { exact: true })).toHaveValue('Словечко');
	} finally { await other.dispose(); }
});

test('retries a term edit with replacement alternatives and archives the shared card', async ({ page, baseURL }) => {
	const headers = { Origin: baseURL! };
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await page.request.post('/api/cards', { headers, data: { ...CARD_B, id: cardId } })).status()).toBe(201);
	await page.goto('/');
	await page.getByRole('button', { name: 'Слова', exact: true }).click();
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await page.getByLabel('Пример по-польски').fill('To mój dom.');
	await expect(page.getByLabel('Другие ответы по-русски')).toHaveValue('Жилище');
	await page.getByLabel('По-русски', { exact: true }).fill('Жилище');
	await expect(page.getByLabel('Другие ответы по-русски')).toHaveValue('');
	await page.getByLabel('Другие ответы по-русски').fill('Дом');
	await page.route(`**/api/cards/${cardId}`, route => route.abort());
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Нет связи с сервером');
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('To mój dom.');
	await expect(page.getByLabel('Другие ответы по-русски')).toHaveValue('Дом');
	await page.unroute(`**/api/cards/${cardId}`);
	await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Dom / Жилище', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Dom / Жилище', exact: true }).click();
	await expect(page.getByLabel('Пример по-польски')).toHaveValue('To mój dom.');
	await expect(page.getByLabel('Другие ответы по-русски')).toHaveValue('Дом');
	await page.getByRole('button', { name: 'В архив', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Dom / Жилище', exact: true })).toHaveCount(0);
	expect((await (await page.request.get('/api/cards?q=Dom')).json()).cards).toEqual([]);
});
