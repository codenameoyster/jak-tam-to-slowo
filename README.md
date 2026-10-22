# Jak tam to słowo?

A private Polish and Russian card-learning app for two learners. Cards and one owner's ChatGPT connection are shared. Answers, review progress, translation direction, and card-creation attribution belong to each learner. The app uses React, Bun, Cloudflare Workers, and D1.

## Learn words

Use **Добавить** to prepare a card with the shared ChatGPT connection. Select one meaning when a word has several meanings. Edit the terms, examples, and accepted answers before you save. Use **Слова** to search, edit, or archive shared cards.

Study starts with `RU -> PL`. The app saves your last direction. It keeps up to ten cards ready and refills the queue when three remain. **Проверить** and **Показать ответ** show the target term and both usage examples. Correct answers use intervals of 1, 3, 7, 14, 30, and 60 days. Almost correct answers return in 10 minutes. Other answers and Reveal return in 1 minute. Exact answers and Reveal work without ChatGPT.

If a save or review response is lost, use **Повторить**. The app sends the same request and does not record it twice. Keep that tab until the retry completes. Drafts use account-specific session storage. Session expiry retains drafts in that tab. Explicit logout clears them. A shared-card conflict retains your answer for copying.

## Local setup

Use Node.js 24 or later and Bun 1.4.3 or later. The lockfile pins the dependencies. Run these commands from the repository root. Create local credentials once. If a private file already exists, keep it and check its purpose before continuing.

```sh
bun install --frozen-lockfile
umask 077
mkdir -m 700 .local
set -C
bun scripts/credentials.ts learner-1 'Ученик 1' learner-2 'Ученик 2' > .local/accounts.json 2> .local/credentials.txt
```

Save the passwords from `.local/credentials.txt` in a password manager. Create the local secret key and a separate local host identity once. These files stay ignored and owner-only.

