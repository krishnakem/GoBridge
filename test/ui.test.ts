import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAccount } from "../src/accounts";
import { LINK_SCOPES } from "../src/google";
import { listAudit } from "../src/guardrails";
import { ALL_TOOLS, READ_TOOLS, registerTools, runTool, WRITE_TOOLS } from "../src/tools";
import { untrusted } from "../src/tools/common";
import { ACCOUNTS_JS } from "../src/ui/accounts-card";
import { APP_JS, BRIDGE_JS, HELPERS_JS } from "../src/ui/bridge";
import { CALENDAR_JS } from "../src/ui/calendar-card";
import { DRIVE_JS } from "../src/ui/drive-card";
import { MAIL_JS } from "../src/ui/mail-card";
import { WORKSPACE_JS } from "../src/ui/workspace-card";
import { cardHtml, registerUiResources, UI_CARDS, UI_MIME_TYPE, uiCardsMode, uiResourceUri } from "../src/ui/resources";
import { expectInert, HOSTILE, mountCard, textResult } from "./helpers/fake-dom";

const CLIENT = { clientId: "client-ui-1", clientName: "Claude" };
const withCards = (value: unknown) => ({ ...env, UI_CARDS: value }) as Env;

afterEach(() => {
	vi.restoreAllMocks();
});

const SHARED = BRIDGE_JS + HELPERS_JS + APP_JS;
const mailScript = SHARED + MAIL_JS;
const calendarScript = SHARED + CALENDAR_JS;
const accountsScript = SHARED + ACCOUNTS_JS;
const driveScript = SHARED + DRIVE_JS;
const workspaceScript = SHARED + WORKSPACE_JS;
const CARD_SOURCES = [BRIDGE_JS, HELPERS_JS, APP_JS, MAIL_JS, CALENDAR_JS, ACCOUNTS_JS, DRIVE_JS, WORKSPACE_JS];
const W = (value: string) => untrusted("email", value);
const C = (value: string) => untrusted("calendar", value);
const D = (value: string) => untrusted("drive", value);
const FORM_TAGS = ["div", "span", "p", "pre", "button", "svg", "path", "label", "input", "textarea", "select", "option"];
const TABLE_TAGS = [...FORM_TAGS, "table", "thead", "tbody", "tr", "th", "td", "img"];

/** Which card each tool points at. Read tools when cards are on; write tools only when UI_CARDS is "all". */
const READ_CARDS: Record<string, string> = {
	get_event: "calendar",
	get_file_permissions: "drive",
	get_thread: "mail",
	get_values: "workspace",
	list_accounts: "accounts",
	list_events: "calendar",
	list_recent_files: "drive",
	query_drive_activity: "drive",
	read_doc: "workspace",
	read_presentation: "workspace",
	read_slide_page_thumbnail: "workspace",
	search_events: "calendar",
	search_files: "drive",
	search_threads: "mail",
	suggest_time: "calendar",
};
const WRITE_CARDS: Record<string, string> = {};
const metaFor = (card: string) => ({ ui: { resourceUri: `ui://gobridge/${card}.html` }, "ui/resourceUri": `ui://gobridge/${card}.html` });
const expectedMeta = (cards: Record<string, string>) => Object.fromEntries(Object.entries(cards).map(([tool, card]) => [tool, metaFor(card)]));

/** URLs that may appear in a card's source: an XML namespace name and GoBridge's own fixed link targets. */
/** img-src in each card's own policy: 'none' unless listed. */
const IMG_SRC: Record<string, string> = { workspace: "data:" };

const ALLOWED_URLS = new Set(["http://www.w3.org/2000/svg", "https://calendar.google.com/calendar/event?eid=", "https://docs.google.com/", "https://gobridge.test/link"]);

/** Minimal valid arguments for every card-backed tool (the account alias is added by the test). */
const CARD_TOOL_ARGS: Record<string, Record<string, unknown>> = {
	get_event: { eventId: "e1" },
	get_file_permissions: { fileId: "f1" },
	get_thread: { threadId: "t1" },
	get_values: { range: "Sheet1!A1:C3", spreadsheetId: "s1" },
	list_accounts: {},
	list_events: { startTime: "2026-10-05T00:00:00", endTime: "2026-10-06T00:00:00" },
	list_recent_files: {},
	query_drive_activity: { itemName: "f1" },
	read_doc: { commentsIncluded: true, documentId: "d1" },
	read_presentation: { presentationId: "p1" },
	read_slide_page_thumbnail: { pageId: "g1", presentationId: "p1" },
	search_events: { query: "standup" },
	search_files: { query: "title contains 'budget'" },
	search_threads: { query: "is:unread", view: "MINIMAL" },
	suggest_time: { attendeeEmails: ["dana@example.com"], endTime: "2030-01-08T17:00:00", startTime: "2030-01-07T09:00:00" },
};

/** A stand-in Google response with hostile text in every field a card tool reads. */
const GENERIC_GOOGLE = {
	activities: [{ actors: [{ user: { knownUser: { isCurrentUser: true } } }], primaryActionDetail: { rename: { newTitle: HOSTILE.subject, oldTitle: "Old" } }, targets: [{ driveItem: { name: "items/f1", title: HOSTILE.file } }], timestamp: "2026-10-05T13:00:00Z" }],
	body: { content: [{ paragraph: { elements: [{ textRun: { content: `${HOSTILE.body}\n` } }] } }] },
	comments: [{ author: { displayName: HOSTILE.from }, content: HOSTILE.body, id: "c1" }],
	contentUrl: "https://lh3.googleusercontent.com/thumbnail",
	documentId: "d1",
	files: [{ id: "f1", mimeType: "application/pdf", name: HOSTILE.file }],
	heightPx: 900,
	permissions: [{ id: "p1", role: "reader", type: "anyone" }, { displayName: HOSTILE.from, emailAddress: "dana@example.com", id: "p2", role: "writer", type: "user" }],
	slides: [{ objectId: "g1", pageElements: [{ shape: { text: { textElements: [{ textRun: { content: HOSTILE.subject } }] } } }] }],
	title: HOSTILE.subject,
	values: [["Item", "Amount"], [HOSTILE.subject, "-12.50"]],
	widthPx: 1600,
	id: "x1",
	items: [{ end: { dateTime: "2026-10-05T14:00:00Z" }, id: "e1", start: { dateTime: "2026-10-05T13:00:00Z" }, summary: HOSTILE.subject }],
	messages: [{ id: "m1", labelIds: ["INBOX"], payload: { body: { data: btoa("Body") }, headers: [{ name: "Subject", value: HOSTILE.subject }], mimeType: "text/plain" }, threadId: "t1" }],
	threads: [{ id: "t1", snippet: HOSTILE.body }],
};

// ---------- Tests ----------

describe("UI_CARDS switch", () => {
	it("is off unless the value is exactly read or all", () => {
		expect(uiCardsMode(withCards("read"))).toBe("read");
		expect(uiCardsMode(withCards("all"))).toBe("all");
		for (const value of ["off", "", "ALL", "true", "1", undefined, null, 1]) {
			expect(uiCardsMode(withCards(value)), String(value)).toBe("off");
		}
	});

	it("points each card-backed tool at its ui:// resource, write tools only in all mode, and none when off", () => {
		const registeredMeta = (value: unknown) => {
			const registered: Record<string, any> = {};
			registerTools({ registerTool: (name: string, config: any) => (registered[name] = config) } as any, withCards(value), () => CLIENT);
			return Object.fromEntries(Object.entries(registered).filter(([, config]) => "_meta" in config).map(([name, config]) => [name, config._meta]));
		};
		expect(registeredMeta("read")).toEqual(expectedMeta(READ_CARDS));
		expect(registeredMeta("all")).toEqual(expectedMeta({ ...READ_CARDS, ...WRITE_CARDS }));
		expect(registeredMeta("off")).toEqual({});
		expect(registeredMeta(undefined)).toEqual({});
		for (const name of Object.keys(READ_CARDS)) expect(READ_TOOLS.some((t) => t.name === name), name).toBe(true);
		for (const name of Object.keys(WRITE_CARDS)) expect(WRITE_TOOLS.some((t) => t.name === name), name).toBe(true);
	});

	it("keeps the 72 tools (28 reads, 44 writes)", () => {
		expect(ALL_TOOLS).toHaveLength(72);
		expect(READ_TOOLS).toHaveLength(28);
		expect(WRITE_TOOLS).toHaveLength(44);
	});
});

