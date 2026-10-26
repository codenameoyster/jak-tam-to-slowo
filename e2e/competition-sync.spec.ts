import { expect, test, type Page } from '@playwright/test';
import type { Card, Competition, ReviewResult } from '../shared/types';
import { CARD_B, USER_A, USER_B } from '../test/fixtures';
import { allCards, sql } from './cards';

let other: Page;
let cards: Card[];

async function signIn(page: Page, user = USER_A) {
	expect((await page.request.post('/api/session', { data: { username: user.username, password: user.password } })).status()).toBe(200);
	expect((await page.request.patch('/api/me', { data: { direction: 'ru-pl' } })).status()).toBe(200);
}

async function seed(page: Page): Promise<Card> {
	const response = await page.request.post('/api/cards', { data: { ...CARD_B, id: crypto.randomUUID() } });
	expect(response.status()).toBe(201);
	const card: Card = await response.json();
	cards.push(card);
	return card;
}

async function invite(page: Page): Promise<Competition> {
	const response = await page.request.post('/api/competitions', { data: { id: crypto.randomUUID() } });
	expect(response.status()).toBe(200);
	return response.json();
}

async function start(page: Page): Promise<Competition> {
	const round = await invite(page);
	const response = await other.request.post(`/api/competitions/${round.id}/accept`, { data: {} });
	expect(response.status()).toBe(200);
	return response.json();
}

async function current(page: Page): Promise<Competition> {
	return (await page.request.get('/api/competitions/current')).json();
}

async function answer(page: Page) {
	await page.getByLabel('Odpowiedź po polsku').fill('Dom');
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await expect(page.locator('.study-feedback')).toContainText('Dobrze');
}

async function visibility(page: Page, value: 'hidden' | 'visible') {
	await page.evaluate(value => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, value });
		document.dispatchEvent(new Event('visibilitychange'));
	}, value);
}

async function scores(page: Page, a: number, b: number, user = USER_A, main = false) {
	const block = page.getByTestId(main ? 'competition-scores' : 'competition-summary');
	await expect(block).toContainText(`${USER_A.displayName}${user.id === USER_A.id ? ' (Ty)' : ''}: ${a}`);
	await expect(block).toContainText(`${USER_B.displayName}${user.id === USER_B.id ? ' (Ty)' : ''}: ${b}`);
}

test.beforeEach(async ({ page, browser, baseURL }) => {
	cards = [];
	other = await (await browser.newContext({ baseURL, viewport: page.viewportSize() })).newPage();
	await page.context().setExtraHTTPHeaders({ Origin: baseURL!, 'CF-Connecting-IP': `competition-a-${crypto.randomUUID()}` });
	await other.context().setExtraHTTPHeaders({ Origin: baseURL!, 'CF-Connecting-IP': `competition-b-${crypto.randomUUID()}` });
	await signIn(page);
	await signIn(other, USER_B);
	for (const card of await allCards(page.request)) {
		expect((await page.request.patch(`/api/cards/${card.id}`, { data: { version: card.version, archived: true } })).status()).toBe(200);
	}
});

test.afterEach(async ({ page }) => {
	await page.close();
	await other.context().close();
	const ids = cards.map(card => `'${card.id}'`).join(',') || "''";
	sql(`DELETE FROM competition_events; DELETE FROM competitions;
		DELETE FROM reviews WHERE json_extract(input_json, '$.cardId') IN (${ids});
		DELETE FROM card_progress WHERE card_id IN (${ids}); DELETE FROM cards WHERE id IN (${ids})`);
});

test("shows another learner's invitation and saved score", async ({ page }) => {
	await seed(page);
	await other.goto('/');
	await other.getByRole('button', { name: 'Zawody', exact: true }).click();
	await expect(other.getByRole('button', { name: 'Zaproś do wyścigu', exact: true })).toBeEnabled();
	await invite(page);
	await expect(other.getByRole('button', { name: 'Przyjmij wyzwanie', exact: true })).toBeVisible({ timeout: 7000 });
	await other.getByRole('button', { name: 'Przyjmij wyzwanie', exact: true }).click();
	await expect(other.getByRole('button', { name: 'Trenuj słówka', exact: true })).toBeEnabled();
	await page.goto('/');
	await scores(page, 0, 0);
	await answer(page);
	await expect(other.getByTestId('competition-scores')).toContainText(`${USER_A.displayName}: 1`, { timeout: 7000 });
	await scores(other, 1, 0, USER_B, true);
	expect((await current(page)).participants.map(p => p.score)).toEqual([1, 0]);
});

