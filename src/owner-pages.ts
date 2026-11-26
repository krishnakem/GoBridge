/**
 * Owner-only pages for reviewing and controlling access.
 *
 *   GET  /clients         AI clients, one card per app; ?open=<group key> shows the detail view
 *   POST /clients/revoke  remove every connection of one app          (session + CSRF + confirm)
 *   GET  /settings        allowed AI clients (editable), status, usage by account, all activity
 *   POST /settings/allowed-clients         allow one redirect URL     (session + CSRF)
 *   POST /settings/allowed-clients/remove  remove one redirect URL    (session + CSRF)
 *   GET  /audit           owner-only redirect to All activity on /settings
 *   GET  /export.csv      owner-only CSV of one data list (?table=...), same filters as its page
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
	type ActivityOptions,
	aliasSpans,
	allActivity,
	countActivity,
	listActivity,
	OWNER_CLIENT_ID,
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
	errorCardHtml,
	exportHref,
	type ExportTable,
	groupAllowed,
	groupBadgesHtml,
	groupLogoHtml,
	listFootHtml,
	loadAccountClientRows,
	loadGroupActivity,
	loadOrNull,
	modalHtml,
	revokeFormHtml,
	ROW_LIMIT,
	statusHtml,
	timeHtml,
	usageMetersHtml,
	writeLineHtml,
} from "./components";
import { csvDocument, csvResponse } from "./csv";
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

/** The body-free facts recorded with one audit row, as plain text lines. */
function auditDetailParts(entry: AuditEntry): string[] {
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
	return parts;
}

const auditDetails = (entry: AuditEntry) => auditDetailParts(entry).map(escapeHtml).join("<br>");

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

/** AI clients' writes by one app: what its detail view lists and its CSV exports. */
const clientWrites = (group: ClientGroup): ActivityOptions => ({
	clientIds: group.clients.map((client) => client.clientId),
	clientsOnly: true,
	reads: false,
});

