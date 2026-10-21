import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, vi } from 'vitest';
import { testAccountSecret } from './fixtures';

beforeEach(async () => {
	vi.restoreAllMocks();
	await reset();
	env.ACCOUNTS = testAccountSecret;
	delete env.LOCAL_HTTP;
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
