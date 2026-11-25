/**
 * Mail card (ui://gobridge/mail.html): search_threads results as a list and
 * get_thread results as a conversation. Opening a row calls get_thread through
 * the host, so it passes the same guardrails as a call made by the model.
 *
 * Email content is shown as plain text only: no HTML mail, no images, and no
 * clickable links from message bodies. The one link is "Open in Gmail", which
 * goes through the host's ui/open-link and only for https://mail.google.com.
 */

export const MAIL_CSS = String.raw`
.messages { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
.bubble { border: 1px solid var(--line); border-radius: 12px; background: var(--bg-soft); overflow: hidden; }
.bubble-head {
	all: unset;
	box-sizing: border-box;
	display: flex;
	justify-content: space-between;
	gap: 12px;
	width: 100%;
	min-height: 36px;
	padding: 8px 12px;
	cursor: pointer;
}
.bubble-body { display: flex; flex-direction: column; gap: 10px; padding: 0 12px 12px; }
.bubble-body[hidden] { display: none; }
.file { border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font-size: 12px; background: var(--bg); }
.unread .from { font-weight: 700; }
.mail-row { display: flex; align-items: stretch; border-bottom: 1px solid var(--line); }
.mail-row .item { border-bottom: 0; }
.mail-pick { display: flex; align-items: center; padding: 0 0 0 16px; }
.bulk { padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--bg-soft); font-size: 13px; }
`;