describe("ui:// resources", () => {
	const collect = (value: unknown) => {
		const registered: { name: string; uri: string; config: any; read: () => Promise<any> }[] = [];
		registerUiResources(
			{ registerResource: (name: string, uri: string, config: any, read: any) => registered.push({ config, name, read, uri }) } as any,
			withCards(value),
		);
		return registered;
	};

	it("registers nothing when cards are off", () => {
		expect(collect("off")).toEqual([]);
		expect(collect(undefined)).toEqual([]);
	});

	it("serves each card as an MCP App document that declares no outside origin", async () => {
		for (const mode of ["read", "all"]) {
			const registered = collect(mode);
			expect(registered.map((r) => r.uri)).toEqual(UI_CARDS.map((card) => `ui://gobridge/${card}.html`));
			for (const resource of registered) {
				expect(resource.config.mimeType).toBe(UI_MIME_TYPE);
				const { contents } = await resource.read();
				expect(contents).toHaveLength(1);
				expect(contents[0].uri).toBe(resource.uri);
				expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
				expect(contents[0]._meta.ui).toEqual({
					csp: { baseUriDomains: [], connectDomains: [], frameDomains: [], resourceDomains: [] },
					prefersBorder: false,
				});
				expect(contents[0]._meta.ui.permissions).toBeUndefined();
				expect(contents[0]._meta.ui.domain).toBeUndefined();
			}
		}
	});

	it("builds constant, self-contained HTML with a hash-pinned policy", async () => {
		for (const mode of ["read", "all"]) {
			for (const card of UI_CARDS) {
				const html = await cardHtml(card, withCards(mode));
				expect(await cardHtml(card, withCards(mode))).toBe(html);
				expect(uiResourceUri(card)).toMatch(/^ui:\/\/gobridge\/[a-z]+\.html$/);
				expect(html).toContain(`var GB_WRITES=${mode === "all"};`);

				// No outside URL anywhere in the bundle: the only URLs are an XML
				// namespace name and GoBridge's own fixed link targets.
				for (const url of html.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\\]*/gi) ?? []) expect(ALLOWED_URLS, `${card}: ${url}`).toContain(url);
				// No protocol-relative address either.
				expect(html).not.toMatch(/["'`(=\s]\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i);
				expect(html).not.toMatch(/@import|url\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|navigator\./);

				// One script, one style, no markup that loads or submits anything.
				expect(html.match(/<script>/g)).toHaveLength(1);
				expect(html.match(/<\/script>/g)).toHaveLength(1);
				expect(html.match(/<style>/g)).toHaveLength(1);
				const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
				const style = /<style>([\s\S]*)<\/style>/.exec(html)![1];
				const shell = html.replace(script, "").replace(style, "");
				expect(shell).not.toMatch(/\b(src|href|srcset|action)\s*=/i);
				expect(shell).not.toMatch(/<(img|iframe|link|object|embed|form|a)\b/i);
				expect(shell).not.toMatch(/\son[a-z]+\s*=/i);

				const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)![1];
				const hash = async (text: string) =>
					btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));
				expect(policy).toBe(
					`default-src 'none'; script-src 'sha256-${await hash(script)}'; style-src 'sha256-${await hash(style)}'; img-src ${IMG_SRC[card] ?? "'none'"}; connect-src 'none'; base-uri 'none'; form-action 'none'`,
				);
				expect(policy).not.toContain("unsafe");
				expect(policy).not.toMatch(/https?:|\*/);
			}
		}
	});

	it("puts GoBridge's own /link address in the accounts card only, and only for an https BASE_URL", async () => {
		expect(await cardHtml("accounts", withCards("read"))).toContain('var GB_LINK_URL="https://gobridge.test/link";');
		expect(await cardHtml("accounts", { ...withCards("read"), BASE_URL: "http://gobridge.test" } as Env)).toContain('var GB_LINK_URL="";');
		expect(await cardHtml("accounts", { ...withCards("read"), BASE_URL: 'https://x"</script>' } as Env)).toContain('var GB_LINK_URL="";');
		for (const card of UI_CARDS.filter((c) => c !== "accounts")) expect(await cardHtml(card, withCards("read"))).not.toContain("GB_LINK_URL=");
	});

	it("never uses an HTML-parsing or code-evaluating sink in card scripts", () => {
		for (const source of CARD_SOURCES) {
			expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\s*\(\s*["']|setInterval|srcdoc|createContextualFragment|DOMParser|\.href\s*=|(window|document|self|top)\.location|\blocation\.(href|assign|replace|reload)|window\.open/);
			expect(source).not.toMatch(/ui\/message|ui\/update-model-context|sampling\/|console\./);
			// Attributes are only ever set from constants: a literal name, then a literal or a fixed icon path.
			for (const call of source.match(/setAttribute\([^)]*\)/g) ?? []) {
				expect(call).toMatch(/^setAttribute\("(data-theme|viewBox|class|aria-hidden|aria-label|d)", ("[^"]*"|context\.theme|label|ICON_PATHS\[name\])\)$/);
			}
		}
	});
});

describe("mail card", () => {
	it("completes the handshake and applies the host theme", async () => {
		const card = await mountCard(mailScript);
		const init = card.sent.find((m) => m.method === "ui/initialize");
		expect(init.params.protocolVersion).toBe("2026-01-26");
		expect(card.sent.some((m) => m.method === "ui/notifications/initialized" && m.id === undefined)).toBe(true);
		expect(card.html.attributes["data-theme"]).toBe("dark");
	});

	it("ignores messages that do not come from the host frame", async () => {
		const card = await mountCard(mailScript);
		card.host({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: textResult({ threads: [] }) }, { other: "frame" });
		expect(card.root.textContent).toBe("");
		card.notify("ui/notifications/tool-result", textResult({ threads: [] }));
		expect(card.root.textContent).toContain("No conversations found.");
	});

	it("shows the header strip: tool name, Read badge, account chip and key arguments", async () => {
		const card = await mountCard(mailScript, { tool: "search_threads" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "michigan", query: "is:unread", pageSize: 10 } });
		card.notify("ui/notifications/tool-result", textResult({ threads: [] }));
		const texts = card.root.texts();
		expect(texts).toContain("search_threads");
		expect(texts).toContain("Read");
		expect(texts).toContain("query: is:unread · pageSize: 10");
		const chip = card.nodes().find((n) => n.className.startsWith("chip"))!;
		expect(chip.textContent).toBe("michigan");
		expect(chip.className).toBe("chip chip-indigo");
	});

	it("shows hostile email content as inert text and offers no link for it", async () => {
		const card = await mountCard(mailScript, { tool: "get_thread" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "work", threadId: "t1" } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({
				messageCount: 1,
				messages: [
					{
						attachments: [{ filename: W(HOSTILE.file), mimeType: "application/pdf", size: 2048 }],
						body: W(HOSTILE.body),
						date: "Mon, 5 Oct 2026 10:00:00 +0000",
						from: W(HOSTILE.from),
						id: "m1",
						labelIds: ["INBOX", HOSTILE.subject, "Label_7"],
						subject: W(HOSTILE.subject),
						to: W("me@example.com"),
					},
				],
				threadId: "t1",
				viewUrl: "javascript:alert(1)",
			}),
		);
		const texts = card.root.texts();
		expect(texts).toContain(HOSTILE.subject);
		expect(texts).toContain(HOSTILE.from);
		// The wrapper is removed and the escaped closing tag is restored, as text.
		expect(texts).toContain(HOSTILE.body);
		expect(texts).toContain(`${HOSTILE.file} · 2 KB`);
		expect(texts).toContain("Inbox");
		expect(texts).toContain("+1 label");
		expect(card.root.textContent).not.toContain("<untrusted_content");
		expect(card.buttons("Open in Gmail")).toEqual([]);
		expect(card.sent.some((m) => m.method === "ui/open-link")).toBe(false);
		expectInert(card);
	});

	it("shows a very long hostile string as one text node", async () => {
		const card = await mountCard(mailScript, { tool: "search_threads" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "work" } });
		card.notify("ui/notifications/tool-result", textResult({ threads: [{ from: W(HOSTILE.long), snippet: W(HOSTILE.long), subject: W(HOSTILE.long), threadId: "t1" }] }));
		expect(card.root.texts().filter((t) => t === HOSTILE.long)).toHaveLength(3);
		expectInert(card);
	});

	it("refuses look-alike Gmail links", async () => {
		for (const viewUrl of ["http://mail.google.com/mail/#all/t1", "https://mail.google.com.evil.example/", "https://evil.example/?https://mail.google.com/", "data:text/html,x"]) {
			const card = await mountCard(mailScript, { tool: "get_thread" });
			card.notify("ui/notifications/tool-result", textResult({ messages: [], threadId: "t1", viewUrl }));
			expect(card.buttons("Open in Gmail"), viewUrl).toEqual([]);
		}
	});

	it("opens a search result through get_thread and Gmail through the host", async () => {
		const card = await mountCard(mailScript, { tool: "search_threads" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "work", query: "from:dana" } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({
				nextPageToken: "next",
				threads: [{ from: W("Dana <dana@example.com>"), labelIds: ["UNREAD"], lastDate: "Mon, 5 Oct 2026 10:00:00 +0000", messageCount: 3, snippet: W("Two things"), subject: W("Q4 planning"), threadId: "t9" }],
			}),
		);
		expect(card.root.textContent).toContain("Q4 planning");
		expect(card.root.textContent).toContain("3 messages");
		// Nothing is fetched until the user asks.
		expect(card.calls()).toEqual([]);

		card.buttons("Q4 planning")[0].click();
		expect(card.calls()).toEqual([{ arguments: { account: "work", messageFormat: "PLAIN_TEXT", threadId: "t9" }, name: "get_thread" }]);

		const viewUrl = "https://mail.google.com/mail/?authuser=me%40example.com#all/t9";
		await card.reply("tools/call", textResult({ messageCount: 1, messages: [{ body: W("Two things before Thursday"), from: W("Dana"), subject: W("Q4 planning") }], threadId: "t9", viewUrl }));
		expect(card.root.textContent).toContain("Two things before Thursday");
		expect(card.root.texts()).toContain("get_thread");

		card.buttons("Open in Gmail")[0].click();
		expect(card.sent.find((m) => m.method === "ui/open-link").params).toEqual({ url: viewUrl });

		card.buttons("Back")[0].click();
		expect(card.root.textContent).toContain("1 conversation.");

		card.buttons("Load more")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "work", pageToken: "next", query: "from:dana" }, name: "search_threads" }]);
		await card.reply("tools/call", textResult({ threads: [{ subject: W("Older"), threadId: "t8" }] }));
		expect(card.root.textContent).toContain("2 conversations.");
		expect(card.buttons("Load more")).toEqual([]);
		expectInert(card);
	});

	it("searches the other accounts only when asked, one counted call each", async () => {
		const card = await mountCard(mailScript, { tool: "search_threads" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "michigan", query: "is:unread" } });
		card.notify("ui/notifications/tool-result", textResult({ threads: [{ subject: W("Mine"), threadId: "t1" }] }));
		expect(card.calls()).toEqual([]);

		card.buttons("Show other accounts")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: {}, name: "list_accounts" }]);
		await card.reply("tools/call", textResult({ accounts: [{ alias: "michigan", email: "a@example.com" }, { alias: "gmail", email: "b@example.com" }, { alias: "kemisetti", email: "c@example.com" }] }));
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", query: "is:unread" }, name: "search_threads" }]);
		await card.reply("tools/call", textResult({ threads: [{ subject: W("Theirs"), threadId: "t2" }] }));
		await card.reply("tools/call", textResult("Rate limit reached", true));

		expect(card.root.textContent).toContain("Theirs");
		expect(card.root.textContent).toContain("1 account could not be searched.");
		expect(card.nodes().filter((n) => n.className.startsWith("chip ")).map((n) => n.className)).toEqual(["chip chip-indigo", "chip chip-teal"]);
		expect(card.buttons("Show other accounts")).toEqual([]);

		// A row from another account opens with that account.
		card.buttons("Theirs")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", messageFormat: "PLAIN_TEXT", threadId: "t2" }, name: "get_thread" }]);
	});

	it("shows a refusal from GoBridge as text and cannot open threads without an account", async () => {
		const card = await mountCard(mailScript, { tool: "search_threads" });
		card.notify("ui/notifications/tool-result", textResult("Rate limit reached: <b>try later</b>", true));
		expect(card.root.texts()).toContain("Rate limit reached: <b>try later</b>");

		card.notify("ui/notifications/tool-result", textResult({ threads: [{ subject: W("Hello"), threadId: "t1" }] }));
		card.buttons("Hello")[0].click();
		expect(card.calls()).toEqual([]);
		expect(card.buttons("Show other accounts")).toEqual([]);
	});

	it("works out the view from the result when the host does not name the tool", async () => {
		const card = await mountCard(mailScript);
		card.notify("ui/notifications/tool-result", textResult({ messages: [{ body: W("Hi"), from: W("Dana") }], threadId: "t1" }));
		expect(card.root.texts()).toContain("get_thread");
		card.notify("ui/notifications/tool-result", textResult({ something: "else" }));
		expect(card.root.textContent).toContain("This result cannot be shown as a card.");
	});

	it("answers the host's teardown request", async () => {
		const card = await mountCard(mailScript);
		card.host({ id: 77, jsonrpc: "2.0", method: "ui/resource-teardown", params: {} });
		expect(card.sent).toContainEqual({ id: 77, jsonrpc: "2.0", result: {} });
	});
});

