/**
 * Linked Google accounts, stored in the GOOGLE_TOKENS KV namespace keyed by alias.
 * The refresh token is always encrypted at rest; everything else is metadata.
 */
import { decryptSecret, encryptSecret } from "./crypto";

/** Lowercase letters, numbers, hyphens; 1-32 chars; no leading/trailing hyphen. */
export const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const KEY_PREFIX = "account:";
/** Marker written when Google stops accepting an account's refresh token. */
const RELINK_PREFIX = "relink:";

type StoredAccount = {
	v: 1;
	alias: string;
	email: string;
	sub: string;
	scopes: string[];
	linkedAt: string;
	/** Google profile picture URL (allowed host only), shown on /link. Never logged. */
	picture?: string;
	/** AES-256-GCM encrypted refresh token */
	iv: string;
	ciphertext: string;
};

/** What the rest of the app may see about an account. Never includes token material. */
export type AccountInfo = Pick<
	StoredAccount,
	"alias" | "email" | "sub" | "scopes" | "linkedAt" | "picture"
>;

function toInfo(record: StoredAccount): AccountInfo {
	const { alias, email, sub, scopes, linkedAt, picture } = record;
	return { alias, email, linkedAt, scopes, sub, ...(picture ? { picture } : {}) };
}

async function readRecord(env: Env, alias: string): Promise<StoredAccount | null> {
	if (!ALIAS_PATTERN.test(alias)) return null;
	const raw = await env.GOOGLE_TOKENS.get(`${KEY_PREFIX}${alias}`);
	if (!raw) return null;
	try {
		const record = JSON.parse(raw) as StoredAccount;
		return record.v === 1 && record.alias === alias ? record : null;
	} catch (_e) {
		return null;
	}
}

export async function getAccount(env: Env, alias: string): Promise<AccountInfo | null> {
	const record = await readRecord(env, alias);
	return record ? toInfo(record) : null;
}

export async function listAccounts(env: Env): Promise<AccountInfo[]> {
	const accounts: AccountInfo[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.GOOGLE_TOKENS.list({ cursor, prefix: KEY_PREFIX });
		for (const key of page.keys) {
			const record = await readRecord(env, key.name.slice(KEY_PREFIX.length));
			if (record) accounts.push(toInfo(record));
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return accounts.sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function saveAccount(
	env: Env,
	account: {
		alias: string;
		email: string;
		sub: string;
		scopes: string[];
		refreshToken: string;
		picture?: string;
	},
): Promise<void> {
	if (!ALIAS_PATTERN.test(account.alias)) throw new Error("invalid alias");
	const encrypted = await encryptSecret(
		account.refreshToken,
		env.TOKEN_ENCRYPTION_KEY,
		account.alias,
	);
	const record: StoredAccount = {
		alias: account.alias,
		ciphertext: encrypted.ciphertext,
		email: account.email,
		iv: encrypted.iv,
		linkedAt: new Date().toISOString(),
		scopes: account.scopes,
		sub: account.sub,
		v: 1,
		...(account.picture ? { picture: account.picture } : {}),
	};
	await env.GOOGLE_TOKENS.put(`${KEY_PREFIX}${account.alias}`, JSON.stringify(record));
	await env.GOOGLE_TOKENS.delete(`${RELINK_PREFIX}${account.alias}`);
}

export type RenameOutcome = "ok" | "unknown_alias" | "alias_in_use" | "same_alias";

/**
 * Moves an account record from one alias to another, keeping everything in
 * it (email, scopes, link date, picture, encrypted refresh token). The token
 * is bound to its alias by the encryption, so it is decrypted in memory and
 * encrypted again under the new alias; it is never logged or returned.
 *
 * Order matters: the new key is written first and the old key deleted only
 * afterwards, so a failure part-way can leave a duplicate but never a loss.
 * A pending "re-link needed" flag follows the account.
 */
export async function renameAccount(
	env: Env,
	alias: string,
	newAlias: string,
): Promise<RenameOutcome> {
	if (!ALIAS_PATTERN.test(alias) || !ALIAS_PATTERN.test(newAlias)) return "unknown_alias";
	if (alias === newAlias) return "same_alias";
	const record = await readRecord(env, alias);
	if (!record) return "unknown_alias";
	if (await env.GOOGLE_TOKENS.get(`${KEY_PREFIX}${newAlias}`)) return "alias_in_use";

	const refreshToken = await decryptSecret(record, env.TOKEN_ENCRYPTION_KEY, alias);
	const encrypted = await encryptSecret(refreshToken, env.TOKEN_ENCRYPTION_KEY, newAlias);
	const moved: StoredAccount = {
		...record,
		alias: newAlias,
		ciphertext: encrypted.ciphertext,
		iv: encrypted.iv,
	};
	await env.GOOGLE_TOKENS.put(`${KEY_PREFIX}${newAlias}`, JSON.stringify(moved));
	await env.GOOGLE_TOKENS.delete(`${KEY_PREFIX}${alias}`);

	const flagged = await env.GOOGLE_TOKENS.get(`${RELINK_PREFIX}${alias}`);
	if (flagged) {
		await env.GOOGLE_TOKENS.put(`${RELINK_PREFIX}${newAlias}`, flagged);
		await env.GOOGLE_TOKENS.delete(`${RELINK_PREFIX}${alias}`);
	}
	return "ok";
}

/** Remembers that this account must be linked again (shown on the owner pages). */
export async function markNeedsRelink(env: Env, alias: string): Promise<void> {
	if (!ALIAS_PATTERN.test(alias)) return;
	await env.GOOGLE_TOKENS.put(`${RELINK_PREFIX}${alias}`, new Date().toISOString());
}

/** Aliases flagged as needing a re-link. Linking again or unlinking clears the flag. */
export async function aliasesNeedingRelink(env: Env): Promise<string[]> {
	const page = await env.GOOGLE_TOKENS.list({ prefix: RELINK_PREFIX });
	return page.keys.map((key) => key.name.slice(RELINK_PREFIX.length)).sort();
}

/** Decrypts the stored refresh token. For server-side Google calls only. */
export async function getRefreshToken(env: Env, alias: string): Promise<string | null> {
	const record = await readRecord(env, alias);
	if (!record) return null;
	return decryptSecret(record, env.TOKEN_ENCRYPTION_KEY, alias);
}

export async function deleteAccount(env: Env, alias: string): Promise<void> {
	if (!ALIAS_PATTERN.test(alias)) return;
	await env.GOOGLE_TOKENS.delete(`${KEY_PREFIX}${alias}`);
	await env.GOOGLE_TOKENS.delete(`${RELINK_PREFIX}${alias}`);
}
