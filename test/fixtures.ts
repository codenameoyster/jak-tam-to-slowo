import { createHash } from 'node:crypto';

export const USER_A = {
	id: '11111111-1111-4111-8111-111111111111',
	username: 'anna-test',
	displayName: 'Анна',
	password: 'test-anna-password-000001',
};
export const USER_B = {
	id: '22222222-2222-4222-8222-222222222222',
	username: 'boris-test',
	displayName: 'Борис',
	password: 'test-boris-password-00001',
};
export const testAccountSecret = JSON.stringify([USER_A, USER_B].map(({ password, ...user }) => ({
	...user, passwordHash: createHash('sha256').update(password).digest('hex'),
})));

export const testBindings = {
	ACCOUNTS: testAccountSecret,
	AI_TOKEN_KEY: btoa('t'.repeat(32)),
	CHATGPT_HOST_ID: 'test-host',
};
