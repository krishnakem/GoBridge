/**
 * What the owner pages show about activity, read from the audit tables in D1
 * (`audit_writes`, `audit_reads`). Read-only: nothing here writes or changes a
 * row, and nothing here can return more than the audit tables hold (never
 * bodies, queries or file content).
 *
 * Renames: an account's old audit rows keep the alias they were written
 * under (the log is never rewritten). To show one account's history across a
 * rename, `aliasSpans` follows the owner's `rename_account` rows backwards and
 * returns the (alias, time window) pairs that belong to the account.
 */
import { type AuditEntry, auditEntryFrom, type AuditRow } from "./guardrails";

/** `client_id` of rows the owner pages write themselves (renames, revokes, ...). */
export const OWNER_CLIENT_ID = "owner";

/** One stretch of an account's history: rows under `alias` with from <= ts < to. */
export type AliasSpan = { alias: string; from?: string; to?: string };

type OwnerEvent = { ts: string; alias: string; tool: string; newAlias?: string };

/**
 * The alias windows that belong to the account currently linked as `alias`.
 *
 * Walking back from now: the account has been `alias` since the latest rename
 * INTO it; before that it was the rename's old alias, until the rename into
 * that one, and so on. The oldest window starts where the alias last stopped
 * belonging to someone else: at its latest unlink, or at the latest rename
 * AWAY from it. So a new account linked under a freed alias never shows the
 * previous holder's rows.
 */
export async function aliasSpans(env: Env, alias: string): Promise<AliasSpan[]> {
	const { results } = await env.AUDIT_DB.prepare(
		`SELECT ts, alias, tool, meta FROM audit_writes
		 WHERE client_id = ? AND tool IN ('rename_account', 'unlink_account')
		   AND outcome IN ('ok', 'partial', 'not_revoked')
		 ORDER BY ts DESC, id DESC LIMIT 500`,
	)
		.bind(OWNER_CLIENT_ID)
		.all<{ ts: string; alias: string; tool: string; meta: string }>();
	const events: OwnerEvent[] = results.map((row) => {
		let newAlias: string | undefined;
		try {
			const meta = JSON.parse(row.meta ?? "{}") as { newAlias?: unknown };
			if (typeof meta.newAlias === "string") newAlias = meta.newAlias;
		} catch (_e) {
			newAlias = undefined;
		}
		return { alias: row.alias, newAlias, tool: row.tool, ts: row.ts };
	});

	const spans: AliasSpan[] = [];
	let current = alias;
	let upper: string | undefined;
	for (let hop = 0; hop <= MAX_RENAME_HOPS; hop++) {
		const before = (event: OwnerEvent) => upper === undefined || event.ts < upper;
		// events are newest first, so find() returns the latest match
		const renamedInto = events.find(
			(event) => event.tool === "rename_account" && event.newAlias === current && before(event),
		);
		if (renamedInto) {
			spans.push({ alias: current, from: renamedInto.ts, to: upper });
			current = renamedInto.alias;
			upper = renamedInto.ts;
			continue;
		}
		const freed = events.find(
			(event) =>
				event.alias === current &&
				before(event) &&
				(event.tool === "unlink_account" || event.tool === "rename_account"),
		);
		spans.push({ alias: current, from: freed?.ts, to: upper });
		break;
	}
	return spans;
}

type Clause = { sql: string; binds: (string | number)[] };

function spansClause(spans: readonly AliasSpan[]): Clause {
	const binds: string[] = [];
	const parts = spans.map((span) => {
		let sql = "alias = ?";
		binds.push(span.alias);
		if (span.from !== undefined) {
			sql += " AND ts >= ?";
			binds.push(span.from);
		}
		if (span.to !== undefined) {
			sql += " AND ts < ?";
			binds.push(span.to);
		}
		return `(${sql})`;
	});
	return { binds, sql: parts.length ? `(${parts.join(" OR ")})` : "0" };
}

/**
 * D1 allows 100 bound values per query, and the reads view binds the filter
 * twice. A group of more registrations than this is cut to its newest; an
 * account's history is followed across at most MAX_RENAME_HOPS renames.
 */
const MAX_RENAME_HOPS = 5;
export const MAX_CLIENT_IDS = 30;

export type ActivityFilter = {
	/** Only these client ids (one app's registrations), or the owner's own actions. */
	clientIds?: readonly string[];
	/** Only one account, across its renames. */
	spans?: readonly AliasSpan[];
};

