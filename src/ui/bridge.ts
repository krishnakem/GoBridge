/**
 * Shared browser code for the in-chat cards (MCP Apps, spec 2026-01-26).
 *
 * These strings are inlined into each card's HTML (src/ui/resources.ts) and run
 * inside the host's sandboxed iframe. They implement the postMessage JSON-RPC
 * protocol directly, so no SDK is bundled and nothing is loaded from outside.
 *
 * DOM safety rule for every card: nodes are built with createElement and
 * textContent only. Nothing here or in a card may use innerHTML, outerHTML,
 * insertAdjacentHTML, document.write or eval. Attributes are set only from
 * constants in this file (icon paths, aria labels, input types), never from
 * tool results. test/ui.test.ts scans the card source for those sinks and
 * checks that hostile content never reaches an attribute.
 */

/** Protocol version sent in ui/initialize. */
export const APPS_PROTOCOL_VERSION = "2026-01-26";

/** JSON-RPC bridge to the host. Defines the global `GB`. */
export const BRIDGE_JS = String.raw`
var GB = (function () {
	var host = window.parent;
	var nextId = 1;
	var pending = {};
	var handlers = {};
	var lastHeight = 0;
	var info = { tool: "" };

	function post(message) {
		// The host's origin is not known to the card; the sandbox only lets this
		// frame talk to its parent, and replies are accepted from the parent only.
		host.postMessage(message, "*");
	}
	function request(method, params) {
		return new Promise(function (resolve, reject) {
			var id = nextId++;
			pending[id] = { resolve: resolve, reject: reject };
			post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
		});
	}
	function notify(method, params) {
		post({ jsonrpc: "2.0", method: method, params: params || {} });
	}
	function on(method, handler) {
		handlers[method] = handler;
	}

	function applyContext(context) {
		if (!context || typeof context !== "object") return;
		// The host's theme, colours and fonts are deliberately ignored: every card
		// is white with black text in the system font, in light and dark hosts alike.
		var tool = context.toolInfo && context.toolInfo.tool;
		if (tool && typeof tool.name === "string" && /^[a-z_]{1,64}$/.test(tool.name)) info.tool = tool.name;
	}

	function reportSize() {
		var box = document.documentElement.getBoundingClientRect();
		var height = Math.ceil(box.height);
		if (height === lastHeight) return;
		lastHeight = height;
		notify("ui/notifications/size-changed", { height: height, width: Math.ceil(box.width) });
	}

	window.addEventListener("message", function (event) {
		if (event.source !== host) return;
		var message = event.data;
		if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
		if (typeof message.method === "string") {
			var isRequest = message.id !== undefined && message.id !== null;
			if (isRequest) {
				if (message.method === "ui/resource-teardown" || message.method === "ping") {
					post({ jsonrpc: "2.0", id: message.id, result: {} });
				} else {
					post({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
				}
				return;
			}
			if (message.method === "ui/notifications/host-context-changed") applyContext(message.params);
			var handler = handlers[message.method];
			if (handler) handler(message.params || {});
			return;
		}
		if (!Object.prototype.hasOwnProperty.call(pending, message.id)) return;
		var waiting = pending[message.id];
		delete pending[message.id];
		if (message.error) waiting.reject(new Error("host_error"));
		else waiting.resolve(message.result || {});
	});

	function connect(name) {
		var app = { name: name, version: "1" };
		return request("ui/initialize", {
			protocolVersion: "${APPS_PROTOCOL_VERSION}",
			appInfo: app,
			clientInfo: app,
			appCapabilities: {},
			capabilities: {},
		}).then(function (result) {
			applyContext(result.hostContext);
			notify("ui/notifications/initialized", {});
			if (typeof ResizeObserver === "function") {
				new ResizeObserver(reportSize).observe(document.documentElement);
				reportSize();
			}
			return result;
		});
	}

	return {
		connect: connect,
		on: on,
		info: info,
		callTool: function (name, args) {
			return request("tools/call", { name: name, arguments: args });
		},
		openLink: function (url) {
			return request("ui/open-link", { url: url });
		},
	};
})();
`.replace("${APPS_PROTOCOL_VERSION}", APPS_PROTOCOL_VERSION);

