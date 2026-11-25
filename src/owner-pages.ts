/**
 * Owner-only pages for reviewing and controlling access.
 *
 *   GET  /clients         AI clients, one card per app; ?open=<group key> shows the detail view
 *   POST /clients/revoke  remove every connection of one app          (session + CSRF + confirm)
 *   GET  /settings        allowed AI clients (editable), status, usage by account, all activity
 *   POST /settings/allowed-clients         allow one redirect URL     (session + CSRF)
 *   POST /settings/allowed-clients/remove  remove one redirect URL    (session + CSRF)
 *   GET  /audit           owner-only redirect to All activity on /settings
 *   POST /logout          end the owner session (session + CSRF); other methods get 405
 *   GET  /signed-out      public "Signed out" notice with a Sign in button
 *
 * Like /link: no content without an owner session, and every state-changing
 * action is POST-only with a CSRF token.
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { type AccountInfo, ALIAS_PATTERN } from "./accounts";
import {
	ACTIVITY_MAX_PAGE,
	type ActivityFilter,
	activityPage,
	aliasSpans,
	OWNER_CLIENT_ID,
	recentWrites,
} from "./activity";
import {
	addAllowedRedirect,
	isRedirectAllowed,
	listAllowedRedirects,
	MAX_ALLOWED_REDIRECTS,
	normalizeRedirectUri,
	removeAllowedRedirect,
} from "./allowed-clients";
import {
	type ClientDirectory,
	type ClientGroup,
	GROUP_KEY_PATTERN,
	loadClientDirectory,
	revokeGroup,
	revokeLeftoverGrants,
} from "./client-groups";
import { clientLogoHtml } from "./client-logos";
import {
	clientCardsHtml,
	drawerHtml,
	errorCardHtml,
	groupBadgesHtml,
	groupLogoHtml,
	loadGroupActivity,
	loadOrNull,
	revokeFormHtml,
	statusHtml,
	timeHtml,
	usageMetersHtml,
	writeLineHtml,
} from "./components";
import {
	type AuditEntry,
	dailySendCap,
	DAILY_SHARE_CAP,
	KILL_SWITCHES,
	OWNER_RENAME_LIMIT_PER_HOUR,
	recordAudit,
	readRateLimit,
	WRITE_RATE_LIMIT_PER_HOUR,
	writesEnabled,
	writeUsage,
	switchEnabled,
} from "./guardrails";
import {
	type Attention,
	avatarHtml,
	escapeHtml,
	ICONS,
	type OwnerPath,
	renderMessagePage,
	renderOwnerPage,
} from "./html";
import { ownerStatus } from "./owner-status";
import { requireOwnerPost } from "./link-handler";
import {
	endOwnerSession,
	readOwnerSession,
	SESSION_TTL_SECONDS,
	startOwnerLogin,
} from "./session";
import { uiCardsMode } from "./ui/resources";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

const OWNER_PATHS: readonly OwnerPath[] = ["/clients", "/settings", "/link"];

// A failed load never shows a blank page or a raw error.
app.onError((_error, c) => {
	console.error(`${c.req.method} ${c.req.routePath} error: internal`);
	const back = OWNER_PATHS.find((path) => c.req.routePath.startsWith(path)) ?? "/link";
	return renderMessagePage(
		"Something went wrong",
		c.req.method === "GET"
			? "GoBridge could not load this page. Nothing was changed."
			: "GoBridge hit an error. Check the page before trying again.",
		500,
		undefined,
		undefined,
		{ href: back, label: c.req.method === "GET" ? "Retry" : "Back" },
	);
});

/** Used when the account list itself cannot be read: the menu still renders. */
const fallbackAttention = (env: Env): Attention => ({ relink: [], writesOff: !writesEnabled(env) });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const day = (seconds?: number) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "");

