import { expect, test, type Page } from '@playwright/test';
import type { CardPage, StudyBatch } from '../shared/types';
import { CARD_B, USER_A, USER_B } from '../test/fixtures';

async function login(page: Page, user: typeof USER_A) {
	await page.getByLabel('Имя пользователя').fill(user.username);
	await page.getByLabel('Пароль', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await expect(page.getByText(user.displayName, { exact: true })).toBeVisible();
}

for (const scenario of [
	{ name: 'exact review', screen: 'study', path: '/reviews', method: 'POST', answer: 'Dom', action: 'Проверить' },
	{ name: 'semantic review', screen: 'study', path: '/reviews', method: 'POST', answer: 'domu', action: 'Проверить' },
	{ name: 'shared generation', screen: 'add', path: '/cards/draft', method: 'POST', answer: 'мой ответ', action: 'Подготовить карточку' },
	{ name: 'preference change', screen: 'study', path: '/me', method: 'PATCH', answer: 'мой ответ', action: 'PL -> RU' },
	{ name: 'logout', screen: 'study', path: '/session', method: 'DELETE', answer: 'мой ответ', action: 'Выйти' },
]) test(`rejects ${scenario.name} from an old A tab after the shared cookie changes to B`, async ({ page, context, baseURL }) => {
	const headers = { Origin: baseURL!, 'CF-Connecting-IP': `switch-${crypto.randomUUID()}` };
	await context.setExtraHTTPHeaders(headers);
	const other = await context.newPage();
	const id = crypto.randomUUID();
	try {
		await page.goto('/');
		const firstStudy = page.waitForRequest(request => request.url().includes('/api/study?'));
		await login(page, USER_A);
		expect((await firstStudy).headers()['x-account-id']).toBe(USER_A.id);
		expect((await page.request.patch('/api/me', { headers, data: { direction: 'ru-pl' } })).status()).toBe(200);
		expect((await page.request.post('/api/cards', { headers, data: { ...CARD_B, id } })).status()).toBe(201);
		await page.reload();
		await page.getByLabel('Ответ по-польски').fill(scenario.answer);
		if (scenario.screen === 'add') {
			await page.getByRole('button', { name: 'Добавить', exact: true }).click();
			const matches = page.waitForResponse(response => response.url().includes('/api/cards?q='));
			await page.getByLabel('Слово или выражение').fill('личный черновик');
			await matches;
		}
		await other.goto('/');
		await expect(other.getByText(USER_A.displayName, { exact: true })).toBeVisible();
		await other.getByRole('button', { name: 'Выйти', exact: true }).click();
		await login(other, USER_B);
		expect((await other.request.patch('/api/me', { headers, data: { direction: 'ru-pl' } })).status()).toBe(200);
		const before = await other.request.get('/api/session');
		await expect(page.getByText(USER_A.displayName, { exact: true })).toBeVisible();
		const rejected = page.waitForResponse(response => response.url().endsWith(`/api${scenario.path}`) && response.request().method() === scenario.method);
		if (scenario.path === '/me') page.once('dialog', dialog => dialog.accept());
		await page.getByRole('button', { name: scenario.action, exact: true }).click();
		const response = await rejected;
		expect(response.status()).toBe(409);
		expect(await response.json()).toMatchObject({ code: 'account_mismatch' });
		expect(response.request().headers()['x-account-id']).toBe(USER_A.id);
		await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
		const after = await other.request.get('/api/session');
		expect(after.headers()['x-test-provider-calls']).toBe(before.headers()['x-test-provider-calls']);
		expect(await after.json()).toMatchObject({ id: USER_B.id, direction: 'ru-pl' });
		const batch: StudyBatch = await (await other.request.get('/api/study?direction=ru-pl')).json();
		expect(batch.cards.find(item => item.card.id === id)?.progress).toBeNull();
		await login(page, USER_B);
		await expect(page.getByLabel('Ответ по-польски')).toHaveValue('');
		await page.getByRole('button', { name: 'Выйти', exact: true }).click();
		await login(page, USER_A);
		await expect(page.getByLabel('Ответ по-польски')).toHaveValue(scenario.answer);
		if (scenario.screen === 'add') {
			await page.getByRole('button', { name: 'Добавить', exact: true }).click();
			await expect(page.getByLabel('Слово или выражение')).toHaveValue('личный черновик');
		}
	} finally {
		for (const user of [USER_A, USER_B]) {
			await page.request.post('/api/session', { headers, data: { username: user.username, password: user.password } });
			await page.request.patch('/api/me', { headers, data: { direction: 'ru-pl' } });
		}
		const list: CardPage = await (await page.request.get('/api/cards')).json();
		const card = list.cards.find(card => card.id === id);
		if (card) await page.request.patch(`/api/cards/${id}`, { headers, data: { version: card.version, archived: true } });
		await other.close();
	}
});
