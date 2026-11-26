/**
 * Shared building blocks of the owner pages.
 *
 * Two of them exist so that two views can never disagree:
 *   - `clientCardsHtml` + `revokeFormHtml`: the AI client list with Revoke,
 *     on /clients and in its detail view;
 *   - `usageMetersHtml`: an account's usage, used by /settings and by the
 *     account detail view on /link.
 *
 * Everything returned is trusted markup: every dynamic value (alias, client
 * name, redirect URL, audit text) is escaped here, on output.
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { aliasSpans, type ClientStat, clientStats, recentWrites } from "./activity";
import { isRedirectAllowed } from "./allowed-clients";
import { brandLogoHtml, letterTileHtml } from "./client-logos";
import { type ClientGroup, loadClientDirectory } from "./client-groups";
import {
	type AuditEntry,
	dailySendCap,
	DAILY_SHARE_CAP,
	readRateLimit,
	WRITE_RATE_LIMIT_PER_HOUR,
	writeUsage,
} from "./guardrails";
import { escapeHtml, ICONS } from "./html";

// ---------- Small pieces ----------

/** "5 min ago", "3 h ago", "2 d ago", or the date for anything older than 30 days. */
export function relativeTime(ts: string | undefined, now = Date.now()): string {
	const then = ts ? Date.parse(ts) : Number.NaN;
	if (!Number.isFinite(then)) return "never";
	const minutes = Math.floor((now - then) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
	if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / (60 * 24))} d ago`;
	return new Date(then).toISOString().slice(0, 10);
}

/** A relative time with the exact UTC time as its tooltip and machine-readable value. */
export function timeHtml(ts: string | undefined, now = Date.now()): string {
	if (!ts || !Number.isFinite(Date.parse(ts))) return "never";
	const iso = new Date(Date.parse(ts)).toISOString();
	return `<time datetime="${iso}" title="${iso.replace("T", " ").slice(0, 19)} UTC">${relativeTime(ts, now)}</time>`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The status dot on an account: connected, or needs re-login. Always with its text. */
export function statusHtml(needsRelink: boolean): string {
	return needsRelink
		? '<span class="status status-alert"><span class="status-dot"></span>Needs re-login</span>'
		: '<span class="status"><span class="status-dot"></span>Connected</span>';
}

/** Shown in place of a section whose data could not be loaded. Never a raw error. */
export function errorCardHtml(what: string, retryHref: string): string {
	return `<div class="card card-alert" role="alert">
<div class="card-title"><strong>Could not load ${escapeHtml(what)}</strong></div>
<p class="card-sub">Nothing was changed. This is usually temporary.</p>
<div class="card-foot"><a class="btn" href="${escapeHtml(retryHref)}">Retry</a></div>
</div>`;
}

/** A card that explains an empty list. `bodyHtml` is trusted markup. */
export function emptyCardHtml(title: string, bodyHtml: string): string {
	return `<div class="card card-empty">
<div class="card-title"><strong>${escapeHtml(title)}</strong></div>
${bodyHtml}
</div>`;
}

/** Resolves to null instead of throwing, so one failed load cannot blank a page. */
export async function loadOrNull<T>(load: Promise<T>): Promise<T | null> {
	try {
		return await load;
	} catch (_e) {
		return null;
	}
}

/**
 * A detail view: a centered modal card over a dimmed backdrop (near full
 * screen on phones), scrolling inside when tall. It is part of the page the
 * server sends (opened by `?open=`), so it works without JavaScript: the X
 * and the backdrop are links back to the page, and the page behind is
 * `inert`, which keeps keyboard focus inside the modal. /static/menu.js adds
 * Escape-to-close and moves focus in.
 *
 * `closeHref` is the same page with a fragment naming the card that was
 * clicked, so focus returns to it. Callers build it from a validated alias
 * or group key only.
 */
export function modalHtml(options: {
	title: string;
	closeHref: string;
	/** Logo or avatar beside the title, and lines under it. Trusted markup. */
	leadHtml: string;
	subHtml: string;
	bodyHtml: string;
}): string {
	const close = escapeHtml(options.closeHref);
	return `<a class="modal-backdrop" href="${close}" tabindex="-1" aria-hidden="true"></a>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1" data-modal>
