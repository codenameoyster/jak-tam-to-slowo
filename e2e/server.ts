import { $ } from 'bun';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { testBindings } from '../test/fixtures';

await mkdir('.wrangler/playwright', { recursive: true });
await rm('.wrangler/playwright/state', { recursive: true, force: true });
await writeFile('.wrangler/playwright/test.env', Object.entries(testBindings).map(([name, value]) => `${name}='${value}'`).join('\n'), { mode: 0o600 });
await $`bunx wrangler d1 migrations apply DB --local --persist-to .wrangler/playwright/state`;
await $`bunx wrangler dev --local --host 127.0.0.1:8790 --port 8790 --persist-to .wrangler/playwright/state --var LOCAL_HTTP:1 --env-file .wrangler/playwright/test.env`;
