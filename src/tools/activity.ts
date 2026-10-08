/**
 * Drive Activity (owner-approved 2026-10-08): query_drive_activity, the one
 * tool that uses the drive.activity.readonly scope. Accounts linked before
 * that scope existed keep every other tool and get a re-link hint here.
 * Actors are reported as "you", a People id, or a kind; no People API calls.
 */
import { z } from "zod";
import { getAccount } from "../accounts";
import { hasDriveActivityScope } from "../google";
import { googleJson, ToolError } from "../google-api";
import { account, cap, googleId, LIMITS, pageSize, pageToken, singleLine, tool, UNTRUSTED, untrusted } from "./common";

const QUERY_URL = "https://driveactivity.googleapis.com/v2/activity:query";

type Json = Record<string, any>;

const itemId = (value: unknown) => (typeof value === "string" ? value.replace(/^items\//, "") : undefined);

function shapeItem(item: Json | undefined) {
	if (!item) return undefined;
	return {
		id: itemId(item.name),
		title: untrusted("activity", cap(item.title, LIMITS.headerChars)),
		mimeType: cap(item.mimeType, 100),
		kind: item.driveFile ? "file" : item.driveFolder ? "folder" : undefined,
	};
}

function shapeTarget(target: Json) {
	if (target.driveItem) return { type: "driveItem", ...shapeItem(target.driveItem) };
	if (target.fileComment) {
		return { type: "fileComment", parent: shapeItem(target.fileComment.parent), legacyCommentId: cap(target.fileComment.legacyCommentId, 100) };
	}
	if (target.drive) return { type: "drive", id: cap(target.drive.name, 100), title: untrusted("activity", cap(target.drive.title, LIMITS.headerChars)) };
	return { type: "unknown" };
}

function shapeActor(actor: Json): string {
	const known = actor.user?.knownUser;
	if (known) return known.isCurrentUser ? "you" : `person:${String(known.personName ?? "").replace(/^people\//, "").slice(0, 64)}`;
	if (actor.user?.deletedUser) return "deleted user";
	if (actor.user?.unknownUser) return "unknown user";
	if (actor.anonymous) return "anonymous";
	if (actor.administrator) return "administrator";
	if (actor.impersonation) return "impersonation";
	if (actor.system) return "system";
	return "unknown";
}

function permissionSummary(p: Json) {
	const type = p.user ? "user" : p.group ? "group" : p.domain ? "domain" : p.anyone ? "anyone" : "unknown";
	const who = p.user ? shapeActor({ user: p.user }) : undefined;
	return { role: cap(p.role, 40), type, who, allowDiscovery: p.allowDiscovery };
}

/** The action detail without any free text beyond titles (wrapped). */
function shapeDetail(detail: Json | undefined): { type: string; detail?: Json } {
	if (!detail) return { type: "unknown" };
	const type = Object.keys(detail)[0] ?? "unknown";
	const body = detail[type] ?? {};
	switch (type) {
		case "move":
			return {
				type,
				detail: {
					addedParents: (body.addedParents ?? []).slice(0, 10).map((p: Json) => shapeItem(p.driveItem)),
					removedParents: (body.removedParents ?? []).slice(0, 10).map((p: Json) => shapeItem(p.driveItem)),
				},
			};
		case "rename":
			return { type, detail: { oldTitle: untrusted("activity", cap(body.oldTitle, LIMITS.headerChars)), newTitle: untrusted("activity", cap(body.newTitle, LIMITS.headerChars)) } };
		case "permissionChange":
			return {
				type,
				detail: {
					addedPermissions: (body.addedPermissions ?? []).slice(0, 20).map(permissionSummary),
					removedPermissions: (body.removedPermissions ?? []).slice(0, 20).map(permissionSummary),
				},
			};
		case "create":
		case "edit":
		case "delete":
		case "restore":
		case "comment":
		case "dlpChange":
		case "reference":
		case "settingsChange":
		case "appliedLabelChange":
			return { type, detail: { subtype: Object.keys(body)[0] } };
		default:
			return { type };
	}
}

export const ACTIVITY_TOOLS = [
	tool({
		name: "query_drive_activity",
		title: "Query Drive activity",
		description: `Lists recent activity on one Drive file (itemName) or on a folder and everything inside it (ancestorName): who did what and when (create, edit, rename, move, comment, permission changes, delete, restore). Actors are "you", "person:<people id>", "anonymous" or a kind; names are not looked up. filter uses the Drive Activity syntax, e.g. time > "2026-10-01T00:00:00Z" AND detail.action_detail_case:(EDIT RENAME). Needs the Drive Activity permission: accounts linked before 2026-10-08 must be re-linked at /link for this one tool. ${UNTRUSTED}`,
		kind: "read",
		countKey: "activities",
		schema: z.object({
			account,
			itemName: googleId("Drive file or folder id").optional().describe("Activity on this one item"),
			ancestorName: googleId("Drive folder id").optional().describe("Activity on this folder and everything under it"),
			filter: singleLine(500).optional().describe("Drive Activity filter, e.g. time > \"2026-10-01T00:00:00Z\" AND detail.action_detail_case:RENAME"),
			pageSize: pageSize(LIMITS.activities, 20),
			pageToken,
		}),
		run: async (env, args) => {
			if (!!args.itemName === !!args.ancestorName) {
				throw new ToolError("invalid_input", "Invalid input: give exactly one of itemName (a file or folder) or ancestorName (a folder and its contents).");
			}
			const linked = await getAccount(env, args.account);
			if (!linked || !hasDriveActivityScope(linked.scopes)) {
				throw new ToolError(
					"relink_required",
					`Re-link this account to enable Drive Activity: "${args.account}" was linked before that permission existed. The owner can re-link it at /link; every other tool keeps working meanwhile.`,
				);
			}
			const data = await googleJson<{ activities?: Json[]; nextPageToken?: string }>(env, args.account, QUERY_URL, {
				json: {
					...(args.itemName ? { itemName: `items/${args.itemName}` } : { ancestorName: `items/${args.ancestorName}` }),
					...(args.filter ? { filter: args.filter } : {}),
					pageSize: args.pageSize,
					...(args.pageToken ? { pageToken: args.pageToken } : {}),
				},
				method: "POST",
				what: "item id or filter",
			});
			return {
				activities: (data.activities ?? []).slice(0, args.pageSize).map((a) => ({
					time: a.timestamp ?? (a.timeRange ? { start: a.timeRange.startTime, end: a.timeRange.endTime } : undefined),
					primaryAction: shapeDetail(a.primaryActionDetail),
					actions: Array.isArray(a.actions) ? a.actions.slice(0, 20).map((action: Json) => shapeDetail(action.detail).type) : [],
					actors: Array.isArray(a.actors) ? a.actors.slice(0, 20).map(shapeActor) : [],
					targets: Array.isArray(a.targets) ? a.targets.slice(0, 20).map(shapeTarget) : [],
				})),
				nextPageToken: data.nextPageToken,
			};
		},
	}),
];
