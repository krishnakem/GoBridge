import { PICTURE_HOST } from "./auth";
import { ICON_LINKS_HTML, iconHref, STATIC_VERSION } from "./static-assets";
import { sanitizeText } from "./workers-oauth-utils";

/**
 * Security headers for every HTML page GoBridge serves.
 *
 * Styles, the one menu script and images (the logo, favicon) come only from
 * this origin (/static/..., /favicon.*): no inline scripts, inline event
 * handlers, or inline styles are allowed.
 * form-action allows Google because sign-in/link forms POST and then redirect there.
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
	"Content-Type": "text/html; charset=utf-8",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
};

/**
 * Owner pages additionally may load profile pictures, from this origin or
 * Google's picture host only (owner-approved 2026-10-07). Everything else is
 * identical to HTML_SECURITY_HEADERS.
 */
export const OWNER_PAGE_CSP = HTML_SECURITY_HEADERS["Content-Security-Policy"].replace(
	"img-src 'self'; ",
	`img-src 'self' https://${PICTURE_HOST}; `,
);

/** The GoBridge wordmark with the small logo beside it (same-origin image, no data). */
const BRAND_HTML = `<img class="brand-logo" src="${iconHref("/favicon.png")}" alt="" width="22" height="22">GoBridge`;

/** Escapes text for use in HTML content or attribute values. */
export const escapeHtml = sanitizeText;

function renderDocument(
	title: string,
	bodyClass: string,
	bodyHtml: string,
	status: number,
	extraHeaders?: Headers,
	csp = HTML_SECURITY_HEADERS["Content-Security-Policy"],
): Response {
	const headers = new Headers(extraHeaders);
	for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) {
		headers.set(name, value);
	}
	headers.set("Content-Security-Policy", csp);
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>GoBridge | ${escapeHtml(title)}</title>
${ICON_LINKS_HTML}
<link rel="stylesheet" href="/static/app.css?v=${STATIC_VERSION}">
<script src="/static/menu.js?v=${STATIC_VERSION}" defer></script>
</head>
<body class="${bodyClass}">
${bodyHtml}
</body>
</html>`;
	return new Response(html, { status, headers });
}

/**
 * A plain GoBridge page with no navigation, for visitors without an owner
 * session (sign-in errors, signed out). `bodyHtml` is trusted markup: callers
 * must escape every dynamic value.
 */
export function renderPage(
	title: string,
	bodyHtml: string,
	status = 200,
	extraHeaders?: Headers,
): Response {
	return renderDocument(
		title,
		"simple",
		`<main class="simple-main">
<div class="brand">${BRAND_HTML}</div>
${bodyHtml}
</main>`,
		status,
		extraHeaders,
	);
}

/** A minimal GoBridge-branded message page. `title` and `message` are escaped. */
export function renderMessagePage(
	title: string,
	message: string,
	status: number,
	extraHeaders?: Headers,
	backTo?: "/link" | "/settings",
	action?: { href: "/link"; label: string },
): Response {
	const backLabel = backTo === "/settings" ? "Back to settings" : "Back to linked accounts";
	const back = backTo ? `\n<p><a href="${backTo}">${backLabel}</a></p>` : "";
	const button = action
		? `\n<p><a class="btn btn-primary" href="${action.href}">${escapeHtml(action.label)}</a></p>`
		: "";
	return renderPage(
		title,
		`<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>${button}${back}`,
		status,
		extraHeaders,
	);
}

/**
 * Shown at /authorize or /callback when an AI client is not on the owner's
 * allowed list. The owner is the one in the browser, so the page names the
 * exact redirect URLs to add on /settings, and warns against adding them for a
 * connection the owner did not start. Every URL is escaped.
 */
export function renderClientNotAllowedPage(unlisted: readonly string[]): Response {
	const items = unlisted.map((uri) => `<li><code>${escapeHtml(uri)}</code></li>`).join("\n");
	return renderPage(
		"App not allowed",
		`<h1>This app is not allowed to connect</h1>
