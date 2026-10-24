import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import type { Card, ReviewInput, ReviewResult, StudyBatch } from '../shared/types';
import { CARD_B, USER_A, USER_B } from '../test/fixtures';
import { allCards } from './cards';

let headers: Record<string, string>;

async function login(page: Page, user = USER_A) {
	await page.getByLabel('Nazwa użytkownika').fill(user.username);
	await page.getByLabel('Hasło', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Zaloguj', exact: true }).click();
	await expect(page.getByText(user.displayName, { exact: true })).toBeVisible();
}

async function archive(page: Page, keep?: string) {
	const list = await allCards(page.request);
	for (const card of list.filter(card => card.id !== keep)) {
		expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { version: card.version, archived: true } })).status()).toBe(200);
	}
}

async function seed(page: Page, count = 1): Promise<Card[]> {
	const cards: Card[] = [];
	for (let index = 0; index < count; index++) {
		const suffix = index ? ` ${index + 1}` : '';
		const response = await page.request.post('/api/cards', { headers, data: { ...CARD_B, id: crypto.randomUUID(), pl: `Dom${suffix}`, ru: `Дом${suffix}` } });
		expect(response.status()).toBe(201);
		cards.push(await response.json());
	}
	return cards;
}

async function answer(page: Page, text: string) {
	await page.getByLabel('Odpowiedź po polsku').fill(text);
	await page.getByLabel('Odpowiedź po polsku').press('Enter');
	await expect(page.getByRole('status').filter({ hasText: 'Dobrze' })).toBeVisible();
}

async function reachRefill(page: Page, cards: Card[]) {
	for (const card of cards.slice(0, 7)) {
		await expect(page.getByTestId('study-term')).toHaveText(card.ru);
		await answer(page, card.pl);
		await page.getByRole('button', { name: 'Dalej', exact: true }).click();
	}
}

function sql(command: string) {
	const result = spawnSync('bun', ['x', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.wrangler/playwright/state', '--command', command], { encoding: 'utf8' });
	expect(result.status, result.stderr).toBe(0);
}

test.beforeEach(async ({ page, baseURL }) => {
	headers = { Origin: baseURL!, 'CF-Connecting-IP': `study-${crypto.randomUUID()}` };
	await page.setExtraHTTPHeaders(headers);
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await page.request.patch('/api/me', { headers, data: { direction: 'ru-pl' } })).status()).toBe(200);
	await archive(page);
});

test.afterEach(async ({ page }) => {
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	await archive(page);
});

test('refills once at three unanswered cards, keeps the active card in the cap, and removes overlapping IDs', async ({ page }, testInfo) => {
	const cards = await seed(page, 17);
	const refills: string[] = [], reviews: ReviewInput[] = [];
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) reviews.push(request.postDataJSON()); });
	await page.route('**/api/study?*', async route => {
		if (!new URL(route.request().url()).searchParams.get('exclude')) return route.continue();
		refills.push(route.request().url());
		const response = await route.fetch();
		const batch: StudyBatch = await response.json();
		if (refills.length === 1) {
			received.resolve();
			await release.promise;
			// Inject an overlapping response to check client deduplication.
			batch.cards = [{ card: cards[7], progress: null }, ...batch.cards, ...batch.cards];
		}
		await route.fulfill({ response, json: batch });
	});
	await page.goto('/');
	await expect(page.getByTestId('study-remaining')).toHaveText('W kolejce: 10');
	await expect(page.getByText('Это наш дом.', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveAttribute('lang', 'pl');
	await page.screenshot({ path: `.wrangler/playwright/study-answer-${testInfo.project.name}-${page.viewportSize()!.width}.png`, fullPage: true, animations: 'disabled', scale: 'css' });
	for (const card of cards.slice(0, 7)) {
		await answer(page, card.pl);
		expect(refills).toHaveLength(0);
		await page.getByRole('button', { name: 'Dalej', exact: true }).click();
	}
	await received.promise;
	try {
		await expect(page.getByTestId('study-term')).toHaveText('Дом 8');
		await expect(page.getByTestId('study-remaining')).toHaveText('W kolejce: 3');
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		expect(refills).toHaveLength(1);
		const params = new URL(refills[0]).searchParams;
		expect(params.get('limit')).toBe('7');
		expect(params.get('exclude')?.split(',')).toEqual(cards.slice(7, 10).map(card => card.id));
		expect(reviews).toHaveLength(7);
		await answer(page, cards[7].pl);
		await page.getByRole('button', { name: 'Dalej', exact: true }).click();
		await expect(page.getByTestId('study-term')).toHaveText('Дом 9');
		expect(refills).toHaveLength(1);
	} finally { release.resolve(); }
	await expect(page.getByTestId('study-remaining')).toHaveText('W kolejce: 9');
	for (const card of cards.slice(8)) {
		await expect(page.getByTestId('study-term')).toHaveText(card.ru);
		await answer(page, card.pl);
		await page.getByRole('button', { name: 'Dalej', exact: true }).click();
	}
	await expect(page.getByText('Na dziś wszystko gotowe.', { exact: true })).toBeVisible();
	expect(reviews.map(review => review.cardId)).toEqual(cards.map(card => card.id));
});

