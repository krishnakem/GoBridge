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
		var rootElement = document.documentElement;
		if (context.theme === "light" || context.theme === "dark") {
			rootElement.setAttribute("data-theme", context.theme);
		}
		// Only the host's fonts are taken over. Colours are the card's own, so the
		// contrast of every text and badge stays as designed in both themes.
		var variables = context.styles && context.styles.variables;
		if (variables && typeof variables === "object") {
			["--font-sans", "--font-mono"].forEach(function (name) {
				var value = variables[name];
				if (typeof value === "string" && value.length < 200 && /^[\w\s,"'.-]+$/.test(value)) {
					rootElement.style.setProperty(name, value);
				}
			});
		}
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
	mark: "M3 18h18M5 18v-5a7 7 0 0 1 14 0v5M9 18v-4M12 18v-6M15 18v-4",
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

	function header(screen) {
		var kind = WRITE_TOOLS[screen.tool] ? "write" : "read";
		var top = el(
			"div",
			"strip-top",
			null,
			el("span", "mark", null, icon("mark")),
			el("span", "tool", screen.tool || "gobridge"),
			el("span", "badge badge-" + kind, kind === "write" ? "Write" : "Read"),
			screen.account ? accountChip(screen.account) : null
		);
		return el("div", "strip", null, top, screen.line ? el("div", "strip-line", screen.line) : null);
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

	/**
	 * The confirm step every write goes through. It names the account, the
	 * action and the target, and runs nothing until the button is pressed.
	 * With twoClick the button must be pressed twice.
	 * opts: { account, action, target, label, twoClick, danger, note, extra, run, done }
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
				close();
				opts.done(result.data);
			});
		});
		var rows = el("div", "pairs", null, pair("Account", opts.account), pair("Action", opts.action), pair("Target", opts.target));
		slot.replaceChildren(
			el(
				"div",
				"confirm",
				null,
				el("div", "confirm-title", opts.twoClick ? "Confirm (two clicks)" : "Confirm"),
				rows,
				opts.extra || null,
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
		confirm: confirm,
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

/** Base styles: one card, the header strip, chips, badges, buttons, forms. */
export const BASE_CSS = String.raw`
:root {
	color-scheme: light;
	--bg: #ffffff;
	--bg-soft: #f3f4f6;
	--fg: #111827;
	--muted: #4b5563;
	--line: #e5e7eb;
	--accent: #1d4ed8;
	--accent-fg: #ffffff;
	--danger: #b91c1c;
	--danger-fg: #ffffff;
	--read-bg: #dcfce7;
	--read-fg: #166534;
	--write-bg: #fef3c7;
	--write-fg: #92400e;
	--warn-bg: #fef3c7;
	--warn-fg: #92400e;
	--indigo-bg: #e0e7ff;
	--indigo-fg: #3730a3;
	--teal-bg: #ccfbf1;
	--teal-fg: #115e59;
	--purple-bg: #f3e8ff;
	--purple-fg: #6b21a8;
	--other-bg: #f3f4f6;
	--other-fg: #374151;
	--bad: #b91c1c;
	--good: #166534;
}
:root[data-theme="dark"] {
	color-scheme: dark;
	--bg: #111827;
	--bg-soft: #1f2937;
	--fg: #f9fafb;
	--muted: #d1d5db;
	--line: #374151;
	--accent: #2563eb;
	--accent-fg: #ffffff;
	--danger: #b91c1c;
	--danger-fg: #ffffff;
	--read-bg: #14532d;
	--read-fg: #bbf7d0;
	--write-bg: #78350f;
	--write-fg: #fde68a;
	--warn-bg: #78350f;
	--warn-fg: #fde68a;
	--indigo-bg: #312e81;
	--indigo-fg: #c7d2fe;
	--teal-bg: #134e4a;
	--teal-fg: #99f6e4;
	--purple-bg: #581c87;
	--purple-fg: #e9d5ff;
	--other-bg: #374151;
	--other-fg: #e5e7eb;
	--bad: #fca5a5;
	--good: #86efac;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
	color: var(--fg);
	font-family: var(--font-sans, Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
	font-size: 14px;
	line-height: 1.45;
	overflow-wrap: anywhere;
}
.card {
	display: flex;
	flex-direction: column;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 14px;
	overflow: hidden;
}
.strip { padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--bg-soft); }
.strip-top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.strip-line { margin-top: 4px; color: var(--muted); font-size: 12px; }
.mark { display: inline-flex; color: var(--accent); }
:root[data-theme="dark"] .mark { color: #93c5fd; }
.icon { width: 18px; height: 18px; display: block; }
.icon path { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.tool, .mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 13px; }
.tool { font-weight: 600; }
.badge, .chip, .tag {
	display: inline-block;
	border-radius: 999px;
	padding: 2px 9px;
	font-size: 12px;
	font-weight: 600;
	white-space: nowrap;
}
.badge-read { background: var(--read-bg); color: var(--read-fg); }
.badge-write { background: var(--write-bg); color: var(--write-fg); }
.chip-indigo { background: var(--indigo-bg); color: var(--indigo-fg); }
.chip-teal { background: var(--teal-bg); color: var(--teal-fg); }
.chip-purple { background: var(--purple-bg); color: var(--purple-fg); }
.chip-other, .tag { background: var(--other-bg); color: var(--other-fg); }
.tag-warn { background: var(--warn-bg); color: var(--warn-fg); }
.body { display: flex; flex-direction: column; }
.pad { padding: 12px 16px; }
.title { font-size: 16px; font-weight: 600; }
.strong { font-weight: 600; }
.muted { color: var(--muted); font-size: 12px; }
.note { color: var(--muted); font-size: 13px; padding: 16px; margin: 0; }
.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.text { margin: 0; white-space: pre-wrap; font: inherit; }
.stack { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.grow { flex: 1; min-width: 0; }
.item {
	all: unset;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	gap: 2px;
	width: 100%;
	min-height: 36px;
	padding: 10px 16px;
	border-bottom: 1px solid var(--line);
	cursor: pointer;
}
.item:hover { background: var(--bg-soft); }
.item:disabled { cursor: default; }
.line { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.foot, .confirm-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.foot { padding: 12px 16px; border-top: 1px solid var(--line); }
.foot[hidden], .slot[hidden] { display: none; }
.footnote { padding: 8px 16px 12px; color: var(--muted); font-size: 12px; }
.footnote.plain { padding: 0; }
.banner { margin: 12px 16px 0; padding: 8px 12px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); font-size: 13px; }
.banner-ok { background: var(--read-bg); color: var(--read-fg); }
.btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	font: inherit;
	font-size: 13px;
	font-weight: 600;
	min-height: 36px;
	padding: 0 14px;
	border-radius: 8px;
	border: 1px solid var(--line);
	background: var(--bg);
	color: var(--fg);
	cursor: pointer;
}
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.btn-danger { background: var(--danger); border-color: var(--danger); color: var(--danger-fg); }
.btn-icon { min-width: 36px; padding: 0 8px; }
.btn:disabled { opacity: 0.55; cursor: default; }
button:focus-visible, .input:focus-visible, .tick:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.field-inline { flex-direction: row; align-items: center; gap: 8px; min-height: 36px; }
.field-label { font-weight: 600; }
.field-inline .field-label { font-weight: 400; }
.form { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
.input {
	font: inherit;
	min-height: 36px;
	width: 100%;
	padding: 6px 10px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--bg);
	color: var(--fg);
}
.area { min-height: 120px; resize: vertical; }
.tick { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); flex: none; }
.slot { border-top: 1px solid var(--line); }
.confirm { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; background: var(--bg-soft); }
.confirm-title { font-weight: 600; }
.pairs { display: flex; flex-direction: column; gap: 2px; }
.pair { display: flex; gap: 8px; font-size: 13px; }
.pair-name { flex: none; width: 76px; color: var(--muted); }
.pair-value { font-weight: 600; min-width: 0; }
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 12px 16px; }
.tile { border: 1px solid var(--line); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tile-value { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bad { color: var(--bad); }
.good { color: var(--good); }
`;
