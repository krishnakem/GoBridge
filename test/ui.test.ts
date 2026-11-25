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
import { MAIL_JS } from "../src/ui/mail-card";
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
const CARD_SOURCES = [BRIDGE_JS, HELPERS_JS, APP_JS, MAIL_JS, CALENDAR_JS, ACCOUNTS_JS];
const W = (value: string) => untrusted("email", value);
const C = (value: string) => untrusted("calendar", value);

/** Which card each tool points at. Read tools when cards are on; write tools only when UI_CARDS is "all". */
const READ_CARDS: Record<string, string> = {
	get_thread: "mail",
	list_accounts: "accounts",
	list_events: "calendar",
	search_threads: "mail",
};
const WRITE_CARDS: Record<string, string> = {};
const metaFor = (card: string) => ({ ui: { resourceUri: `ui://gobridge/${card}.html` }, "ui/resourceUri": `ui://gobridge/${card}.html` });
const expectedMeta = (cards: Record<string, string>) => Object.fromEntries(Object.entries(cards).map(([tool, card]) => [tool, metaFor(card)]));

/** URLs that may appear in a card's source: an XML namespace name and GoBridge's own fixed link targets. */
/** img-src in each card's own policy: 'none' unless listed. */
const IMG_SRC: Record<string, string> = {};

const ALLOWED_URLS = new Set(["http://www.w3.org/2000/svg", "https://calendar.google.com/calendar/event?eid=", "https://gobridge.test/link"]);

/** Minimal valid arguments for every card-backed tool (the account alias is added by the test). */
const CARD_TOOL_ARGS: Record<string, Record<string, unknown>> = {
	get_thread: { threadId: "t1" },
	list_accounts: {},
	list_events: { startTime: "2026-10-05T00:00:00", endTime: "2026-10-06T00:00:00" },
	search_threads: { query: "is:unread", view: "MINIMAL" },
};

/** A stand-in Google response with hostile text in every field a card tool reads. */
const GENERIC_GOOGLE = {
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
				expect(html).not.toMatch(/\/\/[a-z0-9-]+\.(com|net|org|io|dev|app)\b(?!\/calendar\/event)/i);
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
			expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\s*\(\s*["']|setInterval|srcdoc|createContextualFragment|DOMParser|\.href\s*=|location\b|window\.open/);
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
