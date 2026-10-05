/**
 * Scopes for the OWNER LOGIN flow (AI client -> GoBridge). Identity only.
 * The Gmail/Calendar/Drive scopes belong to the separate /link flow and must
 * never be requested here.
 */
export const OWNER_LOGIN_SCOPES = ["openid", "email"] as const;

/**
 * Constructs an authorization URL for an upstream service.
 *
 * @param {Object} options
 * @param {string} options.upstreamUrl - The base URL of the upstream service.
 * @param {string} options.clientId - The client ID of the application.
 * @param {string} options.redirectUri - The redirect URI of the application.
 * @param {string} [options.state] - The state parameter.
 *
 * @returns {string} The authorization URL.
 */
export function getUpstreamAuthorizeUrl({
	upstreamUrl,
	clientId,
	scope,
	redirectUri,
	state,
}: {
	upstreamUrl: string;
	clientId: string;
	scope: string;
	redirectUri: string;
	state?: string;
}) {
	const upstream = new URL(upstreamUrl);
	upstream.searchParams.set("client_id", clientId);
	upstream.searchParams.set("redirect_uri", redirectUri);
	upstream.searchParams.set("scope", scope);
	upstream.searchParams.set("response_type", "code");
	if (state) upstream.searchParams.set("state", state);
	// Always show the account chooser so the owner picks the right account.
	upstream.searchParams.set("prompt", "select_account");
	return upstream.href;
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to GoBridgeMCP as this.props.
// Never put Google tokens here: MCP grants and Google access stay separate.
export type Props = {
	email: string;
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * Exchanges a Google authorization code and returns Google's userinfo claims
 * (sub, email, email_verified) for the caller to check against the allowlist.
 *
 * Returns null on any failure. The short-lived identity token is used once and
 * dropped: it is never stored, logged, or returned. Google's raw responses are
 * never logged or surfaced.
 */
export async function fetchGoogleIdentityClaims({
	clientId,
	clientSecret,
	code,
	redirectUri,
}: {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
}): Promise<unknown | null> {
	try {
		const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
			}).toString(),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			method: "POST",
		});
		if (!tokenResp.ok) return null;
		const { access_token } = (await tokenResp.json()) as { access_token?: unknown };
		if (typeof access_token !== "string" || !access_token) return null;

		const userResp = await fetch(GOOGLE_USERINFO_URL, {
			headers: { Authorization: `Bearer ${access_token}` },
		});
		if (!userResp.ok) return null;
		return await userResp.json();
	} catch (_e) {
		return null;
	}
}
