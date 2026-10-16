import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addAllowedRedirect,
	checkClient,
	isRedirectAllowed,
	listAllowedRedirects,
	normalizeRedirectUri,
	removeAllowedRedirect,
} from "../src/allowed-clients";
import { isAllowedEmail, verifyOwner } from "../src/auth";

const BASE = "https://gobridge.test";
const CLIENT_REDIRECT = "https://client.example/callback";
// Shaped like real Google tokens/codes so leak checks are meaningful.
const FAKE_GOOGLE_ACCESS_TOKEN = "ya29.fake-google-access-token";
const FAKE_GOOGLE_CODE = "4/fake-google-auth-code";

type GoogleMock = {
	tokenStatus?: number;
	claims?: Record<string, unknown>;
};

const OWNER_CLAIMS = { sub: "owner-sub-1", email: "owner@example.com", email_verified: true };

let logSpies: ReturnType<typeof vi.spyOn>[] = [];

/** Replaces outbound fetch with a fake Google. Any other outbound call fails the test. */
function mockGoogle({ tokenStatus = 200, claims = OWNER_CLAIMS }: GoogleMock = {}) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new Request(input as RequestInfo, init).url;
		if (url === "https://oauth2.googleapis.com/token") {
			if (tokenStatus !== 200) {
				return new Response('{"error":"invalid_grant","error_description":"raw google detail"}', {
					status: tokenStatus,
				});
			}
			return Response.json({ access_token: FAKE_GOOGLE_ACCESS_TOKEN, expires_in: 3600 });
		}
		if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
			return Response.json(claims);
		}
		throw new Error(`Unexpected outbound fetch in test: ${new URL(url).origin}`);
	});
}

function cookiesFrom(res: Response): string {
	return res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.filter((c) => !c.endsWith("="))
		.join("; ");
}

async function pkcePair() {
	const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return { verifier, challenge };
}

async function registerClient(name = "Test Client", redirectUris = [CLIENT_REDIRECT]) {
	const res = await SELF.fetch(`${BASE}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: name,
			redirect_uris: redirectUris,
			token_endpoint_auth_method: "none",
		}),
	});
	expect(res.status).toBe(201);
	const { client_id } = (await res.json()) as { client_id: string };
	return client_id;
}

/** Runs the flow up to the redirect to Google. Returns what /callback needs. */
async function startLogin() {
	const clientId = await registerClient();
	const { verifier, challenge } = await pkcePair();

	const authorizeUrl = new URL(`${BASE}/authorize`);
	authorizeUrl.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: CLIENT_REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "client-state",
		resource: `${BASE}/mcp`,
	}).toString();

	const dialog = await SELF.fetch(authorizeUrl);
	expect(dialog.status).toBe(200);
	const html = await dialog.text();
	const formState = html.match(/name="state" value="([^"]+)"/)?.[1];
	const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
	expect(formState).toBeTruthy();
	expect(csrfToken).toBeTruthy();

	const approve = await SELF.fetch(`${BASE}/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Cookie: cookiesFrom(dialog),
		},
		body: new URLSearchParams({ state: formState!, csrf_token: csrfToken! }).toString(),
	});
	expect(approve.status).toBe(302);
	const googleUrl = new URL(approve.headers.get("Location")!);

	return {
		clientId,
		verifier,
		dialog,
		googleUrl,
		googleState: googleUrl.searchParams.get("state")!,
		cookie: cookiesFrom(approve),
	};
}

async function finishCallback(login: Awaited<ReturnType<typeof startLogin>>) {
	return SELF.fetch(
		`${BASE}/callback?code=${encodeURIComponent(FAKE_GOOGLE_CODE)}&state=${login.googleState}`,
		{ redirect: "manual", headers: { Cookie: login.cookie } },
	);
}

