/**
 * Owner-only "link a Google account" pages.
 *
 *   GET  /link           list linked accounts (starts owner sign-in if needed)
 *   POST /link           start linking under an alias     (session + CSRF)
 *   GET  /link/callback  Google returns here              (session + state + PKCE)
 *   POST /link/unlink    revoke at Google + delete record (session + CSRF)
 *   POST /link/rename    move the record to a new alias    (session + CSRF)
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import {
	type AccountInfo,
	ALIAS_PATTERN,
	checkNewAlias,
	deleteAccount,
	getAccount,
	getRefreshToken,
	listAccounts,
	renameAccount,
	saveAccount,
} from "./accounts";
import { letterTileHtml } from "./client-logos";
import {
	emptyCardHtml,
	errorCardHtml,
	exportHref,
	groupLogoHtml,
	listFootHtml,
	loadAccountClientRows,
	loadOrNull,
	modalHtml,
	ROW_LIMIT,
	statusHtml,
	timeHtml,
	usageMetersHtml,
} from "./components";
import { randomToken, safeEqual, sha256Base64Url } from "./crypto";
import {
	buildLinkAuthorizeUrl,
	exchangeLinkCode,
	grantedScopesMatch,
	hasDriveActivityScope,
	LINK_SCOPES,
	revokeGoogleToken,
} from "./google";
import {
	carryOverUsage,
	OWNER_RENAME_LIMIT_PER_HOUR,
	recordAudit,
	takeOwnerRename,
	writesEnabled,
	writeUsage,
} from "./guardrails";
import {
	type Attention,
	avatarHtml,
	escapeHtml,
	ICONS,
	renderMessagePage,
	renderOwnerPage,
} from "./html";
import { ownerStatus } from "./owner-status";
import { hasValidCsrf, type OwnerSession, readOwnerSession, startOwnerLogin } from "./session";

const LINK_STATE_TTL_SECONDS = 600;

/** An alias that names an account already stored: the pattern only. New aliases use checkNewAlias. */
const existingAlias = (value: unknown) =>
	typeof value === "string" && ALIAS_PATTERN.test(value) ? value : null;

const ALIAS_INPUT = 'required maxlength="32" pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?" autocomplete="off" autocapitalize="none" spellcheck="false"';

type LinkState = {
	alias: string;
	/** PKCE code verifier; never leaves the server */
	verifier: string;
	/** CSRF token of the owner session that started this link */
	csrf: string;
};

type LinkContext = Context<{ Bindings: Env & { OAUTH_PROVIDER?: OAuthHelpers } }>;

const NOTICES: Record<string, { text: string; warn?: boolean }> = {
	linked: { text: "Account linked." },
	renamed: { text: "Account renamed. Use the new alias in your AI clients from now on." },
	unlinked: { text: "Account unlinked and its access revoked at Google." },
	unlinked_not_revoked: {
		text: "Account unlinked here, but Google did not confirm the revocation. Also remove GoBridge at myaccount.google.com/connections for that account.",
		warn: true,
	},
};

function denied(
	message: string,
	status: 400 | 403 | 404 | 429 | 500 | 502 | 503,
	category: string,
	route: string,
) {
	console.warn(`${route} denied: ${category}`);
	return renderMessagePage("Could not continue", message, status, undefined, "/link");
}

/** Session + CSRF gate for every state-changing owner action. */
export async function requireOwnerPost(
	c: LinkContext,
	route: string,
): Promise<{ session: OwnerSession; form: FormData } | Response> {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) {
		return denied("Please sign in at /link first.", 403, "no_session", route);
	}
	let form: FormData;
	try {
		form = await c.req.raw.formData();
	} catch (_e) {
		return denied("The form could not be read.", 400, "bad_form", route);
	}
	if (!hasValidCsrf(session, form.get("csrf_token"))) {
		return denied("This form has expired. Go back and try again.", 403, "bad_csrf", route);
	}
	return { form, session };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** One account card: photo, alias (with inline rename), email, status dot. The alias opens the detail view. */
