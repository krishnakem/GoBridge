/**
 * Guardrails for the MCP tools.
 *
 * Writes (SPEC.md, non-negotiable):
 *   - WRITES_ENABLED kill switch
 *   - rate limit: 60 write-tool calls per account per hour
 *   - daily cap on send_draft per account (DAILY_SEND_CAP, default 25)
 *   - audit log of every write, kept 90 days, never bodies
 *
 * Reads:
 *   - rate limit: READ_RATE_LIMIT_PER_HOUR calls per account per hour (default 300)
 *   - a minimal audit entry per read: who, which tool, outcome, result count.
 *     Never queries, ids, subjects, or content
 *
 * Counters live in the UsageCounter Durable Object (atomic). Every limit FAILS
 * CLOSED: if the counter cannot be reached, the call is refused.
 * The audit log lives in the D1 database AUDIT_DB; a daily cron trigger deletes
 * rows older than 90 days.
 */
import { ToolError } from "./google-api";
import type { CounterKind } from "./usage-counter";

export const WRITE_RATE_LIMIT_PER_HOUR = 60;
export const DAILY_SHARE_CAP = 10;

/**
 * Feature kill switches (non-secret vars). Each must be exactly "true" to be on.
 * WRITES_ENABLED gates every mutating tool; the others gate one feature each.
 */
export const KILL_SWITCHES = [
	"WRITES_ENABLED",
	"DIRECT_SEND_ENABLED",
	"FORWARD_ENABLED",
	"DRIVE_WRITE_ENABLED",
	"DRIVE_SHARE_ENABLED",
] as const;
export type KillSwitch = (typeof KILL_SWITCHES)[number];

export function switchEnabled(env: Env, name: KillSwitch): boolean {
	return (env as unknown as Record<string, unknown>)[name] === "true";
}

/** Names of the switches that are currently off. */
export function switchesOff(env: Env): KillSwitch[] {
	return KILL_SWITCHES.filter((name) => !switchEnabled(env, name));
}
export const AUDIT_RETENTION_DAYS = 90;
const DEFAULT_DAILY_SEND_CAP = 25;
const DEFAULT_READ_RATE_LIMIT = 300;
/** Counter used by calls that have no account (list_accounts). */
const NO_ACCOUNT = "(all)";

/** Only the exact value "true" enables writes; anything else is off. */
export function writesEnabled(env: Env): boolean {
	return env.WRITES_ENABLED === "true";
}