function filterClause(filter: ActivityFilter): Clause {
	const parts: string[] = [];
	const binds: (string | number)[] = [];
	if (filter.clientIds) {
		const ids = filter.clientIds.slice(0, MAX_CLIENT_IDS);
		parts.push(ids.length ? `client_id IN (${ids.map(() => "?").join(", ")})` : "0");
		binds.push(...ids);
	}
	if (filter.spans) {
		const clause = spansClause(filter.spans);
		parts.push(clause.sql);
		binds.push(...clause.binds);
	}
	return { binds, sql: parts.length ? parts.join(" AND ") : "1" };
}

export type ClientStat = {
	clientId: string;
	/** The name recorded with the client's latest row (self-reported: escape on output). */
	clientName: string;
	/** Writes that succeeded, within the 90 days the log is kept. */
	writes: number;
	/** Latest read or write, successful or not. */
	lastActive?: string;
};

/** Per client id: successful writes and latest activity, optionally for one account only. */
export async function clientStats(
	env: Env,
	spans?: readonly AliasSpan[],
): Promise<Map<string, ClientStat>> {
	const clause = filterClause({ spans });
	const query = (table: string, count: string) =>
		env.AUDIT_DB.prepare(
			`SELECT client_id, MAX(client_name) AS name, ${count} AS n, MAX(ts) AS last
			 FROM ${table} WHERE client_id != ? AND ${clause.sql} GROUP BY client_id`,
		)
			.bind(OWNER_CLIENT_ID, ...clause.binds)
			.all<{ client_id: string; name: string; n: number; last: string }>();
	const [writes, reads] = await Promise.all([
		query("audit_writes", "SUM(outcome = 'ok')"),
		query("audit_reads", "0"),
	]);
	const stats = new Map<string, ClientStat>();
	for (const row of [...writes.results, ...reads.results]) {
		const stat = stats.get(row.client_id) ?? {
			clientId: row.client_id,
			clientName: row.name ?? "",
			writes: 0,
		};
		stat.writes += Number(row.n) || 0;
		if (row.last && (!stat.lastActive || row.last > stat.lastActive)) stat.lastActive = row.last;
		stats.set(row.client_id, stat);
	}
	return stats;
}

/** The newest writes matching the filter (AI clients' writes only, not the owner's own actions). */
export async function recentWrites(
	env: Env,
	filter: ActivityFilter,
	limit: number,
): Promise<AuditEntry[]> {
	const clause = filterClause(filter);
	const { results } = await env.AUDIT_DB.prepare(
		`SELECT * FROM audit_writes WHERE client_id != ? AND ${clause.sql} ORDER BY ts DESC, id DESC LIMIT ?`,
	)
		.bind(OWNER_CLIENT_ID, ...clause.binds, limit)
		.all<AuditRow>();
	return results.map((row) => auditEntryFrom(row, "write"));
}

export const ACTIVITY_PAGE_SIZE = 50;
/** Deepest page offered: 200 pages of 50. Older rows are still in D1 until the 90-day cleanup. */
export const ACTIVITY_MAX_PAGE = 200;

/**
 * One page of "All activity", newest first: every write (the owner's own
 * actions included) and, when asked, reads. `page` starts at 1.
 */
export async function activityPage(
	env: Env,
	options: ActivityFilter & { reads: boolean; page: number },
): Promise<{ entries: AuditEntry[]; hasNext: boolean }> {
	const clause = filterClause(options);
	const page = Math.min(Math.max(1, Math.floor(options.page) || 1), ACTIVITY_MAX_PAGE);
	const select = (table: string, kind: string, meta: string, count: string) =>
		`SELECT '${kind}' AS kind, id, ts, alias, client_id, client_name, tool, outcome, ${meta} AS meta, ${count} AS result_count FROM ${table} WHERE ${clause.sql}`;
	const sql = options.reads
		? `${select("audit_writes", "write", "meta", "NULL")} UNION ALL ${select("audit_reads", "read", "NULL", "result_count")}`
		: select("audit_writes", "write", "meta", "NULL");
	const binds = options.reads ? [...clause.binds, ...clause.binds] : clause.binds;
	const { results } = await env.AUDIT_DB.prepare(`${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
		.bind(...binds, ACTIVITY_PAGE_SIZE + 1, (page - 1) * ACTIVITY_PAGE_SIZE)
		.all<AuditRow & { kind: "write" | "read" }>();
	return {
		entries: results.slice(0, ACTIVITY_PAGE_SIZE).map((row) => auditEntryFrom(row, row.kind)),
		hasNext: results.length > ACTIVITY_PAGE_SIZE && page < ACTIVITY_MAX_PAGE,
	};
}