function accountCardHtml(account: AccountInfo, relink: boolean, csrf: string): string {
	const alias = escapeHtml(account.alias);
	return `<div class="card card-click${relink ? " card-alert" : ""}">
<div class="card-head">
${avatarHtml(account.email, 32, account.picture)}
<div class="card-main">
<div class="card-title" data-rename>
<span class="rename-view" data-rename-view><a class="card-link" id="acct-${alias}" href="/link?open=${alias}"><strong>${alias}</strong></a>
<a class="icon-btn reveal" href="/link?open=${alias}#rename" data-rename-open aria-label="Rename ${alias}" title="Rename">${ICONS.pencil}</a></span>
<form class="rename-inline" method="post" action="/link/rename" hidden data-rename-form>
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="alias" value="${alias}">
<input type="text" name="newAlias" value="${alias}" ${ALIAS_INPUT} aria-label="New alias for ${alias}">
<div class="rename-confirm" role="alert" hidden data-rename-confirm>
<p class="small">Rename <strong>${alias}</strong> to <strong data-rename-new></strong>? AI clients must use the new alias from then on. Saved instructions that use the old alias will stop working.</p>
<div class="actions"><button class="btn-primary" type="submit" name="confirm" value="yes">Rename</button>
<button type="button" data-rename-cancel>Cancel</button></div>
</div>
</form>
</div>
<div class="card-sub">${escapeHtml(account.email)}</div>
</div>
</div>
<div class="card-foot">${statusHtml(relink)}${
		!relink && !hasDriveActivityScope(account.scopes)
			? '<span class="muted small">Re-link for Drive Activity</span>'
			: ""
	}</div>
</div>`;
}

/** The last card: opens the alias field that starts the existing link flow. */
function addCardHtml(csrf: string, open: boolean): string {
	return `<details class="card card-add disclose"${open ? " open" : ""}>
<summary aria-label="Link a Google account"><span class="plus">${ICONS.plus}</span><span>Link a Google account</span></summary>
<form class="field" method="post" action="/link">
<input type="hidden" name="csrf_token" value="${csrf}">
<input id="alias" type="text" name="alias" ${ALIAS_INPUT} aria-label="Alias for the new account" placeholder="alias, e.g. personal">
<button class="btn-primary" type="submit">Continue to Google</button>
</form>
<p class="card-sub">The alias is the name AI clients use for this account. Lowercase letters, numbers and hyphens. On Google's screen, leave every permission ticked.</p>
</details>`;
}

/**
 * Which AI clients used this account, with last activity and write count:
 * the first ROW_LIMIT rows, and a CSV of them all.
 */
async function accountClientsHtml(
	env: LinkContext["env"],
	session: OwnerSession,
	account: AccountInfo,
): Promise<string> {
	const rows = await loadOrNull(
		loadAccountClientRows(env, env.OAUTH_PROVIDER, session.sub, account.alias),
	);
	if (!rows) return errorCardHtml("this account's activity", `/link?open=${escapeHtml(account.alias)}`);
	const foot = listFootHtml(exportHref("account-clients", { account: account.alias }), rows.length);
	if (!rows.length) {
		return `<p class="muted">No AI client has used this account in the last 90 days.</p>
${foot}`;
	}
	return `<ul class="rows">
${rows
	.slice(0, ROW_LIMIT)
	.map(
		(row) => `<li class="row">
${row.group ? groupLogoHtml(row.group) : letterTileHtml(row.label)}
<div class="row-main"><div><strong>${escapeHtml(row.label)}</strong>${row.group ? (row.group.unverified ? ' <span class="badge badge-alert">Unverified</span>' : "") : ' <span class="badge">No longer registered</span>'}</div>
<div class="card-sub">Last active ${timeHtml(row.lastActive)} · ${plural(row.writes, "write")}</div></div>
</li>`,
	)
	.join("\n")}
</ul>
${foot}`;
}

/** The account detail view: usage, per-client status, rename, re-link and unlink. */
async function accountModalHtml(
	env: LinkContext["env"],
	session: OwnerSession,
	account: AccountInfo,
	relink: boolean,
): Promise<string> {
	const alias = escapeHtml(account.alias);
	const csrf = escapeHtml(session.csrf);
	const [usage, clients] = await Promise.all([
		writeUsage(env, account.alias),
		accountClientsHtml(env, session, account),
	]);
	return modalHtml({
		bodyHtml: `<section class="modal-section">
<h3>Usage</h3>
${usageMetersHtml(env, usage)}
</section>
<section class="modal-section">
<h3>AI clients</h3>
${clients}
</section>
<section class="modal-section" id="rename">
<h3>Rename</h3>
<form class="stack" method="post" action="/link/rename">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="alias" value="${alias}">
<label for="modal-new-alias">New alias</label>
<input id="modal-new-alias" type="text" name="newAlias" ${ALIAS_INPUT}>
<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I understand that AI clients must use the new alias, and saved instructions that use <strong>${alias}</strong> will stop working.</span></label>
<button type="submit">Rename</button>
</form>
</section>
<section class="modal-section">
<div class="actions">
<form method="post" action="/link">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="alias" value="${alias}">
<button type="submit" title="Sign in to Google again for this account, keeping the alias">Re-link</button>
</form>
<details class="disclose confirm">
<summary class="btn btn-danger" aria-label="Unlink ${alias}">Unlink…</summary>
<form method="post" action="/link/unlink">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="alias" value="${alias}">
<p class="small">This revokes GoBridge's access to this Google account and removes it here. AI clients can no longer use <strong>${alias}</strong>.</p>
<button class="btn-danger-solid" type="submit" name="confirm" value="yes">Yes, unlink ${alias}</button>
</form>
</details>
</div>
</section>`,
		closeHref: `/link#acct-${account.alias}`,
		leadHtml: avatarHtml(account.email, 32, account.picture),
		subHtml: `${escapeHtml(account.email)}<br>${statusHtml(relink)} <span class="muted">· linked ${escapeHtml(account.linkedAt.slice(0, 10))}</span>`,
		title: account.alias,
	});
}