/** DOM and data helpers shared by every card. */
export const HELPERS_JS = String.raw`
var SVG_NS = "http://www.w3.org/2000/svg";
/** Fixed icon outlines. Nothing from a tool result ever reaches an SVG. */
var ICON_PATHS = {
	left: "M15 5l-7 7 7 7",
	right: "M9 5l7 7-7 7",
	close: "M6 6l12 12M18 6L6 18",
	edit: "M4 20h4L19 9l-4-4L4 16v4z",
	trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
};
function icon(name) {
	var svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("class", "icon");
	svg.setAttribute("aria-hidden", "true");
	var path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", ICON_PATHS[name]);
	svg.appendChild(path);
	return svg;
}

/** Builds one element. Text always goes through textContent. */
function el(tag, className, text) {
	var node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined && text !== null && text !== "") node.textContent = String(text);
	for (var i = 3; i < arguments.length; i++) {
		if (arguments[i]) node.appendChild(arguments[i]);
	}
	return node;
}
function button(label, className, onClick) {
	var node = el("button", className, label);
	node.type = "button";
	node.addEventListener("click", onClick);
	return node;
}
/** An icon-only button. The label is a constant from the card's own code. */
function iconButton(name, label, onClick) {
	var node = button("", "btn btn-icon", onClick);
	node.setAttribute("aria-label", label);
	node.appendChild(icon(name));
	return node;
}
function input(type, value) {
	var node = document.createElement("input");
	node.type = type;
	if (type === "checkbox" || type === "radio") {
		node.className = "tick";
	} else {
		node.className = "input";
		node.value = value === undefined || value === null ? "" : String(value);
	}
	return node;
}
function textarea(value) {
	var node = document.createElement("textarea");
	node.className = "input area";
	node.value = value === undefined || value === null ? "" : String(value);
	return node;
}
/** options: [[value, label], ...], all constants from the card's own code. */
function select(options, value) {
	var node = document.createElement("select");
	node.className = "input";
	options.forEach(function (pair) {
		var option = document.createElement("option");
		option.value = pair[0];
		option.textContent = pair[1];
		node.appendChild(option);
	});
	node.value = value;
	return node;
}
/** A real <label> around a control; the label text is a text node. */
function field(labelText, control, inline) {
	return inline
		? el("label", "field field-inline", null, control, el("span", "field-label", labelText))
		: el("label", "field", null, el("span", "field-label", labelText), control);
}
function pair(name, value) {
	return el("div", "pair", null, el("span", "pair-name", name), el("span", "pair-value", value));
}
/**
 * Long free text (a message body, a description, speaker notes) cut to a few
 * lines with an ellipsis. Selecting it shows the whole text; selecting it again
 * shortens it. lines is 1, 2 or 3.
 */
function moreText(text, lines) {
	var node = button("", "more", function () {
		if (node.className === "more") {
			node.className = "more more-open";
			node.setAttribute("aria-expanded", "true");
		} else {
			node.className = "more";
			node.setAttribute("aria-expanded", "false");
		}
	});
	node.setAttribute("aria-expanded", "false");
	node.appendChild(el("span", "more-text clamp-" + (lines === 1 || lines === 3 ? lines : 2), text));
	return node;
}
function plural(count, word) {
	return count + " " + word + (count === 1 ? "" : "s");
}

var CHIP_CLASSES = { michigan: "chip-indigo", gmail: "chip-teal", kemisetti: "chip-purple" };
function accountClass(alias) {
	return Object.prototype.hasOwnProperty.call(CHIP_CLASSES, alias) ? CHIP_CLASSES[alias] : "chip-other";
}
function accountChip(alias) {
	return el("span", "chip " + accountClass(alias), alias);
}

/** Removes GoBridge's untrusted_content wrapper from every string in a result. */
function unwrap(value, depth) {
	if (depth > 80) return value;
	if (typeof value === "string") {
		var match = /^<untrusted_content source="[a-z]+">([\s\S]*)<\/untrusted_content>$/.exec(value);
		return match ? match[1].replace(/&lt;(?=\s*\/?\s*untrusted_content)/gi, "<") : value;
	}
	if (Array.isArray(value)) {
		return value.map(function (item) {
			return unwrap(item, depth + 1);
		});
	}
	if (value && typeof value === "object") {
		var out = {};
		Object.keys(value).forEach(function (key) {
			out[key] = unwrap(value[key], depth + 1);
		});
		return out;
	}
	return value;
}

/** Reads a tool result: { data, image } for JSON output, { error } for anything else. */
function parseResult(result) {
	var text = "";
	var image = null;
	var content = result && result.content;
	if (Array.isArray(content)) {
		for (var i = 0; i < content.length; i++) {
			var part = content[i];
			if (!part) continue;
			if (!text && part.type === "text" && typeof part.text === "string") text = part.text;
			if (!image && part.type === "image" && typeof part.data === "string") image = part;
		}
	}
	if (result && result.isError) return { error: text || "The request failed." };
	try {
		var data = JSON.parse(text);
		if (!data || typeof data !== "object") throw new Error("not an object");
		return { data: unwrap(data, 0), image: image };
	} catch (e) {
		return { error: "This result cannot be shown as a card." };
	}
}

/** Returns the URL only when it is https on one of the given hosts, else "". */
function safeLink(url, hosts) {
	try {
		var parsed = new URL(String(url));
		return parsed.protocol === "https:" && hosts.indexOf(parsed.hostname) !== -1 ? parsed.href : "";
	} catch (e) {
		return "";
	}
}
/** A button that asks the host to open an allowed link, or null for any other URL. */
function linkButton(label, url, hosts, className) {
	var link = safeLink(url, hosts);
	if (!link) return null;
	return button(label, className || "btn", function () {
		GB.openLink(link).catch(function () {});
	});
}

function formatDate(value) {
	var time = Date.parse(String(value || ""));
	if (isNaN(time)) return String(value || "");
	return new Date(time).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
function formatSize(bytes) {
	var size = Number(bytes);
	if (!isFinite(size) || size <= 0) return "";
	if (size < 1024) return size + " B";
	if (size < 1048576) return Math.round(size / 1024) + " KB";
	return (size / 1048576).toFixed(1) + " MB";
}
function clip(value, max) {
	var text = String(value === undefined || value === null ? "" : value);
	return text.length > max ? text.slice(0, max) + "…" : text;
}
/** Email addresses found in free text such as "Ann <ann@example.com>, bob@example.com". */
function emailsIn(text) {
	var found = String(text || "").match(/[^\s<>,;:"'()]+@[^\s<>,;:"'()]+\.[^\s<>,;:"'()]+/g) || [];
	var seen = {};
	return found.filter(function (address) {
		var key = address.toLowerCase();
		if (seen[key]) return false;
		seen[key] = true;
		return true;
	});
}
`;

