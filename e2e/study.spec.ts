import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import type { Card, CardPage, ReviewInput, ReviewResult, StudyBatch } from '../shared/types';
import { CARD_B, USER_A, USER_B } from '../test/fixtures';

let headers: Record<string, string>;

async function login(page: Page, user = USER_A) {
	await page.getByLabel('Имя пользователя').fill(user.username);
	await page.getByLabel('Пароль', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await expect(page.getByText(user.displayName, { exact: true })).toBeVisible();
}

async function archive(page: Page, keep?: string) {
	const list: CardPage = await (await page.request.get('/api/cards')).json();
	for (const card of list.cards.filter(card => card.id !== keep)) {
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
	await page.getByLabel('Ответ по-польски').fill(text);
	await page.getByLabel('Ответ по-польски').press('Enter');
	await expect(page.getByRole('status').filter({ hasText: 'Верно' })).toBeVisible();
}

async function reachRefill(page: Page, cards: Card[]) {
	for (const card of cards.slice(0, 7)) {
		await expect(page.getByTestId('study-term')).toHaveText(card.ru);
		await answer(page, card.pl);
		await page.getByRole('button', { name: 'Дальше', exact: true }).click();
	}
}

async function connect(page: Page) {
	const start = await page.request.post('/api/ai/connection/start', { headers });
	const url = new URL((await start.json()).url);
	const callback = new URL(url.searchParams.get('redirect_uri')!);
	callback.search = new URLSearchParams({ code: `a:${url.searchParams.get('nonce')}`, state: url.searchParams.get('state')!, client_id: 'oaiapp_a' }).toString();
	expect((await page.request.post('/api/ai/connection/finish', { headers, data: { address: callback.href } })).status()).toBe(200);
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
	expect((await page.request.delete('/api/ai/connection', { headers })).status()).toBe(200);
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
	await expect(page.getByTestId('study-remaining')).toHaveText('В очереди: 10');
	await expect(page.getByText('Это наш дом.', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Ответ по-польски')).toHaveAttribute('lang', 'pl');
	await page.screenshot({ path: `.wrangler/playwright/study-answer-${testInfo.project.name}.png`, fullPage: true });
	for (const card of cards.slice(0, 7)) {
		await answer(page, card.pl);
		expect(refills).toHaveLength(0);
		await page.getByRole('button', { name: 'Дальше', exact: true }).click();
	}
	await received.promise;
	try {
		await expect(page.getByTestId('study-term')).toHaveText('Дом 8');
		await expect(page.getByTestId('study-remaining')).toHaveText('В очереди: 3');
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		expect(refills).toHaveLength(1);
		const params = new URL(refills[0]).searchParams;
		expect(params.get('limit')).toBe('7');
		expect(params.get('exclude')?.split(',')).toEqual(cards.slice(7, 10).map(card => card.id));
		expect(reviews).toHaveLength(7);
		await answer(page, cards[7].pl);
		await page.getByRole('button', { name: 'Дальше', exact: true }).click();
		await expect(page.getByTestId('study-term')).toHaveText('Дом 9');
		expect(refills).toHaveLength(1);
	} finally { release.resolve(); }
	await expect(page.getByTestId('study-remaining')).toHaveText('В очереди: 9');
	for (const card of cards.slice(8)) {
		await expect(page.getByTestId('study-term')).toHaveText(card.ru);
		await answer(page, card.pl);
		await page.getByRole('button', { name: 'Дальше', exact: true }).click();
	}
	await expect(page.getByText('На сегодня всё готово.', { exact: true })).toBeVisible();
	expect(reviews.map(review => review.cardId)).toEqual(cards.map(card => card.id));
});

for (const scenario of [
	{ name: 'Check in RU -> PL', direction: 'ru-pl', action: 'Проверить', label: 'Ответ по-польски', answer: 'Dom', target: 'To nasz dom.' },
	{ name: 'Reveal in RU -> PL', direction: 'ru-pl', action: 'Показать ответ', label: 'Ответ по-польски', answer: 'Dom', target: 'To nasz dom.' },
	{ name: 'Check in PL -> RU', direction: 'pl-ru', action: 'Проверить', label: 'Ответ по-русски', answer: 'Дом', target: 'Это наш дом.' },
	{ name: 'Reveal in PL -> RU', direction: 'pl-ru', action: 'Показать ответ', label: 'Ответ по-русски', answer: 'Дом', target: 'Это наш дом.' },
]) test(`shows both usage examples after ${scenario.name}`, async ({ page }) => {
	await seed(page);
	await page.goto('/');
	if (scenario.direction === 'pl-ru') await page.getByRole('button', { name: 'PL -> RU', exact: true }).click();
	await expect(page.getByLabel(scenario.label)).toBeEnabled();
	await expect(page.getByText(scenario.target, { exact: true })).toHaveCount(0);
	if (scenario.action === 'Проверить') await page.getByLabel(scenario.label).fill(scenario.answer);
	await page.getByRole('button', { name: scenario.action, exact: true }).click();
	await expect(page.getByRole('button', { name: 'Дальше', exact: true })).toBeVisible();
	await expect(page.getByText('To nasz dom.', { exact: true })).toBeVisible();
	await expect(page.getByText('Это наш дом.', { exact: true })).toBeVisible();
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
			await page.getByRole('button', { name: 'Выйти', exact: true }).click();
			await login(page, USER_B);
			await expect(page.getByTestId('study-term')).toHaveText('Дом');
		}
	} finally { release.resolve(); }
	await finished.promise;
	await expect(page.getByTestId('study-remaining')).toHaveText('В очереди: 1');
	expect(reviews).toBe(7);
	await page.getByLabel(scenario.change === 'direction' ? 'Ответ по-русски' : 'Ответ по-польски').fill(scenario.change === 'direction' ? 'Дом' : 'Dom');
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await page.getByRole('button', { name: 'Дальше', exact: true }).click();
	await expect(page.getByText('На сегодня всё готово.', { exact: true })).toBeVisible();
});

test('keeps the remaining cards and typed text after a failed refill', async ({ page }) => {
	const cards = await seed(page, 11);
	await page.route('**/api/study?*', route => new URL(route.request().url()).searchParams.get('exclude')
		? route.fulfill({ status: 503, json: { code: 'internal_error', error: 'Очередь временно недоступна.' } }) : route.continue());
	await page.goto('/');
	await reachRefill(page, cards);
	await expect(page.getByRole('alert')).toContainText('Очередь временно недоступна.');
	await expect(page.getByTestId('study-term')).toHaveText('Дом 8');
	await page.getByLabel('Ответ по-польски').fill('мой ответ');
	await page.unroute('**/api/study?*');
	await page.getByRole('button', { name: 'Повторить', exact: true }).click();
	await expect(page.getByTestId('study-remaining')).toHaveText('В очереди: 4');
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('мой ответ');
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
		await page.getByLabel('Ответ по-польски').fill('Dom 8');
		await page.getByRole('button', { name: 'Проверить', exact: true }).click();
		await expect(page.getByRole('alert')).toContainText('не подтверждено');
	} finally { release.resolve(); }
	await finished.promise;
	await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeVisible();
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('Dom 8');
	await page.unroute('**/api/reviews');
	const replay = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Повторить', exact: true }).click();
	expect((await replay).request().postData()).toBe(original);
	await expect(page.getByTestId('study-correction')).toHaveText('Dom 8');
});

