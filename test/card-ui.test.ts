/**
 * The card layout of the owner pages: alias rules, the verified rename, client
 * grouping (including spoofed names), revoke-all, the activity views, the
 * detail drawers, and the gates on every changed endpoint.
 *
 * All names, addresses and tokens here are made up.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkNewAlias,
	deleteAccount,
	getAccount,
	getRefreshToken,
	listAccounts,
	renameAccount,
	RESERVED_ALIASES,
	saveAccount,
} from "../src/accounts";
import { activityPage, ACTIVITY_PAGE_SIZE, aliasSpans, clientStats } from "../src/activity";
import { addAllowedRedirect, normalizeRedirectUri } from "../src/allowed-clients";
import { clientIdentity, GROUP_KEY_PATTERN, groupClients, revokeGroup } from "../src/client-groups";
import { claimsKnownBrand } from "../src/client-logos";
import { clientCardsHtml, relativeTime } from "../src/components";
import { LINK_SCOPES } from "../src/google";
import { listAudit, OWNER_RENAME_LIMIT_PER_HOUR, recordAudit, recordReadAudit, takeOwnerRename } from "../src/guardrails";
import { LinkHandler } from "../src/link-handler";
import { OwnerPages } from "../src/owner-pages";
import { MENU_JS } from "../src/static-assets";

const BASE = "https://gobridge.test";
const OWNER_CLAIMS = { sub: "owner-sub-1", email: "owner@example.com", email_verified: true };
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const FAKE_REFRESH = "1//fake-google-refresh-token";

function mockGoogle(claims: Record<string, unknown> = OWNER_CLAIMS) {
	const revoked: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input as RequestInfo, init);
		if (request.url === "https://oauth2.googleapis.com/token") {
			return Response.json({ access_token: "ya29.fake-login-access-token", expires_in: 3600 });
		}
		if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json(claims);
		if (request.url === "https://oauth2.googleapis.com/revoke") {
			revoked.push(String((await request.formData()).get("token") ?? ""));
			return new Response(null, { status: 200 });
		}
		throw new Error(`Unexpected outbound fetch in test: ${new URL(request.url).origin}`);
	});
	return { revoked };
}

const cookiesFrom = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.filter((c) => !c.endsWith("="))
		.join("; ");

async function signIn(page = "/link") {
	const start = await SELF.fetch(`${BASE}${page}`, { redirect: "manual" });
	const google = new URL(start.headers.get("Location")!);
	const callback = await SELF.fetch(
		`${BASE}/callback?code=fake-login-code&state=${google.searchParams.get("state")}`,
		{ redirect: "manual", headers: { Cookie: cookiesFrom(start) } },
	);
	const cookie = cookiesFrom(callback);
	const html = await (await SELF.fetch(`${BASE}${page}`, { headers: { Cookie: cookie } })).text();
	return { cookie, csrf: html.match(/name="csrf_token" value="([^"]+)"/)![1] };
}

const get = (path: string, cookie?: string) =>
	SELF.fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });

const post = (path: string, cookie: string | null, fields: Record<string, string>) =>
	SELF.fetch(`${BASE}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
		body: new URLSearchParams(fields).toString(),
	});

let serial = 0;
async function account(alias: string) {
	serial += 1;
	await saveAccount(env, {
		alias,
		email: `person${serial}@example.com`,
		refreshToken: FAKE_REFRESH,
		scopes: [...LINK_SCOPES],
		sub: `card-sub-${serial}`,
	});
}

async function allow(...uris: string[]) {
	for (const uri of uris) {
		const normalized = normalizeRedirectUri(uri);
		if (normalized.ok) await addAllowedRedirect(env, normalized.uri);
	}
}

async function register(name: string, redirectUris: string[]) {
	const res = await SELF.fetch(`${BASE}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { client_id: string }).client_id;
}

/** Registers a client and takes it through the whole sign-in, returning its tokens. */
async function connect(name: string, redirectUri: string) {
	const clientId = await register(name, [redirectUri]);
	const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const dialog = await SELF.fetch(
		`${BASE}/authorize?${new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: "client-state",
			resource: `${BASE}/mcp`,
		})}`,
	);
	expect(dialog.status).toBe(200);
	const html = await dialog.text();
	const approve = await SELF.fetch(`${BASE}/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesFrom(dialog) },
		body: new URLSearchParams({
			state: html.match(/name="state" value="([^"]+)"/)![1],
			csrf_token: html.match(/name="csrf_token" value="([^"]+)"/)![1],
		}).toString(),
	});
	const google = new URL(approve.headers.get("Location")!);
	const callback = await SELF.fetch(
		`${BASE}/callback?code=fake-code&state=${google.searchParams.get("state")}`,
		{ redirect: "manual", headers: { Cookie: cookiesFrom(approve) } },
	);
	const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
	const token = await SELF.fetch(`${BASE}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: clientId,
			redirect_uri: redirectUri,
			code_verifier: verifier,
			resource: `${BASE}/mcp`,
		}).toString(),
	});
	expect(token.status).toBe(200);
	const { access_token, refresh_token } = (await token.json()) as { access_token: string; refresh_token: string };
	return { access: access_token, clientId, refresh: refresh_token };
}

const mcp = (accessToken: string) =>
	SELF.fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
		}),
	});

const refresh = (clientId: string, refreshToken: string) =>
	SELF.fetch(`${BASE}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }).toString(),
	});

/** Inserts an audit row with a chosen time (the app itself always uses "now"). */
async function row(
	table: "audit_writes" | "audit_reads",
	fields: { ts: string; alias: string; clientId: string; clientName?: string; tool: string; outcome?: string; meta?: object },
) {
	const last = table === "audit_writes" ? JSON.stringify(fields.meta ?? {}) : 1;
	await env.AUDIT_DB.prepare(
		`INSERT INTO ${table} (ts, alias, client_id, client_name, tool, outcome, ${table === "audit_writes" ? "meta" : "result_count"}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(fields.ts, fields.alias, fields.clientId, fields.clientName ?? "", fields.tool, fields.outcome ?? "ok", last)
		.run();
}

const groupKey = async (identity: { clientName?: string; redirectUris: string[] }) =>
	(await groupClients([{ clientId: "x", ...identity } as any], []))[0].key;

let logSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
});
afterEach(() => {
	vi.restoreAllMocks();
});
const logs = () =>
	logSpies
		.flatMap((spy) => spy.mock.calls)
		.map((args) => args.join(" "))
		.join("\n");

