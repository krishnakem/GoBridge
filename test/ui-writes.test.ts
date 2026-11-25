/**
 * In-chat cards, phase 3: everything a card can change.
 *
 * Two halves. The card half runs each card script against the fake DOM and
 * proves the confirm rules (nothing on load, a confirm that names account,
 * action and target, two clicks for sends, forwards, shares, deletes and
 * trashes). The server half proves a call made by a card is an ordinary tool
 * call: same client-id rule, rate limits, caps, kill switches and audit rows.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAccount } from "../src/accounts";
import { LINK_SCOPES, TOOL_SCOPES } from "../src/google";
import { listAudit } from "../src/guardrails";
import { ALL_TOOLS, registerTools, runTool, toolsFor } from "../src/tools";
import { untrusted } from "../src/tools/common";
import { ACCOUNTS_JS } from "../src/ui/accounts-card";
import { APP_JS, BRIDGE_JS, HELPERS_JS } from "../src/ui/bridge";
import { CALENDAR_JS } from "../src/ui/calendar-card";
import { DRIVE_JS } from "../src/ui/drive-card";
import { MAIL_JS } from "../src/ui/mail-card";
import { WORKSPACE_JS } from "../src/ui/workspace-card";
import { expectInert, type FakeNode, HOSTILE, type MountedCard, mountCard, textResult } from "./helpers/fake-dom";

const CLIENT = { clientId: "client-ui-2", clientName: "Claude" };
const withCards = (value: unknown) => ({ ...env, UI_CARDS: value }) as Env;
const SHARED = BRIDGE_JS + HELPERS_JS + APP_JS;
const SCRIPTS = { accounts: SHARED + ACCOUNTS_JS, calendar: SHARED + CALENDAR_JS, drive: SHARED + DRIVE_JS, mail: SHARED + MAIL_JS, workspace: SHARED + WORKSPACE_JS };
const W = (value: string) => untrusted("email", value);
const C = (value: string) => untrusted("calendar", value);
const FORM_TAGS = ["div", "span", "p", "pre", "button", "svg", "path", "label", "input", "textarea", "select", "option"];
const TABLE_TAGS = [...FORM_TAGS, "table", "thead", "tbody", "tr", "th", "td", "img"];

afterEach(() => {
	vi.restoreAllMocks();
});

const STATUS = {
	limits: { readsPerHour: 300, sendsPerDay: 25, sharesPerDay: 10, writesPerHour: 60 },
	relinkNeeded: false,
	services: { calendar: true, drive: true, driveActivity: false, gmail: true },
	switches: { directSend: true, driveShare: true, driveWrite: true, forward: true, writes: true },
	usage: { readsThisHour: 9, sendsToday: 3, sharesToday: 2, writesThisHour: 4 },
};

/** Mounts a card with writes on, feeds it one tool call and its result. */
async function opened(script: string, tool: string, args: Record<string, unknown>, result: unknown, writes = true) {
	const card = await mountCard(script, { tool, writes });
	card.notify("ui/notifications/tool-input", { arguments: args });
	card.notify("ui/notifications/tool-result", textResult(result));
	return card;
}
const names = (card: MountedCard) => card.calls().map((c) => c.name);
const writeCalls = (card: MountedCard) => card.calls().filter((c) => ALL_TOOLS.find((t) => t.name === c.name)?.kind === "write");
/** The open confirm panel's text, or "" when none is open. */
const confirmText = (card: MountedCard) => card.nodes().find((n) => n.className === "confirm")?.textContent ?? "";
/** Answers the status call a confirm panel makes for its usage line. */
const answerStatus = (card: MountedCard) => card.reply("tools/call", textResult(STATUS));
/** Every button the card has built, hidden or not. */
const allButtons = (card: MountedCard) => card.root.all().filter((n: FakeNode) => n.tagName === "button").map((n) => n.textContent);

const THREAD = {
	messageCount: 1,
	messages: [{ attachments: [{ filename: W("a.pdf"), size: 10 }], body: W("Please review"), from: W("Dana <dana@example.com>"), id: "m1", labelIds: ["INBOX", "UNREAD"], subject: W("Q4 plan"), to: W("me@example.com") }],
	threadId: "t1",
	viewUrl: "https://mail.google.com/mail/?authuser=me%40example.com#all/t1",
};
const SEARCH = {
	threads: [
		{ from: W("Dana"), labelIds: ["UNREAD"], subject: W("One"), threadId: "t1" },
		{ from: W("Lee"), subject: W("Two"), threadId: "t2" },
		{ from: W("Sam"), subject: W(HOSTILE.subject), threadId: "t3" },
	],
};
const DRAFT = { body: W("Hello Dana"), cc: W(""), draftId: "d1", from: W("me@example.com"), subject: W("Hi"), to: W("Dana <dana@example.com>"), viewUrl: "https://mail.google.com/mail/?authuser=me%40example.com#all/m9" };
const EVENT = {
	attendees: [{ email: C("dana@example.com"), responseStatus: "accepted" }, { email: C("me@example.com"), responseStatus: "needsAction", self: true }],
	end: "2026-10-05T10:00:00-04:00",
	eventId: "e1",
	location: C("Room 2"),
	start: "2026-10-05T09:00:00-04:00",
	summary: C("Standup"),
	timeZone: "America/Detroit",
};

describe("cards with UI_CARDS read: nothing that changes anything", () => {
	it("shows no write control on any view", async () => {
		const views: [string, string, Record<string, unknown>, unknown][] = [
			[SCRIPTS.mail, "search_threads", { account: "gmail" }, SEARCH],
			[SCRIPTS.mail, "get_thread", { account: "gmail", threadId: "t1" }, THREAD],
			[SCRIPTS.mail, "get_draft", { account: "gmail", draftId: "d1" }, DRAFT],
			[SCRIPTS.mail, "list_labels", { account: "gmail" }, { labels: [{ id: "Label_1", name: W("Work"), type: "user" }] }],
			[SCRIPTS.calendar, "get_event", { account: "gmail", eventId: "e1" }, EVENT],
			[SCRIPTS.calendar, "list_events", { account: "gmail", startTime: "2026-10-05T00:00:00" }, { events: [EVENT] }],
			[SCRIPTS.calendar, "suggest_time", { account: "gmail" }, { suggestions: [{ end: "2026-10-05T09:30:00-04:00", start: "2026-10-05T09:00:00-04:00" }] }],
			[SCRIPTS.drive, "get_file_permissions", { account: "gmail", fileId: "f1" }, { fileId: "f1", permissions: [] }],
			[SCRIPTS.workspace, "get_values", { account: "gmail", range: "A1:B2", spreadsheetId: "s1" }, { spreadsheetId: "s1", values: [["A", "B"], ["1", "2"]] }],
		];
		const writeWords = /Draft reply|Forward|Label|Archive|Trash|Send|Save|Delete|Create|Rename|Reply |Edit|Add guests|Add row|Share|Book|New event|Undo|^Yes$|^Maybe$|^No$/;
		for (const [script, tool, args, result] of views) {
			const card = await opened(script, tool, args, result, false);
			for (const slot of card.nodes().filter((n) => n.tagName === "button" && n.className.includes("slot"))) slot.click();
			for (const label of allButtons(card)) expect(label, `${tool}: ${label}`).not.toMatch(writeWords);
			// No tick boxes, no editable fields: nothing to fill in, hidden or not.
			expect(card.root.all().filter((n) => ["input", "textarea", "select"].includes(n.tagName)), tool).toEqual([]);
			expect(card.calls(), tool).toEqual([]);
		}
	});
});

