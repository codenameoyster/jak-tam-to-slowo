import { expect, test, type Page } from '@playwright/test';
import { USER_A, USER_B } from '../test/fixtures';

test.afterEach(async ({ page, baseURL }) => {
	const headers = { Origin: baseURL!, 'CF-Connecting-IP': `settings-cleanup-${crypto.randomUUID()}` };
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await page.request.delete('/api/ai/connection', { headers })).status()).toBe(200);
});

async function login(page: Page, user = USER_A) {
	await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': `settings-${crypto.randomUUID()}` });
	await page.goto('/');
	await page.getByLabel('Имя пользователя').fill(user.username);
	await page.getByLabel('Пароль', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.getByRole('button', { name: 'Настройки', exact: true }).click();
}
async function start(page: Page, account: string) {
	await page.getByRole('button', { name: /Продолжить с ChatGPT|Подключить заново/ }).click();
	const link = page.getByRole('link', { name: 'Открыть страницу входа ChatGPT' });
	await expect(link).toBeVisible();
	const authorization = new URL((await link.getAttribute('href'))!);
	const callback = new URL(authorization.searchParams.get('redirect_uri')!);
	callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: `${account}:${authorization.searchParams.get('nonce')}`, client_id: `oaiapp_${account}` }).toString();
	return callback;
}
async function finish(page: Page, callback: URL) {
	await page.getByLabel('Адрес со страницы ошибки').fill(callback.href);
	await page.getByRole('button', { name: 'Подключить', exact: true }).click();
}

test('shows shared status with owner-only controls and reports unconfirmed revocation', async ({ page, browser }, testInfo) => {
	await login(page);
	await finish(page, await start(page, 'a'));
	await expect(page.getByText('a@example.test', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Модель', { exact: true })).toHaveValue('a-first');
	await page.getByLabel('Модель', { exact: true }).selectOption('a-second');
	await expect(page.getByRole('status')).toContainText('Модель сохранена.');
	await page.reload();
	await page.getByRole('button', { name: 'Настройки', exact: true }).click();
	await expect(page.getByLabel('Модель', { exact: true })).toHaveValue('a-second');
	await expect(page.getByRole('link', { name: 'Использование ChatGPT' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	const other = await context.newPage();
	await login(other, USER_B);
	await expect(other.getByText('a@example.test', { exact: true })).toBeVisible();
	await expect(other.getByText('Модель: a second', { exact: true })).toBeVisible();
	await expect(other.getByLabel('Модель', { exact: true })).toHaveCount(0);
	await expect(other.getByRole('button', { name: /Продолжить с ChatGPT|Подключить заново|Отключить/ })).toHaveCount(0);
	await expect(other.getByRole('link', { name: 'Использование ChatGPT' })).toHaveCount(0);
	await expect(other.getByLabel('Адрес со страницы ошибки')).toHaveCount(0);
	await page.getByRole('button', { name: 'Отключить', exact: true }).click();
	await expect(page.getByText('ChatGPT не подключён.', { exact: true })).toBeVisible();
	await expect(page.getByRole('status')).toContainText('ChatGPT не подтвердил отключение');
	await other.reload();
	await other.getByRole('button', { name: 'Настройки', exact: true }).click();
	await expect(other.getByText('ChatGPT не подключён.', { exact: true })).toBeVisible();
	await expect(other.getByText('Подключением управляет владелец. Ваша подписка ChatGPT не нужна.', { exact: true })).toBeVisible();
	await expect(other.getByRole('button', { name: /Продолжить с ChatGPT|Подключить заново|Отключить/ })).toHaveCount(0);
	await page.screenshot({ path: `.wrangler/playwright/settings-${testInfo.project.name}-${page.viewportSize()!.width}.png`, fullPage: true, animations: 'disabled', scale: 'css' });
	expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
	await context.close();
});

test('retains a valid connection after failed replacement and permits another sign-in', async ({ page }) => {
	await login(page);
	await finish(page, await start(page, 'a'));
	await expect(page.getByText('a@example.test', { exact: true })).toBeVisible();
	const callback = await start(page, 'a');
	callback.searchParams.set('code', 'denied');
	await finish(page, callback);
	await expect(page.getByRole('alert')).toBeVisible();
	await expect(page.getByLabel('Модель', { exact: true })).toHaveValue('a-first');
	await finish(page, await start(page, 'a'));
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByLabel('Адрес со страницы ошибки')).toHaveCount(0);
	await expect(page.getByText('a@example.test', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Отключить', exact: true }).click();
	await expect(page.getByText('ChatGPT не подключён.', { exact: true })).toBeVisible();
});