function auditDetails(entry: AuditEntry): string {
	const meta = entry.meta ?? {};
	const parts: string[] = [];
	if (meta.recipients?.length) parts.push(`To: ${meta.recipients.join(", ")}`);
	if (meta.subject !== undefined) parts.push(`Subject: ${meta.subject}`);
	if (meta.summary !== undefined) parts.push(`Event: ${meta.summary}`);
	if (meta.eventId) parts.push(`Event id: ${meta.eventId}`);
	if (meta.response) parts.push(`Response: ${meta.response}`);
	if (meta.sendUpdates) parts.push(`Guests emailed: ${meta.sendUpdates === "all" ? "yes" : "no"}`);
	if (meta.messageCount !== undefined) parts.push(`Messages: ${meta.messageCount}`);
	if (meta.addLabelIds?.length) parts.push(`Added: ${meta.addLabelIds.join(", ")}`);
	if (meta.removeLabelIds?.length) parts.push(`Removed: ${meta.removeLabelIds.join(", ")}`);
	if (meta.messageId) parts.push(`Message id: ${meta.messageId}`);
	if (meta.draftId) parts.push(`Draft id: ${meta.draftId}`);
	if (meta.threadId) parts.push(`Thread id: ${meta.threadId}`);
	if (meta.originalMessageId) parts.push(`Forwarded message id: ${meta.originalMessageId}`);
	if (meta.labelIds?.length) parts.push(`Labels: ${meta.labelIds.join(", ")}`);
	if (meta.action) parts.push(`Action: ${meta.action}`);
	if (meta.fileId) parts.push(`File id: ${meta.fileId}`);
	if (meta.parentId) parts.push(`Folder id: ${meta.parentId}`);
	if (meta.recipient) parts.push(`Shared with: ${meta.recipient}${meta.role ? ` (${meta.role})` : ""}`);
	if (meta.destinationFileId) parts.push(`Copied into file id: ${meta.destinationFileId}`);
	if (meta.sheetId) parts.push(`Sheet id: ${meta.sheetId}${meta.dimension ? ` (${meta.dimension})` : ""}`);
	if (meta.requestTypes) {
		parts.push(`Requests: ${Object.entries(meta.requestTypes).map(([type, count]) => `${type} x${count}`).join(", ")}`);
	}
	if (meta.rangeCount !== undefined) parts.push(`Ranges: ${meta.rangeCount}`);
	if (meta.rowCount !== undefined) parts.push(`Rows: ${meta.rowCount}`);
	if (meta.cellCount !== undefined) parts.push(`Cells: ${meta.cellCount}`);
	if (meta.valueInputOption) parts.push(`Input: ${meta.valueInputOption}`);
	if (meta.commentOps) parts.push(`Comment requests: ${meta.commentOps}`);
	if (meta.allowExternalUrls) parts.push("External URLs allowed by caller");
	if (meta.allowExternalFormulas) parts.push("External formulas allowed by caller");
	if (meta.externalFormulas) parts.push(`External formulas: ${meta.externalFormulas}`);
	if (meta.newAlias) parts.push(`Renamed to: ${meta.newAlias}`);
	if (meta.redirectUri) parts.push(`Redirect URL: ${meta.redirectUri}`);
	if (meta.targetClient !== undefined) parts.push(`Client: ${meta.targetClient}`);
	if (meta.clientCount !== undefined) parts.push(`Registrations removed: ${meta.clientCount}`);
	if (meta.grantCount !== undefined) parts.push(`Connections removed: ${meta.grantCount}`);
	if (meta.remainingCount) parts.push(`Could not remove: ${meta.remainingCount}`);
	if (meta.resultCount !== undefined) parts.push(`Items returned: ${meta.resultCount}`);
	return parts.map(escapeHtml).join("<br>");
}

// The old Recent writes page. Its content is now "All activity" on /settings;
// the address still works for the owner and shows nothing to anyone else.
app.get("/audit", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) return startOwnerLogin(c.req.raw, c.env, "/audit");
	return new Response(null, {
		headers: {
			"Cache-Control": "no-store",
			Location: c.req.query("reads") === "show" ? "/settings?reads=show#activity" : "/settings#activity",
		},
		status: 302,
	});
});

const NOTICES: Record<string, string> = {
	leftover: "Leftover connection records removed.",
	revoked: "Client revoked. Its tokens no longer work.",
};

/** One registration's redirect URLs, each marked as on or off the allowed list. */
function redirectCell(uris: readonly string[], allowed: string[] | null): string {
	if (!uris.length) return '<span class="muted">none</span>';
	return uris
		.map((uri) => {
			const badge =
				allowed === null
					? '<span class="badge">List unavailable</span>'
					: isRedirectAllowed(uri, allowed)
						? '<span class="badge badge-ok">Allowed</span>'
						: '<span class="badge badge-alert">Not allowed</span>';
			return `<div><span class="mono small">${escapeHtml(uri)}</span> ${badge}</div>`;
		})
		.join("\n");
}