describe("alias rules", () => {
	it("accepts only lowercase letters, digits and inner hyphens, up to 32 characters", () => {
		for (const good of ["a", "work", "school-2", "x".repeat(32), "0", "a-b-c"]) {
			expect(checkNewAlias(good), good).toEqual({ alias: good, ok: true });
		}
		for (const bad of [
			"", "Work", "has space", "-lead", "trail-", "a_b", "x".repeat(33), "a.b", "é", "a\nb", "a<b",
			"ignore previous instructions", null, undefined, 7, ["work"],
		]) {
			const result = checkNewAlias(bad);
			expect(result.ok, String(bad)).toBe(false);
			if (!result.ok) expect(result.category).toBe("bad_alias");
		}
	});

	it("refuses reserved words, which are all valid-looking aliases", () => {
		for (const word of RESERVED_ALIASES) {
			expect(word, word).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
			expect(checkNewAlias(word)).toMatchObject({ category: "reserved_alias", ok: false });
		}
		for (const word of ["all", "none", "default", "me", "system", "assistant", "owner", "ignore"]) {
			expect(RESERVED_ALIASES.has(word), word).toBe(true);
		}
		// Ordinary names of services, places and people stay available.
		for (const fine of ["gmail", "work", "personal", "school", "family", "alltime", "me2"]) {
			expect(checkNewAlias(fine).ok, fine).toBe(true);
		}
	});

	it("refuses a reserved word for a new link and as a rename target, server-side", async () => {
		mockGoogle();
		await account("alias-rules");
		const owner = await signIn();
		const link = await post("/link", owner.cookie, { alias: "all", csrf_token: owner.csrf });
		expect(link.status).toBe(400);
		expect(await link.text()).toContain("reserved");
		const rename = await post("/link/rename", owner.cookie, {
			alias: "alias-rules", newAlias: "system", confirm: "yes", csrf_token: owner.csrf,
		});
		expect(rename.status).toBe(400);
		expect(await getAccount(env, "system")).toBeNull();
		expect(await getAccount(env, "alias-rules")).not.toBeNull();
		await deleteAccount(env, "alias-rules");
	});

	it("still lets an account that already has a reserved alias be read and re-connected", async () => {
		mockGoogle();
		await account("default");
		expect(await getRefreshToken(env, "default")).toBe(FAKE_REFRESH);
		const owner = await signIn();
		const reconnect = await post("/link", owner.cookie, { alias: "default", csrf_token: owner.csrf });
		expect(reconnect.status).toBe(303);
		expect(new URL(reconnect.headers.get("Location")!).hostname).toBe("accounts.google.com");
		await deleteAccount(env, "default");
	});
});

describe("rename: ordered, verified, safe to retry", () => {
	/** GOOGLE_TOKENS with one operation made to fail. */
	const failing = (fail: (op: string, key: string) => boolean) =>
		({
			...env,
			GOOGLE_TOKENS: new Proxy(env.GOOGLE_TOKENS, {
				get(target, prop) {
					const value = (target as any)[prop];
					if (typeof value !== "function") return value;
					return (...args: any[]) => {
						if (fail(String(prop), String(args[0]))) return Promise.reject(new Error("kv down"));
						return value.apply(target, args);
					};
				},
			}),
		}) as Env;

	it("requires a confirm step, and renames nothing without it", async () => {
		mockGoogle();
		await account("confirm-me");
		const owner = await signIn();
		const res = await post("/link/rename", owner.cookie, { alias: "confirm-me", newAlias: "confirmed", csrf_token: owner.csrf });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("saved instructions that use the old alias will stop working");
		expect(await getAccount(env, "confirmed")).toBeNull();
		expect(await getAccount(env, "confirm-me")).not.toBeNull();
		await deleteAccount(env, "confirm-me");
	});

	it("removes the copy and keeps the account when the new record cannot be verified", async () => {
		await account("verify-old");
		const before = await env.GOOGLE_TOKENS.get("account:verify-old");
		let reads = 0;
		// The read-back of the new record (its second read) fails.
		const broken = failing((op, key) => op === "get" && key === "account:verify-new" && ++reads === 2);
		expect(await renameAccount(broken, "verify-old", "verify-new")).toBe("verify_failed");
		expect(await env.GOOGLE_TOKENS.get("account:verify-new")).toBeNull();
		expect(await env.GOOGLE_TOKENS.get("account:verify-old")).toBe(before);
		expect(await getRefreshToken(env, "verify-old")).toBe(FAKE_REFRESH);
		await deleteAccount(env, "verify-old");
	});

	it("never loses the token when the old record cannot be deleted, and a retry finishes the rename", async () => {
		await account("stuck-old");
		const broken = failing((op, key) => op === "delete" && key === "account:stuck-old");
		expect(await renameAccount(broken, "stuck-old", "stuck-new")).toBe("old_not_removed");
		// Both records exist; each decrypts only under its own alias.
		expect(await getRefreshToken(env, "stuck-new")).toBe(FAKE_REFRESH);
		expect(await getRefreshToken(env, "stuck-old")).toBe(FAKE_REFRESH);
		const oldRecord = JSON.parse((await env.GOOGLE_TOKENS.get("account:stuck-old"))!);
		await env.GOOGLE_TOKENS.put("account:crossed", JSON.stringify({ ...oldRecord, alias: "crossed" }));
		await expect(getRefreshToken(env, "crossed")).rejects.toThrow();
		await env.GOOGLE_TOKENS.delete("account:crossed");

		// Retrying resumes: same Google account already under the new alias.
		expect(await renameAccount(env, "stuck-old", "stuck-new")).toBe("ok");
		expect(await getAccount(env, "stuck-old")).toBeNull();
		expect(await getRefreshToken(env, "stuck-new")).toBe(FAKE_REFRESH);
		await deleteAccount(env, "stuck-new");
	});

	it("will not resume onto an alias held by a different Google account", async () => {
		await account("mine");
		await account("theirs");
		const theirs = await env.GOOGLE_TOKENS.get("account:theirs");
		expect(await renameAccount(env, "mine", "theirs")).toBe("alias_in_use");
		expect(await env.GOOGLE_TOKENS.get("account:theirs")).toBe(theirs);
		expect(await getAccount(env, "mine")).not.toBeNull();
		await deleteAccount(env, "mine");
		await deleteAccount(env, "theirs");
	});

	it("tells the owner what remains after a partial rename, audits it, and finishes on retry", async () => {
		mockGoogle();
		await account("half-old");
		const owner = await signIn();
		const body = new URLSearchParams({ alias: "half-old", newAlias: "half-new", confirm: "yes", csrf_token: owner.csrf }).toString();
		const request = () =>
			new Request(`${BASE}/link/rename`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: owner.cookie },
				body,
			});
		const partial = await LinkHandler.fetch(request(), failing((op, key) => op === "delete" && key === "account:half-old"));
		expect(partial.status).toBe(500);
		const text = await partial.text();
		expect(text).toContain("now works as &quot;half-new&quot;");
		expect(text).toContain("safe to retry");
		const audit = (await listAudit(env, 50)).filter((entry) => entry.alias === "half-old");
		expect(audit[0]).toMatchObject({ outcome: "partial", tool: "rename_account" });

		const retry = await LinkHandler.fetch(request(), env);
		expect(retry.status).toBe(303);
		expect(await getAccount(env, "half-old")).toBeNull();
		expect(await getRefreshToken(env, "half-new")).toBe(FAKE_REFRESH);
		expect(logs()).not.toContain("1//");
		await deleteAccount(env, "half-new");
	});
});