/** The client detail view: recent writes, the underlying connections, and Revoke. */
async function clientModalHtml(
	env: Env,
	group: ClientGroup,
	allowed: string[] | null,
	csrf: string,
): Promise<string> {
	const options = clientWrites(group);
	const writes = await loadOrNull(
		Promise.all([listActivity(env, { ...options, limit: ROW_LIMIT }), countActivity(env, options)]),
	);
	const writesHtml =
		writes === null
			? errorCardHtml("this client's recent writes", `/clients?open=${group.key}`)
			: `${
					writes[0].length
						? `<ul class="rows">
${writes[0].map((entry) => `<li class="row"><div class="row-main">${writeLineHtml(entry)}</div></li>`).join("\n")}
</ul>`
						: '<p class="muted">No writes in the last 90 days.</p>'
				}
${listFootHtml(exportHref("client-writes", { client: group.key }), writes[1])}`;
	const connections = group.clients
		.slice(0, ROW_LIMIT)
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
	return modalHtml({
		bodyHtml: `${
			group.unverified
				? '<p class="warn">This app registered under a well-known name, but its redirect URLs are not that company\'s. Treat it as an unknown app.</p>'
				: ""
		}<section class="modal-section">
<h3>Recent writes</h3>
${writesHtml}
</section>
<section class="modal-section">
<h3>${plural(group.clients.length, "connection")}</h3>
<ul class="rows connections">
${connections}
</ul>
${listFootHtml(exportHref("client-connections", { client: group.key }), group.clients.length)}
</section>
<section class="modal-section">
${revokeFormHtml(group, csrf)}
</section>`,
		closeHref: `/clients#app-${group.key}`,
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
${
	directory
		? clientCardsHtml(groups, { activity, allowed, csrf: session.csrf })
		: `<div class="cards">
${errorCardHtml("your AI clients", "/clients")}
</div>`
}`,
		overlayHtml: open ? await clientModalHtml(c.env, open, allowed, session.csrf) : undefined,
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
</div>`;
}

/** What the All activity filters accept, after validation. Unknown values are dropped, never echoed. */
type ActivityQuery = { group?: ClientGroup; owner: boolean; account?: string; reads: boolean };

/** Reads the filters from a request. Each value must be one GoBridge already knows. */
function activityQuery(
	query: (name: string) => string | undefined,
	groups: readonly ClientGroup[] | null,
	accounts: readonly AccountInfo[],
): ActivityQuery {
	const client = query("client") ?? "";
	const account = query("account") ?? "";
	return {
		account:
			ALIAS_PATTERN.test(account) && accounts.some((linked) => linked.alias === account) ? account : undefined,
		group: GROUP_KEY_PATTERN.test(client) ? groups?.find((group) => group.key === client) : undefined,
		owner: client === "owner",
		reads: query("reads") === "show",
	};
}

const activityParams = (query: ActivityQuery) => ({
	account: query.account,
	client: query.group ? query.group.key : query.owner ? "owner" : undefined,
	reads: query.reads ? "show" : undefined,
});

/** The rows the filters select: used by the page, its row count and its CSV alike. */
async function activityOptions(env: Env, query: ActivityQuery): Promise<ActivityOptions> {
	const options: ActivityOptions = { reads: query.reads };
	if (query.group) options.clientIds = query.group.clients.map((client) => client.clientId);
	else if (query.owner) options.clientIds = [OWNER_CLIENT_ID];
	if (query.account) options.spans = await aliasSpans(env, query.account);
	return options;
}

/** Who a row is shown as: the app's card label, "Owner", or the name recorded with a removed app. */
function clientLabeller(groups: readonly ClientGroup[] | null): (entry: AuditEntry) => { label: string; group?: ClientGroup } {
	const groupOf = new Map<string, ClientGroup>();
	for (const group of groups ?? []) {
		for (const client of group.clients) groupOf.set(client.clientId, group);
	}
	return (entry) => {
		if (entry.clientId === OWNER_CLIENT_ID) return { label: "Owner" };
		const group = groupOf.get(entry.clientId);
		return group ? { group, label: group.label } : { label: entry.clientName || "(no name)" };
	};
}

/**
 * All activity: every write across all clients and accounts, newest first,
 * filterable by client and by account. The page shows the newest ROW_LIMIT
 * rows; Download CSV has every row the filters match. Recipients, subjects
 * and ids sit behind a per-row expand. Bodies and file content are never
 * stored, so they cannot appear.
 */
async function activitySectionHtml(
	env: Env,
	query: ActivityQuery,
	groups: readonly ClientGroup[] | null,
	accounts: readonly AccountInfo[],
): Promise<string> {
	const result = await loadOrNull(
		activityOptions(env, query).then((options) =>
			Promise.all([listActivity(env, { ...options, limit: ROW_LIMIT }), countActivity(env, options)]),
		),
	);
	const params = activityParams(query);
	const search = new URLSearchParams(Object.entries(params).filter((pair): pair is [string, string] => !!pair[1]));
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
${search.size ? '<a href="/settings#activity">Clear</a>' : ""}
</form>`;

	if (!result) {
		return `${form}
${errorCardHtml("the activity log", `/settings${search.size ? `?${search}` : ""}#activity`)}`;
	}
	const [entries, total] = result;
	const labelOf = clientLabeller(groups);
	const rows = entries
		.map((entry) => {
			const who = labelOf(entry);
			const details = auditDetails(entry);
			const client =
				entry.clientId === OWNER_CLIENT_ID
					? "Owner"
					: who.group
						? `${escapeHtml(who.label)}${who.group.unverified ? ' <span class="badge badge-alert">Unverified</span>' : ""}`
						: `${escapeHtml(who.label)}${groups ? '<br><span class="muted small">No longer registered</span>' : ""}`;
			return `<tr>
<td class="muted nowrap">${timeHtml(entry.ts)}</td>
<td>${client}</td>
<td>${escapeHtml(entry.alias || "(all)")}</td>
<td><strong>${escapeHtml(entry.tool)}</strong> <span class="badge">${entry.kind === "read" ? "read" : "write"}</span>${entry.outcome === "ok" ? "" : `<br><span class="muted">${escapeHtml(`failed: ${entry.outcome}`)}</span>`}</td>
<td>${details ? `<details class="row-details"><summary>Details</summary><div class="small">${details}</div></details>` : ""}</td>
</tr>`;
		})
		.join("\n");
	return `${form}
${
	entries.length
		? `<div class="table-wrap"><table>
<tr><th>Time</th><th>AI client</th><th>Account</th><th>Action</th><th></th></tr>
${rows}
</table></div>`
		: '<p class="muted">Nothing recorded for this view.</p>'
}
${listFootHtml(exportHref("activity", params), total)}`;
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
	const shown = accounts.slice(0, ROW_LIMIT);
	const usage = await Promise.all(shown.map((account) => writeUsage(c.env, account.alias)));
	const cap = dailySendCap(c.env);
	const enabled = writesEnabled(c.env);
	const csrf = escapeHtml(session.csrf);
	const notice = SETTINGS_NOTICES[c.req.query("msg") ?? ""];
	const query = activityQuery((name) => c.req.query(name), groups, accounts);

	const usageCards = shown
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
		: `${
				accounts.length
					? `<div class="cards">
${usageCards}
</div>`
					: '<p class="muted">No accounts linked yet. Link one on the <a href="/link">Linked accounts</a> page.</p>'
			}
${listFootHtml(exportHref("usage"), accounts.length)}`;

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
${allowedUrlsHtml(allowed, csrf)}
</section>
<section class="panel">
<h2>Usage by account</h2>
${usageSection}
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
<section class="panel" id="activity">
<h2>All activity</h2>
${await activitySectionHtml(c.env, query, groups, accounts)}
</section>`,
		session,
		title: "Settings",
	});
});

const EXPORT_TABLES: readonly ExportTable[] = ["activity", "usage", "client-writes", "client-connections", "account-clients"];

