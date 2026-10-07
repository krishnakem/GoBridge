/**
 * Allowed AI clients: the owner's list of redirect URLs (D1 table
 * `allowed_redirect_uris`, edited on /settings).
 *
 * An AI client may sign in (/authorize, /callback) and use /mcp only when
 * EVERY redirect URL it registered is on the list. An empty list means no AI
 * client can connect. Every check FAILS CLOSED: if the list cannot be read,
 * the client is refused.
 *
 * Matching is exact on the normalized URL (scheme, host, path, query), with
 * one exception from RFC 8252: http loopback URLs (localhost, 127.0.0.1,
 * [::1]) match on any port, because native apps such as Claude Code pick a
 * new port each session. D1 is used (not KV) so a removal takes effect
 * everywhere at once.
 */

/** Most URLs the list may hold. */
export const MAX_ALLOWED_REDIRECTS = 20;
const MAX_URI_LENGTH = 512;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type NormalizedRedirect = { ok: true; uri: string } | { ok: false; reason: string };

const fail = (reason: string): NormalizedRedirect => ({ ok: false, reason });

/**
 * Normalizes a redirect URL for storing or comparing. Accepts only https URLs
 * and http URLs on a loopback host (whose port is dropped). Never accepts
 * wildcards, credentials, or fragments.
 */
export function normalizeRedirectUri(input: unknown): NormalizedRedirect {
	if (typeof input !== "string") return fail("Enter a redirect URL.");
	const text = input.trim();
	if (!text) return fail("Enter a redirect URL.");
	if (text.length > MAX_URI_LENGTH) return fail(`A redirect URL can be at most ${MAX_URI_LENGTH} characters.`);
	if (text.includes("*")) return fail("Wildcards are not allowed. Enter the app's exact redirect URL.");
	if (text.includes("#")) return fail("A redirect URL cannot contain a # fragment.");
	let url: URL;
	try {
		url = new URL(text);
	} catch (_e) {
		return fail("That is not a valid URL. It should start with https://");
	}
	if (url.username || url.password) return fail("A redirect URL cannot contain a user name or password.");
	if (url.protocol === "https:" && url.hostname) return { ok: true, uri: url.href };
	if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
		url.port = "";
		return { ok: true, uri: url.href };
	}
	return fail(
		"Use an https:// URL, or an http://localhost or http://127.0.0.1 URL for an app running on your own computer.",
	);
}

/** True when this redirect URL is on the list (loopback URLs on any port). */
export function isRedirectAllowed(uri: unknown, allowed: readonly string[]): boolean {
	const normalized = normalizeRedirectUri(uri);
	return normalized.ok && allowed.includes(normalized.uri);
}

/** The list, oldest first. Throws if the database cannot be read (callers fail closed). */
export async function listAllowedRedirects(env: Env): Promise<string[]> {
	const { results } = await env.AUDIT_DB.prepare(
		"SELECT uri FROM allowed_redirect_uris ORDER BY added_at, uri",
	).all<{ uri: string }>();
	return results.map((row) => row.uri);
}

/** Adds an already-normalized URL. */
export async function addAllowedRedirect(
	env: Env,
	uri: string,
): Promise<"added" | "exists" | "full"> {
	const current = await listAllowedRedirects(env);
	if (current.includes(uri)) return "exists";
	if (current.length >= MAX_ALLOWED_REDIRECTS) return "full";
	await env.AUDIT_DB.prepare("INSERT OR IGNORE INTO allowed_redirect_uris (uri, added_at) VALUES (?, ?)")
		.bind(uri, new Date().toISOString())
		.run();
	return "added";
}

/** Removes a URL. Returns whether it was on the list. */
export async function removeAllowedRedirect(env: Env, uri: string): Promise<boolean> {
	const result = await env.AUDIT_DB.prepare("DELETE FROM allowed_redirect_uris WHERE uri = ?")
		.bind(uri)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export type ClientVerdict =
	| { ok: true }
	/** `unlisted`: the client's redirect URLs that are not on the list (normalized where possible). */
	| { ok: false; reason: "not_allowed"; unlisted: string[] }
	| { ok: false; reason: "unknown_client" | "list_unavailable" };

/**
 * Decides whether a registered client may sign in or use /mcp. When
 * `requestedRedirect` is given (sign-in), it must also be one of the client's
 * own registered URLs.
 */
export async function checkClient(
	env: Env,
	client: { redirectUris?: readonly string[] } | null | undefined,
	requestedRedirect?: string,
): Promise<ClientVerdict> {
	const registered = client?.redirectUris ?? [];
	if (!client || registered.length === 0) return { ok: false, reason: "unknown_client" };
	if (requestedRedirect !== undefined && !registered.includes(requestedRedirect)) {
		return { ok: false, reason: "unknown_client" };
	}
	let allowed: string[];
	try {
		allowed = await listAllowedRedirects(env);
	} catch (_e) {
		console.error("allowed clients error: list_unavailable");
		return { ok: false, reason: "list_unavailable" };
	}
	const unlisted = registered
		.filter((uri) => !isRedirectAllowed(uri, allowed))
		.map((uri) => {
			const normalized = normalizeRedirectUri(uri);
			return normalized.ok ? normalized.uri : uri;
		});
	return unlisted.length ? { ok: false, reason: "not_allowed", unlisted } : { ok: true };
}
