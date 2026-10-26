import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Card, Competition } from '../shared/types';
import { CARD_B, USER_A, USER_B } from '../test/fixtures';
import { sql } from './cards';

const snapshot: Competition = {
	id: '33333333-3333-4333-8333-333333333333', createdBy: USER_A.id, target: 20,
	status: 'active', winnerId: null, createdAt: 1, startedAt: 2, finishedAt: null, version: 1,
	participants: [{ id: USER_A.id, displayName: USER_A.displayName, score: 8 }, { id: USER_B.id, displayName: USER_B.displayName, score: 8 }],
};
let other: Page;
let cards: Card[];
let realRound: boolean;

function withScores(a: number, b: number, round = snapshot): Competition {
	const winner = a === round.target ? 0 : b === round.target ? 1 : null;
	return { ...round, version: round.version + 1, status: winner === null ? 'active' : 'finished',
		winnerId: winner === null ? null : round.participants[winner].id, finishedAt: winner === null ? null : 3,
		participants: [{ ...round.participants[0], score: a }, { ...round.participants[1], score: b }] };
}

async function refresh(page: Page) {
	const response = page.waitForResponse('**/api/competitions/current');
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await response;
}

async function fixedRound(page: Page, initial: Competition | null) {
	let round = initial;
	await page.route('**/api/competitions/current', route => route.fulfill({ json: round }));
	return async (next: Competition | null, poll = false) => {
		round = next;
		if (poll) {
			const response = page.waitForResponse('**/api/competitions/current');
			await page.clock.fastForward(5000);
			await response;
		} else await refresh(page);
	};
}

async function open(page: Page, compact = false) {
	await page.goto('/');
	if (!compact) await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	await expect(page.locator('svg.competition-ladder')).toBeVisible();
	return page.locator('svg.competition-ladder');
}

async function geometry(ladder: Locator) {
	return ladder.evaluate((node: SVGSVGElement) => {
		const point = (element: SVGGraphicsElement, x = 0, y = 0) => {
			const p = new DOMPoint(x, y).matrixTransform(element.getScreenCTM()!);
			return { x: p.x, y: p.y };
		};
		const bars = [...node.querySelectorAll<SVGRectElement>('.rung-bar')].map(bar => {
			const r = bar.getBoundingClientRect();
			return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
		});
		const prize = node.querySelector<SVGGElement>('.prize')!;
		return {
			bars, floor: node.querySelector('.ladder-floor')!.getBoundingClientRect().top,
			axes: [point(node, 174).x, point(node, 306).x],
			prize: prize.getAttribute('transform'), handles: [point(prize, -5, 27), point(prize, 61, 27)],
			people: [...node.querySelectorAll<SVGGElement>('[data-person]')].map(person => ({
				body: point(person), shirt: person.querySelector('.sleeve')!.getAttribute('stroke'),
				initial: person.querySelector('text')!.textContent,
				hands: [...person.querySelectorAll<SVGCircleElement>('.hand')].map(hand => point(hand, hand.cx.baseVal.value, hand.cy.baseVal.value)),
				feet: [...person.querySelectorAll<SVGGElement>('.shoe')].map(shoe => point(shoe, 0, 2)),
			})),
			labels: [...node.querySelectorAll<SVGTextElement>('[data-score-label]')].map(label => ({ text: label.textContent, rung: point(label, 0, label.y.baseVal[0].value - 12).y })),
		};
	});
}

type Geometry = Awaited<ReturnType<typeof geometry>>;
function onBar(point: { x: number; y: number }, bars: Geometry['bars']) {
	return bars.some(bar => point.x >= bar.x && point.x <= bar.right && point.y >= bar.y - 0.1 && point.y <= bar.bottom + 0.1);
}
function supported(frame: Geometry, person = 0) {
	expect(frame.people[person].hands.some(hand => onBar(hand, frame.bars))).toBe(true);
	expect(frame.people[person].feet.some(foot => frame.bars.some(bar => foot.x >= bar.x && foot.x <= bar.right && Math.abs(foot.y - bar.y) < 1) || Math.abs(foot.y - frame.floor) < 1)).toBe(true);
}
function resting(frame: Geometry, score: number, person = 0) {
	const lower = frame.people[person].feet.reduce((a, b) => a.y > b.y ? a : b);
	expect(Math.abs(lower.y - (score ? frame.bars[score - 1].y : frame.floor))).toBeLessThan(1);
	expect(lower.x).toBeGreaterThan(frame.bars[0].x);
	expect(lower.x).toBeLessThan(frame.bars[0].right);
	expect(frame.labels[person].text).toBe(String(score));
	if (score) expect(Math.abs(frame.labels[person].rung - frame.bars[score - 1].y)).toBeLessThan(1);
}
async function evidence(page: Page, name: string) {
	await expect(page.getByText('Wczytywanie fiszek…', { exact: true })).toHaveCount(0);
	await page.screenshot({ path: `.superpowers/competitions/${test.info().project.name}-${name}.png`, fullPage: true, scale: 'css' });
}

