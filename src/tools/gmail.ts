/**
 * Gmail tools (PARITY.md): 30 tools matching Google's Gmail connector.
 *
 * Sending happens three ways (draft, direct, reply) plus forward; each counts
 * against the daily send cap and the direct and forward paths have their own
 * kill switches. There is no permanent deletion of messages.
 */
import { z } from "zod";
import { b64urlDecode, b64urlEncode, randomToken } from "../crypto";
import { googleJson, googleRequest, ToolError } from "../google-api";
import { reserveDailySend } from "../guardrails";
import {
	account,
	assertRecipientLimit,
	base64,
	cap,
	capBody,
	CONFIRM,
	decodeBase64,
	email,
	googleId,
	LIMITS,
	pageSize,
	pageToken,
	recipients,
	singleLine,
	stripHtml,
	tool,
	type ToolContext,
	UNTRUSTED,
	untrusted,
} from "./common";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_PATH = "/gmail/v1/users/me";
const BATCH = "https://gmail.googleapis.com/batch/gmail/v1";
const encoder = new TextEncoder();

const viewUrl = (ctx: ToolContext, id: string | undefined) =>
	id ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(ctx.accountEmail)}#all/${id}` : undefined;

// ---------- Google message parsing ----------

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
	partId?: string;
	mimeType?: string;
	filename?: string;
	headers?: GmailHeader[];
	body?: { data?: string; size?: number; attachmentId?: string };
	parts?: GmailPart[];
};
export type GmailMessage = {
	id?: string;
	threadId?: string;
	labelIds?: string[];
	snippet?: string;
	payload?: GmailPart;
	raw?: string;
	internalDate?: string;
};

function header(part: GmailPart | undefined, name: string): string {
	const found = part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
	return typeof found?.value === "string" ? found.value : "";
}
const h = (message: GmailMessage | undefined, name: string) =>
	cap(header(message?.payload, name), LIMITS.headerChars);

function decodePart(part: GmailPart): string {
	if (!part.body?.data) return "";
	try {
		const bytes = b64urlDecode(part.body.data.replace(/=+$/, ""));
		const charset = /charset="?([\w-]+)"?/i.exec(header(part, "Content-Type"))?.[1] ?? "utf-8";
		try {
			return new TextDecoder(charset).decode(bytes);
		} catch (_e) {
			return new TextDecoder().decode(bytes);
		}
	} catch (_e) {
		return "";
	}
}

type Attachment = { filename: string; mimeType: string; size: number; attachmentId?: string; partId?: string };

/** Plain text, HTML, and attachment list of a message. */
function extractBody(payload: GmailPart | undefined): { plain: string; html: string; attachments: Attachment[] } {
	let plain = "";
	let html = "";
	const attachments: Attachment[] = [];
	const visit = (part: GmailPart | undefined, depth: number) => {
		if (!part || depth > 10) return;
		if (part.filename) {
			if (attachments.length < LIMITS.attachments) {
				attachments.push({
					attachmentId: part.body?.attachmentId,
					filename: cap(part.filename, 200),
					mimeType: part.mimeType ?? "application/octet-stream",
					partId: part.partId,
					size: part.body?.size ?? 0,
				});
			}
			return;
		}
		if (part.mimeType === "text/plain" && !plain) plain = decodePart(part);
		else if (part.mimeType === "text/html" && !html) html = decodePart(part);
		for (const child of part.parts ?? []) visit(child, depth + 1);
	};
	visit(payload, 0);
	return { attachments, html, plain };
}

const MESSAGE_FORMATS = ["MINIMAL", "METADATA_ONLY", "FULL_CONTENT", "PLAIN_TEXT", "RAW"] as const;
type MessageFormat = (typeof MESSAGE_FORMATS)[number];
const messageFormat = z.enum(MESSAGE_FORMATS).default("PLAIN_TEXT");
const draftFormat = z.enum(["MINIMAL", "METADATA_ONLY", "FULL_CONTENT", "PLAIN_TEXT"]).default("PLAIN_TEXT");
const HEADERS = "metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date";

function formatQuery(format: MessageFormat): string {
	switch (format) {
		case "MINIMAL":
			return "format=minimal";
		case "METADATA_ONLY":
			return `format=metadata&${HEADERS}`;
		case "RAW":
			return "format=raw";
		default:
			return "format=full";
	}
}

/** Shapes a Google message for the given format. External text is wrapped. */
function shapeMessage(message: GmailMessage, format: MessageFormat, ctx: ToolContext, bodyChars: number = LIMITS.bodyChars) {
	const basic = {
		id: message.id,
		threadId: message.threadId,
		labelIds: (message.labelIds ?? []).slice(0, 20),
		snippet: untrusted("email", cap(message.snippet, LIMITS.snippetChars)),
		viewUrl: viewUrl(ctx, message.id),
	};
	if (format === "MINIMAL") return { ...basic, bodyChars: 0 };
	if (format === "RAW") {
		const raw = capBody(message.raw ?? "", LIMITS.rawChars);
		return { ...basic, raw: untrusted("email", raw.text), rawTruncated: raw.truncated, bodyChars: raw.text.length };
	}
	const meta = {
		...basic,
		from: untrusted("email", h(message, "From")),
		to: untrusted("email", h(message, "To")),
		cc: untrusted("email", h(message, "Cc")),
		subject: untrusted("email", h(message, "Subject")),
		date: h(message, "Date"),
	};
	if (format === "METADATA_ONLY") return { ...meta, bodyChars: 0 };
	const { plain, html, attachments } = extractBody(message.payload);
	const text = capBody(plain.trim() ? plain : stripHtml(html), bodyChars);
	const shaped = {
		...meta,
		body: untrusted("email", text.text),
		bodyTruncated: text.truncated,
		attachments: attachments.map((a) => ({
			filename: untrusted("email", a.filename),
			mimeType: a.mimeType,
			size: a.size,
		})),
		bodyChars: text.text.length,
	};
	if (format === "PLAIN_TEXT") return shaped;
	const htmlBody = capBody(html, LIMITS.htmlChars);
	return { ...shaped, htmlBody: untrusted("email", htmlBody.text), htmlTruncated: htmlBody.truncated };
}

const strip = <T extends { bodyChars: number }>({ bodyChars: _b, ...rest }: T) => rest;

