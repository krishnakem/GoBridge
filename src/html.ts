import { sanitizeText } from "./workers-oauth-utils";

/**
 * Security headers for every HTML page GoBridge serves.
 *
 * Styles and the one menu script come only from this origin (/static/...):
 * no inline scripts, inline event handlers, or inline styles are allowed.
 * form-action allows Google because sign-in/link forms POST and then redirect there.
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
	"Content-Type": "text/html; charset=utf-8",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
};

/** Escapes text for use in HTML content or attribute values. */
export const escapeHtml = sanitizeText;

function renderDocument(
	title: string,
	bodyClass: string,
	bodyHtml: string,
	status: number,
	extraHeaders?: Headers,
): Response {
	const headers = new Headers(extraHeaders);
	for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) {
		headers.set(name, value);
	}
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>GoBridge | ${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/menu.js" defer></script>
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
<div class="brand">GoBridge</div>
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
	backTo?: "/link",
	action?: { href: "/link"; label: string },
): Response {
	const back = backTo ? `\n<p><a href="${backTo}">Back to linked accounts</a></p>` : "";
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

// ---------- Owner pages: sidebar / tab bar layout with the account menu ----------

/** What the avatar's red dot and the Settings menu label report. */
export type Attention = {
	/** WRITES_ENABLED is not "true" */
	writesOff: boolean;
	/** Aliases of linked accounts that must be linked again */
	relink: string[];
};

export type OwnerPath = "/link" | "/audit" | "/clients" | "/settings";

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
];

function navLinks(active: OwnerPath): string {
	return NAV.map(
		(item) =>
			`<a href="${item.href}"${item.href === active ? ' aria-current="page"' : ""}>${item.icon}<span>${item.label}</span></a>`,
	).join("\n");
}

function accountMenu(
	variant: "row" | "avatar",
	session: { email: string; csrf: string },
	attention: Attention,
): string {
	const email = escapeHtml(session.email);
	const needsAttention = attention.writesOff || attention.relink.length > 0;
	const flag = attention.writesOff ? "Writes off" : attention.relink.length ? "Re-link needed" : "";
	const size = variant === "row" ? 22 : 32;
	const avatar = `<span class="avatar-wrap"><span class="avatar avatar-${size}" aria-hidden="true">${escapeHtml(
		session.email.trim().charAt(0).toUpperCase() || "?",
	)}</span>${needsAttention ? '<span class="dot"></span>' : ""}</span>`;
	const trigger =
		variant === "row"
			? `${avatar}<span class="account-email">${email}</span>`
			: avatar;

	return `<details class="account-menu" data-account-menu>
<summary class="${variant === "row" ? "account-row" : "avatar-button"}" aria-haspopup="menu" aria-label="${needsAttention ? "Account (needs attention)" : "Account"}">${trigger}</summary>
<div class="menu-backdrop" data-menu-close></div>
<div class="menu" role="menu" aria-label="Account">
<div class="menu-header">${email}</div>
<div class="menu-divider" role="separator"></div>
<a class="menu-item" role="menuitem" href="/link">Linked accounts</a>
<a class="menu-item" role="menuitem" href="/audit">Recent writes</a>
<a class="menu-item" role="menuitem" href="/clients">AI clients</a>
<a class="menu-item" role="menuitem" href="/settings"><span>Settings</span>${flag ? `<span class="menu-flag">${flag}</span>` : ""}</a>
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
	session: { email: string; csrf: string };
	attention: Attention;
	bodyHtml: string;
}): Response {
	const { title, active, session, attention, bodyHtml } = options;
	return renderDocument(
		title,
		"app",
		`<div class="shell">
<aside class="sidebar">
<div class="brand">GoBridge</div>
<nav class="side-nav" aria-label="Main">
${navLinks(active)}
</nav>
<div class="side-account">
${accountMenu("row", session, attention)}
</div>
</aside>
<div class="main-col">
<header class="topbar">
<span class="brand">GoBridge</span>
${accountMenu("avatar", session, attention)}
</header>
<main class="content">
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</main>
</div>
</div>
<nav class="tabbar" aria-label="Main">
${navLinks(active)}
</nav>`,
		200,
	);
}
