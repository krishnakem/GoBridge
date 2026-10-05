/**
 * Owner allowlist. GoBridge has exactly one allowed user: the Google account
 * whose address equals the ALLOWED_EMAIL secret.
 */

export type GoogleIdentity = {
	sub: string;
	email: string;
};

/** True only for a non-empty address that equals ALLOWED_EMAIL, ignoring case. */
export function isAllowedEmail(email: unknown, allowedEmail: unknown): email is string {
	if (typeof email !== "string" || typeof allowedEmail !== "string") return false;
	const allowed = allowedEmail.trim().toLowerCase();
	if (!allowed) return false;
	return email.trim().toLowerCase() === allowed;
}

/**
 * Checks Google's userinfo claims against the allowlist. Returns the identity
 * only when `email_verified` is exactly `true` AND the email is the owner's.
 */
export function verifyOwner(claims: unknown, allowedEmail: unknown): GoogleIdentity | null {
	if (!claims || typeof claims !== "object") return null;
	const { sub, email, email_verified } = claims as Record<string, unknown>;
	if (typeof sub !== "string" || !sub) return null;
	if (email_verified !== true) return null;
	if (!isAllowedEmail(email, allowedEmail)) return null;
	return { sub, email };
}