async function start(page: Page, score: number): Promise<Competition> {
	realRound = true;
	const response = await page.request.post('/api/competitions', { data: { id: crypto.randomUUID() } });
	expect(response.status()).toBe(200);
	const round: Competition = await response.json();
	expect(round.target).toBe(20);
	expect((await other.request.post(`/api/competitions/${round.id}/accept`, { data: {} })).status()).toBe(200);
	sql(`UPDATE competitions SET score_a = ${score}, version = version + 1 WHERE id = '${round.id}'`);
	return (await page.request.get('/api/competitions/current')).json();
}

async function save(page: Page, round: Competition, action: 'answer' | 'reveal') {
	const response = await page.request.post('/api/cards', { data: { ...CARD_B, id: crypto.randomUUID() } });
	expect(response.status()).toBe(201);
	const card: Card = await response.json();
	cards.push(card);
	const saved = await page.request.post('/api/reviews', { data: { attemptId: crypto.randomUUID(), cardId: card.id,
		cardVersion: card.version, progressVersion: 0, direction: 'ru-pl', competitionId: round.id,
		...(action === 'answer' ? { action, answer: 'Dom' } : { action }) } });
	expect(saved.status()).toBe(200);
	await refresh(page);
}

test.beforeEach(async ({ page, browser, baseURL }) => {
	cards = []; realRound = false;
	other = await (await browser.newContext({ baseURL })).newPage();
	await page.context().setExtraHTTPHeaders({ Origin: baseURL!, 'CF-Connecting-IP': `ladder-a-${crypto.randomUUID()}` });
	await other.context().setExtraHTTPHeaders({ Origin: baseURL!, 'CF-Connecting-IP': `ladder-b-${crypto.randomUUID()}` });
	expect((await page.request.post('/api/session', { data: { username: USER_A.username, password: USER_A.password } })).status()).toBe(200);
	expect((await other.request.post('/api/session', { data: { username: USER_B.username, password: USER_B.password } })).status()).toBe(200);
	await page.clock.install({ time: new Date('2026-10-26T12:00:00Z') });
	await page.clock.pauseAt(new Date('2026-10-26T12:00:01Z'));
});

test.afterEach(async ({ page }) => {
	await page.close();
	await other.context().close();
	if (realRound) {
		const ids = cards.map(card => `'${card.id}'`).join(',') || "''";
		sql(`DELETE FROM competition_events; DELETE FROM competitions;
			DELETE FROM reviews WHERE json_extract(input_json, '$.cardId') IN (${ids});
			DELETE FROM card_progress WHERE card_id IN (${ids}); DELETE FROM cards WHERE id IN (${ids})`);
	}
});

for (const scenario of [
	{ name: 'ten words', target: 10 }, { name: 'twenty words', target: 20 }, { name: 'thirty words', target: 30 },
]) test(`matches the challenge target: ${scenario.name}`, async ({ page }) => {
	await fixedRound(page, { ...snapshot, target: scenario.target });
	const ladder = await open(page, true);
	await expect(ladder.locator('.rung-bar')).toHaveCount(scenario.target);
	await expect(ladder.locator('.tick').last()).toHaveText(String(scenario.target));
	await expect(page.getByTestId('competition-summary')).toContainText(`8 / ${scenario.target}`);
	await page.getByTestId('competition-summary').click();
	await expect(ladder.locator('.rung-bar')).toHaveCount(scenario.target);
	await expect(ladder.locator('.tick').last()).toHaveText(String(scenario.target));
	await expect(page.getByTestId('competition-scores')).toContainText(`8 / ${scenario.target}`);
});