async function fetchMessage(env: Env, alias: string, messageId: string, format: MessageFormat) {
	return googleJson<GmailMessage>(
		env,
		alias,
		`${GMAIL}/messages/${encodeURIComponent(messageId)}?${formatQuery(format)}`,
		{ what: "message id" },
	);
}

function shapeThread(thread: { id?: string; messages?: GmailMessage[] }, format: MessageFormat, ctx: ToolContext) {
	const all = thread.messages ?? [];
	let remaining: number = LIMITS.threadTotalChars;
	const messages = all.slice(-LIMITS.threadMessages).map((message) => {
		const shaped = shapeMessage(message, format, ctx, Math.max(0, Math.min(LIMITS.threadMessageChars, remaining)));
		remaining -= shaped.bodyChars;
		return strip(shaped);
	});
	return {
		threadId: thread.id,
		messageCount: all.length,
		messagesOmitted: all.length - messages.length,
		messages,
		viewUrl: viewUrl(ctx, thread.id),
	};
}

// ---------- Gmail batch GET (one subrequest for many ids) ----------

async function gmailBatchGet<T>(env: Env, alias: string, paths: string[], what: string): Promise<(T | null)[]> {
	if (paths.length === 0) return [];
	const boundary = `gobridge_${randomToken(9)}`;
	const body = `${paths
		.map(
			(path, i) =>
				`--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\nGET ${path} HTTP/1.1\r\n\r\n`,
		)
		.join("")}--${boundary}--\r\n`;
	const resp = await googleRequest(env, alias, BATCH, {
		body,
		headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
		method: "POST",
		what,
	});
	const replyBoundary = /boundary="?([^";]+)"?/i.exec(resp.headers.get("Content-Type") ?? "")?.[1];
	const text = await resp.text();
	if (!replyBoundary) throw new ToolError("google_error", "Google returned an unreadable response.");
	const results: (T | null)[] = paths.map(() => null);
	for (const part of text.split(`--${replyBoundary}`)) {
		const index = Number(/Content-ID:\s*<response-item(\d+)>/i.exec(part)?.[1]);
		const status = Number(/HTTP\/1\.[01] (\d{3})/.exec(part)?.[1]);
		const start = part.indexOf("{");
		const end = part.lastIndexOf("}");
		if (!Number.isInteger(index) || status < 200 || status > 299 || start < 0 || end < start) continue;
		try {
			results[index] = JSON.parse(part.slice(start, end + 1)) as T;
		} catch (_e) {
			// leave null
		}
	}
	return results;
}

// ---------- Building messages ----------

/** RFC 2047 encoding for a header value that is not plain ASCII. */
function encodeHeader(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const words: string[] = [];
	let chunk = "";
	for (const char of value) {
		if (encoder.encode(chunk + char).byteLength > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += char;
	}
	if (chunk) words.push(chunk);
	return words.map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`).join("\r\n ");
}

const MESSAGE_ID = /^<[^\s<>]+>$/;
/** Keeps only well-formed message ids, so nothing from an email can inject a header. */
const messageIds = (value: string) => value.split(/\s+/).filter((id) => MESSAGE_ID.test(id) && id.length <= 300);
const ADDRESS = /[^\s<>,;:"()]+@[^\s<>,;:"()]+/g;
const addressesIn = (value: string) => (value.match(ADDRESS) ?? []).map((a) => a.toLowerCase());
const safeFilename = (name: string | undefined, fallback: string) =>
	(name ?? fallback).replace(/[\r\n"\\]/g, "_").slice(0, 200) || fallback;

export type OutgoingAttachment = { filename: string; mimeType: string; bytes: Uint8Array; inline?: boolean };
type Threading = { threadId?: string; inReplyTo?: string; references?: string };
type Outgoing = {
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	body: string;
	htmlBody?: string;
	attachments: OutgoingAttachment[];
};

const wrap76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");

/** Builds the RFC 5322 message Gmail stores or sends. */
export function buildMimeMessage(message: Outgoing, threading: Threading = {}): string {
	const headers = [
		message.to.length ? `To: ${message.to.join(", ")}` : "",
		message.cc.length ? `Cc: ${message.cc.join(", ")}` : "",
		message.bcc.length ? `Bcc: ${message.bcc.join(", ")}` : "",
		`Subject: ${encodeHeader(message.subject)}`,
		threading.inReplyTo ? `In-Reply-To: ${threading.inReplyTo}` : "",
		threading.references ? `References: ${threading.references}` : "",
		"MIME-Version: 1.0",
	].filter(Boolean);

	const textPart = (type: string, content: string) =>
		`Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(base64(encoder.encode(content)))}`;
	let content: string;
	if (message.htmlBody) {
		const alt = `alt_${randomToken(9)}`;
		content = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${textPart("text/plain", message.body)}\r\n--${alt}\r\n${textPart("text/html", message.htmlBody)}\r\n--${alt}--`;
	} else {
		content = textPart("text/plain", message.body);
	}
	if (message.attachments.length === 0) return `${headers.join("\r\n")}\r\n${content}`;

	const mixed = `mixed_${randomToken(9)}`;
	const parts = message.attachments.map((a) => {
		const name = safeFilename(a.filename, "attachment");
		const disposition = a.inline ? "inline" : "attachment";
		const cid = a.inline ? `\r\nContent-ID: <${name.replace(/[^A-Za-z0-9._-]/g, "_")}@gobridge>` : "";
		return `Content-Type: ${a.mimeType}; name="${name}"\r\nContent-Disposition: ${disposition}; filename="${name}"\r\nContent-Transfer-Encoding: base64${cid}\r\n\r\n${wrap76(base64(a.bytes))}`;
	});
	return `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n--${mixed}\r\n${content}\r\n${parts.map((p) => `--${mixed}\r\n${p}\r\n`).join("")}--${mixed}--`;
}

const attachmentInput = z.object({
	content: z.string().min(1).describe("File bytes, base64"),
	filename: singleLine(200).optional(),
	mimeType: singleLine(100).optional(),
	inline: z.boolean().optional(),
});
const attachmentsInput = z.array(attachmentInput).max(LIMITS.attachments).optional();

