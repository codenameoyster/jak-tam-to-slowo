# Jak tam to słowo?

A private Polish and Russian card-learning app. The current application provides learner accounts and a saved translation direction. It uses React, Bun, Cloudflare Workers, and D1.

## Local setup

Use Node.js 24 or later and Bun 1.4.3 or later. Install the dependencies. Generate two accounts. Save the passwords from the terminal in your password manager.

```sh
bun install
mkdir -p .local
umask 077
bun run credentials anna 'Анна' boris 'Борис' > .local/accounts.json
```

Create the local secrets file. Run this command once. Keep the token key and host ID for later use.

```sh
bun run - <<'JS'
import { randomBytes, randomUUID } from "node:crypto";
const accounts = (await Bun.file(".local/accounts.json").text()).trim();
await Bun.write(".dev.vars", `ACCOUNTS='${accounts}'\nAI_TOKEN_KEY=${randomBytes(32).toString("base64")}\nCHATGPT_HOST_ID=${randomUUID()}\n`);
JS
bunx wrangler d1 migrations apply DB --local
bun run dev
```

Open `http://127.0.0.1:8787`. Local development uses local D1 and disables remote bindings. The development cookie works only on loopback HTTP with `LOCAL_HTTP=1`. Production uses a secure, host-only cookie.

## Credentials

`ACCOUNTS` contains a JSON array of `{id, username, displayName, passwordHash}`. The credential command generates 24-character passwords from 18 random bytes. Use only these generated passwords with the SHA-256 credential format.

To rotate passwords, run `bun run credentials --rotate .local/accounts.json > .local/accounts-next.json`. Save the new passwords. Replace the `ACCOUNTS` value with the new JSON array. Keep the new account file for the next rotation. The command preserves each account ID. A credential change ends that account's existing sessions. Saved direction stays with the account ID.

## Checks

```sh
bun run test
bunx playwright install chromium
bun run test:browser
bun run typecheck
bun run lint
```

Browser tests use fixed test accounts and a separate local D1 database. They reset only `.wrangler/playwright/state`. Browser results and screenshots stay in `.wrangler/playwright/`.

After a binding change, run `bunx wrangler types src/worker-configuration.d.ts --env-interface Bindings --include-runtime false`.
