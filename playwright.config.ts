import { defineConfig } from '@playwright/test';
import { testBindings } from './test/fixtures';

export default defineConfig({
	testDir: './e2e',
	workers: 1,
	timeout: 25_000,
	expect: { timeout: 5_000 },
	outputDir: '.wrangler/playwright/results',
	reporter: [['list'], ['html', { outputFolder: '.wrangler/playwright/report', open: 'never' }]],
	use: {
		baseURL: 'http://127.0.0.1:8790',
		browserName: 'chromium',
		viewport: { width: 390, height: 844 },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	webServer: {
		command: 'bun e2e/server.ts',
		url: 'http://127.0.0.1:8790',
		reuseExistingServer: false,
		env: {
			CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true',
			...testBindings,
		},
	},
});