describe("calendar card", () => {
	const event = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ end, eventId: id, start, summary: C(summary), ...extra });
	const day = (events: unknown[]) => textResult({ events });

	it("draws the day from 9 AM to 5 PM, marks overlaps and lists events outside it", async () => {
		const card = await mountCard(calendarScript, { tool: "list_events" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", startTime: "2026-10-05T00:00:00", timeZone: "America/Detroit" } });
		card.notify(
			"ui/notifications/tool-result",
			day([
				event("e1", "Standup", "2026-10-05T09:00:00-04:00", "2026-10-05T10:00:00-04:00"),
				event("e2", "Review", "2026-10-05T09:30:00-04:00", "2026-10-05T10:30:00-04:00"),
				event("e3", "Lunch", "2026-10-05T13:00:00-04:00", "2026-10-05T14:00:00-04:00"),
				event("e4", "Dinner", "2026-10-05T19:00:00-04:00", "2026-10-05T20:00:00-04:00"),
				event("e5", "Holiday", "2026-10-05", "2026-10-06"),
				event("e6", "Tomorrow", "2026-10-06T09:00:00-04:00", "2026-10-06T10:00:00-04:00"),
			]),
		);
		const blocks = card.nodes().filter((n) => n.tagName === "button" && n.className.startsWith("ev "));
		expect(blocks.map((b) => b.children[0].textContent)).toEqual(["Standup", "Review", "Lunch"]);
		expect(blocks.map((b) => b.className)).toEqual(["ev chip-teal ev-conflict", "ev chip-teal ev-conflict", "ev chip-teal"]);
		expect(blocks[0].styles).toEqual({ height: "12.5%", left: "0%", top: "0%", width: "50%" });
		expect(blocks[1].styles).toEqual({ height: "12.5%", left: "50%", top: "6.25%", width: "50%" });
		expect(blocks[2].styles.top).toBe("50%");
		const text = card.root.textContent;
		expect(text).toContain("9 AM to 10 AM · Overlaps");
		expect(text).toContain("2 events overlap.");
		expect(text).toContain("1 event outside 9 AM to 5 PM");
		expect(text).toContain("Dinner");
		expect(text).toContain("Holiday");
		expect(text).not.toContain("Tomorrow");
		expect(text).toContain("This result covers 2 days");
		expect(card.calls()).toEqual([]);
	});

	it("moves a day at a time with one list_events call for the shown account", async () => {
		const card = await mountCard(calendarScript, { tool: "list_events" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", calendarId: "team@example.com", startTime: "2026-10-31T00:00:00", timeZone: "America/Detroit" } });
		card.notify("ui/notifications/tool-result", day([]));
		expect(card.root.textContent).toContain("Nothing on this day.");
		card.labelled("Next day")[0].click();
		expect(card.pendingCalls()).toEqual([
			{ arguments: { account: "gmail", calendarId: "team@example.com", endTime: "2026-11-02T00:00:00", startTime: "2026-11-01T00:00:00", timeZone: "America/Detroit" }, name: "list_events" },
		]);
		await card.reply("tools/call", day([event("e9", "Brunch", "2026-11-01T11:00:00-04:00", "2026-11-01T12:00:00-04:00")]));
		expect(card.root.textContent).toContain("Brunch");
		card.labelled("Previous day")[0].click();
		expect(card.pendingCalls()[0].arguments.startTime).toBe("2026-10-31T00:00:00");
	});

	it("adds the other accounts only when asked and colours events by account", async () => {
		const card = await mountCard(calendarScript, { tool: "list_events" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", startTime: "2026-10-05T00:00:00" } });
		card.notify("ui/notifications/tool-result", day([event("e1", "Mine", "2026-10-05T09:00:00-04:00", "2026-10-05T10:00:00-04:00")]));
		expect(card.calls()).toEqual([]);
		card.buttons("Show other accounts")[0].click();
		await card.reply("tools/call", textResult({ accounts: [{ alias: "gmail" }, { alias: "michigan" }] }));
		await card.reply("tools/call", day([event("e1", "Mine", "2026-10-05T09:00:00-04:00", "2026-10-05T10:00:00-04:00")]));
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "michigan", endTime: "2026-10-06T00:00:00", startTime: "2026-10-05T00:00:00" }, name: "list_events" }]);
		await card.reply("tools/call", day([event("e2", "Class", "2026-10-05T09:30:00-04:00", "2026-10-05T10:30:00-04:00")]));
		const blocks = card.nodes().filter((n) => n.tagName === "button" && n.className.startsWith("ev "));
		expect(blocks.map((b) => b.className)).toEqual(["ev chip-teal ev-conflict", "ev chip-indigo ev-conflict"]);
	});

	it("shows hostile event text as inert text", async () => {
		const card = await mountCard(calendarScript, { tool: "list_events" });
		card.notify("ui/notifications/tool-input", { arguments: { account: HOSTILE.from, startTime: "2026-10-05T00:00:00", timeZone: HOSTILE.subject } });
		card.notify(
			"ui/notifications/tool-result",
			day([
				event("e1", HOSTILE.body, "2026-10-05T09:00:00-04:00", "2026-10-05T10:00:00-04:00", { htmlLink: "javascript:alert(1)", location: C(HOSTILE.subject) }),
				event("e2", HOSTILE.long, "2026-10-05", "2026-10-06"),
				event("e3", HOSTILE.subject, "2026-10-05T20:00:00-04:00", "2026-10-05T21:00:00-04:00"),
				event(HOSTILE.subject, HOSTILE.file, `2026-10-05T09:00:00"><script>alert(1)</script>`, HOSTILE.body),
			]),
		);
		const texts = card.root.texts();
		expect(texts).toContain(HOSTILE.body);
		expect(texts).toContain(HOSTILE.long);
		expect(texts).toContain(HOSTILE.subject);
		expect(card.nodes().find((n) => n.className.startsWith("chip"))!.className).toBe("chip chip-other");
		expectInert(card);
	});
});