// Download CSV: every row of one data list, with the same filters as its page.
// Read-only and owner-only, like the pages: without a session it returns no
// data and starts owner sign-in. Each parameter must be a value GoBridge
// already knows (a table name, a group key, a linked alias).
app.get("/export.csv", async (c) => {
	const route = "GET /export.csv";
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) return startOwnerLogin(c.req.raw, c.env, "/settings");
	const refuse = (category: string) => {
		console.warn(`${route} denied: ${category}`);
		return renderMessagePage("Could not continue", "There is nothing to download for that request.", 404, undefined, "/settings");
	};
	const table = EXPORT_TABLES.find((name) => name === c.req.query("table"));
	if (!table) return refuse("unknown_table");
	const iso = (ts?: string) => (ts && Number.isFinite(Date.parse(ts)) ? new Date(Date.parse(ts)).toISOString() : "");

	const [status, directory] = await Promise.all([
		ownerStatus(c.env),
		table === "usage" ? null : loadClientDirectory(c.env.OAUTH_PROVIDER, session.sub),
	]);
	const groups = directory?.groups ?? [];

	if (table === "activity") {
		const query = activityQuery((name) => c.req.query(name), groups, status.accounts);
		const entries = await allActivity(c.env, await activityOptions(c.env, query));
		const labelOf = clientLabeller(groups);
		return csvResponse(
			"activity",
			csvDocument(
				["time", "ai_client", "account", "action", "kind", "outcome", "details"],
				entries.map((entry) => [
					iso(entry.ts),
					labelOf(entry).label,
					entry.alias || "(all)",
					entry.tool,
					entry.kind,
					entry.outcome,
					auditDetailParts(entry).join("; "),
				]),
			),
		);
	}

	if (table === "usage") {
		const usage = await Promise.all(status.accounts.map((account) => writeUsage(c.env, account.alias)));
		const shown = (count?: number) => count ?? "unavailable";
		return csvResponse(
			"usage",
			csvDocument(
				["account", "email", "status", "emails_sent_today", "daily_send_cap", "writes_this_hour", "write_limit", "reads_this_hour", "read_limit", "files_shared_today", "daily_share_cap"],
				status.accounts.map((account, i) => [
					account.alias,
					account.email,
					status.attention.relink.includes(account.alias) ? "needs re-login" : "connected",
					shown(usage[i]?.sendsToday),
					dailySendCap(c.env),
					shown(usage[i]?.writesThisHour),
					WRITE_RATE_LIMIT_PER_HOUR,
					shown(usage[i]?.readsThisHour),
					readRateLimit(c.env),
					shown(usage[i]?.sharesToday),
					DAILY_SHARE_CAP,
				]),
			),
		);
	}

	if (table === "account-clients") {
		const wanted = c.req.query("account") ?? "";
		const account = ALIAS_PATTERN.test(wanted) ? status.accounts.find((linked) => linked.alias === wanted) : undefined;
		if (!account) return refuse("unknown_alias");
		const rows = await loadAccountClientRows(c.env, c.env.OAUTH_PROVIDER, session.sub, account.alias);
		return csvResponse(
			"account-clients",
			csvDocument(
				["account", "ai_client", "status", "last_active", "writes"],
				rows.map((row) => [
					account.alias,
					row.label,
					row.group ? (row.group.unverified ? "unverified" : row.group.brand ? "verified" : "registered") : "no longer registered",
					iso(row.lastActive),
					row.writes,
				]),
			),
		);
	}

	const wanted = c.req.query("client") ?? "";
	const group = GROUP_KEY_PATTERN.test(wanted) ? groups.find((candidate) => candidate.key === wanted) : undefined;
	if (!group) return refuse("unknown_client");

	if (table === "client-writes") {
		const entries = await allActivity(c.env, clientWrites(group));
		return csvResponse(
			"client-writes",
			csvDocument(
				["time", "ai_client", "account", "action", "outcome"],
				entries.map((entry) => [iso(entry.ts), group.label, entry.alias || "(all)", entry.tool, entry.outcome]),
			),
		);
	}

	const allowed = await loadOrNull(listAllowedRedirects(c.env));
	return csvResponse(
		"client-connections",
		csvDocument(
			["ai_client", "registered_as", "client_id", "registered", "grants", "connected_since", "redirect_urls", "allowed"],
			group.clients.map((client) => {
				const grants = group.grants.filter((grant) => grant.clientId === client.clientId);
				const ok = groupAllowed({ ...group, clients: [client] }, allowed);
				return [
					group.label,
					client.clientName || "(no name)",
					client.clientId,
					client.registrationDate ? new Date(client.registrationDate * 1000).toISOString() : "",
					grants.length,
					grants.length ? new Date(Math.min(...grants.map((grant) => grant.createdAt)) * 1000).toISOString() : "",
					(client.redirectUris ?? []).join(" "),
					ok === null ? "unknown" : ok ? "yes" : "no",
				];
			}),
		),
	);
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