/** The client detail view: recent writes, the underlying connections, and Revoke. */
async function clientDrawerHtml(
	env: Env,
	group: ClientGroup,
	allowed: string[] | null,
	csrf: string,
): Promise<string> {
	const writes = await loadOrNull(
		recentWrites(env, { clientIds: group.clients.map((client) => client.clientId) }, 20),
	);
	const writesHtml =
		writes === null
			? errorCardHtml("this client's recent writes", `/clients?open=${group.key}`)
			: writes.length
				? `<ul class="rows">
${writes.map((entry) => `<li class="row"><div class="row-main">${writeLineHtml(entry)}</div></li>`).join("\n")}
</ul>
<p class="muted small">Account, action and time only. Recipients and subjects are under All activity in <a href="/settings#activity">Settings</a>.</p>`
				: '<p class="muted">No writes in the last 90 days.</p>';
	const connections = group.clients
		.map((client) => {
			const grants = group.grants.filter((grant) => grant.clientId === client.clientId);
			return `<li><dl class="info-panel">
<div><dt>Registered as</dt><dd>${escapeHtml(client.clientName || "(no name)")}</dd></div>
<div><dt>Client ID</dt><dd class="mono">${escapeHtml(client.clientId)}</dd></div>
<div><dt>Registered</dt><dd>${escapeHtml(day(client.registrationDate)) || "unknown"}</dd></div>
<div><dt>Access</dt><dd>${grants.length ? `Connected since ${escapeHtml(day(Math.min(...grants.map((grant) => grant.createdAt))))} (${plural(grants.length, "grant")})` : "Registered, not connected"}</dd></div>
<div><dt>Redirect URLs</dt><dd class="url-list">${redirectCell(client.redirectUris ?? [], allowed)}</dd></div>
</dl></li>`;
		})
		.join("\n");
	return drawerHtml({
		bodyHtml: `${
			group.unverified
				? '<p class="warn">This app registered under a well-known name, but its redirect URLs are not that company\'s. Treat it as an unknown app.</p>'
				: ""
		}<section class="drawer-section">
<h3>Recent writes</h3>
${writesHtml}
</section>
<section class="drawer-section">
<h3>${plural(group.clients.length, "connection")}</h3>
<ul class="rows connections">
${connections}
</ul>
</section>
<section class="drawer-section">
<h3>Revoke</h3>
${revokeFormHtml(group, csrf)}
</section>`,
		closeHref: "/clients",
		leadHtml: groupLogoHtml(group),
		subHtml: `${groupBadgesHtml(group, allowed)} <span class="muted">${group.brand ? "Verified by its redirect URLs" : `Name chosen by the app · ${escapeHtml(group.hosts.join(", ") || "no redirect URL")}`}</span>`,
		title: group.label,
	});
}

app.get("/clients", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) return startOwnerLogin(c.req.raw, c.env, "/clients");

	const [directory, status, allowed] = await Promise.all([
		loadOrNull(loadClientDirectory(c.env.OAUTH_PROVIDER, session.sub)),
		loadOrNull(ownerStatus(c.env)),
		loadOrNull(listAllowedRedirects(c.env)),
	]);
	const csrf = escapeHtml(session.csrf);
	const groups = directory?.groups ?? [];
	const activity = directory ? await loadOrNull(loadGroupActivity(c.env, groups)) : null;

	// ?open= must be the key of a group that exists right now. Anything else
	// shows the page with no detail view: the value is never echoed.
	const wanted = c.req.query("open") ?? "";
	const open = GROUP_KEY_PATTERN.test(wanted) ? groups.find((group) => group.key === wanted) : undefined;

	const leftover = directory?.leftoverGrants.length
		? `<div class="warn"><p>${plural(directory.leftoverGrants.length, "connection record")} left behind by an earlier revoke. Their tokens no longer work; this only tidies up.</p>
<form method="post" action="/clients/revoke">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="group" value="leftover">
<button type="submit" name="confirm" value="yes">Remove leftover records</button>
</form></div>`
		: "";
	const notice = NOTICES[c.req.query("msg") ?? ""];
	return renderOwnerPage({
		active: "/clients",
		attention: status?.attention ?? fallbackAttention(c.env),
		bodyHtml: `${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${leftover}
<p class="muted">One card per app. An app that was added more than once shows as one card with several connections. A name is chosen by the app itself, so only apps whose redirect URLs prove who they are get a logo; an app can connect only when all its redirect URLs are on the allowed list in <a href="/settings">Settings</a>.</p>
${
	directory
		? clientCardsHtml(groups, { activity, allowed, csrf: session.csrf })
		: `<div class="cards">
${errorCardHtml("your AI clients", "/clients")}
</div>`
}`,
		overlayHtml: open ? await clientDrawerHtml(c.env, open, allowed, session.csrf) : undefined,
		session,
		title: "AI clients",
	});
});

