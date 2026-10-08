/**
 * Comments on Google Docs, Sheets and Slides files, through the Drive v3
 * comments and replies API (the batchUpdate APIs have no comment requests;
 * Google's MCP servers accept them, so GoBridge routes them here).
 * Uses the existing `drive` scope.
 */
import { z } from "zod";
import { googleJson, ToolError } from "../google-api";
import { cap, LIMITS, type UntrustedSource, untrusted } from "./common";
import type { COMMENT_REQUESTS, Request } from "./workspace-safety";

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const FIELDS =
	"comments(id,createdTime,modifiedTime,resolved,author(emailAddress,displayName),content,quotedFileContent(value),anchor,replies(id,author(displayName),content,createdTime,action))";

type Json = Record<string, any>;

/** The comments on one file, capped and wrapped. */
export async function listComments(env: Env, alias: string, fileId: string, source: UntrustedSource) {
	const data = await googleJson<{ comments?: Json[] }>(
		env,
		alias,
		`${DRIVE}/${encodeURIComponent(fileId)}/comments?pageSize=${LIMITS.comments}&fields=${encodeURIComponent(FIELDS)}`,
		{ what: "file id" },
	);
	return (data.comments ?? []).slice(0, LIMITS.comments).map((c) => ({
		id: c.id,
		createdTime: c.createdTime,
		modifiedTime: c.modifiedTime,
		resolved: c.resolved,
		author: untrusted(source, cap(c.author?.displayName ?? c.author?.emailAddress, LIMITS.headerChars)),
		quoted: untrusted(source, cap(c.quotedFileContent?.value, 500)),
		content: untrusted(source, cap(c.content, 2000)),
		replies: Array.isArray(c.replies)
			? c.replies.slice(0, 20).map((r: Json) => ({
					id: r?.id,
					author: untrusted(source, cap(r?.author?.displayName, 200)),
					content: untrusted(source, cap(r?.content, 2000)),
					createdTime: r?.createdTime,
					action: r?.action,
				}))
			: undefined,
	}));
}

const commentId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "must be a comment id");
const content = z.string().min(1).max(10_000);

/**
 * The shape GoBridge accepts for each comment request. Google's pages give
 * `requests[]` only as an opaque object, so these are GoBridge's definitions.
 */
const SHAPES = {
	insertComment: z.object({ content, quotedText: z.string().max(2000).optional() }).strict(),
	addCommentReply: z.object({ commentId, content, resolve: z.boolean().optional() }).strict(),
	updateCommentPost: z.object({ commentId, replyId: commentId.optional(), content }).strict(),
	deleteComment: z.object({ commentId }).strict(),
	deleteCommentReply: z.object({ commentId, replyId: commentId }).strict(),
} as const;

export type CommentOp = { index: number; type: (typeof COMMENT_REQUESTS)[number]; body: Request };

/** Validates every comment request before anything is sent. */
export function validateCommentOps(ops: CommentOp[]): void {
	for (const op of ops) {
		const parsed = SHAPES[op.type].safeParse(op.body);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			throw new ToolError(
				"invalid_input",
				`Invalid input: requests[${op.index}].${op.type}${issue?.path.length ? `.${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid"}`,
			);
		}
	}
}

/**
 * Applies validated comment requests one by one, in order. Returns one reply
 * per request (ids only; never the text). Stops at the first failure and
 * reports how many succeeded, so the caller can say what did happen.
 */
export async function applyCommentOps(
	env: Env,
	alias: string,
	fileId: string,
	ops: CommentOp[],
): Promise<{ replies: Record<string, unknown>[]; applied: number }> {
	const base = `${DRIVE}/${encodeURIComponent(fileId)}/comments`;
	const replies: Record<string, unknown>[] = [];
	for (const op of ops) {
		const body = SHAPES[op.type].parse(op.body) as Json;
		switch (op.type) {
			case "insertComment": {
				const created = await googleJson<Json>(env, alias, `${base}?fields=id`, {
					json: { content: body.content, ...(body.quotedText ? { quotedFileContent: { value: body.quotedText } } : {}) },
					method: "POST",
					what: "file id",
				});
				replies.push({ insertComment: { commentId: created.id } });
				break;
			}
			case "addCommentReply": {
				const created = await googleJson<Json>(env, alias, `${base}/${encodeURIComponent(body.commentId)}/replies?fields=id`, {
					json: { content: body.content, ...(body.resolve === undefined ? {} : { action: body.resolve ? "resolve" : "reopen" }) },
					method: "POST",
					what: "comment id",
				});
				replies.push({ addCommentReply: { commentId: body.commentId, replyId: created.id } });
				break;
			}
			case "updateCommentPost": {
				const url = body.replyId
					? `${base}/${encodeURIComponent(body.commentId)}/replies/${encodeURIComponent(body.replyId)}?fields=id`
					: `${base}/${encodeURIComponent(body.commentId)}?fields=id`;
				await googleJson<Json>(env, alias, url, { json: { content: body.content }, method: "PATCH", what: "comment or reply id" });
				replies.push({ updateCommentPost: { commentId: body.commentId, ...(body.replyId ? { replyId: body.replyId } : {}) } });
				break;
			}
			case "deleteComment":
				await googleJson<Json>(env, alias, `${base}/${encodeURIComponent(body.commentId)}`, { method: "DELETE", what: "comment id" });
				replies.push({ deleteComment: { commentId: body.commentId } });
				break;
			case "deleteCommentReply":
				await googleJson<Json>(env, alias, `${base}/${encodeURIComponent(body.commentId)}/replies/${encodeURIComponent(body.replyId)}`, {
					method: "DELETE",
					what: "comment or reply id",
				});
				replies.push({ deleteCommentReply: { commentId: body.commentId, replyId: body.replyId } });
				break;
		}
	}
	return { applied: replies.length, replies };
}

/**
 * Runs a batchUpdate followed by the comment requests, and merges the replies
 * back into one list in the original request order.
 */
export async function withCommentOps(
	env: Env,
	alias: string,
	fileId: string,
	split: { batch: Request[]; comments: CommentOp[] },
	batchReplies: unknown[],
): Promise<{ replies: unknown[]; commentsApplied: number; commentError?: string }> {
	const replies: unknown[] = [];
	let batchIndex = 0;
	const commentAt = new Map(split.comments.map((op) => [op.index, op]));
	const total = split.batch.length + split.comments.length;
	let commentReplies: Record<string, unknown>[] = [];
	let commentError: string | undefined;
	let applied = 0;
	if (split.comments.length) {
		try {
			const result = await applyCommentOps(env, alias, fileId, split.comments);
			commentReplies = result.replies;
			applied = result.applied;
		} catch (error) {
			commentError = error instanceof ToolError ? error.message : "A comment request failed.";
		}
	}
	let commentIndex = 0;
	for (let i = 0; i < total; i++) {
		if (commentAt.has(i)) {
			replies.push(commentReplies[commentIndex] ?? { [commentAt.get(i)!.type]: { applied: false } });
			commentIndex += 1;
		} else {
			replies.push(batchReplies[batchIndex] ?? {});
			batchIndex += 1;
		}
	}
	return { commentsApplied: applied, replies, ...(commentError ? { commentError } : {}) };
}