describe("mail card writes", () => {
	it("never calls anything on load, even with writes on", async () => {
		for (const [tool, args, result] of [
			["search_threads", { account: "gmail" }, SEARCH],
			["get_thread", { account: "gmail", threadId: "t1" }, THREAD],
			["get_draft", { account: "gmail", draftId: "d1" }, DRAFT],
			["create_draft", { account: "gmail" }, { ...DRAFT, to: ["dana@example.com"] }],
			["list_labels", { account: "gmail" }, { labels: [] }],
			["send_message", { account: "gmail" }, { recipients: ["dana@example.com"], sent: true, subject: "Hi" }],
		] as const) {
			const card = await opened(SCRIPTS.mail, tool, args, result);
			await card.flush();
			expect(card.calls(), tool).toEqual([]);
		}
	});

	it("trashes selected conversations only after a two-click confirm that names account, action and target", async () => {
		const card = await opened(SCRIPTS.mail, "search_threads", { account: "gmail", query: "is:unread" }, SEARCH);
		const boxes = () => card.labelled("Select this conversation");
		expect(boxes()).toHaveLength(3);
		expect(card.buttons("Trash")).toEqual([]);

		boxes()[0].click();
		// The first tick asks for the usage numbers, once.
		expect(card.calls()).toEqual([{ arguments: { account: "gmail" }, name: "get_card_status" }]);
		await answerStatus(card);
		boxes()[2].click();
		expect(card.root.texts()).toContain("2 selected · uses 2 of 60 writes this hour (4 of 60 writes this hour so far)");
		expect(names(card)).toEqual(["get_card_status"]);

		card.buttons("Trash")[0].click();
		expect(confirmText(card)).toContain("Confirm (two clicks)");
		expect(confirmText(card)).toContain("Accountgmail");
		expect(confirmText(card)).toContain("ActionMove to Trash");
		expect(confirmText(card)).toContain("Target2 conversations");
		expect(confirmText(card)).toContain("Uses 2 writes of the 60 allowed per account each hour.");
		expect(writeCalls(card)).toEqual([]);

		// Cancel leaves everything as it was.
		card.buttons("Cancel")[0].click();
		expect(confirmText(card)).toBe("");
		expect(writeCalls(card)).toEqual([]);

		card.buttons("Trash")[0].click();
		card.buttons("Move 2 to Trash")[0].click();
		expect(writeCalls(card)).toEqual([]);
		expect(confirmText(card)).toContain("Nothing has happened yet. Click again to go ahead.");
		card.buttons("Click again: Move 2 to Trash")[0].click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "gmail", threadId: "t1" }, name: "trash_thread" }]);
		await card.reply("tools/call", textResult({ id: "t1", trashed: true }));
		expect(writeCalls(card)).toHaveLength(2);
		expect(writeCalls(card)[1]).toEqual({ arguments: { account: "gmail", threadId: "t3" }, name: "trash_thread" });
		await card.reply("tools/call", textResult("Rate limit reached: at most 60 write actions per account per hour.", true));

		expect(card.root.textContent).toContain("Moved to Trash: 1 conversation. 1 could not be changed.");
		expect(card.buttons("One")).toEqual([]);
		expect(card.buttons(HOSTILE.subject)).toHaveLength(1);
		expect(boxes().some((b) => b.checked)).toBe(false);
		expectInert(card, FORM_TAGS);
	});

	it("archives with one confirm click and labels after choosing a label", async () => {
		const card = await opened(SCRIPTS.mail, "search_threads", { account: "gmail" }, SEARCH);
		card.labelled("Select this conversation")[1].click();
		await answerStatus(card);
		card.buttons("Archive")[0].click();
		expect(confirmText(card)).toContain("ActionArchive (remove from the inbox)");
		expect(confirmText(card)).not.toContain("two clicks");
		card.buttons("Archive 1")[0].click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "gmail", labelIds: ["INBOX"], threadId: "t2" }, name: "unlabel_thread" }]);
		await card.reply("tools/call", textResult({ id: "t2", labelIds: [] }));
		expect(card.root.textContent).toContain("Archived 1 conversation.");

		card.labelled("Select this conversation")[0].click();
		await answerStatus(card);
		card.buttons("Label")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "gmail" }, name: "list_labels" }]);
		await card.reply("tools/call", textResult({ labels: [{ id: "INBOX", name: W("INBOX"), type: "system" }, { id: "Label_1", name: W(HOSTILE.subject), type: "user" }, { id: "Label_2", name: W("Work"), type: "user" }] }));
		const options = card.nodes().filter((n) => n.tagName === "option");
		expect(options.map((o) => [o.value, o.textContent])).toEqual([["0", HOSTILE.subject], ["1", "Work"]]);
		card.control("Label").enter("1");
		card.buttons("Add label")[0].click();
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "gmail", labelIds: ["Label_2"], threadId: "t1" }, name: "label_thread" });
		await card.reply("tools/call", textResult({ id: "t1", labelIds: ["Label_2"] }));
		expect(card.root.textContent).toContain("Labelled 1 conversation.");
		expectInert(card, FORM_TAGS);
	});

	it("moves a thread to Trash with two clicks and can undo it", async () => {
		const card = await opened(SCRIPTS.mail, "get_thread", { account: "michigan", threadId: "t1" }, THREAD);
		expect(allButtons(card)).toEqual(expect.arrayContaining(["Draft reply", "Forward", "Label", "Archive", "Trash", "Open in Gmail"]));
		card.buttons("Trash")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("Accountmichigan");
		expect(confirmText(card)).toContain("TargetQ4 plan");
		expect(confirmText(card)).toContain("4 of 60 writes this hour");
		card.buttons("Move to Trash")[0].click();
		expect(writeCalls(card)).toEqual([]);
		card.buttons("Click again: Move to Trash")[0].click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "michigan", threadId: "t1" }, name: "trash_thread" }]);
		await card.reply("tools/call", textResult({ id: "t1", trashed: true }));
		expect(card.root.textContent).toContain("Moved to Trash.");

		card.buttons("Undo")[0].click();
		await answerStatus(card);
		card.buttons("Undo").at(-1)!.click();
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "michigan", threadId: "t1" }, name: "untrash_thread" });
		await card.reply("tools/call", textResult({ id: "t1", untrashed: true }));
		expect(card.root.textContent).toContain("Undone. It is back where it was.");
		expect(card.buttons("Undo")).toEqual([]);
	});

	it("shows a refusal from GoBridge in the confirm panel and changes nothing else", async () => {
		const card = await opened(SCRIPTS.mail, "get_thread", { account: "gmail", threadId: "t1" }, THREAD);
		card.buttons("Archive")[0].click();
		await card.reply("tools/call", textResult("GoBridge could not check its usage limits, so nothing was done.", true));
		expect(confirmText(card)).toContain("The current count is not available.");
		card.buttons("Archive").at(-1)!.click();
		await card.reply("tools/call", textResult("Writes disabled: the owner has turned off all write actions. Nothing was changed.", true));
		expect(confirmText(card)).toContain("Writes disabled: the owner has turned off all write actions.");
		expect(card.root.textContent).not.toContain("Archived.");
		expect(writeCalls(card)).toHaveLength(1);
	});

	it("saves a reply as a draft, then sends it only after save and a two-click confirm", async () => {
		const card = await opened(SCRIPTS.mail, "get_thread", { account: "gmail", threadId: "t1" }, THREAD);
		card.buttons("Draft reply")[0].click();
		card.buttons("Save as draft")[0].click();
		expect(card.root.textContent).toContain("Write a reply first.");
		card.control("Your reply").enter("Looks good");
		card.buttons("Save as draft")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("ActionSave a reply as a draft (nothing is sent)");
		card.buttons("Save draft")[0].click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "gmail", body: "Looks good", replyToMessageId: "m1" }, name: "create_draft" }]);
		await card.reply("tools/call", textResult({ body: "Looks good", cc: [], draftId: "d7", isReply: true, subject: "Re: Q4 plan", to: ["dana@example.com"] }));

		// The draft view: editable, and Send refuses while there are unsaved edits.
		expect(card.root.texts()).toContain("Draft. Not sent.");
		expect(card.control("To").value).toBe("dana@example.com");
		card.control("Subject").enter("Re: Q4 plan (updated)");
		card.buttons("Send")[0].click();
		expect(card.root.textContent).toContain("Save your changes first.");
		expect(names(card)).not.toContain("send_message");

		card.buttons("Save draft")[0].click();
		await answerStatus(card);
		card.buttons("Save draft").at(-1)!.click();
		// Only the changed field is sent, so the rest of the draft is kept as it is.
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "gmail", draftId: "d7", subject: "Re: Q4 plan (updated)" }, name: "update_draft" });
		await card.reply("tools/call", textResult({ body: "Looks good", cc: [], draftId: "d7", subject: "Re: Q4 plan (updated)", to: ["dana@example.com"] }));

		card.buttons("Send")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("Confirm (two clicks)");
		expect(confirmText(card)).toContain("Accountgmail");
		expect(confirmText(card)).toContain("ActionSend this draft by email now");
		expect(confirmText(card)).toContain("Targetdana@example.com");
		expect(confirmText(card)).toContain("3 of 25 sends today");
		expect(confirmText(card)).toContain("Counts as a send.");
		card.buttons("Send").at(-1)!.click();
		expect(names(card)).not.toContain("send_message");
		card.buttons("Click again: Send")[0].click();
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "gmail", draftId: "d7" }, name: "send_message" });
		await card.reply("tools/call", textResult({ messageId: "m9", recipients: ["dana@example.com"], sent: true, subject: "Re: Q4 plan (updated)", viewUrl: "https://mail.google.com/mail/?authuser=x#all/m9" }));
		expect(card.root.texts()).toContain("Sent.");
		expect(card.root.texts()).toContain("send_message");

		// The limits are fetched on request and shown as plain numbers.
		card.buttons("Show limits")[0].click();
		await answerStatus(card);
		expect(card.root.texts()).toEqual(expect.arrayContaining(["3 / 25", "Sends today", "4 / 60", "Writes this hour", "On", "Direct send"]));
		expectInert(card, FORM_TAGS);
	});

	it("deletes a draft only after two clicks", async () => {
		const card = await opened(SCRIPTS.mail, "get_draft", { account: "gmail", draftId: "d1" }, DRAFT);
		card.buttons("Delete draft")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("ActionDelete this draft for good");
		expect(confirmText(card)).toContain("TargetHi");
		card.buttons("Delete draft").at(-1)!.click();
		expect(writeCalls(card)).toEqual([]);
		card.buttons("Click again: Delete draft")[0].click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "gmail", draftId: "d1" }, name: "delete_draft" }]);
		await card.reply("tools/call", textResult({ deleted: true, draftId: "d1" }));
		expect(card.root.textContent).toContain("Draft deleted.");
		expect(card.buttons("Back")).toEqual([]);
	});

	it("forwards with recipient chips, a two-click confirm and the send count", async () => {
		const card = await opened(SCRIPTS.mail, "get_thread", { account: "kemisetti", threadId: "t1" }, THREAD);
		card.buttons("Forward")[0].click();
		expect(card.root.textContent).toContain("Counts as a send. Attachments on the original are always included.");
		card.buttons("Forward").at(-1)!.click();
		expect(card.root.textContent).toContain("Add at least one recipient.");

		card.control("Forward to").enter("lee@example.com, sam@example.com");
		card.buttons("Add recipient")[0].click();
		card.labelled("Remove this recipient")[1].click();
		card.control("Note").enter("FYI");
		card.buttons("Forward").at(-1)!.click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("Accountkemisetti");
		expect(confirmText(card)).toContain("ActionForward this message by email");
		expect(confirmText(card)).toContain("Targetlee@example.com");
		expect(confirmText(card)).not.toContain("sam@example.com");
		expect(confirmText(card)).toContain("3 of 25 sends today");
		expect(confirmText(card)).toContain("Counts as a send. 1 attachment will be included.");
		card.buttons("Forward").at(-1)!.click();
		expect(writeCalls(card)).toEqual([]);
		card.buttons("Click again: Forward")[0].click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "kemisetti", forwardText: "FYI", messageId: "m1", to: ["lee@example.com"] }, name: "forward" }]);
		await card.reply("tools/call", textResult({ recipients: ["lee@example.com"], sent: true, subject: "Fwd: Q4 plan" }));
		expect(card.root.texts()).toEqual(expect.arrayContaining(["Sent.", "forward", "lee@example.com", "Fwd: Q4 plan"]));
		expectInert(card, FORM_TAGS);
	});

	it("creates, renames and deletes labels, each after its own confirm", async () => {
		const labels = { labels: [{ id: "INBOX", name: W("INBOX"), type: "system" }, { color: { backgroundColor: "#16a766" }, id: "Label_1", name: W(HOSTILE.subject), type: "user" }, { color: { backgroundColor: "red;background:url(https://evil.example/x)" }, id: "Label_2", name: W("Work"), type: "user" }] };
		const card = await opened(SCRIPTS.mail, "list_labels", { account: "gmail" }, labels);
		const swatches = card.nodes().filter((n) => n.className === "swatch");
		expect(swatches.map((s) => s.styles)).toEqual([{}, { background: "#16a766" }, {}]);
		expect(card.labelled("Rename this label")).toHaveLength(2);

		card.control("New label name").enter("Receipts");
		card.buttons("Create label")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("TargetReceipts");
		card.buttons("Create label").at(-1)!.click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "gmail", displayName: "Receipts" }, name: "create_label" }]);
		await card.reply("tools/call", textResult({ id: "Label_3" }));
		await card.reply("tools/call", textResult(labels));
		expect(card.root.textContent).toContain("Label created.");

		card.labelled("Rename this label")[1].click();
		card.labelled("New name for this label")[0].enter("Office");
		card.buttons("Save")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("TargetWork → Office");
		card.buttons("Rename")[0].click();
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "gmail", displayName: "Office", labelId: "Label_2" }, name: "update_label" });
		await card.reply("tools/call", textResult({ id: "Label_2" }));
		await card.reply("tools/call", textResult(labels));

		card.labelled("Delete this label")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("Confirm (two clicks)");
		card.buttons("Delete label")[0].click();
		expect(writeCalls(card)).toHaveLength(2);
		card.buttons("Click again: Delete label")[0].click();
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "gmail", labelId: "Label_1" }, name: "delete_label" });
		expectInert(card, FORM_TAGS);
	});
});

