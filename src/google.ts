/**
 * GoBridge -> Google: the "link account" OAuth relationship.
 *
 * This is completely separate from the AI client -> GoBridge relationship.
 * Google tokens obtained here are never given to MCP clients.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * EXACTLY the scopes a linked account grants. Changing this list requires the
 * owner's explicit approval (see SPEC.md and PARITY.md). Never add
 * https://mail.google.com/, gmail.settings.*, or the full calendar scope.
 */
export const LINK_SCOPES = [
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/calendar.events",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	"https://www.googleapis.com/auth/calendar.freebusy",
	"https://www.googleapis.com/auth/drive",
	"openid",
	"email",
] as const;

/** True when a stored account was linked with exactly the current scope list. */
export function hasCurrentScopes(scopes: unknown): boolean {
	return (
		Array.isArray(scopes) &&
		scopes.length === LINK_SCOPES.length &&
		LINK_SCOPES.every((scope) => scopes.includes(scope))
	);
}

/** Google reports the `email` scope under its long name. */
function normalizeScope(scope: string): string {
	return scope === "https://www.googleapis.com/auth/userinfo.email" ? "email" : scope;
}

/** True only when Google granted exactly LINK_SCOPES: nothing missing, nothing extra. */
export function grantedScopesMatch(grantedScope: unknown): boolean {
	if (typeof grantedScope !== "string") return false;
	const granted = new Set(grantedScope.split(/\s+/).filter(Boolean).map(normalizeScope));
	const wanted = new Set<string>(LINK_SCOPES);
	if (granted.size !== wanted.size) return false;
	for (const scope of wanted) {
		if (!granted.has(scope)) return false;
	}
	return true;
}

export function buildLinkAuthorizeUrl({
	clientId,
	redirectUri,
	state,
	codeChallenge,
}: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(GOOGLE_AUTH_URL);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", LINK_SCOPES.join(" "));
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.href;
}

export type LinkedGrant = {
	refreshToken: string;
	grantedScope: unknown;
	email: string;
	sub: string;
};

export type LinkExchangeResult =
	| { ok: true; grant: LinkedGrant }
	| { ok: false; reason: "exchange_failed" | "no_refresh_token" | "identity_failed"; revokable?: string };

/**
 * Exchanges the /link/callback code (with PKCE) and looks up which Google
 * account was linked. The access token is used once here and dropped. Google's
 * raw responses are never logged or returned.
 */
export async function exchangeLinkCode({
	clientId,
	clientSecret,
	code,
	codeVerifier,
	redirectUri,
}: {
	clientId: string;
	clientSecret: string;
	code: string;
	codeVerifier: string;
	redirectUri: string;
}): Promise<LinkExchangeResult> {
	try {
		const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				code_verifier: codeVerifier,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
			}).toString(),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			method: "POST",
		});
		if (!tokenResp.ok) return { ok: false, reason: "exchange_failed" };
		const tokens = (await tokenResp.json()) as Record<string, unknown>;
		const accessToken = tokens.access_token;
		const refreshToken = tokens.refresh_token;
		if (typeof accessToken !== "string" || !accessToken) {
			return { ok: false, reason: "exchange_failed" };
		}
		if (typeof refreshToken !== "string" || !refreshToken) {
			return { ok: false, reason: "no_refresh_token", revokable: accessToken };
		}

		const userResp = await fetch(GOOGLE_USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!userResp.ok) return { ok: false, reason: "identity_failed", revokable: refreshToken };
		const claims = (await userResp.json()) as Record<string, unknown>;
		if (typeof claims.email !== "string" || !claims.email || typeof claims.sub !== "string") {
			return { ok: false, reason: "identity_failed", revokable: refreshToken };
		}

		return {
			ok: true,
			grant: {
				email: claims.email,
				grantedScope: tokens.scope,
				refreshToken,
				sub: claims.sub,
			},
		};
	} catch (_e) {
		return { ok: false, reason: "exchange_failed" };
	}
}

/** Asks Google to revoke a token (and the grant behind it). Returns whether Google confirmed. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
	try {
		const resp = await fetch(GOOGLE_REVOKE_URL, {
			body: new URLSearchParams({ token }).toString(),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			method: "POST",
		});
		return resp.ok;
	} catch (_e) {
		return false;
	}
}
