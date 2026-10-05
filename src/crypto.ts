/**
 * WebCrypto helpers.
 *
 * - Google refresh tokens: AES-256-GCM with TOKEN_ENCRYPTION_KEY (64 hex chars),
 *   a fresh random IV per record, and the record's alias as additional data so
 *   a ciphertext cannot be moved to another alias.
 * - Owner session cookies: AES-256-GCM with a key derived (HKDF) from
 *   COOKIE_ENCRYPTION_KEY. GCM both encrypts and authenticates the cookie.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** A URL-safe random token with `byteLength` bytes of entropy. */
export function randomToken(byteLength = 32): string {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return b64urlEncode(new Uint8Array(digest));
}

/** Constant-time string comparison. */
export function safeEqual(a: unknown, b: unknown): boolean {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.byteLength !== right.byteLength) return false;
	return crypto.subtle.timingSafeEqual(left, right);
}

export type EncryptedSecret = {
	/** base64url, 12 random bytes, unique per record */
	iv: string;
	/** base64url AES-256-GCM ciphertext + tag */
	ciphertext: string;
};

async function importTokenKey(hexKey: unknown): Promise<CryptoKey> {
	const hex = typeof hexKey === "string" ? hexKey.trim() : "";
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		// Never include the key (or any part of it) in the message.
		throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hex characters");
	}
	const raw = new Uint8Array(32);
	for (let i = 0; i < 32; i++) raw[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(
	plaintext: string,
	hexKey: string,
	context: string,
): Promise<EncryptedSecret> {
	const key = await importTokenKey(hexKey);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encoder.encode(context) },
		key,
		encoder.encode(plaintext),
	);
	return { iv: b64urlEncode(iv), ciphertext: b64urlEncode(new Uint8Array(ciphertext)) };
}

/** Throws if the key, IV, ciphertext, or context do not match. */
export async function decryptSecret(
	secret: EncryptedSecret,
	hexKey: string,
	context: string,
): Promise<string> {
	const key = await importTokenKey(hexKey);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: b64urlDecode(secret.iv), additionalData: encoder.encode(context) },
		key,
		b64urlDecode(secret.ciphertext),
	);
	return decoder.decode(plaintext);
}

async function deriveCookieKey(secret: unknown, purpose: string): Promise<CryptoKey> {
	if (typeof secret !== "string" || secret.trim().length < 32) {
		throw new Error("COOKIE_ENCRYPTION_KEY is missing or too short");
	}
	const material = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret.trim()),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: encoder.encode("gobridge"), info: encoder.encode(purpose) },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Encrypts + authenticates a small JSON value for use in a cookie. */
export async function seal(value: unknown, secret: string, purpose: string): Promise<string> {
	const key = await deriveCookieKey(secret, purpose);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encoder.encode(JSON.stringify(value)),
	);
	return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

/** Returns null for anything that was not sealed with this secret + purpose. */
export async function unseal<T>(sealed: string, secret: string, purpose: string): Promise<T | null> {
	const [iv, ciphertext, ...rest] = sealed.split(".");
	if (!iv || !ciphertext || rest.length > 0) return null;
	try {
		const key = await deriveCookieKey(secret, purpose);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: b64urlDecode(iv) },
			key,
			b64urlDecode(ciphertext),
		);
		return JSON.parse(decoder.decode(plaintext)) as T;
	} catch (_e) {
		return null;
	}
}
