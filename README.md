# GoBridge

A personal MCP server on Cloudflare Workers. It lets your AI clients (Claude and ChatGPT) reach your own Gmail, Google Calendar, and Google Drive (read-only), and nobody else's. Only one Google account, the owner's, can sign in.

> **Status:** all six build steps are done and deployed to dev. Before going to production, read `SECURITY_REVIEW.md` and follow `PROD_CHECKLIST.md` step by step.

There are two environments. Each has its own storage and its own secrets:

| Environment  | Worker         | URL                                         |
| ------------ | -------------- | ------------------------------------------- |
| `dev`        | `gobridge-dev` | `https://gobridge-dev.krishnakem.workers.dev` |
| `production` | `gobridge`     | `https://gobridge.krishnakem.workers.dev`     |

Run every command below in a terminal opened in this project folder.

## 1. One-time setup on your computer

```sh
npm install              # download the project's dependencies
brew install gitleaks    # secret scanner used by the commit hook
npm run hooks:install    # turn on the commit hook for this repo
npx wrangler login       # sign in to Cloudflare (opens a browser)
```

The commit hook (`.githooks/pre-commit`) runs `gitleaks` on every commit and blocks the commit if it finds something that looks like a secret, or if `gitleaks` is not installed.

## 2. Google Cloud setup

Already done for dev: project "GoBridge", the Gmail / Calendar / Drive APIs, the consent screen, and the `gobridge-dev` OAuth client.

Before going to production, create a second **Web application** OAuth client named `gobridge-prod` (Google Cloud Console → Google Auth Platform → Clients → Create client) with these Authorized redirect URIs:

- `https://gobridge.krishnakem.workers.dev/callback`
- `https://gobridge.krishnakem.workers.dev/link/callback`

Keep its client ID and secret for step 4. Never reuse the dev client in production.

## 3. Create the storage

Each environment has its own storage, never shared:

| What | Holds | Kind |
| --- | --- | --- |
| `OAUTH_KV` | AI-client registrations, grants, owner sessions | KV namespace |
| `GOOGLE_TOKENS` | Linked accounts (refresh tokens encrypted) | KV namespace |
| `AUDIT_DB` | The audit log of writes and reads | D1 database |
| `USAGE_COUNTER` | Rate-limit and send-cap counters | Durable Object (created automatically on deploy) |

Dev is already set up. For reference, these were the commands:

```sh
npx wrangler kv namespace create OAUTH_KV --env dev
npx wrangler kv namespace create GOOGLE_TOKENS --env dev
npx wrangler d1 create gobridge-audit-dev
npm run migrate:dev      # creates the audit tables
```

Each `create` command prints an `id`. If Wrangler offers to add it to the config for you, answer **no**. Instead open `wrangler.jsonc` and put the id in the matching place. These ids are not secrets.

Whenever a new file appears in the `migrations/` folder, run `npm run migrate:dev` before `npm run deploy:dev`.

For production, follow `PROD_CHECKLIST.md`: it has the same steps with the production names and the `REPLACE_WITH_PROD_..._ID` placeholders.

Old audit entries are deleted automatically after 90 days by a scheduled job that runs once a day.

## 4. Set the secrets

Secrets never go in `wrangler.jsonc`, in source code, or in a chat. Each command below asks you to paste the value; it is not shown on screen.

