import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAccount } from "../src/accounts";
import { b64urlEncode } from "../src/crypto";
import { clearAccessTokenCache } from "../src/google-api";
import { LIMITS, READ_TOOLS, registerReadTools, runReadTool, stripHtml } from "../src/read-tools";

const BASE = "https://gobridge.test";
const CLIENT_REDIRECT = "https://client.example/callback";
// Shaped like real Google tokens so leak checks are meaningful.
const LOGIN_ACCESS_TOKEN = "ya29.fake-login-access-token";
const API_ACCESS_TOKEN = "ya29.fake-api-access-token";
const FAKE_REFRESH_TOKEN = "1//fake-google-refresh-token";
const OWNER_CLAIMS = { sub: "owner-sub-1", email: "owner@example.com", email_verified: true };

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

type Route = (url: URL, request: Request) => Response | undefined;
type GoogleOptions = { refreshStatus?: number };
type GoogleCalls = { api: { url: URL; auth: string | null; range: string | null }[]; refreshes: number };

let counter = 0;
let logSpies: ReturnType<typeof vi.spyOn>[] = [];

/** Links a unique fake account directly in KV (the /link flow has its own tests). */
async function linked() {
	counter += 1;
	const alias = `read-${counter}`;
	await saveAccount(env, {
		alias,
		email: `linked${counter}@example.com`,
		refreshToken: FAKE_REFRESH_TOKEN,
		scopes: [],
		sub: `linked-sub-${counter}`,
	});
	return alias;
}

/** Replaces outbound fetch with a fake Google. Any call no route answers fails the test. */
function mockGoogle(route: Route = () => undefined, options: GoogleOptions = {}): GoogleCalls {
	const calls: GoogleCalls = { api: [], refreshes: 0 };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input as RequestInfo, init);
		const url = new URL(request.url);
		if (request.url === "https://oauth2.googleapis.com/token") {
			const body = await request.formData();
			if (body.get("grant_type") === "refresh_token") {
				calls.refreshes += 1;
				expect(body.get("refresh_token")).toBe(FAKE_REFRESH_TOKEN);
				if (options.refreshStatus) {
					return new Response('{"error":"invalid_grant","error_description":"raw google detail"}', {
						status: options.refreshStatus,
					});
				}
				return Response.json({ access_token: API_ACCESS_TOKEN, expires_in: 3600 });
			}
			return Response.json({ access_token: LOGIN_ACCESS_TOKEN, expires_in: 3600 });
		}
		if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
			return Response.json(OWNER_CLAIMS);
		}
		calls.api.push({
			auth: request.headers.get("Authorization"),
			range: request.headers.get("Range"),
			url,
		});
		const response = route(url, request);
		if (response) return response;
		throw new Error(`Unexpected outbound fetch in test: ${url.origin}${url.pathname}`);
	});
	return calls;
}

const b64 = (text: string) => b64urlEncode(new TextEncoder().encode(text));

function gmailMessage(id: string, body: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		threadId: "thread1",
		labelIds: ["INBOX"],
		snippet: "Snippet of the message",
		payload: {
			mimeType: "multipart/alternative",
			headers: [
				{ name: "From", value: "Alice <alice@example.com>" },
				{ name: "To", value: "linked@example.com" },
				{ name: "Subject", value: "Quarterly plans" },
				{ name: "Date", value: "Mon, 5 Oct 2026 10:00:00 +0000" },
			],
			parts: [
				{
					mimeType: "text/plain",
					headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
					body: { data: b64(body) },
				},
				{ mimeType: "text/html", body: { data: b64(`<p>${body}</p>`) } },
			],
		},
		...extra,
	};
}

