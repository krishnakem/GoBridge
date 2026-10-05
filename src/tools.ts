/**
 * Tool registry and runner (PARITY.md).
 *
 * Every call goes through runTool, which enforces, in order: validation, a
 * known MCP client, a linked account, the feature switches (writes only), the
 * rate limit (reads and writes), and then records the call in the audit log.
 * Failures become short, safe messages: no stack traces, tokens, or raw Google
 * responses reach the client.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccount, listAccounts } from "./accounts";
import { ToolError } from "./google-api";
import {
	type AuditMeta,
	enforceReadRateLimit,
	enforceWriteRateLimit,
	type KillSwitch,
	recordAudit,
	recordReadAudit,
	switchEnabled,
} from "./guardrails";
import { CALENDAR_TOOLS } from "./tools/calendar";
import { type McpContent, type ToolDef, tool } from "./tools/common";
import { DRIVE_TOOLS } from "./tools/drive";
import { GMAIL_TOOLS } from "./tools/gmail";
import { z } from "zod";

const listAccountsTool = tool({
	name: "list_accounts",
	title: "List linked Google accounts",
	description:
		"Lists the linked Google accounts (alias and email address). Every other tool takes one of these aliases as `account`.",
	kind: "read",
	countKey: "accounts",
	schema: z.object({}),
	run: async (env) => ({
		accounts: (await listAccounts(env)).map(({ alias, email }) => ({ alias, email })),
	}),
});

export const ALL_TOOLS: ToolDef[] = [listAccountsTool, ...GMAIL_TOOLS, ...CALENDAR_TOOLS, ...DRIVE_TOOLS];
export const READ_TOOLS = ALL_TOOLS.filter((t) => t.kind === "read");
export const WRITE_TOOLS = ALL_TOOLS.filter((t) => t.kind === "write");

export type ToolResult = { content: McpContent[]; isError?: boolean };
export type ToolClient = { clientId?: string; clientName?: string } | undefined;

const failure = (message: string): ToolResult => ({
	content: [{ text: message, type: "text" }],
	isError: true,
});

const SWITCH_LABELS: Record<KillSwitch, string> = {
	DIRECT_SEND_ENABLED: "Sending without a draft (and replying)",
	DRIVE_SHARE_ENABLED: "Sharing Drive files",
	DRIVE_WRITE_ENABLED: "Changing Drive files",
	FORWARD_ENABLED: "Forwarding",
	WRITES_ENABLED: "All write actions",
};

export async function runTool(
	env: Env,
	client: ToolClient,
	name: string,
	rawArgs: unknown,
): Promise<ToolResult> {
	const definition = ALL_TOOLS.find((t) => t.name === name);
	if (!definition) return failure("Unknown tool.");
	const isWrite = definition.kind === "write";

	if (isWrite && !switchEnabled(env, "WRITES_ENABLED")) {
		console.warn(`tool=${name} error=writes_disabled`);
		return failure("Writes disabled: the owner has turned off all write actions. Nothing was changed.");
	}

	const parsed = definition.schema.safeParse(rawArgs ?? {});
	if (!parsed.success) {
		console.warn(`tool=${name} error=invalid_input`);
		const details = parsed.error.issues
			.slice(0, 5)
			.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
			.join("; ");
		return failure(`Invalid input: ${details}`.slice(0, 500));
	}
	const args = parsed.data as Record<string, unknown>;
	const alias = typeof args.account === "string" ? args.account : "";
	const clientId = client?.clientId;
	const who = isWrite
		? `tool=${name} alias=${alias} client=${clientId ?? "unknown"}`
		: `tool=${name}${alias ? ` alias=${alias}` : ""}`;

	const audit: AuditMeta = {};
	let reachedTool = false;
	let outcome = "ok";
	let resultCount: number | undefined;
	let result: ToolResult;
	try {
		if (!clientId) {
			// Every call must be attributable to a client in the audit log.
			throw new ToolError(
				"client_unknown",
				"This connection has no client identity. Disconnect and reconnect GoBridge in your AI client, then try again. Nothing was changed.",
			);
		}
		let accountEmail = "";
		if (alias) {
			const linked = await getAccount(env, alias);
			if (!linked) {
				throw new ToolError(
					"unknown_alias",
					`No linked account has the alias "${alias}". Use list_accounts to see the linked accounts.`,
				);
			}
			accountEmail = linked.email;
		}
		if (isWrite) {
			for (const name of definition.switches?.(args) ?? []) {
				if (!switchEnabled(env, name)) {
					throw new ToolError(
						"feature_disabled",
						`${SWITCH_LABELS[name]} is switched off by the owner (${name}). Nothing was changed.`,
					);
				}
			}
			await enforceWriteRateLimit(env, alias);
		} else {
			await enforceReadRateLimit(env, alias);
		}
		reachedTool = true;

		const output = await definition.run(env, args, {
			accountEmail,
			alias,
			audit,
			client: { clientId, clientName: client?.clientName ?? "" },
		});
		const asContent = output as { mcpContent?: McpContent[] } | null;
		if (asContent && Array.isArray(asContent.mcpContent)) {
			resultCount = 1;
			result = { content: asContent.mcpContent };
		} else {
			const list = (output as Record<string, unknown> | null)?.[definition.countKey ?? ""];
			resultCount = Array.isArray(list) ? list.length : 1;
			result = { content: [{ text: JSON.stringify(output, null, 1), type: "text" }] };
		}
		console.log(`${who} ok`);
	} catch (error) {
		outcome = error instanceof ToolError ? error.category : "internal";
		console.warn(`${who} error=${outcome}`);
		result = failure(
			error instanceof ToolError
				? error.message
				: isWrite
					? "Something went wrong inside GoBridge. Check the account before retrying: the action may or may not have happened."
					: "Something went wrong inside GoBridge. Nothing was changed.",
		);
	}

	if (reachedTool && clientId) {
		const clientName = client?.clientName ?? "";
		try {
			if (isWrite) {
				await recordAudit(env, { alias, clientId, clientName, meta: audit, outcome, tool: name });
			} else {
				await recordReadAudit(env, { alias, clientId, clientName, outcome, resultCount, tool: name });
			}
		} catch (_e) {
			console.error(`${who} error=audit_write_failed`);
		}
	}
	return result;
}

/** Convenience wrappers kept for tests. */
export const runReadTool = (env: Env, name: string, args: unknown, client?: ToolClient) =>
	runTool(env, client, name, args);
export const runWriteTool = (env: Env, client: ToolClient, name: string, args: unknown) =>
	runTool(env, client, name, args);

export function registerTools(server: McpServer, env: Env, client: () => ToolClient): void {
	for (const definition of ALL_TOOLS) {
		server.registerTool(
			definition.name,
			{
				annotations: {
					destructiveHint: definition.kind === "write" ? definition.destructive === true : false,
					openWorldHint: true,
					readOnlyHint: definition.kind === "read",
				},
				description: definition.description,
				inputSchema: definition.schema.shape,
				title: definition.title,
			},
			(args: unknown) => runTool(env, client(), definition.name, args),
		);
	}
}