describe("client grouping", () => {
	const claude = (id: string, name = "Claude") => ({ clientId: id, clientName: name, redirectUris: [CLAUDE_REDIRECT] });

	it("groups registrations of a verified brand, whatever they call themselves", async () => {
		const groups = await groupClients(
			[claude("a"), claude("b", "Claude (work)"), claude("c", "totally not claude")] as any,
			[{ clientId: "a", createdAt: 1, id: "g1" }, { clientId: "c", createdAt: 2, id: "g2" }] as any,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ label: "Claude", unverified: false });
		expect(groups[0].brand?.name).toBe("Claude");
		expect(groups[0].clients).toHaveLength(3);
		expect(groups[0].grants).toHaveLength(2);
		expect(groups[0].key).toMatch(GROUP_KEY_PATTERN);
	});

	it("gives a spoofed name its own unverified card, with no logo, never the brand's group", async () => {
		const groups = await groupClients(
			[
				claude("real"),
				{ clientId: "fake", clientName: "Claude", redirectUris: ["https://evil.example/cb"] },
				{ clientId: "mixed", clientName: "Claude", redirectUris: [CLAUDE_REDIRECT, "https://evil.example/cb"] },
				{ clientId: "local", clientName: "Claude Code", redirectUris: ["http://localhost:4123/callback"] },
				{ clientId: "sub", clientName: "ChatGPT", redirectUris: ["https://chatgpt.com.evil.example/cb"] },
			] as any,
			[],
		);
		expect(groups).toHaveLength(5);
		const byClient = (id: string) => groups.find((group) => group.clients.some((client) => client.clientId === id))!;
		expect(byClient("real").brand?.name).toBe("Claude");
		for (const id of ["fake", "mixed", "local", "sub"]) {
			expect(byClient(id).brand, id).toBeNull();
			expect(byClient(id).unverified, id).toBe(true);
			expect(byClient(id).key).not.toBe(byClient("real").key);
		}
		const html = clientCardsHtml(groups, { activity: null, allowed: [], csrf: "t" });
		expect(html.match(/logo-claude/g)).toHaveLength(1);
		expect(html.match(/>Unverified</g)).toHaveLength(4);
	});

	it("groups unknown apps only on the same name AND the same hosts", async () => {
		const app = (id: string, name: string, uri: string) => ({ clientId: id, clientName: name, redirectUris: [uri] });
		const groups = await groupClients(
			[
				app("1", "Notes", "https://notes.example/cb"),
				app("2", " notes ", "https://notes.example/other"),
				app("3", "Notes", "https://other.example/cb"),
				app("4", "Journal", "https://notes.example/cb"),
				app("5", "Notes", "http://127.0.0.1:9/cb"),
				app("6", "Notes", "http://localhost:1/cb"),
			] as any,
			[],
		);
		const sizes = groups.map((group) => group.clients.map((client) => client.clientId).sort().join("")).sort();
		expect(sizes).toEqual(["12", "3", "4", "56"]);
		expect(groups.every((group) => !group.unverified && !group.brand)).toBe(true);
	});

	it("detects brand names through spacing, punctuation and full-width letters", () => {
		for (const name of ["Claude", "chat-gpt", "Chat GPT", "OPENAI app", "ＣＬＡＵＤＥ", "by Anthropic"]) {
			expect(claimsKnownBrand(name), name).toBe(true);
		}
		for (const name of ["Notes", "", "Cloud", "My Assistant"]) expect(claimsKnownBrand(name), name).toBe(false);
	});

	it("derives the key from identity only, so a name cannot choose its key or its card", () => {
		const hostile = clientIdentity({ clientName: 'brand:Claude","x', redirectUris: ["https://evil.example/cb"] });
		expect(hostile.id).not.toBe(clientIdentity(claude("a")).id);
		expect(hostile.id.startsWith("other:")).toBe(true);
		expect(clientIdentity({ clientName: "x", redirectUris: [] }).brand).toBeNull();
	});
});

describe("revoke-all", () => {
	it("cuts off every connection of the app, refuses its old tokens, and leaves other apps alone", async () => {
		mockGoogle();
		const other = "https://notes.example/callback";
		await allow(CLAUDE_REDIRECT, other);
		const first = await connect("Claude", CLAUDE_REDIRECT);
		const second = await connect("Claude (second device)", CLAUDE_REDIRECT);
		const bystander = await connect("Notes", other);
		for (const client of [first, second, bystander]) expect((await mcp(client.access)).status).toBe(200);

		const owner = await signIn("/clients");
		const page = await (await get("/clients", owner.cookie)).text();
		// One card for both registrations.
		expect(page.match(/logo-claude/g)).toHaveLength(1);
		expect(page).toContain("2 connections");
		const key = await groupKey({ redirectUris: [CLAUDE_REDIRECT] });
		expect(page).toContain(`href="/clients?open=${key}"`);

		// Gates: no session, no CSRF, no confirm, GET. Nothing is revoked by any of them.
		expect((await post("/clients/revoke", null, { group: key, confirm: "yes", csrf_token: owner.csrf })).status).toBe(403);
		expect((await post("/clients/revoke", owner.cookie, { group: key, confirm: "yes" })).status).toBe(403);
		expect((await post("/clients/revoke", owner.cookie, { group: key, confirm: "yes", csrf_token: "forged" })).status).toBe(403);
		expect((await post("/clients/revoke", owner.cookie, { group: key, csrf_token: owner.csrf })).status).toBe(400);
		expect((await get(`/clients/revoke?group=${key}&confirm=yes&csrf_token=${owner.csrf}`, owner.cookie)).status).toBe(404);
		// A client id from the form is ignored: the group key is the only input.
		expect((await post("/clients/revoke", owner.cookie, { client_id: first.clientId, confirm: "yes", csrf_token: owner.csrf })).status).toBe(404);
		const unknown = await post("/clients/revoke", owner.cookie, { group: "<script>alert(1)</script>", confirm: "yes", csrf_token: owner.csrf });
		expect(unknown.status).toBe(404);
		expect(await unknown.text()).not.toContain("alert(1)");
		for (const client of [first, second]) expect((await mcp(client.access)).status).toBe(200);

		const res = await post("/clients/revoke", owner.cookie, { group: key, confirm: "yes", csrf_token: owner.csrf });
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/clients?msg=revoked");

		// Every old token of both registrations is refused; so is refreshing.
		for (const client of [first, second]) {
			expect((await mcp(client.access)).status).toBe(401);
			expect((await refresh(client.clientId, client.refresh)).status).toBeGreaterThanOrEqual(400);
			expect((await mcp(client.refresh)).status).toBe(401);
		}
		// The other app is untouched.
		expect((await mcp(bystander.access)).status).toBe(200);
		expect((await refresh(bystander.clientId, bystander.refresh)).status).toBe(200);

		const after = await (await get("/clients?msg=revoked", owner.cookie)).text();
		expect(after).toContain("Client revoked.");
		expect(after).not.toContain("logo-claude");
		expect(after).toContain("Notes");

		const audit = (await listAudit(env, 20)).find((entry) => entry.tool === "revoke_client")!;
		expect(audit).toMatchObject({ alias: "", clientId: "owner", clientName: "Owner (/clients)", outcome: "ok" });
		expect(audit.meta).toMatchObject({ clientCount: 2, grantCount: 2, remainingCount: 0, targetClient: "Claude" });
		// Neither the log nor the audit row holds a token.
		for (const secret of [first.access, first.refresh, second.access, owner.csrf]) {
			expect(logs()).not.toContain(secret);
			expect(JSON.stringify(audit)).not.toContain(secret);
		}
	});

	it("still removes the registrations when a grant cannot be removed, and reports what remains", async () => {
		const clients = [{ clientId: "c1" }, { clientId: "c2" }] as any;
		const live = new Set(["c1", "c2"]);
		const grants = [
			{ clientId: "c1", id: "g1" },
			{ clientId: "c2", id: "g2" },
			{ clientId: "zz", id: "other" },
		];
		const revoked: string[] = [];
		const helpers = {
			deleteClient: async (id: string) => void live.delete(id),
			listUserGrants: async (userId: string) => {
				expect(userId).toBe("owner-sub-1");
				return { items: grants.filter((grant) => !revoked.includes(grant.id)) };
			},
			lookupClient: async (id: string) => (live.has(id) ? { clientId: id } : null),
			revokeGrant: async (id: string) => {
				if (id === "g2") throw new Error("kv down");
				revoked.push(id);
			},
		} as any;
		const result = await revokeGroup(helpers, "owner-sub-1", { clients });
		expect(result).toEqual({ clientCount: 2, grantCount: 1, remainingClients: 0, remainingGrants: 1 });
		// Another app's grant was never touched.
		expect(revoked).toEqual(["g1"]);
		// Safe to repeat: nothing left to do for the registrations, the grant is retried.
		expect((await revokeGroup(helpers, "owner-sub-1", { clients })).remainingGrants).toBe(1);
	});

	it("shows a clear, retryable message and writes a partial audit row", async () => {
		mockGoogle();
		const owner = await signIn("/clients");
		const key = await groupKey({ clientName: "Stubborn", redirectUris: ["https://stubborn.example/cb"] });
		const helpers = {
			deleteClient: async () => {
				throw new Error("kv down");
			},
			listClients: async () => ({ items: [{ clientId: "s1", clientName: "Stubborn", redirectUris: ["https://stubborn.example/cb"] }] }),
			listUserGrants: async () => ({ items: [] }),
			lookupClient: async () => ({ clientId: "s1" }),
			revokeGrant: async () => undefined,
		};
		const res = await OwnerPages.fetch(
			new Request(`${BASE}/clients/revoke`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: owner.cookie },
				body: new URLSearchParams({ group: key, confirm: "yes", csrf_token: owner.csrf }).toString(),
			}),
			{ ...env, OAUTH_PROVIDER: helpers } as any,
		);
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).toContain("1 registration could not be removed and may still work");
		expect(text).toContain("safe to retry");
		expect(text).toContain("Back to AI clients");
		expect(text).not.toContain("kv down");
		const audit = (await listAudit(env, 5)).find((entry) => entry.tool === "revoke_client")!;
		expect(audit).toMatchObject({ outcome: "partial" });
		expect(audit.meta).toMatchObject({ remainingCount: 1, targetClient: "Stubborn" });
	});
});

