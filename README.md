# Jak tam to słowo?

A private Polish and Russian card-learning app for two learners. Cards and one server-side Anthropic API key are shared. Answers, review progress, translation direction, and card-creation attribution belong to each learner. The app uses React, Bun, Cloudflare Workers, and D1.

## Learn words

Use **Добавить** to prepare a card with the AI. Type or dictate in Polish or Russian. The AI infers the source language from the text. Select one meaning when a word has several meanings. Edit the terms, examples, and accepted answers before you save. Use **Слова** to search, edit, or archive shared cards.

Study starts with `RU -> PL`. The app saves your last direction. It keeps up to ten cards ready and refills the queue when three remain. **Проверить** and **Показать ответ** show the target term and both usage examples. Correct answers use intervals of 1, 3, 7, 14, 30, and 60 days. Almost correct answers return in 10 minutes. Other answers and Reveal return in 1 minute. Exact answers and Reveal work without the AI.

If a save or review response is lost, use **Повторить**. The app sends the same request and does not record it twice. Keep that tab until the retry completes. Drafts use account-specific session storage. Session expiry retains drafts in that tab. Explicit logout clears them. A shared-card conflict retains your answer for copying. A stale tab with another displayed account receives `409 account_mismatch` before any action.

## Local setup

Use Node.js 24 or later and Bun 1.4.3 or later. The lockfile pins the dependencies. Run these commands from the repository root. Create local credentials once. If a private file already exists, keep it and check its purpose before continuing.

```sh
bun install --frozen-lockfile
umask 077
mkdir -m 700 .local
set -C
bun scripts/credentials.ts 'mąż' 'Mąż' 'żona' 'Żona' > .local/accounts.json 2> .local/credentials.txt
```

Save the passwords from `.local/credentials.txt` in a password manager. Create the local secrets file once. It stays ignored and owner-only.

```sh
bun run - <<'JS'
import { writeFileSync } from "node:fs";
const accounts = (await Bun.file(".local/accounts.json").text()).trim();
writeFileSync(".dev.vars", `ACCOUNTS='${accounts}'\n`, { mode: 0o600, flag: "wx" });
JS
bunx wrangler d1 migrations apply DB --local
bun run dev
```

Open `http://127.0.0.1:8787`. The `dev` command uses local D1 and disables remote Cloudflare bindings. The development cookie works only on loopback HTTP with `LOCAL_HTTP=1`. Production uses a secure, host-only, HttpOnly cookie. Sessions expire after seven days. Local Cloudflare mode sends real Anthropic and OpenAI requests. The automated tests supply controlled provider responses.

Keep `ACCOUNTS` in `.dev.vars`. Add `ANTHROPIC_API_KEY` to this protected file to enable card drafts and AI grading. Add `OPENAI_TRANSCRIPTION_API_KEY` to it to enable dictation. Use an OpenAI API key with audio transcription access. Keep its value on the server. Local dictation uses the same usage-based speech billing as production. Wrangler loads only names in `secrets.required`. `.dev.vars` takes precedence over `.env`. See [local secrets](https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets).

## Credentials

`ACCOUNTS` contains a JSON array of `{id, username, displayName, passwordHash}`. The credential command generates 24-character passwords from 18 random bytes. Use only these generated passwords with the SHA-256 credential format.

Usernames contain 3-40 Unicode letters, ASCII digits, dots, underscores, or dashes. Names are case-sensitive. To rename an account, update its `username` and `displayName` in `ACCOUNTS`. Keep `id` and `passwordHash` unchanged. Sign in again with the new username and the existing password. Direction and progress stay with the stable ID.

To rotate local passwords, run the command below with a restrictive umask and new output files. Save the new passwords. Replace the local `ACCOUNTS` value with the new JSON array. Keep the new account file for the next rotation.

```sh
umask 077
set -C
bun scripts/credentials.ts --rotate .local/accounts.json > .local/accounts-next.json 2> .local/credentials-next.txt
```

