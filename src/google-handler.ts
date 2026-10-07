import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { verifyOwner } from "./auth";
import { renderMessagePage } from "./html";
import { LinkHandler } from "./link-handler";
import { OwnerPages } from "./owner-pages";
import { finishOwnerLogin, OWNER_LOGIN_STATE_PREFIX } from "./session";
import { StaticAssets } from "./static-assets";
import {
	fetchGoogleIdentityClaims,
	getUpstreamAuthorizeUrl,
	OWNER_LOGIN_SCOPES,
	type Props,
} from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

// Unexpected errors: log the route and a category only, never the error itself
// (its message or stack could contain request data).
app.onError((_error, c) => {
	console.error(`${c.req.method} ${c.req.path} error: internal`);
	return c.text("Internal server error", 500);
});

/** OAuth 2.1: every MCP client must use PKCE with S256. */
function hasRequiredPkce(request: AuthRequest): boolean {
	return Boolean(request.codeChallenge) && request.codeChallengeMethod === "S256";
}

// Health check: no data, no auth.
app.get("/health", (c) => c.text("ok"));

// The bare worker URL: a fixed redirect to /link (which requires owner sign-in).
// No data, no cookies, and only GET; every other method on / is 404.
app.get("/", (c) =>
	c.body(null, 302, { "Cache-Control": "no-store", Location: "/link" }),
);

app.get("/authorize", async (c) => {
	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch (_e) {
		// Unknown client, unregistered redirect URI, bad PKCE method, and so on.
		console.warn("GET /authorize denied: invalid_request");
		return c.text("Invalid request", 400);
	}
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}
	if (!hasRequiredPkce(oauthReqInfo)) {
		console.warn("GET /authorize denied: pkce_required");
		return c.text("PKCE with S256 is required", 400);
	}

	// Check if client is already approved
	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		// Skip approval dialog but still create secure state and bind to session
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		return redirectToGoogle(c.req.raw, c.env, stateToken, {
			"Set-Cookie": sessionBindingCookie,
		});
	}

	// Generate CSRF protection for the approval form
	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "GoBridge is a private MCP server. Only its owner can sign in.",
			name: "GoBridge",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		// Read form data once
		const formData = await c.req.raw.formData();

		// Validate CSRF token
		validateCSRFToken(formData, c.req.raw);

		// Extract state from form data
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}
		if (!hasRequiredPkce(state.oauthReqInfo)) {
			console.warn("POST /authorize denied: pkce_required");
			return c.text("PKCE with S256 is required", 400);
		}

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		// Create OAuth state and bind it to this user's session
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		// Set both cookies: approved client list + session binding
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToGoogle(c.req.raw, c.env, stateToken, Object.fromEntries(headers));
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		// Log only route + error category: never the error object or request data.
		console.error("POST /authorize error: internal");
		return c.text("Internal server error", 500);
	}
});

async function redirectToGoogle(
	request: Request,
	env: Env,
	stateToken: string,
	headers: Record<string, string> = {},
) {
	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				clientId: env.GOOGLE_CLIENT_ID,
				redirectUri: new URL("/callback", request.url).href,
				scope: OWNER_LOGIN_SCOPES.join(" "),
				state: stateToken,
				upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			}),
		},
		status: 302,
	});
}

/**
 * OAuth Callback Endpoint
 *
 * SECURITY: This endpoint validates that the state parameter from Google
 * matches both:
 * 1. A valid state token in KV (proves it was created by our server)
 * 2. The __Host-CONSENTED_STATE cookie (proves THIS browser consented to it)
 *
 * It then requires Google to report email_verified === true and an email equal
 * to ALLOWED_EMAIL. Anyone else is rejected and NO grant or token is issued.
 */
app.get("/callback", async (c) => {
	// Owner-page logins (for /link) share this redirect URI but never create an MCP grant.
	if (c.req.query("state")?.startsWith(OWNER_LOGIN_STATE_PREFIX)) {
		return finishOwnerLogin(c.req.raw, c.env);
	}

	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}

	// The session binding cookie is one-time use, whatever the outcome.
	const headers = new Headers();
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	const code = c.req.query("code");
	if (!oauthReqInfo.clientId || !code) {
		return renderMessagePage("Sign-in failed", "The sign-in request was incomplete.", 400, headers);
	}

	const claims = await fetchGoogleIdentityClaims({
		clientId: c.env.GOOGLE_CLIENT_ID,
		clientSecret: c.env.GOOGLE_CLIENT_SECRET,
		code,
		redirectUri: new URL("/callback", c.req.url).href,
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

	const owner = verifyOwner(claims, c.env.ALLOWED_EMAIL);
	if (!owner) {
		console.warn("GET /callback denied: not_allowed");
		return renderMessagePage(
			"Access denied",
			"This Google account is not allowed to use GoBridge.",
			403,
			headers,
		);
	}

	// Only the owner reaches this point. Props carry the owner email and which MCP
	// client the grant is for (for the audit log): never a Google token.
	const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: owner.email,
		},
		props: {
			clientId: oauthReqInfo.clientId,
			clientName: client?.clientName?.slice(0, 100),
			email: owner.email,
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: owner.sub,
	});

	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
});

// Owner-only pages: /link, /link/callback, /link/unlink, /audit, /clients,
// /clients/revoke, /settings, /logout (plus the public /signed-out notice)
app.route("/", LinkHandler);
app.route("/", OwnerPages);
// Public, data-free CSS and JS for the pages above: /static/app.css, /static/menu.js
app.route("/", StaticAssets);

export { app as GoogleHandler };
