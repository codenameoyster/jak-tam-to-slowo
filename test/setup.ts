import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, vi } from 'vitest';
import { testAccountSecret, testBindings } from './fixtures';

beforeEach(async () => {
	vi.restoreAllMocks();
	await reset();
	env.ACCOUNTS = testAccountSecret;
	env.ANTHROPIC_API_KEY = testBindings.ANTHROPIC_API_KEY;
	delete env.LOCAL_HTTP;
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