describe("calendar card: events, search and suggested times", () => {
	const eventData = {
		attendees: [
			{ displayName: C(HOSTILE.from), email: C("dana@example.com"), responseStatus: "accepted" },
			{ email: C("me@example.com"), responseStatus: "needsAction", self: true },
			{ email: C("lee@example.com"), optional: true, responseStatus: HOSTILE.subject },
		],
		attendeesOmitted: 2,
		description: C(HOSTILE.body),
		end: "2026-10-05T10:00:00-04:00",
		eventId: "e1",
		htmlLink: "https://www.google.com/calendar/event?eid=YWJjMTIz",
		location: C(HOSTILE.subject),
		start: "2026-10-05T09:00:00-04:00",
		summary: C(HOSTILE.file),
		timeZone: "America/Detroit",
	};

	it("shows one event with its guests and RSVPs, hostile text inert", async () => {
		const card = await mountCard(calendarScript, { tool: "get_event" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", eventId: "e1" } });
		card.notify("ui/notifications/tool-result", textResult(eventData));
		const texts = card.root.texts();
		expect(texts).toContain(HOSTILE.file);
		expect(texts).toContain(HOSTILE.body);
		expect(texts).toContain(HOSTILE.subject);
		expect(texts).toContain("3 guests");
		expect(texts).toContain(`${HOSTILE.from} · dana@example.com`);
		expect(texts).toContain("me@example.com (you)");
		expect(texts).toEqual(expect.arrayContaining(["Yes", "No reply", "Unknown", "Optional", "2 more guests not shown."]));
		expect(card.root.textContent).toContain("9 AM to 10 AM (America/Detroit)");
		card.buttons("Open in Calendar")[0].click();
		expect(card.sent.find((m) => m.method === "ui/open-link").params).toEqual({ url: "https://calendar.google.com/calendar/event?eid=YWJjMTIz" });
		expectInert(card);
	});

	it("opens only Google's own event link, rebuilt on calendar.google.com", async () => {
		for (const htmlLink of ["javascript:alert(1)", "https://evil.example/calendar/event?eid=abc", "http://www.google.com/calendar/event?eid=abc", "https://www.google.com/calendar/event?eid=a%22b", "https://www.google.com/calendar/event"]) {
			const card = await mountCard(calendarScript, { tool: "get_event" });
			card.notify("ui/notifications/tool-result", textResult({ ...eventData, htmlLink }));
			expect(card.buttons("Open in Calendar"), htmlLink).toEqual([]);
		}
	});

	it("groups search results by week and opens an event through get_event", async () => {
		vi.useFakeTimers({ now: new Date(2026, 9, 7, 12), toFake: ["Date"] });
		try {
			const card = await mountCard(calendarScript, { tool: "search_events" });
			card.notify("ui/notifications/tool-input", { arguments: { account: "michigan", query: "review" } });
			const at = (id: string, date: string) => ({ end: `${date}T10:00:00-04:00`, eventId: id, location: C("Room 2"), start: `${date}T09:00:00-04:00`, summary: C(`Event ${id}`) });
			card.notify("ui/notifications/tool-result", textResult({ events: [at("a", "2026-10-01"), at("b", "2026-10-05"), at("c", "2026-10-11"), at("d", "2026-10-12"), at("e", "2026-11-20")], nextPageToken: "n2" }));
			const order = card.root.texts().filter((t) => ["Earlier", "This week", "Next week", "Later"].includes(t) || /^Event [a-e]$/.test(t));
			expect(order, JSON.stringify(order)).toEqual(["Earlier", "Event a", "This week", "Event b", "Event c", "Next week", "Event d", "Later", "Event e"]);
			expect(card.root.textContent).toContain("9 AM to 10 AM · Room 2");
			expect(card.calls()).toEqual([]);
			card.buttons("Event d")[0].click();
			expect(card.pendingCalls()).toEqual([{ arguments: { account: "michigan", eventId: "d" }, name: "get_event" }]);
			await card.reply("tools/call", textResult(eventData));
			expect(card.root.texts()).toContain("get_event");
			card.buttons("Back")[0].click();
			card.buttons("Load more")[0].click();
			expect(card.pendingCalls()).toEqual([{ arguments: { account: "michigan", pageToken: "n2", query: "review" }, name: "search_events" }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows suggested times as day columns with a best pick and a chosen slot", async () => {
		const card = await mountCard(calendarScript, { tool: "suggest_time" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", attendeeEmails: ["dana@example.com"], durationMinutes: 30 } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({
				checked: ["me@example.com", "dana@example.com"],
				durationMinutes: 30,
				freeBusyUnavailableFor: ["dana@example.com"],
				suggestions: [
					{ end: "2026-10-05T09:30:00-04:00", start: "2026-10-05T09:00:00-04:00" },
					{ end: "2026-10-05T14:30:00-04:00", start: "2026-10-05T14:00:00-04:00" },
					{ end: "2026-10-06T10:30:00-04:00", start: "2026-10-06T10:00:00-04:00" },
					{ end: HOSTILE.subject, start: HOSTILE.body },
				],
				timeZone: "America/Detroit",
			}),
		);
		const slots = card.nodes().filter((n) => n.tagName === "button" && n.className.includes("slot"));
		expect(slots.map((s) => [s.textContent, s.className])).toEqual([
			["9 AM to 9:30 AM", "btn slot slot-best"],
			["2 PM to 2:30 PM", "btn slot"],
			["10 AM to 10:30 AM", "btn slot"],
		]);
		expect(card.root.textContent).toContain("Pick a time.");
		expect(card.root.textContent).toContain("1 calendar could not be read and is not counted.");
		// The addresses GoBridge checked are counted, not listed.
		expect(card.root.textContent).not.toContain("me@example.com");
		slots[2].click();
		expect(card.root.textContent).toContain("Chosen: Tuesday, Oct 6, 10 AM to 10:30 AM (America/Detroit)");
		expect(card.nodes().filter((n) => n.className.includes("slot-on"))).toHaveLength(1);
		// Read-only build: no way to book from the card.
		expect(card.buttons("Book")).toEqual([]);
		expectInert(card);
	});

	it("finds free time for the shown day only after the user fills in the form", async () => {
		const card = await mountCard(calendarScript, { tool: "list_events" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", startTime: "2026-10-05T00:00:00", timeZone: "America/Detroit" } });
		card.notify("ui/notifications/tool-result", textResult({ events: [] }));
		card.buttons("Find free time")[0].click();
		card.buttons("Find times")[0].click();
		expect(card.root.textContent).toContain("Enter at least one email address.");
		expect(card.calls()).toEqual([]);
		card.control("Who to meet").enter("Dana <dana@example.com>, lee@example.com");
		card.control("Length").enter("60");
		card.buttons("Find times")[0].click();
		expect(card.calls()).toEqual([
			{
				arguments: { account: "gmail", attendeeEmails: ["dana@example.com", "lee@example.com"], durationMinutes: 60, endTime: "2026-10-05T17:00:00", startTime: "2026-10-05T09:00:00", timeZone: "America/Detroit" },
				name: "suggest_time",
			},
		]);
		await card.reply("tools/call", textResult({ suggestions: [], timeZone: "America/Detroit" }));
		expect(card.root.textContent).toContain("No time fits everyone in this range.");
		// Back goes to the day, not to the form.
		card.buttons("Back")[0].click();
		expect(card.root.texts()).toContain("list_events");
		expectInert(card, FORM_TAGS);
	});
});

describe("drive card", () => {
	const FOLDER = "application/vnd.google-apps.folder";
	const file = (id: string, name: string, mimeType: string, extra: Record<string, unknown> = {}) => ({ id, mimeType, modifiedTime: "2026-10-05T13:00:00Z", name: D(name), ...extra });

	it("lists files with type badges and shows hostile names as inert text", async () => {
		const card = await mountCard(driveScript, { tool: "search_files" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "kemisetti", query: "title contains 'plan'" } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({
				files: [
					file("f1", "Folder", FOLDER),
					file("f2", HOSTILE.file, "application/vnd.google-apps.document"),
					file("f3", HOSTILE.subject, "application/vnd.google-apps.spreadsheet"),
					file("f4", HOSTILE.long, "application/vnd.google-apps.presentation"),
					file("f5", "a.pdf", "application/pdf"),
					file("f6", "notes.md", "text/plain"),
					file(HOSTILE.subject, HOSTILE.body, HOSTILE.subject, { modifiedTime: HOSTILE.subject, webViewLink: "javascript:alert(1)" }),
				],
			}),
		);
		const badges = card.nodes().filter((n) => n.className.startsWith("type"));
		expect(badges.map((b) => b.textContent)).toEqual(["DIR", "DOC", "XLS", "PPT", "PDF", "MD", "FILE"]);
		expect(card.root.texts()).toEqual(expect.arrayContaining([HOSTILE.file, HOSTILE.subject, HOSTILE.long, HOSTILE.body]));
		expect(card.calls()).toEqual([]);

		// A file with a hostile id and link offers nothing that would use them.
		card.buttons(HOSTILE.body)[0].click();
		expect(card.buttons("Open in Drive")).toEqual([]);
		expect(card.buttons("Who has access")).toEqual([]);
		expect(card.buttons("Activity")).toEqual([]);
		expectInert(card, FORM_TAGS);
	});

	it("browses folders and searches by name with the words safely quoted", async () => {
		const card = await mountCard(driveScript, { tool: "search_files" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "kemisetti", pageSize: 5, query: "sharedWithMe = true" } });
		card.notify("ui/notifications/tool-result", textResult({ files: [file("fold1", "Taxes", FOLDER)], nextPageToken: "p2" }));

		card.buttons("Load more")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "kemisetti", pageSize: 5, pageToken: "p2", query: "sharedWithMe = true" }, name: "search_files" }]);
		await card.reply("tools/call", textResult({ files: [file("f9", "More", "application/pdf")] }));
		expect(card.root.textContent).toContain("More");

		card.buttons("Taxes")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "kemisetti", pageSize: 5, query: "trashed = false and 'fold1' in parents" }, name: "search_files" }]);
		await card.reply("tools/call", textResult({ files: [file("f2", "2025.pdf", "application/pdf")] }));
		expect(card.root.texts()).toEqual(expect.arrayContaining(["Drive", "Taxes", "2025.pdf"]));

		card.control("Search in this folder").enter(String.raw`it's \ "2025"`);
		card.buttons("Search")[0].click();
		expect(card.pendingCalls()[0].arguments.query).toBe(String.raw`trashed = false and 'fold1' in parents and title contains 'it\'s \\ "2025"'`);
		await card.reply("tools/call", textResult({ files: [] }));
		expect(card.root.textContent).toContain("No files found.");

		card.control("Folders only").click();
		expect(card.pendingCalls()[0].arguments.query).toBe(String.raw`trashed = false and 'fold1' in parents and title contains 'it\'s \\ "2025"' and mimeType = 'application/vnd.google-apps.folder'`);
		await card.reply("tools/call", textResult("Rate limit reached", true));
		expect(card.root.textContent).toContain("Rate limit reached");

		// Back to the top through the breadcrumb.
		card.buttons("Drive")[0].click();
		expect(card.pendingCalls()[0].arguments.query).toBe("trashed = false and mimeType = 'application/vnd.google-apps.folder'");
	});

	it("opens a file's sharing, activity and Drive link from its detail view", async () => {
		const card = await mountCard(driveScript, { tool: "list_recent_files" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", orderBy: "recency" } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({ files: [file("f1", "Budget", "application/vnd.google-apps.spreadsheet", { owners: ["me@example.com"], shared: true, webViewLink: "https://docs.google.com/spreadsheets/d/f1/edit" })], nextPageToken: "r2" }),
		);
		expect(card.nodes().filter((n) => n.className === "file-tile")).toHaveLength(1);
		expect(card.nodes().find((n) => n.className.includes("tile-block"))!.className).toBe("type type-xls tile-block");
		card.buttons("Load more")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", orderBy: "recency", pageToken: "r2" }, name: "list_recent_files" }]);
		await card.reply("tools/call", textResult({ files: [] }));

		card.buttons("Budget")[0].click();
		expect(card.root.texts()).toEqual(expect.arrayContaining(["Budget", "Shared", "me@example.com"]));
		card.buttons("Open in Drive")[0].click();
		expect(card.sent.find((m) => m.method === "ui/open-link").params).toEqual({ url: "https://docs.google.com/spreadsheets/d/f1/edit" });
		card.buttons("Who has access")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", fileId: "f1" }, name: "get_file_permissions" }]);
		await card.reply("tools/call", textResult({ fileId: "f1", permissions: [] }));
		card.buttons("Back")[0].click();
		card.buttons("Activity")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", itemName: "f1" }, name: "query_drive_activity" }]);
		expectInert(card);
	});

	it("groups people by role and warns about link and domain sharing", async () => {
		const card = await mountCard(driveScript, { tool: "get_file_permissions" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", fileId: "f1" } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({
				fileId: "f1",
				permissions: [
					{ displayName: D("Me"), emailAddress: D("me@example.com"), role: "owner", type: "user" },
					{ displayName: D(HOSTILE.from), emailAddress: D(HOSTILE.subject), role: "writer", type: "user" },
					{ emailAddress: D("c@example.com"), role: "commenter", type: "user" },
					{ emailAddress: D("v@example.com"), role: "reader", type: "user" },
					{ emailAddress: D("team@example.com"), role: "writer", type: "group" },
					{ role: "reader", type: "anyone" },
					{ domain: HOSTILE.subject, role: HOSTILE.body, type: "domain" },
				],
			}),
		);
		const texts = card.root.texts();
		const order = texts.filter((t) => ["Owner", "Editors", "Commenters", "Viewers", "Groups"].includes(t));
		expect(order).toEqual(["Owner", "Editors", "Commenters", "Viewers", "Groups"]);
		expect(texts).toContain("Anyone with the link can view this file. This was set outside GoBridge.");
		expect(texts).toContain(`Everyone at ${HOSTILE.subject} can open this file. This was set outside GoBridge.`);
		expect(texts).toContain(`${HOSTILE.from} · ${HOSTILE.subject}`);
		expect(texts).toContain("Can edit");
		// Read-only build: nothing that shares.
		expect(card.buttons("Share")).toEqual([]);
		expect(card.calls()).toEqual([]);
		expectInert(card);
	});

	it("shows activity as a timeline without naming other people", async () => {
		const A = (value: string) => untrusted("activity", value);
		const card = await mountCard(driveScript, { tool: "query_drive_activity" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", itemName: "f1" } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({
				activities: [
					{ actions: ["rename"], actors: ["you"], primaryAction: { detail: { newTitle: A(HOSTILE.subject), oldTitle: A("Draft") }, type: "rename" }, targets: [{ id: "f1", title: A(HOSTILE.file), type: "driveItem" }], time: "2026-10-05T13:00:00Z" },
					{ actors: ["person:1234567", "person:1234567"], primaryAction: { detail: { addedPermissions: [{ role: "reader", type: "anyone" }], removedPermissions: [{ role: "writer", type: "user" }] }, type: "permissionChange" }, targets: [{ id: "f1", title: A("Plan"), type: "driveItem" }], time: { end: "2026-10-04T13:00:00Z" } },
					{ actors: [HOSTILE.subject], primaryAction: { type: HOSTILE.subject }, targets: [{ parent: { title: A("Notes") }, type: "fileComment" }] },
				],
				nextPageToken: "a2",
			}),
		);
		const texts = card.root.texts();
		expect(texts).toContain(`Renamed ${HOSTILE.file}`);
		expect(texts).toContain(`Draft → ${HOSTILE.subject}`);
		expect(texts).toContain("Changed sharing of Plan");
		expect(texts).toContain("Added: view (anyone) · Removed: 1 permission");
		expect(texts).toContain("Changed Notes");
		expect(card.root.textContent).toContain("Someone else · ");
		expect(card.root.textContent).not.toContain("1234567");
		card.buttons("Load more")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", itemName: "f1", pageToken: "a2" }, name: "query_drive_activity" }]);
		expectInert(card);
	});
});