for (const scenario of [
	{ name: 'floor', score: 0 }, { name: 'first rung', score: 1 }, { name: 'eighth rung', score: 8 },
	{ name: 'fourteenth rung', score: 14 }, { name: 'fifteenth rung', score: 15 },
	{ name: 'eighteenth rung', score: 18 }, { name: 'upper crouch', score: 19 },
]) test(`keeps resting grips and feet on wood: ${scenario.name}`, async ({ page }) => {
	await fixedRound(page, withScores(scenario.score, scenario.score));
	const ladder = await open(page);
	const frame = await geometry(ladder);
	for (const [index, person] of frame.people.entries()) {
		expect(person.hands.every(hand => onBar(hand, frame.bars))).toBe(true);
		resting(frame, scenario.score, index);
	}
	await evidence(page, `full-${scenario.score}`);
	await page.getByRole('button', { name: 'Nauka', exact: true }).click();
	await evidence(page, `compact-${scenario.score}`);
});

for (const scenario of [
	{ name: 'first account at a tie', viewer: USER_A, a: 8, b: 8 },
	{ name: 'second account at a tie', viewer: USER_B, a: 8, b: 8 },
	{ name: 'first account at adjacent scores', viewer: USER_A, a: 8, b: 9 },
	{ name: 'second account at adjacent scores', viewer: USER_B, a: 9, b: 8 },
]) test(`keeps fixed identities at a tie: ${scenario.name}`, async ({ page }) => {
	expect((await page.request.post('/api/session', { data: { username: scenario.viewer.username, password: scenario.viewer.password } })).status()).toBe(200);
	await fixedRound(page, withScores(scenario.a, scenario.b));
	const frame = await geometry(await open(page));
	expect(frame.people.map(person => person.body.x)).toEqual(frame.axes);
	expect(frame.people.map(person => person.shirt)).toEqual(['#2d6a78', '#874b78']);
	expect(frame.people.map(person => person.initial)).toEqual(['А', 'Б']);
	await expect(page.getByTestId('competition-scores')).toContainText(`${USER_A.displayName}${scenario.viewer === USER_A ? ' (Ty)' : ''}: ${scenario.a}`);
	await expect(page.getByTestId('competition-scores')).toContainText(`${USER_B.displayName}${scenario.viewer === USER_B ? ' (Ty)' : ''}: ${scenario.b}`);
});

for (const scenario of [
	{ name: 'ascent', from: 8, to: 9, action: 'answer' as const },
	{ name: 'descent', from: 8, to: 7, action: 'reveal' as const },
	{ name: 'leaves zero', from: 0, to: 1, action: 'answer' as const },
	{ name: 'returns to zero', from: 1, to: 0, action: 'reveal' as const },
]) test(`climbs and descends on one-point changes: ${scenario.name}`, async ({ page }) => {
	const round = await start(page, scenario.from);
	const ladder = await open(page);
	const before = await geometry(ladder);
	await save(page, round, scenario.action);
	await expect(ladder.locator('[data-score-label="0"]')).toHaveText(String(scenario.to));
	for (const sample of [{ name: 'early', delta: 160 }, { name: 'middle', delta: 160 }, { name: 'late', delta: 160 }]) {
		await page.clock.runFor(sample.delta);
		const frame = await geometry(ladder);
		supported(frame);
		expect(frame.people[0].body.y).not.toBe(before.people[0].body.y);
		await evidence(page, `${scenario.name}-${sample.name}`);
		if (sample.name === 'early') await refresh(page);
	}
	await page.clock.runFor(200);
	resting(await geometry(ladder), scenario.to);
});

test('finishes interrupted or multi-point updates', async ({ page }) => {
	const update = await fixedRound(page, withScores(8, 8));
	const ladder = await open(page);
	await update(withScores(9, 8, { ...snapshot, version: 2 }));
	await expect(ladder.locator('[data-score-label="0"]')).toHaveText('9');
	await page.clock.runFor(320);
	const interrupted = await geometry(ladder);
	await update(withScores(10, 8, { ...snapshot, version: 3 }));
	await expect(ladder.locator('[data-score-label="0"]')).toHaveText('10');
	expect((await geometry(ladder)).people[0].body).toEqual(interrupted.people[0].body);
	await page.clock.runFor(700);
	resting(await geometry(ladder), 10);
	await update(withScores(13, 8, { ...snapshot, version: 4 }), true);
	await expect(ladder.locator('[data-score-label="0"]')).toHaveText('13');
	const final = await geometry(ladder);
	resting(final, 13);
	await page.clock.runFor(2000);
	expect(await geometry(ladder)).toEqual(final);
});

