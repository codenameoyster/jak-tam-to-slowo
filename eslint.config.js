import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
	{
		files: ['**/*.{ts,tsx}'],
		languageOptions: { parser: tsparser, parserOptions: { ecmaVersion: 2026, sourceType: 'module' } },
		plugins: { '@typescript-eslint': tseslint },
		rules: { ...tseslint.configs.recommended.rules },
	},
	{
		files: ['{web,shared}/**/*.{ts,tsx}'],
		rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['**/src/**'], message: 'Browser code must not import server code.' }] }] },
	},
];