describe("calendar card writes", () => {
	it("books a suggested time: no emails by default, two clicks when guests are emailed", async () => {
		const suggestions = { suggestions: [{ end: "2026-10-05T09:30:00-04:00", start: "2026-10-05T09:00:00-04:00" }], timeZone: "America/Detroit" };
		const card = await opened(SCRIPTS.calendar, "suggest_time", { account: "michigan", attendeeEmails: ["dana@example.com"] }, suggestions);
		expect(card.buttons("Book this time")).toEqual([]);
		card.buttons("9 AM to 9:30 AM")[0].click();
		card.buttons("Book this time")[0].click();
		expect(card.calls()).toEqual([]);
		expect(card.control("Date").value).toBe("2026-10-05");
		expect(card.control("Starts").value).toBe("09:00");
		expect(card.control("Ends").value).toBe("09:30");
		expect(card.control("Guests").value).toBe("dana@example.com");
		expect(card.control("Email guests").value).toBe("NONE");
		expect(card.root.textContent).toContain("Everyone emails every guest.");

		card.buttons("Create event")[0].click();
		expect(card.root.textContent).toContain("Give a title, a date, and start and end times.");
		card.control("Title").enter("Sync");
		card.buttons("Create event")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("Accountmichigan");
		expect(confirmText(card)).toContain("ActionCreate an event: no emails are sent");
		expect(confirmText(card)).toContain("TargetSync · Monday, Oct 5, 9 AM to 9:30 AM · dana@example.com");
		expect(confirmText(card)).not.toContain("two clicks");
		card.buttons("Cancel")[0].click();

		card.control("Email guests").enter("ALL");
		card.buttons("Create event")[0].click();
		expect(confirmText(card)).toContain("ActionCreate an event: EVERY guest is emailed");
		expect(confirmText(card)).toContain("Everyone emails every guest on the list.");
		card.buttons("Create and email guests")[0].click();
		expect(writeCalls(card)).toEqual([]);
		card.buttons("Click again: Create and email guests")[0].click();
		expect(writeCalls(card)).toEqual([
			{
				arguments: { account: "michigan", attendees: [{ email: "dana@example.com" }], endTime: "2026-10-05T09:30:00", notificationLevel: "ALL", startTime: "2026-10-05T09:00:00", summary: "Sync", timeZone: "America/Detroit" },
				name: "create_event",
			},
		]);
		await card.reply("tools/call", textResult({ ...EVENT, attendeesEmailed: true, summary: C("Sync") }));
		expect(card.root.texts()).toContain("Event created. Guests were emailed.");
		expect(card.root.texts()).toContain("create_event");
		expectInert(card, FORM_TAGS);
	});

	it("answers an invitation with one confirm and offers Undo back to the earlier reply", async () => {
		const card = await opened(SCRIPTS.calendar, "get_event", { account: "gmail", calendarId: "team@example.com", eventId: "e1" }, EVENT);
		expect(allButtons(card)).toEqual(expect.arrayContaining(["Reply Yes", "Reply Maybe", "Reply No", "Edit", "Add guests", "Delete"]));
		card.buttons("Reply Yes")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("ActionReply Yes to this invitation");
		expect(confirmText(card)).toContain("TargetStandup · Monday, Oct 5, 9 AM to 10 AM (America/Detroit)");
		card.buttons("Reply Yes").at(-1)!.click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "gmail", calendarId: "team@example.com", eventId: "e1", notificationLevel: "NONE", responseStatus: "accepted" }, name: "respond_to_event" }]);
		const accepted = { ...EVENT, attendees: [EVENT.attendees[0], { ...EVENT.attendees[1], responseStatus: "accepted" }], response: "accepted" };
		await card.reply("tools/call", textResult(accepted));
		expect(card.root.texts()).toContain("Your reply: Yes. No email was sent.");

		card.buttons("Undo")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("ActionClear my reply to this invitation");
		card.buttons("Clear reply")[0].click();
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "gmail", calendarId: "team@example.com", eventId: "e1", notificationLevel: "NONE", responseStatus: "needsAction" }, name: "respond_to_event" });
	});

	it("lists invitations on the day view with a conflict warning, Yes / Maybe / No and Undo", async () => {
		const other = { end: "2026-10-05T10:30:00-04:00", eventId: "e2", start: "2026-10-05T09:30:00-04:00", summary: C("Class") };
		const card = await opened(SCRIPTS.calendar, "list_events", { account: "gmail", startTime: "2026-10-05T00:00:00" }, { events: [EVENT, other] });
		expect(card.root.texts()).toContain("Invitations waiting for your reply");
		expect(card.root.textContent).toContain("9 AM to 10 AM · Overlaps another event");
		expect(card.calls()).toEqual([]);
		card.buttons("Maybe")[0].click();
		await answerStatus(card);
		card.buttons("Reply Maybe")[0].click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "gmail", eventId: "e1", notificationLevel: "NONE", responseStatus: "tentative" }, name: "respond_to_event" }]);
		await card.reply("tools/call", textResult({ ...EVENT, response: "tentative" }));
		expect(card.root.texts()).toContain("You replied Maybe");
		card.buttons("Undo")[0].click();
		await answerStatus(card);
		card.buttons("Clear reply")[0].click();
		expect(writeCalls(card).at(-1)!.arguments.responseStatus).toBe("needsAction");
	});

	it("edits, adds guests and deletes with the right confirm for each", async () => {
		const card = await opened(SCRIPTS.calendar, "get_event", { account: "gmail", eventId: "e1" }, EVENT);
		card.buttons("Edit")[0].click();
		card.buttons("Save changes")[0].click();
		expect(card.root.textContent).toContain("Nothing has changed.");
		card.control("Title").enter("Standup (moved)");
		card.control("Starts").enter("11:00");
		card.control("Ends").enter("11:30");
		card.buttons("Save changes")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("ActionChange this event (no emails are sent)");
		card.buttons("Save changes").at(-1)!.click();
		expect(writeCalls(card)).toEqual([
			{ arguments: { account: "gmail", endTime: "2026-10-05T11:30:00", eventId: "e1", notificationLevel: "NONE", startTime: "2026-10-05T11:00:00", summary: "Standup (moved)", timeZone: "America/Detroit" }, name: "update_event" },
		]);
		await card.reply("tools/call", textResult({ ...EVENT, attendeesEmailed: false }));
		expect(card.root.texts()).toContain("Event changed. No emails were sent.");

		card.buttons("Add guests")[0].click();
		card.control("Guests to add").enter("lee@example.com");
		card.control("Email guests").enter("EXTERNAL_ONLY");
		card.buttons("Add guests").at(-1)!.click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("Confirm (two clicks)");
		expect(confirmText(card)).toContain("guests outside your organisation are emailed");
		card.buttons("Add and email guests")[0].click();
		expect(writeCalls(card)).toHaveLength(1);
		card.buttons("Click again: Add and email guests")[0].click();
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "gmail", addedAttendees: [{ email: "lee@example.com" }], eventId: "e1", notificationLevel: "EXTERNAL_ONLY" }, name: "update_event" });
		await card.reply("tools/call", textResult({ ...EVENT, attendeesEmailed: true }));

		card.buttons("Delete")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("ActionDelete this event");
		expect(confirmText(card)).toContain("No cancellation emails are sent to guests.");
		card.buttons("Delete event")[0].click();
		expect(writeCalls(card)).toHaveLength(2);
		card.buttons("Click again: Delete event")[0].click();
		expect(writeCalls(card).at(-1)).toEqual({ arguments: { account: "gmail", eventId: "e1", notificationLevel: "NONE" }, name: "delete_event" });
		await card.reply("tools/call", textResult({ deleted: true, eventId: "e1" }));
		expect(card.root.textContent).toContain("Event deleted. No emails were sent.");
		expectInert(card, FORM_TAGS);
	});

	it("opens a blank new-event form from the day view and can load the calendar list", async () => {
		const card = await opened(SCRIPTS.calendar, "list_events", { account: "gmail", startTime: "2026-10-05T00:00:00", timeZone: "America/Detroit" }, { events: [] });
		card.buttons("New event")[0].click();
		expect(card.control("Date").value).toBe("2026-10-05");
		card.buttons("Load my calendars")[0].click();
		expect(card.calls()).toEqual([{ arguments: { account: "gmail" }, name: "list_calendars" }]);
		await card.reply("tools/call", textResult({ calendars: [{ accessRole: "owner", calendarId: "me@example.com", primary: true, summary: C("Me") }, { accessRole: "writer", calendarId: "team@example.com", summary: C(HOSTILE.subject) }, { accessRole: "reader", calendarId: "holidays", summary: C("Holidays") }] }));
		const options = card.nodes().filter((n) => n.tagName === "option" && /^\d+$/.test(n.value));
		expect(options.map((o) => [o.value, o.textContent])).toEqual([["0", "Primary calendar"], ["1", HOSTILE.subject]]);
		card.control("Calendar").enter("1");
		card.control("Title").enter("Lunch");
		card.control("Ends").enter("08:00");
		card.buttons("Create event")[0].click();
		expect(card.root.textContent).toContain("The end time must be after the start time.");
		card.control("Ends").enter("10:00");
		card.buttons("Create event")[0].click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("ActionCreate an event: no guests");
		card.buttons("Create event").at(-1)!.click();
		expect(writeCalls(card)).toEqual([
			{ arguments: { account: "gmail", calendarId: "team@example.com", endTime: "2026-10-05T10:00:00", notificationLevel: "NONE", startTime: "2026-10-05T09:00:00", summary: "Lunch", timeZone: "America/Detroit" }, name: "create_event" },
		]);
		expectInert(card, FORM_TAGS);
	});
});

