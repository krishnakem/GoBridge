/**
 * Usage counters for the rate limits and the daily send cap.
 *
 * One SQLite-backed Durable Object per linked account alias (plus one named
 * "(all)" for calls that have no account, such as list_accounts). A Durable
 * Object handles one call at a time and `take` never waits on anything, so
 * checking the limit and counting the call is a single atomic step: two calls
 * arriving together can never both take the last slot.
 */
import { DurableObject } from "cloudflare:workers";

export type CounterKind = "read" | "write" | "send" | "share";

/** Reads and writes are counted per UTC hour; sends and shares per UTC day. */
export function counterWindow(kind: CounterKind, now: number): string {
	return kind === "send" || kind === "share"
		? new Date(now).toISOString().slice(0, 10)
		: `h${Math.floor(now / 3_600_000)}`;
}

export type CounterUsage = Record<CounterKind, number>;

export class UsageCounter extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// One row per kind: the current window and how many calls it has seen.
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS counters (kind TEXT PRIMARY KEY, win TEXT NOT NULL, count INTEGER NOT NULL)",
		);
	}

	private current(kind: CounterKind): number {
		const row = this.ctx.storage.sql
			.exec("SELECT win, count FROM counters WHERE kind = ?", kind)
			.toArray()[0];
		return row && row.win === counterWindow(kind, Date.now()) ? Number(row.count) : 0;
	}

	/**
	 * Counts one call if the limit allows it. Returns whether it was allowed.
	 * Synchronous on purpose: no other call can run between the check and the update.
	 */
	take(kind: CounterKind, limit: number): { allowed: boolean; count: number } {
		const count = this.current(kind);
		if (!(count < limit)) return { allowed: false, count };
		this.ctx.storage.sql.exec(
			"INSERT INTO counters (kind, win, count) VALUES (?, ?, ?) ON CONFLICT (kind) DO UPDATE SET win = excluded.win, count = excluded.count",
			kind,
			counterWindow(kind, Date.now()),
			count + 1,
		);
		return { allowed: true, count: count + 1 };
	}

	/** Current counts, for the /settings page. Changes nothing. */
	usage(): CounterUsage {
		return {
			read: this.current("read"),
			send: this.current("send"),
			share: this.current("share"),
			write: this.current("write"),
		};
	}
}