/**
 * The card frame: header strip, body, confirm slot, footer, and navigation
 * between views inside one card. Defines the global `App`.
 *
 * GB_WRITES is a constant set by src/ui/resources.ts: true only when UI_CARDS
 * is "all". When it is false no view shows a control that changes anything.
 */
export const APP_JS = String.raw`
var WRITES = typeof GB_WRITES !== "undefined" && GB_WRITES === true;
var LOGO = typeof GB_LOGO === "string" && /^data:image\/png;base64,[A-Za-z0-9+\/]+={0,2}$/.test(GB_LOGO) ? GB_LOGO : "";
var WRITE_TOOLS = {
	create_draft: 1, update_draft: 1, delete_draft: 1, send_message: 1, reply: 1, forward: 1,
	label_thread: 1, unlabel_thread: 1, trash_thread: 1, untrash_thread: 1,
	create_label: 1, update_label: 1, delete_label: 1,
	create_event: 1, update_event: 1, delete_event: 1, respond_to_event: 1,
	share_file: 1, update_doc: 1, append_values: 1,
};
/** Arguments never shown in the header line: long or content-bearing. */
var HIDDEN_ARGS = { account: 1, body: 1, htmlBody: 1, forwardText: 1, values: 1, requests: 1, attachments: 1, description: 1, pageToken: 1 };

var App = (function () {
	var root = document.getElementById("app");
	var views = {};
	var stack = [];
	var current = { tool: "", args: {}, account: "" };
	var live = { slot: null, foot: null };
	var busy = false;
	var sniff = null;

	function argsLine(args) {
		var parts = [];
		Object.keys(args || {}).forEach(function (key) {
			var value = args[key];
			if (HIDDEN_ARGS[key] || parts.length >= 4) return;
			if (Array.isArray(value)) value = value.length && typeof value[0] !== "object" ? value.join(", ") : plural(value.length, "item");
			else if (value && typeof value === "object") return;
			if (value === undefined || value === null || value === "") return;
			parts.push(key + ": " + clip(value, 60));
		});
		return parts.join(" · ");
	}

	/** The GoBridge logo and name. The logo is a constant data: URL (GB_LOGO), never anything from a result. */
	function brand() {
		var logo = null;
		if (LOGO) {
			logo = document.createElement("img");
			logo.className = "brand-logo";
			logo.alt = "";
			logo.src = LOGO;
		}
		return el("span", "brand", null, logo, el("span", "brand-name", "GoBridge"));
	}
	function header(screen) {
		var kind = WRITE_TOOLS[screen.tool] ? "write" : "read";
		var top = el(
			"div",
			"strip-top",
			null,
			brand(),
			el("span", "grow"),
			screen.account ? accountChip(screen.account) : null,
			el("span", "badge badge-" + kind, kind === "write" ? "Write" : "Read")
		);
		var sub = el("div", "strip-line", null, el("span", "tool", screen.tool || "gobridge"), screen.line ? el("span", "strip-args", screen.line) : null);
		return el("div", "strip", null, top, sub);
	}

	/** Draws one screen: { tool, account, line, body: [nodes], actions: [nodes], note }. */
	function draw(screen) {
		var body = el("div", "body");
		(screen.body || []).forEach(function (node) {
			if (node) body.appendChild(node);
		});
		var slot = el("div", "slot");
		slot.hidden = true;
		var foot = el("div", "foot");
		if (stack.length > 1) foot.appendChild(button("Back", "btn", back));
		(screen.actions || []).forEach(function (node) {
			if (node) foot.appendChild(node);
		});
		foot.hidden = foot.children.length === 0;
		live = { slot: slot, foot: foot };
		var note = screen.note ? el("div", "footnote", screen.note) : null;
		root.replaceChildren.apply(root, [header(screen), body, slot, foot, note].filter(Boolean));
	}
	function go(screenFn) {
		stack.push(screenFn);
		screenFn();
	}
	function redraw() {
		if (stack.length) stack[stack.length - 1]();
	}
	function back() {
		if (busy || stack.length < 2) return;
		stack.pop();
		redraw();
	}
	function message(tool, account, line, text) {
		go(function () {
			draw({ tool: tool, account: account, line: line, body: [el("p", "note", text)] });
		});
	}

	/** Calls a tool through the host. Never rejects: resolves to { data } or { error }. */
	function call(tool, args) {
		return GB.callTool(tool, args).then(parseResult, function () {
			return { error: "The request could not be completed." };
		});
	}
	/** Calls a read tool and shows its view on top of the current one. */
	function open(tool, args, replace) {
		if (busy) return Promise.resolve();
		busy = true;
		stack.push(function () {
			draw({ tool: tool, account: args.account, line: argsLine(args), body: [el("p", "note", "Loading…")] });
		});
		redraw();
		return call(tool, args).then(function (parsed) {
			busy = false;
			stack.pop();
			if (replace) stack.pop();
			show(tool, parsed, args);
		});
	}
	function show(tool, parsed, args) {
		var account = typeof args.account === "string" ? args.account : "";
		if (parsed.error) return message(tool, account, argsLine(args), parsed.error);
		var view = views[tool];
		if (!view) return message(tool, account, argsLine(args), "This result cannot be shown as a card.");
		view(parsed, args, account);
	}

	/** get_card_status for one account: numbers and true/false only. Asked for once, then kept until a write. */
	var statusCache = {};
	function cardStatus(account) {
		if (!statusCache[account]) statusCache[account] = call("get_card_status", { account: account });
		return statusCache[account];
	}
	var USAGE = {
		send: ["sendsToday", "sendsPerDay", "sends today"],
		share: ["sharesToday", "sharesPerDay", "shares today"],
		write: ["writesThisHour", "writesPerHour", "writes this hour"],
	};
	/** "3 of 25 sends today", or "" when the numbers are not there. */
	function usageText(data, kind) {
		var names = USAGE[kind];
		var used = Number(data && data.usage && data.usage[names[0]]);
		var limit = Number(data && data.limits && data.limits[names[1]]);
		return isFinite(used) && isFinite(limit) ? used + " of " + limit + " " + names[2] : "";
	}

	/**
	 * The confirm step every write goes through. It names the account, the
	 * action and the target, and runs nothing until the button is pressed.
	 * With twoClick the button must be pressed twice.
	 * With usage ("send", "share" or "write") it also shows the account's current count.
	 * opts: { account, action, target, label, twoClick, danger, note, extra, usage, run, done }
	 */
	function confirm(opts) {
		if (!WRITES || !live.slot) return;
		var slot = live.slot;
		var foot = live.foot;
		var armed = false;
		var working = false;
		var status = el("div", "muted");
		function close() {
			slot.hidden = true;
			slot.replaceChildren();
			foot.hidden = foot.children.length === 0;
		}
		var cancel = button("Cancel", "btn", function () {
			if (!working) close();
		});
		var proceed = button(opts.label, "btn " + (opts.danger ? "btn-danger" : "btn-primary"), function () {
			if (working) return;
			if (opts.twoClick && !armed) {
				armed = true;
				proceed.textContent = "Click again: " + opts.label;
				status.textContent = "Nothing has happened yet. Click again to go ahead.";
				return;
			}
			working = true;
			busy = true;
			proceed.disabled = true;
			cancel.disabled = true;
			status.textContent = "Working…";
			opts.run().then(function (result) {
				working = false;
				busy = false;
				if (result.error) {
					armed = false;
					proceed.disabled = false;
					cancel.disabled = false;
					proceed.textContent = opts.label;
					status.textContent = result.error;
					return;
				}
				delete statusCache[opts.account];
				close();
				opts.done(result.data);
			});
		});
		var rows = el("div", "pairs", null, pair("Account", opts.account), pair("Action", opts.action), pair("Target", opts.target));
		var count = null;
		if (opts.usage) {
			count = el("div", "muted", "Checking the current count…");
			cardStatus(opts.account).then(function (result) {
				count.textContent = (result.data && usageText(result.data, opts.usage)) || "The current count is not available.";
			});
		}
		slot.replaceChildren(
			el(
				"div",
				"confirm",
				null,
				el("div", "confirm-title", opts.twoClick ? "Confirm (two clicks)" : "Confirm"),
				rows,
				opts.extra || null,
				count,
				opts.note ? el("div", "footnote plain", opts.note) : null,
				el("div", "confirm-actions", null, cancel, proceed),
				status
			)
		);
		slot.hidden = false;
		foot.hidden = true;
	}

	function receive(result) {
		var parsed = parseResult(result);
		var tool = current.tool || GB.info.tool || (parsed.data && sniff ? sniff(parsed.data) : "");
		stack = [];
		busy = false;
		show(tool, parsed, current.args);
	}

	function start(name, sniffer) {
		sniff = sniffer || null;
		GB.on("ui/notifications/tool-input", function (params) {
			var args = params && params.arguments;
			current.args = args && typeof args === "object" ? args : {};
			current.account = typeof current.args.account === "string" ? current.args.account : "";
		});
		GB.on("ui/notifications/tool-result", receive);
		GB.on("ui/notifications/tool-cancelled", function () {
			stack = [];
			message(current.tool || GB.info.tool, current.account, "", "This request was cancelled.");
		});
		GB.connect(name).then(
			function () {
				current.tool = GB.info.tool;
			},
			function () {
				root.replaceChildren(el("p", "note", "This card could not connect to the app."));
			}
		);
	}

	return {
		view: function (tool, render) {
			views[tool] = render;
		},
		argsLine: argsLine,
		draw: draw,
		go: go,
		redraw: redraw,
		back: back,
		call: call,
		open: open,
		show: show,
		/** Shows a result in place of the current screen (a form that has done its job). */
		replace: function (tool, parsed, args) {
			stack.pop();
			show(tool, parsed, args);
		},
		replaceMessage: function (tool, account, text) {
			stack.pop();
			message(tool, account, "", text);
		},
		confirm: confirm,
		status: cardStatus,
		usageText: usageText,
		message: message,
		start: start,
		has: function (tool) {
			return typeof views[tool] === "function";
		},
		isBusy: function () {
			return busy;
		},
	};
})();
`;

