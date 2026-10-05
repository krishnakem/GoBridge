/**
 * Owner-only "link a Google account" pages.
 *
 *   GET  /link           list linked accounts (starts owner sign-in if needed)
 *   POST /link           start linking under an alias     (session + CSRF)
 *   GET  /link/callback  Google returns here              (session + state + PKCE)
 *   POST /link/unlink    revoke at Google + delete record (session + CSRF)
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
	type AccountInfo,
	ALIAS_PATTERN,
	deleteAccount,
	getAccount,
	getRefreshToken,
	listAccounts,
	saveAccount,
} from "./accounts";
import { randomToken, safeEqual, sha256Base64Url } from "./crypto";
import {
	buildLinkAuthorizeUrl,
	exchangeLinkCode,
	grantedScopesMatch,
	LINK_SCOPES,
	revokeGoogleToken,
} from "./google";
import { type Attention, escapeHtml, renderMessagePage, renderOwnerPage } from "./html";
import { ownerStatus } from "./owner-status";
import { hasValidCsrf, type OwnerSession, readOwnerSession, startOwnerLogin } from "./session";

const LINK_STATE_TTL_SECONDS = 600;

const aliasSchema = z.string().regex(ALIAS_PATTERN);

type LinkState = {
	alias: string;
	/** PKCE code verifier; never leaves the server */
	verifier: string;
	/** CSRF token of the owner session that started this link */
	csrf: string;
};

type LinkContext = Context<{ Bindings: Env }>;

const NOTICES: Record<string, { text: string; warn?: boolean }> = {
	linked: { text: "Account linked." },
	unlinked: { text: "Account unlinked and its access revoked at Google." },
	unlinked_not_revoked: {
		text: "Account unlinked here, but Google did not confirm the revocation. Also remove GoBridge at myaccount.google.com/connections for that account.",
		warn: true,
	},
};

function denied(message: string, status: 400 | 403 | 404 | 502, category: string, route: string) {
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

function renderLinkPage(
	session: OwnerSession,
	accounts: AccountInfo[],
	attention: Attention,
	notice?: string,
) {
	const csrf = escapeHtml(session.csrf);
	const note = notice && NOTICES[notice];
	const noteHtml = note
		? `<p class="${note.warn ? "warn" : "notice"}">${escapeHtml(note.text)}</p>`
		: "";

	const rows = accounts
		.map(
			(account) => `<tr>
<td><strong>${escapeHtml(account.alias)}</strong></td>
<td>${escapeHtml(account.email)}</td>
<td>${
				attention.relink.includes(account.alias)
					? '<span class="badge badge-alert">Needs re-link</span>'
					: '<span class="badge badge-ok">Linked</span>'
			}</td>
<td class="muted">${escapeHtml(account.linkedAt.slice(0, 10))}</td>
<td><form class="inline" method="post" action="/link/unlink">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="alias" value="${escapeHtml(account.alias)}">
<button class="btn-danger" type="submit">Unlink</button>
</form></td>
</tr>`,
		)
		.join("\n");

	const table = accounts.length
		? `<div class="table-wrap"><table>
<tr><th>Alias</th><th>Google account</th><th>Status</th><th>Linked</th><th></th></tr>
${rows}
</table></div>`
		: `<p class="muted">No accounts linked yet.</p>`;
	const relinkHelp = attention.relink.length
		? `<p class="warn">Needs re-link: ${escapeHtml(attention.relink.join(", "))}. Either Google no longer accepts GoBridge's access, or the account was linked before the current permissions were added. Unlink each one, then link it again with the same alias.</p>`
		: "";

	return renderOwnerPage({
		active: "/link",
		attention,
		bodyHtml: `${noteHtml}${relinkHelp}
${table}
<h2>Link a Google account</h2>
<p>Pick a short alias (for example <code>personal</code>). AI clients use it to say which account to act on.</p>
<form class="field" method="post" action="/link">
<input type="hidden" name="csrf_token" value="${csrf}">
<label for="alias">Alias</label>
<input id="alias" type="text" name="alias" required maxlength="32" pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?" autocomplete="off">
<button class="btn-primary" type="submit">Continue to Google</button>
</form>
<p class="muted small">Lowercase letters, numbers and hyphens only. On Google's screen, leave every permission ticked: GoBridge refuses a partial grant.</p>`,
		session,
		title: "Linked accounts",
	});
}

const app = new Hono<{ Bindings: Env }>();

app.get("/link", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) {
		// No content without a session: straight to owner sign-in.
		return startOwnerLogin(c.req.raw, c.env, "/link");
	}
	const { accounts, attention } = await ownerStatus(c.env);
	return renderLinkPage(session, accounts, attention, c.req.query("msg"));
});

app.post("/link", async (c) => {
	const gate = await requireOwnerPost(c, "POST /link");
	if (gate instanceof Response) return gate;

	const alias = aliasSchema.safeParse(gate.form.get("alias"));
	if (!alias.success) {
		return denied(
			"An alias must be 1-32 lowercase letters, numbers or hyphens, and cannot start or end with a hyphen.",
			400,
			"bad_alias",
			"POST /link",
		);
	}

	const state = randomToken();
	const verifier = randomToken(48);
	const linkState: LinkState = { alias: alias.data, csrf: gate.session.csrf, verifier };
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
		refreshToken: grant.refreshToken,
		scopes: [...LINK_SCOPES],
		sub: grant.sub,
	});
	console.log(`${route} ok: linked alias=${alias}`);
	return c.redirect("/link?msg=linked", 303);
});

app.post("/link/unlink", async (c) => {
	const route = "POST /link/unlink";
	const gate = await requireOwnerPost(c, route);
	if (gate instanceof Response) return gate;

	const alias = aliasSchema.safeParse(gate.form.get("alias"));
	if (!alias.success || !(await getAccount(c.env, alias.data))) {
		return denied("No linked account has that alias.", 404, "unknown_alias", route);
	}

	let refreshToken: string | null = null;
	try {
		refreshToken = await getRefreshToken(c.env, alias.data);
	} catch (_e) {
		refreshToken = null; // undecryptable record: still delete it below
	}
	const revoked = refreshToken ? await revokeGoogleToken(refreshToken) : false;
	await deleteAccount(c.env, alias.data);

	console.log(`${route} ok: unlinked alias=${alias.data} revoked=${revoked}`);
	return c.redirect(`/link?msg=${revoked ? "unlinked" : "unlinked_not_revoked"}`, 303);
});

export { app as LinkHandler };