export function dailySendCap(env: Env): number {
	const parsed = Number.parseInt(env.DAILY_SEND_CAP, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_SEND_CAP;
}

export function readRateLimit(env: Env): number {
	const parsed = Number.parseInt(env.READ_RATE_LIMIT_PER_HOUR, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_READ_RATE_LIMIT;
}

function counterFor(env: Env, alias: string) {
	return env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(alias || NO_ACCOUNT));
}

/**
 * Counts one call against a limit. Returns false when the limit is reached.
 * Fails closed: if the counter cannot be reached or updated, the call is refused.
 */
async function take(env: Env, alias: string, kind: CounterKind, limit: number): Promise<boolean> {
	let allowed: unknown;
	try {
		allowed = (await counterFor(env, alias).take(kind, limit)).allowed;
	} catch (_e) {
		allowed = undefined;
	}
	if (typeof allowed !== "boolean") {
		console.error(`usage counter error: unavailable kind=${kind}`);
		throw new ToolError(
			"counter_unavailable",
			"GoBridge could not check its usage limits, so nothing was done. Try again in a moment.",
		);
	}
	return allowed;
}

/** Counts one write-tool call for this account; throws once the hourly limit is reached. */
export async function enforceWriteRateLimit(env: Env, alias: string): Promise<void> {
	if (!(await take(env, alias, "write", WRITE_RATE_LIMIT_PER_HOUR))) {
		throw new ToolError(
			"rate_limited",
			`Rate limit reached: at most ${WRITE_RATE_LIMIT_PER_HOUR} write actions per account per hour. Try again later.`,
		);
	}
}

/** Counts one read-tool call for this account; throws once the hourly limit is reached. */
export async function enforceReadRateLimit(env: Env, alias: string): Promise<void> {
	const limit = readRateLimit(env);
	if (!(await take(env, alias, "read", limit))) {
		throw new ToolError(
			"rate_limited",
			`Rate limit reached: at most ${limit} read actions per account per hour. Try again later.`,
		);
	}
}

/**
 * Reserves one send for this account today (UTC); throws once the daily cap is
 * reached. Reserved before sending, so a failed send still counts.
 */
export async function reserveDailySend(env: Env, alias: string): Promise<void> {
	const cap = dailySendCap(env);
	if (!(await take(env, alias, "send", cap))) {
		throw new ToolError(
			"send_cap_reached",
			`Daily send cap reached: at most ${cap} emails per account per day. Nothing was sent.`,
		);
	}
}

/** Reserves one share_file call for this account today (UTC); throws once the daily cap is reached. */
export async function reserveDailyShare(env: Env, alias: string): Promise<void> {
	if (!(await take(env, alias, "share", DAILY_SHARE_CAP))) {
		throw new ToolError(
			"share_cap_reached",
			`Daily share cap reached: at most ${DAILY_SHARE_CAP} share_file calls per account per day. Nothing was shared.`,
		);
	}
}

/** Read-only view of an account's counters, for the /settings page. Null if unavailable. */
export async function writeUsage(
	env: Env,
	alias: string,
): Promise<{
	sendsToday: number;
	sharesToday: number;
	writesThisHour: number;
	readsThisHour: number;
} | null> {
	try {
		const usage = await counterFor(env, alias).usage();
		return {
			readsThisHour: usage.read,
			sendsToday: usage.send,
			sharesToday: usage.share ?? 0,
			writesThisHour: usage.write,
		};
	} catch (_e) {
		return null;
	}
}

/** Minimal, body-free facts about one write. */
export type AuditMeta = {
	draftId?: string;
	messageId?: string;
	messageCount?: number;
	recipients?: string[];
	subject?: string;
	addLabelIds?: string[];
	removeLabelIds?: string[];
	eventId?: string;
	calendarId?: string;
	summary?: string;
	sendUpdates?: string;
	response?: string;
	threadId?: string;
	labelIds?: string[];
	/** Forwards: the message that was forwarded. */
	originalMessageId?: string;
	/** Drive writes and shares. */
	fileId?: string;
	action?: string;
	parentId?: string;
	role?: string;
	recipient?: string;
	/** Reads only: how many items came back. Never what they were. */
	resultCount?: number;
};

export type AuditEntry = {
	kind: "read" | "write";
	ts: string;
	alias: string;
	clientId: string;
	clientName: string;
	tool: string;
	/** "ok" or an error category */
	outcome: string;
	meta: AuditMeta;
};

const clip = (value: unknown, max: number) =>
	typeof value === "string" ? value.slice(0, max) : undefined;

/** Copies only the known audit fields, clipped. Bodies can never get in. */
function sanitizeMeta(meta: AuditMeta): AuditMeta {
	const list = (values: unknown, max: number) =>
		Array.isArray(values) ? values.slice(0, max).map((v) => clip(v, 254) ?? "") : undefined;
	return {
		addLabelIds: list(meta.addLabelIds, 20),
		calendarId: clip(meta.calendarId, 256),
		draftId: clip(meta.draftId, 256),
		eventId: clip(meta.eventId, 256),
		messageCount: typeof meta.messageCount === "number" ? meta.messageCount : undefined,
		messageId: clip(meta.messageId, 256),
		recipients: list(meta.recipients, 60),
		removeLabelIds: list(meta.removeLabelIds, 20),
		response: clip(meta.response, 20),
		sendUpdates: clip(meta.sendUpdates, 20),
		subject: clip(meta.subject, 300),
		summary: clip(meta.summary, 300),
		threadId: clip(meta.threadId, 256),
		labelIds: list(meta.labelIds, 20),
		originalMessageId: clip(meta.originalMessageId, 256),
		fileId: clip(meta.fileId, 256),
		action: clip(meta.action, 40),
		parentId: clip(meta.parentId, 256),
		role: clip(meta.role, 20),
		recipient: clip(meta.recipient, 254),
	};
}

type AuditInput = {
	alias: string;
	clientId: string;
	clientName: string;
	tool: string;
	outcome: string;
};

/** Records one write: recipients + subject, or event id + summary. Never bodies. */
export async function recordAudit(env: Env, entry: AuditInput & { meta: AuditMeta }): Promise<void> {
	await env.AUDIT_DB.prepare(
		"INSERT INTO audit_writes (ts, alias, client_id, client_name, tool, outcome, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			new Date().toISOString(),
			entry.alias,
			entry.clientId.slice(0, 200),
			entry.clientName.slice(0, 100),
			entry.tool,
			entry.outcome.slice(0, 40),
			JSON.stringify(sanitizeMeta(entry.meta)),
		)
		.run();
}

/**
 * Records one read. The table has no column for queries, ids, subjects or
 * content: only who, which tool, the outcome and how many items came back.
 */
export async function recordReadAudit(
	env: Env,
	entry: AuditInput & { resultCount?: number },
): Promise<void> {
	await env.AUDIT_DB.prepare(
		"INSERT INTO audit_reads (ts, alias, client_id, client_name, tool, outcome, result_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			new Date().toISOString(),
			entry.alias,
			entry.clientId.slice(0, 200),
			entry.clientName.slice(0, 100),
			entry.tool,
			entry.outcome.slice(0, 40),
			typeof entry.resultCount === "number" ? entry.resultCount : null,
		)
		.run();
}

type AuditRow = {
	ts: string;
	alias: string;
	client_id: string;
	client_name: string;
	tool: string;
	outcome: string;
	meta?: string;
	result_count?: number | null;
};

/** The most recent write (default) or read audit entries, newest first. */
export async function listAudit(
	env: Env,
	limit = 100,
	kind: "write" | "read" = "write",
): Promise<AuditEntry[]> {
	const table = kind === "read" ? "audit_reads" : "audit_writes";
	const { results } = await env.AUDIT_DB.prepare(
		`SELECT * FROM ${table} ORDER BY ts DESC, id DESC LIMIT ?`,
	)
		.bind(limit)
		.all<AuditRow>();
	return results.map((row) => {
		let meta: AuditMeta = {};
		if (kind === "read") {
			if (typeof row.result_count === "number") meta = { resultCount: row.result_count };
		} else {
			try {
				meta = JSON.parse(row.meta ?? "{}") as AuditMeta;
			} catch (_e) {
				meta = {};
			}
		}
		return {
			alias: row.alias,
			clientId: row.client_id,
			clientName: row.client_name,
			kind,
			meta,
			outcome: row.outcome,
			tool: row.tool,
			ts: row.ts,
		};
	});
}

/** Deletes audit rows older than 90 days. Run daily by the cron trigger. */
export async function purgeOldAudit(env: Env, now = Date.now()): Promise<number> {
	const cutoff = new Date(now - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const results = await env.AUDIT_DB.batch([
		env.AUDIT_DB.prepare("DELETE FROM audit_writes WHERE ts < ?").bind(cutoff),
		env.AUDIT_DB.prepare("DELETE FROM audit_reads WHERE ts < ?").bind(cutoff),
	]);
	return results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
}