export const MAIL_JS = String.raw`
(function () {
	var MAIL_HOSTS = ["mail.google.com"];
	var SYSTEM_LABELS = { INBOX: "Inbox", UNREAD: "Unread", STARRED: "Starred", IMPORTANT: "Important", SENT: "Sent", DRAFT: "Draft", TRASH: "Trash", SPAM: "Spam" };

	function labelTags(ids) {
		var row = el("div", "wrap");
		var other = 0;
		(Array.isArray(ids) ? ids : []).forEach(function (id) {
			if (Object.prototype.hasOwnProperty.call(SYSTEM_LABELS, id)) row.appendChild(el("span", "tag", SYSTEM_LABELS[id]));
			else if (/^Label_/.test(String(id))) other++;
		});
		if (other) row.appendChild(el("span", "tag", "+" + plural(other, "label")));
		return row.children.length ? row : null;
	}

	function messageNode(message, open) {
		var body = el("div", "bubble-body");
		var people = [message.to ? "To " + message.to : "", message.cc ? "Cc " + message.cc : ""].filter(Boolean).join(" · ");
		if (people) body.appendChild(el("div", "muted", people));
		var text = typeof message.body === "string" && message.body ? message.body : message.snippet;
		if (text) body.appendChild(el("pre", "text", text));
		if (message.bodyTruncated) body.appendChild(el("div", "muted", "This message is longer than shown here."));
		var files = Array.isArray(message.attachments) ? message.attachments : [];
		if (files.length) {
			var list = el("div", "wrap");
			files.forEach(function (file) {
				var size = formatSize(file.size);
				list.appendChild(el("span", "file", (file.filename || "Attachment") + (size ? " · " + size : "")));
			});
			body.appendChild(list);
		}
		body.hidden = !open;
		var toggle = button("", "bubble-head", function () {
			body.hidden = !body.hidden;
		});
		toggle.appendChild(el("span", "strong", message.from || "Unknown sender"));
		toggle.appendChild(el("span", "muted", formatDate(message.date)));
		return el("div", "bubble", null, toggle, body);
	}

	App.view("get_thread", function (parsed, args, account) {
		var data = parsed.data;
		var messages = Array.isArray(data.messages) ? data.messages : [];
		var subject = "";
		var labels = [];
		messages.forEach(function (message) {
			if (!subject && message.subject) subject = message.subject;
			(Array.isArray(message.labelIds) ? message.labelIds : []).forEach(function (id) {
				if (labels.indexOf(id) === -1) labels.push(id);
			});
		});
		var count = Number(data.messageCount) || messages.length;
		App.go(function () {
			var list = el("div", "messages");
			var omitted = Number(data.messagesOmitted) || 0;
			if (omitted) list.appendChild(el("div", "muted", plural(omitted, "earlier message") + " not shown."));
			messages.forEach(function (message, index) {
				list.appendChild(messageNode(message, index === messages.length - 1));
			});
			var top = el("div", "pad stack", null, el("div", "title", subject || "Conversation"), el("div", "muted", plural(count, "message")), labelTags(labels));
			App.draw({
				tool: "get_thread",
				account: account,
				line: App.argsLine(args),
				body: [top, list],
				actions: [linkButton("Open in Gmail", data.viewUrl, MAIL_HOSTS, "btn btn-primary")],
				note: "Renders as plain text. Links are not clickable and images are not loaded.",
			});
		});
	});

	App.view("search_threads", function (parsed, args, account) {
		var state = { rows: [], next: parsed.data.nextPageToken || "", others: null, notice: "" };
		function add(data, alias) {
			(Array.isArray(data.threads) ? data.threads : []).forEach(function (thread) {
				state.rows.push({ thread: thread, account: alias });
			});
		}
		add(parsed.data, account);

		function openThread(row) {
			if (!row.account || typeof row.thread.threadId !== "string") return;
			App.open("get_thread", { account: row.account, threadId: row.thread.threadId, messageFormat: "PLAIN_TEXT" });
		}
		function loadMore() {
			var more = {};
			Object.keys(args).forEach(function (key) {
				more[key] = args[key];
			});
			more.pageToken = state.next;
			state.notice = "Loading more…";
			App.redraw();
			App.call("search_threads", more).then(function (result) {
				state.notice = result.error || "";
				if (result.data) {
					add(result.data, account);
					state.next = result.data.nextPageToken || "";
				}
				App.redraw();
			});
		}
		/** Runs the same search on the other linked accounts. Only on the user's click. */
		function showOthers() {
			state.notice = "Checking the other accounts…";
			state.others = [];
			App.redraw();
			App.call("list_accounts", {}).then(function (result) {
				if (result.error) {
					state.notice = result.error;
					state.others = null;
					return App.redraw();
				}
				var aliases = (Array.isArray(result.data.accounts) ? result.data.accounts : [])
					.map(function (entry) {
						return entry && entry.alias;
					})
					.filter(function (alias) {
						return typeof alias === "string" && alias !== account;
					});
				var failed = 0;
				function next() {
					var alias = aliases.shift();
					if (!alias) {
						state.notice = failed ? plural(failed, "account") + " could not be searched." : "";
						return App.redraw();
					}
					var same = {};
					Object.keys(args).forEach(function (key) {
						if (key !== "pageToken") same[key] = args[key];
					});
					same.account = alias;
					App.call("search_threads", same).then(function (found) {
						if (found.data) {
							add(found.data, alias);
							state.others.push(alias);
						} else {
							failed++;
						}
						next();
					});
				}
				next();
			});
		}

		App.go(function () {
			var body = state.rows.map(function (row) {
				var thread = row.thread;
				var count = Number(thread.messageCount) || 0;
				var unread = Array.isArray(thread.labelIds) && thread.labelIds.indexOf("UNREAD") !== -1;
				var item = button("", "item" + (unread ? " unread" : ""), function () {
					openThread(row);
				});
				item.appendChild(
					el(
						"div",
						"row",
						null,
						el("span", "from clip grow", thread.from || "Conversation"),
						el("span", "muted", [formatDate(thread.lastDate), count > 1 ? plural(count, "message") : ""].filter(Boolean).join(" · ")),
						row.account ? accountChip(row.account) : null
					)
				);
				if (thread.subject) item.appendChild(el("div", "clip", thread.subject));
				if (thread.snippet) item.appendChild(el("div", "muted clip", thread.snippet));
				if (!row.account) item.disabled = true;
				return el("div", "mail-row", null, item);
			});
			if (!state.rows.length) body.push(el("p", "note", "No conversations found."));
			var summary = state.rows.length ? plural(state.rows.length, "conversation") + ". Select one to open it here." : "";
			if (state.notice) summary = state.notice;
			if (summary && state.rows.length) body.push(el("div", "footnote", summary));
			App.draw({
				tool: "search_threads",
				account: state.others && state.others.length ? "" : account,
				line: App.argsLine(args),
				body: body,
				actions: [
					state.next ? button("Load more", "btn", loadMore) : null,
					account && !state.others ? button("Show other accounts", "btn", showOthers) : null,
				],
				note: "Subjects and snippets render as plain text.",
			});
		});
	});

	App.start("GoBridge mail", function (data) {
		if (Array.isArray(data.threads)) return "search_threads";
		if (Array.isArray(data.messages)) return "get_thread";
		return "";
	});
})();
`;
