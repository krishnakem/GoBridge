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
.bulk { padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--bg-soft); font-size: 13px; font-weight: 600; }
.swatch { flex: none; width: 12px; height: 12px; border-radius: 50%; background: var(--other-bg); border: 1px solid var(--line); }
.label-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 4px 16px; border-bottom: 1px solid var(--line); }
.label-row .input { flex: 1; width: auto; }
.pill { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 2px 4px 2px 10px; background: var(--other-bg); color: var(--other-fg); font-size: 12px; font-weight: 600; }
.pill .btn-icon { min-height: 24px; min-width: 24px; padding: 0 3px; border: 0; background: none; color: inherit; }
.pill .icon { width: 14px; height: 14px; }
.quoted { border-left: 3px solid var(--line); margin: 0 16px 12px; padding: 4px 0 4px 10px; }
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
			var last = messages[messages.length - 1];
			var threadId = data.threadId || args.threadId;
			var target = subject ? clip(subject, 80) : "This conversation";
			var canWrite = WRITES && account && isId(threadId);
			App.draw({
				tool: "get_thread",
				account: account,
				line: App.argsLine(args),
				body: [top, list],
				actions: [
					canWrite && last && isId(last.id)
						? button("Draft reply", "btn", function () {
								replyScreen(last, subject, account);
							})
						: null,
					canWrite && last && isId(last.id)
						? button("Forward", "btn", function () {
								forwardScreen(last, subject, account);
							})
						: null,
					canWrite
						? button("Label", "btn", function () {
								chooseLabel(account, plural(1, "conversation") + ": " + target, [threadId]);
							})
						: null,
					canWrite && labels.indexOf("INBOX") !== -1
						? button("Archive", "btn", function () {
								App.confirm({
									account: account,
									action: "Archive (remove from the inbox)",
									target: target,
									label: "Archive",
									usage: "write",
									run: function () {
										return App.call("unlabel_thread", { account: account, threadId: threadId, labelIds: ["INBOX"] });
									},
									done: function () {
										receipt("unlabel_thread", account, "Archived. It is out of the inbox and still in All Mail.", target, data.viewUrl, null);
									},
								});
							})
						: null,
					canWrite
						? button("Trash", "btn", function () {
								App.confirm({
									account: account,
									action: "Move to Trash",
									target: target,
									label: "Move to Trash",
									twoClick: true,
									danger: true,
									usage: "write",
									note: "Gmail empties Trash after 30 days. GoBridge cannot delete mail for good.",
									run: function () {
										return App.call("trash_thread", { account: account, threadId: threadId });
									},
									done: function () {
										receipt("trash_thread", account, "Moved to Trash.", target, "", function () {
											return App.call("untrash_thread", { account: account, threadId: threadId });
										});
									},
								});
							})
						: null,
					linkButton("Open in Gmail", data.viewUrl, MAIL_HOSTS, "btn btn-primary"),
				],
				note: "Renders as plain text. Links are not clickable and images are not loaded.",
			});
		});
	});

	App.view("search_threads", function (parsed, args, account) {
		var state = { rows: [], next: parsed.data.nextPageToken || "", others: null, notice: "", picked: [], used: null };
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

		function pickedRows() {
			return state.rows.filter(function (row) {
				return state.picked.indexOf(row) !== -1;
			});
		}
		function pickedAccounts() {
			var seen = [];
			pickedRows().forEach(function (row) {
				if (seen.indexOf(row.account) === -1) seen.push(row.account);
			});
			return seen;
		}
		function toggle(row, on) {
			var index = state.picked.indexOf(row);
			if (on && index === -1) state.picked.push(row);
			if (!on && index !== -1) state.picked.splice(index, 1);
			// The count of writes already used is asked for once, on the first tick.
			if (state.used === null && account) {
				state.used = "";
				App.status(account).then(function (result) {
					state.used = (result.data && App.usageText(result.data, "write")) || "";
					App.redraw();
				});
			}
			App.redraw();
		}
		/** Runs one write per picked conversation, in turn. Each is counted and audited on its own. */
		function runEach(rows, tool, extra) {
			var queue = rows.slice();
			var failed = 0;
			var done = [];
			return new Promise(function (resolve) {
				function next() {
					var row = queue.shift();
					if (!row) return resolve({ data: { done: done, failed: failed } });
					var call = { account: row.account, threadId: row.thread.threadId };
					Object.keys(extra || {}).forEach(function (key) {
						call[key] = extra[key];
					});
					App.call(tool, call).then(function (result) {
						if (result.error) failed++;
						else done.push(row);
						next();
					});
				}
				next();
			});
		}
		function finish(result, verb, remove) {
			if (remove) {
				state.rows = state.rows.filter(function (row) {
					return result.done.indexOf(row) === -1;
				});
			}
			state.picked = [];
			state.used = null;
			state.notice = verb + " " + plural(result.done.length, "conversation") + "." + (result.failed ? " " + result.failed + " could not be changed." : "");
			App.redraw();
		}
		function bulk(kind) {
			var rows = pickedRows().filter(function (row) {
				return row.account && isId(row.thread.threadId);
			});
			var accounts = pickedAccounts();
			if (!rows.length) return;
			var target = plural(rows.length, "conversation");
			if (kind === "label") {
				if (accounts.length !== 1) {
					state.notice = "Labels belong to one account. Select conversations from a single account to label them.";
					return App.redraw();
				}
				return chooseLabel(
					accounts[0],
					target,
					rows.map(function (row) {
						return row.thread.threadId;
					}),
					function (count, failed) {
						finish({ done: rows.slice(0, count), failed: failed }, "Labelled", false);
					}
				);
			}
			var trash = kind === "trash";
			App.confirm({
				account: accounts.join(", "),
				action: trash ? "Move to Trash" : "Archive (remove from the inbox)",
				target: target,
				label: trash ? "Move " + rows.length + " to Trash" : "Archive " + rows.length,
				twoClick: trash,
				danger: trash,
				note: "Uses " + plural(rows.length, "write") + " of the 60 allowed per account each hour." + (trash ? " Gmail empties Trash after 30 days." : ""),
				run: function () {
					return trash ? runEach(rows, "trash_thread", null) : runEach(rows, "unlabel_thread", { labelIds: ["INBOX"] });
				},
				done: function (result) {
					finish(result, trash ? "Moved to Trash:" : "Archived", true);
				},
			});
		}

		App.go(function () {
			var body = [];
			if (WRITES && state.picked.length) {
				body.push(el("div", "bulk", state.picked.length + " selected · uses " + state.picked.length + " of 60 writes this hour" + (state.used ? " (" + state.used + " so far)" : "")));
			}
			body = body.concat(state.rows.map(function (row) {
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
				var pick = null;
				if (WRITES && row.account && isId(thread.threadId)) {
					var box = input("checkbox");
					box.checked = state.picked.indexOf(row) !== -1;
					box.setAttribute("aria-label", "Select this conversation");
					box.addEventListener("change", function () {
						toggle(row, box.checked);
					});
					pick = el("span", "mail-pick", null, box);
				}
				return el("div", "mail-row", null, pick, item);
			}));
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
					WRITES && state.picked.length
						? button("Label", "btn", function () {
								bulk("label");
							})
						: null,
					WRITES && state.picked.length
						? button("Archive", "btn", function () {
								bulk("archive");
							})
						: null,
					WRITES && state.picked.length
						? button("Trash", "btn", function () {
								bulk("trash");
							})
						: null,
					state.next ? button("Load more", "btn", loadMore) : null,
					account && !state.others ? button("Show other accounts", "btn", showOthers) : null,
				],
				note: "Subjects and snippets render as plain text.",
			});
		});
	});

	function isId(value) {
		return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
	}

	/** A plain result screen after a write, with Undo when the write can be reversed. */
	function receipt(tool, account, text, target, viewUrl, undo) {
		var state = { text: text, undone: false, error: "" };
		App.go(function () {
			App.draw({
				tool: tool,
				account: account,
				line: "",
				body: [el("div", "banner banner-ok", state.text), el("div", "pad pairs", null, pair("Account", account), pair("Target", target)), state.error ? el("p", "note", state.error) : null],
				actions: [
					undo && !state.undone
						? button("Undo", "btn", function () {
								App.confirm({
									account: account,
									action: "Undo: put it back",
									target: target,
									label: "Undo",
									usage: "write",
									run: undo,
									done: function () {
										state.undone = true;
										state.text = "Undone. It is back where it was.";
										App.redraw();
									},
								});
							})
						: null,
					linkButton("Open in Gmail", viewUrl, MAIL_HOSTS, "btn btn-primary"),
				],
			});
		});
	}

	/** Loads the account's labels, then asks which one to add to the given conversations. */
	function chooseLabel(account, target, threadIds, after) {
		App.call("list_labels", { account: account }).then(function (result) {
			if (result.error) return App.message("list_labels", account, "", result.error);
			var labels = (Array.isArray(result.data.labels) ? result.data.labels : []).filter(function (label) {
				return label && label.type === "user" && isId(label.id);
			});
			if (!labels.length) return App.message("list_labels", account, "", "This account has no labels of its own yet.");
			// Option values are positions in the list, never text from Gmail.
			var options = document.createElement("select");
			options.className = "input";
			labels.forEach(function (label, index) {
				var option = document.createElement("option");
				option.value = String(index);
				option.textContent = label.name || "Label";
				options.appendChild(option);
			});
			options.value = "0";
			App.confirm({
				account: account,
				action: "Add a label",
				target: target,
				label: "Add label",
				extra: field("Label", options),
				note: "Uses " + plural(threadIds.length, "write") + " of the 60 allowed per account each hour.",
				run: function () {
					var chosen = labels[Number(options.value)] || labels[0];
					var queue = threadIds.slice();
					var count = 0;
					var failed = 0;
					var lastError = "";
					return new Promise(function (resolve) {
						function next() {
							var threadId = queue.shift();
							if (!threadId) return resolve(count ? { data: { count: count, failed: failed, name: chosen.name } } : { error: lastError || "Nothing was labelled." });
							App.call("label_thread", { account: account, threadId: threadId, labelIds: [chosen.id] }).then(function (one) {
								if (one.error) {
									failed++;
									lastError = one.error;
								} else {
									count++;
								}
								next();
							});
						}
						next();
					});
				},
				done: function (data) {
					if (after) return after(data.count, data.failed);
					receipt("label_thread", account, "Label added: " + (data.name || "label") + ".", target, "", null);
				},
			});
		});
	}

	function replyScreen(message, subject, account) {
		var body = textarea("");
		var status = el("div", "muted");
		App.go(function () {
			App.draw({
				tool: "create_draft",
				account: account,
				line: "reply to: " + clip(message.from || "the sender", 80),
				body: [el("div", "form", null, field("Your reply", body), status)],
				actions: [
					button("Save as draft", "btn btn-primary", function () {
						if (!body.value.trim()) {
							status.textContent = "Write a reply first.";
							return;
						}
						App.confirm({
							account: account,
							action: "Save a reply as a draft (nothing is sent)",
							target: clip(subject || "This conversation", 80),
							label: "Save draft",
							usage: "write",
							run: function () {
								return App.call("create_draft", { account: account, replyToMessageId: message.id, body: body.value });
							},
							done: function (data) {
								App.replace("create_draft", { data: data }, { account: account });
							},
						});
					}),
				],
				note: "Saved as a draft in Gmail. You review and send it as a separate step.",
			});
		});
	}

	/** Recipients as removable chips. Returns { node, list }. */
	function recipientPicker(labelText) {
		var list = [];
		var chips = el("div", "wrap");
		var entry = input("email", "");
		var status = el("div", "muted");
		function drawChips() {
			chips.replaceChildren.apply(
				chips,
				list.map(function (address) {
					return el(
						"span",
						"pill",
						null,
						el("span", null, address),
						iconButton("close", "Remove this recipient", function () {
							list.splice(list.indexOf(address), 1);
							drawChips();
						})
					);
				})
			);
		}
		function add() {
			var found = emailsIn(entry.value);
			status.textContent = found.length ? "" : "Enter an email address.";
			found.forEach(function (address) {
				if (list.indexOf(address) === -1 && list.length < 20) list.push(address);
			});
			if (found.length) entry.value = "";
			drawChips();
		}
		var node = el("div", "stack", null, field(labelText, entry), el("div", "wrap", null, button("Add recipient", "btn", add)), chips, status);
		return { node: node, list: list, add: add, entry: entry };
	}

	function forwardScreen(message, subject, account) {
		var picker = recipientPicker("Forward to");
		var note = textarea("");
		var status = el("div", "muted");
		App.go(function () {
			var preview = el(
				"div",
				"quoted stack",
				null,
				el("div", "strong", clip(subject || "(no subject)", 120)),
				el("div", "muted", "From " + clip(message.from || "unknown sender", 120)),
				el("pre", "text", clip(message.body || message.snippet || "", 600))
			);
			var files = Array.isArray(message.attachments) ? message.attachments.length : 0;
			App.draw({
				tool: "forward",
				account: account,
				line: "",
				body: [el("div", "form", null, picker.node, field("Note (optional)", note), status), el("div", "group pad", "Original message"), preview],
				actions: [
					button("Forward", "btn btn-primary", function () {
						if (picker.entry.value.trim()) picker.add();
						if (!picker.list.length) {
							status.textContent = "Add at least one recipient.";
							return;
						}
						status.textContent = "";
						App.confirm({
							account: account,
							action: "Forward this message by email",
							target: picker.list.join(", "),
							label: "Forward",
							twoClick: true,
							usage: "send",
							note: "Counts as a send." + (files ? " " + plural(files, "attachment") + " will be included." : ""),
							run: function () {
								var call = { account: account, messageId: message.id, to: picker.list.slice() };
								if (note.value.trim()) call.forwardText = note.value;
								return App.call("forward", call);
							},
							done: function (data) {
								App.replace("forward", { data: data }, { account: account });
							},
						});
					}),
				],
				note: "Counts as a send. Attachments on the original are always included.",
			});
		});
	}

	/** The receipt for send_message, reply and forward. */
	function sentView(tool) {
		return function (parsed, args, account) {
			var data = parsed.data;
			var state = { limits: null, notice: "" };
			App.go(function () {
				var recipients = Array.isArray(data.recipients) ? data.recipients.join(", ") : "";
				var facts = el("div", "pad pairs", null, pair("From", account || "this account"), pair("To", recipients || "the draft's recipients"), pair("Subject", data.subject || "(no subject)"));
				var tiles = null;
				if (state.limits) {
					var usage = state.limits.usage || {};
					var limits = state.limits.limits || {};
					var direct = state.limits.switches && state.limits.switches.directSend === true;
					tiles = el(
						"div",
						"tiles",
						null,
						el("div", "tile", null, el("span", "tile-value", Number(usage.sendsToday) + " / " + Number(limits.sendsPerDay)), el("span", "muted", "Sends today")),
						el("div", "tile", null, el("span", "tile-value", Number(usage.writesThisHour) + " / " + Number(limits.writesPerHour)), el("span", "muted", "Writes this hour")),
						el("div", "tile", null, el("span", "tile-value", direct ? "On" : "Off"), el("span", "muted", "Direct send"))
					);
				}
				App.draw({
					tool: tool,
					account: account,
					line: "",
					body: [el("div", "banner banner-ok", data.sent === true ? "Sent." : "This call did not report a sent message."), facts, tiles, state.notice ? el("p", "note", state.notice) : null],
					actions: [
						account && !state.limits
							? button("Show limits", "btn", function () {
									App.status(account).then(function (result) {
										state.limits = result.data || null;
										state.notice = result.error || "";
										App.redraw();
									});
								})
							: null,
						linkButton("Open in Gmail", data.viewUrl, MAIL_HOSTS, "btn btn-primary"),
					],
					note: "Counts as a send. This card shows the result; it did not send anything itself.",
				});
			});
		};
	}
	App.view("send_message", sentView("send_message"));
	App.view("forward", sentView("forward"));

	/** A draft: get_draft, and the preview create_draft and update_draft return. */
	function draftView(tool) {
		return function (parsed, args, account) {
			var data = parsed.data;
			var draftId = data.draftId || args.draftId;
			var asList = function (value) {
				return Array.isArray(value) ? value.join(", ") : emailsIn(value).join(", ");
			};
			var saved = { to: asList(data.to), cc: asList(data.cc), subject: typeof data.subject === "string" ? data.subject : "", body: typeof data.body === "string" ? data.body : null };
			var hasBody = saved.body !== null;
			var editable = WRITES && account && isId(draftId);
			var to = input("text", saved.to);
			var cc = input("text", saved.cc);
			var subject = input("text", saved.subject);
			var body = textarea(hasBody ? saved.body : "");
			var status = el("div", "muted");
			function changes() {
				var out = {};
				if (to.value.trim() !== saved.to) out.to = emailsIn(to.value);
				if (cc.value.trim() !== saved.cc) out.cc = emailsIn(cc.value);
				if (subject.value !== saved.subject) out.subject = subject.value;
				if (hasBody && body.value !== saved.body) out.body = body.value;
				return out;
			}
			function dirty() {
				return Object.keys(changes()).length > 0;
			}
			App.go(function () {
				var content;
				if (editable) {
					content = el("div", "form", null, field("To", to), field("Cc", cc), field("Subject", subject), hasBody ? field("Message", body) : el("div", "muted", data.snippet ? "Starts: " + data.snippet : "The message text was not included in this result, so it cannot be edited here."), status);
				} else {
					content = el("div", "pad stack", null, el("div", "pairs", null, pair("To", saved.to || "(nobody yet)"), pair("Cc", saved.cc || "(nobody)"), pair("Subject", saved.subject || "(no subject)")), el("pre", "text", hasBody ? saved.body : data.snippet || ""));
				}
				var recipients = [saved.to, saved.cc].filter(Boolean).join(", ");
				App.draw({
					tool: tool,
					account: account,
					line: App.argsLine(args),
					body: [el("div", "banner", "Draft. Not sent."), content],
					actions: editable
						? [
								button("Delete draft", "btn", function () {
									App.confirm({
										account: account,
										action: "Delete this draft for good",
										target: saved.subject ? clip(saved.subject, 80) : "Draft without a subject",
										label: "Delete draft",
										twoClick: true,
										danger: true,
										usage: "write",
										note: "Only the unsent draft is deleted. This cannot be undone.",
										run: function () {
											return App.call("delete_draft", { account: account, draftId: draftId });
										},
										done: function () {
											App.replaceMessage("delete_draft", account, "Draft deleted.");
										},
									});
								}),
								button("Save draft", "btn", function () {
									var changed = changes();
									if (!Object.keys(changed).length) {
										status.textContent = "Nothing has changed.";
										return;
									}
									status.textContent = "";
									changed.account = account;
									changed.draftId = draftId;
									App.confirm({
										account: account,
										action: "Save changes to this draft (nothing is sent)",
										target: clip(subject.value || "Draft without a subject", 80),
										label: "Save draft",
										usage: "write",
										run: function () {
											return App.call("update_draft", changed);
										},
										done: function (updated) {
											App.replace("update_draft", { data: updated }, { account: account, draftId: draftId });
										},
									});
								}),
								button("Send", "btn btn-primary", function () {
									if (dirty()) {
										status.textContent = "Save your changes first. Send delivers the draft exactly as saved.";
										return;
									}
									if (!recipients) {
										status.textContent = "Add a recipient and save the draft first.";
										return;
									}
									status.textContent = "";
									App.confirm({
										account: account,
										action: "Send this draft by email now",
										target: recipients,
										label: "Send",
										twoClick: true,
										usage: "send",
										note: "Counts as a send. The draft is sent exactly as saved.",
										run: function () {
											return App.call("send_message", { account: account, draftId: draftId });
										},
										done: function (sent) {
											App.replace("send_message", { data: sent }, { account: account });
										},
									});
								}),
							]
						: [linkButton("Open in Gmail", data.viewUrl, MAIL_HOSTS, "btn btn-primary")],
					note: "Renders as plain text. Nothing is sent or saved until you confirm.",
				});
			});
		};
	}
	App.view("get_draft", draftView("get_draft"));
	App.view("create_draft", draftView("create_draft"));
	App.view("update_draft", draftView("update_draft"));

	App.view("list_labels", function (parsed, args, account) {
		var state = { labels: Array.isArray(parsed.data.labels) ? parsed.data.labels : [], editing: "", notice: "" };
		function reload(text) {
			state.notice = text;
			state.editing = "";
			App.call("list_labels", { account: account }).then(function (result) {
				if (result.data) state.labels = Array.isArray(result.data.labels) ? result.data.labels : [];
				else state.notice = text + " " + result.error;
				App.redraw();
			});
		}
		App.go(function () {
			var canWrite = WRITES && account;
			var fresh = input("text", "");
			var body = [];
			if (state.notice) body.push(el("div", "banner banner-ok", state.notice));
			state.labels.forEach(function (label) {
				var own = label.type === "user" && isId(label.id);
				var dot = el("span", "swatch");
				var colour = label.color && label.color.backgroundColor;
				// Only a plain six-digit hex colour from Gmail's palette is ever used as a style.
				if (typeof colour === "string" && /^#[0-9a-fA-F]{6}$/.test(colour)) dot.style.setProperty("background", colour);
				var row = el("div", "label-row", null, dot);
				if (canWrite && own && state.editing === label.id) {
					var name = input("text", label.name || "");
					name.setAttribute("aria-label", "New name for this label");
					row.appendChild(name);
					row.appendChild(
						button("Save", "btn", function () {
							var next = name.value.trim();
							if (!next || next === label.name) return;
							App.confirm({
								account: account,
								action: "Rename this label",
								target: clip(label.name || "Label", 60) + " → " + clip(next, 60),
								label: "Rename",
								usage: "write",
								run: function () {
									return App.call("update_label", { account: account, labelId: label.id, displayName: next });
								},
								done: function () {
									reload("Label renamed.");
								},
							});
						})
					);
					row.appendChild(
						iconButton("close", "Stop renaming", function () {
							state.editing = "";
							App.redraw();
						})
					);
				} else {
					row.appendChild(el("span", "grow clip", label.name || "Label"));
					if (!own) row.appendChild(el("span", "tag", "Built in"));
					if (canWrite && own) {
						row.appendChild(
							iconButton("edit", "Rename this label", function () {
								state.editing = label.id;
								App.redraw();
							})
						);
						row.appendChild(
							iconButton("trash", "Delete this label", function () {
								App.confirm({
									account: account,
									action: "Delete this label for good",
									target: clip(label.name || "Label", 80),
									label: "Delete label",
									twoClick: true,
									danger: true,
									usage: "write",
									note: "The label is removed from every conversation. The conversations themselves stay.",
									run: function () {
										return App.call("delete_label", { account: account, labelId: label.id });
									},
									done: function () {
										reload("Label deleted.");
									},
								});
							})
						);
					}
				}
				body.push(row);
			});
			if (!state.labels.length) body.push(el("p", "note", "No labels."));
			if (canWrite) body.push(el("div", "form", null, field("New label name", fresh)));
			App.draw({
				tool: "list_labels",
				account: account,
				line: plural(state.labels.length, "label"),
				body: body,
				actions: [
					canWrite
						? button("Create label", "btn btn-primary", function () {
								var name = fresh.value.trim();
								if (!name) return;
								App.confirm({
									account: account,
									action: "Create a label",
									target: clip(name, 80),
									label: "Create label",
									usage: "write",
									run: function () {
										return App.call("create_label", { account: account, displayName: name });
									},
									done: function () {
										reload("Label created.");
									},
								});
							})
						: null,
				],
				note: "Label names render as plain text. Gmail does not report how many conversations a label holds here.",
			});
		});
	});

	App.start("GoBridge mail", function (data) {
		if (Array.isArray(data.threads)) return "search_threads";
		if (Array.isArray(data.messages)) return "get_thread";
		if (Array.isArray(data.labels)) return "list_labels";
		if (data.sent === true) return "send_message";
		if (typeof data.draftId === "string") return "get_draft";
		return "";
	});
})();
`;
