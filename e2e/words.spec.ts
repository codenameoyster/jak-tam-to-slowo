import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { CARD_A, CARD_B, USER_A, USER_B } from '../test/fixtures';
import { allCards } from './cards';

let cardId: string;
test.beforeEach(async ({ context }) => {
	cardId = crypto.randomUUID();
	await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `words-${crypto.randomUUID()}` });
});
test.afterEach(async ({ page, baseURL }) => {
	expect((await page.request.post('/api/session', { headers: { Origin: baseURL! }, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	const list = await allCards(page.request);
	const card = list.find(card => card.id === cardId);
	if (card) expect((await page.request.patch(`/api/cards/${card.id}`, { headers: { Origin: baseURL! }, data: { version: card.version, archived: true } })).status()).toBe(200);
});

async function login(page: Page, user = USER_A) {
	await page.getByLabel('Nazwa użytkownika').fill(user.username);
	await page.getByLabel('Hasło', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Zaloguj', exact: true }).click();
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
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await page.getByLabel('Po polsku', { exact: true }).fill('Domek');
	await page.getByLabel('Przykład po polsku').fill('To mój nowy dom.');
	await page.getByLabel('Inne odpowiedzi po polsku').fill('Dom\nBudynek');
	const expired = spawnSync('bun', ['x', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.wrangler/playwright/state', '--command', `UPDATE sessions SET expires_at=0 WHERE user_id='${USER_A.id}'`], { encoding: 'utf8' });
	expect(expired.status, expired.stderr).toBe(0);
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Zaloguj', exact: true })).toBeVisible();
	await page.reload();
	if (scenario.other || scenario.conflict) {
		await login(page, USER_B);
		await page.getByRole('button', { name: 'Słówka', exact: true }).click();
		await expect(page.getByLabel('Przykład po polsku')).toHaveCount(0);
		if (scenario.conflict) expect((await page.request.patch(`/api/cards/${cardId}`, { headers, data: { ...CARD_B, id: undefined, version: 1, examplePl: 'To dom innego ucznia.' } })).status()).toBe(200);
		await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
	}
	await login(page);
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveValue('Domek');
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To mój nowy dom.');
	await expect(page.getByLabel('Inne odpowiedzi po polsku')).toHaveValue('Dom\nBudynek');
	const saved = page.waitForResponse(response => response.url().endsWith(`/api/cards/${cardId}`) && response.request().method() === 'PATCH');
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	expect((await saved).request().postDataJSON().version).toBe(1);
	expect((await saved).status()).toBe(scenario.conflict ? 409 : 200);
	if (scenario.conflict) {
		await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To mój nowy dom.');
		const list = await allCards(page.request);
		expect(list.find(card => card.id === cardId)).toMatchObject({ version: 2, examplePl: 'To dom innego ucznia.' });
	} else {
		await expect(page.getByRole('button', { name: 'Domek / Дом', exact: true })).toBeVisible();
		await page.reload();
		await page.getByRole('button', { name: 'Słówka', exact: true }).click();
		await expect(page.getByLabel('Przykład po polsku')).toHaveCount(0);
	}
});

for (const scenario of [
	{ name: 'Cancel', action: 'Odrzuć zmiany', expired: false },
	{ name: 'deliberate logout', action: 'Wyloguj', expired: false },
	{ name: 'deliberate logout after session loss', action: 'Wyloguj', expired: true },
]) test(`clears Words recovery after ${scenario.name}`, async ({ page, baseURL }) => {
	const headers = { Origin: baseURL! };
	await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } });
	await page.request.post('/api/cards', { headers, data: { ...CARD_B, id: cardId } });
	await page.goto('/');
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await page.getByLabel('Przykład po polsku').fill('To mój nowy dom.');
	await page.reload();
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To mój nowy dom.');
	if (scenario.expired) await page.context().clearCookies();
	await page.getByRole('button', { name: scenario.action, exact: true }).click();
	if (scenario.action === 'Wyloguj') await login(page);
	await page.reload();
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await expect(page.getByLabel('Przykład po polsku')).toHaveCount(0);
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To nasz dom.');
});

test('keeps an unsaved shared edit after another learner saves first', async ({ page, playwright, baseURL }, testInfo) => {
	const headers = { Origin: baseURL! };
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await page.request.post('/api/cards', { headers, data: { ...CARD_A, id: cardId } })).status()).toBe(201);
	const other = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { ...headers, 'CF-Connecting-IP': `words-${crypto.randomUUID()}` } });
	try {
		expect((await other.post('/api/session', { data: { username: USER_B.username, password: USER_B.password } })).status()).toBe(200);
		await page.goto('/');
		await page.getByRole('button', { name: 'Słówka', exact: true }).click();
		await page.getByLabel('Szukaj słówek').fill('СЛОВО');
		await page.getByRole('button', { name: 'Szukaj', exact: true }).click();
		await expect(page.getByText(CARD_A.meaningRu, { exact: true })).toHaveAttribute('lang', 'ru');
		await page.getByRole('button', { name: 'Słowo / Слово', exact: true }).click();
		await expect(page.getByText('Zmiany będą widoczne dla obu osób.', { exact: true })).toBeVisible();
		await page.getByLabel('Po rosyjsku', { exact: true }).fill('Мой вариант');
		await expect(page.getByLabel('Inne odpowiedzi po rosyjsku')).toHaveValue('');
		const { id, ...content } = { ...CARD_A, id: cardId };
		expect((await other.patch(`/api/cards/${id}`, { data: { ...content, ru: 'Словечко', alternativesRu: [], version: 1 } })).status()).toBe(200);
		const saved = page.waitForResponse(response => response.url().endsWith(`/api/cards/${id}`) && response.request().method() === 'PATCH');
		await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
		expect((await saved).status()).toBe(409);
		await expect(page.getByRole('alert')).toContainText('Fiszka została już zmieniona');
		await expect(page.getByLabel('Po rosyjsku', { exact: true })).toHaveValue('Мой вариант');
		await expect(page.getByRole('button', { name: 'Zapisz', exact: true })).toBeEnabled();
		const list = await (await other.get('/api/cards?q=Словечко')).json();
		expect(list.cards).toMatchObject([{ id, ru: 'Словечко', version: 2 }]);
		await page.screenshot({ path: `.wrangler/playwright/words-conflict-${testInfo.project.name}-${page.viewportSize()!.width}.png`, fullPage: true, animations: 'disabled', scale: 'css' });
		await page.getByRole('button', { name: 'Odrzuć zmiany', exact: true }).click();
		await page.getByLabel('Szukaj słówek').fill('Словечко');
		await page.getByRole('button', { name: 'Szukaj', exact: true }).click();
		await page.getByRole('button', { name: 'Słowo / Словечко', exact: true }).click();
		await expect(page.getByLabel('Po rosyjsku', { exact: true })).toHaveValue('Словечко');
	} finally { await other.dispose(); }
});