```sh
bun run - <<'JS'
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
const accounts = (await Bun.file(".local/accounts.json").text()).trim();
writeFileSync(".dev.vars", `ACCOUNTS='${accounts}'\nAI_TOKEN_KEY=${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
writeFileSync(".local/host-id.txt", `urn:uuid:${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
writeFileSync(".local/owner-id.txt", `${JSON.parse(accounts)[0].id}\n`, { mode: 0o600, flag: "wx" });
JS
bunx wrangler d1 migrations apply DB --local
bun run dev --var "CHATGPT_HOST_ID:$(cat .local/host-id.txt)" --var "CHATGPT_OWNER_ID:$(cat .local/owner-id.txt)"
```

Open `http://127.0.0.1:8787`. The `dev` command uses local D1 and disables remote Cloudflare bindings. The development cookie works only on loopback HTTP with `LOCAL_HTTP=1`. Production uses a secure, host-only, HttpOnly cookie. Sessions expire after seven days. Local Cloudflare mode does not fake OpenAI requests. The automated tests supply controlled OpenAI responses.

Keep `ACCOUNTS` and `AI_TOKEN_KEY` in `.dev.vars`. Add `OPENAI_TRANSCRIPTION_API_KEY` to this protected file to enable dictation. Use an OpenAI API key with audio transcription access. Keep its value on the server. Local dictation uses the same usage-based speech billing as production. Wrangler loads only names in `secrets.required`. `.dev.vars` takes precedence over `.env`. `CHATGPT_HOST_ID` and `CHATGPT_OWNER_ID` are non-secret configuration. The command above selects the local host and the first generated learner as the local connection owner. For an existing local setup, set `CHATGPT_OWNER_ID` to that learner's existing stable ID. See [local secrets](https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets).

## Credentials

`ACCOUNTS` contains a JSON array of `{id, username, displayName, passwordHash}`. The credential command generates 24-character passwords from 18 random bytes. Use only these generated passwords with the SHA-256 credential format.

To rotate local passwords, run the command below with a restrictive umask and new output files. Save the new passwords. Replace the local `ACCOUNTS` value with the new JSON array. Keep the new account file for the next rotation.

```sh
umask 077
set -C
bun scripts/credentials.ts --rotate .local/accounts.json > .local/accounts-next.json 2> .local/credentials-next.txt
```

For production, use `.wrangler/production/accounts.json` as the rotation input. Update `ACCOUNTS` in the protected secrets JSON with the new array. Deploy that file with the command below. Keep `AI_TOKEN_KEY` unchanged. The rotation command preserves account IDs. Each credential change invalidates that account's existing sessions. Direction and progress stay with its stable ID. New IDs create new learners.

## Shared ChatGPT connection

Both learners use the subscription of `learner-1`. `CHATGPT_OWNER_ID` selects its stable application ID, `3c5d81fe-1a09-4d3f-bc88-e4009f01aeca`, in production. Only this authenticated owner can connect, reconnect, choose the model, or disconnect in **Настройки**. The other learner sees shared status and the current model. That learner needs no ChatGPT account or subscription. The server derives the `canManage` permission from the session and owner configuration.

As the owner, select **Продолжить с ChatGPT**. Open the sign-in link. Complete provider consent. Copy the full address from the loopback error page into the app. The callback address is `http://127.0.0.1:47319/auth/callback`. Keep callback addresses private. The app uses the copied-address pattern from redlamp.me. Local tests use controlled provider responses. Hosted eligibility, owner consent, and model access from the deployed Worker remain unverified. See [OpenAI registration requirements](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

The first visible model is selected on connection. The owner can select another visible model for both learners. Reconnection keeps the valid connection until the new credentials and model catalog pass validation. Disconnect clears only the owner's credentials and stops shared text inference for both learners. Exact checks and Reveal still work. If remote revocation fails, the app asks the owner to remove access in [ChatGPT Settings](https://chatgpt.com/settings/usage).

`AI_TOKEN_KEY` is a base64-encoded 32-byte AES-GCM key. Keep it stable to read stored credentials. `CHATGPT_HOST_ID` is the persistent opaque identity of this host. Generate it once. Keep the issued client ID with its verified account identity after disconnect. OAuth attempts expire after ten minutes and belong to one application session. Access, refresh, and ID tokens stay encrypted in D1.

Text inference always selects the configured owner's existing encrypted row. Existing learner records stay in D1. A missing or rejected owner connection never selects another learner's old credentials. This change requires no migration or credential transfer. The authenticated requester still owns card writes, answers, and review progress. A stale tab with another displayed account receives `409 account_mismatch` before any action.

## Dictation

Use **Диктовать** to record a short word or expression. Allow microphone access. Stop the recording within 30 seconds. The app adds the transcript to your typed text and lets you edit it. Study uses the answer language. Add uses the selected input language. Cancel discards the clip. The complete upload must fit within 2 MiB.

The server sends one multipart request to [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text) with `model=gpt-transcribe` and `languages[]` set to the selected `pl` or `ru` language. The upload uses a generic filename. The request has a 30-second timeout. The app keeps audio only in request memory. Browser tests use controlled recordings. Actual iOS Safari and Android Chrome recording, permissions, encoding, and recognition still need device checks over HTTPS. These checks have not passed yet.

Both learners use the server-only `OPENAI_TRANSCRIPTION_API_KEY` for speech. OpenAI bills speech separately from the shared ChatGPT subscription. The shared ChatGPT connection continues to generate cards and grade answers. A speech service error keeps the current text editable and keeps the application session active.

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

Browser tests run Chromium, Firefox, WebKit, and a Chromium mobile viewport. The two-learner workflow runs on mobile and desktop Chromium. It checks shared inference, requester-owned cards and progress, failed semantic checks, exact answers, lost-response retries, owner disconnect, and archiving. Settings checks cover shared status and owner-only controls. API navigation tests check that `/api` and `/api/*` reach the Worker rather than the SPA fallback. For container checks, use `mcr.microsoft.com/playwright:v1.64.1-noble` with `--init` so stopped Worker processes are reaped.

Tests use fixed test accounts, a fake transcription API key, and a separate local D1 database. The test-only Worker supplies controlled OpenAI responses. Tests reset only `.wrangler/playwright/state`. Results, traces, and screenshots stay in `.wrangler/playwright/`. CI uses an Ubuntu host runner and needs no production credentials. CI performs no remote deployment or inference. A passing dry run checks packaging, not remote behavior.

After a binding change, run `bunx wrangler types src/worker-configuration.d.ts --env-interface Bindings --include-runtime false --strict-vars false`.

## Production setup

The approved account is **TheRustatian**, `d89bca31204306ee78e165e9f8ebd3be`. `wrangler.toml` configures Worker `jak-tam-to-slowo`, D1 `jak-tam-to-slowo` (`3e8c178e-be58-462c-bf9c-0e76543c9429`), and Custom Domain `learn.rustatian.me`. The dedicated database exists and has migrations `0001` through `0005`. The Worker is not yet published. The owner confirmed the existing Workers Paid plan. Billing entitlements and hostname conflicts still need a final check before publication.

The initial usernames are `learner-1` and `learner-2`. Their generated passwords are in `.wrangler/production/credentials.txt`. Stable account IDs and password hashes are in `.wrangler/production/accounts.json`. `.wrangler/production/secrets.json` must contain `ACCOUNTS`, `AI_TOKEN_KEY`, and `OPENAI_TRANSCRIPTION_API_KEY`. Add the speech key to the existing protected file. Preserve the account credentials and encryption key. `.wrangler/production/host-id.txt` is a backup of the non-secret host ID in `wrangler.toml`. The directory uses mode `0700`; each file uses `0600`. Preserve these files and put a protected copy in the owner's password manager. Secret values must stay out of source, assets, command arguments, CI, and logs.

Publication waits for task review, ponytail review, and final branch review. After those reviews, confirm the account and the absence of a conflicting hostname assignment. Read the installed Wrangler help before remote commands. Apply only this app's pending migrations, then deploy code and secrets together:

```sh
bunx wrangler whoami --account d89bca31204306ee78e165e9f8ebd3be
bunx wrangler d1 migrations apply DB --remote
bunx wrangler deploy --secrets-file .wrangler/production/secrets.json
```

The [secrets-file option](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code) uploads secrets with the code. `secret put` and `secret bulk` can activate a deployment. Use the reviewed deployment command for the first publication. `workers_dev = false` and `preview_urls = false` keep alternate public URLs disabled. Cloudflare creates the DNS record and certificate for the [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Do not replace a conflicting record or change another app.

After publication, check HTTPS, both account logins, shared cards, independent progress, shared ChatGPT status, and owner-only management. Check Polish and Russian dictation on real phones within the approved speech budget. Record sanitized outcomes. Real owner consent, phone recording, hosted inference, and deployed usage remain open checks.

### Account-wide allowances

The existing Workers Paid allocation includes 10 million requests and 30 million CPU milliseconds per month. Static asset requests are free. D1 includes 25 billion rows read, 50 million rows written per month, and 5 GB of storage across the account. Other applications share these allowances. Excess usage on a paid account can incur charges. OpenAI speech uses separate usage-based billing. The published [`gpt-transcribe` price](https://developers.openai.com/api/docs/models/gpt-transcribe) is USD 0.0045 per audio minute.

Check account usage in Workers & Pages, D1 Metrics, and OpenAI before live checks. The owner approved usage-billed OpenAI speech. This setup permits no credit purchases, plan upgrades, or paid add-ons. Stop if an operation requests a purchase. See current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Export and recovery

Keep exports owner-only. A full export contains session hashes and encrypted provider credentials. Store it with protected backups of the account IDs and token key. Use a new filename for each export:

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

Restore can bring back expired sessions, old OAuth attempts, and old provider tokens. Before you restore traffic, clear application sessions and pending OAuth attempts. Clear provider tokens while keeping each verified client identity. This SQL affects only the configured app database:

```sh
bunx wrangler d1 execute DB --remote --command "DELETE FROM oauth_attempts; DELETE FROM sessions; UPDATE ai_connections SET access_token = NULL, refresh_token = NULL, id_token = NULL, scopes = NULL, expires_at = NULL, refresh_after = NULL, refresh_lease_until = NULL, model = NULL, models = '[]', version = version + 1;"
```

Keep the current production passwords, stable account IDs, and `CHATGPT_OWNER_ID`. Ask the owner to remove the old app grant in ChatGPT Settings, then reconnect after service resumes. Local token deletion does not revoke provider access. Apply pending app migrations and redeploy the reviewed configuration to restore the Custom Domain. Verify both accounts and restored progress. If a restore is wrong, use the previous bookmark returned by Time Travel, then repeat credential invalidation. A Worker version rollback does not restore D1 data.
