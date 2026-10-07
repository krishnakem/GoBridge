/**
 * Owner allowlist. GoBridge has exactly one allowed user: the Google account
 * whose address equals the ALLOWED_EMAIL secret.
 */

export type GoogleIdentity = {
	sub: string;
	email: string;
	/** Google profile picture URL, only when it is served from the one allowed host. */
	picture?: string;
};

/** The only host the owner pages may load profile pictures from (also in the CSP). */
export const PICTURE_HOST = "lh3.googleusercontent.com";
const PICTURE_MAX_LENGTH = 512;

/**
 * The `picture` claim from Google's userinfo, accepted only as an https URL on
 * PICTURE_HOST with no query or fragment. Anything else is dropped: the pages
 * then show the initial-letter avatar instead. Never logged.
 */
export function profilePictureFrom(claims: unknown): string | undefined {
	if (!claims || typeof claims !== "object") return undefined;
	const { picture } = claims as Record<string, unknown>;
	if (typeof picture !== "string" || picture.length > PICTURE_MAX_LENGTH) return undefined;
	let url: URL;
	try {
		url = new URL(picture);
	} catch (_e) {
		return undefined;
	}
	if (url.protocol !== "https:" || url.hostname !== PICTURE_HOST) return undefined;
	if (url.username || url.password || url.search || url.hash) return undefined;
	return url.href;
}

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
	const picture = profilePictureFrom(claims);
	return picture ? { email, picture, sub } : { email, sub };
}
