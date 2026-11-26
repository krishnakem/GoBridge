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

export type ActivityOptions = ActivityFilter & {
	/** Include reads (audit_reads) as well as writes. */
	reads: boolean;
	/** Leave out the owner's own actions (renames, revokes, ...): AI clients' rows only. */
	clientsOnly?: boolean;
};

/** The SELECT behind every activity list, count and export, so they can never disagree. */
function activitySelect(options: ActivityOptions): Clause {
	const filter = filterClause(options);
	const where = options.clientsOnly ? `client_id != ? AND ${filter.sql}` : filter.sql;
	const binds = options.clientsOnly ? [OWNER_CLIENT_ID, ...filter.binds] : filter.binds;
	const select = (table: string, kind: string, meta: string, count: string) =>
		`SELECT '${kind}' AS kind, id, ts, alias, client_id, client_name, tool, outcome, ${meta} AS meta, ${count} AS result_count FROM ${table} WHERE ${where}`;
	return options.reads
		? {
				binds: [...binds, ...binds],
				sql: `${select("audit_writes", "write", "meta", "NULL")} UNION ALL ${select("audit_reads", "read", "NULL", "result_count")}`,
			}
		: { binds, sql: select("audit_writes", "write", "meta", "NULL") };
}

/** Activity rows matching the options, newest first. */
export async function listActivity(
	env: Env,
	options: ActivityOptions & { limit: number; offset?: number },
): Promise<AuditEntry[]> {
	const select = activitySelect(options);
	const { results } = await env.AUDIT_DB.prepare(`${select.sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
		.bind(...select.binds, options.limit, options.offset ?? 0)
		.all<AuditRow & { kind: "write" | "read" }>();
	return results.map((row) => auditEntryFrom(row, row.kind));
}

/** How many rows match the options. */
export async function countActivity(env: Env, options: ActivityOptions): Promise<number> {
	const select = activitySelect(options);
	const row = await env.AUDIT_DB.prepare(`SELECT COUNT(*) AS n FROM (${select.sql})`)
		.bind(...select.binds)
		.first<{ n: number }>();
	return Number(row?.n) || 0;
}

/** Rows read per query when exporting, and the most rows one export returns. */
const EXPORT_BATCH = 5000;
export const EXPORT_MAX_ROWS = 200_000;

/** Every row matching the options, newest first, for a CSV export. */
export async function allActivity(env: Env, options: ActivityOptions, batch = EXPORT_BATCH): Promise<AuditEntry[]> {
	const rows: AuditEntry[] = [];
	while (rows.length < EXPORT_MAX_ROWS) {
		const page = await listActivity(env, { ...options, limit: batch, offset: rows.length });
		rows.push(...page);
		if (page.length < batch) break;
	}
	return rows;
}

/** The newest writes by AI clients matching the filter (not the owner's own actions). */
export function recentWrites(env: Env, filter: ActivityFilter, limit: number): Promise<AuditEntry[]> {
	return listActivity(env, { ...filter, clientsOnly: true, limit, reads: false });
}
