import { createHash, randomBytes, randomUUID } from 'node:crypto';

interface Account { id: string; username: string; displayName: string; passwordHash?: string }
const args = process.argv.slice(2);
let accounts: Account[];
if (args[0] === '--rotate' && args.length === 2) {
	accounts = await Bun.file(args[1]).json();
} else if (args.length === 4) {
	accounts = [
		{ id: randomUUID(), username: args[0], displayName: args[1] },
		{ id: randomUUID(), username: args[2], displayName: args[3] },
	];
} else {
	throw new Error('Use: bun run credentials USERNAME DISPLAY_NAME USERNAME DISPLAY_NAME, or --rotate ACCOUNTS_FILE.');
}
if (!Array.isArray(accounts) || accounts.length !== 2 || accounts.some(account =>
	!account || typeof account.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(account.id)
	|| typeof account.username !== 'string' || !/^[\p{L}0-9._-]{3,40}$/u.test(account.username)
	|| typeof account.displayName !== 'string' || !account.displayName.trim() || account.displayName.length > 80,
) || accounts[0].id === accounts[1].id || accounts[0].username === accounts[1].username) {
	throw new Error('Supply two accounts with distinct IDs and usernames. Use 3-40 letters, digits, dots, dashes, or underscores for usernames.');
}
const secret = accounts.map(({ id, username, displayName }) => {
	const password = randomBytes(18).toString('base64url');
	console.error(`${displayName} (${username})\nPassword: ${password}`);
	return { id, username, displayName, passwordHash: createHash('sha256').update(password).digest('hex') };
});
console.error('Save these passwords in your password manager. Keep the account IDs for credential rotation.');
console.log(JSON.stringify(secret));