describe("activity", () => {
	it("follows an account across a rename, and never shows a freed alias's old rows to its new holder", async () => {
		await row("audit_writes", { alias: "span-old", clientId: "span-c1", clientName: "App", tool: "send_message", ts: "2026-11-01T10:00:00.000Z" });
		await row("audit_writes", { alias: "span-old", clientId: "owner", tool: "rename_account", ts: "2026-11-02T10:00:00.000Z", meta: { newAlias: "span-new" } });
		await row("audit_writes", { alias: "span-new", clientId: "span-c1", clientName: "App", tool: "create_draft", ts: "2026-11-03T10:00:00.000Z" });
		// A different account is later linked under the freed alias.
		await row("audit_writes", { alias: "span-old", clientId: "span-c2", clientName: "Other", tool: "trash_thread", ts: "2026-11-04T10:00:00.000Z" });
		// A rename that failed verification changes nothing.
		await row("audit_writes", { alias: "span-x", clientId: "owner", tool: "rename_account", outcome: "verify_failed", ts: "2026-11-05T10:00:00.000Z", meta: { newAlias: "span-new" } });

		expect(await aliasSpans(env, "span-new")).toEqual([
			{ alias: "span-new", from: "2026-11-02T10:00:00.000Z", to: undefined },
			{ alias: "span-old", from: undefined, to: "2026-11-02T10:00:00.000Z" },
		]);
		expect(await aliasSpans(env, "span-old")).toEqual([
			{ alias: "span-old", from: "2026-11-02T10:00:00.000Z", to: undefined },
		]);

		const renamed = await clientStats(env, await aliasSpans(env, "span-new"));
		expect([...renamed.keys()]).toEqual(["span-c1"]);
		expect(renamed.get("span-c1")).toMatchObject({ lastActive: "2026-11-03T10:00:00.000Z", writes: 2 });
		const reused = await clientStats(env, await aliasSpans(env, "span-old"));
		expect([...reused.keys()]).toEqual(["span-c2"]);

		// An unlink also ends an alias's history.
		await row("audit_writes", { alias: "span-old", clientId: "owner", tool: "unlink_account", ts: "2026-11-06T10:00:00.000Z" });
		expect(await aliasSpans(env, "span-old")).toEqual([{ alias: "span-old", from: "2026-11-06T10:00:00.000Z", to: undefined }]);
	});

	it("pages newest first, filters by client and account, and adds reads only when asked", async () => {
		for (let i = 0; i < ACTIVITY_PAGE_SIZE + 5; i++) {
			await row("audit_writes", {
				alias: i % 2 ? "page-a" : "page-b",
				clientId: i % 5 ? "page-c1" : "page-c2",
				tool: "create_draft",
				ts: `2026-10-01T10:${String(i).padStart(2, "0")}:00.000Z`,
			});
		}
		await row("audit_reads", { alias: "page-a", clientId: "page-c1", tool: "get_thread", ts: "2026-10-01T12:00:00.000Z" });
		const ids = ["page-c1", "page-c2"];

		const first = await activityPage(env, { clientIds: ids, page: 1, reads: false });
		expect(first.entries).toHaveLength(ACTIVITY_PAGE_SIZE);
		expect(first.hasNext).toBe(true);
		expect(first.entries[0].ts > first.entries[1].ts).toBe(true);
		expect(first.entries.every((entry) => entry.kind === "write")).toBe(true);
		const second = await activityPage(env, { clientIds: ids, page: 2, reads: false });
		expect(second.entries).toHaveLength(5);
		expect(second.hasNext).toBe(false);

		const withReads = await activityPage(env, { clientIds: ids, page: 1, reads: true });
		expect(withReads.entries[0]).toMatchObject({ kind: "read", meta: { resultCount: 1 }, tool: "get_thread" });

		const oneClient = await activityPage(env, { clientIds: ["page-c2"], page: 1, reads: false });
		expect(oneClient.entries).toHaveLength(11);
		const oneAccount = await activityPage(env, { clientIds: ids, page: 1, reads: false, spans: [{ alias: "page-a" }] });
		expect(oneAccount.entries.every((entry) => entry.alias === "page-a")).toBe(true);
		expect(oneAccount.entries).toHaveLength(27);
		expect((await activityPage(env, { clientIds: [], page: 1, reads: true })).entries).toEqual([]);
		// A nonsense page number falls back to the first page.
		expect((await activityPage(env, { clientIds: ids, page: Number.NaN, reads: false })).entries).toHaveLength(ACTIVITY_PAGE_SIZE);
	});

	it("formats relative times", () => {
		const now = Date.parse("2026-11-25T12:00:00Z");
		expect(relativeTime("2026-11-25T11:59:40Z", now)).toBe("just now");
		expect(relativeTime("2026-11-25T11:30:00Z", now)).toBe("30 min ago");
		expect(relativeTime("2026-11-25T07:00:00Z", now)).toBe("5 h ago");
		expect(relativeTime("2026-11-20T12:00:00Z", now)).toBe("5 d ago");
		expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("2026-09-01");
		expect(relativeTime(undefined, now)).toBe("never");
		expect(relativeTime("<script>", now)).toBe("never");
	});
});