/** Records a revoke. A failed audit write never blocks or undoes the revoke. */
async function auditRevoke(
	env: Env,
	route: string,
	entry: { label: string; ok: boolean; clientCount: number; grantCount: number; remainingCount: number },
) {
	try {
		await recordAudit(env, {
			alias: "",
			clientId: "owner",
			clientName: "Owner (/clients)",
			meta: {
				clientCount: entry.clientCount,
				grantCount: entry.grantCount,
				remainingCount: entry.remainingCount,
				targetClient: entry.label,
			},
			outcome: entry.ok ? "ok" : "partial",
			tool: "revoke_client",
		});
	} catch (_e) {
		console.error(`${route} error: audit_failed`);
	}
}

// Revoking reduces access, so it is never rate limited and never waits on a
// counter: owner session, CSRF, POST and the confirm step are its only gates.
// The form names a group key; the server works out the registrations and
// grants itself, from the signed-in owner's own grants.
app.post("/clients/revoke", async (c) => {
	const route = "POST /clients/revoke";
	const gate = await requireOwnerPost(c as any, route);
	if (gate instanceof Response) return gate;
	const fail = (message: string, status: 400 | 404 | 500 | 503, category: string) => {
		console.warn(`${route} denied: ${category}`);
		return renderMessagePage("Could not continue", message, status, undefined, "/clients");
	};
	const key = gate.form.get("group");
	const confirmed = gate.form.get("confirm") === "yes";

	if (key === "leftover") {
		if (!confirmed) return fail("That needs to be confirmed. Nothing was changed.", 400, "not_confirmed");
		const swept = await revokeLeftoverGrants(c.env.OAUTH_PROVIDER, gate.session.sub);
		await auditRevoke(c.env, route, {
			clientCount: 0,
			grantCount: swept.removed,
			label: "(leftover records)",
			ok: swept.remaining === 0,
			remainingCount: swept.remaining,
		});
		if (swept.remaining) {
			return fail(
				`${plural(swept.remaining, "leftover record")} could not be removed. Their tokens do not work. It is safe to try again.`,
				500,
				"partial",
			);
		}
		console.log(`${route} ok: leftover grants=${swept.removed}`);
		return c.redirect("/clients?msg=leftover", 303);
	}

	let directory: ClientDirectory;
	try {
		directory = await loadClientDirectory(c.env.OAUTH_PROVIDER, gate.session.sub);
	} catch (_e) {
		return fail(
			"GoBridge could not read its list of AI clients, so nothing was revoked. Try again now. To cut every app off at once, remove its redirect URL under Allowed AI clients in Settings.",
			503,
			"clients_unavailable",
		);
	}
	const group =
		typeof key === "string" && GROUP_KEY_PATTERN.test(key)
			? directory.groups.find((candidate) => candidate.key === key)
			: undefined;
	if (!group) return fail("No AI client matches that request. It may already be revoked.", 404, "unknown_client");
	if (!confirmed) return fail("Revoking needs to be confirmed. Nothing was changed.", 400, "not_confirmed");

	const result = await revokeGroup(c.env.OAUTH_PROVIDER, gate.session.sub, group);
	const remaining = result.remainingGrants + result.remainingClients;
	await auditRevoke(c.env, route, {
		clientCount: result.clientCount,
		grantCount: result.grantCount,
		label: group.label,
		ok: remaining === 0,
		remainingCount: remaining,
	});
	if (remaining) {
		const parts = [
			result.remainingClients ? `${plural(result.remainingClients, "registration")} could not be removed and may still work` : "",
			result.remainingGrants
				? `${plural(result.remainingGrants, "connection record")} could not be removed${result.remainingClients ? "" : " (their tokens no longer work, because the registration is gone)"}`
				: "",
		].filter(Boolean);
		return fail(
			`Revoke did not finish: ${parts.join("; ")}. Removed so far: ${plural(result.clientCount, "registration")} and ${plural(result.grantCount, "connection")}. Go back and revoke again; it is safe to retry.`,
			500,
			"partial",
		);
	}

	console.log(`${route} ok: clients=${result.clientCount} grants=${result.grantCount}`);
	return c.redirect("/clients?msg=revoked", 303);
});

function environmentName(env: Env): string {
	let host = "";
	try {
		host = new URL(env.BASE_URL).hostname;
	} catch (_e) {
		// fall through to "unknown"
	}
	if (host.startsWith("gobridge-dev.")) return "Development (dev)";
	if (host.startsWith("gobridge.")) return "Production";
	return "Unknown";
}

const SETTINGS_NOTICES: Record<string, string> = {
	allowed: "Redirect URL allowed. Apps that use only allowed URLs can now connect.",
	exists: "That redirect URL was already on the list. Nothing changed.",
	removed: "Redirect URL removed. Apps that use it are cut off at once.",
};

