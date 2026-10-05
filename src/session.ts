/**
 * Owner browser session for the owner-only pages (/link, later /audit and /clients).
 *
 * The session lives in an encrypted + authenticated cookie, backed by a record
 * in OAUTH_KV that sign-out deletes. It is created only after the same Google
 * login + allowlist check that protects MCP grants, and it is re-checked against
 * ALLOWED_EMAIL and that record on every request.
 */
import { isAllowedEmail, verifyOwner } from "./auth";
import { randomToken, safeEqual, seal, sha256Base64Url, unseal } from "./crypto";
import { renderMessagePage } from "./html";
import { fetchGoogleIdentityClaims, getUpstreamAuthorizeUrl, OWNER_LOGIN_SCOPES } from "./utils";

const SESSION_COOKIE = "__Host-GOBRIDGE_SESSION";
const LOGIN_STATE_COOKIE = "__Host-GOBRIDGE_LOGIN_STATE";
const SESSION_PURPOSE = "owner-session";
/** Maximum lifetime of an owner session: 2 hours, then the owner signs in again. */
export const SESSION_TTL_SECONDS = 2 * 60 * 60;
const LOGIN_STATE_TTL_SECONDS = 600;

/** Prefix that tells /callback a state belongs to an owner-page login, not an MCP grant. */
export const OWNER_LOGIN_STATE_PREFIX = "owner-";

/** Owner pages a login may return to. Never redirect anywhere else. */
const OWNER_PAGES = ["/link", "/audit", "/clients", "/settings"] as const;
type OwnerPage = (typeof OWNER_PAGES)[number];

export type OwnerSession = {
	/** Id of the server-side session record; signing out deletes that record. */
	sid: string;
	email: string;
	sub: string;
	/** Per-session CSRF token; must accompany every state-changing POST. */
	csrf: string;
	/** Expiry, seconds since the Unix epoch. */
	exp: number;
};

function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie") || "";
	for (const part of header.split(";")) {
		const cookie = part.trim();
		if (cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1);
	}
	return null;
}

function cookie(name: string, value: string, maxAge: number): string {
	return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Returns the session only if the cookie is genuine, unexpired, and still the owner's. */
export async function readOwnerSession(request: Request, env: Env): Promise<OwnerSession | null> {
	const sealed = readCookie(request, SESSION_COOKIE);
	if (!sealed) return null;
	const session = await unseal<OwnerSession>(sealed, env.COOKIE_ENCRYPTION_KEY, SESSION_PURPOSE);
	if (!session || typeof session.exp !== "number" || typeof session.csrf !== "string") return null;
	if (session.exp <= Math.floor(Date.now() / 1000)) return null;
	if (!isAllowedEmail(session.email, env.ALLOWED_EMAIL)) return null;
	// The cookie alone is not enough: its server-side record must still exist,
	// so a cookie copied before sign-out cannot be replayed.
	if (typeof session.sid !== "string" || !session.sid) return null;
	if (!(await env.OAUTH_KV.get(sessionKey(session.sid)))) return null;
	return session;
}

const sessionKey = (sid: string) => `owner:session:${sid}`;

/**
 * Signs the owner out: deletes the server-side session record and returns the
 * Set-Cookie value that expires the session cookie (same name, path and flags).
 */
export async function endOwnerSession(env: Env, session: OwnerSession): Promise<string> {
	await env.OAUTH_KV.delete(sessionKey(session.sid));
	return cookie(SESSION_COOKIE, "", 0);
}

/** True only when the form's token matches this session's CSRF token. */
export function hasValidCsrf(session: OwnerSession, formToken: unknown): boolean {
	return safeEqual(session.csrf, formToken);
}

/** Sends the browser to Google to sign in as the owner, then back to `returnTo`. */
export async function startOwnerLogin(
	request: Request,
	env: Env,
	returnTo: OwnerPage,
): Promise<Response> {
	const state = `${OWNER_LOGIN_STATE_PREFIX}${randomToken()}`;
	await env.OAUTH_KV.put(`owner:state:${state}`, JSON.stringify({ returnTo }), {
		expirationTtl: LOGIN_STATE_TTL_SECONDS,
	});
	return new Response(null, {
		status: 302,
		headers: {
			"Cache-Control": "no-store",
			Location: getUpstreamAuthorizeUrl({
				clientId: env.GOOGLE_CLIENT_ID,
				redirectUri: new URL("/callback", request.url).href,
				scope: OWNER_LOGIN_SCOPES.join(" "),
				state,
				upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			}),
			// Bind the state to this browser: only its hash goes in the cookie.
			"Set-Cookie": cookie(
				LOGIN_STATE_COOKIE,
				await sha256Base64Url(state),
				LOGIN_STATE_TTL_SECONDS,
			),
		},
	});
}

/**
 * Handles /callback for an owner-page login. Issues a session cookie ONLY when
 * the state is ours, belongs to this browser, and Google reports the owner's
 * verified email.
 */
export async function finishOwnerLogin(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const state = url.searchParams.get("state") || "";
	const headers = new Headers({ "Set-Cookie": cookie(LOGIN_STATE_COOKIE, "", 0) });

	const stored = await env.OAUTH_KV.get(`owner:state:${state}`);
	const boundHash = readCookie(request, LOGIN_STATE_COOKIE);
	if (!stored || !boundHash || !safeEqual(boundHash, await sha256Base64Url(state))) {
		return renderMessagePage(
			"Sign-in failed",
			"This sign-in link is invalid or has expired. Please start again.",
			400,
			headers,
		);
	}
	// One-time use.
	await env.OAUTH_KV.delete(`owner:state:${state}`);

	const code = url.searchParams.get("code");
	if (!code) {
		return renderMessagePage("Sign-in failed", "The sign-in request was incomplete.", 400, headers);
	}

	const claims = await fetchGoogleIdentityClaims({
		clientId: env.GOOGLE_CLIENT_ID,
		clientSecret: env.GOOGLE_CLIENT_SECRET,
		code,
		redirectUri: new URL("/callback", request.url).href,
	});
	if (!claims) {
		console.warn("GET /callback denied: google_exchange_failed");
		return renderMessagePage(
			"Sign-in failed",
			"Google sign-in could not be completed. Please try again.",
			502,
			headers,
		);
	}

	const owner = verifyOwner(claims, env.ALLOWED_EMAIL);
	if (!owner) {
		console.warn("GET /callback denied: not_allowed");
		return renderMessagePage(
			"Access denied",
			"This Google account is not allowed to use GoBridge.",
			403,
			headers,
		);
	}

	let returnTo: string = OWNER_PAGES[0];
	try {
		const parsed = JSON.parse(stored) as { returnTo?: string };
		if (OWNER_PAGES.includes(parsed.returnTo as OwnerPage)) returnTo = parsed.returnTo as string;
	} catch (_e) {
		// keep the default
	}

	const session: OwnerSession = {
		csrf: randomToken(),
		email: owner.email,
		exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
		sid: randomToken(),
		sub: owner.sub,
	};
	await env.OAUTH_KV.put(sessionKey(session.sid), "1", { expirationTtl: SESSION_TTL_SECONDS });
	headers.append(
		"Set-Cookie",
		cookie(
			SESSION_COOKIE,
			await seal(session, env.COOKIE_ENCRYPTION_KEY, SESSION_PURPOSE),
			SESSION_TTL_SECONDS,
		),
	);
	headers.set("Location", returnTo);
	headers.set("Cache-Control", "no-store");
	return new Response(null, { status: 302, headers });
}