For dev:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID --env dev       # client ID of the gobridge-dev OAuth client
npx wrangler secret put GOOGLE_CLIENT_SECRET --env dev   # client secret of the gobridge-dev OAuth client
npx wrangler secret put ALLOWED_EMAIL --env dev          # the one Google address allowed to sign in
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY --env dev   # new random key, sent straight to Cloudflare
openssl rand -hex 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY --env dev    # new random key, sent straight to Cloudflare
```

If Wrangler says the Worker does not exist yet and offers to create it, answer **yes**.

For production, run the same five commands with `--env production`, using the `gobridge-prod` client ID and secret. The two `openssl` commands generate brand-new keys each time, so production never shares a key with dev. Never copy a dev key into production.

Optional, for running locally with `npm run dev`: put the same five names in a file called `.dev.vars` (one `NAME=value` per line). That file is gitignored. Never commit it.

## 5. Deploying

```sh
npm run deploy:dev     # typecheck + tests, then deploy to gobridge-dev
npm run deploy:prod    # typecheck + tests, then deploy to gobridge (owner only)
```

Both refuse to deploy if the typecheck or any test fails. Production deploys are done only by the owner, following `PROD_CHECKLIST.md`.

## 6. Linking Google accounts

Linking gives GoBridge access to one Google account. Do it once per account.

1. Open `/link` on the server in your browser (dev: <https://gobridge-dev.krishnakem.workers.dev/link>).
2. Sign in with the owner account (the `ALLOWED_EMAIL` address). Nobody else can open this page.
3. Type a short alias such as `personal` (lowercase letters, numbers, hyphens) and click **Continue to Google**.
4. On Google's screens, pick the account you want to link. Google warns that the app is unverified: click **Advanced**, then **Go to GoBridge**. Leave **every** permission ticked and continue. GoBridge refuses a partial grant and saves nothing.
5. You land back on `/link` with the account listed.

GoBridge asks Google for exactly these permissions and no others: read and modify Gmail (no permanent delete), send Gmail, edit Calendar events, see your list of calendars, see free/busy times, full access to Drive files, and your email address. Accounts linked before a permission was added show **Needs re-link**: unlink and link them again.

The account's refresh token is stored encrypted (AES-256-GCM with `TOKEN_ENCRYPTION_KEY`). If that key is ever changed or lost, linked accounts stop working: unlink them and link again.

**Signing out:** open the account menu (your initial, bottom-left on a computer, top-right on a phone) and click **Sign Out**. An owner session also ends by itself after 2 hours. Signing out does not disconnect AI clients; use `/clients` for that. A red dot on your initial means something needs attention: writes are switched off, or an account must be linked again. The **Settings** page in the same menu shows the current limits and today's usage; it is read-only.

**Unlinking:** click **Unlink** next to the account. GoBridge asks Google to revoke its access and deletes the stored record. If the page says Google did not confirm, also remove GoBridge at <https://myaccount.google.com/connections> for that account.

## 7. Connecting Claude and ChatGPT

The address to give each client is the server URL followed by `/mcp`:

- dev: `https://gobridge-dev.krishnakem.workers.dev/mcp`
- production: `https://gobridge.krishnakem.workers.dev/mcp`

Link at least one Google account first (section 6).

**Claude** (claude.ai or the desktop app):

1. Settings → Connectors → **Add custom connector**.
2. Name: `GoBridge-Dev` (or `GoBridge` for production). URL: the `/mcp` address above. Leave the advanced OAuth fields empty.
3. Click **Add**, then **Connect**. A GoBridge page opens: approve it, then sign in to Google with the owner account.
4. In a new chat, turn the connector on and ask: "Use GoBridge to list my linked accounts."

**ChatGPT:**

1. Settings → Apps & Connectors → Advanced settings → turn on **Developer mode**.
2. Plugins → **Create MCP App**. Name: `GoBridge-Dev`. MCP server URL: the `/mcp` address above. Authentication: **OAuth**.
3. Create it, then sign in the same way as for Claude.
4. In a new chat, add the app and ask it to list your linked accounts.

In each client, also:

- Set GoBridge's write tools to **require approval** every time.
- Turn **off** the setting that allows your chats to be used for model training.

GoBridge exposes the same 51 tools as Google's own Gmail, Calendar and Drive connectors, with the same names, plus `list_accounts`. Every tool takes the account alias.

- **Gmail (30):** search_threads, get_thread, get_message, list_drafts, get_draft, list_labels; create_draft, update_draft, delete_draft; send_message, reply, forward; create_label, update_label, delete_label; label_message, unlabel_message, label_thread, unlabel_thread, update_message_labels; trash_message, untrash_message, trash_thread, untrash_thread, mark_message_spam, unmark_message_spam, mark_thread_spam, unmark_thread_spam, apply_sensitive_message_label, apply_sensitive_thread_label.
- **Calendar (9):** list_calendars, list_events, search_events, get_event, create_event, update_event, delete_event, respond_to_event, suggest_time.
- **Drive (11):** search_files, list_recent_files, get_file_metadata, get_file_permissions, read_file_content, download_file_content, create_file, copy_file, update_file, trash_file, share_file.