for (const scenario of [
	{ name: 'Check in RU -> PL', direction: 'ru-pl', action: 'Sprawdź', label: 'Odpowiedź po polsku', answer: 'Dom', target: 'To nasz dom.' },
	{ name: 'Reveal in RU -> PL', direction: 'ru-pl', action: 'Pokaż odpowiedź', label: 'Odpowiedź po polsku', answer: 'Dom', target: 'To nasz dom.' },
	{ name: 'Check in PL -> RU', direction: 'pl-ru', action: 'Sprawdź', label: 'Odpowiedź po rosyjsku', answer: 'Дом', target: 'Это наш дом.' },
	{ name: 'Reveal in PL -> RU', direction: 'pl-ru', action: 'Pokaż odpowiedź', label: 'Odpowiedź po rosyjsku', answer: 'Дом', target: 'Это наш дом.' },
]) test(`shows both usage examples after ${scenario.name}`, async ({ page }) => {
	await seed(page);
	await page.goto('/');
	if (scenario.direction === 'pl-ru') await page.getByRole('button', { name: 'PL -> RU', exact: true }).click();
	await expect(page.getByLabel(scenario.label)).toBeEnabled();
	await expect(page.getByText(scenario.target, { exact: true })).toHaveCount(0);
	if (scenario.action === 'Sprawdź') await page.getByLabel(scenario.label).fill(scenario.answer);
	await page.getByRole('button', { name: scenario.action, exact: true }).click();
	await expect(page.getByRole('button', { name: 'Dalej', exact: true })).toBeVisible();
	await expect(page.getByText('To nasz dom.', { exact: true })).toBeVisible();
	await expect(page.getByText('Это наш дом.', { exact: true })).toBeVisible();
});

test('changes the direction in one step and keeps the card in place', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	const term = page.getByTestId('study-term');
	await expect(term).toHaveText('Дом');
	const top = (await term.boundingBox())!.y;
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/study?*', async route => { received.resolve(); await release.promise; await route.continue(); });
	await page.getByLabel('PL -> RU', { exact: true }).click();
	await received.promise;
	try {
		await expect(page.getByText('Zapisywanie kierunku…', { exact: true })).toBeAttached();
		await expect(page.getByRole('button', { name: 'Nauka', exact: true })).toBeDisabled();
		// The busy status and the dimmed controls appear only after 0.4 s.
		expect(await page.evaluate(() => {
			const status = [...document.querySelectorAll('[role="status"]')].find(node => node.textContent === 'Zapisywanie kierunku…')!;
			const tab = document.querySelector('.tabs button')!;
			const animations = [...status.getAnimations(), ...tab.getAnimations()];
			animations.forEach(animation => animation.pause());
			return [0, 1000].map(time => {
				animations.forEach(animation => { animation.currentTime = time; });
				return [getComputedStyle(status).opacity, getComputedStyle(tab).opacity];
			});
		})).toEqual([['0', '1'], ['1', '0.45']]);
		await expect(page.getByText('Zapisywanie kierunku…', { exact: true })).toBeVisible();
		await expect(term).toHaveText('Дом');
		expect((await term.boundingBox())!.y).toBe(top);
	} finally { release.resolve(); }
	await expect(term).toHaveText('Dom');
	expect((await term.boundingBox())!.y).toBe(top);
	await expect(page.getByLabel('PL -> RU', { exact: true })).toHaveAttribute('aria-pressed', 'true');
});

