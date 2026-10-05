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
	return upstream.href;
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to GoBridgeMCP as this.props.
// Never put Google tokens here: MCP grants and Google access stay separate.
export type Props = {
	email: string;
};