test('shows an empty collection and refreshes it when the page becomes visible', async ({ page }) => {
	let reviews = 0;
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) reviews++; });
	await page.goto('/');
	await expect(page.getByText('Добавьте слово, чтобы начать.', { exact: true })).toBeVisible();
	await seed(page);
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(page.getByTestId('study-term')).toHaveText('Дом');
	expect(reviews).toBe(0);
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toBeVisible();
});

for (const scenario of [
	{ name: 'wakes when a card becomes due on a visible page', hidden: false },
	{ name: 'waits for visibility when a card becomes due in the background', hidden: true },
]) test(scenario.name, async ({ page }) => {
	const [card] = await seed(page);
	expect((await page.request.post('/api/reviews', { headers, data: { attemptId: crypto.randomUUID(), cardId: card.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'reveal' } })).status()).toBe(200);
	sql(`UPDATE review_state SET due_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 4000 WHERE card_id = '${card.id}'`);
	await page.goto('/');
	await expect(page.getByText('На сегодня всё готово.', { exact: true })).toBeVisible();
	await expect(page.getByText(/Следующее повторение:/)).toBeVisible();
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
	{ name: 'Check RU -> PL', direction: 'ru-pl', action: 'answer', label: 'Ответ по-польски', answer: '  DOM  ', correction: 'Dom', grade: 'Верно', stage: 1 },
	{ name: 'Reveal RU -> PL', direction: 'ru-pl', action: 'reveal', label: 'Ответ по-польски', answer: '', correction: 'Dom', grade: 'Повторите', stage: 0 },
	{ name: 'Check PL -> RU', direction: 'pl-ru', action: 'answer', label: 'Ответ по-русски', answer: '  ДОМ  ', correction: 'Дом', grade: 'Верно', stage: 1 },
	{ name: 'Reveal PL -> RU', direction: 'pl-ru', action: 'reveal', label: 'Ответ по-русски', answer: '', correction: 'Дом', grade: 'Повторите', stage: 0 },
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
	else await page.getByRole('button', { name: 'Показать ответ', exact: true }).click();
	await received.promise;
	try {
		await expect(page.getByLabel('PL -> RU', { exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Проверить', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Показать ответ', exact: true })).toBeDisabled();
		await expect(page.getByLabel(scenario.label)).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Дальше', exact: true })).toHaveCount(0);
		expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).pending, `study-draft:${USER_A.id}`)).toBe(original);
		expect(JSON.parse(original)).toEqual({ attemptId: expect.any(String), cardId: card.id, cardVersion: 1, progressVersion: 0, direction: scenario.direction,
			...(scenario.action === 'answer' ? { action: 'answer', answer: scenario.answer } : { action: 'reveal' }) });
	} finally { release.resolve(); }
	await expect(page.getByRole('alert')).toContainText('не подтверждено');
	await expect(page.getByLabel(scenario.label)).toHaveValue(scenario.answer);
	expect(((await (await page.request.get(`/api/study?direction=${scenario.direction}`)).json()) as StudyBatch).cards).toEqual([]);
	expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { ...CARD_B, id: undefined, version: 1, examplePl: 'To inny dom.', exampleRu: 'Это другой дом.' } })).status()).toBe(200);
	await page.unroute('**/api/reviews');
	await page.reload();
	await expect(page.getByLabel(scenario.label)).toHaveValue(scenario.answer);
	const replay = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Повторить', exact: true }).click();
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
	await page.screenshot({ path: `.wrangler/playwright/study-feedback-${testInfo.project.name}-${scenario.direction}-${scenario.action}.png`, fullPage: true });
	await page.getByRole('button', { name: 'Дальше', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByText('На сегодня всё готово.', { exact: true })).toBeVisible();
	await expect(page.getByText('Это наш дом.', { exact: true })).toHaveCount(0);
	await expect(page.getByText('To nasz dom.', { exact: true })).toHaveCount(0);
});