describe("workspace card", () => {
	const X = (value: string) => untrusted("docs", value);
	const para = (text: string, style?: string, extra: Record<string, unknown> = {}) => ({
		paragraph: { elements: [{ textRun: { content: X(`${text}\n`), ...extra } }], ...(style ? { paragraphStyle: { namedStyleType: style } } : {}) },
	});

	it("shows a doc as an outline, sections, suggestions and comments, all as text", async () => {
		const card = await mountCard(workspaceScript, { tool: "read_doc" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "michigan", documentId: "doc1" } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({
				body: {
					content: [
						{ sectionBreak: {} },
						para("Plan", "TITLE"),
						para("Intro text"),
						para(HOSTILE.subject, "HEADING_2"),
						{ paragraph: { bullet: { listId: "l1" }, elements: [{ textRun: { content: X("kept ") } }, { textRun: { content: X("added"), suggestedInsertionIds: ["s1"] } }, { textRun: { content: X("gone\n"), suggestedDeletionIds: ["s2"] } }] } },
						{ table: { tableRows: [{ tableCells: [{ content: [para(HOSTILE.body)] }, { content: [para("B")] }] }] } },
						para("Budget", "HEADING_2"),
						para("Numbers"),
						{ paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: "i1" } }] } },
					],
				},
				comments: [{ author: X(HOSTILE.from), content: X(HOSTILE.body), id: "c1", quoted: X(HOSTILE.subject), replies: [{ author: X("Lee"), content: X(HOSTILE.file) }], resolved: true }],
				documentId: "doc1",
				nextPageToken: "e40",
				title: X(HOSTILE.file),
			}),
		);
		const texts = card.root.texts();
		expect(texts).toEqual(expect.arrayContaining([HOSTILE.file, "Whole page", "Plan", HOSTILE.subject, "Budget", "Intro text", "kept ", "added", "gone", HOSTILE.body, "[image]", "1 comment", HOSTILE.from, "Resolved", `Lee: ${HOSTILE.file}`]));
		expect(card.nodes().filter((n) => n.className === "ins").map((n) => n.textContent)).toEqual(["added"]);
		expect(card.nodes().filter((n) => n.className === "del").map((n) => n.textContent)).toEqual(["gone"]);
		expect(card.nodes().find((n) => n.className.includes("bullet"))!.className).toBe("para bullet");
		expect(card.root.textContent).toContain("Suggested additions are underlined");
		expect(card.calls()).toEqual([]);

		// One section at a time, up to the next heading of the same level.
		card.buttons(HOSTILE.subject)[0].click();
		const main = card.nodes().find((n) => n.className === "doc-main")!;
		expect(main.textContent).toBe(`${HOSTILE.subject}kept addedgone${HOSTILE.body}B`);

		card.buttons("Open in Docs")[0].click();
		expect(card.sent.find((m) => m.method === "ui/open-link").params).toEqual({ url: "https://docs.google.com/document/d/doc1/edit" });
		card.buttons("Show suggestions")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "michigan", documentId: "doc1", suggestionsViewMode: "SUGGESTIONS_INLINE" }, name: "read_doc" }]);
		await card.reply("tools/call", textResult({ body: { content: [para("Clean")] }, documentId: "doc1", nextPageToken: "e40", title: X("T") }));
		expect(card.buttons("Hide suggestions")).toHaveLength(1);
		expect(card.buttons("Back")).toEqual([]);
		card.buttons("Next page")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "michigan", documentId: "doc1", pageToken: "e40", suggestionsViewMode: "SUGGESTIONS_INLINE" }, name: "read_doc" }]);
		expectInert(card, TABLE_TAGS);
	});

	it("reads every tab and offers no editor link for a hostile id", async () => {
		const card = await mountCard(workspaceScript);
		card.notify("ui/notifications/tool-result", textResult({ documentId: 'x"/../../evil', tabs: [{ documentTab: { body: { content: [para("Tab one")] } } }, { documentTab: { body: { content: [para("Tab two")] } } }], title: X("Tabs") }));
		expect(card.root.texts()).toEqual(expect.arrayContaining(["read_doc", "Tab one", "Tab two"]));
		expect(card.buttons("Open in Docs")).toEqual([]);
	});

	it("shows a range as a table with numbers, negatives, sorting and a bar chart", async () => {
		const S = (value: string) => untrusted("sheets", value);
		const card = await mountCard(workspaceScript, { tool: "get_values" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "kemisetti", range: "Sheet1!A1:C4", spreadsheetId: "sheet1" } });
		card.notify(
			"ui/notifications/tool-result",
			textResult({
				range: "Sheet1!A1:C4",
				rowsReturned: 4,
				spreadsheetId: "sheet1",
				truncated: true,
				values: [
					[S("Item"), S("Amount"), S(HOSTILE.subject)],
					[S("Rent"), S("-1,200.50"), S(HOSTILE.body)],
					[S("Pay"), S("$3,000"), S('=IMPORTDATA("https://evil.example/x")')],
					[S(HOSTILE.file), S("(45)"), S("")],
				],
			}),
		);
		const cells = () => card.nodes().filter((n) => n.tagName === "td");
		expect(cells().map((c) => c.textContent)).toEqual(["Rent", "-1,200.50", HOSTILE.body, "Pay", "$3,000", '=IMPORTDATA("https://evil.example/x")', HOSTILE.file, "(45)", ""]);
		expect(cells().map((c) => c.className)).toEqual(["", "num neg", "", "", "num", "", "", "num neg", ""]);
		const bars = card.nodes().filter((n) => n.className.startsWith("bar ") || n.className === "bar");
		expect(bars.map((b) => [b.className, b.styles.width])).toEqual([["bar bar-neg", "40.016666666666666%"], ["bar", "100%"], ["bar bar-neg", "1.5%"]]);
		expect(card.root.textContent).toContain("Only part of the range fits in one answer (10,000 cells).");

		card.buttons("Amount")[0].click();
		expect(cells().filter((_c, i) => i % 3 === 0).map((c) => c.textContent)).toEqual(["Rent", HOSTILE.file, "Pay"]);
		card.buttons("Amount")[0].click();
		expect(cells().filter((_c, i) => i % 3 === 0).map((c) => c.textContent)).toEqual(["Pay", HOSTILE.file, "Rent"]);
		card.buttons("Clear sort")[0].click();
		expect(cells()[0].textContent).toBe("Rent");
		expect(card.calls()).toEqual([]);

		card.buttons("Show formulas")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "kemisetti", range: "Sheet1!A1:C4", spreadsheetId: "sheet1", valueRenderOption: "FORMULA" }, name: "get_values" }]);
		await card.reply("tools/call", textResult({ spreadsheetId: "sheet1", values: [[S("Item"), S("Amount")], [S("Rent"), S("=SUM(B3:B9)")], [S("Pay"), S("3000")]] }));
		expect(card.root.textContent).toContain("Showing formulas as text; they are not run here.");
		expect(card.nodes().filter((n) => n.className.startsWith("bar"))).toEqual([]);
		expect(card.buttons("Show values")).toHaveLength(1);
		expect(card.buttons("Add row")).toEqual([]);
		expectInert(card, TABLE_TAGS);
	});

	const shape = (text: string) => ({ shape: { text: { textElements: [{ textRun: { content: untrusted("slides", text) } }] } } });
	const slide = (id: string, text: string, notes: string) => ({ objectId: id, pageElements: [shape(text), { elementGroup: { children: [shape("Grouped")] } }], slideProperties: { notesPage: { pageElements: [{ shape: {} }, shape(notes)] } } });
	const PNG = { data: "iVBORw0KGgo=", mimeType: "image/png", type: "image" };

	it("shows slides as a grid built from text, with speaker notes", async () => {
		const card = await mountCard(workspaceScript, { tool: "read_presentation" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", presentationId: "deck1" } });
		card.notify("ui/notifications/tool-result", textResult({ nextPageToken: "s2", presentationId: "deck1", slideCount: 5, slides: [slide("g1", HOSTILE.subject, "Say hello"), slide("g2", "Second", HOSTILE.body)], title: untrusted("slides", HOSTILE.file) }));
		expect(card.nodes().filter((n) => n.className.startsWith("slide")).filter((n) => n.tagName === "button")).toHaveLength(2);
		expect(card.root.texts()).toEqual(expect.arrayContaining([HOSTILE.file, "5 slides", "Slide 1", `${HOSTILE.subject}\nGrouped`, "Say hello"]));
		card.buttons("Slide 2")[0].click();
		expect(card.root.texts()).toContain(HOSTILE.body);
		expect(card.calls()).toEqual([]);

		card.buttons("Show slide image")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", pageId: "g2", presentationId: "deck1" }, name: "read_slide_page_thumbnail" }]);
		await card.reply("tools/call", { content: [PNG, { text: JSON.stringify({ heightPx: 900, pageId: "g2", presentationId: "deck1", widthPx: 1600 }), type: "text" }] });
		const image = card.nodes().find((n) => n.tagName === "img")!;
		expect(image.attributes.src).toBe("data:image/png;base64,iVBORw0KGgo=");
		expect(card.root.textContent).toContain("Slide 2 of 2");
		expect(card.root.texts()).toContain(HOSTILE.body);
		expect(card.labelled("Next slide")[0].disabled).toBe(true);
		card.labelled("Previous slide")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", pageId: "g1", presentationId: "deck1" }, name: "read_slide_page_thumbnail" }]);
		expectInert(card, TABLE_TAGS);
	});

	it("shows only a PNG that came as image content, and loads the slide list on request", async () => {
		const summary = { text: JSON.stringify({ heightPx: 900, pageId: "g1", presentationId: "deck9", widthPx: 1600 }), type: "text" };
		for (const bad of [{ ...PNG, mimeType: "image/svg+xml" }, { ...PNG, data: 'x" onerror="alert(1)' }, { ...PNG, data: "https://evil.example/pixel.gif" }, { data: PNG.data, mimeType: "image/png", type: "text" }]) {
			const card = await mountCard(workspaceScript, { tool: "read_slide_page_thumbnail" });
			card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", pageId: "g1", presentationId: "deck9" } });
			card.notify("ui/notifications/tool-result", { content: [bad, summary] });
			expect(card.nodes().filter((n) => n.tagName === "img"), JSON.stringify(bad)).toEqual([]);
			expect(card.root.textContent).toContain("The slide image is not available.");
		}
		const card = await mountCard(workspaceScript, { tool: "read_slide_page_thumbnail" });
		card.notify("ui/notifications/tool-input", { arguments: { account: "gmail", pageId: "g1", presentationId: "deck9", thumbnailProperties: { thumbnailSize: "LARGE" } } });
		card.notify("ui/notifications/tool-result", { content: [PNG, summary] });
		expect(card.nodes().filter((n) => n.tagName === "img")).toHaveLength(1);
		expect(card.labelled("Next slide")).toEqual([]);
		expect(card.calls()).toEqual([]);
		card.buttons("Load slide list")[0].click();
		expect(card.pendingCalls()).toEqual([
			{ arguments: { account: "gmail", fields: ["presentationId", "slides.objectId", "slides.slideProperties.notesPage.pageElements.shape.text"], presentationId: "deck9" }, name: "read_presentation" },
		]);
		await card.reply("tools/call", textResult({ presentationId: "deck9", slides: [slide("g1", "", "First notes"), slide("g2", "", "")] }));
		expect(card.root.textContent).toContain("Slide 1 of 2");
		expect(card.root.texts()).toContain("First notes");
		card.labelled("Next slide")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail", pageId: "g2", presentationId: "deck9", thumbnailProperties: { thumbnailSize: "LARGE" } }, name: "read_slide_page_thumbnail" }]);
		expectInert(card, TABLE_TAGS);
	});
});