test('keeps Words mounted through a delayed save and reload, then recovers later edits', async ({ page, baseURL }) => {
	const headers = { Origin: baseURL! };
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await page.request.post('/api/cards', { headers, data: { ...CARD_B, id: cardId } })).status()).toBe(201);
	await page.goto('/');
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await page.getByLabel('Przykład po polsku').fill('To mój nowy dom.');
	const saved = Promise.withResolvers<void>(), releaseSave = Promise.withResolvers<void>();
	const reloaded = Promise.withResolvers<void>(), releaseReload = Promise.withResolvers<void>();
	await page.route(`**/api/cards/${cardId}`, async route => {
		const response = await route.fetch();
		expect(response.status()).toBe(200);
		saved.resolve();
		await releaseSave.promise;
		await route.fulfill({ response });
	});
	await page.route('**/api/cards?*', async route => {
		const response = await route.fetch();
		reloaded.resolve();
		await releaseReload.promise;
		await route.fulfill({ response });
	});
	try {
		await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
		await saved.promise;
		await page.getByRole('button', { name: 'Nauka', exact: true }).click({ force: true });
		await expect(page.getByRole('heading', { name: 'Słówka', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Nauka', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Słówka', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Dodaj', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Wyloguj', exact: true })).toBeDisabled();
		releaseSave.resolve();
		await reloaded.promise;
		await page.getByRole('button', { name: 'Wyloguj', exact: true }).click({ force: true });
		await expect(page.getByRole('heading', { name: 'Słówka', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Wyloguj', exact: true })).toBeDisabled();
	} finally { releaseSave.resolve(); releaseReload.resolve(); }
	await expect(page.getByLabel('Szukaj słówek')).toBeEnabled();
	await page.unroute('**/api/cards?*');
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To mój nowy dom.');
	await page.getByLabel('Przykład po polsku').fill('To kolejny opis domu.');
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To kolejny opis domu.');
	await page.reload();
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To kolejny opis domu.');
});

test('retries a term edit with replacement alternatives and archives the shared card', async ({ page, baseURL }) => {
	const headers = { Origin: baseURL! };
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await page.request.post('/api/cards', { headers, data: { ...CARD_B, id: cardId } })).status()).toBe(201);
	await page.goto('/');
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await page.getByRole('button', { name: 'Dom / Дом', exact: true }).click();
	await page.getByLabel('Przykład po polsku').fill('To mój dom.');
	await expect(page.getByLabel('Inne odpowiedzi po rosyjsku')).toHaveValue('Жилище');
	await page.getByLabel('Po rosyjsku', { exact: true }).fill('Жилище');
	await expect(page.getByLabel('Inne odpowiedzi po rosyjsku')).toHaveValue('');
	await page.getByLabel('Inne odpowiedzi po rosyjsku').fill('Дом');
	await page.route(`**/api/cards/${cardId}`, route => route.abort());
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Brak połączenia z serwerem');
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To mój dom.');
	await expect(page.getByLabel('Inne odpowiedzi po rosyjsku')).toHaveValue('Дом');
	await page.unroute(`**/api/cards/${cardId}`);
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Dom / Жилище', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Dom / Жилище', exact: true }).click();
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To mój dom.');
	await expect(page.getByLabel('Inne odpowiedzi po rosyjsku')).toHaveValue('Дом');
	await page.getByRole('button', { name: 'Do archiwum', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Dom / Жилище', exact: true })).toHaveCount(0);
	expect((await (await page.request.get('/api/cards?q=Dom')).json()).cards).toEqual([]);
});
