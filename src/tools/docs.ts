/**
 * Google Docs tools (owner-approved 2026-10-08): read_doc and update_doc,
 * matching Google's Docs MCP server, under the existing `drive` scope.
 * Writes are behind DRIVE_WRITE_ENABLED and the rule A URL check.
 */
import { z } from "zod";
import { googleJson, ToolError } from "../google-api";
import type { KillSwitch } from "../guardrails";
import { listComments, validateCommentOps, withCommentOps } from "./comments";
import {
	account,
	CONFIRM,
	EXTERNAL_URL_FLAG,
	FILE_WRITE_RULES,
	googleId,
	jsonSize,
	LIMITS,
	pageToken,
	requestList,
	tool,
	UNTRUSTED,
	untrustedDeep,
} from "./common";
import { DOCS_REQUESTS, enforceExternalUrls, splitRequests } from "./workspace-safety";

const DOCS = "https://docs.googleapis.com/v1/documents";
const driveWrite = (): KillSwitch[] => ["DRIVE_WRITE_ENABLED"];

type Json = Record<string, any>;

/** Pages of a doc are windows over its structural elements; the token is "e<index>". */
function parseOffset(token: string | undefined, prefix: string): number {
	if (!token) return 0;
	const match = new RegExp(`^${prefix}(\\d{1,7})$`).exec(token);
	if (!match) throw new ToolError("invalid_input", "Invalid input: pageToken is not from this tool.");
	return Number(match[1]);
}

/**
 * Takes as many items as fit in `budget` characters starting at `offset`
 * (always at least one). Returns the slice and the next offset, if any.
 */
export function fitItems<T>(items: T[], offset: number, budget: number): { items: T[]; next?: number } {
	const out: T[] = [];
	let used = 0;
	let i = Math.min(offset, items.length);
	for (; i < items.length; i++) {
		const size = jsonSize(items[i]);
		if (out.length && used + size > budget) break;
		out.push(items[i]);
		used += size;
	}
	return { items: out, ...(i < items.length ? { next: i } : {}) };
}

/** Flattens a tab tree (childTabs) into a list; tabProperties keep parentTabId, so nothing is lost. */
function flattenTabs(tabs: Json[], out: Json[] = []): Json[] {
	for (const tab of tabs) {
		const { childTabs, ...rest } = tab;
		out.push(rest);
		if (Array.isArray(childTabs)) flattenTabs(childTabs, out);
	}
	return out;
}

