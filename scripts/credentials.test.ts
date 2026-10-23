import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

it('generates usable credentials for case-sensitive names', () => {
	const username = 'mąż', otherUsername = 'Mąż';
	const result = spawnSync('bun', ['scripts/credentials.ts', username, 'Test first', otherUsername, 'Test second'], { encoding: 'utf8' });
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	const accounts = JSON.parse(result.stdout) as { id: string; username: string; displayName: string; passwordHash: string }[];
	expect(accounts.map(({ username, displayName }) => ({ username, displayName }))).toEqual([
		{ username, displayName: 'Test first' }, { username: otherUsername, displayName: 'Test second' },
	]);
	expect(accounts[0].id).not.toBe(accounts[1].id);
	const passwords = Array.from(result.stderr.matchAll(/^Password: ([A-Za-z0-9_-]{24})$/gm), match => match[1]);
	expect(passwords.length).toBe(2);
	for (const [index, account] of accounts.entries()) {
		expect(account.id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
		expect(account.passwordHash).toBe(createHash('sha256').update(passwords[index]).digest('hex'));
		expect(result.stdout.includes(passwords[index])).toBe(false);
	}
});

it('rejects a space before generating credentials', () => {
	const result = spawnSync('bun', ['scripts/credentials.ts', 'ma ż', 'Test first', 'peer-test', 'Test second'], { encoding: 'utf8' });
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(1);
	expect(result.stdout.length).toBe(0);
	expect(result.stderr.includes('Password:')).toBe(false);
});