test('shares one snapshot across tabs', async ({ page }) => {
	await seed(page);
	await start(page);
	await page.clock.install();
	let reads = 0;
	page.on('request', request => { if (request.url().endsWith('/api/competitions/current')) reads++; });
	await page.goto('/');
	await scores(page, 0, 0);
	await answer(page);
	await scores(page, 1, 0);
	const before = reads;
	for (const screen of [
		{ name: 'Słówka', main: false }, { name: 'Dodaj', main: false },
		{ name: 'Zawody', main: true }, { name: 'Nauka', main: false },
	]) {
		await page.getByRole('button', { name: screen.name, exact: true }).click();
		await scores(page, 1, 0, USER_A, screen.main);
	}
	expect(reads).toBe(before);
	await page.clock.runFor(5000);
	await expect.poll(() => reads).toBe(before + 1);
	await scores(page, 1, 0);
	await page.clock.runFor(5000);
	await expect.poll(() => reads).toBe(before + 2);
	await other.goto('/');
	await scores(other, 1, 0, USER_B);
});

test('uses the current round when an editable review retry creates a new attempt', async ({ page }) => {
	await seed(page);
	const round = await invite(page);
	await page.clock.install();
	await page.goto('/');
	await scores(page, 0, 0);
	await page.getByLabel('Odpowiedź po polsku').fill('ошибка подключения');
	const failed = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	const rejected = await failed;
	expect(rejected.status()).toBe(503);
	expect(rejected.headers()['x-review-recovery']).toBe('editable');
	const original = rejected.request().postDataJSON();
	expect(original.competitionId).toBeUndefined();
	await expect(page.getByLabel('Odpowiedź po polsku')).toBeEnabled();
	expect((await other.request.post(`/api/competitions/${round.id}/accept`, { data: {} })).status()).toBe(200);
	await page.clock.runFor(5000);
	await expect(page.getByTestId('competition-summary')).not.toContainText('Oczekiwanie na przyjęcie wyzwania');
	await page.getByLabel('Odpowiedź po polsku').fill('Dom');
	const saved = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	const response = await saved;
	expect(response.status()).toBe(200);
	const retry = response.request().postDataJSON();
	expect(retry.attemptId).not.toBe(original.attemptId);
	expect(retry.competitionId).toBe(round.id);
	expect((await response.json()).competition).toMatchObject({ competitionId: round.id, delta: 1, scoreAfter: 1 });
	await expect(page.locator('.study-feedback')).toContainText('Wynik: 1.');
	await scores(page, 1, 0);
});

for (const scenario of [
	{ name: 'a tie at zero', a: 0, b: 0, text: 'Remis.' },
	{ name: 'a tie above zero', a: 8, b: 8, text: 'Remis.' },
	{ name: 'the first learner leads by one', a: 9, b: 8, text: `${USER_A.displayName} prowadzi o 1 punkt.` },
	{ name: 'the second learner leads by four', a: 8, b: 12, text: `${USER_B.displayName} prowadzi o 4 punkty.` },
	{ name: 'a twelve-point lead', a: 12, b: 0, text: `${USER_A.displayName} prowadzi o 12 punktów.` },
]) test(`shows the active result in both score displays for ${scenario.name}`, async ({ page }) => {
	const round = await start(page);
	sql(`UPDATE competitions SET score_a = ${scenario.a}, score_b = ${scenario.b}, version = version + 1 WHERE id = '${round.id}'`);
	await page.goto('/');
	await expect(page.getByTestId('competition-summary')).toContainText(scenario.text);
	await scores(page, scenario.a, scenario.b);
	await page.getByTestId('competition-summary').click();
	await expect(page.getByTestId('competition-scores')).toContainText(scenario.text);
	await scores(page, scenario.a, scenario.b, USER_A, true);
});

