import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRefreshToken } from "../src/accounts";
import { decryptSecret, encryptSecret, sha256Base64Url } from "../src/crypto";
import { grantedScopesMatch, LINK_SCOPES } from "../src/google";

const BASE = "https://gobridge.test";
// Shaped like real Google tokens so leak checks are meaningful.
const LOGIN_ACCESS_TOKEN = "ya29.fake-login-access-token";
const LINK_ACCESS_TOKEN = "ya29.fake-link-access-token";
const FAKE_REFRESH_TOKEN = "1//fake-google-refresh-token";

const ALLOWED_SCOPES = [
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/calendar.events",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	"https://www.googleapis.com/auth/calendar.freebusy",
	"https://www.googleapis.com/auth/drive",
	"openid",
	"email",
];
// How Google reports a full grant: `email` comes back under its long name.
const GOOGLE_FULL_GRANT = [
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/calendar.events",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	"https://www.googleapis.com/auth/calendar.freebusy",
	"https://www.googleapis.com/auth/drive",
	"openid",
	"https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const OWNER_CLAIMS = { sub: "owner-sub-1", email: "owner@example.com", email_verified: true };

type GoogleOptions = {
	ownerClaims?: Record<string, unknown>;
	linkedClaims?: Record<string, unknown>;
	grantedScope?: string;
	refreshToken?: string | null;
	revokeStatus?: number;
};

type GoogleCalls = {
	tokenBodies: URLSearchParams[];
	revoked: string[];
};

let counter = 0;
let logSpies: ReturnType<typeof vi.spyOn>[] = [];

/** A unique alias + Google account per test, since KV is shared within the file. */
function fresh() {
	counter += 1;
	return {
		alias: `acct-${counter}`,
		claims: { sub: `linked-sub-${counter}`, email: `linked${counter}@example.com`, email_verified: true },
	};
}

/** Replaces outbound fetch with a fake Google. Any other outbound call fails the test. */
function mockGoogle(options: GoogleOptions = {}): GoogleCalls {
	const calls: GoogleCalls = { revoked: [], tokenBodies: [] };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input as RequestInfo, init);
		if (request.url === "https://oauth2.googleapis.com/token") {
			const body = new URLSearchParams(
				[...(await request.formData()).entries()] as [string, string][],
			);
			calls.tokenBodies.push(body);
			if (body.get("redirect_uri") === `${BASE}/link/callback`) {
				const refreshToken =
					options.refreshToken === undefined ? FAKE_REFRESH_TOKEN : options.refreshToken;
				return Response.json({
					access_token: LINK_ACCESS_TOKEN,
					expires_in: 3600,
					scope: options.grantedScope ?? GOOGLE_FULL_GRANT,
					...(refreshToken ? { refresh_token: refreshToken } : {}),
				});
			}
			return Response.json({ access_token: LOGIN_ACCESS_TOKEN, expires_in: 3600 });
		}
		if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
			const isLink = request.headers.get("Authorization") === `Bearer ${LINK_ACCESS_TOKEN}`;
			return Response.json(
				isLink ? (options.linkedClaims ?? {}) : (options.ownerClaims ?? OWNER_CLAIMS),
			);
		}
		if (request.url === "https://oauth2.googleapis.com/revoke") {
			calls.revoked.push(String((await request.formData()).get("token") ?? ""));
			return new Response(null, { status: options.revokeStatus ?? 200 });
		}
		throw new Error(`Unexpected outbound fetch in test: ${new URL(request.url).origin}`);
	});
	return calls;
}

function cookiesFrom(res: Response): string {
	return res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.filter((c) => !c.endsWith("="))
		.join("; ");
}

/** Signs in through /link -> Google -> /callback. Returns the /callback response. */
async function ownerLogin() {
	const start = await SELF.fetch(`${BASE}/link`, { redirect: "manual" });
	expect(start.status).toBe(302);
	const google = new URL(start.headers.get("Location")!);
	const callback = await SELF.fetch(
		`${BASE}/callback?code=fake-login-code&state=${google.searchParams.get("state")}`,
		{ redirect: "manual", headers: { Cookie: cookiesFrom(start) } },
	);
	return { callback, google, start };
}