What stays protected:

- Messages and files are only ever trashed, never permanently deleted. Only unsent drafts and user labels can be deleted.
- Calendar tools send **no** emails to guests unless the AI passes a notification level explicitly. Event times use `America/Detroit` unless another time zone is given.
- Drive sharing is to one person or group only, never "anyone" or a whole domain, and is capped at 10 shares per account per day.
- Limits per linked account: 25 sent emails per day (sending, replying and forwarding all count), 60 write actions per hour, 300 read actions per hour, 20 recipients per message, 25 MB of attachments.
- Everything that comes from outside (email text, event details, file contents and names, label names) is handed to the AI inside `<untrusted_content>` markers, so it is treated as data and not as instructions.
- Every write is recorded on the `/audit` page (dev: <https://gobridge-dev.krishnakem.workers.dev/audit>): time, which AI client, account, action, recipients and subject, event name, or file id. Never the body. Reads are recorded too, with only the tool name and how many items came back; click **Show reads too** to see them. Entries are kept 90 days.

Because the AI can now send, forward and share directly, **set every write tool to require approval in each AI client** (section 7). That approval step is the main protection against a malicious email or file tricking the AI.

If a tool answers "re-link this account at /link", unlink and link that account again (section 6). If a write tool answers "reconnect GoBridge", remove the connector in that AI client and add it again.

## 8. Turning off Cloudflare Preview URLs

Preview URLs are extra public addresses for a Worker. `wrangler.jsonc` already sets `"preview_urls": false`. To double-check in the dashboard: Workers & Pages → the worker → Settings → Domains & Routes → Preview URLs → Disabled.

## 9. Kill switches

Five settings in `wrangler.jsonc` turn features off. Each must be exactly `"true"` to be on; change it to `"false"` and deploy again (`npm run deploy:dev`), or edit it in the Cloudflare dashboard under the Worker's Variables for an immediate effect (then update `wrangler.jsonc` to match before the next deploy).

| Variable | Turns off |
| --- | --- |
| `WRITES_ENABLED` | Every write tool. Read tools keep working. |
| `DIRECT_SEND_ENABLED` | Sending without a draft (`send_message` without `draftId`) and `reply`. Sending a saved draft still works. |
| `FORWARD_ENABLED` | `forward`. |
| `DRIVE_WRITE_ENABLED` | `create_file`, `copy_file`, `update_file`, `trash_file`. |
| `DRIVE_SHARE_ENABLED` | `share_file`. |

The **Settings** page shows all five, and your initial gets a red dot when any is off.

## 10. Revoking access

**One AI client:** open `/clients` (dev: <https://gobridge-dev.krishnakem.workers.dev/clients>), sign in as the owner, and click **Revoke** next to it. Its tokens stop working at once and its registration is removed; other clients are not affected. To use that client again, add GoBridge in it again.

**Everything:**

1. Google: <https://myaccount.google.com/connections> → GoBridge → remove access (do this for each linked account). Or click **Unlink** for each account on `/link`.
2. GoBridge: the `/clients` page → revoke each AI client.
3. Cloudflare dashboard: delete the Worker, its two KV namespaces and its D1 database.

## Scripts

| Command               | What it does                                          |
| --------------------- | ----------------------------------------------------- |
| `npm run typecheck`   | Checks the TypeScript code for errors                 |
| `npm test`            | Runs the tests                                        |
| `npm run predeploy`   | Typecheck + tests                                     |
| `npm run migrate:dev` | Creates or updates the audit tables in the dev database |
| `npm run deploy:dev`  | Predeploy, then deploy to dev                         |
| `npm run deploy:prod` | Predeploy, then deploy to production (owner only)     |
| `npm run cf-typegen`  | Regenerates types after editing `wrangler.jsonc`      |
| `npm run hooks:install` | Turns on the gitleaks commit hook                   |
