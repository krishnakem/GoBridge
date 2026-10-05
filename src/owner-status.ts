/**
 * What the owner pages need to know on every render: the linked accounts and
 * whether anything needs the owner's attention (the avatar's red dot).
 */
import { type AccountInfo, aliasesNeedingRelink, listAccounts } from "./accounts";
import { hasCurrentScopes } from "./google";
import { type KillSwitch, switchesOff } from "./guardrails";
import type { Attention } from "./html";

export async function ownerStatus(
	env: Env,
): Promise<{ accounts: AccountInfo[]; attention: Attention; switchesOff: KillSwitch[] }> {
	const [accounts, flagged] = await Promise.all([listAccounts(env), aliasesNeedingRelink(env)]);
	const linked = new Set(accounts.map((account) => account.alias));
	// Accounts linked before the scope list changed must be linked again.
	const stale = accounts.filter((a) => !hasCurrentScopes(a.scopes)).map((a) => a.alias);
	const off = switchesOff(env);
	return {
		accounts,
		attention: {
			relink: [...new Set([...flagged.filter((alias) => linked.has(alias)), ...stale])].sort(),
			switchesOff: off.filter((name) => name !== "WRITES_ENABLED"),
			writesOff: off.includes("WRITES_ENABLED"),
		},
		switchesOff: off,
	};
}