for (const scenario of [
	{ name: 'direction changes', change: 'direction' },
	{ name: 'account changes', change: 'account' },
]) test(`ignores an old refill after ${scenario.name}`, async ({ page }) => {
	const cards = await seed(page, 17);
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
	let reviews = 0;
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) reviews++; });
	await page.route('**/api/study?*', async route => {
		if (!new URL(route.request().url()).searchParams.get('exclude')) return route.continue();
		const response = await route.fetch();
		received.resolve();
		await release.promise;
		await route.fulfill({ response });
		finished.resolve();
	});
	await page.goto('/');
	await reachRefill(page, cards);
	await received.promise;
	try {
		await archive(page, cards[0].id);
		if (scenario.change === 'direction') {
			await page.getByLabel('PL -> RU', { exact: true }).click();
			await expect(page.getByLabel('PL -> RU', { exact: true })).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByTestId('study-term')).toHaveText('Dom');
		} else {
			await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
			await login(page, USER_B);
			await expect(page.getByTestId('study-term')).toHaveText('Дом');
		}
	} finally { release.resolve(); }
	await finished.promise;
	await expect(page.getByTestId('study-remaining')).toHaveText('W kolejce: 1');
	expect(reviews).toBe(7);
	await page.getByLabel(scenario.change === 'direction' ? 'Odpowiedź po rosyjsku' : 'Odpowiedź po polsku').fill(scenario.change === 'direction' ? 'Дом' : 'Dom');
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await page.getByRole('button', { name: 'Dalej', exact: true }).click();
	await expect(page.getByText('Na dziś wszystko gotowe.', { exact: true })).toBeVisible();
});

test('keeps the remaining cards and typed text after a failed refill', async ({ page }) => {
	const cards = await seed(page, 11);
	await page.route('**/api/study?*', route => new URL(route.request().url()).searchParams.get('exclude')
		? route.fulfill({ status: 503, json: { code: 'internal_error', error: 'Kolejka jest chwilowo niedostępna.' } }) : route.continue());
	await page.goto('/');
	await reachRefill(page, cards);
	await expect(page.getByRole('alert')).toContainText('Kolejka jest chwilowo niedostępna.');
	await expect(page.getByTestId('study-term')).toHaveText('Дом 8');
	await page.getByLabel('Odpowiedź po polsku').fill('мой ответ');
	await page.unroute('**/api/study?*');
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	await expect(page.getByTestId('study-remaining')).toHaveText('W kolejce: 4');
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('мой ответ');
});

test('keeps an uncertain review retry visible when an older refill succeeds', async ({ page }) => {
	const cards = await seed(page, 17);
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
	await page.route('**/api/study?*', async route => {
		if (!new URL(route.request().url()).searchParams.get('exclude')) return route.continue();
		const response = await route.fetch();
		received.resolve();
		await release.promise;
		await route.fulfill({ response });
		finished.resolve();
	});
	await page.goto('/');
	await reachRefill(page, cards);
	await received.promise;
	let original = '';
	await page.route('**/api/reviews', async route => {
		original = route.request().postData()!;
		expect((await route.fetch()).status()).toBe(200);
		await route.abort();
	});
	try {
		await page.getByLabel('Odpowiedź po polsku').fill('Dom 8');
		await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
		await expect(page.getByRole('alert')).toContainText('nie został potwierdzony');
	} finally { release.resolve(); }
	await finished.promise;
	await expect(page.getByRole('button', { name: 'Ponów', exact: true })).toBeVisible();
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('Dom 8');
	await page.unroute('**/api/reviews');
	const replay = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	expect((await replay).request().postData()).toBe(original);
	await expect(page.getByTestId('study-correction')).toHaveText('Dom 8');
});