/** The host of an allowed redirect URL, for its card title; the URL itself if it does not parse. */
function hostOf(uri: string): string {
	try {
		return new URL(uri).hostname || uri;
	} catch (_e) {
		return uri;
	}
}

/** The redirect-URL editor: the allowed list (which decides who may connect), Remove and the add form. */
function allowedUrlsHtml(allowed: string[] | null, csrf: string): string {
	const list =
		allowed === null
			? '<p class="warn">The allowed list could not be read just now, so every AI client is being refused. <a href="/settings">Retry</a></p>'
			: allowed.length
				? ""
				: '<p class="warn">The list is empty, so no AI client can connect. Add the redirect URL of each app you use.</p>';
	return `${list}
<div class="cards">
${(allowed ?? [])
	.map((uri) => {
		const host = escapeHtml(hostOf(uri));
		return `<div class="card">
<div class="card-head">
${clientLogoHtml([uri], hostOf(uri))}
<div class="card-main">
<div class="card-title"><strong>${host}</strong></div>
<div class="card-sub mono">${escapeHtml(uri)}</div>
</div>
<form method="post" action="/settings/allowed-clients/remove">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(uri)}">
<button class="icon-btn icon-btn-danger" type="submit" aria-label="Remove ${host}" title="Remove">${ICONS.trash}</button>
</form>
</div>
</div>`;
	})
	.join("\n")}
<div class="card card-form">
<div class="card-title"><strong><label for="redirect_uri">Allow a redirect URL</label></strong></div>
<form class="field" method="post" action="/settings/allowed-clients">
<input type="hidden" name="csrf_token" value="${csrf}">
<input id="redirect_uri" type="url" name="redirect_uri" required maxlength="512" autocomplete="off">
<button class="btn-primary" type="submit">Allow</button>
</form>
</div>
</div>
<p class="muted small">Exact URLs only, no wildcards. Loopback URLs (<code>localhost</code>, <code>127.0.0.1</code>) match on any port, for apps such as Claude Code. At most ${MAX_ALLOWED_REDIRECTS} URLs.</p>`;
}

/** What the All activity filters accept, after validation. Unknown values are dropped, never echoed. */
type ActivityQuery = { group?: ClientGroup; owner: boolean; account?: string; reads: boolean; page: number };

function activityHref(query: ActivityQuery, page: number): string {
	const params = new URLSearchParams();
	if (query.group) params.set("client", query.group.key);
	else if (query.owner) params.set("client", "owner");
	if (query.account) params.set("account", query.account);
	if (query.reads) params.set("reads", "show");
	if (page > 1) params.set("page", String(page));
	const search = params.toString();
	return `/settings${search ? `?${search}` : ""}#activity`;
}

/**
 * All activity: every write across all clients and accounts, newest first,
 * filterable by client and by account, 50 to a page. Rows show time, client,
 * account and action; recipients, subjects and ids sit behind a per-row
 * expand. Bodies and file content are never stored, so they cannot appear.
 */
