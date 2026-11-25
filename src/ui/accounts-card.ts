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
	function linkHost() {
		try {
			return [new URL(LINK_URL).hostname];
		} catch (e) {
			return [];
		}
	}

	App.view("list_accounts", function (parsed, args) {
		var accounts = Array.isArray(parsed.data.accounts) ? parsed.data.accounts : [];
		var state = { status: {}, notice: "" };
		App.go(function () {
			var body = accounts.map(function (entry) {
				var alias = typeof entry.alias === "string" ? entry.alias : "";
				return el("div", "account", null, el("div", "row", null, accountChip(alias), el("span", "grow clip", entry.email || "")));
			});
			if (!accounts.length) body.push(el("p", "note", "No Google account is linked yet."));
			App.draw({
				tool: "list_accounts",
				account: "",
				line: plural(accounts.length, "linked account"),
				body: body,
				actions: [linkButton("Manage accounts", LINK_URL, linkHost(), "btn btn-primary")],
				note: state.notice || "Linking and re-linking happen on GoBridge's own page, in your browser.",
			});
		});
	});

	App.start("GoBridge accounts", function (data) {
		return Array.isArray(data.accounts) ? "list_accounts" : "";
	});
})();
`;