describe("drive card writes", () => {
	it("shares with one person after a two-click confirm, and never with anyone or a domain", async () => {
		const card = await opened(SCRIPTS.drive, "get_file_permissions", { account: "kemisetti", fileId: "f1" }, { fileId: "f1", permissions: [] });
		expect(card.calls()).toEqual([]);
		card.buttons("Share with someone")[0].click();
		// The share count is asked for when the form opens.
		expect(card.calls()).toEqual([{ arguments: { account: "kemisetti" }, name: "get_card_status" }]);
		await answerStatus(card);
		expect(card.root.texts()).toContain("Shares today: 2 of 10");

		const radios = card.nodes().filter((n) => n.tagName === "input" && n.type === "radio");
		expect(radios.map((r) => [r.checked, r.disabled])).toEqual([[true, false], [false, false], [false, false], [false, true], [false, true]]);
		expect(card.root.texts()).toEqual(expect.arrayContaining(["Viewer", "Commenter", "Editor", "Anyone with the link (not allowed in GoBridge)", "Everyone at a domain (not allowed in GoBridge)"]));
		// A disabled choice cannot be picked.
		radios[3].click();
		expect(radios[3].checked).toBe(false);
		radios[2].click();
		expect(radios.map((r) => r.checked)).toEqual([false, false, true, false, false]);

		card.buttons("Share").at(-1)!.click();
		expect(card.root.textContent).toContain("Enter one email address.");
		card.control("Person or group").enter("dana@example.com");
		card.buttons("Share").at(-1)!.click();
		await card.flush();
		expect(confirmText(card)).toContain("Confirm (two clicks)");
		expect(confirmText(card)).toContain("Accountkemisetti");
		expect(confirmText(card)).toContain("ActionShare this file as Editor (Google emails them)");
		expect(confirmText(card)).toContain("Targetdana@example.com");
		expect(confirmText(card)).toContain("2 of 10 shares today");
		card.buttons("Share").at(-1)!.click();
		expect(writeCalls(card)).toEqual([]);
		card.buttons("Click again: Share")[0].click();
		expect(writeCalls(card)).toEqual([{ arguments: { account: "kemisetti", emailAddress: "dana@example.com", fileId: "f1", role: "writer" }, name: "share_file" }]);
		await card.reply("tools/call", textResult({ emailAddress: "dana@example.com", fileId: "f1", role: "writer", shared: true, type: "user" }));
		expect(card.root.texts()).toEqual(expect.arrayContaining(["Shared. Google emailed the recipient.", "dana@example.com", "Editor", "Person"]));
		expectInert(card, FORM_TAGS);
	});

	it("shows a share_file result as a receipt without calling anything", async () => {
		const card = await opened(SCRIPTS.drive, "share_file", { account: "gmail", emailAddress: "x@example.com", fileId: "f1", role: "reader" }, { emailAddress: HOSTILE.subject, fileId: "f1", role: HOSTILE.body, shared: true, type: "group" });
		expect(card.root.texts()).toEqual(expect.arrayContaining(["Write", HOSTILE.subject, "Viewer", "Group"]));
		expect(card.calls()).toEqual([]);
		expectInert(card);
	});
});