async function activitySectionHtml(
	env: Env,
	query: ActivityQuery,
	groups: readonly ClientGroup[] | null,
	accounts: readonly AccountInfo[],
): Promise<string> {
	const filter: ActivityFilter = {};
	if (query.group) filter.clientIds = query.group.clients.map((client) => client.clientId);
	else if (query.owner) filter.clientIds = [OWNER_CLIENT_ID];
	let former: string[] = [];
	let result: Awaited<ReturnType<typeof activityPage>> | null = null;
	try {
		if (query.account) {
			filter.spans = await aliasSpans(env, query.account);
			former = filter.spans.slice(1).map((span) => span.alias);
		}
		result = await activityPage(env, { ...filter, page: query.page, reads: query.reads });
	} catch (_e) {
		result = null;
	}

	const groupOf = new Map<string, ClientGroup>();
	for (const group of groups ?? []) {
		for (const client of group.clients) groupOf.set(client.clientId, group);
	}
	const optionLabel = (group: ClientGroup) =>
		group.brand ? group.label : `${group.label} (${group.hosts.join(", ") || "no redirect URL"})`;
	const form = `<form class="filters" method="get" action="/settings#activity">
<label>AI client
<select name="client">
<option value="">All clients</option>
${(groups ?? []).map((group) => `<option value="${escapeHtml(group.key)}"${query.group?.key === group.key ? " selected" : ""}>${escapeHtml(optionLabel(group))}</option>`).join("\n")}
<option value="owner"${query.owner ? " selected" : ""}>Owner actions</option>
</select></label>
<label>Account
<select name="account">
<option value="">All accounts</option>
${accounts.map((account) => `<option value="${escapeHtml(account.alias)}"${query.account === account.alias ? " selected" : ""}>${escapeHtml(account.alias)}</option>`).join("\n")}
</select></label>
<label class="check"><input type="checkbox" name="reads" value="show"${query.reads ? " checked" : ""}> Show reads too</label>
<button type="submit">Apply</button>
${query.group || query.owner || query.account || query.reads || query.page > 1 ? '<a href="/settings#activity">Clear</a>' : ""}
</form>`;

	if (!result) {
		return `${form}
${errorCardHtml("the activity log", activityHref(query, query.page))}`;
	}
	const clientCell = (entry: AuditEntry) => {
		if (entry.clientId === OWNER_CLIENT_ID) return "Owner";
		const group = groupOf.get(entry.clientId);
		if (group) {
			return `${escapeHtml(group.label)}${group.unverified ? ' <span class="badge badge-alert">Unverified</span>' : ""}`;
		}
		return `${escapeHtml(entry.clientName || "(no name)")}${groups ? '<br><span class="muted small">No longer registered</span>' : ""}`;
	};
	const rows = result.entries
		.map((entry) => {
			const details = auditDetails(entry);
			return `<tr>
<td class="muted nowrap">${timeHtml(entry.ts)}</td>
<td>${clientCell(entry)}</td>
<td>${escapeHtml(entry.alias || "(all)")}</td>
<td><strong>${escapeHtml(entry.tool)}</strong> <span class="badge">${entry.kind === "read" ? "read" : "write"}</span>${entry.outcome === "ok" ? "" : `<br><span class="muted">${escapeHtml(`failed: ${entry.outcome}`)}</span>`}</td>
<td>${details ? `<details class="row-details"><summary>Details</summary><div class="small">${details}</div></details>` : ""}</td>
</tr>`;
		})
		.join("\n");
	const pager =
		query.page > 1 || result.hasNext
			? `<nav class="pager" aria-label="Activity pages">
${query.page > 1 ? `<a class="btn" href="${escapeHtml(activityHref(query, query.page - 1))}">Newer</a>` : "<span></span>"}
<span class="muted small">Page ${query.page}</span>
${result.hasNext ? `<a class="btn" href="${escapeHtml(activityHref(query, query.page + 1))}">Older</a>` : "<span></span>"}
</nav>`
			: "";
	return `${form}
${former.length ? `<p class="muted small">Includes activity from when this account was called ${former.map((name) => `<strong>${escapeHtml(name)}</strong>`).join(", ")}.</p>` : ""}
${
	result.entries.length
		? `<div class="table-wrap"><table>
<tr><th>Time</th><th>AI client</th><th>Account</th><th>Action</th><th></th></tr>
${rows}
</table></div>`
		: '<p class="muted">Nothing recorded for this view.</p>'
}
${pager}`;
}