describe("accounts card", () => {
	it("lists the accounts and links only to GoBridge's own /link page", async () => {
		const card = await mountCard(accountsScript, { linkUrl: "https://gobridge.test/link", tool: "list_accounts" });
		card.notify("ui/notifications/tool-input", { arguments: {} });
		card.notify("ui/notifications/tool-result", textResult({ accounts: [{ alias: "michigan", email: "a@example.com" }, { alias: HOSTILE.from, email: HOSTILE.subject }] }));
		expect(card.root.texts()).toContain("a@example.com");
		expect(card.root.texts()).toContain(HOSTILE.subject);
		expect(card.nodes().filter((n) => n.className.startsWith("chip ")).map((n) => n.className)).toEqual(["chip chip-indigo", "chip chip-other"]);
		expect(card.calls()).toEqual([]);
		card.buttons("Manage accounts")[0].click();
		expect(card.sent.find((m) => m.method === "ui/open-link").params).toEqual({ url: "https://gobridge.test/link" });
		expectInert(card);
	});

	it("offers no link without a usable address", async () => {
		for (const linkUrl of ["", "http://gobridge.test/link", "javascript:alert(1)"]) {
			const card = await mountCard(accountsScript, { linkUrl, tool: "list_accounts" });
			card.notify("ui/notifications/tool-result", textResult({ accounts: [] }));
			expect(card.root.textContent).toContain("No Google account is linked yet.");
			expect(card.buttons("Manage accounts"), linkUrl).toEqual([]);
		}
	});
});