<div class="modal-head">
${options.leadHtml}
<div class="card-main">
<h2 id="modal-title">${escapeHtml(options.title)}</h2>
<div class="card-sub">${options.subHtml}</div>
</div>
<a class="icon-btn" href="${close}" aria-label="Close" title="Close" data-modal-close>${ICONS.close}</a>
</div>
${options.bodyHtml}
</div>`;
}

// ---------- Data lists: 5 rows and a CSV of everything ----------

/** Every table or list of data shows this many rows; the rest are in its CSV. */
export const ROW_LIMIT = 5;

export type ExportTable = "activity" | "usage" | "client-writes" | "client-connections" | "account-clients";

/** The address of a list's CSV. `params` hold only validated values (a group key, an alias). */
export function exportHref(table: ExportTable, params: Record<string, string | undefined> = {}): string {
	const search = new URLSearchParams({ table });
	for (const [name, value] of Object.entries(params)) if (value) search.set(name, value);
	return `/export.csv?${search}`;
}

/** Under a list: the Download CSV button and, when rows are hidden, how many there are. */
export function listFootHtml(href: string, total: number): string {
	return `<div class="list-foot"><a class="btn" href="${escapeHtml(href)}" download>Download CSV</a>${
		total > ROW_LIMIT ? `<span class="muted small">Showing ${ROW_LIMIT} of ${total}</span>` : ""
	}</div>`;
}

/** One AI client's use of one account. */
export type AccountClientRow = {
	group?: ClientGroup;
	label: string;
	writes: number;
	lastActive?: string;
};

/**
 * Which AI clients used an account, most recent first, across the account's
 * renames. A client that is no longer registered is listed by the name it
 * was recorded under. Throws if the audit log cannot be read.
 */
export async function loadAccountClientRows(
	env: Env,
	helpers: OAuthHelpers | undefined,
	userId: string,
	alias: string,
): Promise<AccountClientRow[]> {
	const stats = await clientStats(env, await aliasSpans(env, alias));
	const directory = helpers ? await loadOrNull(loadClientDirectory(helpers, userId)) : null;
	const groupOf = new Map<string, ClientGroup>();
	for (const group of directory?.groups ?? []) {
		for (const client of group.clients) groupOf.set(client.clientId, group);
	}
	const rows = new Map<string, AccountClientRow>();
	for (const stat of stats.values()) {
		const group = groupOf.get(stat.clientId);
		const key = group ? `group:${group.key}` : `gone:${stat.clientName}`;
		const row = rows.get(key) ?? { group, label: group?.label ?? (stat.clientName || "(no name)"), writes: 0 };
		row.writes += stat.writes;
		if (stat.lastActive && (!row.lastActive || stat.lastActive > row.lastActive)) row.lastActive = stat.lastActive;
		rows.set(key, row);
	}
	return [...rows.values()].sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
}

// ---------- Shared component: usage ----------

/** One usage meter: "3 of 25" over a bar filled in tenths (classes, since inline styles are not allowed). */
export function meterHtml(label: string, used: number | undefined, limit: number): string {
	if (used === undefined) {
		return `<div><span class="meter-top"><span>${label}</span><span>unavailable</span></span><span class="meter-track"><span class="meter-fill meter-0"></span></span></div>`;
	}
	const ratio = limit > 0 ? used / limit : 1;
	const tenths = Math.min(10, Math.max(used > 0 ? 1 : 0, Math.round(ratio * 10)));
	return `<div${ratio >= 0.9 ? ' class="meter-high"' : ""}><span class="meter-top"><span>${label}</span><span>${used} of ${limit}</span></span><span class="meter-track"><span class="meter-fill meter-${tenths}"></span></span></div>`;
}

export type AccountUsage = Awaited<ReturnType<typeof writeUsage>>;

/**
 * THE usage component: the four limits of one account, read from its usage
 * counter. Null usage (counter unreachable) shows "unavailable" on each line.
 */
export function usageMetersHtml(env: Env, usage: AccountUsage): string {
	return `<div class="meters">