for (const scenario of [
	{ name: 'first participant', index: 0, a: 20, b: 19, prize: 'translate(197,12)' },
	{ name: 'second participant', index: 1, a: 19, b: 20, prize: 'translate(227,12)' },
]) test(`lets either winner grab the trophy: ${scenario.name}`, async ({ page }) => {
	const update = await fixedRound(page, withScores(19, 19));
	const ladder = await open(page);
	await update(withScores(scenario.a, scenario.b, { ...snapshot, version: 2 }));
	await expect(ladder.locator(`[data-score-label="${scenario.index}"]`)).toHaveText('20');
	await page.clock.runFor(656);
	const landed = await geometry(ladder);
	expect(landed.prize).toBe('translate(212,27)');
	for (const shoe of landed.people[scenario.index].feet) expect(Math.abs(shoe.y - landed.bars[19].y)).toBeLessThan(1);
	await evidence(page, `winner-${scenario.index}-landed`);
	await page.clock.runFor(200);
	await evidence(page, `winner-${scenario.index}-reach`);
	for (const sample of [{ name: 'early', delta: 72 }, { name: 'middle', delta: 48 }, { name: 'late', delta: 48 }]) {
		await page.clock.runFor(sample.delta);
		const lifting = await geometry(ladder);
		const hand = lifting.people[scenario.index].hands[scenario.index === 0 ? 1 : 0], handle = lifting.handles[scenario.index];
		expect(Math.hypot(hand.x - handle.x, hand.y - handle.y)).toBeLessThan(1);
		expect(lifting.prize).not.toBe(landed.prize);
		await evidence(page, `winner-${scenario.index}-lift-${sample.name}`);
	}
	await page.clock.runFor(88);
	expect((await geometry(ladder)).prize).toBe(scenario.prize);
	await expect(ladder).toHaveClass(/celebrate/);
	await evidence(page, `winner-${scenario.index}-held`);
	await page.getByRole('button', { name: 'Nauka', exact: true }).click();
	expect((await geometry(ladder)).prize).toBe(scenario.prize);
	await evidence(page, `winner-${scenario.index}-compact`);
});

test('does not repeat the pickup on an unchanged poll', async ({ page }) => {
	const update = await fixedRound(page, withScores(19, 8));
	const ladder = await open(page);
	const finished = withScores(20, 8, { ...snapshot, version: 2 });
	await update(finished);
	await expect(ladder.locator('[data-score-label="0"]')).toHaveText('20');
	await page.clock.runFor(1800);
	const final = await geometry(ladder);
	await update(finished, true);
	await page.clock.runFor(160);
	expect(await geometry(ladder)).toEqual(final);
	await expect(ladder).not.toHaveClass(/celebrate/);
	await page.clock.runFor(1200);
	expect(await geometry(ladder)).toEqual(final);
	await expect(ladder).not.toHaveClass(/celebrate/);
});