describe("workspace card writes", () => {
	const S = (value: string) => untrusted("sheets", value);
	const values = { range: "Sheet1!A1:B4", spreadsheetId: "sheet1", values: [[S("Item"), S(HOSTILE.subject)], [S("Rent"), S("1200")], [S("Pay"), S("3000")], [S("Food"), S("400")]] };

	it("adds a row as RAW unless the user picks the other option, and never sets the formula override", async () => {
		const card = await opened(SCRIPTS.workspace, "get_values", { account: "gmail", range: "Sheet1!A1:B4", spreadsheetId: "sheet1" }, values);
		card.buttons("Add row")[0].click();
		expect(card.calls()).toEqual([]);
		// Fields come from the header row; the last two rows are shown for context.
		expect(card.nodes().filter((n) => n.tagName === "td").map((n) => n.textContent)).toEqual(["Pay", "3000", "Food", "400"]);
		expect(card.control("How values are stored").value).toBe("RAW");
		card.buttons("Add row").at(-1)!.click();
		expect(card.root.textContent).toContain("Fill in at least one cell.");
		card.control("Item").enter("Gas");
		card.control(HOSTILE.subject).enter('=IMPORTDATA("https://evil.example/x")');
		card.buttons("Add row").at(-1)!.click();
		await answerStatus(card);
		expect(confirmText(card)).toContain("ActionAdd one row, stored exactly as typed (RAW)");
		expect(confirmText(card)).toContain("TargetSheet1!A1:B4");
		expect(confirmText(card)).toContain("RAW: text starting with = is stored as text, not as a formula.");
		card.buttons("Cancel")[0].click();

		card.control("How values are stored").enter("USER_ENTERED");
		card.buttons("Add row").at(-1)!.click();
		expect(confirmText(card)).toContain("interpreted by Sheets (USER_ENTERED): formulas run");
		expect(confirmText(card)).toContain("GoBridge refuses formulas that reach outside the spreadsheet");
		card.buttons("Add row").at(-1)!.click();
		expect(writeCalls(card)).toEqual([
			{ arguments: { account: "gmail", range: "Sheet1!A1:B4", spreadsheetId: "sheet1", valueInputOption: "USER_ENTERED", values: [["Gas", '=IMPORTDATA("https://evil.example/x")']] }, name: "append_values" },
		]);
		// GoBridge's own scan refuses it; the card shows the refusal and nothing else happens.
		await card.reply("tools/call", textResult("Refused: 1 formula reaches outside the spreadsheet. Nothing was written.", true));
		expect(confirmText(card)).toContain("Refused: 1 formula reaches outside the spreadsheet.");
		expect(JSON.stringify(card.calls())).not.toContain("allowExternalFormulas");
		expectInert(card, TABLE_TAGS);
	});

	it("shows append_values and update_doc results as receipts", async () => {
		const appended = await opened(SCRIPTS.workspace, "append_values", { account: "gmail", range: "A1:B2", spreadsheetId: "sheet1", values: [["a"]] }, { appended: true, spreadsheetId: "sheet1", tableRange: S("Sheet1!A1:B4"), updates: { updatedCells: 2, updatedRange: S("Sheet1!A5:B5"), updatedRows: 1 } });
		expect(appended.root.texts()).toEqual(expect.arrayContaining(["Row added.", "Sheet1!A5:B5", "RAW (exactly as typed)", "Write"]));
		expect(appended.calls()).toEqual([]);

		const requests = [{ insertText: { text: HOSTILE.body } }, { insertText: { text: "b" } }, { [HOSTILE.subject]: {} }, { insertInlineImage: { uri: "https://evil.example/pixel.gif" } }];
		const updated = await opened(SCRIPTS.workspace, "update_doc", { account: "gmail", allowExternalUrls: true, documentId: "doc1", requests }, { commentError: untrusted("docs", HOSTILE.from), documentId: "doc1", replies: [{}, {}], requestsApplied: 4, updated: true });
		const texts = updated.root.texts();
		expect(texts).toEqual(expect.arrayContaining(["Applied 4 changes.", "2 ×", "insertText", HOSTILE.subject, "insertInlineImage"]));
		expect(updated.root.textContent).toContain("This call carried 1 image request. They ran only because allowExternalUrls was set for this call.");
		// The text and URL that were written are not repeated on the card.
		expect(updated.root.textContent).not.toContain("pixel.gif");
		expect(updated.calls()).toEqual([]);
		expectInert(updated, TABLE_TAGS);

		const plain = await opened(SCRIPTS.workspace, "update_doc", { account: "gmail", documentId: "doc1", requests: [{ insertText: {} }] }, { documentId: "doc1", requestsApplied: 1, updated: true });
		expect(plain.root.textContent).toContain("Image requests from a URL are refused unless allowExternalUrls is set for that call. This call had none.");
	});
});

