# GoBridge

A single-owner remote MCP server on Cloudflare Workers that lets AI clients (Claude, ChatGPT) use **several Google accounts** — Gmail, Google Calendar and Google Drive — through one connector.

Personal project, shared as a reference. Not a hosted service; deploy your own copy.

## What it does

- 72 MCP tools matching the names and parameters of Google's own Gmail (30), Calendar (9) and Drive (11) connectors and its Docs (2), Sheets (6) and Slides (4) MCP servers, plus the Sheets API methods those servers leave out (8), one Drive Activity tool and `list_accounts`. Every tool takes an account alias.
- Link any number of Google accounts on an owner-only `/link` page (rename or unlink them there too); refresh tokens are stored encrypted (AES-256-GCM).
- Only one Google account (the owner, set in a secret) can sign in. OAuth 2.1 with PKCE S256 for AI clients.

## Guardrails

- Messages and files are never permanently deleted (only unsent drafts and labels can be).
- Per-account limits: 25 sends/day, 60 writes/hour, 300 reads/hour, 10 Drive shares/day. Counters are atomic and fail closed.
- Drive sharing only to a person or group, never "anyone" or a whole domain. Copying a sheet into another spreadsheet only when this account owns the destination, and it counts as a share.
- Docs and Slides requests that make Google fetch a URL (inserting images from URLs) and Sheets formulas that reach outside the spreadsheet (`IMPORTRANGE`, `IMPORTXML`, `IMAGE`, `HYPERLINK`...) are refused unless the call carries an explicit `allowExternalUrls` / `allowExternalFormulas` flag that the tool description reserves for URLs and formulas the user personally supplied. The audit log records that the flag was set, never the URL or formula.
- Slide thumbnails are fetched server-side from Google's image host only and returned as images; no URL is handed to the model.
- Content inside Docs, Sheets and Slides can be edited and deleted (version history restores it); files themselves are only ever trashed.
- Kill switches for all writes, direct send, forward, Drive writes and Drive sharing.
- Audit log (D1) of writes and minimal reads — never message bodies, queries, cell values, formulas, ranges, titles or file content; for Docs/Sheets/Slides writes it records file ids, request types with counts, cell counts and the override flags; 90-day retention.
- All external content is wrapped in `<untrusted_content>` so the model treats it as data, not instructions.
- Allowed AI clients: an app can sign in and use `/mcp` only when every redirect URL it registered is on the owner's list in `/settings`. Checked at `/authorize`, `/callback` and on every `/mcp` request; removing a URL cuts that app off at once. An empty list allows no app.
- Owner pages: CSRF on every state change, strict CSP, no inline scripts.

Set every write tool to **require approval** in your AI client — that is the main defence against prompt injection from email or files.

## Stack

TypeScript · Cloudflare Workers, KV, D1, Durable Objects · `@cloudflare/workers-oauth-provider` · `@modelcontextprotocol/sdk` · Hono · Vitest

## Running your own

1. Google Cloud: enable the Gmail, Calendar and Drive APIs and create a Web application OAuth client with redirect URIs `https://<your-worker>.<your-subdomain>.workers.dev/callback` and `https://<your-worker>.<your-subdomain>.workers.dev/link/callback`.
2. Create the KV namespaces and D1 database (`wrangler kv namespace create`, `wrangler d1 create`), put their ids in `wrangler.jsonc`, and set `BASE_URL` to your worker URL.
3. Set secrets with `wrangler secret put`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL`, `COOKIE_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY` (generate the two keys with `openssl rand -hex 32`). For local development, use a gitignored `.dev.vars`.
4. `npm install`, then `npm run migrate:dev` and `npm run deploy:dev`.
5. Open `/link` and link your accounts. On `/settings`, under **Allowed AI clients**, add the redirect URL of each AI app you use:
   - Claude (web, desktop, mobile): `https://claude.ai/api/mcp/auth_callback`
   - Claude Code: `http://localhost/callback` and `http://127.0.0.1/callback` (loopback URLs match on any port)
   - ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect` (or the app-specific URL ChatGPT shows)

   If you miss one, GoBridge shows you the exact URL when that app tries to connect.
6. Add `https://<your-worker>.<your-subdomain>.workers.dev/mcp` as a custom connector in your AI client.

The Google app will be unverified. Scopes requested when linking an account: `gmail.modify`, `gmail.send`, `calendar.events`, `calendar.calendarlist.readonly`, `calendar.freebusy`, `drive`, `openid`, `email`, `profile` (picture URL only). Owner sign-in for the owner pages uses `openid`, `email`, `profile`; AI-client sign-in uses `openid`, `email`.

## Development

`npm run typecheck` · `npm test` · `npm run hooks:install` (gitleaks pre-commit hook)

## Credits

OAuth helper code adapted from Cloudflare's remote MCP server templates.