test('shows an empty collection and refreshes it when the page becomes visible', async ({ page }) => {
	let reviews = 0;
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) reviews++; });
	await page.goto('/');
	await expect(page.getByText('Dodaj słówko, aby zacząć.', { exact: true })).toBeVisible();
	await seed(page);
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(page.getByTestId('study-term')).toHaveText('Дом');
	expect(reviews).toBe(0);
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toBeVisible();
});

for (const scenario of [
	{ name: 'wakes when a card becomes due on a visible page', hidden: false },
	{ name: 'waits for visibility when a card becomes due in the background', hidden: true },
]) test(scenario.name, async ({ page }) => {
	const [card] = await seed(page);
	expect((await page.request.post('/api/reviews', { headers, data: { attemptId: crypto.randomUUID(), cardId: card.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'reveal' } })).status()).toBe(200);
	sql(`UPDATE review_state SET due_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 4000 WHERE card_id = '${card.id}'`);
	await page.goto('/');
	await expect(page.getByText('Na dziś wszystko gotowe.', { exact: true })).toBeVisible();
	await expect(page.getByText(/Następna powtórka:/)).toBeVisible();
	if (scenario.hidden) {
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await expect.poll(async () => ((await (await page.request.get('/api/study?direction=ru-pl')).json()) as StudyBatch).cards.length).toBe(1);
		await expect(page.getByTestId('study-term')).toHaveCount(0);
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
			document.dispatchEvent(new Event('visibilitychange'));
		});
	}
	await expect(page.getByTestId('study-term')).toHaveText('Дом');
});

for (const scenario of [
	{ name: 'Check RU -> PL', direction: 'ru-pl', action: 'answer', label: 'Odpowiedź po polsku', answer: '  DOM  ', correction: 'Dom', grade: 'Dobrze', stage: 1 },
	{ name: 'Reveal RU -> PL', direction: 'ru-pl', action: 'reveal', label: 'Odpowiedź po polsku', answer: '', correction: 'Dom', grade: 'Powtórz', stage: 0 },
	{ name: 'Check PL -> RU', direction: 'pl-ru', action: 'answer', label: 'Odpowiedź po rosyjsku', answer: '  ДОМ  ', correction: 'Дом', grade: 'Dobrze', stage: 1 },
	{ name: 'Reveal PL -> RU', direction: 'pl-ru', action: 'reveal', label: 'Odpowiedź po rosyjsku', answer: '', correction: 'Дом', grade: 'Powtórz', stage: 0 },
]) test(`retries stored ${scenario.name} with its frozen envelope after reload and shows its original examples`, async ({ page }, testInfo) => {
	const [card] = await seed(page);
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	let original = '', stored: ReviewResult | undefined;
	await page.route('**/api/reviews', async route => {
		original = route.request().postData()!;
		const response = await route.fetch();
		expect(response.status()).toBe(200);
		stored = await response.json();
		received.resolve();
		await release.promise;
		await route.abort();
	});
	await page.goto('/');
	if (scenario.direction === 'pl-ru') await page.getByLabel('PL -> RU', { exact: true }).click();
	await page.getByLabel(scenario.label).fill(scenario.answer);
	if (scenario.action === 'answer') await page.getByLabel(scenario.label).press('Enter');
	else await page.getByRole('button', { name: 'Pokaż odpowiedź', exact: true }).click();
	await received.promise;
	try {
		await expect(page.getByLabel('PL -> RU', { exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Sprawdź', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Pokaż odpowiedź', exact: true })).toBeDisabled();
		await expect(page.getByLabel(scenario.label)).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Dalej', exact: true })).toHaveCount(0);
		expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).pending, `study-draft:${USER_A.id}`)).toBe(original);
		expect(JSON.parse(original)).toEqual({ attemptId: expect.any(String), cardId: card.id, cardVersion: 1, progressVersion: 0, direction: scenario.direction,
			...(scenario.action === 'answer' ? { action: 'answer', answer: scenario.answer } : { action: 'reveal' }) });
	} finally { release.resolve(); }
	await expect(page.getByRole('alert')).toContainText('nie został potwierdzony');
	await expect(page.getByLabel(scenario.label)).toHaveValue(scenario.answer);
	expect(((await (await page.request.get(`/api/study?direction=${scenario.direction}`)).json()) as StudyBatch).cards).toEqual([]);
	expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { ...CARD_B, id: undefined, version: 1, examplePl: 'To inny dom.', exampleRu: 'Это другой дом.' } })).status()).toBe(200);
	await page.unroute('**/api/reviews');
	await page.reload();
	await expect(page.getByLabel(scenario.label)).toHaveValue(scenario.answer);
	const replay = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	const response = await replay;
	expect(response.request().postData()).toBe(original);
	expect(await response.json()).toEqual(stored);
	await expect(page.getByRole('status').filter({ hasText: scenario.grade })).toBeVisible();
	await expect(page.getByTestId('study-correction')).toHaveText(scenario.correction);
	await expect(page.getByText('Это наш дом.', { exact: true })).toBeVisible();
	await expect(page.getByText('To nasz dom.', { exact: true })).toBeVisible();
	expect(stored).toMatchObject({ cardId: card.id, progress: { version: 1, stage: scenario.stage } });
	expect(await page.evaluate(key => sessionStorage.getItem(key), `study-draft:${USER_A.id}`)).toBeNull();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: `.wrangler/playwright/study-feedback-${testInfo.project.name}-${page.viewportSize()!.width}-${scenario.direction}-${scenario.action}.png`, fullPage: true, animations: 'disabled', scale: 'css' });
	await page.getByRole('button', { name: 'Dalej', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByText('Na dziś wszystko gotowe.', { exact: true })).toBeVisible();
	await expect(page.getByText('Это наш дом.', { exact: true })).toHaveCount(0);
	await expect(page.getByText('To nasz dom.', { exact: true })).toHaveCount(0);
});