async function exchangeCode(login: Awaited<ReturnType<typeof startLogin>>, code: string) {
	return SELF.fetch(`${BASE}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: login.clientId,
			redirect_uri: CLIENT_REDIRECT,
			code_verifier: login.verifier,
			resource: `${BASE}/mcp`,
		}).toString(),
	});
}

/** The JSON-RPC result from an /mcp response body (plain JSON or one SSE event). */
function jsonRpcResult(body: string): any {
	const json = body.startsWith("{")
		? body
		: body
				.split("\n")
				.find((line) => line.startsWith("data:"))
				?.slice("data:".length)
				.trim();
	const message = JSON.parse(json ?? "null");
	expect(message?.error).toBeUndefined();
	return message.result;
}

function allLogOutput(): string {
	return logSpies
		.flatMap((spy) => spy.mock.calls)
		.map((args) => args.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
		.join("\n");
}

/** Empties the owner's allowed-clients list, then allows exactly these URLs. */
async function setAllowed(...uris: string[]) {
	await env.AUDIT_DB.prepare("DELETE FROM allowed_redirect_uris").run();
	for (const uri of uris) {
		const normalized = normalizeRedirectUri(uri);
		if (!normalized.ok) throw new Error(`test setup: bad URL ${uri}`);
		await addAllowedRedirect(env, normalized.uri);
	}
}

/** Opens /authorize for a client with a fresh PKCE pair. */
async function openAuthorize(clientId: string, redirectUri = CLIENT_REDIRECT) {
	const { challenge } = await pkcePair();
	return SELF.fetch(
		`${BASE}/authorize?${new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: "client-state",
			resource: `${BASE}/mcp`,
		})}`,
		{ redirect: "manual" },
	);
}

const mcpInitialize = (accessToken: string) =>
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

beforeEach(async () => {
	// The sign-in tests below use CLIENT_REDIRECT, so it is on the owner's list.
	await setAllowed(CLIENT_REDIRECT);
	logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
		vi.spyOn(console, level),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("allowlist rules", () => {
	it("matches the owner email case-insensitively", () => {
		expect(isAllowedEmail("Owner@Example.COM", "owner@example.com")).toBe(true);
		expect(isAllowedEmail("owner@example.com", " Owner@Example.com ")).toBe(true);
	});

	it("rejects other, partial, and empty addresses", () => {
		expect(isAllowedEmail("other@example.com", "owner@example.com")).toBe(false);
		expect(isAllowedEmail("owner@example.com.evil.test", "owner@example.com")).toBe(false);
		expect(isAllowedEmail("xowner@example.com", "owner@example.com")).toBe(false);
		expect(isAllowedEmail("", "")).toBe(false);
		expect(isAllowedEmail("owner@example.com", "")).toBe(false);
		expect(isAllowedEmail(undefined, undefined)).toBe(false);
	});

	it("requires email_verified to be exactly true", () => {
		const allowed = "owner@example.com";
		expect(verifyOwner(OWNER_CLAIMS, allowed)).toEqual({
			sub: "owner-sub-1",
			email: "owner@example.com",
		});
		expect(verifyOwner({ ...OWNER_CLAIMS, email_verified: false }, allowed)).toBeNull();
		expect(verifyOwner({ ...OWNER_CLAIMS, email_verified: "true" }, allowed)).toBeNull();
		expect(verifyOwner({ sub: "s", email: "owner@example.com" }, allowed)).toBeNull();
		expect(verifyOwner({ email: "owner@example.com", email_verified: true }, allowed)).toBeNull();
		expect(verifyOwner(null, allowed)).toBeNull();
	});
});

describe("unauthenticated access", () => {
	it("rejects /mcp without a token: 401 + WWW-Authenticate", async () => {
		const res = await SELF.fetch(`${BASE}/mcp`, { method: "POST" });
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
	});

	it("rejects /mcp with a garbage token: 401", async () => {
		const res = await SELF.fetch(`${BASE}/mcp`, {
			method: "POST",
			headers: { Authorization: "Bearer not-a-real-token" },
		});
		expect(res.status).toBe(401);
	});

	it("returns 404 for unknown routes", async () => {
		for (const path of ["/definitely-not-a-route", "/debug", "/test", "/admin"]) {
			const res = await SELF.fetch(`${BASE}${path}`);
			expect(res.status, path).toBe(404);
		}
	});

	it("redirects GET / to /link with no data, and nothing else on /", async () => {
		const res = await SELF.fetch(`${BASE}/`, { redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/link");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.getSetCookie()).toHaveLength(0);
		expect(await res.text()).toBe("");
		// Query strings and a session cookie change nothing: it is a fixed redirect.
		const withQuery = await SELF.fetch(`${BASE}/?next=/audit`, {
			redirect: "manual",
			headers: { Cookie: "__Host-GOBRIDGE_SESSION=forged.value" },
		});
		expect(withQuery.status).toBe(302);
		expect(withQuery.headers.get("Location")).toBe("/link");
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			const other = await SELF.fetch(`${BASE}/`, { method, redirect: "manual" });
			expect(other.status, method).toBe(404);
			expect(other.headers.get("Location")).toBeNull();
		}
	});

	it("serves exactly the allowlisted routes without a session", async () => {
		// Unauthenticated routes allowed by CLAUDE.md, with what each must answer.
		const allowed: [string, number][] = [
			["/", 302],
			["/health", 200],
			["/signed-out", 200],
			["/static/app.css", 200],
			["/static/menu.js", 200],
			["/static/logo.svg", 200],
			["/static/logo-256.png", 200],
			["/static/logo-512.png", 200],
			["/favicon.ico", 200],
			["/favicon.png", 200],
			["/apple-touch-icon.png", 200],
			["/.well-known/oauth-authorization-server", 200],
			["/.well-known/oauth-protected-resource/mcp", 200],
			["/logout", 405],
		];
		for (const [path, status] of allowed) {
			const res = await SELF.fetch(`${BASE}${path}`, { redirect: "manual" });
			expect(res.status, path).toBe(status);
			expect(res.headers.getSetCookie(), path).toHaveLength(0);
			await res.body?.cancel();
		}
		// Owner pages never show content without a session: they go to Google sign-in.
		for (const path of ["/link", "/audit", "/clients", "/settings"]) {
			const res = await SELF.fetch(`${BASE}${path}`, { redirect: "manual" });
			expect(res.status, path).toBe(302);
			expect(new URL(res.headers.get("Location")!).hostname).toBe("accounts.google.com");
			expect(await res.text()).toBe("");
		}
		for (const path of [
			"/link/rename",
			"/link/unlink",
			"/clients/revoke",
			"/settings/allowed-clients",
			"/settings/allowed-clients/remove",
		]) {
			const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", redirect: "manual" });
			expect(res.status, path).toBe(403);
		}
	});

	it("serves a health check with no data", async () => {
		const res = await SELF.fetch(`${BASE}/health`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("publishes OAuth metadata for MCP clients", async () => {
		const as = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
		expect(as.status).toBe(200);
		const meta = (await as.json()) as Record<string, unknown>;
		expect(meta.registration_endpoint).toBe(`${BASE}/register`);
		expect(meta.code_challenge_methods_supported).toContain("S256");

		const pr = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
		expect(pr.status).toBe(200);
		expect(((await pr.json()) as Record<string, unknown>).resource).toBe(`${BASE}/mcp`);
	});
});

describe("owner login", () => {
	it("sends the owner to Google asking only for openid + email", async () => {
		const login = await startLogin();
		expect(login.googleUrl.origin + login.googleUrl.pathname).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(login.googleUrl.searchParams.get("scope")).toBe("openid email");
		expect(login.googleUrl.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
		expect(login.googleUrl.searchParams.get("access_type")).toBeNull();
	});

	it("sets security headers on the approval page", async () => {
		const { dialog } = await startLogin();
		expect(dialog.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(dialog.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
		expect(dialog.headers.get("X-Frame-Options")).toBe("DENY");
		expect(dialog.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	it("rejects the approval form without a valid CSRF token", async () => {
		const res = await SELF.fetch(`${BASE}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ state: btoa("{}"), csrf_token: "forged" }).toString(),
		});
		expect(res.status).toBe(400);
		expect(res.headers.get("Location")).toBeNull();
	});

	it("lets the owner in and issues access + refresh tokens", async () => {
		mockGoogle();
		const login = await startLogin();
		const callback = await finishCallback(login);
		expect(callback.status).toBe(302);

		const redirect = new URL(callback.headers.get("Location")!);
		expect(redirect.origin + redirect.pathname).toBe(CLIENT_REDIRECT);
		expect(redirect.searchParams.get("state")).toBe("client-state");
		const code = redirect.searchParams.get("code");
		expect(code).toBeTruthy();

		const tokenRes = await exchangeCode(login, code!);
		expect(tokenRes.status).toBe(200);
		const tokens = (await tokenRes.json()) as Record<string, string>;
		expect(tokens.access_token).toBeTruthy();
		expect(tokens.refresh_token).toBeTruthy();

		// The Google token never reaches the MCP client.
		const everythingSentToClient = callback.headers.get("Location")! + JSON.stringify(tokens);
		expect(everythingSentToClient).not.toContain(FAKE_GOOGLE_ACCESS_TOKEN);
		expect(everythingSentToClient).not.toContain("ya29.");

		// The GoBridge token is accepted at /mcp (anything but an auth failure).
		const mcp = await SELF.fetch(`${BASE}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokens.access_token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "test", version: "0" },
				},
			}),
		});
		expect(mcp.status).toBe(200);
		// The handshake names the server and advertises its icon as absolute
		// https URLs on this environment's own origin.
		const { serverInfo } = jsonRpcResult(await mcp.text()) as {
			serverInfo: { name: string; title?: string; websiteUrl?: string; icons?: { src: string; mimeType?: string; sizes?: string[] }[] };
		};
		expect(serverInfo.name).toBe("GoBridge");
		expect(serverInfo.title).toBe("GoBridge");
		expect(serverInfo.websiteUrl).toBe(BASE);
		expect(serverInfo.icons).toEqual([
			{ src: `${BASE}/static/logo.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
			{ src: `${BASE}/static/logo-256.png`, mimeType: "image/png", sizes: ["256x256"] },
			{ src: `${BASE}/static/logo-512.png`, mimeType: "image/png", sizes: ["512x512"] },
		]);
		for (const icon of serverInfo.icons!) {
			expect(icon.src.startsWith("https://")).toBe(true);
			const file = await SELF.fetch(icon.src);
			expect(file.status, icon.src).toBe(200);
			expect(file.headers.get("Content-Type")).toBe(icon.mimeType);
			await file.body?.cancel();
		}

		// Refresh tokens work.
		const refreshed = await SELF.fetch(`${BASE}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: tokens.refresh_token,
				client_id: login.clientId,
			}).toString(),
		});
		expect(refreshed.status).toBe(200);
		expect(((await refreshed.json()) as Record<string, string>).access_token).toBeTruthy();
	});

	it("accepts the owner email in a different letter case", async () => {
		mockGoogle({ claims: { ...OWNER_CLAIMS, email: "Owner@Example.com" } });
		const callback = await finishCallback(await startLogin());
		expect(callback.status).toBe(302);
	});

	it("rejects a non-allowed email and issues no grant", async () => {
		mockGoogle({ claims: { sub: "intruder", email: "intruder@example.com", email_verified: true } });
		const login = await startLogin();
		const callback = await finishCallback(login);
		expect(callback.status).toBe(403);
		expect(callback.headers.get("Location")).toBeNull();
		expect(callback.headers.get("X-Frame-Options")).toBe("DENY");
		expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
		const body = await callback.text();
		expect(body).toContain("not allowed");
		expect(body).not.toContain("intruder@example.com");

		// The same state cannot be replayed.
		const replay = await finishCallback(login);
		expect(replay.status).toBe(400);
		expect(replay.headers.get("Location")).toBeNull();
	});

	it("rejects the owner email when email_verified is false", async () => {
		mockGoogle({ claims: { ...OWNER_CLAIMS, email_verified: false } });
		const callback = await finishCallback(await startLogin());
		expect(callback.status).toBe(403);
		expect(callback.headers.get("Location")).toBeNull();
	});

	it("rejects the owner email when email_verified is missing or not a boolean", async () => {
		mockGoogle({ claims: { sub: "owner-sub-1", email: "owner@example.com" } });
		expect((await finishCallback(await startLogin())).status).toBe(403);
		vi.restoreAllMocks();
		mockGoogle({ claims: { ...OWNER_CLAIMS, email_verified: "true" } });
		expect((await finishCallback(await startLogin())).status).toBe(403);
	});

	it("rejects /callback with an unknown state", async () => {
		const fetchSpy = mockGoogle();
		const res = await SELF.fetch(`${BASE}/callback?code=x&state=not-a-real-state`, {
			redirect: "manual",
		});
		expect(res.status).toBe(400);
		expect(res.headers.get("Location")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects /callback when the state does not belong to this browser", async () => {
		const fetchSpy = mockGoogle();
		const victim = await startLogin();
		const attacker = await startLogin();
		// Attacker's state, victim's cookie.
		const res = await SELF.fetch(`${BASE}/callback?code=x&state=${attacker.googleState}`, {
			redirect: "manual",
			headers: { Cookie: victim.cookie },
		});
		expect(res.status).toBe(400);
		expect(res.headers.get("Location")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("fails closed when Google rejects the code, without leaking Google's response", async () => {
		mockGoogle({ tokenStatus: 400 });
		const callback = await finishCallback(await startLogin());
		expect(callback.status).toBe(502);
		expect(callback.headers.get("Location")).toBeNull();
		const body = await callback.text();
		expect(body).not.toContain("invalid_grant");
		expect(body).not.toContain("raw google detail");
	});

	it("never logs tokens, codes, cookies, or email addresses", async () => {
		mockGoogle();
		const ok = await startLogin();
		const okCallback = await finishCallback(ok);
		const code = new URL(okCallback.headers.get("Location")!).searchParams.get("code")!;
		const tokens = (await (await exchangeCode(ok, code)).json()) as Record<string, string>;

		vi.mocked(globalThis.fetch).mockRestore();
		mockGoogle({ claims: { sub: "intruder", email: "intruder@example.com", email_verified: true } });
		await finishCallback(await startLogin());
		vi.mocked(globalThis.fetch).mockRestore();
		mockGoogle({ tokenStatus: 400 });
		await finishCallback(await startLogin());

		const logs = allLogOutput();
		for (const secret of [
			"ya29.",
			"1//",
			"Bearer ",
			FAKE_GOOGLE_CODE,
			code,
			tokens.access_token,
			tokens.refresh_token,
			ok.googleState,
			"owner@example.com",
			"intruder@example.com",
			"raw google detail",
			"test-google-client-secret",
		]) {
			expect(logs, `log output must not contain ${secret.slice(0, 6)}…`).not.toContain(secret);
		}
		// The denials themselves are logged, by category only.
		expect(logs).toContain("not_allowed");
		expect(logs).toContain("google_exchange_failed");
	});
});

describe("review hardening", () => {
	it("requires PKCE with S256 at /authorize", async () => {
		const clientId = await registerClient();
		const base = {
			response_type: "code",
			client_id: clientId,
			redirect_uri: CLIENT_REDIRECT,
			state: "client-state",
			resource: `${BASE}/mcp`,
		};
		const { challenge } = await pkcePair();
		const attempts: Record<string, string>[] = [
			base,
			{ ...base, code_challenge: challenge, code_challenge_method: "plain" },
		];
		for (const params of attempts) {
			const res = await SELF.fetch(`${BASE}/authorize?${new URLSearchParams(params)}`, {
				redirect: "manual",
			});
			expect(res.status).toBe(400);
			expect(res.headers.get("Location")).toBeNull();
			await res.body?.cancel();
		}
		// An unknown client or an unregistered redirect URI is a clean 400 too.
		const pkce = { code_challenge: challenge, code_challenge_method: "S256" };
		for (const params of [
			{ ...base, ...pkce, client_id: "no-such-client" },
			{ ...base, ...pkce, redirect_uri: "https://attacker.example/cb" },
		]) {
			const res = await SELF.fetch(`${BASE}/authorize?${new URLSearchParams(params)}`, {
				redirect: "manual",
			});
			expect(res.status).toBe(400);
			await res.body?.cancel();
		}
		const ok = await SELF.fetch(
			`${BASE}/authorize?${new URLSearchParams({ ...base, code_challenge: challenge, code_challenge_method: "S256" })}`,
		);
		expect(ok.status).toBe(200);
		await ok.body?.cancel();
	});

	it("logs OAuth errors as status + code only", async () => {
		const res = await SELF.fetch(`${BASE}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: "secret-looking-code-value",
				client_id: "no-such-client",
				code_verifier: "secret-looking-verifier",
			}).toString(),
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
		await res.body?.cancel();
		const logs = allLogOutput();
		expect(logs).toMatch(/oauth error: status=\d+ code=[a-z_]+/);
		expect(logs).not.toContain("OAuth error response");
		expect(logs).not.toContain("secret-looking");
		expect(logs).not.toContain("no-such-client");
	});
});