async function call(name: string, args: Record<string, unknown>) {
	const result = await runReadTool(env, name, args);
	const text = result.content.map((c) => c.text).join("\n");
	return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

function allLogOutput(): string {
	return logSpies
		.flatMap((spy) => spy.mock.calls)
		.map((args) => args.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
		.join("\n");
}

beforeEach(() => {
	clearAccessTokenCache();
	logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
		vi.spyOn(console, level),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("read tool registration", () => {
	it("registers exactly the spec's read tools, all marked read-only", () => {
		const registered: { name: string; config: any }[] = [];
		const fakeServer = {
			registerTool: (name: string, config: unknown) => registered.push({ config, name }),
		};
		registerReadTools(fakeServer as any, env);

		expect(registered.map((r) => r.name).sort()).toEqual(
			[
				"get_event",
				"list_accounts",
				"list_drafts",
				"list_events",
				"list_labels",
				"read_drive_file",
				"read_email",
				"read_thread",
				"search_drive",
				"search_emails",
			].sort(),
		);
		for (const { config } of registered) {
			expect(config.annotations.readOnlyHint).toBe(true);
			expect(config.annotations.destructiveHint).toBeUndefined();
		}
	});

	it("requires an account alias on every tool except list_accounts", () => {
		for (const tool of READ_TOOLS) {
			expect("account" in tool.schema.shape).toBe(tool.name !== "list_accounts");
		}
	});

	it("tells the model that returned content is untrusted", () => {
		for (const tool of READ_TOOLS) {
			if (["list_accounts", "list_labels"].includes(tool.name)) continue;
			expect(tool.description).toContain("untrusted data");
		}
	});
});

describe("list_accounts", () => {
	it("returns aliases and emails only", async () => {
		const alias = await linked();
		const res = await call("list_accounts", {});
		expect(res.isError).toBe(false);
		const mine = res.json().accounts.find((a: { alias: string }) => a.alias === alias);
		expect(Object.keys(mine).sort()).toEqual(["alias", "email"]);
		expect(res.text).not.toContain("ciphertext");
		expect(res.text).not.toContain("linked-sub-");
	});
});

describe("input validation", () => {
	it("rejects out-of-range and malformed input without calling Google", async () => {
		const alias = await linked();
		const calls = mockGoogle();
		const bad: [string, Record<string, unknown>][] = [
			["search_emails", { account: alias, query: "x", maxResults: 21 }],
			["search_emails", { account: alias, query: "x", maxResults: 0 }],
			["search_emails", { account: alias, query: "" }],
			["search_emails", { account: alias, query: "x".repeat(501) }],
			["search_emails", { account: alias }],
			["search_emails", { query: "x" }],
			["search_emails", { account: "Not An Alias!", query: "x" }],
			["read_email", { account: alias, messageId: "../../drafts" }],
			["read_email", { account: alias, messageId: "abc?format=raw" }],
			["read_thread", { account: alias, threadId: "" }],
			["list_drafts", { account: alias, maxResults: 21 }],
			["list_events", { account: alias, timeMin: "yesterday", timeMax: "2026-10-06T00:00:00Z" }],
			[
				"list_events",
				{ account: alias, timeMin: "2026-10-06T00:00:00Z", timeMax: "2026-10-05T00:00:00Z" },
			],
			[
				"list_events",
				{
					account: alias,
					maxResults: 51,
					timeMin: "2026-10-05T00:00:00Z",
					timeMax: "2026-10-06T00:00:00Z",
				},
			],
			["get_event", { account: alias, eventId: "evt/../x" }],
			["get_event", { account: alias, eventId: "evt1", calendarId: "a/b" }],
			["search_drive", { account: alias, query: "x", maxResults: 21 }],
			["read_drive_file", { account: alias, fileId: "a b" }],
		];
		for (const [name, args] of bad) {
			const res = await call(name, args);
			expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
			expect(res.text).toMatch(/^Invalid input/);
		}
		expect(calls.api).toHaveLength(0);
		expect(calls.refreshes).toBe(0);
	});

	it("gives a clear error for an unknown alias", async () => {
		const calls = mockGoogle();
		const res = await call("list_labels", { account: "no-such-account" });
		expect(res.isError).toBe(true);
		expect(res.text).toContain('No linked account has the alias "no-such-account"');
		expect(calls.api).toHaveLength(0);
		expect(calls.refreshes).toBe(0);
	});
});

describe("Gmail read tools", () => {
	it("search_emails returns headers and snippets from metadata only", async () => {
		const alias = await linked();
		const calls = mockGoogle((url) => {
			if (url.href.startsWith(`${GMAIL}/messages?`)) {
				return Response.json({ messages: [{ id: "m1" }, { id: "m2" }] });
			}
			if (url.pathname.endsWith("/messages/m1") || url.pathname.endsWith("/messages/m2")) {
				const { payload, ...rest } = gmailMessage(url.pathname.split("/").pop()!, "unused");
				return Response.json({ ...rest, payload: { headers: payload.headers } });
			}
		});
		const res = await call("search_emails", { account: alias, query: "from:alice" });
		expect(res.isError).toBe(false);
		expect(res.json().messages).toHaveLength(2);
		expect(res.json().messages[0]).toMatchObject({
			id: "m1",
			from: "Alice <alice@example.com>",
			subject: "Quarterly plans",
			snippet: "Snippet of the message",
		});

		expect(calls.api[0].url.searchParams.get("q")).toBe("from:alice");
		expect(calls.api[0].url.searchParams.get("maxResults")).toBe("10");
		for (const api of calls.api.slice(1)) {
			expect(api.url.searchParams.get("format")).toBe("metadata");
		}
		// The linked account's own access token is used, and fetched only once.
		expect(calls.api.every((api) => api.auth === `Bearer ${API_ACCESS_TOKEN}`)).toBe(true);
		expect(calls.refreshes).toBe(1);
	});

	it("read_email returns the decoded plain-text body and attachment names", async () => {
		const alias = await linked();
		mockGoogle((url) => {
			if (url.pathname.endsWith("/messages/m1")) {
				const message = gmailMessage("m1", "Hello — plain text body ✓");
				message.payload.parts.push({
					mimeType: "application/pdf",
					filename: "report.pdf",
					body: { attachmentId: "att1" },
				} as any);
				return Response.json(message);
			}
		});
		const res = await call("read_email", { account: alias, messageId: "m1" });
		expect(res.json()).toMatchObject({
			id: "m1",
			body: "Hello — plain text body ✓",
			bodyTruncated: false,
			attachments: ["report.pdf"],
			subject: "Quarterly plans",
		});
	});

	it("read_email falls back to stripped HTML", async () => {
		const alias = await linked();
		mockGoogle((url) => {
			if (url.pathname.endsWith("/messages/m1")) {
				return Response.json({
					id: "m1",
					payload: {
						mimeType: "text/html",
						headers: [{ name: "Subject", value: "HTML only" }],
						body: {
							data: b64(
								"<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;there</p><script>alert(1)</script><div>Second &amp; last</div></body></html>",
							),
						},
					},
				});
			}
		});
		const res = await call("read_email", { account: alias, messageId: "m1" });
		expect(res.json().body).toBe("Hi there\nSecond & last");
	});

	it("read_email caps the body at about 20k characters", async () => {
		const alias = await linked();
		mockGoogle((url) => {
			if (url.pathname.endsWith("/messages/big")) {
				return Response.json(gmailMessage("big", "x".repeat(50_000)));
			}
		});
		const res = await call("read_email", { account: alias, messageId: "big" });
		expect(res.json().body).toHaveLength(LIMITS.bodyChars);
		expect(res.json().bodyTruncated).toBe(true);
		expect(res.text.length).toBeLessThan(LIMITS.bodyChars + 2_000);
	});

	it("read_thread caps message count, per-message size, and total size", async () => {
		const alias = await linked();
		mockGoogle((url) => {
			if (url.pathname.endsWith("/threads/t1")) {
				return Response.json({
					id: "t1",
					messages: Array.from({ length: 30 }, (_v, i) => gmailMessage(`m${i}`, "y".repeat(6_000))),
				});
			}
		});
		const res = await call("read_thread", { account: alias, threadId: "t1" });
		const thread = res.json();
		expect(thread.messageCount).toBe(30);
		expect(thread.messages).toHaveLength(LIMITS.threadMessages);
		expect(thread.messagesOmitted).toBe(5);
		expect(thread.messages[0].id).toBe("m5");
		expect(thread.messages[0].body).toHaveLength(LIMITS.threadMessageChars);
		const total = thread.messages.reduce((n: number, m: { body: string }) => n + m.body.length, 0);
		expect(total).toBe(LIMITS.threadTotalChars);
		expect(thread.messages.at(-1).bodyTruncated).toBe(true);
	});

	it("list_labels and list_drafts return bounded summaries", async () => {
		const alias = await linked();
		const calls = mockGoogle((url) => {
			if (url.pathname.endsWith("/labels")) {
				return Response.json({
					labels: [{ id: "INBOX", name: "INBOX", type: "system", messagesTotal: 4 }],
				});
			}
			if (url.pathname.endsWith("/drafts")) return Response.json({ drafts: [{ id: "d1" }] });
			if (url.pathname.endsWith("/drafts/d1")) {
				return Response.json({ id: "d1", message: gmailMessage("m9", "draft body") });
			}
		});
		const labels = await call("list_labels", { account: alias });
		expect(labels.json().labels).toEqual([{ id: "INBOX", name: "INBOX", type: "system" }]);

		const drafts = await call("list_drafts", { account: alias });
		expect(drafts.json().drafts[0]).toMatchObject({
			draftId: "d1",
			messageId: "m9",
			subject: "Quarterly plans",
		});
		expect(drafts.text).not.toContain("draft body");
		const draftGet = calls.api.find((api) => api.url.pathname.endsWith("/drafts/d1"))!;
		expect(draftGet.url.searchParams.get("format")).toBe("metadata");
	});
});

describe("Calendar read tools", () => {
	const event = {
		id: "evt1",
		status: "confirmed",
		summary: "Planning",
		description: "d".repeat(20_000),
		start: { dateTime: "2026-10-05T10:00:00Z" },
		end: { dateTime: "2026-10-05T11:00:00Z" },
		attendees: Array.from({ length: 80 }, (_v, i) => ({
			email: `guest${i}@example.com`,
			responseStatus: "needsAction",
		})),
		htmlLink: "https://calendar.google.com/event?eid=abc",
	};

	it("list_events queries the primary calendar by default and caps descriptions", async () => {
		const alias = await linked();
		const calls = mockGoogle((url) => {
			if (url.pathname === "/calendar/v3/calendars/primary/events") {
				return Response.json({ items: [event], nextPageToken: "more" });
			}
		});
		const res = await call("list_events", {
			account: alias,
			timeMin: "2026-10-05T00:00:00Z",
			timeMax: "2026-10-06T00:00:00-07:00",
		});
		expect(res.isError).toBe(false);
		const listed = res.json();
		expect(listed.moreAvailable).toBe(true);
		expect(listed.events[0].summary).toBe("Planning");
		expect(listed.events[0].description.length).toBeLessThanOrEqual(
			LIMITS.eventListDescriptionChars + 1,
		);
		expect(listed.events[0].attendees).toHaveLength(LIMITS.attendees);
		expect(listed.events[0].attendeesOmitted).toBe(30);

		const params = calls.api[0].url.searchParams;
		expect(params.get("singleEvents")).toBe("true");
		expect(params.get("orderBy")).toBe("startTime");
		expect(params.get("maxResults")).toBe("25");
		expect(params.get("timeMin")).toBe("2026-10-05T00:00:00Z");
	});

	it("get_event reads one event from the given calendar", async () => {
		const alias = await linked();
		const calls = mockGoogle((url) => {
			if (url.href === `${CALENDAR}/team%40example.com/events/evt1`) return Response.json(event);
		});
		const res = await call("get_event", {
			account: alias,
			eventId: "evt1",
			calendarId: "team@example.com",
		});
		expect(res.json().id).toBe("evt1");
		expect(res.json().description.length).toBeLessThanOrEqual(LIMITS.eventDescriptionChars + 1);
		expect(calls.api).toHaveLength(1);
	});
});

describe("Drive read tools", () => {
	it("search_drive escapes the query and asks only for the listed fields", async () => {
		const alias = await linked();
		const calls = mockGoogle((url) => {
			if (url.origin + url.pathname === DRIVE) {
				return Response.json({
					files: [
						{
							id: "f1",
							name: "Budget",
							mimeType: "application/vnd.google-apps.spreadsheet",
							modifiedTime: "2026-10-01T00:00:00Z",
							webViewLink: "https://docs.google.com/spreadsheets/d/f1",
							owners: [{ emailAddress: "someone@example.com" }],
						},
					],
				});
			}
		});
		const res = await call("search_drive", { account: alias, query: "bob's \\ budget" });
		expect(Object.keys(res.json().files[0]).sort()).toEqual(
			["id", "mimeType", "modifiedTime", "name", "webViewLink"].sort(),
		);
		const params = calls.api[0].url.searchParams;
		expect(params.get("q")).toBe("fullText contains 'bob\\'s \\\\ budget' and trashed = false");
		expect(params.get("fields")).toBe(
			"nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
		);
		expect(params.get("orderBy")).toBeNull();
		expect(params.get("pageSize")).toBe("10");
	});

	it("search_drive finds folders by name and lists a folder's contents", async () => {
		const alias = await linked();
		const calls = mockGoogle((url) => {
			if (url.origin + url.pathname === DRIVE) {
				return Response.json({ files: [{ id: "folder1", name: "Projects" }], nextPageToken: "n" });
			}
		});
		const folders = await call("search_drive", { account: alias, query: "Projects", type: "folder" });
		expect(folders.json().files[0].id).toBe("folder1");
		expect(folders.json().moreAvailable).toBe(true);
		expect(calls.api[0].url.searchParams.get("q")).toBe(
			"name contains 'Projects' and trashed = false and mimeType = 'application/vnd.google-apps.folder'",
		);

		await call("search_drive", { account: alias, folderId: "folder1" });
		expect(calls.api[1].url.searchParams.get("q")).toBe(
			"trashed = false and 'folder1' in parents",
		);
		expect(calls.api[1].url.searchParams.get("orderBy")).toBe("folder,name");

		await call("search_drive", { account: alias, query: "notes", folderId: "root" });
		expect(calls.api[2].url.searchParams.get("q")).toBe(
			"fullText contains 'notes' and trashed = false and 'root' in parents",
		);

		// Neither a query nor a folder, or a folder id that could break out of the query.
		for (const args of [{}, { folderId: "x' or '1'='1" }]) {
			const res = await call("search_drive", { account: alias, ...args });
			expect(res.isError).toBe(true);
			expect(res.text).toMatch(/^Invalid input/);
		}
		expect(calls.api).toHaveLength(3);
	});

	function driveFile(mimeType: string, content: string) {
		return (url: URL) => {
			if (url.pathname === "/drive/v3/files/f1/export") return new Response(content);
			if (url.pathname === "/drive/v3/files/f1") {
				return url.searchParams.get("alt") === "media"
					? new Response(content)
					: Response.json({ id: "f1", name: "The file", mimeType });
			}
		};
	}

	it("read_drive_file exports Docs and Slides as text and Sheets as CSV", async () => {
		const alias = await linked();
		const cases = [
			["application/vnd.google-apps.document", "text/plain"],
			["application/vnd.google-apps.presentation", "text/plain"],
			["application/vnd.google-apps.spreadsheet", "text/csv"],
		];
		for (const [mimeType, exportAs] of cases) {
			vi.restoreAllMocks();
			const calls = mockGoogle(driveFile(mimeType, "exported content"));
			const res = await call("read_drive_file", { account: alias, fileId: "f1" });
			expect(res.json()).toMatchObject({
				content: "exported content",
				contentTruncated: false,
				contentType: exportAs,
				name: "The file",
			});
			const exportCall = calls.api.find((api) => api.url.pathname.endsWith("/export"))!;
			expect(exportCall.url.searchParams.get("mimeType")).toBe(exportAs);
		}
	});

	it("read_drive_file downloads plain text with a byte range and caps the result", async () => {
		const alias = await linked();
		const calls = mockGoogle(driveFile("text/plain", "z".repeat(500_000)));
		const res = await call("read_drive_file", { account: alias, fileId: "f1" });
		expect(res.json().content).toHaveLength(LIMITS.driveChars);
		expect(res.json().contentTruncated).toBe(true);
		const download = calls.api.find((api) => api.url.searchParams.get("alt") === "media")!;
		expect(download.range).toBe(`bytes=0-${LIMITS.driveDownloadBytes - 1}`);
	});

	it("read_drive_file refuses non-text files without downloading them", async () => {
		const alias = await linked();
		const calls = mockGoogle(driveFile("application/pdf", "%PDF-1.7 binary"));
		const res = await call("read_drive_file", { account: alias, fileId: "f1" });
		expect(res.isError).toBe(true);
		expect(res.text).toContain("Only Google Docs, Sheets, Slides and plain-text files");
		expect(calls.api).toHaveLength(1); // metadata only
	});
});

describe("errors", () => {
	const RAW = '{"error":{"message":"raw google detail","stack":"at Object.secret (internal.js:1)"}}';

	it("asks for a re-link when Google no longer accepts the refresh token", async () => {
		const alias = await linked();
		const calls = mockGoogle(undefined, { refreshStatus: 400 });
		const res = await call("list_labels", { account: alias });
		expect(res.isError).toBe(true);
		expect(res.text).toContain("re-link this account at /link");
		expect(res.text).not.toContain("raw google detail");
		expect(calls.api).toHaveLength(0);
	});

	it("asks for a re-link when Google rejects the access token", async () => {
		const alias = await linked();
		mockGoogle(() => new Response(RAW, { status: 401 }));
		const res = await call("search_emails", { account: alias, query: "x" });
		expect(res.isError).toBe(true);
		expect(res.text).toContain("re-link this account at /link");
	});

	it("never leaks raw Google responses or stack traces", async () => {
		const alias = await linked();
		for (const status of [400, 403, 404, 429, 500]) {
			vi.restoreAllMocks();
			mockGoogle(() => new Response(RAW, { status }));
			const res = await call("read_email", { account: alias, messageId: "m1" });
			expect(res.isError).toBe(true);
			expect(res.text).not.toContain("raw google detail");
			expect(res.text).not.toContain("internal.js");
			expect(res.text.length).toBeLessThan(300);
		}

		vi.restoreAllMocks();
		mockGoogle(() => {
			throw new Error("boom at secret-internal-frame");
		});
		const res = await call("read_email", { account: alias, messageId: "m1" });
		expect(res.isError).toBe(true);
		expect(res.text).not.toContain("boom");
	});
});

describe("tokens and logging", () => {
	it("no tool response or log line contains a token, and logs carry no content", async () => {
		const alias = await linked();
		mockGoogle((url) => {
			const path = url.pathname;
			if (path.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
			if (path.endsWith("/messages/m1")) return Response.json(gmailMessage("m1", "Secret body text"));
			if (path.endsWith("/threads/t1")) {
				return Response.json({ id: "t1", messages: [gmailMessage("m1", "Secret body text")] });
			}
			if (path.endsWith("/labels")) return Response.json({ labels: [{ id: "L1", name: "Work" }] });
			if (path.endsWith("/drafts")) return Response.json({ drafts: [{ id: "d1" }] });
			if (path.endsWith("/drafts/d1")) {
				return Response.json({ id: "d1", message: gmailMessage("m2", "Draft text") });
			}
			if (path.endsWith("/events")) return Response.json({ items: [{ id: "e1", summary: "Dentist" }] });
			if (path.endsWith("/events/e1")) return Response.json({ id: "e1", summary: "Dentist" });
			if (path.endsWith("/export")) return new Response("Doc text");
			if (path === "/drive/v3/files/f1") {
				return Response.json({ name: "Notes", mimeType: "application/vnd.google-apps.document" });
			}
			if (path === "/drive/v3/files") return Response.json({ files: [{ id: "f1", name: "Notes" }] });
		});

		const range = { timeMin: "2026-10-05T00:00:00Z", timeMax: "2026-10-06T00:00:00Z" };
		const outputs = [
			await call("list_accounts", {}),
			await call("search_emails", { account: alias, query: "confidential-query" }),
			await call("read_email", { account: alias, messageId: "m1" }),
			await call("read_thread", { account: alias, threadId: "t1" }),
			await call("list_labels", { account: alias }),
			await call("list_drafts", { account: alias }),
			await call("list_events", { account: alias, ...range }),
			await call("get_event", { account: alias, eventId: "e1" }),
			await call("search_drive", { account: alias, query: "confidential-query" }),
			await call("read_drive_file", { account: alias, fileId: "f1" }),
			await call("read_email", { account: "no-such-account", messageId: "m1" }),
			await call("read_email", { account: alias, messageId: "bad id" }),
		];
		expect(outputs.slice(0, 10).every((o) => !o.isError)).toBe(true);

		const logs = allLogOutput();
		for (const text of [...outputs.map((o) => o.text), logs]) {
			expect(text).not.toContain("ya29.");
			expect(text).not.toContain("1//");
			expect(text).not.toContain("Bearer ");
		}

		// Logs: tool name, alias, and outcome only.
		expect(logs).toContain(`tool=read_email alias=${alias} ok`);
		expect(logs).toContain("tool=read_email alias=no-such-account error=unknown_alias");
		expect(logs).toContain("tool=read_email error=invalid_input");
		for (const content of [
			"Secret body text",
			"Quarterly plans",
			"alice@example.com",
			"confidential-query",
			"Dentist",
			"Doc text",
			"Notes",
			"@example.com",
		]) {
			expect(logs).not.toContain(content);
		}
	});

	it("stripHtml removes markup, scripts, and styles", () => {
		expect(stripHtml("<div>a<br>b</div><script>x()</script><style>.c{}</style>&lt;ok&gt;")).toBe(
			"a\nb\n<ok>",
		);
	});
});

describe("over /mcp", () => {
	async function pkcePair() {
		const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		return { challenge: b64urlEncode(new Uint8Array(digest)), verifier };
	}

	const cookiesFrom = (res: Response) =>
		res.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.filter((c) => !c.endsWith("="))
			.join("; ");

	/** Full MCP-client OAuth flow; returns a GoBridge access token. */
	async function mcpAccessToken() {
		const registration = await SELF.fetch(`${BASE}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Read Test Client",
				redirect_uris: [CLIENT_REDIRECT],
				token_endpoint_auth_method: "none",
			}),
		});
		const { client_id } = (await registration.json()) as { client_id: string };
		const { verifier, challenge } = await pkcePair();

		const authorizeUrl = new URL(`${BASE}/authorize`);
		authorizeUrl.search = new URLSearchParams({
			response_type: "code",
			client_id,
			redirect_uri: CLIENT_REDIRECT,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: "client-state",
			resource: `${BASE}/mcp`,
		}).toString();
		const dialog = await SELF.fetch(authorizeUrl);
		const html = await dialog.text();
		const approve = await SELF.fetch(`${BASE}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Cookie: cookiesFrom(dialog),
			},
			body: new URLSearchParams({
				state: html.match(/name="state" value="([^"]+)"/)![1],
				csrf_token: html.match(/name="csrf_token" value="([^"]+)"/)![1],
			}).toString(),
		});
		const google = new URL(approve.headers.get("Location")!);
		const callback = await SELF.fetch(
			`${BASE}/callback?code=fake-code&state=${google.searchParams.get("state")}`,
			{ redirect: "manual", headers: { Cookie: cookiesFrom(approve) } },
		);
		const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
		const tokenRes = await SELF.fetch(`${BASE}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id,
				redirect_uri: CLIENT_REDIRECT,
				code_verifier: verifier,
				resource: `${BASE}/mcp`,
			}).toString(),
		});
		return ((await tokenRes.json()) as { access_token: string }).access_token;
	}

	async function rpc(token: string, session: string | null, body: Record<string, unknown>) {
		const res = await SELF.fetch(`${BASE}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(session ? { "mcp-session-id": session } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", ...body }),
		});
		const text = await res.text();
		const data = text
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)));
		const message = data.find((m) => m.id === body.id) ?? (text.startsWith("{") ? JSON.parse(text) : null);
		return { message, res };
	}

	it("lists the read tools and runs one for an authorized client", async () => {
		const alias = await linked();
		mockGoogle((url) => {
			if (url.pathname.endsWith("/labels")) return Response.json({ labels: [{ id: "L1", name: "Work" }] });
		});
		const token = await mcpAccessToken();

		const init = await rpc(token, null, {
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "0" },
			},
		});
		expect(init.res.status).toBe(200);
		const session = init.res.headers.get("mcp-session-id");
		expect(session).toBeTruthy();
		await rpc(token, session, { method: "notifications/initialized" });

		const list = await rpc(token, session, { id: 2, method: "tools/list" });
		const tools = list.message.result.tools as { name: string; annotations: any; inputSchema: any }[];
		expect(tools.map((t) => t.name).sort()).toEqual(READ_TOOLS.map((t) => t.name).sort());
		expect(tools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
		const search = tools.find((t) => t.name === "search_emails")!;
		expect(search.inputSchema.properties.maxResults.maximum).toBe(20);
		expect(search.inputSchema.required).toContain("account");

		const labels = await rpc(token, session, {
			id: 3,
			method: "tools/call",
			params: { name: "list_labels", arguments: { account: alias } },
		});
		expect(labels.message.result.isError).toBeFalsy();
		expect(labels.message.result.content[0].text).toContain("Work");

		// The protocol layer enforces the same zod limits.
		const tooMany = await rpc(token, session, {
			id: 4,
			method: "tools/call",
			params: { name: "search_emails", arguments: { account: alias, query: "x", maxResults: 99 } },
		});
		const failed = tooMany.message.error ?? tooMany.message.result;
		expect(tooMany.message.error || tooMany.message.result.isError).toBeTruthy();
		expect(JSON.stringify(failed)).not.toContain("ya29.");
	});
});