test('retains expired-session input for its account without showing or sending it for another account', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel('Слово или выражение').fill('личный черновик');
	await page.getByRole('button', { name: 'Учить', exact: true }).click();
	await page.getByLabel('Ответ по-польски').fill('  Dom ');
	sql(`UPDATE sessions SET expires_at = 0 WHERE user_id = '${USER_A.id}'`);
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
	const original = await page.evaluate(key => sessionStorage.getItem(key), `study-draft:${USER_A.id}`);
	expect(original).toContain('  Dom ');
	let sent = 0;
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) sent++; });
	await login(page, USER_B);
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('');
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('');
	await page.getByRole('button', { name: 'Выйти', exact: true }).click();
	expect(sent).toBe(0);
	expect(await page.evaluate(key => sessionStorage.getItem(key), `study-draft:${USER_A.id}`)).toBe(original);
	await login(page);
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('  Dom ');
	const replay = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Повторить', exact: true }).click();
	expect((await replay).request().postData()).toBe(JSON.parse(original!).pending);
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('личный черновик');
});

test('clears Add and Study recovery on deliberate logout', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill('личный ответ');
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByLabel('Слово или выражение').fill('личный черновик');
	await page.getByRole('button', { name: 'Выйти', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
	expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
	await login(page);
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('');
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await expect(page.getByLabel('Слово или выражение')).toHaveValue('');
});

test('confirms direction changes with input and keeps the saved direction when Study remounts', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill('мой ответ');
	page.once('dialog', dialog => dialog.dismiss());
	await page.getByLabel('PL -> RU', { exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('RU -> PL', { exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('мой ответ');
	page.once('dialog', dialog => dialog.accept());
	await page.keyboard.press('Space');
	await expect(page.getByTestId('study-term')).toHaveText('Dom');
	await expect(page.getByLabel('Ответ по-русски')).toHaveValue('');
	await page.getByRole('button', { name: 'Добавить', exact: true }).click();
	await page.getByRole('button', { name: 'Учить', exact: true }).click();
	await expect(page.getByLabel('PL -> RU', { exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('study-term')).toHaveText('Dom');
	await page.reload();
	await expect(page.getByLabel('PL -> RU', { exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('retains an editable answer on provider 401 without expiring the app session', async ({ page }) => {
	await seed(page);
	await connect(page);
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill('ошибка подключения');
	const failed = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	expect((await failed).status()).toBe(401);
	await expect(page.getByRole('alert')).toContainText('ChatGPT не принял подключение');
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('ошибка подключения');
	await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
	expect(((await (await page.request.get('/api/study?direction=ru-pl')).json()) as StudyBatch).cards[0].progress).toBeNull();
	await expect(page.getByLabel('Ответ по-польски')).toBeEnabled();
	await page.getByLabel('Ответ по-польски').fill('Dom');
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
});

for (const scenario of [
	{ name: 'disconnected grading', connected: false, answer: 'domu', status: 409 },
	{ name: 'usage limit', connected: true, answer: 'лимит', status: 429 },
]) test(`restores editing and Reveal after ${scenario.name} and reload`, async ({ page }) => {
	await seed(page);
	if (scenario.connected) await connect(page);
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill(scenario.answer);
	const failed = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	expect((await failed).status()).toBe(scenario.status);
	await expect(page.getByLabel('Ответ по-польски')).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Показать ответ', exact: true })).toBeEnabled();
	expect(((await (await page.request.get('/api/study')).json()) as StudyBatch).cards[0].progress).toBeNull();
	await page.reload();
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue(scenario.answer);
	await page.getByLabel('Ответ по-польски').fill('мой ответ');
	await page.getByRole('button', { name: 'Показать ответ', exact: true }).click();
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
});

for (const scenario of [
	{ name: 'its original card', archived: false, term: 'Дом' },
	{ name: 'a separate retained answer when the card is archived', archived: true, term: 'Дом 2' },
]) test(`restores a rejected pending review without a loaded queue to ${scenario.name}`, async ({ page }) => {
	const [card] = await seed(page, 2);
	await page.route('**/api/reviews', async route => { await route.fetch(); await route.abort(); });
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill('domu');
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('не подтверждено');
	await page.unroute('**/api/reviews');
	await page.reload();
	if (scenario.archived) await page.route('**/api/reviews', async route => {
		const response = await route.fetch();
		expect(response.status()).toBe(409);
		expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { version: 1, archived: true } })).status()).toBe(200);
		await route.fulfill({ response });
	});
	await page.getByRole('button', { name: 'Повторить', exact: true }).click();
	await expect(page.getByTestId('study-term')).toHaveText(scenario.term);
	await expect(page.getByLabel('Ответ по-польски')).toBeEnabled();
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue(scenario.archived ? '' : 'domu');
	if (scenario.archived) await expect(page.getByLabel('Сохранённый ответ')).toHaveValue('domu');
	await page.unroute('**/api/reviews');
	await page.getByRole('button', { name: 'Показать ответ', exact: true }).click();
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
		await route.fulfill({ status: scenario.status, json: { code: 'internal_error', error: 'Неизвестный результат записи.' } });
	});
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill('Dom');
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Неизвестный результат');
	await expect(page.getByLabel('Ответ по-польски')).toBeDisabled();
	await page.unroute('**/api/reviews');
	await page.reload();
	await expect(page.getByRole('button', { name: 'Показать ответ', exact: true })).toBeDisabled();
	const replay = page.waitForResponse(response => response.url().endsWith('/api/reviews'));
	await page.getByRole('button', { name: 'Повторить', exact: true }).click();
	expect((await replay).request().postData()).toBe(original);
	expect(await (await replay).json()).toMatchObject({ progress: { version: 1 } });
	await expect(page.getByTestId('study-correction')).toHaveText('Dom');
});

for (const scenario of [
	{ name: 'almost correct', answer: 'domu', button: 'Проверить', feedback: 'Почти верно', stage: 0 },
	{ name: 'reveal', answer: '', button: 'Показать ответ', feedback: 'Повторите', stage: 0 },
]) test(`announces ${scenario.name} feedback after a saved review`, async ({ page }) => {
	await seed(page);
	if (scenario.answer) await connect(page);
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill(scenario.answer);
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
	await page.getByLabel('Ответ по-польски').fill('Dom');
	if (scenario.change === 'card') {
		expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { ...CARD_B, id: undefined, version: 1, ru: 'Жилище' } })).status()).toBe(200);
	} else {
		expect((await page.request.post('/api/reviews', { headers, data: { attemptId: crypto.randomUUID(), cardId: card.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Dom' } })).status()).toBe(200);
	}
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await expect(page.getByLabel('Сохранённый ответ')).toHaveValue('Dom');
	if (scenario.change === 'card') {
		await expect(page.getByTestId('study-term')).toHaveText('Жилище');
		await expect(page.getByLabel('Ответ по-польски')).toHaveValue('');
	} else await expect(page.getByText('На сегодня всё готово.', { exact: true })).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Сохранённый ответ')).toHaveValue('Dom');
});

test('does not send a review when its recovery envelope cannot be stored', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill('Dom');
	let sent = 0;
	page.on('request', request => { if (request.url().endsWith('/api/reviews')) sent++; });
	await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage is full.', 'QuotaExceededError'); }; });
	await page.getByRole('button', { name: 'Проверить', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Браузер не сохранил ответ');
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('Dom');
	await expect(page.getByLabel('Ответ по-польски')).toBeEnabled();
	expect(sent).toBe(0);
});

for (const scenario of [
	{ name: 'restores unsent input on its original card', completed: false },
	{ name: 'keeps unsent input separate when its original card is no longer due', completed: true },
]) test(scenario.name, async ({ page }) => {
	const [card] = await seed(page);
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill(' Dom ');
	if (scenario.completed) {
		expect((await page.request.post('/api/reviews', { headers, data: { attemptId: crypto.randomUUID(), cardId: card.id, cardVersion: 1, progressVersion: 0, direction: 'ru-pl', action: 'answer', answer: 'Dom' } })).status()).toBe(200);
	}
	await page.reload();
	if (scenario.completed) {
		await expect(page.getByLabel('Сохранённый ответ')).toHaveValue(' Dom ');
		await expect(page.getByTestId('study-term')).toHaveCount(0);
	} else {
		await expect(page.getByTestId('study-term')).toHaveText('Дом');
		await expect(page.getByLabel('Ответ по-польски')).toHaveValue(' Dom ');
	}
});

test('keeps input after a lost direction response and retries the direction save', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.getByLabel('Ответ по-польски').fill('сохранить этот ответ');
	await page.route('**/api/me', async route => { await route.fetch(); await route.abort(); });
	page.once('dialog', dialog => dialog.accept());
	await page.getByLabel('PL -> RU', { exact: true }).click();
	await expect(page.getByRole('alert')).toBeVisible();
	await expect(page.getByLabel('Ответ по-польски')).toHaveValue('сохранить этот ответ');
	await page.unroute('**/api/me');
	page.once('dialog', dialog => dialog.accept());
	await page.getByRole('button', { name: 'Повторить', exact: true }).click();
	await expect(page.getByLabel('PL -> RU', { exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('study-term')).toHaveText('Dom');
});