describe("allowed AI clients", () => {
	it("normalizes redirect URLs and refuses anything but https or loopback http", () => {
		expect(normalizeRedirectUri(" https://Claude.AI/api/mcp/auth_callback ")).toEqual({
			ok: true,
			uri: "https://claude.ai/api/mcp/auth_callback",
		});
		expect(normalizeRedirectUri("http://localhost:3118/callback")).toEqual({
			ok: true,
			uri: "http://localhost/callback",
		});
		expect(normalizeRedirectUri("http://127.0.0.1:55555/callback")).toEqual({
			ok: true,
			uri: "http://127.0.0.1/callback",
		});
		for (const bad of [
			"",
			"   ",
			"not a url",
			"http://client.example/callback",
			"https://*.claude.ai/callback",
			"https://claude.ai/cb#frag",
			"https://user:pass@claude.ai/cb",
			"javascript:alert(1)",
			"data:text/html,hi",
			"cursor://anysphere.cursor-mcp/oauth/callback",
			`https://claude.ai/${"a".repeat(600)}`,
			42,
			null,
		]) {
			expect(normalizeRedirectUri(bad).ok, String(bad)).toBe(false);
		}
	});

	it("matches exactly, except that loopback URLs match on any port", () => {
		const allowed = ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback"];
		expect(isRedirectAllowed("https://claude.ai/api/mcp/auth_callback", allowed)).toBe(true);
		expect(isRedirectAllowed("http://localhost:3118/callback", allowed)).toBe(true);
		expect(isRedirectAllowed("http://localhost/callback", allowed)).toBe(true);
		for (const other of [
			"https://claude.ai/api/mcp/auth_callback/",
			"https://claude.ai/api/mcp/auth_callback?next=https://evil.example",
			"https://claude.ai/other",
			"https://evil.claude.ai/api/mcp/auth_callback",
			"http://claude.ai/api/mcp/auth_callback",
			"http://localhost:3118/other",
			"http://127.0.0.1:3118/callback",
		]) {
			expect(isRedirectAllowed(other, allowed), other).toBe(false);
		}
	});

	it("refuses a client whose redirect URL is not listed, before any approval or Google sign-in", async () => {
		const fetchSpy = mockGoogle();
		await setAllowed();
		const clientId = await registerClient();
		const res = await openAuthorize(clientId);
		expect(res.status).toBe(403);
		expect(res.headers.get("Location")).toBeNull();
		expect(res.headers.getSetCookie()).toHaveLength(0);
		expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
		const html = await res.text();
		expect(html).toContain("This app is not allowed to connect");
		expect(html).toContain(`<code>${CLIENT_REDIRECT}</code>`);
		expect(html).toContain('href="/settings"');
		expect(html).toContain("If you did not start this connection");
		// No approval form, nothing that could continue the flow.
		expect(html).not.toContain("<form");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(allLogOutput()).toContain("GET /authorize denied: client_not_allowed");
	});

	it("requires every redirect URL a client registered to be listed", async () => {
		const extra = "https://attacker.example/cb";
		const clientId = await registerClient("Claude", [CLIENT_REDIRECT, extra]);
		const res = await openAuthorize(clientId);
		expect(res.status).toBe(403);
		const html = await res.text();
		expect(html).toContain(`<code>${extra}</code>`);
		expect(html).not.toContain(`<code>${CLIENT_REDIRECT}</code>`);

		await addAllowedRedirect(env, extra);
		const allowed = await openAuthorize(clientId);
		expect(allowed.status).toBe(200);
		await allowed.body?.cancel();
	});

	it("escapes hostile redirect URLs on the refusal page", async () => {
		await setAllowed();
		const clientId = await registerClient("Evil", ["https://evil.example/cb?x=<script>alert(1)</script>&y=\"'"]);
		const res = await openAuthorize(
			clientId,
			"https://evil.example/cb?x=<script>alert(1)</script>&y=\"'",
		);
		const html = await res.text();
		expect(html).not.toContain("<script>alert");
		expect(html).not.toMatch(/<code>[^<]*["'][^<]*<\/code>/);
	});

	it("lets a loopback client in on any port when its loopback URL is listed", async () => {
		await setAllowed("http://localhost/callback");
		const clientId = await registerClient("Claude Code", ["http://localhost:3118/callback"]);
		const res = await openAuthorize(clientId, "http://localhost:3118/callback");
		expect(res.status).toBe(200);
		await res.body?.cancel();
	});

	it("refuses the approval form if the URL was removed after the dialog opened", async () => {
		mockGoogle();
		const clientId = await registerClient();
		const dialog = await openAuthorize(clientId);
		expect(dialog.status).toBe(200);
		const html = await dialog.text();
		await setAllowed();
		const approve = await SELF.fetch(`${BASE}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesFrom(dialog) },
			body: new URLSearchParams({
				state: html.match(/name="state" value="([^"]+)"/)![1],
				csrf_token: html.match(/name="csrf_token" value="([^"]+)"/)![1],
			}).toString(),
		});
		expect(approve.status).toBe(403);
		expect(approve.headers.get("Location")).toBeNull();
	});

	it("refuses /callback, without signing in to Google or issuing a grant, if the URL was removed mid-flow", async () => {
		const fetchSpy = mockGoogle();
		const login = await startLogin();
		await setAllowed();
		const callback = await finishCallback(login);
		expect(callback.status).toBe(403);
		expect(callback.headers.get("Location")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
		// The one-time session binding cookie is still cleared.
		expect(callback.headers.getSetCookie().join(";")).toContain("__Host-CONSENTED_STATE=;");
	});

	it("cuts off /mcp the moment the client's URL is removed, and restores it when re-added", async () => {
		mockGoogle();
		const login = await startLogin();
		const code = new URL((await finishCallback(login)).headers.get("Location")!).searchParams.get("code")!;
		const tokens = (await (await exchangeCode(login, code)).json()) as Record<string, string>;

		const before = await mcpInitialize(tokens.access_token);
		expect(before.status).toBe(200);
		await before.body?.cancel();

		expect(await removeAllowedRedirect(env, CLIENT_REDIRECT)).toBe(true);
		const after = await mcpInitialize(tokens.access_token);
		expect(after.status).toBe(403);
		expect(await after.text()).toContain("not on GoBridge's allowed list");
		expect(allLogOutput()).toContain("/mcp denied: client_not_allowed");

		await addAllowedRedirect(env, CLIENT_REDIRECT);
		const restored = await mcpInitialize(tokens.access_token);
		expect(restored.status).toBe(200);
		await restored.body?.cancel();
	});

	it("fails closed when the list cannot be read", async () => {
		const broken = {
			...env,
			AUDIT_DB: {
				prepare() {
					throw new Error("D1 unavailable");
				},
			},
		} as unknown as Env;
		expect(await checkClient(broken, { redirectUris: [CLIENT_REDIRECT] })).toEqual({
			ok: false,
			reason: "list_unavailable",
		});
		expect(await checkClient(env, null)).toEqual({ ok: false, reason: "unknown_client" });
		expect(await checkClient(env, { redirectUris: [CLIENT_REDIRECT] }, "https://other.example/cb")).toEqual({
			ok: false,
			reason: "unknown_client",
		});
		expect(await checkClient(env, { redirectUris: [CLIENT_REDIRECT] })).toEqual({ ok: true });
	});

	it("caps the list and ignores duplicates", async () => {
		await setAllowed();
		for (let i = 0; i < 20; i++) {
			expect(await addAllowedRedirect(env, `https://app${i}.example/cb`)).toBe("added");
		}
		expect(await addAllowedRedirect(env, "https://app0.example/cb")).toBe("exists");
		expect(await addAllowedRedirect(env, "https://app20.example/cb")).toBe("full");
		expect(await listAllowedRedirects(env)).toHaveLength(20);
	});
});
