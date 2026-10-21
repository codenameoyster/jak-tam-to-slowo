import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { USER_A, USER_B } from '../test/fixtures';

test('keeps the account and direction after reload and revokes access at logout', async ({ page }) => {
	await page.goto('/');
	expect((await page.request.get('/api/session')).status()).toBe(401);
	const stylesheet = await page.locator('link[rel="stylesheet"]').getAttribute('href');
	expect((await page.request.get(stylesheet!)).headers()['content-type']).toContain('text/css');
	await page.getByLabel('Имя пользователя').fill(USER_A.username);
	await page.getByLabel('Пароль', { exact: true }).fill(USER_A.password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await expect(page.getByText(USER_A.displayName, { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'PL -> RU', exact: true }).click();
	await expect(page.getByRole('button', { name: 'PL -> RU', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.reload();
	await expect(page.getByText(USER_A.displayName, { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'PL -> RU', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.screenshot({ path: '.wrangler/playwright/account-mobile.png', fullPage: true });
	await page.getByRole('button', { name: 'Выйти', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
	expect((await page.request.get('/api/session')).status()).toBe(401);
	await page.getByLabel('Имя пользователя').fill(USER_B.username);
	await page.getByLabel('Пароль', { exact: true }).fill(USER_B.password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await expect(page.getByText(USER_B.displayName, { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'RU -> PL', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('shows a failed sign-in and allows another attempt', async ({ page }) => {
	await page.goto('/');
	await page.getByLabel('Имя пользователя').fill(USER_A.username);
	await page.getByLabel('Пароль', { exact: true }).fill('wrong-password');
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Неверное имя пользователя или пароль.');
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeEnabled();
	await page.screenshot({ path: '.wrangler/playwright/login-mobile.png', fullPage: true });
});

test('generates random passwords and retains account IDs during rotation', async ({}, testInfo) => {
	const generated = spawnSync('bun', ['scripts/credentials.ts', 'anna', 'Анна', 'boris', 'Борис'], { encoding: 'utf8' });
	expect(generated.status).toBe(0);
	const accounts: { id: string; username: string; displayName: string; passwordHash: string }[] = JSON.parse(generated.stdout);
	expect(accounts).toHaveLength(2);
	const passwords = [...generated.stderr.matchAll(/Password: ([A-Za-z0-9_-]{24})/g)].map(match => match[1]);
	expect(passwords).toHaveLength(2);
	expect(new Set(passwords).size).toBe(2);
	expect(accounts[0]).toMatchObject({ username: 'anna', displayName: 'Анна', passwordHash: createHash('sha256').update(passwords[0]).digest('hex') });
	expect(accounts[1]).toMatchObject({ username: 'boris', displayName: 'Борис', passwordHash: createHash('sha256').update(passwords[1]).digest('hex') });
	expect(accounts[0].id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
	expect(accounts[1].id).not.toBe(accounts[0].id);
	const path = testInfo.outputPath('accounts.json');
	await writeFile(path, generated.stdout, { mode: 0o600 });
	const rotated = spawnSync('bun', ['scripts/credentials.ts', '--rotate', path], { encoding: 'utf8' });
	expect(rotated.status).toBe(0);
	const next: typeof accounts = JSON.parse(rotated.stdout);
	expect(next.map(({ id, username, displayName }) => ({ id, username, displayName }))).toEqual(accounts.map(({ id, username, displayName }) => ({ id, username, displayName })));
	expect(next[0].passwordHash).not.toBe(accounts[0].passwordHash);
	expect(next[1].passwordHash).not.toBe(accounts[1].passwordHash);
});
