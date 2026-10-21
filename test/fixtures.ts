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

export const CARD_A = {
	id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	pl: 'Słowo', ru: 'Слово', meaningRu: 'Единица речи',
	examplePl: 'To nowe słowo.', exampleRu: 'Это новое слово.',
	alternativesPl: ['Wyraz'], alternativesRu: ['Словечко'],
};
export const CARD_B = {
	id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
	pl: 'Dom', ru: 'Дом', meaningRu: 'Жилое здание',
	examplePl: 'To nasz dom.', exampleRu: 'Это наш дом.',
	alternativesPl: [], alternativesRu: ['Жилище'],
};

export const WORD_DRAFT = {
	pl: 'Słowo', ru: 'Слово', meaningRu: 'Единица речи',
	examplePl: 'Nie znam tego słowa.', exampleRu: 'Я не знаю этого слова.',
	alternativesPl: ['Wyraz'], alternativesRu: [],
};
export const ONION_DRAFT = {
	pl: 'Cebula', ru: 'Лук', meaningRu: 'Овощ',
	examplePl: 'Kroję cebulę.', exampleRu: 'Я режу лук.',
	alternativesPl: [], alternativesRu: [],
};