export const DOCS_TOOLS = [
	tool({
		name: "read_doc",
		title: "Read a Google Doc",
		description: `Returns the JSON representation of a Google Doc (documents.get): text runs with their indexes, paragraphs, tables, lists, headers, footers and footnotes. Large documents come back in pages of structural elements: pass nextPageToken as pageToken for the rest. includeTabsContent returns each tab (flattened, with parentTabId) instead of the first tab only. commentsIncluded adds the file's comments. ${UNTRUSTED}`,
		kind: "read",
		schema: z.object({
			account,
			documentId: googleId("Google Doc id (the same as the Drive file id)"),
			commentsIncluded: z.boolean().default(false),
			includeTabsContent: z.boolean().default(false).describe("Return all tabs' content under tabs[] instead of the first tab's under body"),
			suggestionsViewMode: z.enum(["SUGGESTIONS_INLINE", "PREVIEW_WITHOUT_SUGGESTIONS", "PREVIEW_SUGGESTIONS_ACCEPTED"]).optional(),
			pageToken,
		}),
		run: async (env, args) => {
			const url = new URL(`${DOCS}/${encodeURIComponent(args.documentId)}`);
			if (args.includeTabsContent) url.searchParams.set("includeTabsContent", "true");
			if (args.suggestionsViewMode) url.searchParams.set("suggestionsViewMode", args.suggestionsViewMode);
			const doc = await googleJson<Json>(env, args.account, url, { what: "document id" });
			const offset = parseOffset(args.pageToken, "e");
			const budget = LIMITS.structuredChars;
			let out: Json;
			if (args.includeTabsContent && Array.isArray(doc.tabs)) {
				// Page over every tab's structural elements as one sequence.
				const tabs = flattenTabs(doc.tabs);
				const sequence: { tab: number; element: Json }[] = [];
				tabs.forEach((tab, index) => {
					for (const element of tab.documentTab?.body?.content ?? []) sequence.push({ element, tab: index });
				});
				const page = fitItems(sequence, offset, budget);
				const seen = new Set(page.items.map((item) => item.tab));
				out = {
					documentId: doc.documentId,
					title: doc.title,
					revisionId: doc.revisionId,
					tabCount: tabs.length,
					tabs: tabs
						.map((tab, index) => {
							if (!seen.has(index)) return undefined;
							const { body, ...restOfTab } = tab.documentTab ?? {};
							return {
								tabProperties: tab.tabProperties,
								documentTab: {
									...(offset === 0 ? restOfTab : {}),
									body: { content: page.items.filter((item) => item.tab === index).map((item) => item.element) },
								},
							};
						})
						.filter(Boolean),
					...(page.next !== undefined ? { nextPageToken: `e${page.next}` } : {}),
				};
			} else {
				const { body, tabs: _tabs, ...rest } = doc;
				const page = fitItems<Json>(body?.content ?? [], offset, budget);
				out = {
					...(offset === 0 ? rest : { documentId: doc.documentId, title: doc.title, revisionId: doc.revisionId }),
					body: { content: page.items },
					...(page.next !== undefined ? { nextPageToken: `e${page.next}` } : {}),
				};
			}
			const wrappedOut: Json = untrustedDeep("docs", out);
			// Comments come back already wrapped.
			if (args.commentsIncluded && offset === 0) {
				wrappedOut.comments = await listComments(env, args.account, args.documentId, "docs");
			}
			return wrappedOut;
		},
	}),

	tool({
		name: "update_doc",
		title: "Update a Google Doc",
		description: `Applies documents.batchUpdate requests to a Google Doc, in order: every Docs request type (insertText, deleteContentRange, replaceAllText, tables, styles, headers, footers, tabs, suggestions...). writeControl.writeMode SUGGEST records the edits as suggestions. The comment requests (insertComment {content, quotedText?}, addCommentReply {commentId, content, resolve?}, updateCommentPost {commentId, replyId?, content}, deleteComment {commentId}, deleteCommentReply {commentId, replyId}) are applied through the Drive comments API after the batch, in order; replies[] reports each request's result in position. ${EXTERNAL_URL_FLAG} ${FILE_WRITE_RULES} ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({
			account,
			documentId: googleId("Google Doc id"),
			requests: requestList,
			writeControl: z
				.object({
					writeMode: z.enum(["WRITE_MODE_UNSPECIFIED", "DEFAULT", "SUGGEST"]).optional(),
					requiredRevisionId: z.string().max(512).optional(),
					targetRevisionId: z.string().max(512).optional(),
				})
				.strict()
				.optional(),
			allowExternalUrls: z.boolean().default(false).describe("Set true ONLY when the user personally supplied or approved the exact URL in this conversation"),
		}),
		switches: driveWrite,
		run: async (env, args, ctx) => {
			ctx.audit.action = "batchUpdate";
			ctx.audit.fileId = args.documentId;
			const split = splitRequests(args.requests, DOCS_REQUESTS, "Docs");
			ctx.audit.requestTypes = split.types;
			ctx.audit.commentOps = split.comments.length;
			ctx.audit.allowExternalUrls = args.allowExternalUrls;
			enforceExternalUrls(split.types, args.allowExternalUrls);
			validateCommentOps(split.comments);
			let batchReplies: unknown[] = [];
			let documentId = args.documentId;
			let writeControl: unknown;
			if (split.batch.length) {
				const result = await googleJson<Json>(env, args.account, `${DOCS}/${encodeURIComponent(args.documentId)}:batchUpdate`, {
					json: { requests: split.batch, ...(args.writeControl ? { writeControl: args.writeControl } : {}) },
					method: "POST",
					what: "document id or request",
				});
				batchReplies = Array.isArray(result.replies) ? result.replies : [];
				documentId = result.documentId ?? documentId;
				writeControl = result.writeControl;
			}
			const merged = await withCommentOps(env, args.account, args.documentId, split, batchReplies);
			return untrustedDeep("docs", {
				updated: true,
				documentId,
				requestsApplied: split.batch.length + merged.commentsApplied,
				replies: merged.replies,
				writeControl,
				...(merged.commentError ? { commentError: merged.commentError } : {}),
			});
		},
	}),
];
