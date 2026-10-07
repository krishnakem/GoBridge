/**
 * Owner-only pages for reviewing and controlling access.
 *
 *   GET  /audit           recent writes and which AI client made them
 *   GET  /clients         registered AI clients and their active grants
 *   POST /clients/revoke  revoke one client's grants + registration (session + CSRF)
 *   GET  /settings        read-only status (environment, limits, usage, re-link flags)
 *   POST /logout          end the owner session (session + CSRF); other methods get 405
 *   GET  /signed-out      public "Signed out" notice with a Sign in button
 *
 * Like /link: no content without an owner session, and the only state-changing
 * action is POST-only with a CSRF token.
 */
import type { ClientInfo, GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
	type AuditEntry,
	dailySendCap,
	DAILY_SHARE_CAP,
	KILL_SWITCHES,
	listAudit,
	readRateLimit,
	WRITE_RATE_LIMIT_PER_HOUR,
	writesEnabled,
	writeUsage,
	switchEnabled,
} from "./guardrails";
import { escapeHtml, renderMessagePage, renderOwnerPage } from "./html";
import { ownerStatus } from "./owner-status";
import { requireOwnerPost } from "./link-handler";
import {
	endOwnerSession,
	readOwnerSession,
	SESSION_TTL_SECONDS,
	startOwnerLogin,
} from "./session";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

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
	if (meta.newAlias) parts.push(`Renamed to: ${meta.newAlias}`);
	if (meta.resultCount !== undefined) parts.push(`Items returned: ${meta.resultCount}`);
	return parts.map(escapeHtml).join("<br>");
}

app.get("/audit", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) return startOwnerLogin(c.req.raw, c.env, "/audit");

	// A plain GET filter: reads are hidden unless asked for. Nothing changes state.
	const showReads = c.req.query("reads") === "show";
	const [writes, reads, { attention }] = await Promise.all([
		listAudit(c.env, 100, "write"),
		showReads ? listAudit(c.env, 100, "read") : Promise.resolve([]),
		ownerStatus(c.env),
	]);
	const entries = [...writes, ...reads].sort((a, b) => b.ts.localeCompare(a.ts));
	const rows = entries
		.map(
			(entry) => `<tr>
<td class="muted">${escapeHtml(entry.ts.replace("T", " ").slice(0, 19))}</td>
<td>${escapeHtml(entry.clientName || "(no name)")}<br><span class="muted mono small">${escapeHtml(entry.clientId)}</span></td>
<td>${escapeHtml(entry.alias || "(all)")}</td>
<td><strong>${escapeHtml(entry.tool)}</strong> <span class="badge">${entry.kind === "read" ? "read" : "write"}</span><br><span class="muted">${escapeHtml(entry.outcome === "ok" ? "done" : `failed: ${entry.outcome}`)}</span></td>
<td>${auditDetails(entry)}</td>
</tr>`,
		)
		.join("\n");
	const table = entries.length
		? `<div class="table-wrap"><table>
<tr><th>Time (UTC)</th><th>AI client</th><th>Account</th><th>Action</th><th>Details</th></tr>
${rows}
</table></div>`
		: `<p class="muted">Nothing recorded yet.</p>`;
	const filter = showReads
		? '<p>Showing writes and reads. <a href="/audit">Hide reads</a></p>'
		: '<p>Showing writes only. <a href="/audit?reads=show">Show reads too</a></p>';

	return renderOwnerPage({
		active: "/audit",
		attention,
		bodyHtml: `<p class="muted">The 100 most recent write actions${showReads ? " and the 100 most recent reads" : ""}. Entries are kept for 90 days. Writes record recipients and subject or event name, never bodies. Reads record only the tool and how many items came back.</p>
${filter}
${table}`,
		session,
		title: showReads ? "Recent writes and reads" : "Recent writes",
	});
});

async function allClients(helpers: OAuthHelpers): Promise<ClientInfo[]> {
	const clients: ClientInfo[] = [];
	let cursor: string | undefined;
	do {
		const page = await helpers.listClients({ cursor, limit: 100 });
		clients.push(...page.items);
		cursor = page.cursor;
	} while (cursor && clients.length < 500);
	return clients;
}

async function allGrants(helpers: OAuthHelpers, userId: string): Promise<GrantSummary[]> {
	const grants: GrantSummary[] = [];
	let cursor: string | undefined;
	do {
		const page = await helpers.listUserGrants(userId, { cursor, limit: 100 });
		grants.push(...page.items);
		cursor = page.cursor;
	} while (cursor && grants.length < 500);
	return grants;
}

const NOTICES: Record<string, string> = {
	revoked: "Client revoked. Its tokens no longer work.",
};

