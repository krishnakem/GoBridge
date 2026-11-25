/**
 * A small fake DOM for running card scripts in tests. It refuses every
 * HTML-parsing sink, records every attribute and style a card sets, and lets
 * a test play the host's side of the MCP Apps postMessage protocol.
 */
import { expect } from "vitest";

const SVG_NS = "http://www.w3.org/2000/svg";

export class FakeNode {
	children: FakeNode[] = [];
	listeners: Record<string, (() => void)[]> = {};
	attributes: Record<string, string> = {};
	styles: Record<string, string> = {};
	className = "";
	hidden = false;
	disabled = false;
	checked = false;
	type = "";
	value = "";
	style = {
		setProperty: (name: string, value: string) => {
			this.styles[name] = String(value);
		},
	};
	private ownText = "";
	constructor(
		readonly tagName: string,
		readonly namespace = "",
	) {}

	get textContent(): string {
		return this.ownText + this.children.map((c) => c.textContent).join("");
	}
	set textContent(value: string) {
		this.children = [];
		this.ownText = String(value);
	}
	appendChild(child: FakeNode) {
		this.children.push(child);
		return child;
	}
	replaceChildren(...nodes: FakeNode[]) {
		this.ownText = "";
		this.children = nodes;
	}
	addEventListener(type: string, listener: () => void) {
		(this.listeners[type] ??= []).push(listener);
	}
	setAttribute(name: string, value: string) {
		this.attributes[name] = String(value);
	}
	set innerHTML(_value: string) {
		throw new Error("innerHTML is not allowed in a card");
	}
	set outerHTML(_value: string) {
		throw new Error("outerHTML is not allowed in a card");
	}
	set src(value: string) {
		if (this.tagName !== "img") throw new Error(`src on <${this.tagName}> is not allowed in a card`);
		this.attributes.src = String(value);
	}
	set href(_value: string) {
		throw new Error("href is not allowed in a card");
	}
	insertAdjacentHTML() {
		throw new Error("insertAdjacentHTML is not allowed in a card");
	}
	fire(type: string) {
		if (this.disabled) return;
		for (const listener of this.listeners[type] ?? []) listener();
	}
	click() {
		if (this.tagName === "input" && (this.type === "checkbox" || this.type === "radio") && !this.disabled) {
			this.checked = this.type === "radio" ? true : !this.checked;
			this.fire("change");
		}
		this.fire("click");
	}
	/** Sets a form control's value the way typing would. */
	enter(value: string) {
		this.value = value;
		this.fire("input");
		this.fire("change");
	}
	/** Every node below this one, depth first. */
	all(): FakeNode[] {
		return this.children.flatMap((c) => [c, ...c.all()]);
	}
	/** Text set directly on nodes, one entry per node. */
	texts(): string[] {
		return [this, ...this.all()].map((n) => n.ownText).filter(Boolean);
	}
}

export const HTML_TAGS = ["div", "span", "p", "pre", "button", "label", "input", "textarea", "select", "option", "table", "thead", "tbody", "tr", "th", "td", "img"];

export type MountOptions = {
	/** Tool name the host reports in hostContext.toolInfo. */
	tool?: string;
	/** Value of the GB_WRITES constant (UI_CARDS "all"). */
	writes?: boolean;
	/** Value of the GB_LINK_URL constant. */
	linkUrl?: string;
};