function renderLinkPage(
	session: OwnerSession,
	accounts: AccountInfo[] | null,
	attention: Attention,
	options: { notice?: string; overlayHtml?: string },
) {
	const csrf = escapeHtml(session.csrf);
	const note = options.notice && NOTICES[options.notice];
	const noteHtml = note
		? `<p class="${note.warn ? "warn" : "notice"}">${escapeHtml(note.text)}</p>`
		: "";
	const relinkHelp = attention.relink.length
		? `<p class="warn">Needs re-login: ${escapeHtml(attention.relink.join(", "))}. Either Google no longer accepts GoBridge's access, or the account was linked before the current permissions were added. Open the account and choose Re-link.</p>`
		: "";
	const grid =
		accounts === null
			? `<div class="cards">
${errorCardHtml("your linked accounts", "/link")}
</div>`
			: `<div class="cards">
${
	accounts.length
		? accounts
				.map((account) => accountCardHtml(account, attention.relink.includes(account.alias), csrf))
				.join("\n")
		: emptyCardHtml(
				"No accounts linked yet",
				'<p class="card-sub">Link a Google account to let your AI clients use its Gmail, Calendar and Drive. Pick a short alias for it, such as <code>personal</code>, then sign in to that account at Google.</p>',
			)
}
${addCardHtml(csrf, accounts.length === 0)}
</div>`;

	return renderOwnerPage({
		active: "/link",
		attention,
		bodyHtml: `${noteHtml}${relinkHelp}
${grid}`,
		overlayHtml: options.overlayHtml,
		session,
		title: "Linked accounts",
	});
}

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER?: OAuthHelpers } }>();

// A failed load never shows a blank page or a raw error.
app.onError((_error, c) => {
	console.error(`${c.req.method} ${c.req.routePath} error: internal`);
	return renderMessagePage(
		"Something went wrong",
		c.req.method === "GET"
			? "GoBridge could not load this page. Nothing was changed."
			: "GoBridge hit an error. Check the page before trying again.",
		500,
		undefined,
		undefined,
		{ href: "/link", label: c.req.method === "GET" ? "Retry" : "Back to linked accounts" },
	);
});

app.get("/link", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) {
		// No content without a session: straight to owner sign-in.
		return startOwnerLogin(c.req.raw, c.env, "/link");
	}
	const status = await loadOrNull(ownerStatus(c.env));
	if (!status) {
		return renderLinkPage(session, null, { relink: [], writesOff: !writesEnabled(c.env) }, {});
	}
	const { accounts, attention } = status;
	// ?open= must be a well-formed alias of a linked account. Anything else
	// shows the page with no detail view: the value is never echoed.
	const wanted = existingAlias(c.req.query("open"));
	const open = wanted ? accounts.find((account) => account.alias === wanted) : undefined;
	return renderLinkPage(session, accounts, attention, {
		notice: c.req.query("msg"),
		overlayHtml: open
			? await accountModalHtml(c.env, session, open, attention.relink.includes(open.alias))
			: undefined,
	});
});

app.post("/link", async (c) => {
	const gate = await requireOwnerPost(c, "POST /link");
	if (gate instanceof Response) return gate;

	// A new alias must pass the reserved-word check. Re-connecting an account
	// that already has the alias only needs the alias to exist.
	const requested = gate.form.get("alias");
	const known = existingAlias(requested);
	const alias =
		known && (await getAccount(c.env, known))
			? ({ alias: known, ok: true } as const)
			: checkNewAlias(requested);
	if (!alias.ok) return denied(alias.message, 400, alias.category, "POST /link");

	const state = randomToken();
	const verifier = randomToken(48);
	const linkState: LinkState = { alias: alias.alias, csrf: gate.session.csrf, verifier };
	await c.env.OAUTH_KV.put(`link:state:${state}`, JSON.stringify(linkState), {
		expirationTtl: LINK_STATE_TTL_SECONDS,
	});

	return new Response(null, {
		status: 303,
		headers: {
			"Cache-Control": "no-store",
			Location: buildLinkAuthorizeUrl({
				clientId: c.env.GOOGLE_CLIENT_ID,
				codeChallenge: await sha256Base64Url(verifier),
				redirectUri: new URL("/link/callback", c.req.url).href,
				state,
			}),
		},
	});
});