describe("linked accounts page", () => {
	it("shows a card per account, a + card for the add flow, and the inline rename form", async () => {
		mockGoogle();
		await account("grid-one");
		const owner = await signIn();
		const html = await (await get("/link", owner.cookie)).text();
		expect(html).not.toContain("<table");
		expect(html).toContain('<a class="card-link" href="/link?open=grid-one"><strong>grid-one</strong></a>');
		expect(html).toContain('<span class="status"><span class="status-dot"></span>Connected</span>');
		// The pencil is a real link (works without the script) that the script upgrades.
		expect(html).toContain('<a class="icon-btn reveal" href="/link?open=grid-one#rename" data-rename-open aria-label="Rename grid-one" title="Rename">');
		expect(html).toMatch(/<form class="rename-inline" method="post" action="\/link\/rename" hidden data-rename-form>\n<input type="hidden" name="csrf_token" value="[^"]+">\n<input type="hidden" name="alias" value="grid-one">/);
		expect(html).toContain("Saved instructions that use the old alias will stop working.");
		expect(html).toContain('<button class="btn-primary" type="submit" name="confirm" value="yes">Rename</button>');
		// The last card starts the existing add-account flow.
		const cards = html.slice(html.indexOf('<div class="cards">'));
		expect(cards.lastIndexOf('<details class="card card-add disclose">')).toBeGreaterThan(cards.lastIndexOf('class="card card-click'));
		expect(html).toMatch(/<summary aria-label="Link a Google account">[\s\S]*?<form class="field" method="post" action="\/link">/);
		// No detail view, so the page is not inert.
		expect(html).not.toContain("data-drawer");
		expect(html).not.toContain(" inert");
		await deleteAccount(env, "grid-one");
	});

	it("opens the detail view with usage, per-client status, re-connect, rename and unlink", async () => {
		mockGoogle();
		await account("detail-acct");
		await allow("https://notes.example/callback");
		const clientId = await register("Notes", ["https://notes.example/callback"]);
		const secretMeta = { recipients: ["someone@example.com"], subject: "Quarterly secret" };
		await recordAudit(env, { alias: "detail-acct", clientId, clientName: "Notes", meta: secretMeta, outcome: "ok", tool: "send_message" });
		await recordAudit(env, { alias: "detail-acct", clientId, clientName: "Notes", meta: {}, outcome: "ok", tool: "create_draft" });
		await recordAudit(env, { alias: "detail-acct", clientId: "gone-client-1", clientName: "Old <b>App</b>", meta: {}, outcome: "ok", tool: "create_draft" });
		await recordReadAudit(env, { alias: "detail-acct", clientId, clientName: "Notes", outcome: "ok", tool: "get_thread" });
		await recordAudit(env, { alias: "someone-else", clientId, clientName: "Notes", meta: {}, outcome: "ok", tool: "trash_thread" });
		const counter = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName("detail-acct"));
		for (let i = 0; i < 2; i++) await counter.take("send", 25);

		const owner = await signIn();
		const html = await (await get("/link?open=detail-acct", owner.cookie)).text();
		const drawer = html.slice(html.indexOf('<aside class="drawer"'));
		expect(drawer).toContain('<aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1" data-drawer>');
		expect(drawer).toContain('<h2 id="drawer-title">detail-acct</h2>');
		expect(drawer).toContain('<a class="icon-btn" href="/link" aria-label="Close" title="Close" data-drawer-close>');
		// The page behind the drawer cannot be focused or clicked.
		expect(html).toContain('<div class="shell" inert>');
		expect(html).toContain('<nav class="tabbar" aria-label="Main" inert>');
		// Usage: the shared component.
		expect(drawer).toContain("<span>Emails sent today (UTC)</span><span>2 of 25</span>");
		// Per-client status: last activity and write count, for this account only.
		expect(drawer).toMatch(/<strong>Notes<\/strong><\/div>\n<div class="card-sub">Last active <time [^>]+>just now<\/time> · 2 writes<\/div>/);
		expect(drawer).toContain('<strong>Old &lt;b&gt;App&lt;/b&gt;</strong> <span class="badge">No longer registered</span>');
		expect(drawer).not.toContain("<b>App</b>");
		// Minimal fields only: no recipients or subjects in the drawer.
		expect(html).not.toContain("Quarterly secret");
		expect(html).not.toContain("someone@example.com");
		// Re-connect, rename (with its confirm) and unlink (two steps), all POST with CSRF.
		for (const action of ["/link", "/link/rename", "/link/unlink"]) {
			expect(drawer).toContain(`method="post" action="${action}">\n<input type="hidden" name="csrf_token" value="${owner.csrf}">\n<input type="hidden" name="alias" value="detail-acct">`);
		}
		expect(drawer).toContain('<input type="checkbox" name="confirm" value="yes" required>');
		expect(drawer).toContain('<button class="btn-danger-solid" type="submit" name="confirm" value="yes">Yes, unlink detail-acct</button>');
		expect(drawer).not.toMatch(/\son[a-z]+=|\sstyle=/i);
		await deleteAccount(env, "detail-acct");
	});

	it("ignores an unknown or malformed ?open= without echoing it", async () => {
		mockGoogle();
		await account("open-real");
		const owner = await signIn();
		for (const value of ["never-linked", "<script>alert(1)</script>", "OPEN-REAL", "open-real%00", "../settings", "a".repeat(300), ""]) {
			const res = await get(`/link?open=${encodeURIComponent(value)}`, owner.cookie);
			expect(res.status, value).toBe(200);
			const html = await res.text();
			expect(html, value).not.toContain("data-drawer");
			expect(html).not.toContain(" inert");
			if (value.length > 3 && value !== "OPEN-REAL") expect(html).not.toContain(value);
			expect(html).not.toContain("alert(1)");
		}
		await deleteAccount(env, "open-real");
	});

	it("unlinks only after the confirm step, audits it, and is never rate limited", async () => {
		const google = mockGoogle();
		await account("unlink-me");
		const owner = await signIn();
		const unconfirmed = await post("/link/unlink", owner.cookie, { alias: "unlink-me", csrf_token: owner.csrf });
		expect(unconfirmed.status).toBe(400);
		expect(await getAccount(env, "unlink-me")).not.toBeNull();
		expect(google.revoked).toEqual([]);

		// Even with the counters unreachable, unlink goes through.
		const res = await LinkHandler.fetch(
			new Request(`${BASE}/link/unlink`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: owner.cookie },
				body: new URLSearchParams({ alias: "unlink-me", confirm: "yes", csrf_token: owner.csrf }).toString(),
			}),
			{ ...env, USAGE_COUNTER: undefined } as unknown as Env,
		);
		expect(res.status).toBe(303);
		expect(await getAccount(env, "unlink-me")).toBeNull();
		expect(google.revoked).toEqual([FAKE_REFRESH]);
		const audit = (await listAudit(env, 5)).find((entry) => entry.tool === "unlink_account")!;
		expect(audit).toMatchObject({ alias: "unlink-me", clientId: "owner", outcome: "ok" });
		expect(JSON.stringify(audit)).not.toContain("1//");
	});

	it("explains how to link when there are no accounts, and shows a retry when the list cannot be read", async () => {
		mockGoogle();
		for (const linked of await listAccounts(env)) await deleteAccount(env, linked.alias);
		const owner = await signIn();
		const empty = await (await get("/link", owner.cookie)).text();
		expect(empty).toContain("<strong>No accounts linked yet</strong>");
		expect(empty).toContain('<details class="card card-add disclose" open>');

		const broken = {
			...env,
			GOOGLE_TOKENS: new Proxy(env.GOOGLE_TOKENS, {
				get: (target, prop) =>
					prop === "list" ? () => Promise.reject(new Error("kv exploded")) : (target as any)[prop].bind(target),
			}),
		} as Env;
		const res = await LinkHandler.fetch(new Request(`${BASE}/link`, { headers: { Cookie: owner.cookie } }), broken);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Could not load your linked accounts");
		expect(html).toContain('<a class="btn" href="/link">Retry</a>');
		expect(html).not.toContain("kv exploded");
		// The account menu (and sign-out) still render.
		expect(html).toContain('action="/logout"');
	});
});

