/**
 * What the owner pages need to know on every render: the linked accounts and
 * whether anything needs the owner's attention (the avatar's red dot).
 */
import { type AccountInfo, aliasesNeedingRelink, listAccounts } from "./accounts";
import { writesEnabled } from "./guardrails";
import type { Attention } from "./html";

export async function ownerStatus(
	env: Env,
): Promise<{ accounts: AccountInfo[]; attention: Attention }> {
	const [accounts, flagged] = await Promise.all([listAccounts(env), aliasesNeedingRelink(env)]);
	const linked = new Set(accounts.map((account) => account.alias));
	return {
		accounts,
		attention: {
			relink: flagged.filter((alias) => linked.has(alias)),
			writesOff: !writesEnabled(env),
		},
	};
}
