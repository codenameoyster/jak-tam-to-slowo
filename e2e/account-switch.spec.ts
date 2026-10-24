import { expect, test, type Page } from '@playwright/test';
import { CARD_B, USER_A, USER_B } from '../test/fixtures';
import { allCards } from './cards';

async function login(page: Page, user: typeof USER_A) {
	await page.getByLabel('Nazwa użytkownika').fill(user.username);
	await page.getByLabel('Hasło', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Zaloguj', exact: true }).click();
	await expect(page.getByText(user.displayName, { exact: true })).toBeVisible();
}

test('rejects logout from an old A tab after the shared cookie changes to B', async ({ page, context, baseURL }) => {
	const headers = { Origin: baseURL!, 'CF-Connecting-IP': `switch-${crypto.randomUUID()}` };
	await context.setExtraHTTPHeaders(headers);
	const other = await context.newPage();
	const id = crypto.randomUUID();
	try {
		await page.goto('/');
		const firstStudy = page.waitForRequest(request => request.url().endsWith('/api/study'));
		await login(page, USER_A);
		expect((await firstStudy).headers()['x-account-id']).toBe(USER_A.id);
		expect((await page.request.patch('/api/me', { headers, data: { direction: 'ru-pl' } })).status()).toBe(200);
		expect((await page.request.post('/api/cards', { headers, data: { ...CARD_B, id } })).status()).toBe(201);
		await page.reload();
		await page.getByLabel('Odpowiedź po polsku').fill('мой ответ');
		await other.goto('/');
		await expect(other.getByText(USER_A.displayName, { exact: true })).toBeVisible();
		await other.getByRole('button', { name: 'Wyloguj', exact: true }).click();
		await login(other, USER_B);
		expect((await other.request.patch('/api/me', { headers, data: { direction: 'ru-pl' } })).status()).toBe(200);
		await expect(page.getByText(USER_A.displayName, { exact: true })).toBeVisible();
		const rejected = page.waitForResponse(response => response.url().endsWith('/api/session') && response.request().method() === 'DELETE');
		await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
		const response = await rejected;
		expect(response.status()).toBe(409);
		expect(await response.json()).toMatchObject({ code: 'account_mismatch' });
		expect(response.request().headers()['x-account-id']).toBe(USER_A.id);
		await expect(page.getByRole('button', { name: 'Zaloguj', exact: true })).toBeVisible();
		expect(await (await other.request.get('/api/session')).json()).toMatchObject({ id: USER_B.id, direction: 'ru-pl' });
		await login(page, USER_B);
		await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('');
		await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
		await login(page, USER_A);
		await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('мой ответ');
	} finally {
		for (const user of [USER_A, USER_B]) {
			await page.request.post('/api/session', { headers, data: { username: user.username, password: user.password } });
			await page.request.patch('/api/me', { headers, data: { direction: 'ru-pl' } });
		}
		const list = await allCards(page.request);
		const card = list.find(card => card.id === id);
		if (card) await page.request.patch(`/api/cards/${id}`, { headers, data: { version: card.version, archived: true } });
		await other.close();
	}
});
