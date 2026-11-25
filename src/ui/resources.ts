/**
 * In-chat cards (MCP Apps, spec 2026-01-26): the ui:// resources and the
 * UI_CARDS switch.
 *
 * Each card is one self-contained HTML document that is constant for a given
 * build, UI_CARDS value and BASE_URL. It never contains account data: data
 * reaches the card only as the tool result the host passes in by postMessage.
 * The cards are served through MCP resources/read on /mcp, so they sit behind
 * the same OAuth, owner and allowed-client checks as tools, and there is no
 * HTTP route for them.
 *
 * CSP: the resource declares no outside domains, so the host's default policy
 * applies (no network, inline script and style allowed). Each document also
 * carries its own stricter <meta> policy pinned to the hashes of its one script
 * and one style block, so an injected script or inline handler cannot run.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ACCOUNTS_CSS, ACCOUNTS_JS } from "./accounts-card";
import { APP_JS, BASE_CSS, BRIDGE_JS, HELPERS_JS } from "./bridge";
import { CALENDAR_CSS, CALENDAR_JS } from "./calendar-card";
import { MAIL_CSS, MAIL_JS } from "./mail-card";

export const UI_MIME_TYPE = "text/html;profile=mcp-app";

export type UiCard = "mail" | "calendar" | "accounts";
export type UiCardsMode = "off" | "read" | "all";

type CardSource = {
	title: string;
	description: string;
	css: string;
	js: string;
	/** The card's own img-src. 'none' everywhere except where an MCP image block is shown. */
	img: "'none'" | "data:";
	/** Gets GB_LINK_URL: GoBridge's own /link page, the only non-Google link a card may open. */
	linkUrl?: boolean;
};

const SHARED_JS = BRIDGE_JS + HELPERS_JS + APP_JS;

const CARDS: Record<UiCard, CardSource> = {
	mail: {
		css: BASE_CSS + MAIL_CSS,
		description: "Shows Gmail search results and conversations as plain text.",
		img: "'none'",
		js: SHARED_JS + MAIL_JS,
		title: "GoBridge mail",
	},
	calendar: {
		css: BASE_CSS + CALENDAR_CSS,
		description: "Shows calendar events as a day view, as plain text.",
		img: "'none'",
		js: SHARED_JS + CALENDAR_JS,
		title: "GoBridge calendar",
	},
	accounts: {
		css: BASE_CSS + ACCOUNTS_CSS,
		description: "Shows the linked Google accounts.",
		img: "'none'",
		js: SHARED_JS + ACCOUNTS_JS,
		linkUrl: true,
		title: "GoBridge accounts",
	},
};

export const UI_CARDS = Object.keys(CARDS) as UiCard[];
export const uiResourceUri = (card: UiCard) => `ui://gobridge/${card}.html`;

/**
 * UI_CARDS var: "read" enables the cards without any control that changes
 * something, "all" also enables those controls and the cards on write tools.
 * Anything else, including a missing value, means "off".
 */
export function uiCardsMode(env: Env): UiCardsMode {
	const value = (env as { UI_CARDS?: unknown }).UI_CARDS;
	return value === "read" || value === "all" ? value : "off";
}

/**
 * `_meta` for a tool that renders a card, or undefined when it gets none:
 * read tools when cards are on, write tools only when UI_CARDS is "all".
 */
export function toolUiMeta(env: Env, card: UiCard | undefined, kind: "read" | "write"): Record<string, unknown> | undefined {
	const mode = uiCardsMode(env);
	if (!card || mode === "off" || (kind === "write" && mode !== "all")) return undefined;
	const resourceUri = uiResourceUri(card);
	// The flat key is the pre-GA spelling some hosts still read.
	return { ui: { resourceUri }, "ui/resourceUri": resourceUri };
}

/**
 * Declared on every card: no outside origins of any kind, no permissions.
 * The card draws its own border, so the host is asked not to add one.
 */
export const UI_RESOURCE_META = {
	ui: {
		csp: { baseUriDomains: [], connectDomains: [], frameDomains: [], resourceDomains: [] },
		prefersBorder: false,
	},
};

async function sha256Base64(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	let binary = "";
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** GoBridge's own /link page, or "" unless BASE_URL is a plain https origin. */
export function ownerLinkUrl(env: Env): string {
	try {
		const base = new URL(String(env.BASE_URL));
		return base.protocol === "https:" && !base.username && !base.password ? `${base.origin}/link` : "";
	} catch (_e) {
		return "";
	}
}

const built = new Map<string, Promise<string>>();

/** The card's full HTML. Constant for a given build, UI_CARDS value and BASE_URL. */
export function cardHtml(card: UiCard, env: Env): Promise<string> {
	const source = CARDS[card];
	// These two constants are the only things that vary: no account data.
	const constants = [
		`var GB_WRITES=${uiCardsMode(env) === "all" ? "true" : "false"};`,
		...(source.linkUrl ? [`var GB_LINK_URL=${JSON.stringify(ownerLinkUrl(env))};`] : []),
	].join("");
	const key = `${card}|${constants}`;
	let html = built.get(key);
	if (!html) {
		html = buildCardHtml(source, constants + source.js);
		built.set(key, html);
	}
	return html;
}

async function buildCardHtml({ css, img, title }: CardSource, js: string): Promise<string> {
	const policy = [
		"default-src 'none'",
		`script-src 'sha256-${await sha256Base64(js)}'`,
		`style-src 'sha256-${await sha256Base64(css)}'`,
		`img-src ${img}`,
		"connect-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<div id="app" class="card"><p class="note">Loading…</p></div>
<script>${js}</script>
</body>
</html>`;
}

/** Registers the cards as MCP resources. Registers nothing when UI_CARDS is off. */
export function registerUiResources(server: Pick<McpServer, "registerResource">, env: Env): void {
	if (uiCardsMode(env) === "off") return;
	for (const card of UI_CARDS) {
		const uri = uiResourceUri(card);
		const { description, title } = CARDS[card];
		server.registerResource(
			`${card}-card`,
			uri,
			{ _meta: UI_RESOURCE_META, description, mimeType: UI_MIME_TYPE, title },
			async () => ({
				contents: [{ _meta: UI_RESOURCE_META, mimeType: UI_MIME_TYPE, text: await cardHtml(card, env), uri }],
			}),
		);
	}
}