describe("accounts card status", () => {
	it("checks each account's services only when asked", async () => {
		const card = await opened(SCRIPTS.accounts, "list_accounts", {}, { accounts: [{ alias: "michigan", email: "a@example.com" }, { alias: "gmail", email: "b@example.com" }, { alias: HOSTILE.subject, email: "c@example.com" }] }, false);
		expect(card.calls()).toEqual([]);
		card.buttons("Check services")[0].click();
		expect(card.pendingCalls()).toEqual([{ arguments: { account: "michigan" }, name: "get_card_status" }]);
		await answerStatus(card);
		await card.reply("tools/call", textResult({ ...STATUS, relinkNeeded: true, services: { calendar: false, drive: true, driveActivity: false, gmail: true } }));
		// The hostile alias is never sent anywhere.
		expect(card.calls()).toHaveLength(2);
		const texts = card.root.texts();
		expect(texts).toEqual(expect.arrayContaining(["Gmail: on", "Calendar: on", "Drive: on", "Drive Activity: re-link", "Re-link to turn on Drive Activity. Everything else works.", "Calendar: re-link", "This account needs to be linked again before its tools work."]));
		expect(card.buttons("Check services")).toEqual([]);
		expectInert(card);
	});
});

// ---------- Server side ----------

describe("get_card_status", () => {
	let counter = 0;
	async function linked(scopes: readonly string[] = LINK_SCOPES) {
		counter += 1;
		const alias = `st-${counter}`;
		await saveAccount(env, { alias, email: `status${counter}@example.com`, refreshToken: "1//fake-google-refresh-token", scopes: [...scopes], sub: `status-sub-${counter}` });
		return alias;
	}

	it("exists only while cards are on, and is marked app-only", async () => {
		const alias = await linked();
		expect(toolsFor(withCards("off")).map((t) => t.name)).not.toContain("get_card_status");
		expect(toolsFor(withCards("off"))).toHaveLength(72);
		for (const mode of ["read", "all"]) {
			expect(toolsFor(withCards(mode))).toHaveLength(73);
			const registered: Record<string, any> = {};
			registerTools({ registerTool: (name: string, config: any) => (registered[name] = config) } as any, withCards(mode), () => CLIENT);
			expect(Object.keys(registered)).toHaveLength(73);
			expect(registered.get_card_status._meta).toEqual({ ui: { visibility: ["app"] } });
			expect(registered.get_card_status.annotations).toEqual({ destructiveHint: false, openWorldHint: true, readOnlyHint: true });
		}
		const off = await runTool(withCards("off"), CLIENT, "get_card_status", { account: alias });
		expect(off.isError).toBe(true);
		expect((off.content[0] as { text: string }).text).toBe("Unknown tool.");
	});

	it("returns only numbers and true/false values: no email, id, name or content", async () => {
		const alias = await linked();
		const result = await runTool(env, CLIENT, "get_card_status", { account: alias });
		expect(result.isError).toBeUndefined();
		const text = (result.content[0] as { text: string }).text;
		const data = JSON.parse(text);
		const leaves: unknown[] = [];
		const walk = (value: unknown) => {
			if (value && typeof value === "object") for (const child of Object.values(value)) walk(child);
			else leaves.push(value);
		};
		walk(data);
		expect(leaves.length).toBe(18);
		for (const leaf of leaves) expect(["number", "boolean"]).toContain(typeof leaf);
		expect(text).not.toContain("@");
		expect(text).not.toContain(alias);
		expect(text).not.toContain("untrusted_content");
		expect(data).toEqual({
			limits: { readsPerHour: 300, sendsPerDay: 25, sharesPerDay: 10, writesPerHour: 60 },
			relinkNeeded: false,
			services: { calendar: true, drive: true, driveActivity: true, gmail: true },
			switches: { directSend: true, driveShare: true, driveWrite: true, forward: true, writes: true },
			// The call itself is a read, and is counted before it answers.
			usage: { readsThisHour: 1, sendsToday: 0, sharesToday: 0, writesThisHour: 0 },
		});
	});

	it("reports switches that are off and services an older sign-in does not cover", async () => {
		const older = await linked(TOOL_SCOPES.filter((scope) => !scope.includes("calendar")));
		const tight = { ...env, DAILY_SEND_CAP: "5", DIRECT_SEND_ENABLED: "false", DRIVE_SHARE_ENABLED: "no", WRITES_ENABLED: "TRUE" } as Env;
		const data = JSON.parse(((await runTool(tight, CLIENT, "get_card_status", { account: older })).content[0] as { text: string }).text);
		expect(data.switches).toEqual({ directSend: false, driveShare: false, driveWrite: true, forward: true, writes: false });
		expect(data.services).toEqual({ calendar: false, drive: true, driveActivity: false, gmail: true });
		expect(data.relinkNeeded).toBe(true);
		expect(data.limits.sendsPerDay).toBe(5);
	});

	it("goes through the normal tool path: client id, known alias, read limit, read audit, fail closed", async () => {
		const alias = await linked();
		expect((await runTool(env, undefined, "get_card_status", { account: alias })).isError).toBe(true);
		expect((await runTool(env, CLIENT, "get_card_status", { account: "nobody-here" })).isError).toBe(true);
		expect((await runTool(env, CLIENT, "get_card_status", {})).isError).toBe(true);

		const tight = { ...env, READ_RATE_LIMIT_PER_HOUR: "1" } as Env;
		expect((await runTool(tight, CLIENT, "get_card_status", { account: alias })).isError).toBeUndefined();
		const limited = await runTool(tight, CLIENT, "get_card_status", { account: alias });
		expect(limited.isError).toBe(true);
		expect((limited.content[0] as { text: string }).text).toMatch(/Rate limit reached/);

		const rows = (await listAudit(env, 1000, "read")).filter((e) => e.alias === alias && e.tool === "get_card_status");
		// Like every read: a call refused before it runs writes no audit row; the one that ran does.
		expect(rows.map((r) => r.outcome)).toEqual(["ok"]);
		expect(rows[0].clientId).toBe(CLIENT.clientId);

		const down = { ...env, USAGE_COUNTER: { get: () => { throw new Error("down"); }, idFromName: () => ({}) } } as unknown as Env;
		const refused = await runTool(down, CLIENT, "get_card_status", { account: alias });
		expect(refused.isError).toBe(true);
		expect((refused.content[0] as { text: string }).text).toMatch(/could not check its usage limits/);
	});
});