/** Returns an owner session cookie and its CSRF token. Needs mockGoogle() first. */
async function ownerSession() {
	const { callback } = await ownerLogin();
	expect(callback.status).toBe(302);
	expect(callback.headers.get("Location")).toBe("/link");
	const cookie = cookiesFrom(callback);
	expect(cookie).toContain("__Host-GOBRIDGE_SESSION=");

	const page = await SELF.fetch(`${BASE}/link`, { headers: { Cookie: cookie } });
	expect(page.status).toBe(200);
	const csrf = (await page.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
	expect(csrf).toBeTruthy();
	return { cookie, csrf: csrf! };
}

function post(path: string, cookie: string | null, fields: Record<string, string>) {
	return SELF.fetch(`${BASE}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...(cookie ? { Cookie: cookie } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
}

/** POST /link, returning the Google consent URL the owner is sent to. */
async function startLink(session: { cookie: string; csrf: string }, alias: string) {
	const res = await post("/link", session.cookie, { alias, csrf_token: session.csrf });
	expect(res.status).toBe(303);
	return new URL(res.headers.get("Location")!);
}

function linkCallback(cookie: string | null, state: string, extra = "code=fake-link-code") {
	return SELF.fetch(`${BASE}/link/callback?${extra}&state=${encodeURIComponent(state)}`, {
		redirect: "manual",
		headers: cookie ? { Cookie: cookie } : {},
	});
}

async function linkAccount(session: { cookie: string; csrf: string }, alias: string) {
	const consent = await startLink(session, alias);
	const res = await linkCallback(session.cookie, consent.searchParams.get("state")!);
	return { consent, res };
}

const stored = (alias: string) => env.GOOGLE_TOKENS.get(`account:${alias}`);

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

describe("token encryption", () => {
	const key = env.TOKEN_ENCRYPTION_KEY;

	it("round-trips a token", async () => {
		const encrypted = await encryptSecret(FAKE_REFRESH_TOKEN, key, "personal");
		expect(JSON.stringify(encrypted)).not.toContain(FAKE_REFRESH_TOKEN);
		expect(await decryptSecret(encrypted, key, "personal")).toBe(FAKE_REFRESH_TOKEN);
	});

	it("uses a fresh random IV for every record", async () => {
		const a = await encryptSecret(FAKE_REFRESH_TOKEN, key, "personal");
		const b = await encryptSecret(FAKE_REFRESH_TOKEN, key, "personal");
		expect(a.iv).not.toBe(b.iv);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it("refuses to decrypt under another alias, another key, or after tampering", async () => {
		const encrypted = await encryptSecret(FAKE_REFRESH_TOKEN, key, "personal");
		await expect(decryptSecret(encrypted, key, "work")).rejects.toThrow();
		await expect(decryptSecret(encrypted, "f".repeat(64), "personal")).rejects.toThrow();
		const flipped = encrypted.ciphertext.startsWith("A") ? "B" : "A";
		await expect(
			decryptSecret(
				{ ...encrypted, ciphertext: flipped + encrypted.ciphertext.slice(1) },
				key,
				"personal",
			),
		).rejects.toThrow();
	});

	it("rejects a key that is not 256 bits of hex", async () => {
		await expect(encryptSecret("x", "too-short", "personal")).rejects.toThrow();
		await expect(encryptSecret("x", "z".repeat(64), "personal")).rejects.toThrow();
	});
});

describe("link scopes", () => {
	it("are exactly the allowed list", () => {
		expect([...LINK_SCOPES]).toEqual(ALLOWED_SCOPES);
	});

	it("never include forbidden scopes", () => {
		for (const scope of LINK_SCOPES) {
			expect(scope).not.toBe("https://mail.google.com/");
			expect(scope).not.toContain("gmail.settings");
			expect(scope).not.toBe("https://www.googleapis.com/auth/calendar");
			expect(scope).not.toContain("drive.readonly");
		}
	});

	it("accept only an exact grant", () => {
		expect(grantedScopesMatch(GOOGLE_FULL_GRANT)).toBe(true);
		expect(grantedScopesMatch(ALLOWED_SCOPES.join(" "))).toBe(true);
		expect(grantedScopesMatch(ALLOWED_SCOPES.slice(1).join(" "))).toBe(false);
		expect(grantedScopesMatch(`${GOOGLE_FULL_GRANT} https://mail.google.com/`)).toBe(false);
		expect(grantedScopesMatch("")).toBe(false);
		expect(grantedScopesMatch(undefined)).toBe(false);
	});
});