app.get("/link/callback", async (c) => {
	const route = "GET /link/callback";
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) {
		return denied("Please sign in at /link first.", 403, "no_session", route);
	}

	// The state must be one we issued, unused, and started by THIS owner session.
	const state = c.req.query("state") || "";
	const stored = state ? await c.env.OAUTH_KV.get(`link:state:${state}`) : null;
	let linkState: LinkState | null = null;
	try {
		linkState = stored ? (JSON.parse(stored) as LinkState) : null;
	} catch (_e) {
		linkState = null;
	}
	if (!linkState || !safeEqual(linkState.csrf, session.csrf)) {
		return denied(
			"This link request is invalid or has expired. Nothing was saved.",
			400,
			"bad_state",
			route,
		);
	}
	await c.env.OAUTH_KV.delete(`link:state:${state}`); // one-time use

	const code = c.req.query("code");
	if (c.req.query("error") || !code) {
		return denied("Linking was cancelled. Nothing was saved.", 400, "cancelled", route);
	}

	const result = await exchangeLinkCode({
		clientId: c.env.GOOGLE_CLIENT_ID,
		clientSecret: c.env.GOOGLE_CLIENT_SECRET,
		code,
		codeVerifier: linkState.verifier,
		redirectUri: new URL("/link/callback", c.req.url).href,
	});
	if (!result.ok) {
		if (result.revokable) await revokeGoogleToken(result.revokable);
		return denied(
			"Google could not complete the link. Nothing was saved. Please try again.",
			502,
			result.reason,
			route,
		);
	}
	const { grant } = result;
	const { alias } = linkState;

	const accounts = await listAccounts(c.env);
	const sameGoogleAccount = accounts.find((account) => account.sub === grant.sub);

	// Revoking affects the whole Google grant, so only revoke a rejected token
	// when that Google account is not already linked here.
	const discard = async () => {
		if (!sameGoogleAccount) await revokeGoogleToken(grant.refreshToken);
	};

	if (!grantedScopesMatch(grant.grantedScope)) {
		await discard();
		return denied(
			"Google did not grant exactly the permissions GoBridge asks for. Nothing was saved. Try again and leave every permission ticked.",
			400,
			"scope_mismatch",
			route,
		);
	}
	if (sameGoogleAccount && sameGoogleAccount.alias !== alias) {
		return denied(
			`That Google account is already linked as "${sameGoogleAccount.alias}". Nothing was changed.`,
			400,
			"account_already_linked",
			route,
		);
	}
	const existing = await getAccount(c.env, alias);
	if (existing && existing.sub !== grant.sub) {
		await discard();
		return denied(
			`The alias "${alias}" is already used by another account. Unlink it first, or pick a different alias.`,
			400,
			"alias_in_use",
			route,
		);
	}

	await saveAccount(c.env, {
		alias,
		email: grant.email,
		picture: grant.picture,
		refreshToken: grant.refreshToken,
		scopes: [...LINK_SCOPES],
		sub: grant.sub,
	});
	console.log(`${route} ok: linked alias=${alias}`);
	return c.redirect("/link?msg=linked", 303);
});

/** Records an owner action on /link. A failed audit write never blocks the action. */
async function auditOwner(
	env: Env,
	route: string,
	entry: { alias: string; tool: string; outcome: string; newAlias?: string },
) {
	try {
		await recordAudit(env, {
			alias: entry.alias,
			clientId: "owner",
			clientName: "Owner (/link)",
			meta: entry.newAlias ? { newAlias: entry.newAlias } : {},
			outcome: entry.outcome,
			tool: entry.tool,
		});
	} catch (_e) {
		console.error(`${route} error: audit_failed`);
	}
}

