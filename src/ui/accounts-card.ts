/**
 * Accounts card (ui://gobridge/accounts.html): the linked accounts from
 * list_accounts. The one link opens GoBridge's own /link page through the
 * host's ui/open-link; its URL is a constant built from BASE_URL when the
 * card is served (GB_LINK_URL), never something from a tool result.
 */

export const ACCOUNTS_CSS = String.raw`
.account { display: flex; flex-direction: column; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.services { display: flex; flex-wrap: wrap; gap: 6px; }
`;

export const ACCOUNTS_JS = String.raw`
(function () {
	var LINK_URL = typeof GB_LINK_URL === "string" ? GB_LINK_URL : "";
	var SERVICES = [["gmail", "Gmail"], ["calendar", "Calendar"], ["drive", "Drive"], ["driveActivity", "Drive Activity"]];
	function linkHost() {
		try {
			return [new URL(LINK_URL).hostname];
		} catch (e) {
			return [];
		}
	}

	App.view("list_accounts", function (parsed, args) {
		var accounts = Array.isArray(parsed.data.accounts) ? parsed.data.accounts : [];
		var state = { status: {}, notice: "", checked: false };
		/** One counted status call per account, in turn. Only on the user's click. */
		function checkAll() {
			var queue = accounts
				.map(function (entry) {
					return entry && entry.alias;
				})
				.filter(function (alias) {
					return typeof alias === "string" && /^[a-z0-9-]{1,32}$/.test(alias);
				});
			state.checked = true;
			state.notice = "Checking…";
			App.redraw();
			function next() {
				var alias = queue.shift();
				if (!alias) {
					state.notice = "";
					return App.redraw();
				}
				App.status(alias).then(function (result) {
					state.status[alias] = result;
					next();
				});
			}
			next();
		}
		App.go(function () {
			var body = accounts.map(function (entry) {
				var alias = typeof entry.alias === "string" ? entry.alias : "";
				var node = el("div", "account", null, el("div", "row", null, accountChip(alias), el("span", "grow clip", entry.email || "")));
				var known = Object.prototype.hasOwnProperty.call(state.status, alias) ? state.status[alias] : null;
				if (known && known.error) node.appendChild(el("div", "muted", known.error));
				if (known && known.data) {
					var services = known.data.services || {};
					var row = el("div", "services");
					SERVICES.forEach(function (service) {
						var on = services[service[0]] === true;
						row.appendChild(el("span", on ? "tag good" : "tag tag-warn", service[1] + (on ? ": on" : ": re-link")));
					});
					node.appendChild(row);
					if (known.data.relinkNeeded === true) node.appendChild(el("div", "banner", "This account needs to be linked again before its tools work."));
					else if (services.driveActivity !== true) node.appendChild(el("div", "muted", "Re-link to turn on Drive Activity. Everything else works."));
				}
				return node;
			});
			if (!accounts.length) body.push(el("p", "note", "No Google account is linked yet."));
			App.draw({
				tool: "list_accounts",
				account: "",
				line: plural(accounts.length, "linked account"),
				body: body,
				actions: [
					accounts.length && !state.checked
						? button("Check services", "btn", function () {
								checkAll();
							})
						: null,
					linkButton("Manage accounts", LINK_URL, linkHost(), "btn btn-primary"),
				],
				note: state.notice || "Linking and re-linking happen on GoBridge's own page, in your browser.",
			});
		});
	});

	App.start("GoBridge accounts", function (data) {
		return Array.isArray(data.accounts) ? "list_accounts" : "";
	});
})();
`;
