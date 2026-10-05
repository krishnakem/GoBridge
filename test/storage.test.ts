import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAccount } from "../src/accounts";
import { clearAccessTokenCache } from "../src/google-api";
import {
	AUDIT_RETENTION_DAYS,
	listAudit,
	purgeOldAudit,
	recordAudit,
	recordReadAudit,
	writeUsage,
} from "../src/guardrails";
import worker from "../src/index";
import { runReadTool } from "../src/read-tools";
import { counterWindow } from "../src/usage-counter";
import { runWriteTool } from "../src/write-tools";

const CLIENT = { clientId: "client-storage-1", clientName: "Claude" };
let counter = 0;
let logSpies: ReturnType<typeof vi.spyOn>[] = [];

async function linked() {
	counter += 1;
	const alias = `store-${counter}`;
	await saveAccount(env, {
		alias,
		email: `store${counter}@example.com`,
		refreshToken: "1//fake-google-refresh-token",
		scopes: [],
		sub: `store-sub-${counter}`,
	});
	return alias;
}

/** A fake Google that accepts everything; returns the list of API paths called. */
function mockGoogle() {
	const paths: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input as RequestInfo, init);
		const url = new URL(request.url);
		if (request.url === "https://oauth2.googleapis.com/token") {
			return Response.json({ access_token: "ya29.fake-api-access-token", expires_in: 3600 });
		}
		paths.push(`${request.method} ${url.pathname}`);
		if (url.pathname.endsWith("/labels")) return Response.json({ labels: [] });
		if (url.pathname.endsWith("/drafts/send")) return Response.json({ id: "sent1" });
		if (url.pathname.includes("/drafts/")) {
			return Response.json({
				id: "draft1",
				message: { payload: { headers: [{ name: "To", value: "bob@example.com" }] } },
			});
		}
		return Response.json({ id: "m1" });
	});
	return paths;
}

const counterFor = (alias: string) => env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(alias));

function allLogOutput(): string {
	return logSpies
		.flatMap((spy) => spy.mock.calls)
		.map((args) => args.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
		.join("\n");
}

beforeEach(() => {
	clearAccessTokenCache();
	logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
		vi.spyOn(console, level),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("usage counters (Durable Object)", () => {
	it("counts atomically: concurrent calls never exceed the limit", async () => {
		const stub = counterFor("atomic-1");
		const results = await Promise.all(Array.from({ length: 200 }, () => stub.take("write", 60)));
		expect(results.filter((r) => r.allowed)).toHaveLength(60);
		expect(results.filter((r) => !r.allowed)).toHaveLength(140);
		// Every allowed call got its own slot: counts 1..60, each exactly once.
		expect(results.filter((r) => r.allowed).map((r) => r.count).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 60 }, (_x, i) => i + 1),
		);
		expect(await stub.usage()).toEqual({ read: 0, send: 0, write: 60 });
	});

	it("keeps read, write and send counts separate, and separate per account", async () => {
		const a = counterFor("separate-a");
		const b = counterFor("separate-b");
		await Promise.all([a.take("read", 5), a.take("read", 5), a.take("write", 5), a.take("send", 5)]);
		await b.take("read", 5);
		expect(await a.usage()).toEqual({ read: 2, send: 1, write: 1 });
		expect(await b.usage()).toEqual({ read: 1, send: 0, write: 0 });
		expect((await a.take("read", 2)).allowed).toBe(false);
		expect((await a.take("read", 0)).allowed).toBe(false);
		// A broken limit can never mean "unlimited".
		expect((await a.take("read", Number.NaN)).allowed).toBe(false);
	});

	it("uses hourly windows for reads and writes and daily windows for sends", () => {
		const t = Date.UTC(2026, 9, 5, 18, 59, 59);
		expect(counterWindow("read", t)).toBe(counterWindow("write", t));
		expect(counterWindow("read", t)).not.toBe(counterWindow("read", t + 1000));
		expect(counterWindow("read", t)).toBe(counterWindow("read", t - 59 * 60 * 1000));
		expect(counterWindow("send", t)).toBe("2026-10-05");
		expect(counterWindow("send", t + 1000)).toBe("2026-10-05");
		expect(counterWindow("send", Date.UTC(2026, 9, 6, 0, 0, 0))).toBe("2026-10-06");
	});

	it("enforces the send cap exactly under concurrent send_draft calls", async () => {
		const alias = await linked();
		const paths = mockGoogle();
		const capped = { ...env, DAILY_SEND_CAP: "5" } as Env;
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				runWriteTool(capped, CLIENT, "send_draft", { account: alias, draftId: "draft1" }),
			),
		);
		expect(results.filter((r) => !r.isError)).toHaveLength(5);
		const refused = results.filter((r) => r.isError);
		expect(refused).toHaveLength(15);
		expect(refused.every((r) => r.content[0].text.includes("Daily send cap reached"))).toBe(true);
		expect(paths.filter((p) => p.endsWith("/drafts/send"))).toHaveLength(5);
		expect(await writeUsage(env, alias)).toMatchObject({ sendsToday: 5, writesThisHour: 20 });
	});

	it("enforces the read limit exactly under concurrent reads", async () => {
		const alias = await linked();
		const paths = mockGoogle();
		const limited = { ...env, READ_RATE_LIMIT_PER_HOUR: "7" } as Env;
		const results = await Promise.all(
			Array.from({ length: 30 }, () => runReadTool(limited, "list_labels", { account: alias }, CLIENT)),
		);
		expect(results.filter((r) => !r.isError)).toHaveLength(7);
		expect(paths.filter((p) => p.endsWith("/labels"))).toHaveLength(7);
		expect((await listAudit(env, 1000, "read")).filter((e) => e.alias === alias)).toHaveLength(7);
	});
});

