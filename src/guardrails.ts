/**
 * Write guardrails (SPEC.md, non-negotiable):
 *   - WRITES_ENABLED kill switch
 *   - rate limit: 60 write-tool calls per account per hour
 *   - daily cap on send_draft per account (DAILY_SEND_CAP, default 25)
 *   - audit log of every write in KV AUDIT_LOG, 90-day TTL, never bodies
 *
 * Read guardrails (added before launch):
 *   - rate limit: READ_RATE_LIMIT_PER_HOUR read-tool calls per account per hour
 *     (default 300)
 *   - a minimal audit entry per read: who, which tool, outcome, result count.
 *     Never queries, ids, subjects, or content
 *
 * Counters live in AUDIT_LOG under their own prefixes. KV counters are not
 * atomic: the limits are firm for normal use but best-effort under bursts of
 * simultaneous calls.
 */
import { randomToken } from "./crypto";
import { ToolError } from "./google-api";

export const WRITE_RATE_LIMIT_PER_HOUR = 60;
const DEFAULT_DAILY_SEND_CAP = 25;
const AUDIT_TTL_SECONDS = 90 * 24 * 60 * 60;
const AUDIT_PREFIX = "audit:";
/** Reads are stored apart from writes, so a busy day of reads never hides a write. */
const READ_AUDIT_PREFIX = "readaudit:";
const DEFAULT_READ_RATE_LIMIT = 300;

/** Only the exact value "true" enables writes; anything else is off. */
export function writesEnabled(env: Env): boolean {
	return env.WRITES_ENABLED === "true";
}