describe("AI clients page", () => {
	it("shows one card per app with connections, last activity, write count and the latest write", async () => {
		mockGoogle();
		await allow("https://cardapp.example/callback");
		const one = await register("Card App", ["https://cardapp.example/callback"]);
		const two = await register("Card App", ["https://cardapp.example/callback"]);
		await recordAudit(env, { alias: "work", clientId: one, clientName: "Card App", meta: { recipients: ["x@example.com"], subject: "Hidden subject" }, outcome: "ok", tool: "send_message" });
		await recordAudit(env, { alias: "work", clientId: two, clientName: "Card App", meta: {}, outcome: "ok", tool: "create_event" });
		await recordAudit(env, { alias: "work", clientId: two, clientName: "Card App", meta: {}, outcome: "rate_limited", tool: "create_event" });

		const owner = await signIn("/clients");
		const html = await (await get("/clients", owner.cookie)).text();
		const key = await groupKey({ clientName: "Card App", redirectUris: ["https://cardapp.example/callback"] });
		const card = html.slice(html.indexOf(`href="/clients?open=${key}"`) - 400).split('<div class="card card-click')[1];
		expect(card).toContain('<span class="client-logo" aria-hidden="true">C</span>');
		expect(card).toContain("<strong>Card App</strong>");
		expect(card).toContain("Registered, not connected");
		expect(card).toMatch(/last active <time [^>]+>just now<\/time>/);
		// Failed writes are not counted.
		expect(card).toContain("2 writes in the last 90 days");
		expect(card).toMatch(/Latest: <span class="mono">create_event<\/span> on <strong>work<\/strong>/);
		expect(card).toContain('<span class="badge badge-ok">Allowed</span>');
		expect(html).not.toContain("Hidden subject");
		expect(html).not.toContain("x@example.com");
		// The separate Recent writes page is gone from the navigation.
		expect(html).not.toContain("Recent writes");

		// Detail view: recent writes (account, action, time), both connections, Revoke.
		const drawer = (await (await get(`/clients?open=${key}`, owner.cookie)).text()).split('<aside class="drawer"')[1];
		expect(drawer).toContain('<h2 id="drawer-title">Card App</h2>');
		expect(drawer).toContain("<h3>Recent writes</h3>");
		expect(drawer.match(/<li class="row"><div class="row-main"><span class="mono">/g)).toHaveLength(3);
		expect(drawer).toContain('<span class="muted">(failed)</span>');
		expect(drawer).toContain("<h3>2 connections</h3>");
		expect(drawer).toContain(`<dd class="mono">${one}</dd>`);
		expect(drawer).toContain(`<dd class="mono">${two}</dd>`);
		expect(drawer).toContain('<span class="mono small">https://cardapp.example/callback</span> <span class="badge badge-ok">Allowed</span>');
		expect(drawer).toContain(`<input type="hidden" name="group" value="${key}">`);
		expect(drawer).not.toContain("Hidden subject");
	});

	it("escapes a hostile client name everywhere and flags a spoofed brand", async () => {
		mockGoogle();
		await register('<img src=x onerror=boom()>"Claude', ["https://spoof.example/cb"]);
		const owner = await signIn("/clients");
		const html = await (await get("/clients", owner.cookie)).text();
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x onerror=boom()&gt;&quot;Claude");
		const card = html.split("&lt;img src=x")[0].split('<div class="card card-click').pop()!;
		expect(card).toContain("card-alert");
		expect(card).not.toContain("logo-claude");
		const tail = html.split("&lt;img src=x onerror=boom()&gt;&quot;Claude</strong>")[1];
		expect(tail.split('<div class="card card-click')[0]).toContain(">Unverified</span>");
		// The name only ever appears escaped, in text and inside quoted attributes:
		// its own < > and " never reach the page, so it cannot open a tag or close a quote.
		expect(html).not.toContain("boom()>");
		expect(html).not.toContain('"Claude');
		expect(html.match(/onerror=boom\(\)/g)!.length).toBe(html.match(/onerror=boom\(\)&gt;&quot;Claude/g)!.length);
	});

	it("ignores an unknown or malformed ?open= without echoing it", async () => {
		mockGoogle();
		const owner = await signIn("/clients");
		for (const value of ["AAAAAAAAAAAAAAAA", "<script>alert(1)</script>", "leftover", "owner", "x".repeat(16) + "!"]) {
			const res = await get(`/clients?open=${encodeURIComponent(value)}`, owner.cookie);
			expect(res.status, value).toBe(200);
			const html = await res.text();
			expect(html, value).not.toContain("data-drawer");
			expect(html).not.toContain("alert(1)");
			expect(html).not.toContain("AAAAAAAAAAAAAAAA");
		}
	});

	it("explains how to connect when there are no clients, and shows a retry when they cannot be read", async () => {
		expect(clientCardsHtml([], { activity: null, allowed: [], csrf: "t" })).toContain("<strong>No AI clients yet</strong>");
		mockGoogle();
		const owner = await signIn("/clients");
		const helpers = {
			listClients: async () => {
				throw new Error("kv exploded");
			},
			listUserGrants: async () => ({ items: [] }),
		};
		for (const page of ["/clients", "/settings"]) {
			const res = await OwnerPages.fetch(new Request(`${BASE}${page}`, { headers: { Cookie: owner.cookie } }), {
				...env,
				OAUTH_PROVIDER: helpers,
			} as any);
			expect(res.status, page).toBe(200);
			const html = await res.text();
			expect(html).toContain("Could not load your AI clients");
			expect(html).toContain(`<a class="btn" href="${page}">Retry</a>`);
			expect(html).not.toContain("kv exploded");
		}
	});
});

