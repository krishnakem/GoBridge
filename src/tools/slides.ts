/**
 * Google Slides tools (owner-approved 2026-10-08): read_presentation,
 * read_slide_page, read_slide_page_thumbnail and update_presentation,
 * matching Google's Slides MCP server, under the existing `drive` scope.
 * Writes are behind DRIVE_WRITE_ENABLED and the rule A URL check.
 */
import { z } from "zod";
import { googleJson, ToolError } from "../google-api";
import type { KillSwitch } from "../guardrails";
import { listComments, validateCommentOps, withCommentOps } from "./comments";
import {
	account,
	base64,
	CONFIRM,
	EXTERNAL_URL_FLAG,
	FILE_WRITE_RULES,
	googleId,
	jsonSize,
	LIMITS,
	pageToken,
	requestList,
	singleLine,
	tool,
	UNTRUSTED,
	untrustedDeep,
} from "./common";
import { fitItems } from "./docs";
import { enforceExternalUrls, SLIDES_REQUESTS, splitRequests } from "./workspace-safety";

const SLIDES = "https://slides.googleapis.com/v1/presentations";
const driveWrite = (): KillSwitch[] => ["DRIVE_WRITE_ENABLED"];

type Json = Record<string, any>;

/** A Slides/Docs field mask: paths, commas, parentheses, slashes. */
const fieldMask = z.array(singleLine(200).regex(/^[A-Za-z0-9_.,()/*]+$/, "must be a field mask path")).max(50);

/** True only for Google's own image hosts, where thumbnail content URLs live. */
export function isGoogleUserContentUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && (url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"));
	} catch (_e) {
		return false;
	}
}

/** Downloads at most `maxBytes`; throws if the body is longer. */
async function readBytes(resp: Response, maxBytes: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = resp.body?.getReader();
	if (!reader) return new Uint8Array();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new ToolError("too_large", `The thumbnail is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit. Ask for a smaller thumbnailSize.`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function pageUrl(presentationId: string, pageId: string, suffix = "") {
	return `${SLIDES}/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageId)}${suffix}`;
}

export const SLIDES_TOOLS = [
	tool({
		name: "read_presentation",
		title: "Read a Google Slides presentation",
		description: `Returns the JSON representation of a presentation (presentations.get): title, page size, and each slide's page elements with their text. Slides come back in pages: pass nextPageToken as pageToken for the rest. Without fields, layouts and masters are summarised to their ids and names to keep the output small; pass fields (e.g. ["slides.objectId", "slides.pageElements.shape.text"]) to choose exactly what comes back. commentsIncluded adds the file's comments. ${UNTRUSTED}`,
		kind: "read",
		schema: z.object({
			account,
			presentationId: googleId("Google Slides presentation id (the same as the Drive file id)"),
			fields: fieldMask.optional().describe("Field mask paths matching the Slides REST resource, e.g. slides.pageElements.shape.text"),
			commentsIncluded: z.boolean().default(false),
			pageToken,
		}),
		run: async (env, args) => {
			const url = new URL(`${SLIDES}/${encodeURIComponent(args.presentationId)}`);
			if (args.fields?.length) url.searchParams.set("fields", args.fields.join(","));
			const deck = await googleJson<Json>(env, args.account, url, { what: "presentation id" });
			const match = /^s(\d{1,6})$/.exec(args.pageToken ?? "");
			if (args.pageToken && !match) throw new ToolError("invalid_input", "Invalid input: pageToken is not from this tool.");
			const offset = match ? Number(match[1]) : 0;
			const { slides, layouts, masters, notesMaster, ...rest } = deck;
			const summarise = (pages: unknown) =>
				Array.isArray(pages)
					? pages.map((p: Json) => ({ objectId: p?.objectId, name: p?.layoutProperties?.name ?? p?.masterProperties?.displayName, displayName: p?.layoutProperties?.displayName }))
					: undefined;
			const page = fitItems<Json>(Array.isArray(slides) ? slides : [], offset, LIMITS.structuredChars);
			const out: Json = {
				...(offset === 0 ? rest : { presentationId: deck.presentationId, title: deck.title }),
				slideCount: Array.isArray(slides) ? slides.length : 0,
				slides: page.items,
				...(offset === 0 && !args.fields?.length ? { layouts: summarise(layouts), masters: summarise(masters), notesMasterId: notesMaster?.objectId } : {}),
				...(offset === 0 && args.fields?.length ? { layouts, masters, notesMaster } : {}),
				...(page.next !== undefined ? { nextPageToken: `s${page.next}` } : {}),
			};
			const wrappedOut: Json = untrustedDeep("slides", out);
			// Comments come back already wrapped.
			if (args.commentsIncluded && offset === 0) wrappedOut.comments = await listComments(env, args.account, args.presentationId, "slides");
			return wrappedOut;
		},
	}),

	tool({
		name: "read_slide_page",
		title: "Read one slide",
		description: `Returns the JSON representation of one slide or page (presentations.pages.get): its page elements, text, properties and notes page. fields narrows what comes back. If the page is too large, pageElements are cut and truncated is true: use fields. commentsIncluded adds the file's comments. ${UNTRUSTED}`,
		kind: "read",
		schema: z.object({
			account,
			presentationId: googleId("Google Slides presentation id"),
			pageId: googleId("slide page object id"),
			fields: fieldMask.optional().describe("Field mask paths, e.g. pageElements(objectId,shape.text)"),
			commentsIncluded: z.boolean().default(false),
		}),
		run: async (env, args) => {
			const url = new URL(pageUrl(args.presentationId, args.pageId));
			if (args.fields?.length) url.searchParams.set("fields", args.fields.join(","));
			const page = await googleJson<Json>(env, args.account, url, { what: "presentation or page id" });
			let out: Json = page;
			if (jsonSize(page) > LIMITS.structuredChars && Array.isArray(page.pageElements)) {
				const fit = fitItems<Json>(page.pageElements, 0, LIMITS.structuredChars);
				out = { ...page, pageElements: fit.items, truncated: true };
			}
			const wrappedOut: Json = untrustedDeep("slides", out);
			if (args.commentsIncluded) wrappedOut.comments = await listComments(env, args.account, args.presentationId, "slides");
			return wrappedOut;
		},
	}),

	tool({
		name: "read_slide_page_thumbnail",
		title: "Render one slide as an image",
		description: `Renders one slide as a PNG image (presentations.pages.getThumbnail) and returns the image itself with its width and height. GoBridge fetches the image server-side from Google only; no URL is returned. Images over 5 MB are refused: ask for a smaller thumbnailSize.`,
		kind: "read",
		schema: z.object({
			account,
			presentationId: googleId("Google Slides presentation id"),
			pageId: googleId("slide page object id"),
			thumbnailProperties: z
				.object({
					mimeType: z.enum(["MIME_TYPE_UNSPECIFIED", "PNG"]).optional(),
					thumbnailSize: z.enum(["THUMBNAIL_SIZE_UNSPECIFIED", "LARGE", "MEDIUM", "SMALL", "WIDTH2000_PX"]).optional(),
				})
				.strict()
				.optional(),
		}),
		run: async (env, args) => {
			const url = new URL(pageUrl(args.presentationId, args.pageId, "/thumbnail"));
			if (args.thumbnailProperties?.mimeType) url.searchParams.set("thumbnailProperties.mimeType", args.thumbnailProperties.mimeType);
			if (args.thumbnailProperties?.thumbnailSize) url.searchParams.set("thumbnailProperties.thumbnailSize", args.thumbnailProperties.thumbnailSize);
			const meta = await googleJson<Json>(env, args.account, url, { what: "presentation or page id" });
			if (!isGoogleUserContentUrl(meta.contentUrl)) {
				// Never fetch anywhere but Google's own image host; never say where it pointed.
				throw new ToolError("google_error", "Google returned a thumbnail location GoBridge does not accept. Nothing was fetched.");
			}
			let resp: Response;
			try {
				// The content URL is a short-lived signed link: no account token is sent with it.
				resp = await fetch(meta.contentUrl as string, { redirect: "manual" });
			} catch (_e) {
				throw new ToolError("google_error", "Could not fetch the thumbnail from Google. Try again in a moment.");
			}
			if (!resp.ok) {
				await resp.body?.cancel();
				throw new ToolError("google_error", "Google did not serve the thumbnail. Try again in a moment.");
			}
			const bytes = await readBytes(resp, LIMITS.imageBytes);
			const summary = { presentationId: args.presentationId, pageId: args.pageId, widthPx: meta.widthPx, heightPx: meta.heightPx, bytes: bytes.byteLength };
			return { mcpContent: [{ data: base64(bytes), mimeType: "image/png", type: "image" as const }, { text: JSON.stringify(summary, null, 1), type: "text" as const }] };
		},
	}),

	tool({
		name: "update_presentation",
		title: "Update a Google Slides presentation",
		description: `Applies presentations.batchUpdate requests to a presentation, in order: every Slides request type (createSlide, createShape, insertText, deleteObject, replaceAllText, tables, transforms, styles, importSlides...). The comment requests (insertComment {content, quotedText?}, addCommentReply {commentId, content, resolve?}, updateCommentPost {commentId, replyId?, content}, deleteComment {commentId}, deleteCommentReply {commentId, replyId}) are applied through the Drive comments API after the batch, in order; replies[] reports each request's result in position. ${EXTERNAL_URL_FLAG} ${FILE_WRITE_RULES} ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({
			account,
			presentationId: googleId("Google Slides presentation id"),
			requests: requestList,
			writeControl: z.object({ requiredRevisionId: z.string().max(512).optional() }).strict().optional(),
			allowExternalUrls: z.boolean().default(false).describe("Set true ONLY when the user personally supplied or approved the exact URL in this conversation"),
		}),
		switches: driveWrite,
		run: async (env, args, ctx) => {
			ctx.audit.action = "batchUpdate";
			ctx.audit.fileId = args.presentationId;
			const split = splitRequests(args.requests, SLIDES_REQUESTS, "Slides");
			ctx.audit.requestTypes = split.types;
			ctx.audit.commentOps = split.comments.length;
			ctx.audit.allowExternalUrls = args.allowExternalUrls;
			enforceExternalUrls(split.types, args.allowExternalUrls);
			validateCommentOps(split.comments);
			let batchReplies: unknown[] = [];
			let writeControl: unknown;
			if (split.batch.length) {
				const result = await googleJson<Json>(env, args.account, `${SLIDES}/${encodeURIComponent(args.presentationId)}:batchUpdate`, {
					json: { requests: split.batch, ...(args.writeControl ? { writeControl: args.writeControl } : {}) },
					method: "POST",
					what: "presentation id or request",
				});
				batchReplies = Array.isArray(result.replies) ? result.replies : [];
				writeControl = result.writeControl;
			}
			const merged = await withCommentOps(env, args.account, args.presentationId, split, batchReplies);
			return untrustedDeep("slides", {
				updated: true,
				presentationId: args.presentationId,
				requestsApplied: split.batch.length + merged.commentsApplied,
				replies: merged.replies,
				writeControl,
				...(merged.commentError ? { commentError: merged.commentError } : {}),
			});
		},
	}),
];