// Unlinking reduces access, so it is never rate limited and never waits on a
// counter: owner session, CSRF, POST and the confirm step are its only gates.
app.post("/link/unlink", async (c) => {
	const route = "POST /link/unlink";
	const gate = await requireOwnerPost(c, route);
	if (gate instanceof Response) return gate;

	const alias = existingAlias(gate.form.get("alias"));
	if (!alias || !(await getAccount(c.env, alias))) {
		return denied("No linked account has that alias.", 404, "unknown_alias", route);
	}
	if (gate.form.get("confirm") !== "yes") {
		return denied("Unlinking needs to be confirmed. Nothing was changed.", 400, "not_confirmed", route);
	}

	let refreshToken: string | null = null;
	try {
		refreshToken = await getRefreshToken(c.env, alias);
	} catch (_e) {
		refreshToken = null; // undecryptable record: still delete it below
	}
	const revoked = refreshToken ? await revokeGoogleToken(refreshToken) : false;
	await deleteAccount(c.env, alias);
	await auditOwner(c.env, route, {
		alias,
		outcome: revoked ? "ok" : "not_revoked",
		tool: "unlink_account",
	});

	console.log(`${route} ok: unlinked alias=${alias} revoked=${revoked}`);
	return c.redirect(`/link?msg=${revoked ? "unlinked" : "unlinked_not_revoked"}`, 303);
});

app.post("/link/rename", async (c) => {
	const route = "POST /link/rename";
	const gate = await requireOwnerPost(c, route);
	if (gate instanceof Response) return gate;

	const alias = existingAlias(gate.form.get("alias"));
	const current = alias ? await getAccount(c.env, alias) : null;
	if (!alias || !current) {
		return denied("No linked account has that alias.", 404, "unknown_alias", route);
	}
	const target = checkNewAlias(gate.form.get("newAlias"));
	if (!target.ok) return denied(target.message, 400, target.category, route);
	const newAlias = target.alias;
	if (newAlias === alias) {
		return denied("That is already the account's alias. Nothing was changed.", 400, "same_alias", route);
	}
	if (gate.form.get("confirm") !== "yes") {
		return denied(
			"Renaming needs to be confirmed, because saved instructions that use the old alias will stop working. Nothing was changed.",
			400,
			"not_confirmed",
			route,
		);
	}
	// In use by another Google account: refused. The same account already
	// under the new alias is an interrupted rename, which may be finished.
	const taken = await getAccount(c.env, newAlias);
	if (taken && taken.sub !== current.sub) {
		return denied(
			`The alias "${newAlias}" is already in use. Nothing was changed.`,
			400,
			"alias_in_use",
			route,
		);
	}

	// Renames are rate limited (fail closed), unlike unlink and revoke.
	let allowed: boolean;
	try {
		allowed = await takeOwnerRename(c.env);
	} catch (_e) {
		return denied(
			"GoBridge could not check its rename limit, so nothing was renamed. Try again in a moment.",
			503,
			"counter_unavailable",
			route,
		);
	}
	if (!allowed) {
		return denied(
			`Rename limit reached: at most ${OWNER_RENAME_LIMIT_PER_HOUR} renames an hour. Nothing was changed. Try again later.`,
			429,
			"rate_limited",
			route,
		);
	}

	// Usage limits move first: if they cannot, the rename is refused (fail closed).
	try {
		await carryOverUsage(c.env, alias, newAlias);
	} catch (_e) {
		return denied(
			"GoBridge could not carry the account's usage limits over to the new alias, so nothing was renamed. Try again in a moment.",
			502,
			"counter_unavailable",
			route,
		);
	}

	const outcome = await renameAccount(c.env, alias, newAlias);
	if (outcome === "verify_failed") {
		await auditOwner(c.env, route, { alias, newAlias, outcome, tool: "rename_account" });
		return denied(
			`GoBridge could not confirm the account under the new alias, so nothing was renamed. It still works as "${alias}". It is safe to try again.`,
			500,
			outcome,
			route,
		);
	}
	if (outcome === "old_not_removed") {
		await auditOwner(c.env, route, { alias, newAlias, outcome: "partial", tool: "rename_account" });
		return denied(
			`The account now works as "${newAlias}", but the old alias "${alias}" could not be removed and still works too. Rename "${alias}" to "${newAlias}" again to finish; it is safe to retry.`,
			500,
			outcome,
			route,
		);
	}
	if (outcome !== "ok") {
		return denied("The account could not be renamed. Nothing was changed.", 400, outcome, route);
	}
	// Second pass: catches a call counted on the old alias while the record moved.
	try {
		await carryOverUsage(c.env, alias, newAlias);
	} catch (_e) {
		// Already logged by carryOverUsage; the first pass carried the counts.
	}
	await auditOwner(c.env, route, { alias, newAlias, outcome: "ok", tool: "rename_account" });

	console.log(`${route} ok: alias=${alias} newAlias=${newAlias}`);
	return c.redirect("/link?msg=renamed", 303);
});

export { app as LinkHandler };