${meterHtml("Emails sent today (UTC)", usage?.sendsToday, dailySendCap(env))}
${meterHtml("Writes this hour", usage?.writesThisHour, WRITE_RATE_LIMIT_PER_HOUR)}
${meterHtml("Reads this hour", usage?.readsThisHour, readRateLimit(env))}
${meterHtml("Files shared today", usage?.sharesToday, DAILY_SHARE_CAP)}
</div>`;
}

// ---------- Shared component: AI client list with Revoke ----------

/** What a client card shows beyond the registrations themselves. */
export type GroupActivity = {
	/** Successful writes in the 90 days the log is kept. */
	writes: number;
	lastActive?: string;
	latestWrite?: AuditEntry;
};

/** Folds per-registration stats into one group's numbers. */
export function groupActivity(group: ClientGroup, stats: Map<string, ClientStat>): GroupActivity {
	const activity: GroupActivity = { writes: 0 };
	for (const client of group.clients) {
		const stat = stats.get(client.clientId);
		if (!stat) continue;
		activity.writes += stat.writes;
		if (stat.lastActive && (!activity.lastActive || stat.lastActive > activity.lastActive)) {
			activity.lastActive = stat.lastActive;
		}
	}
	return activity;
}

/** Activity for every group, keyed by group key. Throws if the audit log cannot be read. */
export async function loadGroupActivity(
	env: Env,
	groups: readonly ClientGroup[],
): Promise<Map<string, GroupActivity>> {
	const stats = await clientStats(env);
	const result = new Map<string, GroupActivity>();
	await Promise.all(
		groups.map(async (group) => {
			const activity = groupActivity(group, stats);
			if (activity.writes > 0) {
				const clientIds = group.clients.map((client) => client.clientId);
				activity.latestWrite = (await recentWrites(env, { clientIds }, 1))[0];
			}
			result.set(group.key, activity);
		}),
	);
	return result;
}

/** "send_message on gmail, 2 h ago": action, account and time only. Never recipients or subjects. */
export function writeLineHtml(entry: AuditEntry, now = Date.now()): string {
	const failed = entry.outcome === "ok" ? "" : ' <span class="muted">(failed)</span>';
	return `<span class="mono">${escapeHtml(entry.tool)}</span> on <strong>${escapeHtml(entry.alias || "(all)")}</strong>${failed} <span class="muted">${timeHtml(entry.ts, now)}</span>`;
}

export function groupLogoHtml(group: Pick<ClientGroup, "brand" | "label">): string {
	return group.brand ? brandLogoHtml(group.brand) : letterTileHtml(group.label);
}

/** True when every registration in the group may connect. Null when the list could not be read. */
export function groupAllowed(group: ClientGroup, allowed: readonly string[] | null): boolean | null {
	if (allowed === null) return null;
	return group.clients.every((client) => {
		const uris = client.redirectUris ?? [];
		return uris.length > 0 && uris.every((uri) => isRedirectAllowed(uri, allowed));
	});
}

export function groupBadgesHtml(group: ClientGroup, allowed: readonly string[] | null): string {
	const ok = groupAllowed(group, allowed);
	return [
		group.unverified
			? '<span class="badge badge-alert" title="This app chose a well-known name, but its redirect URLs are not that company\'s.">Unverified</span>'
			: "",
		ok === null
			? '<span class="badge">List unavailable</span>'
			: ok
				? '<span class="badge badge-ok">Allowed</span>'
				: '<span class="badge badge-alert">Not allowed</span>',
	].join("");
}

/**
 * THE Revoke control: a two-step confirm (open, then "Yes, revoke") that
 * posts the group key. The server works out which registrations and grants
 * that means; the form never lists them.
 */
export function revokeFormHtml(group: ClientGroup, csrf: string): string {
	const label = escapeHtml(group.label);
	return `<details class="disclose confirm">
<summary class="btn btn-danger" aria-label="Revoke ${label}">Revoke…</summary>
<form method="post" action="/clients/revoke">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
<input type="hidden" name="group" value="${escapeHtml(group.key)}">
<p class="small">This removes ${group.clients.length === 1 ? "the connection" : `all ${group.clients.length} connections`} of <strong>${label}</strong>. Its tokens stop working at once. To use it again, add GoBridge in that app again.</p>
<button class="btn-danger-solid" type="submit" name="confirm" value="yes">Yes, revoke ${label}</button>
</form>
</details>`;
}

/**
 * THE AI client list: one card per app (see src/client-groups.ts), each with
 * its logo or letter tile, connection count, last activity, write count, the
 * latest write in one line, and Revoke. The card title opens the detail view.
 * `activity` is null when the audit log could not be read: the cards still
 * render, without the numbers.
 */
export function clientCardsHtml(
	groups: readonly ClientGroup[],
	options: {
		csrf: string;
		allowed: readonly string[] | null;
		activity: Map<string, GroupActivity> | null;
		now?: number;
	},
): string {
	const now = options.now ?? Date.now();
	if (!groups.length) {
		return `<div class="cards">
${emptyCardHtml(
	"No AI clients yet",
	`<p class="card-sub">To connect one, add this server as a custom connector in your AI app (for example Claude or ChatGPT), using the address ending in <code>/mcp</code>. The app must use a redirect URL that is on the allowed list in <a href="/settings">Settings</a>; if it is not, GoBridge shows you the exact URL to add.</p>`,
)}
</div>`;
	}
	const cards = groups.map((group) => {
		const label = escapeHtml(group.label);
		const stats = options.activity?.get(group.key);
		const alert = group.unverified || groupAllowed(group, options.allowed) === false;
		const connected = group.grants.length
			? plural(group.grants.length, "connection")
			: "Registered, not connected";
		return `<div class="card card-click${alert ? " card-alert" : ""}">
<div class="card-head">
${groupLogoHtml(group)}
<div class="card-main">
<div class="card-title"><a class="card-link" id="app-${escapeHtml(group.key)}" href="/clients?open=${escapeHtml(group.key)}"><strong>${label}</strong></a></div>
<div class="card-sub">${connected}${stats?.lastActive ? ` · last active ${timeHtml(stats.lastActive, now)}` : ""}</div>
</div>
</div>
<div class="card-sub">${
			stats
				? `${plural(stats.writes, "write")} in the last 90 days${stats.latestWrite ? `<br>Latest: ${writeLineHtml(stats.latestWrite, now)}` : ""}`
				: "Activity unavailable"
		}</div>
<div class="card-foot">${groupBadgesHtml(group, options.allowed)}
<span class="push">${revokeFormHtml(group, options.csrf)}</span>
</div>
</div>`;
	});
	return `<div class="cards">
${cards.join("\n")}
</div>`;
}
