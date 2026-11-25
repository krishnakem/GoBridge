/**
 * AI clients as the owner pages show them: one card per app, not one per
 * registration. An app such as Claude registers again each time it is added,
 * so several registrations ("connections") can belong to the same app.
 *
 * Grouping must not become a trust shortcut. A client's name is whatever the
 * app typed at /register, so it never decides anything on its own:
 *
 *   - VERIFIED: every redirect URL is https on the exact hosts of one known
 *     brand (src/client-logos.ts). These group together under the brand's
 *     name and logo, whatever they called themselves.
 *   - Everything else groups only with registrations that have the same
 *     name AND the same set of redirect hosts. It gets a letter tile.
 *   - A name that uses a known brand without the hosts to prove it is flagged
 *     "Unverified". It never joins the brand's card or gets its logo.
 *
 * Grouping is display and revoke scope only. Whether a client may connect is
 * still decided per registration by the allowed list (src/allowed-clients.ts).
 */
import type { ClientInfo, GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { claimsKnownBrand, type KnownClient, knownClientFor } from "./client-logos";
import { sha256Base64Url } from "./crypto";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** What a group key looks like. Anything else in `?open=` or a form is ignored. */
export const GROUP_KEY_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export type ClientIdentity = {
	/** Stable identity string; hashed into the group key. Never shown. */
	id: string;
	/** Card title: the brand's own name when verified, else the registered name. */
	label: string;
	/** Set only when the redirect URLs prove the brand. */
	brand: KnownClient | null;
	/** The name uses a known brand, but the redirect URLs do not prove it. */
	unverified: boolean;
	/** Redirect hosts, sorted; "loopback" for an app on this computer. */
	hosts: string[];
};

function hostLabel(uri: string): string {
	let url: URL;
	try {
		url = new URL(uri);
	} catch (_e) {
		return "invalid";
	}
	if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return "loopback";
	return url.protocol === "https:" ? url.host : `${url.protocol}//${url.host}`;
}

const cleanName = (name: unknown) =>
	typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 100) : "";

/** The identity one registration is grouped under. Pure: depends only on the registration. */
export function clientIdentity(client: {
	clientName?: string;
	redirectUris?: readonly string[];
}): ClientIdentity {
	const uris = client.redirectUris ?? [];
	const hosts = [...new Set(uris.map(hostLabel))].sort();
	const brand = uris.length ? knownClientFor(uris) : null;
	if (brand) {
		return { brand, hosts, id: `brand:${brand.name}`, label: brand.name, unverified: false };
	}
	const name = cleanName(client.clientName);
	return {
		brand: null,
		hosts,
		// JSON keeps the parts apart whatever characters the name holds.
		id: `other:${JSON.stringify([name.normalize("NFKC").toLowerCase(), hosts])}`,
		label: name || "(no name)",
		unverified: claimsKnownBrand(name),
	};
}

export type ClientGroup = ClientIdentity & {
	/** URL- and form-safe key: a hash of `id`, so it carries nothing the app chose. */
	key: string;
	/** Every registration in the group, newest first. */
	clients: ClientInfo[];
	/** The signed-in owner's grants to those registrations. */
	grants: GrantSummary[];
};

/** Groups registrations by identity and attaches the owner's grants. Connected groups first. */
export async function groupClients(
	clients: readonly ClientInfo[],
	grants: readonly GrantSummary[],
): Promise<ClientGroup[]> {
	const byId = new Map<string, ClientGroup>();
	for (const client of clients) {
		const identity = clientIdentity(client);
		let group = byId.get(identity.id);
		if (!group) {
			group = {
				...identity,
				clients: [],
				grants: [],
				key: (await sha256Base64Url(identity.id)).slice(0, 16),
			};
			byId.set(identity.id, group);
		}
		group.clients.push(client);
		group.grants.push(...grants.filter((grant) => grant.clientId === client.clientId));
	}
	const groups = [...byId.values()];
	for (const group of groups) {
		group.clients.sort((a, b) => (b.registrationDate ?? 0) - (a.registrationDate ?? 0));
	}
	return groups.sort(
		(a, b) =>
			Math.sign(b.grants.length) - Math.sign(a.grants.length) ||
			Number(!!b.brand) - Number(!!a.brand) ||
			a.label.localeCompare(b.label),
	);
}