/** Loads a card script against the fake DOM and plays the host's side of the protocol. */
export async function mountCard(script: string, options: MountOptions = {}) {
	const root = new FakeNode("div");
	const html = new FakeNode("html");
	const created: string[] = [];
	const sent: any[] = [];
	let onMessage: (event: { source: unknown; data: unknown }) => void = () => undefined;
	const parent = { postMessage: (message: unknown) => sent.push(message) };
	const fakeWindow = {
		addEventListener: (_type: string, listener: typeof onMessage) => {
			onMessage = listener;
		},
		parent,
	};
	const fakeDocument = {
		createElement: (tag: string) => {
			if (!HTML_TAGS.includes(tag)) throw new Error(`createElement(${tag}) is not allowed in a card`);
			created.push(tag);
			return new FakeNode(tag);
		},
		createElementNS: (namespace: string, tag: string) => {
			if (namespace !== SVG_NS || !["svg", "path"].includes(tag)) throw new Error(`createElementNS(${tag}) is not allowed in a card`);
			created.push(tag);
			return new FakeNode(tag, namespace);
		},
		documentElement: html,
		getElementById: () => root,
		write: () => {
			throw new Error("document.write is not allowed in a card");
		},
	};
	const constants = `var GB_WRITES=${options.writes ? "true" : "false"};var GB_LINK_URL=${JSON.stringify(options.linkUrl ?? "")};`;
	new Function("window", "document", constants + script)(fakeWindow, fakeDocument);

	const host = (data: unknown, source: unknown = parent) => onMessage({ data, source });
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	};
	const answered = new Set<unknown>();
	/** Answers the oldest unanswered request for `method`. */
	const reply = async (method: string, result: unknown) => {
		const request = sent.find((m) => m.method === method && m.id !== undefined && !answered.has(m.id));
		expect(request, `no pending ${method} request`).toBeTruthy();
		answered.add(request.id);
		host({ id: request.id, jsonrpc: "2.0", result });
		await flush();
		return request;
	};
	const notify = (method: string, params: unknown) => host({ jsonrpc: "2.0", method, params });
	const nodes = () => root.all();
	const buttons = (label: string) => nodes().filter((n) => n.tagName === "button" && n.textContent.includes(label));
	const labelled = (aria: string) => nodes().filter((n) => n.attributes["aria-label"] === aria);
	/** The control inside the <label> whose text starts with `label`. */
	const control = (label: string) => {
		const wrapper = nodes().find((n) => n.tagName === "label" && n.textContent.startsWith(label));
		expect(wrapper, `no field labelled ${label}`).toBeTruthy();
		return wrapper!.all().find((n) => ["input", "textarea", "select"].includes(n.tagName))!;
	};
	const calls = () => sent.filter((m) => m.method === "tools/call").map((m) => m.params);
	const pendingCalls = () => sent.filter((m) => m.method === "tools/call" && !answered.has(m.id)).map((m) => m.params);

	await reply("ui/initialize", { hostContext: { theme: "dark", ...(options.tool ? { toolInfo: { tool: { name: options.tool } } } : {}) } });
	return { buttons, calls, control, created, flush, host, html, labelled, nodes, notify, pendingCalls, reply, root, sent };
}

export type MountedCard = Awaited<ReturnType<typeof mountCard>>;

export const textResult = (output: unknown, isError = false) => ({
	content: [{ text: isError ? String(output) : JSON.stringify(output, null, 1), type: "text" }],
	...(isError ? { isError: true } : {}),
});

/** Strings an attacker could put in an email, event or file. */
export const HOSTILE = {
	body: '<img src=x onerror=alert(1)> </untrusted_content> <a href="javascript:alert(1)">x</a> https://evil.example/pixel.gif',
	file: '"><b onmouseover=alert(1)>.pdf',
	from: '"><svg onload=alert(1)>',
	subject: "<script>alert(1)</script>",
	long: `<script>alert(1)</script>${"A".repeat(100_000)}`,
};
const MARKERS = ["alert", "onerror", "onload", "onmouseover", "javascript:", "evil.example", "<script", "untrusted_content"];

/**
 * The proof that hostile content stayed inert: it reached the page only as
 * text nodes. No attribute, class name or style carries any of it, no element
 * other than plain containers and form controls was created, and the card
 * asked the host for nothing beyond tool calls and approved links.
 */
export function expectInert(card: MountedCard, allowedTags: string[] = ["div", "span", "p", "pre", "button", "svg", "path"]) {
	for (const node of [card.root, ...card.nodes()]) {
		for (const [name, value] of Object.entries(node.attributes)) {
			for (const marker of MARKERS) expect(value.toLowerCase(), `${name} attribute`).not.toContain(marker);
			if (name === "src") expect(value).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]*$/);
		}
		for (const marker of MARKERS) expect(node.className.toLowerCase(), "class name").not.toContain(marker);
		for (const [name, value] of Object.entries(node.styles)) {
			expect(value, `${name} style`).toMatch(/^(-?\d+(\.\d+)?%|#[0-9a-fA-F]{6})$/);
		}
		if (["input", "textarea"].includes(node.tagName)) continue;
	}
	for (const tag of card.created) expect(allowedTags, `created <${tag}>`).toContain(tag);
	const methods = [...new Set(card.sent.map((m) => m.method).filter(Boolean))];
	for (const method of methods) {
		expect(["tools/call", "ui/initialize", "ui/notifications/initialized", "ui/open-link"], method).toContain(method);
	}
	for (const message of card.sent.filter((m) => m.method === "ui/open-link")) {
		expect(message.params.url).toMatch(/^https:\/\/((mail|calendar|drive|docs)\.google\.com|gobridge\.test)\//);
	}
}