For production, use `.wrangler/production/accounts.json` as the rotation input. Update `ACCOUNTS` in the protected secrets JSON with the new array. Deploy that file with the command below. Keep `ANTHROPIC_API_KEY` and `OPENAI_TRANSCRIPTION_API_KEY` unchanged. The rotation command preserves account IDs. Each credential change invalidates that account's existing sessions. Direction and progress stay with its stable ID. New IDs create new learners.

## AI

Both learners use one server-side `ANTHROPIC_API_KEY`. The server calls `claude-sonnet-5-5` with effort `high` to prepare cards and to grade answers that are not exact. Card texts, selected meanings, and those answers go to Anthropic. Exact answers and Reveal work without the AI. An AI error keeps the text editable and keeps the application session active.

Anthropic bills API usage by tokens. Use a dedicated key in its own workspace. Set a monthly spend limit for that workspace in the Anthropic Console. See [workspace limits](https://platform.claude.com/docs/en/api/rate-limits#setting-lower-limits-for-workspaces).

## Dictation

Use **Диктовать** to record a short word or expression. Allow microphone access. Stop the recording within 30 seconds. The app replaces the text selected when the transcript arrives. If no text is selected, it adds the transcript after the current text. You can edit the result. Study uses the answer language. Add accepts Polish or Russian without a language selector, including for restored drafts. Cancel discards the clip. The complete upload must fit within 2 MiB.

The server sends one multipart request to [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text) with `model=gpt-transcribe`. Add sends `language=auto`, which sets repeated `languages[]` fields to `pl` and `ru`. Explicit `pl` or `ru` callers, including Study, send one language hint. The response contains only the transcript text. The upload uses a generic filename. The request has a 30-second timeout. The app keeps audio only in request memory. Browser tests use controlled recordings. Actual iOS Safari and Android Chrome recording, permissions, encoding, and recognition still need device checks over HTTPS. These checks have not passed yet.

Both learners use the server-only `OPENAI_TRANSCRIPTION_API_KEY` for speech. OpenAI bills speech separately from Anthropic usage. Anthropic generates cards and grades answers. A speech service error keeps the current text editable and keeps the application session active.

## Release checks

Install the browser binaries and operating-system packages once on a supported host, such as Ubuntu 24.04:

```sh
bunx playwright install --with-deps chromium firefox webkit
```

Run this sequence from the repository root:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:browser
bunx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

Browser tests run Chromium, Firefox, WebKit, and a Chromium mobile viewport. The two-learner workflow runs on mobile and desktop Chromium. It checks shared inference, requester-owned cards and progress, failed semantic checks, exact answers, lost-response retries, and archiving. API navigation tests check that `/api` and `/api/*` reach the Worker rather than the SPA fallback. For container checks, use `mcr.microsoft.com/playwright:v1.64.1-noble` with `--init` so stopped Worker processes are reaped.

Tests use fixed test accounts, fake Anthropic and transcription API keys, and a separate local D1 database. The test-only Worker supplies controlled Anthropic and OpenAI responses. Tests reset only `.wrangler/playwright/state`. Results, traces, and screenshots stay in `.wrangler/playwright/`. CI uses an Ubuntu host runner and needs no production credentials. CI performs no remote deployment or inference. A passing dry run checks packaging, not remote behavior.

After a binding change, run `bunx wrangler types src/worker-configuration.d.ts --env-interface Bindings --include-runtime false --strict-vars false`.

## Production setup

The approved account is **TheRustatian**, `d89bca31204306ee78e165e9f8ebd3be`. `wrangler.toml` configures Worker `jak-tam-to-slowo`, D1 `jak-tam-to-slowo` (`3e8c178e-be58-462c-bf9c-0e76543c9429`), and Custom Domain `learn.rustatian.me`. The Worker is live at `learn.rustatian.me`. The owner confirmed the existing Workers Paid plan.

The production usernames are `mąż` (ID `3c5d81fe-1a09-4d3f-bc88-e4009f01aeca`) and `żona` (ID `82c369b2-368d-4546-af9b-1b3941d8d8b1`). Their generated passwords are in `.wrangler/production/credentials.txt`. Stable account IDs and password hashes are in `.wrangler/production/accounts.json`. `.wrangler/production/secrets.json` must contain `ACCOUNTS`, `ANTHROPIC_API_KEY`, and `OPENAI_TRANSCRIPTION_API_KEY`. Preserve the account credentials. The directory uses mode `0700`; each file uses `0600`. Preserve these files and put a protected copy in the owner's password manager. Secret values must stay out of source, assets, command arguments, CI, and logs.

Deploy only reviewed code. Confirm the account. Read the installed Wrangler help before remote commands. Deploy code and secrets together. Apply a pending migration that adds tables or columns before the deploy. Apply a pending migration that removes them after the deploy, so the running Worker never reads a dropped table. Migration `0006` removes tables, so it follows the deploy:

```sh
bunx wrangler whoami --account d89bca31204306ee78e165e9f8ebd3be
bunx wrangler deploy --secrets-file .wrangler/production/secrets.json
bunx wrangler d1 migrations apply DB --remote
```

The [secrets-file option](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code) uploads secrets with the code. `secret put` and `secret bulk` can activate a deployment. Use the reviewed deployment command. `workers_dev = false` and `preview_urls = false` keep alternate public URLs disabled. Cloudflare creates the DNS record and certificate for the [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Do not replace a conflicting record or change another app.

After a deploy, check HTTPS, both account logins, shared cards, independent progress, a card draft, and a non-exact answer. Check Polish and Russian dictation on real phones within the approved speech budget. Record sanitized outcomes. Phone recording and deployed usage remain open checks.

### Account-wide allowances

The existing Workers Paid allocation includes 10 million requests and 30 million CPU milliseconds per month. Static asset requests are free. D1 includes 25 billion rows read, 50 million rows written per month, and 5 GB of storage across the account. Other applications share these allowances. Excess usage on a paid account can incur charges. Anthropic bills card drafts and AI grading by token usage, up to the workspace spend limit. OpenAI speech uses separate usage-based billing. The published [`gpt-transcribe` price](https://developers.openai.com/api/docs/models/gpt-transcribe) is USD 0.0045 per audio minute.

Check account usage in Workers & Pages, D1 Metrics, the Anthropic Console, and OpenAI before live checks. The owner approved usage-billed Anthropic text inference and OpenAI speech. This setup permits no credit purchases, plan upgrades, or paid add-ons. Stop if an operation requests a purchase. See current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Export and recovery

Keep exports owner-only. A full export contains session hashes. Store it with protected backups of the account IDs. Use a new filename for each export:

```sh
umask 077
mkdir -p .wrangler/backups
bunx wrangler d1 export DB --remote --output .wrangler/backups/before-restore.sql
```

Use `--local` for a local export. To copy only cards for analysis, add `--table cards`. See [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) keeps up to 30 days on Workers Paid and 7 days on Workers Free. It has no additional restore charge. First stop learner activity and temporarily remove this app's Custom Domain from the Worker. Keep its code and database. Save an export and the current bookmark. Select a restore timestamp within retention:

```sh
bunx wrangler d1 time-travel info DB
bunx wrangler d1 time-travel info DB --timestamp "$RESTORE_TIMESTAMP"
bunx wrangler d1 time-travel restore DB --timestamp "$RESTORE_TIMESTAMP"
```

Restore can bring back expired sessions. Before you restore traffic, clear application sessions. This SQL affects only the configured app database:

```sh
bunx wrangler d1 execute DB --remote --command "DELETE FROM sessions;"
```

Keep the current production passwords and stable account IDs. Apply pending app migrations and redeploy the reviewed configuration to restore the Custom Domain. Verify both accounts and restored progress. If a restore is wrong, use the previous bookmark returned by Time Travel, then repeat session invalidation. A Worker version rollback does not restore D1 data.