test('retains expired-session input for its account without showing or sending it for another account', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByLabel('Słowo lub wyrażenie').fill('личный черновик');
	await page.getByRole('button', { name: 'Nauka', exact: true }).click();
	await page.getByLabel('Odpowiedź po polsku').fill('  Dom ');
	sql(`UPDATE sessions SET expires_at = 0 WHERE user_id = '${USER_A.id}'`);
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Zaloguj', exact: true })).toBeVisible();
	const original = await page.evaluate(key => sessionStorage.getItem(key), `study-draft:${USER_A.id}`);
	expect(original).toContain('  Dom ');
	let sent = 0;
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) sent++; });
	await login(page, USER_B);
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('');
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('');
	await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
	expect(sent).toBe(0);
	expect(await page.evaluate(key => sessionStorage.getItem(key), `study-draft:${USER_A.id}`)).toBe(original);
	await login(page);
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('  Dom ');
	const replay = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	expect((await replay).request().postData()).toBe(JSON.parse(original!).pending);
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('личный черновик');
});

test('clears Add and Study recovery on deliberate logout', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('личный ответ');
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByLabel('Słowo lub wyrażenie').fill('личный черновик');
	await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Zaloguj', exact: true })).toBeVisible();
	expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
	await login(page);
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('');
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('');
});

