/**
 * Drive tools (PARITY.md): 11 tools matching Google's Drive connector.
 * Writes are behind DRIVE_WRITE_ENABLED; sharing behind DRIVE_SHARE_ENABLED
 * plus a daily cap. Files are only ever trashed, never deleted.
 */
import { unzipSync } from "fflate";
import { z } from "zod";
import { googleJson, googleRequest, readTextCapped, ToolError } from "../google-api";
import { type KillSwitch, reserveDailyShare } from "../guardrails";
import {
	account,
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
	singleLine,
	stripHtml,
	tool,
	UNTRUSTED,
	untrusted,
} from "./common";

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,owners(emailAddress,displayName),shared,trashed,description,lastModifyingUser(emailAddress)";
const ALL_DRIVES = "supportsAllDrives=true";
const GOOGLE = {
	doc: "application/vnd.google-apps.document",
	folder: "application/vnd.google-apps.folder",
	sheet: "application/vnd.google-apps.spreadsheet",
	slides: "application/vnd.google-apps.presentation",
};
const EXPORT_TEXT: Record<string, string> = { [GOOGLE.doc]: "text/plain", [GOOGLE.sheet]: "text/csv", [GOOGLE.slides]: "text/plain" };
const OFFICE = {
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

type DriveFile = Record<string, any>;

function shapeFile(file: DriveFile) {
	return {
		id: file.id,
		name: untrusted("drive", cap(file.name, LIMITS.headerChars)),
		mimeType: file.mimeType,
		size: file.size !== undefined ? Number(file.size) : undefined,
		createdTime: file.createdTime,
		modifiedTime: file.modifiedTime,
		webViewLink: file.webViewLink,
		parents: Array.isArray(file.parents) ? file.parents.slice(0, 10) : undefined,
		owners: Array.isArray(file.owners) ? file.owners.slice(0, 5).map((o: any) => cap(o?.emailAddress, LIMITS.headerChars)) : undefined,
		lastModifiedBy: cap(file.lastModifyingUser?.emailAddress, LIMITS.headerChars),
		shared: file.shared,
		trashed: file.trashed,
		description: untrusted("drive", cap(file.description, LIMITS.eventListDescriptionChars)),
	};
}

const fileUrl = (fileId: string, extra = "") => `${DRIVE}/${encodeURIComponent(fileId)}?${ALL_DRIVES}${extra}`;

async function metadata(env: Env, alias: string, fileId: string): Promise<DriveFile> {
	return googleJson<DriveFile>(env, alias, fileUrl(fileId, `&fields=${encodeURIComponent(FIELDS)}`), { what: "file id" });
}

async function listFiles(env: Env, alias: string, params: Record<string, string>, what: string) {
	const url = new URL(DRIVE);
	url.searchParams.set("fields", `nextPageToken,files(${FIELDS})`);
	url.searchParams.set("supportsAllDrives", "true");
	url.searchParams.set("includeItemsFromAllDrives", "true");
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return googleJson<{ files?: DriveFile[]; nextPageToken?: string }>(env, alias, url, { what });
}

/** Downloads at most `maxBytes` of a response body; throws if the body is longer. */
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
			throw new ToolError("too_large", `This file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit for this tool.`);
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

// ---------- Office and PDF text ----------

const decodeXml = (xml: string) =>
	xml
		.replace(/<[^>]+>/g, "")
		.replace(/&#(\d+);/g, (_m, c) => String.fromCodePoint(Number(c) || 0xfffd))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");

const decoder = new TextDecoder();

/** Plain text of a .docx, .pptx or .xlsx file (text runs only; no layout). */
export function officeText(bytes: Uint8Array, mimeType: string): string {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes);
	} catch (_e) {
		throw new ToolError("unsupported_file", "This file could not be opened as an Office document.");
	}
	const xml = (name: string) => (files[name] ? decoder.decode(files[name]) : "");
	if (mimeType === OFFICE.docx) {
		return decodeXml(xml("word/document.xml").replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t")).trim();
	}
	if (mimeType === OFFICE.pptx) {
		const slides = Object.keys(files)
			.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
			.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
		return slides
			.map((n, i) => `--- Slide ${i + 1} ---\n${decodeXml(xml(n).replace(/<\/a:p>/g, "\n")).trim()}`)
			.join("\n\n");
	}
	if (mimeType === OFFICE.xlsx) {
		const shared = [...xml("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXml(m[1]));
		const sheets = Object.keys(files)
			.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
			.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
		return sheets
			.map((n, i) => {
				const rows = [...xml(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
					[...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
						.map((cell) => {
							const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? "";
							const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2])?.[1];
							if (/t="s"/.test(cell[1])) return shared[Number(value)] ?? "";
							if (/t="inlineStr"/.test(cell[1])) return decodeXml(inline ?? "");
							return decodeXml(value);
						})
						.join(","),
				);
				return `--- Sheet ${i + 1} ---\n${rows.join("\n")}`;
			})
			.join("\n\n");
	}
	throw new ToolError("unsupported_file", "Unsupported Office format.");
}

async function pdfText(bytes: Uint8Array): Promise<string> {
	try {
		const { extractText, getDocumentProxy } = await import("unpdf");
		const pdf = await getDocumentProxy(new Uint8Array(bytes));
		const { text } = await extractText(pdf, { mergePages: true });
		return String(text).trim();
	} catch (_e) {
		throw new ToolError("unsupported_file", "The text of this PDF could not be extracted.");
	}
}

// ---------- Create helpers ----------

const CONVERT: Record<string, string> = {
	"application/msword": GOOGLE.doc,
	"application/vnd.ms-excel": GOOGLE.sheet,
	"application/vnd.ms-powerpoint": GOOGLE.slides,
	"text/csv": GOOGLE.sheet,
	"text/html": GOOGLE.doc,
	"text/plain": GOOGLE.doc,
	[OFFICE.docx]: GOOGLE.doc,
	[OFFICE.pptx]: GOOGLE.slides,
	[OFFICE.xlsx]: GOOGLE.sheet,
};

function multipartUpload(meta: Record<string, unknown>, bytes: Uint8Array, contentType: string) {
	const boundary = `gobridge_${crypto.randomUUID()}`;
	const enc = new TextEncoder();
	const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`);
	const tail = enc.encode(`\r\n--${boundary}--`);
	const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
	body.set(head, 0);
	body.set(bytes, head.byteLength);
	body.set(tail, head.byteLength + bytes.byteLength);
	return { body, contentType: `multipart/related; boundary=${boundary}` };
}

// ---------- Tools ----------

const driveWrite = (): KillSwitch[] => ["DRIVE_WRITE_ENABLED"];

export const DRIVE_TOOLS = [
	tool({
		name: "search_files",
		title: "Search Google Drive",
		description: `Searches Drive with Google's query syntax, e.g. name contains 'budget' and mimeType = 'application/pdf', fullText contains 'quarterly', '<folderId>' in parents, sharedWithMe = true, modifiedTime > '2026-01-01T00:00:00'. Returns metadata only. ${UNTRUSTED}`,
		kind: "read",
		countKey: "files",
		schema: z.object({
			account,
			query: z.string().trim().min(1).max(1000).describe("Drive search query (Google's structured syntax)"),
			pageSize: pageSize(100, 10),
			pageToken,
			excludeContentSnippets: z.boolean().default(true).describe("Snippets are not available; results are metadata only"),
		}),
		run: async (env, args) => {
			const params: Record<string, string> = { pageSize: String(args.pageSize), q: args.query };
			if (args.pageToken) params.pageToken = args.pageToken;
			const data = await listFiles(env, args.account, params, "search query");
			return { files: (data.files ?? []).slice(0, args.pageSize).map(shapeFile), nextPageToken: data.nextPageToken };
		},
	}),

	tool({
		name: "list_recent_files",
		title: "List recent Drive files",
		description: `Lists Drive files by recency: recently opened by you (recency), last modified by anyone (lastModified), or last modified by you (lastModifiedByMe). ${UNTRUSTED}`,
		kind: "read",
		countKey: "files",
		schema: z.object({ account, orderBy: z.enum(["recency", "lastModified", "lastModifiedByMe"]).default("recency"), pageSize: pageSize(100, 10), pageToken }),
		run: async (env, args) => {
			const orderBy = { lastModified: "modifiedTime desc", lastModifiedByMe: "modifiedByMeTime desc", recency: "recency desc" }[args.orderBy];
			const params: Record<string, string> = { orderBy, pageSize: String(args.pageSize), q: "trashed = false" };
			if (args.pageToken) params.pageToken = args.pageToken;
			const data = await listFiles(env, args.account, params, "page token");
			return { files: (data.files ?? []).slice(0, args.pageSize).map(shapeFile), nextPageToken: data.nextPageToken };
		},
	}),

	tool({
		name: "get_file_metadata",
		title: "Get Drive file metadata",
		description: `Returns one Drive file's metadata: name, type, size, dates, owners, parents, link. ${UNTRUSTED}`,
		kind: "read",
		schema: z.object({ account, fileId: googleId("Drive file id") }),
		run: async (env, args) => shapeFile(await metadata(env, args.account, args.fileId)),
	}),

	tool({
		name: "get_file_permissions",
		title: "Get Drive file permissions",
		description: `Lists who has access to one Drive file (type, role, email or domain). ${UNTRUSTED}`,
		kind: "read",
		countKey: "permissions",
		schema: z.object({ account, fileId: googleId("Drive file id") }),
		run: async (env, args) => {
			const data = await googleJson<{ permissions?: DriveFile[] }>(
				env,
				args.account,
				`${DRIVE}/${encodeURIComponent(args.fileId)}/permissions?${ALL_DRIVES}&pageSize=${LIMITS.permissions}&fields=permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,deleted)`,
				{ what: "file id" },
			);
			return {
				fileId: args.fileId,
				permissions: (data.permissions ?? []).slice(0, LIMITS.permissions).map((p) => ({
					id: p.id,
					type: p.type,
					role: p.role,
					emailAddress: cap(p.emailAddress, LIMITS.headerChars),
					displayName: untrusted("drive", cap(p.displayName, LIMITS.headerChars)),
					domain: cap(p.domain, LIMITS.headerChars),
					allowFileDiscovery: p.allowFileDiscovery,
				})),
			};
		},
	}),

	tool({
		name: "read_file_content",
		title: "Read a Drive file's content",
		description: `Returns the text of one Drive file, capped at about ${LIMITS.fileChars} characters: Google Docs/Sheets/Slides (exported), plain text, PDF, Word/Excel/PowerPoint (text only). PNG and JPEG images are returned as images. includeComments adds the comments on Google files. ${UNTRUSTED}`,
		kind: "read",
		schema: z.object({ account, fileId: googleId("Drive file id"), includeComments: z.boolean().default(false) }),
		run: async (env, args) => {
			const meta = await metadata(env, args.account, args.fileId);
			const mimeType = typeof meta.mimeType === "string" ? meta.mimeType : "";
			const base = { ...shapeFile(meta) };
			const exportAs = EXPORT_TEXT[mimeType];
			let text: string;
			let truncated = false;
			if (exportAs) {
				const resp = await googleRequest(env, args.account, `${DRIVE}/${encodeURIComponent(args.fileId)}/export?mimeType=${encodeURIComponent(exportAs)}`, { what: "file id" });
				const read = await readTextCapped(resp, LIMITS.readBytes);
				text = read.text;
				truncated = read.truncated;
			} else if (mimeType === "image/png" || mimeType === "image/jpeg") {
				const resp = await googleRequest(env, args.account, fileUrl(args.fileId, "&alt=media"), { what: "file id" });
				const bytes = await readBytes(resp, LIMITS.imageBytes);
				return { mcpContent: [{ data: base64(bytes), mimeType, type: "image" as const }, { text: JSON.stringify(base, null, 1), type: "text" as const }] };
			} else if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml") {
				const resp = await googleRequest(env, args.account, fileUrl(args.fileId, "&alt=media"), { what: "file id" }, );
				const read = await readTextCapped(resp, LIMITS.readBytes);
				text = mimeType === "text/html" ? stripHtml(read.text) : read.text;
				truncated = read.truncated;
			} else if (mimeType === "application/pdf" || Object.values(OFFICE).includes(mimeType)) {
				const resp = await googleRequest(env, args.account, fileUrl(args.fileId, "&alt=media"), { what: "file id" });
				const bytes = await readBytes(resp, LIMITS.readBytes);
				text = mimeType === "application/pdf" ? await pdfText(bytes) : officeText(bytes, mimeType);
			} else {
				throw new ToolError(
					"unsupported_file",
					"This file type cannot be read as text. Supported: Google Docs, Sheets, Slides, plain text, PDF, Word, Excel, PowerPoint, PNG and JPEG. Use download_file_content for the raw bytes.",
				);
			}
			const content = capBody(text, LIMITS.fileChars);
			let comments: unknown;
			if (args.includeComments && exportAs) {
				const data = await googleJson<{ comments?: DriveFile[] }>(
					env,
					args.account,
					`${DRIVE}/${encodeURIComponent(args.fileId)}/comments?pageSize=${LIMITS.comments}&fields=comments(id,createdTime,resolved,author(emailAddress,displayName),content,quotedFileContent(value),replies(author(displayName),content,createdTime))`,
					{ what: "file id" },
				);
				comments = (data.comments ?? []).slice(0, LIMITS.comments).map((c) => ({
					id: c.id,
					createdTime: c.createdTime,
					resolved: c.resolved,
					author: untrusted("drive", cap(c.author?.displayName ?? c.author?.emailAddress, LIMITS.headerChars)),
					quoted: untrusted("drive", cap(c.quotedFileContent?.value, 500)),
					content: untrusted("drive", cap(c.content, 2000)),
					replies: Array.isArray(c.replies)
						? c.replies.slice(0, 20).map((r: any) => ({ author: untrusted("drive", cap(r?.author?.displayName, 200)), content: untrusted("drive", cap(r?.content, 2000)), createdTime: r?.createdTime }))
						: undefined,
				}));
			}
			return { ...base, contentType: exportAs ?? mimeType, content: untrusted("drive", content.text), contentTruncated: content.truncated || truncated, comments };
		},
	}),

	tool({
		name: "download_file_content",
		title: "Download a Drive file",
		description: `Returns one Drive file's bytes as base64 (at most 10 MB). Google Docs/Sheets/Slides are exported as exportMimeType (default PDF). revisionId downloads an older revision of a non-Google file.`,
		kind: "read",
		schema: z.object({
			account,
			fileId: googleId("Drive file id"),
			exportMimeType: singleLine(100).optional().describe("For Google files: e.g. application/pdf, text/plain, text/csv"),
			revisionId: googleId("Drive revision id").optional(),
		}),
		run: async (env, args) => {
			const meta = await metadata(env, args.account, args.fileId);
			const mimeType = typeof meta.mimeType === "string" ? meta.mimeType : "";
			const isGoogle = mimeType.startsWith("application/vnd.google-apps.");
			if (!isGoogle && meta.size !== undefined && Number(meta.size) > LIMITS.fileDownloadBytes) {
				throw new ToolError("too_large", "This file is larger than the 10 MB download limit.");
			}
			let url: string;
			let contentType = mimeType;
			if (isGoogle) {
				contentType = args.exportMimeType ?? "application/pdf";
				url = `${DRIVE}/${encodeURIComponent(args.fileId)}/export?mimeType=${encodeURIComponent(contentType)}`;
			} else if (args.revisionId) {
				url = `${DRIVE}/${encodeURIComponent(args.fileId)}/revisions/${encodeURIComponent(args.revisionId)}?alt=media`;
			} else {
				url = fileUrl(args.fileId, "&alt=media");
			}
			const resp = await googleRequest(env, args.account, url, { what: args.revisionId ? "revision id" : isGoogle ? "export type" : "file id" });
			const bytes = await readBytes(resp, LIMITS.fileDownloadBytes);
			return { ...shapeFile(meta), contentType, size: bytes.byteLength, contentBase64: base64(bytes) };
		},
	}),

	tool({
		name: "create_file",
		title: "Create a Drive file",
		description: `Creates a Drive file or folder. Give textContent or base64Content for a file; a contentMimeType of application/vnd.google-apps.folder makes a folder, and the Google document/spreadsheet/presentation types make blank files. Text, CSV and Office content become Google files unless disableConversionToGoogleType is true. ${CONFIRM}`,
		kind: "write",
		schema: z.object({
			account,
			title: singleLine(255).min(1),
			parentId: googleId("Drive folder id").optional(),
			textContent: z.string().max(5_000_000).optional(),
			base64Content: z.string().max(14_000_000).optional().describe("File bytes, base64 (at most 10 MB)"),
			contentMimeType: singleLine(100).optional(),
			disableConversionToGoogleType: z.boolean().default(false),
		}),
		switches: driveWrite,
		run: async (env, args, ctx) => {
			if (args.textContent !== undefined && args.base64Content !== undefined) {
				throw new ToolError("invalid_input", "Invalid input: give textContent or base64Content, not both.");
			}
			ctx.audit.action = "create";
			ctx.audit.parentId = args.parentId;
			const parents = args.parentId ? [args.parentId] : undefined;
			const contentType = args.contentMimeType ?? (args.base64Content ? "application/octet-stream" : "text/plain");
			const hasContent = args.textContent !== undefined || args.base64Content !== undefined;
			let file: DriveFile;
			if (!hasContent) {
				// Folder, blank Google file, or empty file of the given type (blank Doc by default).
				const mimeType = args.contentMimeType ?? GOOGLE.doc;
				file = await googleJson<DriveFile>(env, args.account, `${DRIVE}?${ALL_DRIVES}&fields=${encodeURIComponent(FIELDS)}`, {
					json: { mimeType, name: args.title, parents },
					method: "POST",
					what: "parent folder id",
				});
			} else {
				const bytes = args.base64Content !== undefined ? decodeBase64(args.base64Content) : new TextEncoder().encode(args.textContent);
				if (bytes.byteLength > LIMITS.fileDownloadBytes) throw new ToolError("too_large", "Content is larger than the 10 MB upload limit.");
				const target = !args.disableConversionToGoogleType && CONVERT[contentType] ? CONVERT[contentType] : undefined;
				const upload = multipartUpload({ ...(target ? { mimeType: target } : {}), name: args.title, parents }, bytes, contentType);
				file = await googleJson<DriveFile>(env, args.account, `${UPLOAD}?uploadType=multipart&${ALL_DRIVES}&fields=${encodeURIComponent(FIELDS)}`, {
					body: upload.body,
					headers: { "Content-Type": upload.contentType },
					method: "POST",
					what: "parent folder id or content type",
				});
			}
			ctx.audit.fileId = file.id;
			return { created: true, ...shapeFile(file) };
		},
	}),

	tool({
		name: "copy_file",
		title: "Copy a Drive file",
		description: `Copies one Drive file, optionally with a new title and into another folder. ${CONFIRM}`,
		kind: "write",
		schema: z.object({ account, fileId: googleId("Drive file id"), title: singleLine(255).optional(), parentId: googleId("Drive folder id").optional() }),
		switches: driveWrite,
		run: async (env, args, ctx) => {
			ctx.audit.action = "copy";
			ctx.audit.fileId = args.fileId;
			ctx.audit.parentId = args.parentId;
			const file = await googleJson<DriveFile>(env, args.account, `${DRIVE}/${encodeURIComponent(args.fileId)}/copy?${ALL_DRIVES}&fields=${encodeURIComponent(FIELDS)}`, {
				json: { ...(args.title ? { name: args.title } : {}), ...(args.parentId ? { parents: [args.parentId] } : {}) },
				method: "POST",
				what: "file id or folder id",
			});
			return { copied: true, sourceFileId: args.fileId, ...shapeFile(file) };
		},
	}),

	tool({
		name: "update_file",
		title: "Rename or move a Drive file",
		description: `Renames a Drive file and/or moves it into another folder. Nothing else about the file changes. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({ account, fileId: googleId("Drive file id"), title: singleLine(255).optional(), parentId: googleId("Drive folder id").optional() }),
		switches: driveWrite,
		run: async (env, args, ctx) => {
			if (!args.title && !args.parentId) throw new ToolError("invalid_input", "Invalid input: give a title, a parentId, or both.");
			ctx.audit.action = "update";
			ctx.audit.fileId = args.fileId;
			ctx.audit.parentId = args.parentId;
			let extra = "";
			if (args.parentId) {
				const current = await metadata(env, args.account, args.fileId);
				const previous = Array.isArray(current.parents) ? current.parents.join(",") : "";
				extra = `&addParents=${encodeURIComponent(args.parentId)}${previous ? `&removeParents=${encodeURIComponent(previous)}` : ""}`;
			}
			const file = await googleJson<DriveFile>(env, args.account, fileUrl(args.fileId, `${extra}&fields=${encodeURIComponent(FIELDS)}`), {
				json: args.title ? { name: args.title } : {},
				method: "PATCH",
				what: "file id or folder id",
			});
			return { updated: true, ...shapeFile(file) };
		},
	}),

	tool({
		name: "trash_file",
		title: "Move a Drive file to Trash",
		description: `Moves one Drive file to Trash (restorable for 30 days). Permanent deletion is not possible. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({ account, fileId: googleId("Drive file id") }),
		switches: driveWrite,
		run: async (env, args, ctx) => {
			ctx.audit.action = "trash";
			ctx.audit.fileId = args.fileId;
			const file = await googleJson<DriveFile>(env, args.account, fileUrl(args.fileId, `&fields=${encodeURIComponent(FIELDS)}`), {
				json: { trashed: true },
				method: "PATCH",
				what: "file id",
			});
			return { ...shapeFile(file), trashed: true };
		},
	}),

	tool({
		name: "share_file",
		title: "Share a Drive file",
		description: `Gives one person or Google group access to a Drive file as reader, commenter or writer. Sharing with "anyone" or a whole domain is not possible. Google emails the recipient. A daily share cap applies. ${CONFIRM}`,
		kind: "write",
		destructive: true,
		schema: z.object({ account, fileId: googleId("Drive file id"), emailAddress: email, role: z.enum(["reader", "commenter", "writer"]) }),
		switches: () => ["DRIVE_SHARE_ENABLED"],
		run: async (env, args, ctx) => {
			ctx.audit.action = "share";
			ctx.audit.fileId = args.fileId;
			ctx.audit.recipient = args.emailAddress;
			ctx.audit.role = args.role;
			await reserveDailyShare(env, args.account);
			const url = `${DRIVE}/${encodeURIComponent(args.fileId)}/permissions?${ALL_DRIVES}&sendNotificationEmail=true&fields=id,type,role,emailAddress`;
			const permission = await googleJson<DriveFile>(env, args.account, url, {
				json: { emailAddress: args.emailAddress, role: args.role, type: "user" },
				method: "POST",
				what: "file id or email address",
			}).catch(async (error: unknown) => {
				// A Google group address must be shared as type "group".
				if (error instanceof ToolError && error.category === "invalid_input") {
					return googleJson<DriveFile>(env, args.account, url, { json: { emailAddress: args.emailAddress, role: args.role, type: "group" }, method: "POST", what: "file id or email address" });
				}
				throw error;
			});
			return { shared: true, fileId: args.fileId, permissionId: permission.id, type: permission.type, role: permission.role, emailAddress: args.emailAddress };
		},
	}),
];