function decodeAttachments(input: z.infer<typeof attachmentsInput>): OutgoingAttachment[] {
	let total = 0;
	return (input ?? []).map((a, i) => {
		let bytes: Uint8Array;
		try {
			bytes = decodeBase64(a.content);
		} catch (_e) {
			throw new ToolError("invalid_input", `Invalid input: attachments.${i}.content is not valid base64.`);
		}
		total += bytes.byteLength;
		if (total > LIMITS.attachmentBytes) {
			throw new ToolError("too_large", "Attachments are too large: at most 25 MB in total. Nothing was changed.");
		}
		return {
			bytes,
			filename: safeFilename(a.filename, `attachment-${i + 1}`),
			inline: a.inline === true,
			mimeType: a.mimeType ?? "application/octet-stream",
		};
	});
}

/** Downloads a message's existing attachments (for forwards and draft updates). */
async function fetchAttachments(env: Env, alias: string, messageId: string, list: Attachment[]): Promise<OutgoingAttachment[]> {
	const result: OutgoingAttachment[] = [];
	let total = 0;
	for (const a of list) {
		if (!a.attachmentId) continue;
		total += a.size;
		if (total > LIMITS.attachmentBytes) {
			throw new ToolError("too_large", "The original attachments exceed 25 MB in total. Nothing was changed.");
		}
		const data = await googleJson<{ data?: string }>(
			env,
			alias,
			`${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.attachmentId)}`,
			{ what: "message id" },
		);
		result.push({ bytes: data.data ? b64urlDecode(data.data) : new Uint8Array(), filename: a.filename, mimeType: a.mimeType });
	}
	return result;
}

/** What a reply or forward needs to know about the original message. */
async function original(env: Env, alias: string, messageId: string, full: boolean) {
	const message = await googleJson<GmailMessage>(
		env,
		alias,
		`${GMAIL}/messages/${encodeURIComponent(messageId)}?${
			full
				? "format=full"
				: `format=metadata&${HEADERS}&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Reply-To`
		}`,
		{ what: "message id" },
	);
	const [inReplyTo] = messageIds(header(message.payload, "Message-ID"));
	const references = [...messageIds(header(message.payload, "References")), ...(inReplyTo ? [inReplyTo] : [])]
		.slice(-20)
		.join(" ");
	return {
		message,
		subject: header(message.payload, "Subject").replace(/[\r\n]/g, " ").slice(0, LIMITS.subjectChars),
		from: addressesIn(header(message.payload, "From")),
		replyTo: addressesIn(header(message.payload, "Reply-To")),
		to: addressesIn(header(message.payload, "To")),
		cc: addressesIn(header(message.payload, "Cc")),
		threading: { inReplyTo, references: references || undefined, threadId: message.threadId } as Threading,
	};
}

const raw = (message: Outgoing, threading: Threading) => ({
	raw: b64urlEncode(encoder.encode(buildMimeMessage(message, threading))),
	...(threading.threadId ? { threadId: threading.threadId } : {}),
});

type DraftResponse = { id?: string; message?: GmailMessage };

function draftPreview(draft: DraftResponse, message: Outgoing, isReply: boolean, ctx: ToolContext) {
	return {
		draftId: draft.id,
		messageId: draft.message?.id,
		threadId: draft.message?.threadId,
		isReply,
		to: message.to,
		cc: message.cc,
		bcc: message.bcc,
		subject: message.subject,
		body: message.body,
		htmlBody: message.htmlBody,
		attachments: message.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.bytes.byteLength })),
		viewUrl: viewUrl(ctx, draft.message?.id),
		status: "Draft saved. NOT sent. Show this preview to the user; send only with send_message after they confirm.",
	};
}

function noteSend(ctx: ToolContext, message: Outgoing) {
	ctx.audit.recipients = [...message.to, ...message.cc, ...message.bcc];
	ctx.audit.subject = message.subject;
}

async function sendRaw(env: Env, ctx: ToolContext, message: Outgoing, threading: Threading) {
	assertRecipientLimit(message);
	if (message.to.length + message.cc.length + message.bcc.length === 0) {
		throw new ToolError("invalid_input", "Invalid input: at least one recipient is required. Nothing was sent.");
	}
	noteSend(ctx, message);
	await reserveDailySend(env, ctx.alias);
	const sent = await googleJson<{ id?: string; threadId?: string }>(env, ctx.alias, `${GMAIL}/messages/send`, {
		json: raw(message, threading),
		method: "POST",
		what: "message",
	});
	ctx.audit.messageId = sent.id;
	ctx.audit.threadId = sent.threadId;
	return {
		sent: true,
		messageId: sent.id,
		threadId: sent.threadId,
		recipients: ctx.audit.recipients,
		subject: message.subject,
		viewUrl: viewUrl(ctx, sent.id),
	};
}

// ---------- Label helpers ----------

const SENSITIVE = ["TRASH", "SPAM"];
const labelIdsInput = z.array(googleId("Gmail label id")).min(1).max(20);
const isUserLabel = (id: string) => id.startsWith("Label_");

function refuseSensitive(ids: string[], action: string) {
	if (ids.some((id) => SENSITIVE.includes(id.toUpperCase()))) {
		throw new ToolError(
			"invalid_input",
			`Invalid input: TRASH and SPAM cannot be ${action} here. Use trash_message, trash_thread, mark_message_spam, mark_thread_spam or their un- versions.`,
		);
	}
}

/** Gmail's allowed label palette, by preset name. */
const COLOR_PRESETS: Record<string, { backgroundColor: string; textColor: string }> = {
	blue: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
	gray: { backgroundColor: "#999999", textColor: "#ffffff" },
	green: { backgroundColor: "#16a766", textColor: "#ffffff" },
	orange: { backgroundColor: "#ffad47", textColor: "#000000" },
	pink: { backgroundColor: "#f691b3", textColor: "#000000" },
	purple: { backgroundColor: "#a479e2", textColor: "#ffffff" },
	red: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
	teal: { backgroundColor: "#43d692", textColor: "#000000" },
	yellow: { backgroundColor: "#fad165", textColor: "#000000" },
};
const colorPreset = z.enum(Object.keys(COLOR_PRESETS) as [string, ...string[]]).optional();
const labelListVisibility = z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional();
const messageListVisibility = z.enum(["show", "hide"]).optional();

/** A thread's labels are the union of its messages' labels. */
async function threadLabels(env: Env, alias: string, threadId: string): Promise<string[]> {
	const thread = await googleJson<{ messages?: GmailMessage[] }>(
		env,
		alias,
		`${GMAIL}/threads/${encodeURIComponent(threadId)}?format=minimal`,
		{ what: "thread id" },
	);
	return [...new Set((thread.messages ?? []).flatMap((m) => m.labelIds ?? []))].slice(0, 50);
}