export function dailySendCap(env: Env): number {
	const parsed = Number.parseInt(env.DAILY_SEND_CAP, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_SEND_CAP;
}

async function increment(env: Env, key: string, limit: number, ttl: number): Promise<boolean> {
	const current = Number.parseInt((await env.AUDIT_LOG.get(key)) ?? "0", 10) || 0;
	if (current >= limit) return false;
	await env.AUDIT_LOG.put(key, String(current + 1), { expirationTtl: ttl });
	return true;
}

const rateKey = (alias: string) => `rate:${alias}:${Math.floor(Date.now() / 3_600_000)}`;
const readRateKey = (alias: string) =>
	`readrate:${alias || "_none"}:${Math.floor(Date.now() / 3_600_000)}`;
const sendCapKey = (alias: string) => `sendcap:${alias}:${new Date().toISOString().slice(0, 10)}`;

/** Read-only view of an account's counters, for the /settings page. */
export async function writeUsage(
	env: Env,
	alias: string,
): Promise<{ sendsToday: number; writesThisHour: number; readsThisHour: number }> {
	const [sends, writes, reads] = await Promise.all([
		env.AUDIT_LOG.get(sendCapKey(alias)),
		env.AUDIT_LOG.get(rateKey(alias)),
		env.AUDIT_LOG.get(readRateKey(alias)),
	]);
	return {
		readsThisHour: Number.parseInt(reads ?? "0", 10) || 0,
		sendsToday: Number.parseInt(sends ?? "0", 10) || 0,
		writesThisHour: Number.parseInt(writes ?? "0", 10) || 0,
	};
}

/** Counts one write-tool call for this account; throws once the hourly limit is reached. */
export async function enforceWriteRateLimit(env: Env, alias: string): Promise<void> {
	if (!(await increment(env, rateKey(alias), WRITE_RATE_LIMIT_PER_HOUR, 2 * 3600))) {
		throw new ToolError(
			"rate_limited",
			`Rate limit reached: at most ${WRITE_RATE_LIMIT_PER_HOUR} write actions per account per hour. Try again later.`,
		);
	}
}

export function readRateLimit(env: Env): number {
	const parsed = Number.parseInt(env.READ_RATE_LIMIT_PER_HOUR, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_READ_RATE_LIMIT;
}

/**
 * Counts one read-tool call for this account; throws once the hourly limit is
 * reached. Reads often arrive several at once, and KV refuses rapid writes to
 * one key, so a failed counter update lets the read through (and is logged)
 * instead of failing it. A counter that is already at the limit always blocks.
 */
export async function enforceReadRateLimit(env: Env, alias: string): Promise<void> {
	const limit = readRateLimit(env);
	const key = readRateKey(alias);
	const current = Number.parseInt((await env.AUDIT_LOG.get(key)) ?? "0", 10) || 0;
	if (current >= limit) {
		throw new ToolError(
			"rate_limited",
			`Rate limit reached: at most ${limit} read actions per account per hour. Try again later.`,
		);
	}
	try {
		await env.AUDIT_LOG.put(key, String(current + 1), { expirationTtl: 2 * 3600 });
	} catch (_e) {
		console.warn("read rate counter error: kv_write_failed");
	}
}

/**
 * Reserves one send for this account today (UTC); throws once the daily cap is
 * reached. Reserved before sending, so a failed send still counts.
 */
export async function reserveDailySend(env: Env, alias: string): Promise<void> {
	const cap = dailySendCap(env);
	if (!(await increment(env, sendCapKey(alias), cap, 2 * 24 * 3600))) {
		throw new ToolError(
			"send_cap_reached",
			`Daily send cap reached: at most ${cap} emails per account per day. Nothing was sent.`,
		);
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
	/** Reads only: how many items came back. Never what they were. */
	resultCount?: number;
};

export type AuditEntry = {
	/** Absent on entries written before reads were audited: those are writes. */
	kind?: "read" | "write";
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
		resultCount: typeof meta.resultCount === "number" ? meta.resultCount : undefined,
		subject: clip(meta.subject, 300),
		summary: clip(meta.summary, 300),
	};
}

async function putAudit(env: Env, prefix: string, record: AuditEntry): Promise<void> {
	// Newest first when listed: keys sort by descending time.
	const key = `${prefix}${String(9_999_999_999_999 - Date.parse(record.ts)).padStart(13, "0")}:${randomToken(6)}`;
	await env.AUDIT_LOG.put(key, JSON.stringify(record), { expirationTtl: AUDIT_TTL_SECONDS });
}

/**
 * Records one read. The entry type has no place for queries, ids, subjects or
 * content: only who, which tool, the outcome and how many items came back.
 */
export async function recordReadAudit(
	env: Env,
	entry: { alias: string; clientId: string; clientName: string; tool: string; outcome: string; resultCount?: number },
): Promise<void> {
	await putAudit(env, READ_AUDIT_PREFIX, {
		alias: entry.alias,
		clientId: entry.clientId.slice(0, 200),
		clientName: entry.clientName.slice(0, 100),
		kind: "read",
		meta: typeof entry.resultCount === "number" ? { resultCount: entry.resultCount } : {},
		outcome: entry.outcome.slice(0, 40),
		tool: entry.tool,
		ts: new Date().toISOString(),
	});
}

export async function recordAudit(env: Env, entry: Omit<AuditEntry, "ts">): Promise<void> {
	const record: AuditEntry = {
		alias: entry.alias,
		clientId: entry.clientId.slice(0, 200),
		clientName: entry.clientName.slice(0, 100),
		meta: sanitizeMeta(entry.meta),
		outcome: entry.outcome.slice(0, 40),
		kind: "write",
		tool: entry.tool,
		ts: new Date().toISOString(),
	};
	await putAudit(env, AUDIT_PREFIX, record);
}

/** The most recent write (default) or read audit entries, newest first. */
export async function listAudit(
	env: Env,
	limit = 100,
	kind: "write" | "read" = "write",
): Promise<AuditEntry[]> {
	const page = await env.AUDIT_LOG.list({
		limit,
		prefix: kind === "read" ? READ_AUDIT_PREFIX : AUDIT_PREFIX,
	});
	const entries = await Promise.all(
		page.keys.map(async (key) => {
			try {
				return JSON.parse((await env.AUDIT_LOG.get(key.name)) ?? "null") as AuditEntry | null;
			} catch (_e) {
				return null;
			}
		}),
	);
	return entries.filter((entry): entry is AuditEntry => entry !== null);
}