describe("owner session", () => {
	it("denies /link without a session: no content, straight to owner sign-in", async () => {
		const res = await SELF.fetch(`${BASE}/link`, { redirect: "manual" });
		expect(res.status).toBe(302);
		const google = new URL(res.headers.get("Location")!);
		expect(google.origin).toBe("https://accounts.google.com");
		expect(google.searchParams.get("scope")).toBe("openid email");
		expect(google.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
		expect(await res.text()).toBe("");
	});

	it("denies every other link route without a session", async () => {
		const fetchSpy = mockGoogle();
		expect((await post("/link", null, { alias: "x", csrf_token: "x" })).status).toBe(403);
		expect((await post("/link/unlink", null, { alias: "x", csrf_token: "x" })).status).toBe(403);
		expect((await linkCallback(null, "some-state")).status).toBe(403);
		expect(fetchSpy.tokenBodies).toHaveLength(0);
	});

	it("gives a session to the owner only", async () => {
		mockGoogle({ ownerClaims: { sub: "intruder", email: "intruder@example.com", email_verified: true } });
		const intruder = await ownerLogin();
		expect(intruder.callback.status).toBe(403);
		expect(cookiesFrom(intruder.callback)).not.toContain("__Host-GOBRIDGE_SESSION");

		vi.restoreAllMocks();
		mockGoogle({ ownerClaims: { ...OWNER_CLAIMS, email_verified: false } });
		const unverified = await ownerLogin();
		expect(unverified.callback.status).toBe(403);
		expect(cookiesFrom(unverified.callback)).not.toContain("__Host-GOBRIDGE_SESSION");
	});

	it("rejects an owner-login state from another browser, and replays", async () => {
		mockGoogle();
		const a = await ownerLogin();
		expect(a.callback.status).toBe(302);
		const b = await SELF.fetch(`${BASE}/link`, { redirect: "manual" });
		const stateB = new URL(b.headers.get("Location")!).searchParams.get("state");

		// B's state with no cookie, then with A's (already used) cookie.
		const noCookie = await SELF.fetch(`${BASE}/callback?code=x&state=${stateB}`, { redirect: "manual" });
		expect(noCookie.status).toBe(400);
		const wrongCookie = await SELF.fetch(`${BASE}/callback?code=x&state=${stateB}`, {
			redirect: "manual",
			headers: { Cookie: cookiesFrom(a.start) },
		});
		expect(wrongCookie.status).toBe(400);
		expect(cookiesFrom(wrongCookie)).not.toContain("__Host-GOBRIDGE_SESSION");

		// A's state cannot be used twice.
		const replay = await SELF.fetch(
			`${BASE}/callback?code=x&state=${a.google.searchParams.get("state")}`,
			{ redirect: "manual", headers: { Cookie: cookiesFrom(a.start) } },
		);
		expect(replay.status).toBe(400);
	});

	it("treats a forged or tampered session cookie as no session", async () => {
		mockGoogle();
		const { cookie } = await ownerSession();
		const value = cookie.split("__Host-GOBRIDGE_SESSION=")[1];
		const tampered = value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA");
		for (const forged of [tampered, "abc.def", btoa('{"email":"owner@example.com"}')]) {
			const res = await SELF.fetch(`${BASE}/link`, {
				redirect: "manual",
				headers: { Cookie: `__Host-GOBRIDGE_SESSION=${forged}` },
			});
			expect(res.status).toBe(302);
		}
	});

	it("sets security headers and cookie flags on the link page", async () => {
		mockGoogle();
		const { callback } = await ownerLogin();
		const sessionCookie = callback.headers
			.getSetCookie()
			.find((c) => c.startsWith("__Host-GOBRIDGE_SESSION="))!;
		expect(sessionCookie).toContain("HttpOnly");
		expect(sessionCookie).toContain("Secure");
		expect(sessionCookie).toContain("SameSite=Lax");

		const page = await SELF.fetch(`${BASE}/link`, { headers: { Cookie: cookiesFrom(callback) } });
		expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(page.headers.get("X-Frame-Options")).toBe("DENY");
		expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(page.headers.get("Cache-Control")).toBe("no-store");
	});
});

describe("CSRF on state-changing actions", () => {
	it("rejects POST /link without or with a wrong CSRF token", async () => {
		mockGoogle();
		const session = await ownerSession();
		expect((await post("/link", session.cookie, { alias: "personal" })).status).toBe(403);
		expect(
			(await post("/link", session.cookie, { alias: "personal", csrf_token: "forged" })).status,
		).toBe(403);
	});

	it("rejects POST /link/unlink without a CSRF token and keeps the account", async () => {
		const { alias, claims } = fresh();
		const calls = mockGoogle({ linkedClaims: claims });
		const session = await ownerSession();
		expect((await linkAccount(session, alias)).res.status).toBe(303);

		expect((await post("/link/unlink", session.cookie, { alias })).status).toBe(403);
		expect(
			(await post("/link/unlink", session.cookie, { alias, csrf_token: "forged" })).status,
		).toBe(403);
		expect(await stored(alias)).not.toBeNull();
		expect(calls.revoked).toHaveLength(0);
	});

	it("does not change state on GET", async () => {
		mockGoogle();
		const session = await ownerSession();
		const res = await SELF.fetch(`${BASE}/link/unlink?alias=personal`, {
			redirect: "manual",
			headers: { Cookie: session.cookie },
		});
		expect(res.status).toBe(404);
	});
});

describe("linking an account", () => {
	it("asks Google for exactly the allowed scopes, offline, with state + PKCE", async () => {
		mockGoogle();
		const session = await ownerSession();
		const consent = await startLink(session, fresh().alias);

		expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(consent.searchParams.get("scope")!.split(" ")).toEqual(ALLOWED_SCOPES);
		expect(consent.searchParams.get("access_type")).toBe("offline");
		expect(consent.searchParams.get("prompt")).toBe("consent");
		expect(consent.searchParams.get("redirect_uri")).toBe(`${BASE}/link/callback`);
		expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
		expect(consent.searchParams.get("code_challenge")).toBeTruthy();
		expect(consent.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
		expect(consent.searchParams.get("include_granted_scopes")).toBeNull();
	});

	it("stores the account with an encrypted refresh token", async () => {
		const { alias, claims } = fresh();
		const calls = mockGoogle({ linkedClaims: claims });
		const session = await ownerSession();
		const { consent, res } = await linkAccount(session, alias);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/link?msg=linked");

		// PKCE: the verifier sent to Google matches the challenge in the consent URL.
		const linkExchange = calls.tokenBodies.find((b) => b.get("redirect_uri")?.endsWith("/link/callback"))!;
		expect(await sha256Base64Url(linkExchange.get("code_verifier")!)).toBe(
			consent.searchParams.get("code_challenge"),
		);

		// The stored KV value has no plaintext token.
		const raw = (await stored(alias))!;
		expect(raw).not.toContain(FAKE_REFRESH_TOKEN);
		expect(raw).not.toContain("1//");
		expect(raw).not.toContain("ya29.");
		const record = JSON.parse(raw);
		expect(record.email).toBe(claims.email);
		expect(record.scopes).toEqual(ALLOWED_SCOPES);
		expect(record.iv).toBeTruthy();
		expect(record.ciphertext).toBeTruthy();

		// ...and decrypts back to the real token, server-side only.
		expect(await getRefreshToken(env, alias)).toBe(FAKE_REFRESH_TOKEN);

		// The page shows alias + email, never token material.
		const page = await (await SELF.fetch(`${BASE}/link`, { headers: { Cookie: session.cookie } })).text();
		expect(page).toContain(alias);
		expect(page).toContain(claims.email);
		expect(page).not.toContain(FAKE_REFRESH_TOKEN);
		expect(page).not.toContain(record.ciphertext);
	});

	it("rejects invalid aliases", async () => {
		mockGoogle();
		const session = await ownerSession();
		for (const alias of ["", "Personal", "my alias", "-lead", "trail-", "a_b", "x".repeat(33), "../x"]) {
			const res = await post("/link", session.cookie, { alias, csrf_token: session.csrf });
			expect(res.status, alias).toBe(400);
			expect(res.headers.get("Location")).toBeNull();
		}
	});

	it("rejects /link/callback with a mismatched, foreign, or replayed state", async () => {
		const { alias, claims } = fresh();
		const calls = mockGoogle({ linkedClaims: claims });
		const session = await ownerSession();
		const consent = await startLink(session, alias);
		const state = consent.searchParams.get("state")!;

		// A state we never issued.
		expect((await linkCallback(session.cookie, "not-the-state-we-issued")).status).toBe(400);
		expect((await linkCallback(session.cookie, "")).status).toBe(400);

		// A real state, but presented by a different owner session.
		const otherSession = await ownerSession();
		expect((await linkCallback(otherSession.cookie, state)).status).toBe(400);

		expect(await stored(alias)).toBeNull();
		expect(calls.tokenBodies.filter((b) => b.get("redirect_uri")?.endsWith("/link/callback"))).toHaveLength(0);

		// The right session works once, then the state is dead.
		expect((await linkCallback(session.cookie, state)).status).toBe(303);
		expect((await linkCallback(session.cookie, state)).status).toBe(400);
	});

	it("saves nothing when the owner cancels at Google", async () => {
		const { alias } = fresh();
		mockGoogle();
		const session = await ownerSession();
		const consent = await startLink(session, alias);
		const res = await linkCallback(session.cookie, consent.searchParams.get("state")!, "error=access_denied");
		expect(res.status).toBe(400);
		expect(await stored(alias)).toBeNull();
	});

	it("rejects a partial grant, saves nothing, and revokes the token", async () => {
		const { alias, claims } = fresh();
		const partial = GOOGLE_FULL_GRANT.replace("https://www.googleapis.com/auth/gmail.send ", "");
		const calls = mockGoogle({ grantedScope: partial, linkedClaims: claims });
		const session = await ownerSession();
		const { res } = await linkAccount(session, alias);
		expect(res.status).toBe(400);
		expect(await stored(alias)).toBeNull();
		expect(calls.revoked).toEqual([FAKE_REFRESH_TOKEN]);
	});

	it("rejects a grant with extra scopes", async () => {
		const { alias, claims } = fresh();
		const calls = mockGoogle({
			grantedScope: `${GOOGLE_FULL_GRANT} https://mail.google.com/`,
			linkedClaims: claims,
		});
		const session = await ownerSession();
		expect((await linkAccount(session, alias)).res.status).toBe(400);
		expect(await stored(alias)).toBeNull();
		expect(calls.revoked).toEqual([FAKE_REFRESH_TOKEN]);
	});

	it("saves nothing when Google returns no refresh token", async () => {
		const { alias, claims } = fresh();
		mockGoogle({ linkedClaims: claims, refreshToken: null });
		const session = await ownerSession();
		expect((await linkAccount(session, alias)).res.status).toBe(502);
		expect(await stored(alias)).toBeNull();
	});

	it("will not put one Google account under two aliases, or reuse an alias for another account", async () => {
		const first = fresh();
		const second = fresh();
		mockGoogle({ linkedClaims: first.claims });
		const session = await ownerSession();
		expect((await linkAccount(session, first.alias)).res.status).toBe(303);

		// Same Google account, new alias: refused, and the existing grant is NOT revoked.
		vi.mocked(globalThis.fetch).mockRestore();
		let calls = mockGoogle({ linkedClaims: first.claims });
		expect((await linkAccount(session, second.alias)).res.status).toBe(400);
		expect(await stored(second.alias)).toBeNull();
		expect(calls.revoked).toHaveLength(0);

		// Different Google account, existing alias: refused, existing record untouched.
		const before = await stored(first.alias);
		vi.mocked(globalThis.fetch).mockRestore();
		calls = mockGoogle({ linkedClaims: second.claims });
		expect((await linkAccount(session, first.alias)).res.status).toBe(400);
		expect(await stored(first.alias)).toBe(before);

		// Same account, same alias: a re-link replaces the record.
		vi.mocked(globalThis.fetch).mockRestore();
		mockGoogle({ linkedClaims: first.claims, refreshToken: "1//fake-replacement-refresh-token" });
		expect((await linkAccount(session, first.alias)).res.status).toBe(303);
		expect(await getRefreshToken(env, first.alias)).toBe("1//fake-replacement-refresh-token");
	});
});

describe("unlinking an account", () => {
	it("revokes the token at Google and deletes the record", async () => {
		const { alias, claims } = fresh();
		const calls = mockGoogle({ linkedClaims: claims });
		const session = await ownerSession();
		expect((await linkAccount(session, alias)).res.status).toBe(303);

		const res = await post("/link/unlink", session.cookie, { alias, csrf_token: session.csrf });
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/link?msg=unlinked");
		expect(calls.revoked).toEqual([FAKE_REFRESH_TOKEN]);
		expect(await stored(alias)).toBeNull();

		const page = await (await SELF.fetch(`${BASE}/link`, { headers: { Cookie: session.cookie } })).text();
		expect(page).not.toContain(claims.email);
	});

	it("still deletes the record when Google does not confirm, and says so", async () => {
		const { alias, claims } = fresh();
		mockGoogle({ linkedClaims: claims, revokeStatus: 400 });
		const session = await ownerSession();
		expect((await linkAccount(session, alias)).res.status).toBe(303);

		const res = await post("/link/unlink", session.cookie, { alias, csrf_token: session.csrf });
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/link?msg=unlinked_not_revoked");
		expect(await stored(alias)).toBeNull();
	});

	it("returns a clear error for an unknown alias", async () => {
		const calls = mockGoogle();
		const session = await ownerSession();
		const res = await post("/link/unlink", session.cookie, {
			alias: "never-linked",
			csrf_token: session.csrf,
		});
		expect(res.status).toBe(404);
		expect(calls.revoked).toHaveLength(0);
	});
});

describe("logging", () => {
	it("never logs tokens, codes, cookies, or email addresses during link + unlink", async () => {
		const ok = fresh();
		const bad = fresh();
		mockGoogle({ linkedClaims: ok.claims });
		const session = await ownerSession();
		const { consent } = await linkAccount(session, ok.alias);
		await post("/link/unlink", session.cookie, { alias: ok.alias, csrf_token: session.csrf });
		await post("/link", session.cookie, { alias: "x", csrf_token: "forged" });
		await linkCallback(session.cookie, "not-the-state-we-issued");

		vi.mocked(globalThis.fetch).mockRestore();
		mockGoogle({ grantedScope: "openid", linkedClaims: bad.claims });
		await linkAccount(session, bad.alias);

		const logs = allLogOutput();
		for (const secret of [
			"ya29.",
			"1//",
			"Bearer ",
			"fake-link-code",
			"fake-login-code",
			consent.searchParams.get("state")!,
			session.csrf,
			session.cookie.split("=")[1],
			"@example.com",
			"test-google-client-secret",
			env.TOKEN_ENCRYPTION_KEY,
		]) {
			expect(logs, `log output must not contain ${secret.slice(0, 6)}…`).not.toContain(secret);
		}
		// Outcomes are logged by route, alias and category only.
		expect(logs).toContain(`linked alias=${ok.alias}`);
		expect(logs).toContain(`unlinked alias=${ok.alias}`);
		expect(logs).toContain("bad_csrf");
		expect(logs).toContain("bad_state");
		expect(logs).toContain("scope_mismatch");
	});
});