export async function allClients(helpers: OAuthHelpers): Promise<ClientInfo[]> {
	const clients: ClientInfo[] = [];
	let cursor: string | undefined;
	do {
		const page = await helpers.listClients({ cursor, limit: 100 });
		clients.push(...page.items);
		cursor = page.cursor;
	} while (cursor && clients.length < 500);
	return clients;
}

/** Grants of ONE user (the signed-in owner). Another user's grants are never listed. */
export async function allGrants(helpers: OAuthHelpers, userId: string): Promise<GrantSummary[]> {
	const grants: GrantSummary[] = [];
	let cursor: string | undefined;
	do {
		const page = await helpers.listUserGrants(userId, { cursor, limit: 100 });
		grants.push(...page.items);
		cursor = page.cursor;
	} while (cursor && grants.length < 500);
	return grants;
}

export type ClientDirectory = {
	groups: ClientGroup[];
	/** Grants whose registration is gone (left by an interrupted revoke). Their tokens no longer work. */
	leftoverGrants: GrantSummary[];
};

export async function loadClientDirectory(
	helpers: OAuthHelpers,
	userId: string,
): Promise<ClientDirectory> {
	const [clients, grants] = await Promise.all([allClients(helpers), allGrants(helpers, userId)]);
	const known = new Set(clients.map((client) => client.clientId));
	return {
		groups: await groupClients(clients, grants),
		leftoverGrants: grants.filter((grant) => !known.has(grant.clientId)),
	};
}

export type RevokeResult = {
	/** Registrations and grants that are gone. */
	clientCount: number;
	grantCount: number;
	/** Records that could not be removed. Both zero means nothing is left. */
	remainingGrants: number;
	remainingClients: number;
};

async function revokeGrants(
	helpers: OAuthHelpers,
	userId: string,
	wanted: (grant: GrantSummary) => boolean,
): Promise<{ removed: number; remaining: number }> {
	let removed = 0;
	let remaining = 0;
	// Two passes: the second retries anything the first could not remove.
	for (let pass = 0; pass < 2; pass++) {
		let grants: GrantSummary[];
		try {
			grants = (await allGrants(helpers, userId)).filter(wanted);
		} catch (_e) {
			return { remaining: Math.max(remaining, 1), removed };
		}
		remaining = 0;
		for (const grant of grants) {
			try {
				await helpers.revokeGrant(grant.id, userId);
				removed += 1;
			} catch (_e) {
				remaining += 1;
			}
		}
		if (remaining === 0) break;
	}
	return { remaining, removed };
}

/**
 * Removes every connection of one app. KV has no transactions, so the steps
 * are ordered and each is safe to repeat:
 *
 *   1. revoke every grant of every registration in the group. This deletes
 *      the grant with its access and refresh tokens, so access is cut first;
 *   2. delete the registrations. This happens even if a grant could not be
 *      removed, because /mcp and /token refuse a client with no registration:
 *      a leftover grant record is then unusable;
 *   3. look again and report anything still there.
 *
 * Never throws and is never rate limited: this is the owner's emergency stop.
 * `userId` is the signed-in owner; only that user's grants are touched.
 */
export async function revokeGroup(
	helpers: OAuthHelpers,
	userId: string,
	group: Pick<ClientGroup, "clients">,
): Promise<RevokeResult> {
	const ids = new Set(group.clients.map((client) => client.clientId));
	const grants = await revokeGrants(helpers, userId, (grant) => ids.has(grant.clientId));

	let clientCount = 0;
	let remainingClients = 0;
	for (const clientId of ids) {
		try {
			await helpers.deleteClient(clientId);
		} catch (_e) {
			// counted by the re-check below
		}
		try {
			if (await helpers.lookupClient(clientId)) remainingClients += 1;
			else clientCount += 1;
		} catch (_e) {
			remainingClients += 1;
		}
	}
	return {
		clientCount,
		grantCount: grants.removed,
		remainingClients,
		remainingGrants: grants.remaining,
	};
}

/** Removes grants whose registration is gone. Safe to repeat; never throws. */
export async function revokeLeftoverGrants(
	helpers: OAuthHelpers,
	userId: string,
): Promise<{ removed: number; remaining: number }> {
	let known: Set<string>;
	try {
		known = new Set((await allClients(helpers)).map((client) => client.clientId));
	} catch (_e) {
		return { remaining: 1, removed: 0 };
	}
	return revokeGrants(helpers, userId, (grant) => !known.has(grant.clientId));
}
