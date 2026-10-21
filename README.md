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
await Bun.write(".dev.vars", `ACCOUNTS='${accounts}'\nAI_TOKEN_KEY=${randomBytes(32).toString("base64")}\nCHATGPT_HOST_ID=urn:uuid:${randomUUID()}\n`);
JS
bunx wrangler d1 migrations apply DB --local
bun run dev
```

Open `http://127.0.0.1:8787`. Local development uses local D1 and disables remote bindings. The development cookie works only on loopback HTTP with `LOCAL_HTTP=1`. Production uses a secure, host-only cookie.

## Credentials

`ACCOUNTS` contains a JSON array of `{id, username, displayName, passwordHash}`. The credential command generates 24-character passwords from 18 random bytes. Use only these generated passwords with the SHA-256 credential format.

To rotate passwords, run `bun run credentials --rotate .local/accounts.json > .local/accounts-next.json`. Save the new passwords. Replace the `ACCOUNTS` value with the new JSON array. Keep the new account file for the next rotation. The command preserves each account ID. A credential change ends that account's existing sessions. Saved direction stays with the account ID.

## Personal ChatGPT connections

Each learner connects their own ChatGPT subscription in **Настройки**. Select **Продолжить с ChatGPT**. Open the sign-in link. Complete provider consent. Copy the full address from the loopback error page into the app. The callback address is `http://127.0.0.1:47319/auth/callback`. The app uses the copied-address pattern from redlamp.me. This implementation has local tests with controlled provider responses. Hosted eligibility, real sign-in, and model access from this Worker remain unverified. Confirm the hosted integration with OpenAI before a live check. See [OpenAI registration requirements](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

The first visible model is selected on connection. The learner can select another visible model. Reconnection keeps the valid connection until the new credentials and model catalog pass validation. Disconnect clears only the learner's credentials. If remote revocation fails, the app asks the learner to remove access in [ChatGPT Settings](https://chatgpt.com/settings/usage).

`AI_TOKEN_KEY` is a base64-encoded 32-byte AES-GCM key. Keep it stable to read stored credentials. `CHATGPT_HOST_ID` is the persistent opaque identity of this host. Generate it once. Keep the issued client ID with its verified account identity after disconnect. OAuth attempts expire after ten minutes and belong to one application session. Access, refresh, and ID tokens stay encrypted in D1.

## Checks

```sh
bun run test
bunx playwright install chromium
bun run test:browser
bun run typecheck
bun run lint
```

Browser tests use fixed test accounts and a separate local D1 database. The test-only Worker entry supplies controlled OpenAI responses. They reset only `.wrangler/playwright/state`. Browser results and screenshots stay in `.wrangler/playwright/`.

After a binding change, run `bunx wrangler types src/worker-configuration.d.ts --env-interface Bindings --include-runtime false`.
