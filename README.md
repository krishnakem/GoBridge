# GoBridge

A single-owner remote MCP server on Cloudflare Workers that lets AI clients (Claude, ChatGPT) use **several Google accounts** — Gmail, Google Calendar and Google Drive — through one connector.

Personal project, shared as a reference. Not a hosted service; deploy your own copy.

## What it does

- 51 MCP tools matching the names and parameters of Google's own Gmail (30), Calendar (9) and Drive (11) connectors, plus `list_accounts`. Every tool takes an account alias.
- Link any number of Google accounts on an owner-only `/link` page (rename or unlink them there too); refresh tokens are stored encrypted (AES-256-GCM).
- Only one Google account (the owner, set in a secret) can sign in. OAuth 2.1 with PKCE S256 for AI clients.

## Guardrails

- Messages and files are never permanently deleted (only unsent drafts and labels can be).
- Per-account limits: 25 sends/day, 60 writes/hour, 300 reads/hour, 10 Drive shares/day. Counters are atomic and fail closed.
- Drive sharing only to a person or group, never "anyone" or a whole domain.
- Kill switches for all writes, direct send, forward, Drive writes and Drive sharing.
- Audit log (D1) of writes and minimal reads — never message bodies, queries or file content; 90-day retention.
- All external content is wrapped in `<untrusted_content>` so the model treats it as data, not instructions.
- Owner pages: CSRF on every state change, strict CSP, no inline scripts.

Set every write tool to **require approval** in your AI client — that is the main defence against prompt injection from email or files.

## Stack

TypeScript · Cloudflare Workers, KV, D1, Durable Objects · `@cloudflare/workers-oauth-provider` · `@modelcontextprotocol/sdk` · Hono · Vitest

## Running your own

1. Google Cloud: enable the Gmail, Calendar and Drive APIs and create a Web application OAuth client with redirect URIs `https://<your-worker>.<your-subdomain>.workers.dev/callback` and `https://<your-worker>.<your-subdomain>.workers.dev/link/callback`.
2. Create the KV namespaces and D1 database (`wrangler kv namespace create`, `wrangler d1 create`), put their ids in `wrangler.jsonc`, and set `BASE_URL` to your worker URL.
3. Set secrets with `wrangler secret put`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL`, `COOKIE_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY` (generate the two keys with `openssl rand -hex 32`). For local development, use a gitignored `.dev.vars`.
4. `npm install`, then `npm run migrate:dev` and `npm run deploy:dev`.
5. Open `/link`, link your accounts, then add `https://<your-worker>.<your-subdomain>.workers.dev/mcp` as a custom connector in your AI client.

The Google app will be unverified. Scopes requested when linking an account: `gmail.modify`, `gmail.send`, `calendar.events`, `calendar.calendarlist.readonly`, `calendar.freebusy`, `drive`, `openid`, `email`, `profile` (picture URL only). Owner sign-in for the owner pages uses `openid`, `email`, `profile`; AI-client sign-in uses `openid`, `email`.

## Development

`npm run typecheck` · `npm test` · `npm run hooks:install` (gitleaks pre-commit hook)

## Credits

OAuth helper code adapted from Cloudflare's remote MCP server templates.