test('resets for a rematch', async ({ page }) => {
	const round = await start(page, 19);
	const ladder = await open(page);
	await save(page, round, 'answer');
	await expect(ladder.locator('[data-score-label="0"]')).toHaveText('20');
	await page.clock.runFor(1800);
	await page.getByRole('button', { name: 'Zaproś na rewanż', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Anuluj zaproszenie', exact: true })).toBeEnabled();
	const frame = await geometry(ladder);
	resting(frame, 0, 0); resting(frame, 0, 1);
	expect(frame.prize).toBe('translate(212,27)');
	await page.clock.runFor(1800);
	expect(await geometry(ladder)).toEqual(frame);
});

test('respects reduced motion', async ({ page }) => {
	const update = await fixedRound(page, withScores(18, 8));
	const ladder = await open(page);
	await update(withScores(19, 8, { ...snapshot, version: 2 }));
	await expect(ladder.locator('[data-score-label="0"]')).toHaveText('19');
	await page.clock.runFor(160);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.clock.runFor(16);
	resting(await geometry(ladder), 19);
	await update(withScores(20, 8, { ...snapshot, version: 3 }));
	await expect(ladder.locator('[data-score-label="0"]')).toHaveText('20');
	expect((await geometry(ladder)).prize).toBe('translate(197,12)');
	await expect(ladder).not.toHaveClass(/celebrate/);
});

for (const scenario of [
	{ name: '320 light', width: 320, theme: 'light' as const, text: 100 },
	{ name: '390 dark', width: 390, theme: 'dark' as const, text: 100 },
	{ name: '390 enlarged text and long names', width: 390, theme: 'light' as const, text: 200 },
]) test(`fits mobile sizes and enlarged text: ${scenario.name}`, async ({ page }) => {
	await page.setViewportSize({ width: scenario.width, height: 844 });
	await page.emulateMedia({ colorScheme: scenario.theme });
	const round = withScores(19, 19);
	if (scenario.text === 200) {
		round.participants[0].displayName = 'Aleksandra Katarzyna';
		round.participants[1].displayName = 'Konstanty Aleksander';
	}
	await fixedRound(page, round);
	await open(page, true);
	await page.addStyleTag({ content: `html { font-size: ${scenario.text}% }` });
	await expect(page.getByTestId('competition-summary')).toContainText(round.participants[0].displayName);
	await expect(page.getByTestId('competition-summary')).toContainText(round.participants[1].displayName);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
	if (scenario.text === 100) expect((await page.getByTestId('competition-summary').boundingBox())!.height).toBeLessThanOrEqual(72);
	await evidence(page, `${scenario.name}-compact`);
	await page.getByTestId('competition-summary').click();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
	await expect(page.getByTestId('competition-scores')).toContainText('19 / 20');
	await evidence(page, `${scenario.name}-full`);
	await page.getByRole('button', { name: 'Trenuj słówka', exact: true }).click();
	await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
	await expect(page.getByRole('textbox').first()).toBeVisible();
});

test('preserves keyboard and screen-reader access', async ({ page }) => {
	const update = await fixedRound(page, withScores(8, 8));
	const ladder = await open(page, true);
	const summary = page.getByTestId('competition-summary');
	expect((await summary.getByText('Remis.', { exact: true }).boundingBox())!.width).toBeGreaterThan(1);
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('heading', { name: 'Wyścig do 20' })).toBeVisible();
	await expect(ladder).toHaveAttribute('aria-hidden', 'true');
	const live = page.getByTestId('competition-scores');
	await expect(live).toHaveAttribute('aria-atomic', 'true');
	const before = await live.innerText();
	await update(withScores(8, 8));
	await page.clock.runFor(32);
	expect(await live.innerText()).toBe(before);
	const controls = page.locator('.tabs button, .competition-actions button, .competition-rules summary');
	for (const control of await controls.all()) {
		const box = (await control.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
		await control.focus();
		expect(await control.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
	}
	await update(withScores(20, 8, { ...snapshot, version: 3 }));
	await expect(live).toContainText(`Wygrywa ${USER_A.displayName}!`);
});

test('shows the default ladder before the first invitation', async ({ page }) => {
	await fixedRound(page, null);
	const ladder = await open(page);
	await expect(ladder.locator('.rung-bar')).toHaveCount(20);
	const frame = await geometry(ladder);
	resting(frame, 0, 0); resting(frame, 0, 1);
	await expect(page.getByRole('button', { name: 'Zaproś do wyścigu', exact: true })).toBeEnabled();
});

for (const scenario of [
	{ name: 'study', screen: 'Nauka', label: 'Odpowiedź po polsku' },
	{ name: 'add', screen: 'Dodaj', label: 'Słowo lub wyrażenie' },
]) test(`keeps the compact ladder in page flow above the keyboard: ${scenario.name}`, async ({ page }) => {
	await start(page, 8);
	expect((await page.request.patch('/api/me', { data: { direction: 'ru-pl' } })).status()).toBe(200);
	const response = await page.request.post('/api/cards', { data: { ...CARD_B, id: crypto.randomUUID() } });
	expect(response.status()).toBe(201);
	cards.push(await response.json());
	await open(page, true);
	await page.getByRole('button', { name: scenario.screen, exact: true }).click();
	const input = page.getByLabel(scenario.label);
	await expect(input).toBeEnabled();
	await input.focus();
	await page.evaluate(() => {
		Object.defineProperties(window.visualViewport!, { height: { configurable: true, value: 420 }, offsetTop: { configurable: true, value: 0 } });
		window.visualViewport!.dispatchEvent(new Event('resize'));
	});
	await page.clock.runFor(32);
	await expect(page.getByRole('navigation')).toBeHidden();
	const field = (await input.boundingBox())!;
	expect(field.y).toBeGreaterThanOrEqual(0);
	expect(field.y + field.height).toBeLessThanOrEqual(420);
	expect(await page.getByTestId('competition-summary').evaluate(node => getComputedStyle(node).position)).toBe('static');
	await input.fill('Dom');
	await expect(input).toHaveValue('Dom');
	await page.screenshot({ path: `.superpowers/competitions/${test.info().project.name}-keyboard-${scenario.name}.png`, clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: 420 }, scale: 'css' });
	await input.blur();
	await page.evaluate(() => {
		Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: innerHeight });
		window.visualViewport!.dispatchEvent(new Event('resize'));
	});
	await page.clock.runFor(32);
	await expect(page.getByRole('navigation')).toBeVisible();
	await page.getByRole('button', { name: 'Zawody', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Wyścig do 20' })).toBeVisible();
});
