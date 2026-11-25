/**
 * Drive card (ui://gobridge/drive.html): search_files, list_recent_files,
 * get_file_permissions and query_drive_activity.
 *
 * File names, people and activity titles are shown as plain text. There are
 * no thumbnails: a file tile is a coloured block with a type badge. The one
 * link is "Open in Drive", through the host's ui/open-link and only for an
 * https URL on drive.google.com or docs.google.com.
 */

export const DRIVE_CSS = String.raw`
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 10px 16px 0; font-size: 13px; }
.crumb { all: unset; cursor: pointer; font-weight: 600; min-height: 24px; }
.crumb:disabled { cursor: default; color: var(--muted); }
.search { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.search .input { flex: 1; min-width: 140px; width: auto; }
.file-row { flex-direction: row; align-items: center; gap: 10px; }
.type { flex: none; width: 40px; text-align: center; border-radius: 6px; padding: 2px 0; font-size: 11px; font-weight: 700; background: var(--other-bg); color: var(--other-fg); }
.type-dir { background: var(--other-bg); color: var(--other-fg); }
.type-doc { background: var(--indigo-bg); color: var(--indigo-fg); }
.type-xls { background: var(--read-bg); color: var(--read-fg); }
.type-ppt { background: var(--write-bg); color: var(--write-fg); }
.type-pdf { background: var(--purple-bg); color: var(--purple-fg); }
.type-md { background: var(--teal-bg); color: var(--teal-fg); }
.grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; padding: 12px 16px; }
.file-tile { all: unset; box-sizing: border-box; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; cursor: pointer; min-width: 0; }
.tile-block { display: flex; align-items: center; justify-content: center; height: 56px; width: auto; border-radius: 0; font-size: 13px; }
.tile-text { display: flex; flex-direction: column; gap: 4px; padding: 8px; min-width: 0; }
.person { display: flex; align-items: center; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--line); }
.steps { display: flex; flex-direction: column; padding: 12px 16px; }
.step { position: relative; padding: 0 0 14px 18px; border-left: 2px solid var(--line); }
.step:last-child { border-left-color: transparent; }
.dot { position: absolute; left: -6px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
@media (max-width: 420px) { .grid3 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

export const DRIVE_JS = String.raw`
(function () {
	var DRIVE_HOSTS = ["drive.google.com", "docs.google.com"];
	var FOLDER = "application/vnd.google-apps.folder";
	var TYPES = [
		[/^application\/vnd\.google-apps\.folder$/, "DIR", "type-dir"],
		[/^application\/vnd\.google-apps\.document$|wordprocessingml|^application\/msword$/, "DOC", "type-doc"],
		[/^application\/vnd\.google-apps\.spreadsheet$|spreadsheetml|^text\/csv$|ms-excel/, "XLS", "type-xls"],
		[/^application\/vnd\.google-apps\.presentation$|presentationml|ms-powerpoint/, "PPT", "type-ppt"],
		[/^application\/pdf$/, "PDF", "type-pdf"],
		[/^text\/(markdown|x-markdown)$/, "MD", "type-md"],
	];
	function typeOf(file) {
		var mime = String(file.mimeType || "");
		for (var i = 0; i < TYPES.length; i++) {
			if (TYPES[i][0].test(mime)) return TYPES[i];
		}
		if (/\.md$/i.test(String(file.name || ""))) return [null, "MD", "type-md"];
		return [null, "FILE", ""];
	}
	function typeBadge(file, extra) {
		var type = typeOf(file);
		return el("span", "type " + type[2] + (extra ? " " + extra : ""), type[1]);
	}
	function isId(value) {
		return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
	}
	/** A user's words inside a Drive query string literal. */
	function quote(text) {
		return "'" + String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
	}
	function copy(args) {
		var out = {};
		Object.keys(args || {}).forEach(function (key) {
			out[key] = args[key];
		});
		return out;
	}

	/** One file: what it is, and the read-only views GoBridge has for it. */
	function fileScreen(file, account, tool) {
		App.go(function () {
			var facts = el("div", "pad pairs", null, pair("Type", typeOf(file)[1]), pair("Modified", formatDate(file.modifiedTime)));
			if (Array.isArray(file.owners) && file.owners.length) facts.appendChild(pair("Owner", file.owners.join(", ")));
			if (file.lastModifiedBy) facts.appendChild(pair("Edited by", file.lastModifiedBy));
			var size = formatSize(file.size);
			if (size) facts.appendChild(pair("Size", size));
			App.draw({
				tool: tool,
				account: account,
				line: "file: " + typeOf(file)[1],
				body: [el("div", "pad stack", null, el("div", "title", file.name || "Untitled"), file.shared ? el("span", "tag", "Shared") : null), facts],
				actions: [
					isId(file.id) && account
						? button("Who has access", "btn", function () {
								App.open("get_file_permissions", { account: account, fileId: file.id });
							})
						: null,
					isId(file.id) && account
						? button("Activity", "btn", function () {
								App.open("query_drive_activity", { account: account, itemName: file.id });
							})
						: null,
					linkButton("Open in Drive", file.webViewLink, DRIVE_HOSTS, "btn btn-primary"),
				],
				note: "File names render as plain text. No preview image is loaded.",
			});
		});
	}

	App.view("search_files", function (parsed, args, account) {
		var state = {
			files: Array.isArray(parsed.data.files) ? parsed.data.files.slice() : [],
			next: parsed.data.nextPageToken || "",
			query: typeof args.query === "string" ? args.query : "",
			crumbs: [],
			words: "",
			foldersOnly: false,
			notice: "",
		};
		/** The query for the current folder, search words and folders-only toggle. */
		function browseQuery() {
			var clauses = ["trashed = false"];
			var folder = state.crumbs.length ? state.crumbs[state.crumbs.length - 1].id : "";
			if (folder) clauses.push(quote(folder) + " in parents");
			if (state.words) clauses.push("title contains " + quote(state.words));
			if (state.foldersOnly) clauses.push("mimeType = " + quote(FOLDER));
			return clauses.join(" and ");
		}
		function run(query, token) {
			if (!account) return;
			var call = { account: account, query: query, pageSize: Number(args.pageSize) || 20 };
			if (token) call.pageToken = token;
			state.notice = "Loading…";
			App.redraw();
			App.call("search_files", call).then(function (result) {
				state.notice = result.error || "";
				if (result.data) {
					var files = Array.isArray(result.data.files) ? result.data.files : [];
					state.files = token ? state.files.concat(files) : files;
					state.next = result.data.nextPageToken || "";
					state.query = query;
				}
				App.redraw();
			});
		}
		function enter(file) {
			if (!isId(file.id)) return;
			state.crumbs.push({ id: file.id, name: file.name || "Folder" });
			state.words = "";
			run(browseQuery(), "");
		}
		function jump(depth) {
			state.crumbs = state.crumbs.slice(0, depth);
			state.words = "";
			run(browseQuery(), "");
		}

		App.go(function () {
			var crumbs = el("div", "crumbs");
			var rootCrumb = button("Drive", "crumb", function () {
				jump(0);
			});
			rootCrumb.disabled = !account;
			crumbs.appendChild(rootCrumb);
			state.crumbs.forEach(function (crumb, index) {
				crumbs.appendChild(el("span", "muted", "›"));
				var node = button(crumb.name, "crumb", function () {
					jump(index + 1);
				});
				node.disabled = index === state.crumbs.length - 1;
				crumbs.appendChild(node);
			});
			var words = input("text", state.words);
			words.addEventListener("input", function () {
				state.words = words.value;
			});
			var onlyFolders = input("checkbox");
			onlyFolders.checked = state.foldersOnly;
			onlyFolders.addEventListener("change", function () {
				state.foldersOnly = onlyFolders.checked;
				run(browseQuery(), "");
			});
			var search = el(
				"div",
				"search",
				null,
				field(state.crumbs.length ? "Search in this folder" : "Search by name", words),
				button("Search", "btn", function () {
					state.words = words.value.trim();
					run(browseQuery(), "");
				}),
				field("Folders only", onlyFolders, true)
			);
			var rows = state.files.map(function (file) {
				var folder = file.mimeType === FOLDER;
				var row = button("", "item file-row", function () {
					if (folder) enter(file);
					else fileScreen(file, account, "search_files");
				});
				row.appendChild(typeBadge(file));
				row.appendChild(el("span", "grow clip", file.name || "Untitled"));
				row.appendChild(el("span", "muted", formatDate(file.modifiedTime)));
				if (account) row.appendChild(accountChip(account));
				return row;
			});
			if (!state.files.length) rows.push(el("p", "note", "No files found."));
			App.draw({
				tool: "search_files",
				account: account,
				line: "query: " + clip(state.query, 120),
				body: [crumbs, account ? search : null].concat(rows),
				actions: [
					state.next
						? button("Load more", "btn", function () {
								run(state.query, state.next);
							})
						: null,
				],
				note: (state.notice ? state.notice + " " : "") + "File names render as plain text.",
			});
		});
	});

	App.view("list_recent_files", function (parsed, args, account) {
		var state = { files: Array.isArray(parsed.data.files) ? parsed.data.files.slice() : [], next: parsed.data.nextPageToken || "", notice: "" };
		function loadMore() {
			var more = copy(args);
			more.pageToken = state.next;
			state.notice = "Loading more…";
			App.redraw();
			App.call("list_recent_files", more).then(function (result) {
				state.notice = result.error || "";
				if (result.data) {
					state.files = state.files.concat(Array.isArray(result.data.files) ? result.data.files : []);
					state.next = result.data.nextPageToken || "";
				}
				App.redraw();
			});
		}
		App.go(function () {
			var grid = el("div", "grid3");
			state.files.forEach(function (file) {
				var tile = button("", "file-tile", function () {
					fileScreen(file, account, "list_recent_files");
				});
				tile.appendChild(typeBadge(file, "tile-block"));
				tile.appendChild(
					el("span", "tile-text", null, el("span", "strong clip", file.name || "Untitled"), el("span", "muted", formatDate(file.modifiedTime)), account ? accountChip(account) : null)
				);
				grid.appendChild(tile);
			});
			App.draw({
				tool: "list_recent_files",
				account: account,
				line: App.argsLine(args),
				body: [state.files.length ? grid : el("p", "note", "No recent files.")],
				actions: [state.next && account ? button("Load more", "btn", loadMore) : null],
				note: (state.notice ? state.notice + " " : "") + "Tiles show the file type only. No thumbnail is loaded.",
			});
		});
	});

	var ROLE_GROUPS = [
		["Owner", ["owner"]],
		["Editors", ["writer", "organizer", "fileOrganizer"]],
		["Commenters", ["commenter"]],
		["Viewers", ["reader"]],
	];
	var ROLE_WORDS = { owner: "own", writer: "edit", organizer: "manage", fileOrganizer: "manage", commenter: "comment on", reader: "view" };
	function roleWord(role) {
		return Object.prototype.hasOwnProperty.call(ROLE_WORDS, role) ? ROLE_WORDS[role] : "open";
	}

	/** Who can open a file. Also the receipt for share_file. */
	function permissionsScreen(tool, data, args, account, banner) {
		var all = Array.isArray(data.permissions) ? data.permissions : [];
		App.go(function () {
			var body = [banner ? el("div", "banner banner-ok", banner) : null];
			all.forEach(function (permission) {
				if (permission.type === "anyone") {
					body.push(el("div", "banner", "Anyone with the link can " + roleWord(permission.role) + " this file. This was set outside GoBridge."));
				} else if (permission.type === "domain") {
					body.push(el("div", "banner", "Everyone at " + (permission.domain || "a whole organisation") + " can " + roleWord(permission.role) + " this file. This was set outside GoBridge."));
				}
			});
			function person(permission, showRole) {
				return el(
					"div",
					"person",
					null,
					el("span", "grow clip", (permission.displayName ? permission.displayName + " · " : "") + (permission.emailAddress || "Unknown")),
					showRole ? el("span", "tag", "Can " + roleWord(permission.role)) : null
				);
			}
			ROLE_GROUPS.forEach(function (group) {
				var people = all.filter(function (permission) {
					return permission.type === "user" && group[1].indexOf(permission.role) !== -1;
				});
				if (!people.length) return;
				body.push(el("div", "group", group[0]));
				people.forEach(function (permission) {
					body.push(person(permission, false));
				});
			});
			var groups = all.filter(function (permission) {
				return permission.type === "group";
			});
			if (groups.length) {
				body.push(el("div", "group", "Groups"));
				groups.forEach(function (permission) {
					body.push(person(permission, true));
				});
			}
			if (!all.length) body.push(el("p", "note", "No sharing information is available for this file."));
			App.draw({
				tool: tool,
				account: account,
				line: App.argsLine(args),
				body: body,
				actions: [shareButton(data.fileId || args.fileId, account)],
				note: "Names and addresses render as plain text. GoBridge can share with one person or group, never with anyone or a whole domain.",
			});
		});
	}
	App.view("get_file_permissions", function (parsed, args, account) {
		permissionsScreen("get_file_permissions", parsed.data, args, account, "");
	});

	var ACTIONS = {
		create: "Created",
		edit: "Edited",
		rename: "Renamed",
		move: "Moved",
		comment: "Commented on",
		permissionChange: "Changed sharing of",
		delete: "Deleted",
		restore: "Restored",
		dlpChange: "Changed a data rule on",
		reference: "Referenced",
		settingsChange: "Changed settings of",
		appliedLabelChange: "Changed a label on",
	};
	function actorName(actor) {
		if (actor === "you") return "You";
		if (/^person:/.test(String(actor))) return "Someone else";
		if (actor === "anonymous") return "Someone not signed in";
		if (actor === "administrator") return "An administrator";
		if (actor === "system") return "Google Drive";
		return "Unknown";
	}
	function activityLine(activity) {
		var action = activity.primaryAction || {};
		var verb = Object.prototype.hasOwnProperty.call(ACTIONS, action.type) ? ACTIONS[action.type] : "Changed";
		var target = Array.isArray(activity.targets) && activity.targets[0] ? activity.targets[0] : {};
		var title = target.title || (target.parent && target.parent.title) || "a file";
		var actors = (Array.isArray(activity.actors) ? activity.actors : []).map(actorName);
		var who = actors.length ? actors.filter(function (name, index) { return actors.indexOf(name) === index; }).join(", ") : "Unknown";
		var detail = "";
		var extra = action.detail || {};
		if (action.type === "rename") detail = (extra.oldTitle || "?") + " → " + (extra.newTitle || "?");
		if (action.type === "permissionChange") {
			var added = Array.isArray(extra.addedPermissions) ? extra.addedPermissions : [];
			var removed = Array.isArray(extra.removedPermissions) ? extra.removedPermissions : [];
			detail = [
				added.length ? "Added: " + added.map(function (p) { return roleWord(p.role) + " (" + (p.type === "anyone" ? "anyone" : p.type === "domain" ? "a domain" : p.type === "group" ? "a group" : "a person") + ")"; }).join(", ") : "",
				removed.length ? "Removed: " + plural(removed.length, "permission") : "",
			].filter(Boolean).join(" · ");
		}
		return { who: who, what: verb + " " + title, detail: detail };
	}

	App.view("query_drive_activity", function (parsed, args, account) {
		var state = { items: Array.isArray(parsed.data.activities) ? parsed.data.activities.slice() : [], next: parsed.data.nextPageToken || "", notice: "" };
		function loadMore() {
			var more = copy(args);
			more.pageToken = state.next;
			state.notice = "Loading more…";
			App.redraw();
			App.call("query_drive_activity", more).then(function (result) {
				state.notice = result.error || "";
				if (result.data) {
					state.items = state.items.concat(Array.isArray(result.data.activities) ? result.data.activities : []);
					state.next = result.data.nextPageToken || "";
				}
				App.redraw();
			});
		}
		App.go(function () {
			var steps = el("div", "steps");
			state.items.forEach(function (activity) {
				var line = activityLine(activity);
				var when = typeof activity.time === "string" ? activity.time : activity.time && (activity.time.end || activity.time.start);
				steps.appendChild(
					el(
						"div",
						"step",
						null,
						el("span", "dot"),
						el("div", "strong", line.what),
						el("div", "muted", line.who + " · " + formatDate(when)),
						line.detail ? el("div", "muted", line.detail) : null
					)
				);
			});
			App.draw({
				tool: "query_drive_activity",
				account: account,
				line: App.argsLine(args),
				body: [state.items.length ? steps : el("p", "note", "No activity found.")],
				actions: [state.next && account ? button("Load more", "btn", loadMore) : null],
				note: (state.notice ? state.notice + " " : "") + "Titles render as plain text. Other people are not named.",
			});
		});
	});

	var SHARE_ROLES = [["reader", "Viewer"], ["commenter", "Commenter"], ["writer", "Editor"]];
	function roleName(role) {
		for (var i = 0; i < SHARE_ROLES.length; i++) {
			if (SHARE_ROLES[i][0] === role) return SHARE_ROLES[i][1];
		}
		return "Viewer";
	}

	/** The button under a file's sharing list: opens the share form. */
	function shareButton(fileId, account) {
		if (!WRITES || !account || !isId(fileId)) return null;
		return button("Share with someone", "btn btn-primary", function () {
			shareScreen(fileId, account);
		});
	}

	function shareScreen(fileId, account) {
		var who = input("email", "");
		var role = "reader";
		var status = el("div", "muted");
		var count = el("div", "muted", "Checking today's share count…");
		// Asked for when the form opens, which only happens on the user's click.
		App.status(account).then(function (result) {
			var text = result.data && App.usageText(result.data, "share");
			count.textContent = text ? "Shares today: " + text.replace(" shares today", "") : "Today's share count is not available.";
		});
		var radios = [];
		function option(value, labelText, allowed) {
			var radio = input("radio");
			radio.checked = allowed && value === role;
			radio.disabled = !allowed;
			radio.addEventListener("change", function () {
				role = value;
				radios.forEach(function (other) {
					other.checked = other === radio;
				});
			});
			if (allowed) radios.push(radio);
			return field(labelText, radio, true);
		}
		App.go(function () {
			var choices = el("div", "stack", null, el("span", "field-label", "Access"));
			SHARE_ROLES.forEach(function (entry) {
				choices.appendChild(option(entry[0], entry[1], true));
			});
			choices.appendChild(option("", "Anyone with the link (not allowed in GoBridge)", false));
			choices.appendChild(option("", "Everyone at a domain (not allowed in GoBridge)", false));
			App.draw({
				tool: "share_file",
				account: account,
				line: "",
				body: [el("div", "form", null, field("Person or group (email address)", who), choices, el("div", "muted", "Google emails the person to tell them. This cannot be switched off here."), count, status)],
				actions: [
					button("Share", "btn btn-primary", function () {
						var emails = emailsIn(who.value);
						if (emails.length !== 1) {
							status.textContent = "Enter one email address.";
							return;
						}
						status.textContent = "";
						App.confirm({
							account: account,
							action: "Share this file as " + roleName(role) + " (Google emails them)",
							target: emails[0],
							label: "Share",
							twoClick: true,
							usage: "share",
							note: "Counts against the 10 shares allowed per account each day.",
							run: function () {
								return App.call("share_file", { account: account, fileId: fileId, emailAddress: emails[0], role: role });
							},
							done: function (shared) {
								App.replace("share_file", { data: shared }, { account: account, fileId: fileId });
							},
						});
					}),
				],
				note: "One person or group at a time. Never anyone with the link, never a whole domain.",
			});
		});
	}

	App.view("share_file", function (parsed, args, account) {
		var data = parsed.data;
		var fileId = data.fileId || args.fileId;
		App.go(function () {
			App.draw({
				tool: "share_file",
				account: account,
				line: "",
				body: [
					el("div", "banner banner-ok", data.shared === true ? "Shared. Google emailed the recipient." : "This call did not report a share."),
					el("div", "pad pairs", null, pair("Account", account || "this account"), pair("Shared with", data.emailAddress || "the recipient"), pair("Access", roleName(data.role)), pair("Kind", data.type === "group" ? "Group" : "Person")),
				],
				actions: [
					account && isId(fileId)
						? button("See who has access", "btn", function () {
								App.open("get_file_permissions", { account: account, fileId: fileId });
							})
						: null,
				],
				note: "Counts as one of the 10 shares allowed per account each day.",
			});
		});
	});

	App.start("GoBridge Drive", function (data) {
		if (Array.isArray(data.permissions)) return "get_file_permissions";
		if (data.shared === true) return "share_file";
		if (Array.isArray(data.activities)) return "query_drive_activity";
		if (Array.isArray(data.files)) return "search_files";
		return "";
	});
})();
`;