<p>GoBridge only lets AI apps connect when every redirect URL they use is on your allowed list. This app uses:</p>
<ul>
${items}
</ul>
<p>If you just added GoBridge to this app yourself, add ${unlisted.length === 1 ? "this URL" : "these URLs"} under <strong>Allowed AI clients</strong> on the Settings page, then connect again.</p>
<p class="warn">If you did not start this connection, close this page and add nothing: someone may be trying to get access to your accounts.</p>
<p><a class="btn btn-primary" href="/settings">Open Settings</a></p>`,
		403,
	);
}

// ---------- Owner pages: sidebar / tab bar layout with the account menu ----------

/** What the avatar's red dot and the Settings menu label report. */
export type Attention = {
	/** WRITES_ENABLED is not "true" */
	writesOff: boolean;
	/** Aliases of linked accounts that must be linked again */
	relink: string[];
	/** Other feature switches that are off (DIRECT_SEND_ENABLED, ...) */
	switchesOff?: string[];
};

export type OwnerPath = "/link" | "/audit" | "/clients" | "/settings";

/**
 * A round avatar: the profile picture when there is one, over the initial
 * letter, which shows until the image loads and stays if it fails (the
 * broken image is hidden by /static/menu.js; no inline handlers). The
 * picture URL is only ever one that passed profilePictureFrom().
 */
export function avatarHtml(email: string, size: 22 | 32, picture?: string): string {
	const initial = escapeHtml(email.trim().charAt(0).toUpperCase() || "?");
	const img = picture
		? `<img class="avatar-img" src="${escapeHtml(picture)}" alt="" width="${size}" height="${size}" referrerpolicy="no-referrer">`
		: "";
	return `<span class="avatar avatar-${size}" aria-hidden="true">${img}${initial}</span>`;
}

const icon = (paths: string) =>
	`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const NAV: { href: OwnerPath; label: string; icon: string }[] = [
	{
		href: "/link",
		icon: icon(
			'<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
		),
		label: "Linked accounts",
	},
	{
		href: "/audit",
		icon: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
		label: "Recent writes",
	},
	{
		href: "/clients",
		icon: icon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
		label: "AI clients",
	},
	{
		href: "/settings",
		icon: icon(
			'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
		),
		label: "Settings",
	},
];

/** What the Settings entry reports when something needs attention. */
function attentionFlag(attention: Attention): string {
	if (attention.writesOff) return "Writes off";
	if (attention.switchesOff?.length) return "Feature off";
	if (attention.relink.length) return "Re-link needed";
	return "";
}

/** Navigation links; the sidebar (`withFlag`) also shows the attention flag on Settings. */
function navLinks(active: OwnerPath, attention: Attention, withFlag: boolean): string {
	const flag = withFlag ? attentionFlag(attention) : "";
	return NAV.map(
		(item) =>
			`<a href="${item.href}"${item.href === active ? ' aria-current="page"' : ""}>${item.icon}<span>${item.label}</span>${item.href === "/settings" && flag ? `<span class="nav-flag">${flag}</span>` : ""}</a>`,
	).join("\n");
}

/**
 * The account menu: the owner's email as its header and Sign Out. The "row"
 * trigger (sidebar) shows the owner's name when the session has one, else
 * the email; the "avatar" trigger (phone top bar) shows the picture only.
 */
function accountMenu(
	variant: "row" | "avatar",
	session: { email: string; csrf: string; picture?: string; name?: string },
	attention: Attention,
): string {
	const email = escapeHtml(session.email);
	const otherOff = attention.switchesOff?.length ?? 0;
	const needsAttention = attention.writesOff || otherOff > 0 || attention.relink.length > 0;
	const size = variant === "row" ? 22 : 32;
	const avatar = `<span class="avatar-wrap">${avatarHtml(session.email, size, session.picture)}${needsAttention ? '<span class="dot"></span>' : ""}</span>`;
	const trigger =
		variant === "row"
			? `${avatar}<span class="account-label">${escapeHtml(session.name || session.email)}</span>`
			: avatar;

	return `<details class="account-menu" data-account-menu>
<summary class="${variant === "row" ? "account-row" : "avatar-button"}" aria-haspopup="menu" aria-label="${needsAttention ? "Account (needs attention)" : "Account"}">${trigger}</summary>
<div class="menu-backdrop" data-menu-close></div>
<div class="menu" role="menu" aria-label="Account">
<div class="menu-header">${email}</div>
<div class="menu-divider" role="separator"></div>
<form method="POST" action="/logout">
<input type="hidden" name="csrf_token" value="${escapeHtml(session.csrf)}">
<button class="menu-item" role="menuitem" type="submit">Sign Out</button>
</form>
</div>
</details>`;
}

/**
 * An owner-only page: sidebar on desktop, top bar + bottom tabs on phones, and
 * the account menu (with the CSRF-protected sign-out form) on both.
 * `bodyHtml` is trusted markup: callers must escape every dynamic value.
 */
export function renderOwnerPage(options: {
	title: string;
	active: OwnerPath;
	session: { email: string; csrf: string; picture?: string; name?: string };
	attention: Attention;
	bodyHtml: string;
}): Response {
	const { title, active, session, attention, bodyHtml } = options;
	return renderDocument(
		title,
		"app",
		`<div class="shell">
<aside class="sidebar">
<div class="brand">${BRAND_HTML}</div>
<nav class="side-nav" aria-label="Main">
${navLinks(active, attention, true)}
</nav>
<div class="side-account">
${accountMenu("row", session, attention)}
</div>
</aside>
<div class="main-col">
<header class="topbar">
<span class="brand">${BRAND_HTML}</span>
${accountMenu("avatar", session, attention)}
</header>
<main class="content">
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</main>
</div>
</div>
<nav class="tabbar" aria-label="Main">
${navLinks(active, attention, false)}
</nav>`,
		200,
		undefined,
		OWNER_PAGE_CSP,
	);
}