describe("fallback and guardrails", () => {
	let counter = 0;
	async function linked() {
		counter += 1;
		const alias = `ui-${counter}`;
		await saveAccount(env, {
			alias,
			email: `ui${counter}@example.com`,
			refreshToken: "1//fake-google-refresh-token",
			scopes: [...LINK_SCOPES],
			sub: `ui-sub-${counter}`,
		});
		return alias;
	}
	function mockGmail() {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input as RequestInfo, init);
			if (request.url === "https://oauth2.googleapis.com/token") {
				return Response.json({ access_token: "ya29.fake-api-access-token", expires_in: 3600 });
			}
			return Response.json({
				id: "t1",
				messages: [
					{
						id: "m1",
						labelIds: ["INBOX"],
						payload: {
							body: { data: btoa("Body text for the card") },
							headers: [
								{ name: "From", value: "Alice <alice@example.com>" },
								{ name: "Subject", value: HOSTILE.subject },
							],
							mimeType: "text/plain",
						},
						snippet: "Snippet",
						threadId: "t1",
					},
				],
			});
		});
	}

	it("returns the same text result whatever UI_CARDS is, with no extra result fields", async () => {
		mockGmail();
		const alias = await linked();
		const args = { account: alias, threadId: "t1" };
		const off = await runTool(withCards("off"), CLIENT, "get_thread", args);
		const all = await runTool(withCards("all"), CLIENT, "get_thread", args);
		expect(all).toEqual(off);
		expect(Object.keys(off)).toEqual(["content"]);
		expect(off.content).toHaveLength(1);
		const text = (off.content[0] as { text: string }).text;
		expect(text).toContain('<untrusted_content source=\\"email\\">');
		expect(JSON.parse(text).messages[0].subject).toBe(untrusted("email", HOSTILE.subject));
	});

	it("gives every card-backed tool byte-identical output with cards off, read-only and on", async () => {
		// One generic Google answer is enough: each tool shapes whatever part of it it reads.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input as RequestInfo, init);
			if (request.url === "https://oauth2.googleapis.com/token") {
				return Response.json({ access_token: "ya29.fake-api-access-token", expires_in: 3600 });
			}
			return Response.json(GENERIC_GOOGLE);
		});
		const alias = await linked();
		const tools = { ...READ_CARDS, ...WRITE_CARDS };
		expect(Object.keys(CARD_TOOL_ARGS).sort()).toEqual(Object.keys(tools).sort());
		for (const name of Object.keys(tools)) {
			const args = { ...CARD_TOOL_ARGS[name], ...(name === "list_accounts" ? {} : { account: alias }) };
			const results = [];
			for (const mode of ["off", "read", "all"]) results.push(await runTool(withCards(mode), CLIENT, name, args));
			const [off, read, all] = results.map((r) => JSON.stringify(r));
			expect(results[0].isError, `${name}: ${off.slice(0, 200)}`).toBeUndefined();
			expect(read, name).toBe(off);
			expect(all, name).toBe(off);
			expect(Object.keys(results[0]), name).toEqual(["content"]);
			expect(off, name).not.toContain("structuredContent");
			expect(off, name).not.toContain("ui://");
		}
	});

	it("applies the same guardrails to a call a card would make", async () => {
		mockGmail();
		const alias = await linked();
		const args = { account: alias, messageFormat: "PLAIN_TEXT", threadId: "t1" };

		// No client identity: refused.
		const anonymous = await runTool(env, undefined, "get_thread", args);
		expect(anonymous.isError).toBe(true);

		// Counted against the read limit, and refused once it is used up.
		const tight = { ...env, READ_RATE_LIMIT_PER_HOUR: "1" } as Env;
		expect((await runTool(tight, CLIENT, "get_thread", args)).isError).toBeUndefined();
		const second = await runTool(tight, CLIENT, "get_thread", args);
		expect(second.isError).toBe(true);
		expect((second.content[0] as { text: string }).text).toMatch(/limit/i);

		// The read audit row holds no content.
		const rows = (await listAudit(env, 1000, "read")).filter((e) => e.alias === alias);
		expect(rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(rows)).not.toContain("Body text");
		expect(JSON.stringify(rows)).not.toContain("alert(1)");
	});
});