async function modify(env: Env, ctx: ToolContext, kind: "messages" | "threads", id: string, add: string[], remove: string[]) {
	const what = kind === "messages" ? "message id" : "thread id";
	const result = await googleJson<{ id?: string; threadId?: string; labelIds?: string[] }>(
		env,
		ctx.alias,
		`${GMAIL}/${kind}/${encodeURIComponent(id)}/modify`,
		{ json: { addLabelIds: add, removeLabelIds: remove }, method: "POST", what },
	);
	// threads.modify answers with the thread only; fetch the resulting labels.
	const labelIds = kind === "threads" ? await threadLabels(env, ctx.alias, id) : (result.labelIds ?? []).slice(0, 50);
	return { id, labelIds, viewUrl: viewUrl(ctx, id) };
}

async function trashOp(env: Env, ctx: ToolContext, kind: "messages" | "threads", id: string, op: "trash" | "untrash") {
	const what = kind === "messages" ? "message id" : "thread id";
	const result = await googleJson<{ id?: string; labelIds?: string[]; messages?: GmailMessage[] }>(
		env,
		ctx.alias,
		`${GMAIL}/${kind}/${encodeURIComponent(id)}/${op}`,
		{ method: "POST", what },
	);
	let labelIds = kind === "threads" ? await threadLabels(env, ctx.alias, id) : (result.labelIds ?? []).slice(0, 50);
	// Gmail's UI puts a restored message back in the inbox; the API only drops TRASH.
	// Re-add INBOX unless the item is sent-only or a draft.
	if (op === "untrash" && !labelIds.includes("INBOX") && !labelIds.includes("DRAFT") && !(labelIds.includes("SENT") && labelIds.every((l) => l === "SENT" || /^Label_|^CATEGORY_/.test(l)))) {
		labelIds = (await modify(env, ctx, kind, id, ["INBOX"], [])).labelIds;
	}
	return { id, [op === "trash" ? "trashed" : "untrashed"]: true, labelIds, viewUrl: viewUrl(ctx, id) };
}

const noteId = (ctx: ToolContext, kind: "messages" | "threads", id: string) => {
	if (kind === "messages") ctx.audit.messageId = id;
	else ctx.audit.threadId = id;
};

function labelOpTool(name: string, kind: "messages" | "threads", add: boolean) {
	const noun = kind === "messages" ? "message" : "thread";
	const idField = kind === "messages" ? "messageId" : "threadId";
	return tool({
		name,
		title: `${add ? "Add labels to" : "Remove labels from"} a ${noun}`,
		description: `${add ? "Adds" : "Removes"} one or more labels ${add ? "to" : "from"} one Gmail ${noun}. TRASH and SPAM are refused: use the trash and spam tools. ${CONFIRM}`,
		kind: "write",
		schema: z.object({ account, [idField]: googleId(`Gmail ${noun} id`), labelIds: labelIdsInput }),
		run: async (env, args, ctx) => {
			const id = args[idField] as string;
			const labelIds = args.labelIds as string[];
			refuseSensitive(labelIds, add ? "added" : "removed");
			noteId(ctx, kind, id);
			ctx.audit.labelIds = labelIds;
			ctx.audit.action = add ? "label" : "unlabel";
			return modify(env, ctx, kind, id, add ? labelIds : [], add ? [] : labelIds);
		},
	});
}

function trashTool(name: string, kind: "messages" | "threads", op: "trash" | "untrash") {
	const noun = kind === "messages" ? "message" : "thread";
	const idField = kind === "messages" ? "messageId" : "threadId";
	return tool({
		name,
		title: `${op === "trash" ? "Move" : "Restore"} a ${noun} ${op === "trash" ? "to" : "from"} Trash`,
		description: `${op === "trash" ? `Moves one Gmail ${noun} to Trash (Gmail empties Trash after 30 days). Permanent deletion is not possible.` : `Moves one Gmail ${noun} out of Trash.`} ${CONFIRM}`,
		kind: "write",
		destructive: op === "trash",
		schema: z.object({ account, [idField]: googleId(`Gmail ${noun} id`) }),
		run: async (env, args, ctx) => {
			const id = args[idField] as string;
			noteId(ctx, kind, id);
			ctx.audit.action = op;
			return trashOp(env, ctx, kind, id, op);
		},
	});
}

function spamTool(name: string, kind: "messages" | "threads", mark: boolean) {
	const noun = kind === "messages" ? "message" : "thread";
	const idField = kind === "messages" ? "messageId" : "threadId";
	return tool({
		name,
		title: `${mark ? "Mark" : "Unmark"} a ${noun} as spam`,
		description: `${mark ? `Moves one Gmail ${noun} to Spam.` : `Moves one Gmail ${noun} out of Spam back to the inbox.`} ${CONFIRM}`,
		kind: "write",
		destructive: mark,
		schema: z.object({ account, [idField]: googleId(`Gmail ${noun} id`) }),
		run: async (env, args, ctx) => {
			const id = args[idField] as string;
			noteId(ctx, kind, id);
			ctx.audit.action = mark ? "spam" : "unspam";
			return modify(env, ctx, kind, id, mark ? ["SPAM"] : ["INBOX"], mark ? ["INBOX"] : ["SPAM"]);
		},
	});
}