/** Base styles: one card, the header strip, chips, badges, buttons, forms. Always light. */
export const BASE_CSS = String.raw`
:root {
	color-scheme: light only;
	/* The same palette as GoBridge's own pages (/static/app.css). */
	--bg: #ffffff;
	--bg-soft: #fafafa;
	--bg-hover: #f4f4f5;
	--fg: #18181b;
	--muted: #71717a;
	--badge-fg: #52525b;
	--line: #e4e4e7;
	--line-strong: #d4d4d8;
	--accent: #0284c7;
	--accent-hover: #0369a1;
	--accent-fg: #ffffff;
	--danger: #dc2626;
	--danger-hover: #b91c1c;
	--danger-fg: #ffffff;
	--sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
	--mono: ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
	color: var(--fg);
	font-family: var(--sans);
	font-size: 13px;
	line-height: 1.4;
	overflow-wrap: anywhere;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
}
.card {
	display: flex;
	flex-direction: column;
	background: var(--bg);
	color: var(--fg);
	border: 1px solid var(--line);
	border-radius: 12px;
	overflow: hidden;
}
.strip { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px 7px; border-bottom: 1px solid var(--line); background: var(--bg); }
.strip-top { display: flex; align-items: center; gap: 6px; min-height: 20px; }
.brand { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.brand-logo { display: block; width: 20px; height: 20px; border-radius: 5px; }
.brand-name { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; color: var(--fg); }
.strip-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; }
.strip-args { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.icon { width: 16px; height: 16px; display: block; }
.icon path { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.tool, .mono { font-family: var(--mono); font-size: 11px; }
.tool { flex: none; color: var(--muted); }
.badge, .chip, .tag {
	display: inline-block;
	border-radius: 999px;
	padding: 1px 7px;
	font-size: 11px;
	font-weight: 500;
	line-height: 16px;
	white-space: nowrap;
	color: var(--badge-fg);
	background: var(--bg-hover);
	border: 1px solid var(--bg-hover);
}
.badge-write { color: var(--fg); background: var(--bg); border-color: var(--line-strong); }
.chip { color: var(--fg); }
.body { display: flex; flex-direction: column; }
.pad { padding: 10px 12px; }
.title { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.strong { font-weight: 600; }
.muted { color: var(--muted); font-size: 12px; }
.note { color: var(--muted); font-size: 12px; padding: 12px; margin: 0; }
.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.nowrap { flex: none; white-space: nowrap; }
.text { margin: 0; white-space: pre-wrap; font: inherit; }
.stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.stack > * { min-width: 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.grow { flex: 1; min-width: 0; }
.item {
	all: unset;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	gap: 1px;
	width: calc(100% - 12px);
	min-width: 0;
	margin: 1px 6px;
	padding: 7px 8px;
	border-radius: 8px;
	cursor: pointer;
}
.item > * { min-width: 0; max-width: 100%; }
.body > .item:first-child, .body > .mail-row:first-child { margin-top: 6px; }
.item:hover { background: var(--bg-hover); }
.item:disabled { cursor: default; }
.item:disabled:hover { background: none; }
.line { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 12px; border-bottom: 1px solid var(--line); }
.line > * { min-width: 0; }
.foot, .confirm-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.foot { padding: 8px 12px; border-top: 1px solid var(--line); }
.foot[hidden], .slot[hidden] { display: none; }
.footnote { padding: 6px 12px 8px; color: var(--muted); font-size: 11px; }
.footnote.plain { padding: 0; }
.banner { margin: 8px 12px 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font-size: 12px; }
.banner-ok { font-weight: 600; }
.btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font: inherit;
	font-size: 12px;
	font-weight: 500;
	min-height: 28px;
	padding: 0 10px;
	border-radius: 8px;
	border: 1px solid var(--line);
	background: var(--bg);
	color: var(--fg);
	cursor: pointer;
	white-space: nowrap;
}
.btn:hover { background: var(--bg-soft); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-danger { background: var(--danger); border-color: var(--danger); color: var(--danger-fg); }
.btn-danger:hover { background: var(--danger-hover); border-color: var(--danger-hover); }
.btn-icon { min-width: 28px; padding: 0 6px; }
.btn:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, .input:focus-visible, .tick:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.more { all: unset; box-sizing: border-box; display: block; width: 100%; min-width: 0; cursor: pointer; border-radius: 4px; }
.more-text { display: block; white-space: pre-wrap; overflow: hidden; }
.more:not(.more-open) .more-text { display: -webkit-box; -webkit-box-orient: vertical; }
.more:not(.more-open) .clamp-1 { -webkit-line-clamp: 1; line-clamp: 1; white-space: normal; }
.more:not(.more-open) .clamp-2 { -webkit-line-clamp: 2; line-clamp: 2; }
.more:not(.more-open) .clamp-3 { -webkit-line-clamp: 3; line-clamp: 3; }
.field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.field-inline { flex-direction: row; align-items: center; gap: 6px; min-height: 28px; }
.field-label { font-weight: 500; color: var(--muted); }
.field-inline .field-label { font-weight: 400; color: var(--fg); }
.form { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; }
.input {
	font: inherit;
	font-size: 13px;
	min-height: 30px;
	width: 100%;
	padding: 4px 8px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--bg);
	color: var(--fg);
}
.area { min-height: 96px; resize: vertical; }
.tick { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); flex: none; }
.slot { border-top: 1px solid var(--line); }
.confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: var(--bg); }
.confirm-title { font-weight: 600; }
.pairs { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pair { display: flex; gap: 8px; font-size: 12px; min-width: 0; }
.pair-name { flex: none; width: 72px; color: var(--muted); }
.pair-value { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.confirm .pair-value { white-space: normal; overflow-wrap: anywhere; }
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 10px 12px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tile-value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bad, .good { color: var(--fg); }
`;