// Status is read-only; the allowed redirect URLs are the one editable setting.
// Limits and switches change only through wrangler config and a deploy.
app.get("/settings", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) return startOwnerLogin(c.req.raw, c.env, "/settings");

	const [status, directory, allowed] = await Promise.all([
		loadOrNull(ownerStatus(c.env)),
		loadOrNull(loadClientDirectory(c.env.OAUTH_PROVIDER, session.sub)),
		loadOrNull(listAllowedRedirects(c.env)),
	]);
	const accounts = status?.accounts ?? [];
	const attention = status?.attention ?? fallbackAttention(c.env);
	const groups = directory?.groups ?? null;
	const [usage, activity] = await Promise.all([
		Promise.all(accounts.map((account) => writeUsage(c.env, account.alias))),
		groups ? loadOrNull(loadGroupActivity(c.env, groups)) : null,
	]);
	const cap = dailySendCap(c.env);
	const enabled = writesEnabled(c.env);
	const csrf = escapeHtml(session.csrf);
	const notice = SETTINGS_NOTICES[c.req.query("msg") ?? ""];

	// Filters: each value must be one GoBridge already knows. Anything else is ignored.
	const clientParam = c.req.query("client") ?? "";
	const accountParam = c.req.query("account") ?? "";
	const pageParam = c.req.query("page") ?? "";
	const query: ActivityQuery = {
		account:
			ALIAS_PATTERN.test(accountParam) && accounts.some((account) => account.alias === accountParam)
				? accountParam
				: undefined,
		group: GROUP_KEY_PATTERN.test(clientParam)
			? groups?.find((group) => group.key === clientParam)
			: undefined,
		owner: clientParam === "owner",
		page: /^[1-9][0-9]{0,2}$/.test(pageParam) ? Math.min(Number(pageParam), ACTIVITY_MAX_PAGE) : 1,
		reads: c.req.query("reads") === "show",
	};

	const usageCards = accounts
		.map((account, i) => {
			const relink = attention.relink.includes(account.alias);
			return `<div class="card${relink ? " card-alert" : ""}">
<div class="card-head">
${avatarHtml(account.email, 32, account.picture)}
<div class="card-main">
<div class="card-title"><strong>${escapeHtml(account.alias)}</strong></div>
<div class="card-sub">${escapeHtml(account.email)}</div>
</div>
${statusHtml(relink)}
</div>
${usageMetersHtml(c.env, usage[i])}
</div>`;
		})
		.join("\n");
	const usageSection = !status
		? `<div class="cards">
${errorCardHtml("your linked accounts", "/settings")}
</div>`
		: accounts.length
			? `<div class="cards">
${usageCards}
</div>`
			: '<p class="muted">No accounts linked yet. Link one on the <a href="/link">Linked accounts</a> page.</p>';

	const switchRows = KILL_SWITCHES.map((name) => {
		const on = switchEnabled(c.env, name);
		const label = {
			DIRECT_SEND_ENABLED: "Send without a draft, and reply",
			DRIVE_SHARE_ENABLED: "Share Drive files",
			DRIVE_WRITE_ENABLED: "Create, copy, rename, move or trash Drive files",
			FORWARD_ENABLED: "Forward emails",
			WRITES_ENABLED: "All write tools",
		}[name];
		return `<dt>${escapeHtml(label)} <span class="muted mono small">${name}</span></dt><dd>${on ? '<span class="badge badge-ok">On</span>' : '<span class="badge badge-alert">Off</span>'}</dd>`;
	}).join("\n");
	const warnings = [
		enabled
			? ""
			: '<p class="warn">Writes are off. Every write tool answers "Writes disabled" until WRITES_ENABLED is set back to "true" and deployed.</p>',
		attention.switchesOff?.length
			? `<p class="warn">Switched off: ${escapeHtml(attention.switchesOff.join(", "))}. Those tools answer "switched off by the owner" until the variable is set back to "true" and deployed.</p>`
			: "",
		attention.relink.length
			? `<p class="warn">Needs re-login: ${escapeHtml(attention.relink.join(", "))}. Fix this on the <a href="/link">Linked accounts</a> page.</p>`
			: "",
	].join("");

	return renderOwnerPage({
		active: "/settings",
		attention,
		bodyHtml: `${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${warnings}
<section class="panel">
<h2>Allowed AI clients</h2>
<p class="muted">An AI app can sign in and use GoBridge only when every redirect URL it registered is on this list. Removing a URL cuts off the apps that use it at once. When an app that is not allowed tries to connect, GoBridge shows you the exact URL to add.</p>
${allowedUrlsHtml(allowed, csrf)}
<h3>Apps that have registered</h3>
${
	groups
		? clientCardsHtml(groups, { activity, allowed, csrf: session.csrf })
		: `<div class="cards">
${errorCardHtml("your AI clients", "/settings")}
</div>`
}
</section>
<section class="panel">
<h2>Status</h2>
<p class="muted">Read-only. To change a limit or switch, edit <code>wrangler.jsonc</code> and deploy.</p>
<dl class="facts">
<dt>Environment</dt><dd>${escapeHtml(environmentName(c.env))} <span class="muted mono small">${escapeHtml(c.env.BASE_URL)}</span></dd>
${switchRows}
<dt>In-chat cards <span class="muted mono small">UI_CARDS</span></dt><dd>${{ all: "On, including cards that can send or change things", off: "Off", read: "On, read-only cards" }[uiCardsMode(c.env)]}</dd>
<dt>Daily send cap</dt><dd>${cap} emails per account per day (send_message, reply and forward)</dd>
<dt>Daily share cap</dt><dd>${DAILY_SHARE_CAP} share_file calls per account per day</dd>
<dt>Write rate limit</dt><dd>${WRITE_RATE_LIMIT_PER_HOUR} write actions per account per hour</dd>
<dt>Read rate limit</dt><dd>${readRateLimit(c.env)} read actions per account per hour</dd>
<dt>Rename limit</dt><dd>${OWNER_RENAME_LIMIT_PER_HOUR} account renames per hour on these pages</dd>
<dt>Owner session lifetime</dt><dd>${SESSION_TTL_SECONDS / 3600} hours, then you sign in again</dd>
<dt>Linked accounts</dt><dd>${status ? `${accounts.length}${attention.relink.length ? `, ${attention.relink.length} needing re-login` : ""}` : "unavailable"}</dd>
</dl>
</section>
<section class="panel">
<h2>Usage by account</h2>
${usageSection}
</section>
<section class="panel" id="activity">
<h2>All activity</h2>
<p class="muted">Every write by every AI client on every account, newest first, kept for 90 days. Writes record recipients and subject or event name, never bodies. Reads record only the tool and how many items came back.</p>
${await activitySectionHtml(c.env, query, groups, accounts)}
</section>`,
		session,
		title: "Settings",
	});
});

