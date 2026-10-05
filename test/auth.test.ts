import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function registerClient(name = "Test Client") {
	const res = await SELF.fetch(`${BASE}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: name,
			redirect_uris: [CLIENT_REDIRECT],
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

function allLogOutput(): string {
	return logSpies
		.flatMap((spy) => spy.mock.calls)
		.map((args) => args.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
		.join("\n");
}

beforeEach(() => {
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
		await mcp.body?.cancel();

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
