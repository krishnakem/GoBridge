/**
 * Owner-only pages for reviewing and controlling access.
 *
 *   GET  /audit           recent writes and which AI client made them
 *   GET  /clients         registered AI clients and their active grants
 *   POST /clients/revoke  revoke one client's grants + registration (session + CSRF)
 *
 * Like /link: no content without an owner session, and the only state-changing
 * action is POST-only with a CSRF token.
 */
import type { ClientInfo, GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { type AuditEntry, listAudit } from "./guardrails";
import { escapeHtml, OWNER_NAV, renderMessagePage, renderPage } from "./html";
import { requireOwnerPost } from "./link-handler";
import { readOwnerSession, startOwnerLogin } from "./session";

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
	return parts.map(escapeHtml).join("<br>");
}

app.get("/audit", async (c) => {
	const session = await readOwnerSession(c.req.raw, c.env);
	if (!session) return startOwnerLogin(c.req.raw, c.env, "/audit");

	const entries = await listAudit(c.env, 100);
	const rows = entries
		.map(
			(entry) => `<tr>
<td class="muted">${escapeHtml(entry.ts.replace("T", " ").slice(0, 19))}</td>
<td>${escapeHtml(entry.clientName || "(no name)")}<br><span class="muted">${escapeHtml(entry.clientId)}</span></td>
<td>${escapeHtml(entry.alias)}</td>
<td><strong>${escapeHtml(entry.tool)}</strong><br><span class="muted">${escapeHtml(entry.outcome === "ok" ? "done" : `failed: ${entry.outcome}`)}</span></td>
<td>${auditDetails(entry)}</td>
</tr>`,
		)
		.join("\n");
	const table = entries.length
		? `<table>
<tr><th>Time (UTC)</th><th>AI client</th><th>Account</th><th>Action</th><th>Details</th></tr>
${rows}
</table>`
		: `<p class="muted">No writes recorded yet.</p>`;

	return renderPage(
		"Recent writes",
		`<h2>Recent writes</h2>
<p class="muted">The 100 most recent write actions. Entries are kept for 90 days and never contain message or event bodies.</p>
${table}
<p class="muted">Signed in as ${escapeHtml(session.email)}.</p>
${OWNER_NAV}`,
	);
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

	const [clients, grants] = await Promise.all([
		allClients(c.env.OAUTH_PROVIDER),
		allGrants(c.env.OAUTH_PROVIDER, session.sub),
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
<td><strong>${escapeHtml(client.clientName || "(no name)")}</strong><br><span class="muted">${escapeHtml(client.clientId)}</span></td>
<td class="muted">${escapeHtml(day(client.registrationDate))}</td>
<td>${access}</td>
<td><form class="inline" method="post" action="/clients/revoke">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="client_id" value="${escapeHtml(client.clientId)}">
<button type="submit">Revoke</button>
</form></td>
</tr>`;
		})
		.join("\n");
	const table = clients.length
		? `<table>
<tr><th>AI client</th><th>Registered</th><th>Access</th><th></th></tr>
${rows}
</table>`
		: `<p class="muted">No AI clients have registered yet.</p>`;

	const notice = NOTICES[c.req.query("msg") ?? ""];
	return renderPage(
		"AI clients",
		`${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<h2>AI clients</h2>
<p class="muted">Every app that has registered with GoBridge. Names are chosen by the app itself. Revoking a client cancels its tokens and removes its registration; other clients keep working. To use it again, add GoBridge in that app again.</p>
${table}
<p class="muted">Signed in as ${escapeHtml(session.email)}.</p>
${OWNER_NAV}`,
	);
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

export { app as OwnerPages };
