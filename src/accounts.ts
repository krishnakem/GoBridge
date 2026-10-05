/**
 * Linked Google accounts, stored in the GOOGLE_TOKENS KV namespace keyed by alias.
 * The refresh token is always encrypted at rest; everything else is metadata.
 */
import { decryptSecret, encryptSecret } from "./crypto";

/** Lowercase letters, numbers, hyphens; 1-32 chars; no leading/trailing hyphen. */
export const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const KEY_PREFIX = "account:";

type StoredAccount = {
	v: 1;
	alias: string;
	email: string;
	sub: string;
	scopes: string[];
	linkedAt: string;
	/** AES-256-GCM encrypted refresh token */
	iv: string;
	ciphertext: string;
};

/** What the rest of the app may see about an account. Never includes token material. */
export type AccountInfo = Pick<StoredAccount, "alias" | "email" | "sub" | "scopes" | "linkedAt">;

function toInfo(record: StoredAccount): AccountInfo {
	const { alias, email, sub, scopes, linkedAt } = record;
	return { alias, email, linkedAt, scopes, sub };
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
	account: { alias: string; email: string; sub: string; scopes: string[]; refreshToken: string },
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
	};
	await env.GOOGLE_TOKENS.put(`${KEY_PREFIX}${account.alias}`, JSON.stringify(record));
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
}
