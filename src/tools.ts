/**
 * Tool registry and runner (PARITY.md): Gmail, Calendar, Drive, and, since
 * 2026-10-08, Docs, Sheets, Slides and Drive Activity.
 *
 * Every call goes through runTool, which enforces, in order: validation, a
 * known MCP client, a linked account, the feature switches (writes only), the
 * rate limit (reads and writes), and then records the call in the audit log.
 * Failures become short, safe messages: no stack traces, tokens, or raw Google
 * responses reach the client.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { aliasesNeedingRelink, getAccount, listAccounts } from "./accounts";
import { hasCurrentScopes, hasDriveActivityScope } from "./google";
import { ToolError } from "./google-api";
import {
	type AuditMeta,
	DAILY_SHARE_CAP,
	dailySendCap,
	enforceReadRateLimit,
	enforceWriteRateLimit,
	type KillSwitch,
	readRateLimit,
	recordAudit,
	recordReadAudit,
	switchEnabled,
	WRITE_RATE_LIMIT_PER_HOUR,
	writeUsage,
} from "./guardrails";
import { ACTIVITY_TOOLS } from "./tools/activity";
import { CALENDAR_TOOLS } from "./tools/calendar";
import { account, type McpContent, type ToolDef, tool } from "./tools/common";
import { DOCS_TOOLS } from "./tools/docs";
import { DRIVE_TOOLS } from "./tools/drive";
import { GMAIL_TOOLS } from "./tools/gmail";
import { SHEETS_TOOLS } from "./tools/sheets";
import { SLIDES_TOOLS } from "./tools/slides";
import { toolUiMeta, uiCardsMode } from "./ui/resources";
import { z } from "zod";

const listAccountsTool = tool({
	name: "list_accounts",
	title: "List linked Google accounts",
	description:
		"Lists the linked Google accounts (alias and email address). Every other tool takes one of these aliases as `account`.",
	kind: "read",
	countKey: "accounts",
	ui: "accounts",
	schema: z.object({}),
	run: async (env) => ({
		accounts: (await listAccounts(env)).map(({ alias, email }) => ({ alias, email })),
	}),
});

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"];
const CALENDAR_SCOPES = [
	"https://www.googleapis.com/auth/calendar.events",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	"https://www.googleapis.com/auth/calendar.freebusy",
];
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];

/**
 * App-only tool for the in-chat cards (owner-approved 2026-11-24). It exists
 * only while UI_CARDS is on, is marked `visibility: ["app"]` so hosts keep it
 * out of the model's tool list, and goes through runTool like every other
 * read: account alias, client id, read rate limit, audit_reads row.
 *
 * It returns ONLY numbers and booleans: usage counts, limits, feature
 * switches and which services the account's grant covers. Never an email
 * address, id, name or any content.
 */
export const CARD_STATUS_TOOL = tool({
	name: "get_card_status",
	title: "GoBridge card status",
	description:
		"For GoBridge's own in-chat cards. Returns one linked account's usage counts and limits, the feature switches, and which Google services its sign-in covers, as numbers and true/false values only. No email addresses, ids, names or content.",
	kind: "read",
	schema: z.object({ account }),
	run: async (env, args) => {
		const usage = await writeUsage(env, args.account);
		if (!usage) {
			throw new ToolError("counter_unavailable", "GoBridge could not read its usage counters. Try again in a moment.");
		}
		const scopes = (await getAccount(env, args.account))?.scopes;
		const has = (needed: string[]) => Array.isArray(scopes) && needed.every((scope) => scopes.includes(scope));
		const flagged = (await aliasesNeedingRelink(env)).includes(args.account);
		return {
			usage: {
				readsThisHour: usage.readsThisHour,
				writesThisHour: usage.writesThisHour,
				sendsToday: usage.sendsToday,
				sharesToday: usage.sharesToday,
			},
			limits: {
				readsPerHour: readRateLimit(env),
				writesPerHour: WRITE_RATE_LIMIT_PER_HOUR,
				sendsPerDay: dailySendCap(env),
				sharesPerDay: DAILY_SHARE_CAP,
			},
			switches: {
				writes: switchEnabled(env, "WRITES_ENABLED"),
				directSend: switchEnabled(env, "DIRECT_SEND_ENABLED"),
				forward: switchEnabled(env, "FORWARD_ENABLED"),
				driveWrite: switchEnabled(env, "DRIVE_WRITE_ENABLED"),
				driveShare: switchEnabled(env, "DRIVE_SHARE_ENABLED"),
			},
			services: {
				gmail: has(GMAIL_SCOPES),
				calendar: has(CALENDAR_SCOPES),
				drive: has(DRIVE_SCOPES),
				driveActivity: hasDriveActivityScope(scopes),
			},
			relinkNeeded: flagged || !hasCurrentScopes(scopes),
		};
	},
});

/** The tools this deployment exposes: the 72, plus get_card_status while cards are on. */
export function toolsFor(env: Env): ToolDef[] {
	return uiCardsMode(env) === "off" ? ALL_TOOLS : [...ALL_TOOLS, CARD_STATUS_TOOL];
}

export const ALL_TOOLS: ToolDef[] = [
	listAccountsTool,
	...GMAIL_TOOLS,
	...CALENDAR_TOOLS,
	...DRIVE_TOOLS,
	...DOCS_TOOLS,
	...SHEETS_TOOLS,
	...SLIDES_TOOLS,
	...ACTIVITY_TOOLS,
];
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
	const definition = toolsFor(env).find((t) => t.name === name);
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
	for (const definition of toolsFor(env)) {
		// Points hosts that support MCP Apps at the card for this tool. The
		// result itself is the same text for every client. get_card_status is
		// for the cards only: hosts hide an app-only tool from the model.
		const _meta = definition === CARD_STATUS_TOOL ? { ui: { visibility: ["app"] } } : toolUiMeta(env, definition.ui, definition.kind);
		server.registerTool(
			definition.name,
			{
				...(_meta ? { _meta } : {}),
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