describe("calls a card makes are ordinary tool calls", () => {
	/** Every tool name a card script mentions: the ones it calls, plus two it only renders. */
	const CARD_TOOLS = [
		"append_values", "create_draft", "create_event", "create_label", "delete_draft", "delete_event", "delete_label", "forward", "get_card_status",
		"get_draft", "get_event", "get_file_permissions", "get_thread", "get_values", "label_thread", "list_accounts", "list_calendars", "list_events",
		"list_labels", "list_recent_files", "query_drive_activity", "read_doc", "read_presentation", "read_slide_page_thumbnail", "respond_to_event",
		"search_events", "search_files", "search_threads", "send_message", "share_file", "suggest_time", "trash_thread", "unlabel_thread",
		"untrash_thread", "update_doc", "update_draft", "update_event", "update_label",
	];

	it("names only real GoBridge tools, and no tool beyond the approved set", () => {
		const source = Object.values(SCRIPTS).join("\n");
		const mentioned = toolsFor(env).map((t) => t.name).filter((name) => source.includes(`"${name}"`));
		expect(mentioned.sort()).toEqual(CARD_TOOLS);
		// The host is the only path: the cards have no other way to reach GoBridge.
		expect(source.match(/tools\/call/g)).toHaveLength(5);
		expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
		// The overrides are never set by a card.
		expect(source).not.toMatch(/allowExternalUrls\s*:|allowExternalFormulas\s*:/);
	});

	let counter = 0;
	async function linked() {
		counter += 1;
		const alias = `cw-${counter}`;
		await saveAccount(env, { alias, email: `cw${counter}@example.com`, refreshToken: "1//fake-google-refresh-token", scopes: [...LINK_SCOPES], sub: `cw-sub-${counter}` });
		return alias;
	}
	function mockGoogle() {
		const seen: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input as RequestInfo, init);
			if (request.url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.fake-api-access-token", expires_in: 3600 });
			seen.push(`${request.method} ${new URL(request.url).pathname}`);
			return Response.json({
				attendees: [{ email: "me@example.com", responseStatus: "needsAction", self: true }],
				id: "x1",
				labelIds: ["DRAFT"],
				message: { id: "m1", labelIds: ["DRAFT"], payload: { headers: [{ name: "To", value: "dana@example.com" }, { name: "Subject", value: "Secret subject" }] } },
				payload: { body: { data: btoa("Secret body text") }, headers: [{ name: "From", value: "dana@example.com" }, { name: "Subject", value: "Secret subject" }], mimeType: "text/plain" },
				summary: "Secret event",
			});
		});
		return seen;
	}
	const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
	/** One call per write tool a card can make, exactly as the card sends it. */
	const cardWrites = (alias: string): [string, Record<string, unknown>][] => [
		["create_draft", { account: alias, body: "Looks good", replyToMessageId: "m1" }],
		["update_draft", { account: alias, draftId: "d1", subject: "New subject" }],
		["delete_draft", { account: alias, draftId: "x1" }],
		["send_message", { account: alias, draftId: "d1" }],
		["forward", { account: alias, forwardText: "FYI", messageId: "m1", to: ["lee@example.com"] }],
		["label_thread", { account: alias, labelIds: ["Label_2"], threadId: "t1" }],
		["unlabel_thread", { account: alias, labelIds: ["INBOX"], threadId: "t1" }],
		["trash_thread", { account: alias, threadId: "t1" }],
		["untrash_thread", { account: alias, threadId: "t1" }],
		["create_label", { account: alias, displayName: "Receipts" }],
		["update_label", { account: alias, displayName: "Office", labelId: "Label_2" }],
		["delete_label", { account: alias, labelId: "Label_2" }],
		["create_event", { account: alias, endTime: "2030-01-07T10:00:00", notificationLevel: "NONE", startTime: "2030-01-07T09:00:00", summary: "Sync" }],
		["update_event", { account: alias, eventId: "e1", notificationLevel: "NONE", summary: "Moved" }],
		["delete_event", { account: alias, eventId: "e1", notificationLevel: "NONE" }],
		["respond_to_event", { account: alias, eventId: "e1", notificationLevel: "NONE", responseStatus: "accepted" }],
		["share_file", { account: alias, emailAddress: "dana@example.com", fileId: "f1", role: "writer" }],
		["append_values", { account: alias, range: "Sheet1!A1:B4", spreadsheetId: "s1", valueInputOption: "RAW", values: [["Gas", "40"]] }],
	];

	it("accepts each write exactly as a card sends it, and audits it without content", async () => {
		mockGoogle();
		const alias = await linked();
		for (const [name, args] of cardWrites(alias)) {
			const result = await runTool(env, CLIENT, name, args);
			expect(result.isError, `${name}: ${text(result).slice(0, 200)}`).toBeUndefined();
		}
		const rows = (await listAudit(env, 1000, "write")).filter((e) => e.alias === alias);
		expect(rows.map((r) => r.tool).sort()).toEqual(cardWrites(alias).map(([name]) => name).sort());
		for (const row of rows) {
			expect(row.clientId).toBe(CLIENT.clientId);
			expect(row.outcome).toBe("ok");
		}
		const audit = JSON.stringify(rows);
		for (const secret of ["Secret body text", "Looks good", "FYI", "Gas"]) expect(audit).not.toContain(secret);
		// Nothing marks a call as coming from a card: the server cannot know, so it does not pretend to.
		expect(audit).not.toMatch(/card|ui:|initiated/i);
	});

	it("refuses every card write without a client id, with writes off, and when the counter is down", async () => {
		const seen = mockGoogle();
		const alias = await linked();
		const down = { ...env, USAGE_COUNTER: { get: () => { throw new Error("down"); }, idFromName: () => ({}) } } as unknown as Env;
		for (const [name, args] of cardWrites(alias)) {
			const anonymous = await runTool(env, undefined, name, args);
			expect(anonymous.isError, name).toBe(true);
			expect(text(anonymous), name).toMatch(/no client identity/);

			const off = await runTool({ ...env, WRITES_ENABLED: "false" } as Env, CLIENT, name, args);
			expect(off.isError, name).toBe(true);
			expect(text(off), name).toMatch(/^Writes disabled/);

			const failed = await runTool(down, CLIENT, name, args);
			expect(failed.isError, name).toBe(true);
			expect(text(failed), name).toMatch(/could not check its usage limits, so nothing was done/);
		}
		// Not one of those 54 calls reached Google.
		expect(seen).toEqual([]);
	});

	it("applies the feature switches to the card's forward, share and Drive writes", async () => {
		const seen = mockGoogle();
		const alias = await linked();
		const calls = Object.fromEntries(cardWrites(alias));
		const cases: [string, string, RegExp][] = [
			["forward", "FORWARD_ENABLED", /Forwarding is switched off/],
			["share_file", "DRIVE_SHARE_ENABLED", /Sharing Drive files is switched off/],
			["append_values", "DRIVE_WRITE_ENABLED", /Changing Drive files is switched off/],
		];
		for (const [name, flag, message] of cases) {
			const result = await runTool({ ...env, [flag]: "false" } as Env, CLIENT, name, calls[name]);
			expect(result.isError, name).toBe(true);
			expect(text(result), name).toMatch(message);
		}
		// The card sends drafts by id, which stays allowed with direct send off; a direct send is refused.
		expect((await runTool({ ...env, DIRECT_SEND_ENABLED: "false" } as Env, CLIENT, "send_message", { account: alias, body: "x", subject: "y", to: ["dana@example.com"] })).isError).toBe(true);
		expect(seen).toEqual([]);
		const refused = (await listAudit(env, 1000, "write")).filter((e) => e.alias === alias);
		expect(refused.map((r) => r.outcome)).toEqual([]);
	});

	it("counts card sends against the daily cap, shares against the share cap, and writes against the hourly limit", async () => {
		mockGoogle();
		const alias = await linked();
		const calls = Object.fromEntries(cardWrites(alias));

		const oneSend = { ...env, DAILY_SEND_CAP: "1" } as Env;
		expect((await runTool(oneSend, CLIENT, "send_message", calls.send_message)).isError).toBeUndefined();
		const capped = await runTool(oneSend, CLIENT, "forward", calls.forward);
		expect(capped.isError).toBe(true);
		expect(text(capped)).toMatch(/Daily send cap reached/);

		const usage = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName(alias));
		for (let i = 0; i < 10; i++) await usage.take("share", 10);
		const shareCapped = await runTool(env, CLIENT, "share_file", calls.share_file);
		expect(shareCapped.isError).toBe(true);
		expect(text(shareCapped)).toMatch(/Daily share cap reached/);

		for (let i = 0; i < 60; i++) await usage.take("write", 60);
		for (const name of ["trash_thread", "label_thread", "create_event", "append_values", "update_draft"]) {
			const limited = await runTool(env, CLIENT, name, calls[name]);
			expect(limited.isError, name).toBe(true);
			expect(text(limited), name).toMatch(/Rate limit reached: at most 60 write actions/);
		}
	});

	it("still scans a card's USER_ENTERED row for outside formulas", async () => {
		const seen = mockGoogle();
		const alias = await linked();
		const row = { account: alias, range: "Sheet1!A1:B4", spreadsheetId: "s1", values: [["Gas", '=IMPORTDATA("https://evil.example/x")']] };
		const refused = await runTool(env, CLIENT, "append_values", { ...row, valueInputOption: "USER_ENTERED" });
		expect(refused.isError).toBe(true);
		expect(seen.filter((line) => line.includes("append"))).toEqual([]);
		// RAW stores it as text, so it is allowed.
		expect((await runTool(env, CLIENT, "append_values", { ...row, valueInputOption: "RAW" })).isError).toBeUndefined();
		const rows = (await listAudit(env, 1000, "write")).filter((e) => e.alias === alias);
		expect(JSON.stringify(rows)).not.toContain("IMPORTDATA");
		expect(JSON.stringify(rows)).not.toContain("evil.example");
	});
});
