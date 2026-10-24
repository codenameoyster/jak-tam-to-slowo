import { expect, type APIRequestContext } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import type { Card, CardPage } from '../shared/types';

// The API returns cards in pages. Test setup and cleanup need all of them.
export async function allCards(request: APIRequestContext): Promise<Card[]> {
	const cards: Card[] = [];
	let cursor: string | null = null;
	do {
		const page: CardPage = await (await request.get(`/api/cards${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`)).json();
		cards.push(...page.cards);
		cursor = page.nextCursor;
	} while (cursor);
	return cards;
}

export function sql(command: string) {
	const result = spawnSync('bun', ['x', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.wrangler/playwright/state', '--command', command], { encoding: 'utf8' });
	expect(result.status, result.stderr).toBe(0);
}
