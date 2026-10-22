import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

it.each([
	{ name: 'Polish mąż at the minimum length', username: 'mąż', otherUsername: 'peer-test' },
	{ name: 'Polish żona', username: 'żona', otherUsername: 'peer-test' },
	{ name: 'other Unicode letters', username: 'Иван', otherUsername: 'peer-test' },
	{ name: 'ASCII letters, digits, and separators', username: 'A1.z_-', otherUsername: 'peer-test' },
	{ name: 'the maximum length', username: 'ż'.repeat(40), otherUsername: 'peer-test' },
	{ name: 'case-sensitive names', username: 'mąż', otherUsername: 'Mąż' },
])('generates usable credentials for $name', ({ username, otherUsername }) => {
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

it.each([
	{ name: 'an empty name', username: '' },
	{ name: 'a name below the minimum length', username: 'ąż' },
	{ name: 'a name above the maximum length', username: 'ż'.repeat(41) },
	{ name: 'a space', username: 'ma ż' },
	{ name: 'unsupported punctuation', username: 'ma@z' },
	{ name: 'a non-ASCII digit', username: 'mąż١' },
	{ name: 'an emoji', username: 'mąż🙂' },
	{ name: 'combining marks', username: 'ma\u0328z\u0307' },
	{ name: 'a duplicate name', username: 'peer-test' },
])('rejects $name before generating credentials', ({ username }) => {
	const result = spawnSync('bun', ['scripts/credentials.ts', username, 'Test first', 'peer-test', 'Test second'], { encoding: 'utf8' });
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(1);
	expect(result.stdout.length).toBe(0);
	expect(result.stderr.includes('Password:')).toBe(false);
});
