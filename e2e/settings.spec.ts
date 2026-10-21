import { expect, test, type Page } from '@playwright/test';
import { USER_A, USER_B } from '../test/fixtures';

async function login(page: Page, user = USER_A) {
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

test('keeps personal connections and models separate and reports unconfirmed revocation', async ({ page, browser }) => {
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
	await expect(other.getByText('ChatGPT не подключён.', { exact: true })).toBeVisible();
	await finish(other, await start(other, 'b'));
	await expect(other.getByText('b@example.test', { exact: true })).toBeVisible();
	await expect(other.getByLabel('Модель', { exact: true }).locator('option')).toHaveText(['b first', 'b second']);
	await page.getByRole('button', { name: 'Отключить', exact: true }).click();
	await expect(page.getByText('ChatGPT не подключён.', { exact: true })).toBeVisible();
	await expect(page.getByRole('status')).toContainText('ChatGPT не подтвердил отключение');
	await expect(other.getByLabel('Модель', { exact: true })).toHaveValue('b-first');
	await page.screenshot({ path: '.wrangler/playwright/settings-mobile.png', fullPage: true });
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