test('retries a lost review against the same round after reload', async ({ page }) => {
	const card = await seed(page);
	const oldRound = await start(page);
	let originalBody = '';
	await page.route('**/api/reviews', async route => {
		originalBody = route.request().postData()!;
		expect((await route.fetch()).status()).toBe(200);
		await route.abort();
	});
	await page.goto('/');
	await scores(page, 0, 0);
	await page.getByLabel('Odpowiedź po polsku').fill('Dom');
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('nie został potwierdzony');
	expect(JSON.parse(originalBody).competitionId).toBe(oldRound.id);
	sql(`UPDATE competitions SET score_b = 19, version = version + 1 WHERE id = '${oldRound.id}'`);
	expect((await other.request.post('/api/reviews', { data: { attemptId: crypto.randomUUID(), cardId: card.id, cardVersion: 1, progressVersion: 0,
		direction: 'ru-pl', action: 'answer', answer: 'Dom', competitionId: oldRound.id } })).status()).toBe(200);
	expect((await current(other)).status).toBe('finished');
	const rematch = await invite(other);
	expect((await page.request.post(`/api/competitions/${rematch.id}/accept`, { data: {} })).status()).toBe(200);
	await page.unroute('**/api/reviews');
	await page.reload();
	await scores(page, 0, 0);
	const retry = page.waitForRequest(request => request.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	expect((await retry).postData()).toBe(originalBody);
	await expect(page.locator('.study-feedback')).toContainText('Dobrze');
	await expect(page.locator('.study-feedback')).not.toContainText('Wynik:');
	await scores(page, 0, 0);
	expect((await current(page)).participants.map(p => p.score)).toEqual([0, 0]);
});

test('queues a fresh snapshot behind an old poll', async ({ page }) => {
	await seed(page);
	await start(page);
	await page.clock.install();
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	let reads = 0;
	await page.route('**/api/competitions/current', async route => {
		if (++reads !== 2) return route.continue();
		const response = await route.fetch();
		received.resolve();
		await release.promise;
		await route.fulfill({ response });
	});
	await page.goto('/');
	await scores(page, 0, 0);
	await page.clock.runFor(5000);
	await received.promise;
	try {
		await answer(page);
		expect(reads).toBe(2);
	} finally { release.resolve(); }
	await expect.poll(() => reads).toBe(3);
	await scores(page, 1, 0);
	await page.clock.runFor(5000);
	await scores(page, 1, 0);
});

for (const scenario of [
	{ name: 'loading', fail: false },
	{ name: 'read error', fail: true },
]) test(`ignores a previous account's late response during ${scenario.name}`, async ({ page }) => {
	const round = await invite(page);
	await page.clock.install();
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
	const newRead = Promise.withResolvers<void>(), releaseNew = Promise.withResolvers<void>();
	let reads = 0;
	await page.route('**/api/competitions/current', async route => {
		if (++reads === 2) {
			const response = await route.fetch();
			received.resolve();
			await release.promise;
			await route.fulfill({ response });
			finished.resolve();
		} else if (reads === 3) {
			newRead.resolve();
			if (scenario.fail) await route.fulfill({ status: 503, json: { error: 'Nowe konto: brak połączenia.' } });
			else { await releaseNew.promise; await route.continue(); }
		} else await route.continue();
	});
	await page.goto('/');
	await scores(page, 0, 0);
	await page.clock.runFor(5000);
	await received.promise;
	try {
		await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
		expect((await other.request.post(`/api/competitions/${round.id}/accept`, { data: {} })).status()).toBe(200);
		await page.getByLabel('Nazwa użytkownika').fill(USER_B.username);
		await page.getByLabel('Hasło', { exact: true }).fill(USER_B.password);
		await page.getByRole('button', { name: 'Zaloguj', exact: true }).click();
		await newRead.promise;
		await page.getByRole('button', { name: 'Zawody', exact: true }).click();
		if (scenario.fail) await expect(page.getByRole('alert')).toContainText('Nowe konto: brak połączenia.');
		release.resolve();
		await finished.promise;
		await expect(page.getByTestId('competition-scores')).toHaveCount(0);
		if (scenario.fail) {
			await expect(page.getByRole('alert')).toContainText('Nowe konto: brak połączenia.');
			await page.getByRole('button', { name: 'Ponów', exact: true }).click();
		} else await expect(page.getByRole('status').filter({ hasText: 'Wczytywanie wyzwania' })).toBeVisible();
	} finally { release.resolve(); releaseNew.resolve(); }
	await scores(page, 0, 0, USER_B, true);
	await expect(page.getByRole('button', { name: 'Trenuj słówka', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Przyjmij wyzwanie', exact: true })).toHaveCount(0);
});

for (const scenario of [
	{ name: 'an active round', active: true },
	{ name: 'no round', active: false },
]) test(`polls only while visible with ${scenario.name}`, async ({ page }) => {
	if (scenario.active) await start(page);
	await page.clock.install();
	let readCount = 0;
	page.on('request', request => { if (request.url().endsWith('/api/competitions/current')) readCount++; });
	await page.goto('/');
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	await expect(page.getByRole('button', { name: scenario.active ? 'Trenuj słówka' : 'Zaproś do wyścigu', exact: true })).toBeEnabled();
	await visibility(page, 'hidden');
	const before = readCount;
	await page.clock.runFor(15000);
	expect(readCount).toBe(before);
	await visibility(page, 'visible');
	await expect.poll(() => readCount).toBe(before + 1);
});

test('keeps answer feedback after a competition read failure', async ({ page }) => {
	await seed(page);
	await start(page);
	await page.clock.install();
	await page.goto('/');
	await scores(page, 0, 0);
	await page.route('**/api/competitions/current', route => route.fulfill({ status: 503, json: { error: 'Brak wyniku.' } }));
	await answer(page);
	await expect(page.locator('.study-feedback')).toContainText('Wynik: 1.');
	await expect(page.getByTestId('competition-summary')).toContainText('Wynik może być nieaktualny');
	await scores(page, 0, 0);
	await page.getByTestId('competition-summary').click();
	await expect(page.getByRole('alert')).toContainText('Brak wyniku.');
	await page.unroute('**/api/competitions/current');
	await expect(page.getByRole('button', { name: 'Odśwież', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Odśwież', exact: true }).click();
	await scores(page, 1, 0, USER_A, true);
	await expect(page.getByText('Wynik może być nieaktualny', { exact: true })).toHaveCount(0);
});

test('recovers an initial competition read', async ({ page }) => {
	await seed(page);
	await invite(other);
	await page.clock.install();
	await page.route('**/api/competitions/current', route => route.fulfill({ status: 503, json: { error: 'Brak wyzwania.' } }));
	await page.goto('/');
	await expect(page.getByLabel('Odpowiedź po polsku')).toBeEnabled();
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Brak wyzwania.');
	await expect(page.getByRole('button', { name: 'Zaproś do wyścigu', exact: true })).toHaveCount(0);
	await page.unroute('**/api/competitions/current');
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	await scores(page, 0, 0, USER_A, true);
	await expect(page.getByRole('button', { name: 'Przyjmij wyzwanie', exact: true })).toBeEnabled();
});

test('retries the same invitation UUID', async ({ page }) => {
	await page.clock.install();
	await page.goto('/');
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Zaproś do wyścigu', exact: true })).toBeEnabled();
	let originalBody = '';
	await page.route('**/api/competitions', async route => {
		originalBody = route.request().postData()!;
		expect((await route.fetch()).status()).toBe(200);
		await route.abort();
	});
	await page.route('**/api/competitions/current', route => route.fulfill({ status: 503, json: { error: 'Brak wyniku.' } }));
	await page.getByRole('button', { name: 'Zaproś do wyścigu', exact: true }).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Nie udało się zapisać wyzwania' })).toBeVisible();
	await page.unroute('**/api/competitions');
	await page.unroute('**/api/competitions/current');
	const retry = page.waitForRequest(request => request.url().endsWith('/api/competitions') && request.method() === 'POST');
	await page.getByRole('button', { name: 'Ponów zaproszenie', exact: true }).click();
	expect((await retry).postData()).toBe(originalBody);
	await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Przyjmij wyzwanie', exact: true })).toHaveCount(0);
	expect((await current(page)).id).toBe(JSON.parse(originalBody).id);
	sql('CREATE TABLE one_round (n INTEGER CHECK (n = 1)); INSERT INTO one_round SELECT count(*) FROM competitions; DROP TABLE one_round;');
});

test('resolves a lost invitation from the current snapshot before a rematch', async ({ page }) => {
	const card = await seed(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	await page.route('**/api/competitions', async route => { await route.fetch(); await route.abort(); });
	await page.getByRole('button', { name: 'Zaproś do wyścigu', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toBeEnabled();
	const original = await current(page);
	expect((await other.request.post(`/api/competitions/${original.id}/accept`, { data: {} })).status()).toBe(200);
	sql(`UPDATE competitions SET score_b = 19, version = version + 1 WHERE id = '${original.id}'`);
	expect((await other.request.post('/api/reviews', { data: { attemptId: crypto.randomUUID(), cardId: card.id, cardVersion: 1, progressVersion: 0,
		direction: 'ru-pl', action: 'answer', answer: 'Dom', competitionId: original.id } })).status()).toBe(200);
	await visibility(page, 'visible');
	await expect(page.getByTestId('competition-scores')).toContainText(`Wygrywa ${USER_B.displayName}!`);
	await page.unroute('**/api/competitions');
	await expect(page.getByRole('alert')).toHaveCount(0);
	await page.getByRole('button', { name: 'Zaproś na rewanż', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toBeEnabled();
	expect((await current(page)).id).not.toBe(original.id);
	await scores(page, 0, 0, USER_A, true);
});

for (const scenario of [
	{ name: 'acceptance from the immediate read', action: 'accept', history: false, readFailure: false, finish: false, button: 'Trenuj słówka' },
	{ name: 'acceptance from a later finished snapshot', action: 'accept', history: false, readFailure: true, finish: true, button: 'Zaproś na rewanż' },
	{ name: 'first invitation cancellation from the immediate read', action: 'cancel', history: false, readFailure: false, finish: false, button: 'Zaproś do wyścigu' },
	{ name: 'rematch cancellation from the immediate read', action: 'cancel', history: true, readFailure: false, finish: false, button: 'Zaproś na rewanż' },
	{ name: 'rematch cancellation from a later poll', action: 'cancel', history: true, readFailure: true, finish: false, button: 'Zaproś na rewanż' },
]) test(`confirms lost ${scenario.name}`, async ({ page }) => {
	let previous: Competition | null = null;
	if (scenario.history) {
		previous = await start(page);
		sql(`UPDATE competitions SET score_a = 20, status = 'finished', winner_id = '${USER_A.id}', finished_at = 1, version = version + 1 WHERE id = '${previous.id}'`);
	}
	const round = await invite(other);
	await page.clock.install();
	await page.goto('/');
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	const action = page.getByRole('button', { name: scenario.action === 'accept' ? 'Przyjmij wyzwanie' : 'Anuluj zaproszenie', exact: true });
	await expect(action).toBeEnabled();
	await page.route(`**/api/competitions/${round.id}/${scenario.action}`, async route => {
		expect((await route.fetch()).status()).toBe(200);
		await route.abort();
	});
	if (scenario.readFailure) await page.route('**/api/competitions/current', route => route.fulfill({ status: 503, json: { error: 'Brak wyniku.' } }));
	const refreshed = page.waitForResponse(response => response.url().endsWith('/api/competitions/current'));
	await action.click();
	await refreshed;
	await expect(page.getByRole('button', { name: 'Zawody', exact: true })).toBeEnabled();
	if (scenario.readFailure) {
		await expect(page.getByRole('alert').filter({ hasText: 'Nie udało się zapisać wyzwania' })).toBeVisible();
		await expect(page.getByRole('alert').filter({ hasText: 'Brak wyniku.' })).toBeVisible();
		if (scenario.finish) sql(`UPDATE competitions SET score_a = 20, status = 'finished', winner_id = '${USER_A.id}', finished_at = 1, version = version + 1 WHERE id = '${round.id}'`);
		await page.unroute('**/api/competitions/current');
		await page.clock.runFor(5000);
	}
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByRole('button', { name: scenario.button, exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: /^Ponów/ })).toHaveCount(0);
	if (scenario.action === 'accept') expect(await current(page)).toMatchObject({ id: round.id, status: scenario.finish ? 'finished' : 'active' });
	else if (previous) expect(await current(page)).toMatchObject({ id: previous.id, status: 'finished' });
	else expect(await current(page)).toBeNull();
});

for (const scenario of [
	{ name: 'acceptance after another invitation becomes current', action: 'accept', replacement: true, retry: 'Ponów przyjęcie' },
	{ name: 'cancellation while the confirming read fails', action: 'cancel', replacement: false, retry: 'Ponów anulowanie' },
]) test(`retries unresolved ${scenario.name} with the original operation and round`, async ({ page }) => {
	const round = await invite(other);
	await page.clock.install();
	await page.goto('/');
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	const action = page.getByRole('button', { name: scenario.action === 'accept' ? 'Przyjmij wyzwanie' : 'Anuluj zaproszenie', exact: true });
	await expect(action).toBeEnabled();
	const path = `/api/competitions/${round.id}/${scenario.action}`;
	await page.route(`**${path}`, async route => {
		expect((await route.fetch()).status()).toBe(200);
		await route.abort();
	});
	await page.route('**/api/competitions/current', route => route.fulfill({ status: 503, json: { error: 'Brak wyniku.' } }));
	await action.click();
	await expect(page.getByRole('alert').filter({ hasText: 'Nie udało się zapisać wyzwania' })).toBeVisible();
	await expect(page.getByRole('alert').filter({ hasText: 'Brak wyniku.' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Zawody', exact: true })).toBeEnabled();
	let replacement: Competition | null = null;
	if (scenario.replacement) {
		sql(`UPDATE competitions SET score_a = 20, status = 'finished', winner_id = '${USER_A.id}', finished_at = 1, version = version + 1 WHERE id = '${round.id}'`);
		replacement = await invite(page);
		await page.unroute('**/api/competitions/current');
		await visibility(page, 'visible');
		await expect(page.getByTestId('competition-scores')).toContainText('Oczekiwanie na przyjęcie wyzwania');
		await expect(page.getByRole('alert').filter({ hasText: 'Brak wyniku.' })).toHaveCount(0);
		await expect(page.getByRole('alert').filter({ hasText: 'Nie udało się zapisać wyzwania' })).toBeVisible();
	}
	await page.unroute(`**${path}`);
	await page.unroute('**/api/competitions/current');
	const posts: string[] = [];
	page.on('request', request => {
		if (request.method() === 'POST' && request.url().includes('/api/competitions')) posts.push(new URL(request.url()).pathname);
	});
	await page.getByRole('button', { name: scenario.retry, exact: true }).click();
	await expect(page.getByRole('button', { name: replacement ? 'Anuluj zaproszenie' : 'Zaproś do wyścigu', exact: true })).toBeEnabled();
	await expect(page.getByRole('alert')).toHaveCount(0);
	expect(posts).toEqual([path]);
	if (replacement) expect(await current(page)).toMatchObject({ id: replacement.id, status: 'waiting' });
	else expect(await current(page)).toBeNull();
});

for (const scenario of [
	{ name: 'the creator cancels the first invitation', invited: false, history: false },
	{ name: 'the invited learner cancels a rematch', invited: true, history: true },
]) test(`selects the current round and stays busy until refresh when ${scenario.name}`, async ({ page }) => {
	let finished: Competition | null = null;
	if (scenario.history) {
		finished = await start(page);
		sql(`UPDATE competitions SET score_a = 20, status = 'finished', winner_id = '${USER_A.id}', finished_at = 1, version = version + 1 WHERE id = '${finished.id}'`);
	}
	await invite(scenario.invited ? other : page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toBeEnabled();
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/competitions/current', async route => {
		received.resolve();
		await release.promise;
		await route.continue();
	});
	await page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true }).click();
	await received.promise;
	try {
		await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toBeDisabled();
		await expect(page.getByRole('navigation').locator('button:disabled')).toHaveCount(4);
		await expect(page.getByRole('button', { name: 'Wyloguj', exact: true })).toBeDisabled();
	} finally { release.resolve(); }
	await expect(page.getByRole('button', { name: scenario.history ? 'Zaproś na rewanż' : 'Zaproś do wyścigu', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toHaveCount(0);
	if (finished) {
		expect((await current(page)).id).toBe(finished.id);
		await scores(page, 20, 0, USER_A, true);
	} else expect(await current(page)).toBeNull();
});

test('refreshes after a lifecycle conflict', async ({ page }) => {
	const round = await invite(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toBeEnabled();
	await page.route(`**/api/competitions/${round.id}/cancel`, async route => {
		expect((await other.request.post(`/api/competitions/${round.id}/accept`, { data: {} })).status()).toBe(200);
		await route.continue();
	});
	await page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Stan wyzwania już się zmienił');
	await expect(page.getByRole('button', { name: 'Trenuj słówka', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toHaveCount(0);
});

test('locks navigation while a review is saved', async ({ page }) => {
	await seed(page);
	await start(page);
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/reviews', async route => { received.resolve(); await release.promise; await route.continue(); });
	await page.goto('/');
	await scores(page, 0, 0);
	await page.getByLabel('Odpowiedź po polsku').fill('Dom');
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await received.promise;
	try {
		await expect(page.getByTestId('competition-summary')).toBeDisabled();
		await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(4);
		await expect(page.getByRole('navigation').locator('button:disabled')).toHaveCount(4);
		await expect(page.getByRole('button', { name: 'Wyloguj', exact: true })).toBeDisabled();
	} finally { release.resolve(); }
	await expect(page.locator('.study-feedback')).toContainText('Dobrze');
	await expect(page.getByTestId('competition-summary')).toBeEnabled();
	await expect(page.getByRole('navigation').locator('button:disabled')).toHaveCount(0);
});

for (const scenario of [
	{ name: 'shows the saved zero-floor contribution', score: 0, action: 'reveal', delta: 0, after: 0, text: 'Zostajesz na starcie. Wynik: 0.' },
	{ name: 'shows the saved downward contribution', score: 1, action: 'reveal', delta: -1, after: 0, text: 'Cofasz się o 1. Wynik: 0.' },
	{ name: 'keeps the winning contribution after the round finishes', score: 19, action: 'answer', delta: 1, after: 20, text: 'Idziesz w górę o 1. Wynik: 20.' },
]) test(scenario.name, async ({ page }) => {
	await seed(page);
	const round = await start(page);
	if (scenario.score) sql(`UPDATE competitions SET score_a = ${scenario.score}, version = version + 1 WHERE id = '${round.id}'`);
	await page.goto('/');
	await scores(page, scenario.score, 0);
	const saved = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	if (scenario.action === 'answer') await answer(page);
	else await page.getByRole('button', { name: 'Pokaż odpowiedź', exact: true }).click();
	const result: ReviewResult = await (await saved).json();
	expect(result.competition).toMatchObject({ competitionId: round.id, delta: scenario.delta, scoreAfter: scenario.after });
	await expect(page.locator('.study-feedback')).toContainText(scenario.text);
	await scores(page, scenario.after, 0);
	if (scenario.after === 20) {
		await expect(page.getByTestId('competition-summary')).toContainText(`Wygrywa ${USER_A.displayName}!`);
		await page.getByTestId('competition-summary').click();
		await expect(page.getByRole('button', { name: 'Zaproś na rewanż', exact: true })).toBeEnabled();
		await page.getByRole('button', { name: 'Zaproś na rewanż', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toBeEnabled();
		await scores(page, 0, 0, USER_A, true);
	} else {
		await page.getByRole('button', { name: 'Dalej', exact: true }).click();
		await expect(page.getByText(/Następna powtórka:/)).toBeVisible();
	}
});
