import { expect, test, type Page } from '@playwright/test';
import { ONION_DRAFT, USER_A, USER_B, WORD_DRAFT } from '../test/fixtures';
import { allCards } from './cards';

let createdIds: string[];
test.beforeEach(async ({ page, baseURL }) => {
	createdIds = [];
	const headers = { Origin: baseURL!, 'CF-Connecting-IP': `add-${crypto.randomUUID()}` };
	await page.setExtraHTTPHeaders(headers);
	expect((await page.request.post('/api/session', { headers, data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	await page.goto('/');
});

test.afterEach(async ({ page, baseURL }) => {
	const headers = { Origin: baseURL! };
	const list = await allCards(page.request);
	for (const card of list.filter(card => createdIds.includes(card.id))) {
		expect((await page.request.patch(`/api/cards/${card.id}`, { headers, data: { version: card.version, archived: true } })).status()).toBe(200);
	}
});

async function loginForm(page: Page, user: typeof USER_A) {
	await page.getByLabel('Nazwa użytkownika').fill(user.username);
	await page.getByLabel('Hasło', { exact: true }).fill(user.password);
	await page.getByRole('button', { name: 'Zaloguj', exact: true }).click();
}

for (const scenario of [
	{ name: 'Polish typed input', text: 'słowo' },
	{ name: 'Russian typed input', text: 'слово' },
]) test(`prepares ${scenario.name} without selecting a language`, async ({ page }) => {
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByLabel('Słowo lub wyrażenie').fill(scenario.text);
	const generated = page.waitForResponse(response => response.url().endsWith('/api/cards/draft'));
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	expect((await generated).request().postDataJSON()).toEqual({ text: scenario.text });
	expect((await generated).status()).toBe(200);
	await expect(page.getByLabel('Język wprowadzania')).toHaveCount(0);
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveValue('Słowo');
	await expect(page.getByLabel('Po rosyjsku', { exact: true })).toHaveValue('Слово');
});

test('keeps similar words visible while the next search runs', async ({ page, baseURL }) => {
	const seedId = crypto.randomUUID();
	expect((await page.request.post('/api/cards', { headers: { Origin: baseURL! }, data: { id: seedId, ...WORD_DRAFT } })).status()).toBe(201);
	createdIds.push(seedId);
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	const input = page.getByLabel('Słowo lub wyrażenie'), similar = page.getByRole('complementary', { name: 'Podobne słówka' });
	await input.fill('słow');
	await expect(similar.getByRole('link', { name: 'Słowo / Слово', exact: true })).toBeVisible();
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/cards?*', async route => { received.resolve(); await release.promise; await route.continue(); });
	const searched = page.waitForResponse(response => response.url().includes('/api/cards?'));
	await input.press('o');
	await received.promise;
	try {
		await expect(similar.getByRole('link', { name: 'Słowo / Слово', exact: true })).toBeVisible();
	} finally { release.resolve(); }
	await searched;
	await page.unroute('**/api/cards?*');
	await input.fill('');
	await expect(similar).toHaveCount(0);
});

test('keeps the similar words area height while the number of matches changes', async ({ page, baseURL }) => {
	const token = `zq${crypto.randomUUID().slice(0, 6)}`;
	for (const word of ['jeden', 'dwa', 'trzy', 'cztery', 'pięć']) {
		const id = crypto.randomUUID();
		expect((await page.request.post('/api/cards', { headers: { Origin: baseURL! }, data: { ...WORD_DRAFT, id, pl: `${token} ${word}` } })).status()).toBe(201);
		createdIds.push(id);
	}
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	const input = page.getByLabel('Słowo lub wyrażenie'), similar = page.getByRole('complementary', { name: 'Podobne słówka' });
	const height = async () => (await similar.boundingBox())!.height;
	await input.fill(token);
	await expect(similar.getByRole('link')).toHaveCount(5);
	const full = await height();
	await input.fill(`${token} j`);
	await expect(similar.getByRole('link')).toHaveCount(1);
	expect(await height()).toBe(full);
	await input.fill(`${token} x`);
	await expect(similar.getByText('Brak podobnych słówek.', { exact: true })).toBeVisible();
	expect(await height()).toBe(full);
});

test('restores the selected meaning and resends it from Przygotuj fiszkę', async ({ page }) => {
	const draft = { id: crypto.randomUUID(), text: 'лук', meaningRu: 'Овощ', choices: [], card: { ...ONION_DRAFT, examplePl: 'To moja cebula.' } };
	await page.evaluate(({ key, draft }) => sessionStorage.setItem(key, JSON.stringify(draft)), { key: `card-draft:${USER_A.id}`, draft });
	await page.reload();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('лук');
	await expect(page.getByText('Wybrane znaczenie: Овощ', { exact: true })).toBeVisible();
	await expect(page.getByText('Wybrane znaczenie: Овощ', { exact: true }).locator('[lang="ru"]')).toHaveText('Овощ');
	await expect(page.getByLabel('Znaczenie (po rosyjsku)')).toHaveAttribute('lang', 'ru');
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To moja cebula.');
	const generated = page.waitForResponse(response => response.url().endsWith('/api/cards/draft'));
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	expect((await generated).request().postDataJSON()).toEqual({ text: 'лук', meaningRu: 'Овощ' });
	expect((await generated).status()).toBe(200);
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveValue('Cebula');
});

test('keeps an uncertain Save retry-only across reload and opens confirmed edits in Words', async ({ page, baseURL }) => {
	const seedId = crypto.randomUUID();
	expect((await page.request.post('/api/cards', { headers: { Origin: baseURL! }, data: { id: seedId, ...WORD_DRAFT } })).status()).toBe(201);
	createdIds.push(seedId);
	const before = (await allCards(page.request)).length;
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByLabel('Słowo lub wyrażenie').fill('słowo');
	await expect(page.getByText(WORD_DRAFT.meaningRu, { exact: true })).toHaveAttribute('lang', 'ru');
	await page.getByRole('link', { name: 'Słowo / Слово', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Słówka', exact: true })).toBeVisible();
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveValue('Słowo');
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('słowo');
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('Nie znam tego słowa.');
	await expect(page.getByLabel('Przykład po rosyjsku')).toHaveValue('Я не знаю этого слова.');
	expect(await allCards(page.request)).toHaveLength(before);
	await page.getByLabel('Po rosyjsku', { exact: true }).fill('Моё слово');
	await page.getByLabel('Przykład po polsku').fill('To moje słowo.');
	await page.getByLabel('Inne odpowiedzi po polsku').fill('Wyraz\n\n');
	let savedId = '';
	let submittedBody = '', storedBody: string | undefined;
	await page.route('**/api/cards', async route => {
		savedId = route.request().postDataJSON().id;
		submittedBody = route.request().postData()!;
		storedBody = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).submission, `card-draft:${USER_A.id}`);
		createdIds.push(savedId);
		expect((await route.fetch()).status()).toBe(201);
		await route.abort();
	});
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Brak połączenia z serwerem');
	await expect(page.getByLabel('Po rosyjsku', { exact: true })).toHaveValue('Моё слово');
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To moje słowo.');
	await expect(page.getByLabel('Po rosyjsku', { exact: true })).toBeDisabled();
	await expect(page.getByLabel('Przykład po polsku')).toBeDisabled();
	await expect(page.getByLabel('Inne odpowiedzi po polsku')).toBeDisabled();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Usuń szkic', exact: true })).toBeDisabled();
	expect(storedBody).toBe(submittedBody);
	await page.unroute('**/api/cards');
	await page.reload();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Po rosyjsku', { exact: true })).toHaveValue('Моё слово');
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('To moje słowo.');
	await expect(page.getByLabel('Po rosyjsku', { exact: true })).toBeDisabled();
	await expect(page.getByLabel('Przykład po polsku')).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true })).toBeDisabled();
	const retry = page.waitForResponse(response => response.url().endsWith('/api/cards') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	expect((await retry).status()).toBe(200);
	expect((await retry).request().postDataJSON().id).toBe(savedId);
	expect((await retry).request().postData()).toBe(submittedBody);
	await expect(page.getByRole('status')).toContainText('Fiszka zapisana.');
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('');
	const cards = await allCards(page.request);
	expect(cards).toHaveLength(before + 1);
	expect(cards.find((card: { id: string }) => card.id === savedId)).toMatchObject({ ru: 'Моё слово', examplePl: 'To moje słowo.', alternativesPl: ['Wyraz'], version: 1, createdBy: USER_A.id });
	expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
	await page.getByRole('link', { name: 'Otwórz w „Słówkach”', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Słówka', exact: true })).toBeVisible();
	await page.getByLabel('Przykład po polsku').fill('Znam to słowo.');
	const edit = page.waitForResponse(response => response.url().endsWith(`/api/cards/${savedId}`) && response.request().method() === 'PATCH');
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	expect((await edit).status()).toBe(200);
	const updated = await allCards(page.request);
	expect(updated).toHaveLength(before + 1);
	expect(updated.find(card => card.id === savedId)).toMatchObject({ examplePl: 'Znam to słowo.', version: 2 });
});

test('recovers meaning choices and the selected meaning until logout independently of study direction', async ({ page }, testInfo) => {
	await page.getByRole('button', { name: 'PL -> RU', exact: true }).click();
	await page.getByRole('button', { name: 'Słówka', exact: true }).click();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByLabel('Słowo lub wyrażenie').fill('лук');
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Овощ', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Овощ', exact: true })).toHaveAttribute('lang', 'ru');
	await expect(page.getByRole('button', { name: 'Оружие для стрельбы стрелами', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Zapisz', exact: true })).toHaveCount(0);
	await page.reload();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Оружие для стрельбы стрелами', exact: true })).toBeVisible();
	const selected = page.waitForRequest(request => request.url().endsWith('/api/cards/draft'));
	await page.getByRole('button', { name: 'Овощ', exact: true }).click();
	expect((await selected).postDataJSON()).toEqual({ text: 'лук', meaningRu: 'Овощ' });
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveValue('Cebula');
	await expect(page.getByLabel('Przykład po polsku')).toHaveValue('Kroję cebulę.');
	await page.getByRole('button', { name: 'Nauka', exact: true }).click();
	await page.getByRole('button', { name: 'RU -> PL', exact: true }).click();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Język wprowadzania')).toHaveCount(0);
	await page.reload();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveValue('Cebula');
	await expect(page.getByText('Wybrane znaczenie: Овощ', { exact: true })).toBeVisible();
	await page.screenshot({ path: `.wrangler/playwright/add-preview-${testInfo.project.name}-${page.viewportSize()!.width}.png`, fullPage: true, animations: 'disabled', scale: 'css' });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
	await loginForm(page, USER_B);
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('');
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveCount(0);
	await page.getByLabel('Słowo lub wyrażenie').fill('dom');
	await page.reload();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('dom');
	await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
	await loginForm(page, USER_A);
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('');
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveCount(0);
	await page.reload();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveCount(0);
	const keys = await page.evaluate(() => Object.keys(sessionStorage));
	expect(keys.some(key => key.includes(USER_A.id))).toBe(false);
	expect(keys.some(key => key.includes(USER_B.id))).toBe(false);
});

for (const scenario of [
	{ name: 'card generation', search: false },
	{ name: 'similar-word search', search: true },
]) test(`retains an Add draft after session expiry in ${scenario.name} only for the original account`, async ({ page, baseURL }) => {
	const expire = async () => expect((await page.request.delete('/api/session', { headers: { Origin: baseURL! } })).status()).toBe(204);
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	if (scenario.search) await expire();
	const searched = page.waitForResponse(response => response.url().includes('/api/cards?q='));
	await page.getByLabel('Słowo lub wyrażenie').fill('личный черновик');
	expect((await searched).status()).toBe(scenario.search ? 401 : 200);
	if (!scenario.search) {
		await expire();
		await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	}
	await expect(page.getByRole('button', { name: 'Zaloguj', exact: true })).toBeVisible();
	await loginForm(page, USER_B);
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('');
	await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
	await loginForm(page, USER_A);
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('личный черновик');
});

test('retains input on provider authentication failure and retains edits on a rejected Save', async ({ page }) => {
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByLabel('Słowo lub wyrażenie').fill('ошибка подключения');
	const rejected = page.waitForResponse(response => response.url().endsWith('/api/cards/draft'));
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	expect((await rejected).status()).toBe(503);
	await expect(page.getByRole('alert')).toContainText('Model AI nie jest skonfigurowany. Poproś właściciela o sprawdzenie klucza API.');
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('ошибка подключения');
	await expect(page.getByRole('button', { name: 'Wyloguj', exact: true })).toBeVisible();
	await page.getByLabel('Słowo lub wyrażenie').fill('słowo');
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	await page.getByLabel('Znaczenie (po rosyjsku)', { exact: true }).fill(' ');
	await page.getByLabel('Przykład po rosyjsku').fill('Я не знаю этого слова.');
	const save = page.waitForResponse(response => response.url().endsWith('/api/cards') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	expect((await save).status()).toBe(400);
	await expect(page.getByRole('alert')).toContainText('Sprawdź pola tekstowe.');
	await expect(page.getByLabel('Znaczenie (po rosyjsku)', { exact: true })).toHaveValue(' ');
	await expect(page.getByLabel('Przykład po rosyjsku')).toHaveValue('Я не знаю этого слова.');
	await expect(page.getByLabel('Znaczenie (po rosyjsku)', { exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true })).toBeEnabled();
	await page.reload();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Znaczenie (po rosyjsku)', { exact: true })).toHaveValue(' ');
	await page.getByLabel('Znaczenie (po rosyjsku)', { exact: true }).fill('Единица речи');
	const corrected = page.waitForResponse(response => response.url().endsWith('/api/cards') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	const result = await corrected;
	createdIds.push(result.request().postDataJSON().id);
	expect(result.status()).toBe(201);
	expect(result.request().postDataJSON().id).toBe((await save).request().postDataJSON().id);
	await expect(page.getByRole('status')).toContainText('Fiszka zapisana.');
	const cards = await allCards(page.request);
	expect(cards).toHaveLength(1);
	expect(cards[0]).toMatchObject({ meaningRu: 'Единица речи', exampleRu: 'Я не знаю этого слова.', version: 1 });
});

test('keeps the preview editable and sends no create when recovery storage fails', async ({ page }) => {
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByLabel('Słowo lub wyrażenie').fill('słowo');
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveValue('Słowo');
	page.on('request', request => {
		if (request.url().endsWith('/api/cards') && request.method() === 'POST') createdIds.push(request.postDataJSON().id);
	});
	await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage is full.', 'QuotaExceededError'); }; });
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Przeglądarka nie zapisała szkicu');
	await expect(page.getByLabel('Po polsku', { exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true })).toBeEnabled();
	expect(createdIds).toEqual([]);
	expect(await allCards(page.request)).toEqual([]);
});

test('keeps an edited preview outside source dictation across reload and save', async ({ page }, testInfo) => {
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	const source = page.getByLabel('Słowo lub wyrażenie'), mic = page.getByRole('button', { name: 'Dyktuj', exact: true });
	await source.fill('słowo');
	await expect(mic).toBeEnabled();
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	const example = page.getByLabel('Przykład po polsku');
	await example.fill('To moje nowe słowo.');
	await example.evaluate(field => field.scrollIntoView({ block: 'center' }));
	const sourceRect = (await source.boundingBox())!;
	expect(sourceRect.y + sourceRect.height).toBeLessThan(0);
	await expect(mic).toHaveCount(0);
	await expect(source).toHaveValue('słowo');
	expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), `card-draft:${USER_A.id}`)).toMatchObject({ text: 'słowo', card: { ...WORD_DRAFT, examplePl: 'To moje nowe słowo.' } });
	await page.screenshot({ path: `.wrangler/playwright/interface-${testInfo.project.name}-${page.viewportSize()!.width}-edited-preview.png`, animations: 'disabled', scale: 'css' });
	await page.reload();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(example).toHaveValue('To moje nowe słowo.');
	await expect(source).toHaveValue('słowo');
	await expect(mic).toHaveCount(0);
	const saved = page.waitForResponse(response => response.url().endsWith('/api/cards') && response.request().method() === 'POST');
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	const response = await saved;
	createdIds.push(response.request().postDataJSON().id);
	expect(response.status()).toBe(201);
	expect(response.request().postDataJSON()).toMatchObject({ ...WORD_DRAFT, examplePl: 'To moje nowe słowo.' });
	await expect(source).toHaveValue('');
	await expect(mic).toBeEnabled();
});

test('keeps the draft mounted until Save confirms and clears recovery data', async ({ page }) => {
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await page.getByLabel('Słowo lub wyrażenie').fill('słowo');
	await page.getByRole('button', { name: 'Przygotuj fiszkę', exact: true }).click();
	await expect(page.getByLabel('Po polsku', { exact: true })).toHaveValue('Słowo');
	const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	await page.route('**/api/cards', async route => {
		createdIds.push(route.request().postDataJSON().id);
		const response = await route.fetch();
		received.resolve();
		await release.promise;
		await route.fulfill({ response });
	});
	await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
	await received.promise;
	try {
		await expect(page.getByRole('button', { name: 'Nauka', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Słówka', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Wyloguj', exact: true })).toBeDisabled();
	} finally { release.resolve(); }
	await expect(page.getByRole('status')).toContainText('Fiszka zapisana.');
	await page.getByRole('button', { name: 'Nauka', exact: true }).click();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByLabel('Słowo lub wyrażenie')).toHaveValue('');
	expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
});