describe("fail closed", () => {
	/** Environments whose counter cannot be reached, cannot be updated, or answers nonsense. */
	function brokenEnvs(): Env[] {
		const namespace = (take: () => unknown) => ({
			get: () => ({ take, usage: take }),
			idFromName: () => ({}),
		});
		return [
			{ ...env, USAGE_COUNTER: { idFromName: () => { throw new Error("namespace down"); } } },
			{ ...env, USAGE_COUNTER: namespace(() => Promise.reject(new Error("storage write failed"))) },
			{ ...env, USAGE_COUNTER: namespace(() => Promise.resolve({})) },
			{ ...env, USAGE_COUNTER: namespace(() => Promise.resolve({ allowed: "yes" })) },
			{ ...env, USAGE_COUNTER: undefined },
		] as unknown as Env[];
	}

	it("refuses reads when the counter cannot be updated", async () => {
		const alias = await linked();
		const paths = mockGoogle();
		for (const broken of brokenEnvs()) {
			for (const [name, args] of [
				["list_labels", { account: alias }],
				["list_accounts", {}],
			] as const) {
				const res = await runReadTool(broken, name, args, CLIENT);
				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("could not check its usage limits");
				expect(res.content[0].text).toContain("Try again");
				expect(res.content[0].text).not.toContain(alias);
			}
		}
		expect(paths).toHaveLength(0);
		expect((await listAudit(env, 1000, "read")).filter((e) => e.alias === alias)).toHaveLength(0);
		expect(allLogOutput()).toContain("usage counter error: unavailable kind=read");
		expect(allLogOutput()).not.toContain("namespace down");
	});

	it("refuses writes when the counter cannot be updated", async () => {
		const alias = await linked();
		const paths = mockGoogle();
		for (const broken of brokenEnvs()) {
			for (const [name, args] of [
				["trash_message", { account: alias, messageId: "m1" }],
				["send_draft", { account: alias, draftId: "draft1" }],
				["create_draft", { account: alias, to: ["bob@example.com"], subject: "s", body: "b" }],
			] as const) {
				const res = await runWriteTool(broken, CLIENT, name, args);
				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("could not check its usage limits");
			}
		}
		expect(paths).toHaveLength(0);
	});

	it("never sends when only the send counter fails", async () => {
		const alias = await linked();
		const paths = mockGoogle();
		const real = counterFor(alias);
		const sendBroken = {
			...env,
			USAGE_COUNTER: {
				get: () => ({
					take: (kind: string, limit: number) =>
						kind === "send" ? Promise.reject(new Error("down")) : real.take(kind as any, limit),
				}),
				idFromName: () => ({}),
			},
		} as unknown as Env;
		const res = await runWriteTool(sendBroken, CLIENT, "send_draft", { account: alias, draftId: "draft1" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("could not check its usage limits");
		expect(paths.some((p) => p.endsWith("/drafts/send"))).toBe(false);
		// The refused attempt is still on the audit log.
		const [entry] = (await listAudit(env, 1000)).filter((e) => e.alias === alias);
		expect(entry).toMatchObject({ outcome: "counter_unavailable", tool: "send_draft" });
	});
});

describe("audit log (D1)", () => {
	const DAY = 24 * 60 * 60 * 1000;

	it("keeps reads and writes in separate tables with no content columns", async () => {
		const tables = await env.AUDIT_DB.prepare(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'audit_%' ORDER BY name",
		).all<{ name: string; sql: string }>();
		expect(tables.results.map((t) => t.name)).toEqual(["audit_reads", "audit_writes"]);
		for (const table of tables.results) {
			expect(table.sql).not.toMatch(/\b(body|content|query|snippet|description)\b\s+(TEXT|BLOB)/i);
		}
		const readColumns = await env.AUDIT_DB.prepare("PRAGMA table_info(audit_reads)").all<{ name: string }>();
		expect(readColumns.results.map((c) => c.name).sort()).toEqual(
			["alias", "client_id", "client_name", "id", "outcome", "result_count", "tool", "ts"].sort(),
		);
	});

	it("deletes entries older than 90 days and keeps newer ones", async () => {
		expect(AUDIT_RETENTION_DAYS).toBe(90);
		const base = { alias: "purge-acct", clientId: "c1", clientName: "Claude", outcome: "ok" };
		await recordAudit(env, { ...base, meta: { subject: "recent" }, tool: "send_draft" });
		await recordReadAudit(env, { ...base, resultCount: 3, tool: "search_emails" });
		const old = new Date(Date.now() - 91 * DAY).toISOString();
		const almost = new Date(Date.now() - 89 * DAY).toISOString();
		for (const ts of [old, almost]) {
			await env.AUDIT_DB.prepare(
				"INSERT INTO audit_writes (ts, alias, client_id, client_name, tool, outcome, meta) VALUES (?, 'purge-acct', 'c1', 'Claude', 'trash_message', 'ok', '{}')",
			).bind(ts).run();
			await env.AUDIT_DB.prepare(
				"INSERT INTO audit_reads (ts, alias, client_id, client_name, tool, outcome, result_count) VALUES (?, 'purge-acct', 'c1', 'Claude', 'read_email', 'ok', 1)",
			).bind(ts).run();
		}
		const mine = async (kind: "read" | "write") =>
			(await listAudit(env, 1000, kind)).filter((e) => e.alias === "purge-acct");
		expect(await mine("write")).toHaveLength(3);
		expect(await mine("read")).toHaveLength(3);

		expect(await purgeOldAudit(env)).toBe(2);
		const writes = await mine("write");
		expect(writes).toHaveLength(2);
		expect(writes.every((e) => e.ts > old)).toBe(true);
		// Newest first.
		expect(writes[0].meta.subject).toBe("recent");
		expect(await mine("read")).toHaveLength(2);
		expect(await purgeOldAudit(env)).toBe(0);
	});

	it("runs the cleanup from the daily cron trigger", async () => {
		await env.AUDIT_DB.prepare(
			"INSERT INTO audit_reads (ts, alias, client_id, client_name, tool, outcome, result_count) VALUES (?, 'cron-acct', 'c1', 'Claude', 'read_email', 'ok', 1)",
		).bind(new Date(Date.now() - 200 * DAY).toISOString()).run();

		await worker.scheduled(createScheduledController(), env, createExecutionContext());

		const left = await env.AUDIT_DB.prepare("SELECT COUNT(*) AS n FROM audit_reads WHERE alias = 'cron-acct'").first<{ n: number }>();
		expect(left?.n).toBe(0);
		expect(allLogOutput()).toMatch(/cron audit_cleanup ok: deleted=\d+/);
	});
});