/** Shared by add and remove: session + CSRF, then a normalized redirect URL. */
async function allowedClientsPost(c: any, route: string) {
	const gate = await requireOwnerPost(c, route);
	if (gate instanceof Response) return gate;
	const normalized = normalizeRedirectUri(gate.form.get("redirect_uri"));
	if (!normalized.ok) {
		console.warn(`${route} denied: bad_redirect_uri`);
		return renderMessagePage("Could not continue", normalized.reason, 400, undefined, "/settings");
	}
	return { session: gate.session, uri: normalized.uri };
}

async function auditOwnerChange(env: Env, route: string, tool: string, uri: string) {
	try {
		await recordAudit(env, {
			alias: "",
			clientId: "owner",
			clientName: "Owner (/settings)",
			meta: { redirectUri: uri },
			outcome: "ok",
			tool,
		});
	} catch (_e) {
		console.error(`${route} error: audit_failed`);
	}
}

const listUnavailable = (route: string) => {
	console.error(`${route} error: list_unavailable`);
	return renderMessagePage(
		"Could not continue",
		"GoBridge could not update its list of allowed apps. Nothing was changed. Try again in a moment.",
		503,
		undefined,
		"/settings",
	);
};

app.post("/settings/allowed-clients", async (c) => {
	const route = "POST /settings/allowed-clients";
	const input = await allowedClientsPost(c, route);
	if (input instanceof Response) return input;
	let outcome: Awaited<ReturnType<typeof addAllowedRedirect>>;
	try {
		outcome = await addAllowedRedirect(c.env, input.uri);
	} catch (_e) {
		return listUnavailable(route);
	}
	if (outcome === "full") {
		console.warn(`${route} denied: list_full`);
		return renderMessagePage(
			"Could not continue",
			`The list already holds ${MAX_ALLOWED_REDIRECTS} redirect URLs. Remove one first.`,
			400,
			undefined,
			"/settings",
		);
	}
	if (outcome === "added") await auditOwnerChange(c.env, route, "allow_client_url", input.uri);
	console.log(`${route} ok: ${outcome}`);
	return c.redirect(`/settings?msg=${outcome === "added" ? "allowed" : "exists"}`, 303);
});

app.post("/settings/allowed-clients/remove", async (c) => {
	const route = "POST /settings/allowed-clients/remove";
	const input = await allowedClientsPost(c, route);
	if (input instanceof Response) return input;
	let removed: boolean;
	try {
		removed = await removeAllowedRedirect(c.env, input.uri);
	} catch (_e) {
		return listUnavailable(route);
	}
	if (!removed) {
		console.warn(`${route} denied: not_listed`);
		return renderMessagePage("Could not continue", "That redirect URL is not on the list.", 404, undefined, "/settings");
	}
	await auditOwnerChange(c.env, route, "remove_client_url", input.uri);
	console.log(`${route} ok`);
	return c.redirect("/settings?msg=removed", 303);
});

app.post("/logout", async (c) => {
	const route = "POST /logout";
	const gate = await requireOwnerPost(c as any, route);
	if (gate instanceof Response) return gate;

	const setCookie = await endOwnerSession(c.env, gate.session);
	console.log(`${route} ok`);
	return new Response(null, {
		headers: { "Cache-Control": "no-store", Location: "/signed-out", "Set-Cookie": setCookie },
		status: 303,
	});
});

// Signing out must never happen from a link, image, or prefetch.
app.all("/logout", (c) => c.text("Method not allowed", 405, { Allow: "POST" }));

// Public and static: says nothing about the owner or whether anyone was signed in.
app.get("/signed-out", () =>
	renderMessagePage(
		"Signed out",
		"You are signed out of GoBridge on this browser. AI clients you connected keep working.",
		200,
		undefined,
		undefined,
		{ href: "/link", label: "Sign in" },
	),
);

export { app as OwnerPages };
