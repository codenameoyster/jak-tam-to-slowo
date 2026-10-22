import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { testBindings } from './test/fixtures.ts';

Object.assign(process.env, testBindings);

export default defineConfig({
	test: {
		projects: [{
			plugins: [cloudflareTest({
				wrangler: { configPath: './wrangler.toml' },
				remoteBindings: false,
				miniflare: {
					bindings: {
						...testBindings,
						TEST_MIGRATIONS: await readD1Migrations('./migrations'),
					},
				},
			})],
			test: { name: 'worker', include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
		}, {
			test: { name: 'scripts', environment: 'node', include: ['scripts/**/*.test.ts'] },
		}],
	},
});