function sensitiveTool(name: string, kind: "messages" | "threads") {
	const noun = kind === "messages" ? "message" : "thread";
	const idField = kind === "messages" ? "messageId" : "threadId";
	return tool({
		name,
		title: `Trash or spam a ${noun}`,
		description: `Applies TRASH or SPAM to one Gmail ${noun}: the only way to use those labels. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({ account, [idField]: googleId(`Gmail ${noun} id`), labelOption: z.enum(["TRASH", "SPAM"]) }),
		run: async (env, args, ctx) => {
			const id = args[idField] as string;
			noteId(ctx, kind, id);
			ctx.audit.action = args.labelOption === "TRASH" ? "trash" : "spam";
			return args.labelOption === "TRASH"
				? trashOp(env, ctx, kind, id, "trash")
				: modify(env, ctx, kind, id, ["SPAM"], ["INBOX"]);
		},
	});
}

// ---------- Tools ----------

const draftFields = {
	to: recipients,
	cc: recipients,
	bcc: recipients,
	subject: singleLine(LIMITS.subjectChars).optional(),
	body: z.string().max(LIMITS.textChars).optional().describe("Plain-text body"),
	htmlBody: z.string().max(LIMITS.textChars).optional().describe("HTML body (a plain-text version is sent alongside)"),
	replyToMessageId: googleId("Gmail message id to reply to").optional(),
	attachments: attachmentsInput,
};

const toOutgoing = (args: {
	to: string[];
	cc: string[];
	bcc: string[];
	subject?: string;
	body?: string;
	htmlBody?: string;
	attachments?: z.infer<typeof attachmentsInput>;
}): Outgoing => ({
	attachments: decodeAttachments(args.attachments),
	bcc: args.bcc,
	body: args.body ?? (args.htmlBody ? stripHtml(args.htmlBody) : ""),
	cc: args.cc,
	htmlBody: args.htmlBody,
	subject: args.subject ?? "",
	to: args.to,
});

export const GMAIL_TOOLS = [
	// ----- reads -----
	tool({
		name: "search_threads",
		title: "Search Gmail threads",
		description: `Searches Gmail threads with Gmail search syntax (e.g. "from:alice newer_than:7d"). view METADATA_ONLY (default) returns subject, participants and date per thread; MINIMAL returns ids and snippets only. ${UNTRUSTED}`,
		kind: "read",
		countKey: "threads",
		schema: z.object({
			account,
			query: z.string().trim().max(500).optional(),
			pageSize: pageSize(50, 10),
			pageToken,
			includeTrash: z.boolean().default(false).describe("Also search Trash and Spam"),
			view: z.enum(["MINIMAL", "METADATA_ONLY"]).default("METADATA_ONLY"),
		}),
		run: async (env, args, ctx) => {
			const url = new URL(`${GMAIL}/threads`);
			if (args.query) url.searchParams.set("q", args.query);
			url.searchParams.set("maxResults", String(args.pageSize));
			if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
			if (args.includeTrash) url.searchParams.set("includeSpamTrash", "true");
			const found = await googleJson<{ threads?: { id: string; snippet?: string }[]; nextPageToken?: string }>(
				env,
				args.account,
				url,
				{ what: "search query" },
			);
			const list = (found.threads ?? []).slice(0, args.pageSize);
			let threads: unknown[];
			if (args.view === "MINIMAL") {
				threads = list.map((t) => ({
					threadId: t.id,
					snippet: untrusted("email", cap(t.snippet, LIMITS.snippetChars)),
					viewUrl: viewUrl(ctx, t.id),
				}));
			} else {
				const details = await gmailBatchGet<{ id?: string; messages?: GmailMessage[] }>(
					env,
					args.account,
					list.map((t) => `${GMAIL_PATH}/threads/${encodeURIComponent(t.id)}?format=metadata&${HEADERS}`),
					"search query",
				);
				threads = list.map((t, i) => {
					const messages = details[i]?.messages ?? [];
					const first = messages[0];
					const last = messages[messages.length - 1];
					return {
						threadId: t.id,
						messageCount: messages.length,
						subject: untrusted("email", h(first, "Subject")),
						from: untrusted("email", h(last, "From")),
						to: untrusted("email", h(last, "To")),
						lastDate: h(last, "Date"),
						labelIds: [...new Set(messages.flatMap((m) => m.labelIds ?? []))].slice(0, 20),
						snippet: untrusted("email", cap(t.snippet, LIMITS.snippetChars)),
						viewUrl: viewUrl(ctx, t.id),
					};
				});
			}
			return { threads, nextPageToken: found.nextPageToken };
		},
	}),

	tool({
		name: "get_thread",
		title: "Get a Gmail thread",
		description: `Returns the messages of one Gmail thread, oldest first. Capped: the most recent ${LIMITS.threadMessages} messages, about ${LIMITS.threadMessageChars} characters each and ${LIMITS.threadTotalChars} in total. ${UNTRUSTED}`,
		kind: "read",
		countKey: "messages",
		schema: z.object({ account, threadId: googleId("Gmail thread id"), messageFormat: messageFormat }),
		run: async (env, args, ctx) => {
			const format = args.messageFormat === "RAW" ? "FULL_CONTENT" : args.messageFormat;
			const thread = await googleJson<{ id?: string; messages?: GmailMessage[] }>(
				env,
				args.account,
				`${GMAIL}/threads/${encodeURIComponent(args.threadId)}?${formatQuery(format)}`,
				{ what: "thread id" },
			);
			return shapeThread(thread, format, ctx);
		},
	}),

	tool({
		name: "get_message",
		title: "Get a Gmail message",
		description: `Returns one Gmail message. messageFormat: MINIMAL (ids, labels, snippet), METADATA_ONLY (headers), PLAIN_TEXT (headers + text body, default), FULL_CONTENT (also the HTML body), RAW (the raw RFC 822 message, base64url). Bodies are capped at about ${LIMITS.bodyChars} characters. ${UNTRUSTED}`,
		kind: "read",
		schema: z.object({ account, messageId: googleId("Gmail message id"), messageFormat }),
		run: async (env, args, ctx) =>
			strip(shapeMessage(await fetchMessage(env, args.account, args.messageId, args.messageFormat), args.messageFormat, ctx)),
	}),

	tool({
		name: "list_drafts",
		title: "List Gmail drafts",
		description: `Lists Gmail drafts, optionally filtered with Gmail search syntax. view METADATA_ONLY (default) returns headers; FULL also returns the text body. ${UNTRUSTED}`,
		kind: "read",
		countKey: "drafts",
		schema: z.object({
			account,
			query: z.string().trim().max(500).optional(),
			pageSize: pageSize(50, 10),
			pageToken,
			view: z.enum(["METADATA_ONLY", "FULL"]).default("METADATA_ONLY"),
		}),
		run: async (env, args, ctx) => {
			const url = new URL(`${GMAIL}/drafts`);
			if (args.query) url.searchParams.set("q", args.query);
			url.searchParams.set("maxResults", String(args.pageSize));
			if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
			const found = await googleJson<{ drafts?: { id: string }[]; nextPageToken?: string }>(env, args.account, url, {
				what: "search query",
			});
			const list = (found.drafts ?? []).slice(0, args.pageSize);
			const format: MessageFormat = args.view === "FULL" ? "PLAIN_TEXT" : "METADATA_ONLY";
			const details = await gmailBatchGet<DraftResponse>(
				env,
				args.account,
				list.map((d) => `${GMAIL_PATH}/drafts/${encodeURIComponent(d.id)}?${formatQuery(format)}`),
				"draft id",
			);
			return {
				drafts: list.map((d, i) => ({
					draftId: d.id,
					...strip(shapeMessage(details[i]?.message ?? {}, format, ctx, LIMITS.threadMessageChars)),
				})),
				nextPageToken: found.nextPageToken,
			};
		},
	}),

	tool({
		name: "get_draft",
		title: "Get a Gmail draft",
		description: `Returns one Gmail draft with its message in the requested format. ${UNTRUSTED}`,
		kind: "read",
		schema: z.object({ account, draftId: googleId("Gmail draft id"), messageFormat: draftFormat }),
		run: async (env, args, ctx) => {
			const draft = await googleJson<DraftResponse>(
				env,
				args.account,
				`${GMAIL}/drafts/${encodeURIComponent(args.draftId)}?${formatQuery(args.messageFormat)}`,
				{ what: "draft id" },
			);
			return { draftId: draft.id, ...strip(shapeMessage(draft.message ?? {}, args.messageFormat, ctx)) };
		},
	}),

	tool({
		name: "list_labels",
		title: "List Gmail labels",
		description: `Lists the account's Gmail labels (id, name, type, colour, visibility). ${UNTRUSTED}`,
		kind: "read",
		countKey: "labels",
		schema: z.object({ account }),
		run: async (env, args) => {
			const data = await googleJson<{ labels?: Record<string, any>[] }>(env, args.account, `${GMAIL}/labels`);
			return {
				labels: (data.labels ?? []).slice(0, LIMITS.labels).map((label) => ({
					id: label.id,
					name: untrusted("email", cap(label.name, LIMITS.headerChars)),
					type: label.type,
					color: label.color,
					labelListVisibility: label.labelListVisibility,
					messageListVisibility: label.messageListVisibility,
				})),
			};
		},
	}),

	// ----- drafts -----
	tool({
		name: "create_draft",
		title: "Create a Gmail draft",
		description: `Saves a Gmail draft and returns its draftId with a full preview. Nothing is sent. To reply, pass replyToMessageId: the draft is threaded with that message. Up to ${LIMITS.recipients} recipients in total and 25 MB of attachments. ${UNTRUSTED}`,
		kind: "write",
		schema: z.object({ account, ...draftFields }),
		run: async (env, args, ctx) => {
			assertRecipientLimit(args);
			const message = toOutgoing(args);
			let threading: Threading = {};
			if (args.replyToMessageId) {
				const orig = await original(env, args.account, args.replyToMessageId, false);
				threading = orig.threading;
				if (!args.subject) message.subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
			}
			noteSend(ctx, message);
			const draft = await googleJson<DraftResponse>(env, args.account, `${GMAIL}/drafts`, {
				json: { message: raw(message, threading) },
				method: "POST",
				what: "draft content",
			});
			ctx.audit.draftId = draft.id;
			return draftPreview(draft, message, Boolean(args.replyToMessageId), ctx);
		},
	}),

	tool({
		name: "update_draft",
		title: "Update a Gmail draft",
		description: `Changes the given fields of an existing Gmail draft; fields you leave out are kept, and attachments are replaced only if you pass them. Nothing is sent. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({
			account,
			draftId: googleId("Gmail draft id"),
			to: z.array(email).max(LIMITS.recipients).optional(),
			cc: z.array(email).max(LIMITS.recipients).optional(),
			bcc: z.array(email).max(LIMITS.recipients).optional(),
			subject: draftFields.subject,
			body: draftFields.body,
			htmlBody: draftFields.htmlBody,
			replyToMessageId: draftFields.replyToMessageId,
			attachments: attachmentsInput,
		}),
		run: async (env, args, ctx) => {
			ctx.audit.draftId = args.draftId;
			const draftUrl = `${GMAIL}/drafts/${encodeURIComponent(args.draftId)}`;
			const existing = await googleJson<DraftResponse>(env, args.account, `${draftUrl}?format=full`, { what: "draft id" });
			const payload = existing.message?.payload;
			const current = extractBody(payload);
			const [inReplyTo] = messageIds(header(payload, "In-Reply-To"));
			const message: Outgoing = {
				attachments: args.attachments
					? decodeAttachments(args.attachments)
					: await fetchAttachments(env, args.account, existing.message?.id ?? "", current.attachments),
				bcc: args.bcc ?? addressesIn(header(payload, "Bcc")),
				body: args.body ?? (args.htmlBody ? stripHtml(args.htmlBody) : current.plain || stripHtml(current.html)),
				cc: args.cc ?? addressesIn(header(payload, "Cc")),
				htmlBody: args.htmlBody ?? (args.body ? undefined : current.html || undefined),
				subject: args.subject ?? header(payload, "Subject").replace(/[\r\n]/g, " ").slice(0, LIMITS.subjectChars),
				to: args.to ?? addressesIn(header(payload, "To")),
			};
			assertRecipientLimit(message);
			let threading: Threading = inReplyTo
				? {
						inReplyTo,
						references: messageIds(header(payload, "References")).slice(-20).join(" ") || undefined,
						threadId: existing.message?.threadId,
					}
				: {};
			if (args.replyToMessageId) threading = (await original(env, args.account, args.replyToMessageId, false)).threading;
			noteSend(ctx, message);
			const draft = await googleJson<DraftResponse>(env, args.account, draftUrl, {
				json: { message: raw(message, threading) },
				method: "PUT",
				what: "draft id",
			});
			return draftPreview(draft, message, Boolean(threading.inReplyTo), ctx);
		},
	}),

	tool({
		name: "delete_draft",
		title: "Delete a Gmail draft",
		description: `Permanently deletes ONE unsent Gmail draft. It only works on drafts: it can never delete a sent or received message. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({ account, draftId: googleId("Gmail draft id") }),
		run: async (env, args, ctx) => {
			ctx.audit.draftId = args.draftId;
			const draftUrl = `${GMAIL}/drafts/${encodeURIComponent(args.draftId)}`;
			const draft = await googleJson<DraftResponse>(
				env,
				args.account,
				`${draftUrl}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject`,
				{ what: "draft id" },
			);
			const labels = draft.message?.labelIds;
			if (draft.id !== args.draftId || !Array.isArray(labels) || !labels.includes("DRAFT")) {
				throw new ToolError("invalid_input", "That id is not an unsent draft. Nothing was deleted.");
			}
			ctx.audit.recipients = ["To", "Cc", "Bcc"].flatMap((name) => addressesIn(header(draft.message?.payload, name)));
			ctx.audit.subject = header(draft.message?.payload, "Subject").slice(0, LIMITS.subjectChars);
			await googleRequest(env, args.account, draftUrl, { method: "DELETE", what: "draft id" }).then((r) => r.body?.cancel());
			return { deleted: true, draftId: args.draftId };
		},
	}),

	// ----- sending -----
	tool({
		name: "send_message",
		title: "Send an email",
		description: `Sends an email. Either pass draftId to send an existing draft exactly as saved (preferred: the user can review it first), or pass recipients, subject and body to send directly. replyThreadId/replyToMessageId thread the message as a reply. A daily send cap applies. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({
			account,
			draftId: googleId("Gmail draft id").optional(),
			to: recipients,
			cc: recipients,
			bcc: recipients,
			subject: draftFields.subject,
			body: draftFields.body,
			htmlBody: draftFields.htmlBody,
			attachments: attachmentsInput,
			replyThreadId: googleId("Gmail thread id to reply in").optional(),
			replyToMessageId: googleId("Gmail message id to reply to").optional(),
		}),
		switches: (args) => (args.draftId ? [] : ["DIRECT_SEND_ENABLED"]),
		run: async (env, args, ctx) => {
			if (args.draftId) {
				ctx.audit.draftId = args.draftId;
				const draft = await googleJson<DraftResponse>(
					env,
					args.account,
					`${GMAIL}/drafts/${encodeURIComponent(args.draftId)}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject`,
					{ what: "draft id" },
				);
				const to = ["To", "Cc", "Bcc"].flatMap((name) => addressesIn(header(draft.message?.payload, name)));
				ctx.audit.recipients = to;
				ctx.audit.subject = header(draft.message?.payload, "Subject").slice(0, LIMITS.subjectChars);
				if (to.length === 0) throw new ToolError("invalid_input", "This draft has no recipients. Nothing was sent.");
				if (to.length > LIMITS.recipients) {
					throw new ToolError("invalid_input", `This draft has more than ${LIMITS.recipients} recipients. Nothing was sent.`);
				}
				await reserveDailySend(env, args.account);
				const sent = await googleJson<{ id?: string; threadId?: string }>(env, args.account, `${GMAIL}/drafts/send`, {
					json: { id: args.draftId },
					method: "POST",
					what: "draft id",
				});
				ctx.audit.messageId = sent.id;
				return { sent: true, messageId: sent.id, threadId: sent.threadId, recipients: to, subject: ctx.audit.subject, viewUrl: viewUrl(ctx, sent.id) };
			}
			const message = toOutgoing(args);
			let threading: Threading = args.replyThreadId ? { threadId: args.replyThreadId } : {};
			if (args.replyToMessageId) {
				const orig = await original(env, args.account, args.replyToMessageId, false);
				threading = orig.threading;
				if (!args.subject) message.subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
			}
			return sendRaw(env, ctx, message, threading);
		},
	}),

	tool({
		name: "reply",
		title: "Reply to an email",
		description: `Sends a reply to one Gmail message, threaded with it. By default it goes to the sender only; replyAll also includes the original To and Cc. Explicit to/cc/bcc override the recipients. A daily send cap applies. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({
			account,
			messageId: googleId("Gmail message id to reply to"),
			body: draftFields.body,
			htmlBody: draftFields.htmlBody,
			replyAll: z.boolean().default(false),
			to: z.array(email).max(LIMITS.recipients).optional(),
			cc: z.array(email).max(LIMITS.recipients).optional(),
			bcc: recipients,
		}),
		switches: () => ["DIRECT_SEND_ENABLED"],
		run: async (env, args, ctx) => {
			if (!args.body && !args.htmlBody) throw new ToolError("invalid_input", "Invalid input: body or htmlBody is required.");
			ctx.audit.originalMessageId = args.messageId;
			const orig = await original(env, args.account, args.messageId, false);
			const self = ctx.accountEmail.toLowerCase();
			const sender = orig.replyTo.length ? orig.replyTo : orig.from;
			const to = args.to ?? sender;
			const cc = args.cc ?? (args.replyAll ? [...new Set([...orig.to, ...orig.cc])].filter((a) => a !== self && !to.includes(a)) : []);
			const message: Outgoing = {
				attachments: [],
				bcc: args.bcc,
				body: args.body ?? stripHtml(args.htmlBody ?? ""),
				cc,
				htmlBody: args.htmlBody,
				subject: /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`,
				to,
			};
			return sendRaw(env, ctx, message, orig.threading);
		},
	}),

	tool({
		name: "forward",
		title: "Forward an email",
		description: `Forwards one Gmail message, with its attachments, to new recipients. forwardText is added above the forwarded content. A daily send cap applies. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({
			account,
			messageId: googleId("Gmail message id to forward"),
			to: recipients,
			cc: recipients,
			bcc: recipients,
			forwardText: z.string().max(LIMITS.textChars).optional(),
			htmlBody: draftFields.htmlBody,
		}),
		switches: () => ["FORWARD_ENABLED"],
		run: async (env, args, ctx) => {
			assertRecipientLimit(args);
			ctx.audit.originalMessageId = args.messageId;
			ctx.audit.recipients = [...args.to, ...args.cc, ...args.bcc];
			const orig = await original(env, args.account, args.messageId, true);
			const content = extractBody(orig.message.payload);
			const quoted = [
				"---------- Forwarded message ---------",
				`From: ${header(orig.message.payload, "From").replace(/[\r\n]/g, " ")}`,
				`Date: ${header(orig.message.payload, "Date").replace(/[\r\n]/g, " ")}`,
				`Subject: ${orig.subject}`,
				`To: ${header(orig.message.payload, "To").replace(/[\r\n]/g, " ")}`,
				"",
				content.plain.trim() ? content.plain : stripHtml(content.html),
			].join("\n");
			const message: Outgoing = {
				attachments: await fetchAttachments(env, args.account, args.messageId, content.attachments),
				bcc: args.bcc,
				body: `${args.forwardText ?? (args.htmlBody ? stripHtml(args.htmlBody) : "")}\n\n${quoted}`.trim(),
				cc: args.cc,
				htmlBody: args.htmlBody ? `${args.htmlBody}<br><br><pre>${quoted.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c)}</pre>` : undefined,
				subject: /^fwd?:/i.test(orig.subject) ? orig.subject : `Fwd: ${orig.subject}`,
				to: args.to,
			};
			// Gmail's UI keeps a forward in the original conversation.
			return sendRaw(env, ctx, message, orig.threading);
		},
	}),

	// ----- labels -----
	tool({
		name: "create_label",
		title: "Create a Gmail label",
		description: `Creates a Gmail label. Use "/" in displayName for nesting (Parent/Child); autoCreateParentLabels creates missing parents. ${CONFIRM}`,
		kind: "write",
		schema: z.object({
			account,
			displayName: singleLine(225).min(1),
			autoCreateParentLabels: z.boolean().default(false),
			colorPreset,
			labelListVisibility,
			messageListVisibility,
		}),
		run: async (env, args, ctx) => {
			const created: string[] = [];
			const body = (name: string) => ({
				name,
				...(args.colorPreset ? { color: COLOR_PRESETS[args.colorPreset] } : {}),
				...(args.labelListVisibility ? { labelListVisibility: args.labelListVisibility } : {}),
				...(args.messageListVisibility ? { messageListVisibility: args.messageListVisibility } : {}),
			});
			if (args.autoCreateParentLabels && args.displayName.includes("/")) {
				const existing = new Set(
					((await googleJson<{ labels?: { name?: string }[] }>(env, args.account, `${GMAIL}/labels`)).labels ?? []).map((l) => l.name),
				);
				const segments = args.displayName.split("/");
				for (let i = 1; i < segments.length; i++) {
					const parent = segments.slice(0, i).join("/");
					if (existing.has(parent)) continue;
					await googleJson(env, args.account, `${GMAIL}/labels`, { json: { name: parent }, method: "POST", what: "label name" });
					created.push(parent);
				}
			}
			const label = await googleJson<Record<string, any>>(env, args.account, `${GMAIL}/labels`, {
				json: body(args.displayName),
				method: "POST",
				what: "label name",
			});
			ctx.audit.action = "create_label";
			ctx.audit.labelIds = [label.id, ...created].filter(Boolean);
			return { labelId: label.id, name: label.name, color: label.color, parentsCreated: created };
		},
	}),

	tool({
		name: "update_label",
		title: "Update a Gmail label",
		description: `Renames or recolours one user-created Gmail label, or changes its visibility. System labels cannot be changed. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({
			account,
			labelId: googleId("Gmail label id"),
			displayName: singleLine(225).min(1).optional(),
			colorPreset,
			labelListVisibility,
			messageListVisibility,
		}),
		run: async (env, args, ctx) => {
			if (!isUserLabel(args.labelId)) throw new ToolError("invalid_input", "Only user-created labels (ids starting with Label_) can be changed.");
			const changes = {
				...(args.displayName ? { name: args.displayName } : {}),
				...(args.colorPreset ? { color: COLOR_PRESETS[args.colorPreset] } : {}),
				...(args.labelListVisibility ? { labelListVisibility: args.labelListVisibility } : {}),
				...(args.messageListVisibility ? { messageListVisibility: args.messageListVisibility } : {}),
			};
			if (Object.keys(changes).length === 0) throw new ToolError("invalid_input", "Invalid input: give at least one field to change.");
			const label = await googleJson<Record<string, any>>(env, args.account, `${GMAIL}/labels/${encodeURIComponent(args.labelId)}`, {
				json: changes,
				method: "PATCH",
				what: "label id",
			});
			ctx.audit.action = "update_label";
			ctx.audit.labelIds = [args.labelId];
			return { labelId: label.id, name: label.name, color: label.color };
		},
	}),

	tool({
		name: "delete_label",
		title: "Delete a Gmail label",
		description: `Deletes one user-created Gmail label (messages keep their other labels). System labels cannot be deleted. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({ account, labelId: googleId("Gmail label id") }),
		run: async (env, args, ctx) => {
			if (!isUserLabel(args.labelId)) throw new ToolError("invalid_input", "Only user-created labels (ids starting with Label_) can be deleted.");
			await googleRequest(env, args.account, `${GMAIL}/labels/${encodeURIComponent(args.labelId)}`, { method: "DELETE", what: "label id" }).then((r) =>
				r.body?.cancel(),
			);
			ctx.audit.action = "delete_label";
			ctx.audit.labelIds = [args.labelId];
			return { deleted: true, labelId: args.labelId };
		},
	}),

	labelOpTool("label_message", "messages", true),
	labelOpTool("unlabel_message", "messages", false),
	labelOpTool("label_thread", "threads", true),
	labelOpTool("unlabel_thread", "threads", false),

	tool({
		name: "update_message_labels",
		title: "Add and remove labels on a message",
		description: `Adds and/or removes labels on one Gmail message (for example remove UNREAD to mark as read, remove INBOX to archive). TRASH and SPAM cannot be added here. ${CONFIRM}`,
		kind: "write",
		schema: z.object({
			account,
			messageId: googleId("Gmail message id"),
			addLabelIds: z.array(googleId("Gmail label id")).max(20).default([]),
			removeLabelIds: z.array(googleId("Gmail label id")).max(20).default([]),
		}),
		run: async (env, args, ctx) => {
			if (args.addLabelIds.length + args.removeLabelIds.length === 0) {
				throw new ToolError("invalid_input", "Invalid input: give at least one label to add or remove.");
			}
			refuseSensitive(args.addLabelIds, "added");
			ctx.audit.messageId = args.messageId;
			ctx.audit.addLabelIds = args.addLabelIds;
			ctx.audit.removeLabelIds = args.removeLabelIds;
			return modify(env, ctx, "messages", args.messageId, args.addLabelIds, args.removeLabelIds);
		},
	}),

	// ----- trash and spam -----
	trashTool("trash_message", "messages", "trash"),
	trashTool("untrash_message", "messages", "untrash"),
	trashTool("trash_thread", "threads", "trash"),
	trashTool("untrash_thread", "threads", "untrash"),
	spamTool("mark_message_spam", "messages", true),
	spamTool("unmark_message_spam", "messages", false),
	spamTool("mark_thread_spam", "threads", true),
	spamTool("unmark_thread_spam", "threads", false),
	sensitiveTool("apply_sensitive_message_label", "messages"),
	sensitiveTool("apply_sensitive_thread_label", "threads"),
];