test('confirms direction changes with input and keeps the saved direction when Study remounts', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('мой ответ');
	page.once('dialog', dialog => dialog.dismiss());
	await page.getByLabel('PL -> RU', { exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('RU -> PL', { exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('мой ответ');
	page.once('dialog', dialog => dialog.accept());
	await page.keyboard.press('Space');
	await expect(page.getByTestId('study-term')).toHaveText('Dom');
	await expect(page.getByLabel('Odpowiedź po rosyjsku')).toHaveValue('');
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByRole('button', { name: 'Nauka', exact: true }).click();
	await expect(page.getByLabel('PL -> RU', { exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('study-term')).toHaveText('Dom');
	await page.reload();
	await expect(page.getByLabel('PL -> RU', { exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('retains an editable answer on provider 401 without expiring the app session', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('ошибка подключения');
	const failed = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	expect((await failed).status()).toBe(503);
	await expect(page.getByRole('alert')).toContainText('Model AI nie jest skonfigurowany. Poproś właściciela o sprawdzenie klucza API.');
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('ошибка подключения');
	await expect(page.getByRole('button', { name: 'Wyloguj', exact: true })).toBeVisible();
	expect(((await (await page.request.get('/api/study?direction=ru-pl')).json()) as StudyBatch).cards[0].progress).toBeNull();
	await expect(page.getByLabel('Odpowiedź po polsku')).toBeEnabled();
	await page.getByLabel('Odpowiedź po polsku').fill('Dom');
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
});

test('restores editing and Reveal after a usage limit and reload', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('лимит');
	const failed = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	expect((await failed).status()).toBe(429);
	await expect(page.getByLabel('Odpowiedź po polsku')).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Pokaż odpowiedź', exact: true })).toBeEnabled();
	expect(((await (await page.request.get('/api/study')).json()) as StudyBatch).cards[0].progress).toBeNull();
	await page.reload();
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('лимит');
	await page.getByLabel('Odpowiedź po polsku').fill('мой ответ');
	await page.getByRole('button', { name: 'Pokaż odpowiedź', exact: true }).click();
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
});

for (const scenario of [
	{ name: 'its original card', archived: false, term: 'Дом' },
	{ name: 'a separate retained answer when the card is archived', archived: true, term: 'Дом 2' },
]) test(`restores a rejected pending review without a loaded queue to ${scenario.name}`, async ({ page }) => {
	const [card] = await seed(page, 2);
	await page.route('**/api/reviews', async route => { await route.fetch(); await route.abort(); });
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('ошибка подключения');
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('nie został potwierdzony');
	await page.unroute('**/api/reviews');
	await page.reload();
	if (scenario.archived) await page.route('**/api/reviews', async route => {
		const response = await route.fetch();
		expect(response.status()).toBe(503);
		expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { version: 1, archived: true } })).status()).toBe(200);
		await route.fulfill({ response });
	});
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	await expect(page.getByTestId('study-term')).toHaveText(scenario.term);
	await expect(page.getByLabel('Odpowiedź po polsku')).toBeEnabled();
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue(scenario.archived ? '' : 'ошибка подключения');
	if (scenario.archived) await expect(page.getByLabel('Zapisana odpowiedź')).toHaveValue('ошибка подключения');
	await page.unroute('**/api/reviews');
	await page.getByRole('button', { name: 'Pokaż odpowiedź', exact: true }).click();
	await expect(page.getByTestId('study-correction')).toHaveText(scenario.archived ? 'Dom 2' : 'Dom');
});

for (const scenario of [
	{ name: 'HTTP 500', status: 500 },
	{ name: 'HTTP 503', status: 503 },
]) test(`keeps an exact frozen retry after an uncertain ${scenario.name}`, async ({ page }) => {
	await seed(page);
	let original = '';
	await page.route('**/api/reviews', async route => {
		original = route.request().postData()!;
		expect((await route.fetch()).status()).toBe(200);
		await route.fulfill({ status: scenario.status, json: { code: 'internal_error', error: 'Nieznany wynik zapisu.' } });
	});
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('Dom');
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Nieznany wynik');
	await expect(page.getByLabel('Odpowiedź po polsku')).toBeDisabled();
	await page.unroute('**/api/reviews');
	await page.reload();
	await expect(page.getByRole('button', { name: 'Pokaż odpowiedź', exact: true })).toBeDisabled();
	const replay = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	expect((await replay).request().postData()).toBe(original);
	expect(await (await replay).json()).toMatchObject({ progress: { version: 1 } });
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
});

for (const scenario of [
	{ name: 'almost correct', answer: 'domu', button: 'Sprawdź', feedback: 'Prawie dobrze', stage: 0 },
	{ name: 'reveal', answer: '', button: 'Pokaż odpowiedź', feedback: 'Powtórz', stage: 0 },
]) test(`announces ${scenario.name} feedback after a saved review`, async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill(scenario.answer);
	const saved = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: scenario.button, exact: true }).click();
	expect((await saved).status()).toBe(200);
	expect((await (await saved).json()).progress.stage).toBe(scenario.stage);
	await expect(page.getByRole('status').filter({ hasText: scenario.feedback })).toBeVisible();
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
});

for (const scenario of [
	{ name: 'a shared card edit', change: 'card' },
	{ name: 'progress saved in another tab', change: 'progress' },
]) test(`reloads the queue after ${scenario.name} and retains the old answer for copying`, async ({ page }) => {
	const [card] = await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('Dom');
	if (scenario.change === 'card') {
		expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { ...CARD_B, id: undefined, version: 1, ru: 'Жилище' } })).status()).toBe(200);
	} else {
		expect((await page.request.post('/api/reviews', { headers, data: { attemptId: crypto.randomUUID(), cardId: card.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Dom' } })).status()).toBe(200);
	}
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await expect(page.getByLabel('Zapisana odpowiedź')).toHaveValue('Dom');
	if (scenario.change === 'card') {
		await expect(page.getByTestId('study-term')).toHaveText('Жилище');
		await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('');
	} else await expect(page.getByText('Na dziś wszystko gotowe.', { exact: true })).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Zapisana odpowiedź')).toHaveValue('Dom');
});

test('does not send a review when its recovery envelope cannot be stored', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('Dom');
	let sent = 0;
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) sent++; });
	await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage is full.', 'QuotaExceededError'); }; });
	await page.getByRole('button', { name: 'Sprawdź', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Przeglądarka nie zapisała odpowiedzi');
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('Dom');
	await expect(page.getByLabel('Odpowiedź po polsku')).toBeEnabled();
	expect(sent).toBe(0);
});

for (const scenario of [
	{ name: 'restores unsent input on its original card', completed: false },
	{ name: 'keeps unsent input separate when its original card is no longer due', completed: true },
]) test(scenario.name, async ({ page }) => {
	const [card] = await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill(' Dom ');
	if (scenario.completed) {
		expect((await page.request.post('/api/reviews', { headers, data: { attemptId: crypto.randomUUID(), cardId: card.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Dom' } })).status()).toBe(200);
	}
	await page.reload();
	if (scenario.completed) {
		await expect(page.getByLabel('Zapisana odpowiedź')).toHaveValue(' Dom ');
		await expect(page.getByTestId('study-term')).toHaveCount(0);
	} else {
		await expect(page.getByTestId('study-term')).toHaveText('Дом');
		await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue(' Dom ');
	}
});

test('keeps input after a lost direction response and retries the direction save', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Odpowiedź po polsku').fill('сохранить этот ответ');
	await page.route('**/api/me', async route => { await route.fetch(); await route.abort(); });
	page.once('dialog', dialog => dialog.accept());
	await page.getByLabel('PL -> RU', { exact: true }).click();
	await expect(page.getByRole('alert')).toBeVisible();
	await expect(page.getByLabel('Odpowiedź po polsku')).toHaveValue('сохранить этот ответ');
	await page.unroute('**/api/me');
	page.once('dialog', dialog => dialog.accept());
	await page.getByRole('button', { name: 'Ponów', exact: true }).click();
	await expect(page.getByLabel('PL -> RU', { exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('study-term')).toHaveText('Dom');
});

test('does not send an empty or space-only answer when Enter is pressed after Dalej', async ({ page, hasTouch }) => {
	test.skip(hasTouch, 'Touch devices do not focus the answer field.');
	const cards = await seed(page, 2);
	await page.goto('/');
	await answer(page, cards[0].pl);
	await expect(page.getByRole('button', { name: 'Dalej', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('Odpowiedź po polsku')).toBeFocused();
	const saved = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.keyboard.press('Enter');
	await page.keyboard.type(' ');
	await page.keyboard.press('Enter');
	await page.keyboard.type(cards[1].pl);
	await page.keyboard.press('Enter');
	expect((await saved).request().postDataJSON()).toMatchObject({ action: 'answer', answer: ` ${cards[1].pl}` });
});
