import { defineConfig, devices } from '@playwright/test';
import { testBindings } from './test/fixtures';

export default defineConfig({
	testDir: './e2e',
	workers: 1,
	forbidOnly: !!process.env.CI,
	timeout: 25_000,
	expect: { timeout: 5_000 },
	outputDir: '.wrangler/playwright/results',
	reporter: [['list'], ['html', { outputFolder: '.wrangler/playwright/report', open: 'never' }]],
	projects: [
		{ name: 'iphone', testIgnore: /workflow\.spec\.ts/, use: { ...devices['iPhone 13'], browserName: 'webkit' } },
		{ name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
		{ name: 'chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
		{ name: 'firefox', testIgnore: /workflow\.spec\.ts/, use: { browserName: 'firefox', viewport: { width: 1280, height: 900 } } },
		{ name: 'webkit', testIgnore: /workflow\.spec\.ts/, use: { browserName: 'webkit', viewport: { width: 1280, height: 900 } } },
	],
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