app.get("/clients", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) return startOwnerLogin(c.req.raw, c.env, "/clients");

	const [clients, grants, { attention }] = await Promise.all([
		allClients(c.env.OAUTH_PROVIDER),
		allGrants(c.env.OAUTH_PROVIDER, session.sub),
		ownerStatus(c.env),
	]);
	const csrf = escapeHtml(session.csrf);
	const day = (seconds?: number) =>
		seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "";

	// Connected clients first, then the rest by registration date (newest first).
	const active = (client: ClientInfo) => grants.filter((g) => g.clientId === client.clientId);
	clients.sort(
		(a, b) =>
			Math.sign(active(b).length) - Math.sign(active(a).length) ||
			(b.registrationDate ?? 0) - (a.registrationDate ?? 0),
	);

	const rows = clients
		.map((client) => {
			const mine = active(client);
			const access = mine.length
				? `Connected (${mine.length} grant${mine.length === 1 ? "" : "s"}, since ${escapeHtml(day(Math.min(...mine.map((g) => g.createdAt))))})`
				: "Registered, not connected";
			return `<tr>
<td><strong>${escapeHtml(client.clientName || "(no name)")}</strong><br><span class="muted mono small">${escapeHtml(client.clientId)}</span></td>
<td class="muted">${escapeHtml(day(client.registrationDate))}</td>
<td>${access}</td>
<td><form class="inline" method="post" action="/clients/revoke">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="client_id" value="${escapeHtml(client.clientId)}">
<button class="btn-danger" type="submit">Revoke</button>
</form></td>
</tr>`;
		})
		.join("\n");
	const table = clients.length
		? `<div class="table-wrap"><table>
<tr><th>AI client</th><th>Registered</th><th>Access</th><th></th></tr>
${rows}
</table></div>`
		: `<p class="muted">No AI clients have registered yet.</p>`;

	const notice = NOTICES[c.req.query("msg") ?? ""];
	return renderOwnerPage({
		active: "/clients",
		attention,
		bodyHtml: `${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<p class="muted">Every app that has registered with GoBridge. Names are chosen by the app itself. Revoking a client cancels its tokens and removes its registration; other clients keep working. To use it again, add GoBridge in that app again.</p>
${table}`,
		session,
		title: "AI clients",
	});
});

app.post("/clients/revoke", async (c) => {
	const route = "POST /clients/revoke";
	const gate = await requireOwnerPost(c as any, route);
	if (gate instanceof Response) return gate;

	const clientId = gate.form.get("client_id");
	const client =
		typeof clientId === "string" && clientId.length <= 512
			? await c.env.OAUTH_PROVIDER.lookupClient(clientId)
			: null;
	if (!client) {
		console.warn(`${route} denied: unknown_client`);
		return renderMessagePage("Could not continue", "No registered client has that id.", 404);
	}

	// Only this client's grants: every other client's tokens stay valid.
	const grants = await allGrants(c.env.OAUTH_PROVIDER, gate.session.sub);
	for (const grant of grants.filter((g) => g.clientId === client.clientId)) {
		await c.env.OAUTH_PROVIDER.revokeGrant(grant.id, gate.session.sub);
	}
	await c.env.OAUTH_PROVIDER.deleteClient(client.clientId);

	console.log(`${route} ok: client=${client.clientId}`);
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

// Read-only status. Nothing here can be edited: settings change only through
// wrangler config and a deploy.
app.get("/settings", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) return startOwnerLogin(c.req.raw, c.env, "/settings");

	const { accounts, attention } = await ownerStatus(c.env);
	const usage = await Promise.all(accounts.map((account) => writeUsage(c.env, account.alias)));
	const cap = dailySendCap(c.env);
	const enabled = writesEnabled(c.env);

	const rows = accounts
		.map(
			(account, i) => `<tr>
<td><strong>${escapeHtml(account.alias)}</strong><br><span class="muted small">${escapeHtml(account.email)}</span></td>
<td>${usage[i] ? `${usage[i].sendsToday} of ${cap}` : "unavailable"}</td>
<td>${usage[i] ? `${usage[i].writesThisHour} of ${WRITE_RATE_LIMIT_PER_HOUR}` : "unavailable"}</td>
<td>${usage[i] ? `${usage[i].readsThisHour} of ${readRateLimit(c.env)}` : "unavailable"}</td>
<td>${usage[i] ? `${usage[i].sharesToday} of ${DAILY_SHARE_CAP}` : "unavailable"}</td>
<td>${
				attention.relink.includes(account.alias)
					? '<span class="badge badge-alert">Needs re-link</span>'
					: '<span class="badge badge-ok">Linked</span>'
			}</td>
</tr>`,
		)
		.join("\n");
	const table = accounts.length
		? `<div class="table-wrap"><table>
<tr><th>Account</th><th>Emails sent today (UTC)</th><th>Writes this hour</th><th>Reads this hour</th><th>Files shared today</th><th>Status</th></tr>
${rows}
</table></div>`
		: `<p class="muted">No accounts linked yet.</p>`;

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
			? `<p class="warn">Needs re-link: ${escapeHtml(attention.relink.join(", "))}. Fix this on the <a href="/link">Linked accounts</a> page.</p>`
			: "",
	].join("");

	return renderOwnerPage({
		active: "/settings",
		attention,
		bodyHtml: `${warnings}
<p class="muted">Read-only status. To change a setting, edit <code>wrangler.jsonc</code> and deploy.</p>
<dl class="facts">
<dt>Environment</dt><dd>${escapeHtml(environmentName(c.env))} <span class="muted mono small">${escapeHtml(c.env.BASE_URL)}</span></dd>
${switchRows}
<dt>Daily send cap</dt><dd>${cap} emails per account per day (send_message, reply and forward)</dd>
<dt>Daily share cap</dt><dd>${DAILY_SHARE_CAP} share_file calls per account per day</dd>
<dt>Write rate limit</dt><dd>${WRITE_RATE_LIMIT_PER_HOUR} write actions per account per hour</dd>
<dt>Read rate limit</dt><dd>${readRateLimit(c.env)} read actions per account per hour</dd>
<dt>Owner session lifetime</dt><dd>${SESSION_TTL_SECONDS / 3600} hours, then you sign in again</dd>
<dt>Linked accounts</dt><dd>${accounts.length}${attention.relink.length ? `, ${attention.relink.length} needing re-link` : ""}</dd>
</dl>
<h2>Usage by account</h2>
${table}`,
		session,
		title: "Settings",
	});
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
