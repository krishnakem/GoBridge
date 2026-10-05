/**
 * Server-side calls to Google APIs on behalf of a linked account.
 *
 * The stored refresh token is decrypted here, exchanged for a short-lived
 * access token, and used for the call. Neither token ever leaves this module:
 * they are not returned to tools, not logged, and not put in error messages.
 * Google's raw responses and error bodies are never surfaced either.
 */
import { getAccount, getRefreshToken } from "./accounts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ToolErrorCategory =
	| "invalid_input"
	| "unknown_alias"
	| "relink_required"
	| "not_found"
	| "google_denied"
	| "google_rate_limited"
	| "google_error"
	| "unsupported_file"
	| "writes_disabled"
	| "rate_limited"
	| "send_cap_reached"
	| "client_unknown"
	| "internal";

/** An error whose message is safe to show to the MCP client as-is. */
export class ToolError extends Error {
	constructor(
		readonly category: ToolErrorCategory,
		message: string,
	) {
		super(message);
	}
}

const relinkError = (alias: string) =>
	new ToolError(
		"relink_required",
		`Google access for "${alias}" has expired or was revoked. Ask the owner to re-link this account at /link.`,
	);

// Short-lived access tokens, kept in memory only (never in KV). Keyed by alias
// and bound to the stored record, so unlinking or re-linking drops the entry.
const accessTokens = new Map<string, { linkedAt: string; token: string; expiresAt: number }>();

async function getAccessToken(env: Env, alias: string): Promise<string> {
	const account = await getAccount(env, alias);
	if (!account) {
		accessTokens.delete(alias);
		throw new ToolError(
			"unknown_alias",
			`No linked account has the alias "${alias}". Use list_accounts to see the linked accounts.`,
		);
	}
	const cached = accessTokens.get(alias);
	if (cached && cached.linkedAt === account.linkedAt && cached.expiresAt > Date.now()) {
		return cached.token;
	}

	let refreshToken: string | null;
	try {
		refreshToken = await getRefreshToken(env, alias);
	} catch (_e) {
		refreshToken = null; // undecryptable record (e.g. the encryption key changed)
	}
	if (!refreshToken) throw relinkError(alias);

	let resp: Response;
	try {
		resp = await fetch(GOOGLE_TOKEN_URL, {
			body: new URLSearchParams({
				client_id: env.GOOGLE_CLIENT_ID,
				client_secret: env.GOOGLE_CLIENT_SECRET,
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}).toString(),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			method: "POST",
		});
	} catch (_e) {
		throw new ToolError("google_error", "Could not reach Google. Try again in a moment.");
	}
	if (!resp.ok) {
		// 400/401 here means the refresh token itself is no longer accepted.
		await resp.body?.cancel();
		if (resp.status === 400 || resp.status === 401) throw relinkError(alias);
		throw new ToolError("google_error", "Google sign-in is unavailable. Try again in a moment.");
	}
	const tokens = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
	const token = tokens?.access_token;
	if (typeof token !== "string" || !token) {
		throw new ToolError("google_error", "Google sign-in is unavailable. Try again in a moment.");
	}
	const lifetime = typeof tokens?.expires_in === "number" ? tokens.expires_in : 0;
	if (lifetime > 120) {
		accessTokens.set(alias, {
			expiresAt: Date.now() + (lifetime - 60) * 1000,
			linkedAt: account.linkedAt,
			token,
		});
	}
	return token;
}

export type GoogleRequestOptions = {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers?: Record<string, string>;
	/** Sent as a JSON body. */
	json?: unknown;
};

/**
 * Calls a Google API URL as the linked account. Returns the successful response;
 * every failure becomes a ToolError with a generic, safe message.
 */
export async function googleRequest(
	env: Env,
	alias: string,
	url: URL | string,
	options: GoogleRequestOptions = {},
): Promise<Response> {
	const token = await getAccessToken(env, alias);
	let resp: Response;
	try {
		resp = await fetch(url, {
			body: options.json === undefined ? undefined : JSON.stringify(options.json),
			headers: {
				...options.headers,
				...(options.json === undefined ? {} : { "Content-Type": "application/json" }),
				Authorization: `Bearer ${token}`,
			},
			method: options.method ?? "GET",
		});
	} catch (_e) {
		throw new ToolError("google_error", "Could not reach Google. Try again in a moment.");
	}
	if (resp.ok) return resp;

	await resp.body?.cancel();
	switch (resp.status) {
		case 401:
			accessTokens.delete(alias);
			throw relinkError(alias);
		case 403:
			throw new ToolError("google_denied", "Google refused this request for this account.");
		case 404:
		case 410:
			throw new ToolError("not_found", "Google could not find that item in this account.");
		case 429:
			throw new ToolError("google_rate_limited", "Google is rate-limiting requests. Try again shortly.");
		case 400:
			throw new ToolError("invalid_input", "Google rejected the request. Check the ids and query.");
		default:
			throw new ToolError("google_error", "Google returned an error. Try again in a moment.");
	}
}

export function googleGet(
	env: Env,
	alias: string,
	url: URL | string,
	headers: Record<string, string> = {},
): Promise<Response> {
	return googleRequest(env, alias, url, { headers });
}

export async function googleGetJson<T>(env: Env, alias: string, url: URL | string): Promise<T> {
	return googleJson<T>(env, alias, url);
}

/** Like googleRequest, but parses a JSON response (an empty body gives `{}`). */
export async function googleJson<T>(
	env: Env,
	alias: string,
	url: URL | string,
	options: GoogleRequestOptions = {},
): Promise<T> {
	const resp = await googleRequest(env, alias, url, options);
	if (resp.status === 204) return {} as T;
	try {
		return (await resp.json()) as T;
	} catch (_e) {
		throw new ToolError("google_error", "Google returned an unreadable response.");
	}
}

/**
 * Reads at most `maxBytes` of a response body as UTF-8 text, then stops
 * downloading. `truncated` is true when the body was longer.
 */
export async function readTextCapped(
	resp: Response,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	if (!resp.body) return { text: "", truncated: false };
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let received = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const room = maxBytes - received;
		if (value.byteLength > room) {
			text += decoder.decode(value.subarray(0, room), { stream: true });
			truncated = true;
			await reader.cancel();
			break;
		}
		received += value.byteLength;
		text += decoder.decode(value, { stream: true });
	}
	return { text, truncated };
}

/** Test hook: forget cached access tokens. */
export function clearAccessTokenCache(): void {
	accessTokens.clear();
}