describe("settings: shared components and All activity", () => {
	it("uses the same client list, with the same Revoke, as the AI clients page", async () => {
		mockGoogle();
		await register("Shared List App", ["https://shared.example/cb"]);
		const owner = await signIn("/settings");
		const cardsOf = (html: string) =>
			html
				.split('<div class="card card-click')
				.slice(1)
				.map((card) => card.split("</details>")[0].replace(/<time [^>]+>[^<]*<\/time>/g, "<time>"))
				.filter((card) => card.includes("/clients?open="));
		const onClients = cardsOf(await (await get("/clients", owner.cookie)).text());
		const onSettings = cardsOf(await (await get("/settings", owner.cookie)).text());
		expect(onClients.length).toBeGreaterThan(0);
		expect(onSettings).toEqual(onClients);
		expect(onSettings.join("")).toContain('action="/clients/revoke"');
	});

	it("filters by client and account, pages, and keeps recipients behind a per-row expand", async () => {
		mockGoogle();
		await account("act-one");
		await account("act-two");
		await allow("https://activity.example/cb");
		const clientId = await register("Activity App", ["https://activity.example/cb"]);
		const key = await groupKey({ clientName: "Activity App", redirectUris: ["https://activity.example/cb"] });
		await recordAudit(env, { alias: "act-one", clientId, clientName: "Activity App", meta: { recipients: ["to@example.com"], subject: "Visible only when expanded" }, outcome: "ok", tool: "send_message" });
		await recordAudit(env, { alias: "act-two", clientId, clientName: "Activity App", meta: {}, outcome: "ok", tool: "trash_thread" });
		await recordAudit(env, { alias: "act-two", clientId: "act-other", clientName: "Someone Else", meta: {}, outcome: "ok", tool: "create_label" });
		const owner = await signIn("/settings");
		const activity = async (query: string) =>
			(await (await get(`/settings${query}`, owner.cookie)).text()).split('id="activity"')[1];

		const all = await activity("");
		expect(all).toContain("<strong>send_message</strong>");
		expect(all).toContain("<strong>create_label</strong>");
		expect(all).toContain('<details class="row-details"><summary>Details</summary><div class="small">To: to@example.com<br>Subject: Visible only when expanded</div></details>');
		expect(all).toContain('Someone Else<br><span class="muted small">No longer registered</span>');
		expect(all).toContain(`<option value="${key}">Activity App (activity.example)</option>`);

		const byClient = await activity(`?client=${key}`);
		expect(byClient).toContain("<strong>send_message</strong>");
		expect(byClient).toContain("<strong>trash_thread</strong>");
		expect(byClient).not.toContain("<strong>create_label</strong>");
		expect(byClient).toContain(`<option value="${key}" selected>`);

		const both = await activity(`?client=${key}&account=act-two`);
		expect(both).toContain("<strong>trash_thread</strong>");
		expect(both).not.toContain("<strong>send_message</strong>");
		expect(both).toContain('<option value="act-two" selected>act-two</option>');

		const ownerOnly = await activity("?client=owner");
		expect(ownerOnly).not.toContain("<strong>send_message</strong>");

		// Unknown or hostile filter values are ignored, never echoed, never an error.
		const res = await get(`/settings?client=${encodeURIComponent("<script>alert(1)</script>")}&account=zz-not-linked&page=-5`, owner.cookie);
		expect(res.status).toBe(200);
		const hostile = await res.text();
		expect(hostile).not.toContain("alert(1)");
		expect(hostile).not.toContain("zz-not-linked");
		expect(hostile.split('id="activity"')[1]).toContain("<strong>send_message</strong>");

		// Paging keeps the filters and stays on the same section.
		for (let i = 0; i < ACTIVITY_PAGE_SIZE; i++) {
			await recordAudit(env, { alias: "act-one", clientId, clientName: "Activity App", meta: {}, outcome: "ok", tool: "create_draft" });
		}
		const paged = await activity(`?client=${key}`);
		expect(paged).toContain(`<a class="btn" href="/settings?client=${key}&amp;page=2#activity">Older</a>`);
		const second = await activity(`?client=${key}&page=2`);
		expect(second).toContain(`<a class="btn" href="/settings?client=${key}#activity">Newer</a>`);
		expect(second).toContain("<strong>send_message</strong>");
		await deleteAccount(env, "act-one");
		await deleteAccount(env, "act-two");
	});

	it("shows a retry in place of the activity log when it cannot be read", async () => {
		mockGoogle();
		const owner = await signIn("/settings");
		const broken = {
			...env,
			AUDIT_DB: { prepare: () => ({ all: () => Promise.reject(new Error("d1 exploded")), bind() { return this; } }) },
			OAUTH_PROVIDER: { listClients: async () => ({ items: [] }), listUserGrants: async () => ({ items: [] }) },
		};
		const res = await OwnerPages.fetch(new Request(`${BASE}/settings`, { headers: { Cookie: owner.cookie } }), broken as any);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Could not load the activity log");
		expect(html).toContain('<a class="btn" href="/settings#activity">Retry</a>');
		expect(html).toContain("The allowed list could not be read just now");
		expect(html).not.toContain("d1 exploded");
	});
});

describe("gates on every changed endpoint", () => {
	const POSTS: [string, Record<string, string>][] = [
		["/link", { alias: "gate-acct" }],
		["/link/rename", { alias: "gate-acct", newAlias: "gate-renamed", confirm: "yes" }],
		["/link/unlink", { alias: "gate-acct", confirm: "yes" }],
		["/clients/revoke", { group: "AAAAAAAAAAAAAAAA", confirm: "yes" }],
		["/clients/revoke", { group: "leftover", confirm: "yes" }],
	];
	const PAGES = ["/link?open=gate-acct", "/clients?open=AAAAAAAAAAAAAAAA", "/settings?client=owner&account=gate-acct&reads=show", "/audit"];

	it("gives no content and changes nothing without the owner's session", async () => {
		mockGoogle();
		await account("gate-acct");
		const owner = await signIn();
		// Signed out: the cookie is genuine but its server-side record is gone.
		const stale = await signIn();
		await post("/logout", stale.cookie, { csrf_token: stale.csrf });

		for (const cookie of [undefined, "__Host-GOBRIDGE_SESSION=forged.value", stale.cookie]) {
			for (const page of PAGES) {
				const res = await get(page, cookie);
				expect(res.status, page).toBe(302);
				expect(new URL(res.headers.get("Location")!).hostname).toBe("accounts.google.com");
				expect(await res.text()).toBe("");
			}
			for (const [path, fields] of POSTS) {
				// A valid CSRF token from another session does not help.
				const res = await post(path, cookie ?? null, { ...fields, csrf_token: owner.csrf });
				expect(res.status, path).toBe(403);
				expect(await res.text()).not.toContain("gate-acct");
			}
		}
		expect(await getAccount(env, "gate-acct")).not.toBeNull();
		expect(await getAccount(env, "gate-renamed")).toBeNull();
	});

	it("locks out a session whose address is no longer the owner's", async () => {
		mockGoogle();
		const owner = await signIn();
		const other = { ...env, ALLOWED_EMAIL: "someone-else@example.com" } as any;
		for (const page of ["/clients", "/settings", "/audit"]) {
			const res = await OwnerPages.fetch(new Request(`${BASE}${page}`, { headers: { Cookie: owner.cookie }, redirect: "manual" }), other);
			expect(res.status, page).toBe(302);
		}
		const link = await LinkHandler.fetch(new Request(`${BASE}/link?open=gate-acct`, { headers: { Cookie: owner.cookie } }), other);
		expect(link.status).toBe(302);
		const form = (path: string, fields: Record<string, string>) =>
			new Request(`${BASE}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: owner.cookie },
				body: new URLSearchParams({ ...fields, csrf_token: owner.csrf }).toString(),
			});
		for (const [path, fields] of POSTS) {
			const handler = path.startsWith("/link") ? LinkHandler : OwnerPages;
			expect((await handler.fetch(form(path, fields), other)).status, path).toBe(403);
		}
	});

	it("rejects a missing or wrong CSRF token, and never acts on GET", async () => {
		mockGoogle();
		const owner = await signIn();
		for (const [path, fields] of POSTS) {
			expect((await post(path, owner.cookie, fields)).status, path).toBe(403);
			expect((await post(path, owner.cookie, { ...fields, csrf_token: "forged" })).status, path).toBe(403);
			if (path !== "/link") {
				const viaGet = await get(`${path}?${new URLSearchParams({ ...fields, csrf_token: owner.csrf })}`, owner.cookie);
				expect(viaGet.status, path).toBe(404);
			}
		}
		expect(await getAccount(env, "gate-acct")).not.toBeNull();
		expect(await getAccount(env, "gate-renamed")).toBeNull();
		await deleteAccount(env, "gate-acct");
	});
});

describe("rename rate limit", () => {
	it("refuses renames past the hourly limit, but never unlink or revoke", async () => {
		const google = mockGoogle();
		await account("limit-acct");
		const owner = await signIn();
		let taken = 0;
		while (await takeOwnerRename(env)) taken += 1;
		expect(taken).toBeLessThanOrEqual(OWNER_RENAME_LIMIT_PER_HOUR);

		const res = await post("/link/rename", owner.cookie, { alias: "limit-acct", newAlias: "limit-new", confirm: "yes", csrf_token: owner.csrf });
		expect(res.status).toBe(429);
		expect(await res.text()).toContain(`at most ${OWNER_RENAME_LIMIT_PER_HOUR} renames an hour`);
		expect(await getAccount(env, "limit-new")).toBeNull();
		expect(await getAccount(env, "limit-acct")).not.toBeNull();

		// Emergency actions still work with the limit exhausted.
		await register("Limit App", ["https://limit.example/cb"]);
		const key = await groupKey({ clientName: "Limit App", redirectUris: ["https://limit.example/cb"] });
		expect((await post("/clients/revoke", owner.cookie, { group: key, confirm: "yes", csrf_token: owner.csrf })).status).toBe(303);
		expect((await post("/link/unlink", owner.cookie, { alias: "limit-acct", confirm: "yes", csrf_token: owner.csrf })).status).toBe(303);
		expect(google.revoked).toEqual([FAKE_REFRESH]);
	});
});

describe("page script (menu.js)", () => {
	type Fake = {
		hidden: boolean;
		value: string;
		readOnly: boolean;
		textContent: string;
		listeners: Record<string, ((event: any) => void)[]>;
		parts: Record<string, Fake>;
		focus: () => void;
		[key: string]: any;
	};
	let focused: Fake | null = null;
	const el = (parts: Record<string, Fake> = {}, extra: Record<string, unknown> = {}): Fake => {
		const node: Fake = {
			addEventListener: (type: string, listener: (event: any) => void) => (node.listeners[type] ??= []).push(listener),
			checkValidity: () => /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(node.parts["input[name=newAlias]"]?.value ?? ""),
			contains: () => true,
			focus: () => {
				focused = node;
			},
			hidden: false,
			listeners: {},
			parts,
			querySelector: (selector: string) => node.parts[selector] ?? null,
			readOnly: false,
			reportValidity: () => undefined,
			select: () => undefined,
			textContent: "",
			value: "",
			...extra,
		};
		return node;
	};
	const event = (extra: Record<string, unknown> = {}) => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra });

	function mount(options: { drawer?: boolean; hash?: string } = {}) {
		const input = el({}, { value: "work" });
		const submit = el();
		const shown = el();
		const confirm = el({ "button[type=submit]": submit }, { hidden: true });
		const cancel = el();
		const form = el(
			{ "[data-rename-cancel]": cancel, "[data-rename-confirm]": confirm, "[data-rename-new]": shown, "input[name=newAlias]": input },
			{ hidden: true },
		);
		const opener = el();
		const view = el();
		const root = el({ "[data-rename-open]": opener, "[data-rename-view]": view, "form[data-rename-form]": form });
		const closeLink = el({}, { getAttribute: () => "/link" });
		const drawer = options.drawer ? el({ "a[data-drawer-close]": closeLink }) : null;
		const documentListeners: Record<string, ((event: any) => void)[]> = {};
		const assigned: string[] = [];
		const fakeDocument = {
			addEventListener: (type: string, listener: (event: any) => void) => (documentListeners[type] ??= []).push(listener),
			getElementById: () => null,
			querySelector: (selector: string) => (selector === "[data-drawer]" ? drawer : null),
			querySelectorAll: (selector: string) => (selector === "[data-rename]" ? [root] : []),
		};
		const fakeWindow = { location: { assign: (href: string) => assigned.push(href), hash: options.hash ?? "" } };
		focused = null;
		new Function("document", "window", MENU_JS)(fakeDocument, fakeWindow);
		return { assigned, cancel, confirm, documentListeners, drawer, form, input, opener, shown, submit, view };
	}

	it("never builds markup from data", () => {
		expect(MENU_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|createElement|fetch\(|XMLHttpRequest|https?:/);
	});

	it("turns the alias into a field: Enter asks to confirm, Enter again saves, Escape cancels", () => {
		const dom = mount();
		const click = event();
		dom.opener.listeners.click[0](click);
		expect(click.defaultPrevented).toBe(true);
		expect(dom.form.hidden).toBe(false);
		expect(dom.view.hidden).toBe(true);
		expect(focused).toBe(dom.input);

		// Enter with an invalid alias: nothing is submitted, no confirm shown.
		dom.input.value = "Not Valid";
		const invalid = event({ key: "Enter", target: dom.input });
		dom.form.listeners.keydown[0](invalid);
		expect(invalid.defaultPrevented).toBe(true);
		expect(dom.confirm.hidden).toBe(true);

		// Enter with a valid alias: the confirm step appears, the new name set as text.
		dom.input.value = "office";
		const first = event({ key: "Enter", target: dom.input });
		dom.form.listeners.keydown[0](first);
		expect(first.defaultPrevented).toBe(true);
		expect(dom.confirm.hidden).toBe(false);
		expect(dom.shown.textContent).toBe("office");
		expect(dom.input.readOnly).toBe(true);
		expect(focused).toBe(dom.submit);

		// Second step: the form is allowed to post.
		const second = event();
		dom.form.listeners.submit[0](second);
		expect(second.defaultPrevented).toBe(false);

		// Escape cancels and puts everything back.
		dom.form.listeners.keydown[0](event({ key: "Escape" }));
		expect(dom.form.hidden).toBe(true);
		expect(dom.view.hidden).toBe(false);
		expect(focused).toBe(dom.opener);
		dom.opener.listeners.click[0](event());
		expect(dom.input.value).toBe("work");
		expect(dom.confirm.hidden).toBe(true);
		expect(dom.input.readOnly).toBe(false);

		// Enter without a change just closes the field; Cancel does the same.
		const unchanged = event();
		dom.form.listeners.submit[0](unchanged);
		expect(unchanged.defaultPrevented).toBe(true);
		expect(dom.form.hidden).toBe(true);
		dom.opener.listeners.click[0](event());
		dom.cancel.listeners.click[0](event());
		expect(dom.form.hidden).toBe(true);
	});

	it("moves focus into the detail view and closes it on Escape", () => {
		const dom = mount({ drawer: true });
		expect(focused).toBe(dom.drawer);
		const escape = event({ key: "Escape", target: { closest: () => null } });
		dom.documentListeners.keydown[0](escape);
		expect(dom.assigned).toEqual(["/link"]);
		// Other keys, and keys something else already handled, do nothing.
		dom.documentListeners.keydown[0](event({ key: "a" }));
		dom.documentListeners.keydown[0](event({ defaultPrevented: true, key: "Escape" }));
		expect(dom.assigned).toHaveLength(1);
		// An open confirm inside the drawer closes first.
		const summary = el();
		const details = el({ summary }, { open: true });
		dom.documentListeners.keydown[0](event({ key: "Escape", target: { closest: () => details } }));
		expect(details.open).toBe(false);
		expect(focused).toBe(summary);
		expect(dom.assigned).toHaveLength(1);
	});
});
