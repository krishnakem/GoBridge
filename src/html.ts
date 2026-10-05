import { sanitizeText } from "./workers-oauth-utils";

/**
 * Security headers for every HTML page GoBridge serves.
 * form-action allows Google because sign-in/link forms POST and then redirect there.
 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
	"Content-Type": "text/html; charset=utf-8",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
};

/** Links between the owner-only pages. */
export function ownerNav(csrfToken: string): string {
	return `<form class="inline muted" method="post" action="/logout">
<a href="/link">Linked accounts</a> · <a href="/audit">Recent writes</a> · <a href="/clients">AI clients</a> ·
<input type="hidden" name="csrf_token" value="${sanitizeText(csrfToken)}">
<button type="submit">Sign out</button>
</form>`;
}

/** Escapes text for use in HTML content or attribute values. */
export const escapeHtml = sanitizeText;

/**
 * Wraps `bodyHtml` in the GoBridge page shell with security headers.
 * `bodyHtml` is trusted markup: callers must escape every dynamic value.
 */
export function renderPage(
	title: string,
	bodyHtml: string,
	status = 200,
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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GoBridge | ${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
h1 { font-size: 1.25rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.5rem 0.75rem 0.5rem 0; border-bottom: 1px solid #ddd; vertical-align: middle; }
input[type=text] { font: inherit; padding: 0.4rem; width: 14rem; }
button { font: inherit; padding: 0.4rem 0.9rem; cursor: pointer; }
.notice { background: #eef6ee; border: 1px solid #b7d7b7; padding: 0.6rem 0.8rem; }
.warn { background: #fdf3e3; border: 1px solid #e6c88f; padding: 0.6rem 0.8rem; }
.muted { color: #666; font-size: 0.9rem; }
form.inline { display: inline; }
</style>
</head>
<body>
<h1>GoBridge</h1>
${bodyHtml}
</body>
</html>`;
	return new Response(html, { status, headers });
}

/** A minimal GoBridge-branded message page. `title` and `message` are escaped. */
export function renderMessagePage(
	title: string,
	message: string,
	status: number,
	extraHeaders?: Headers,
	backTo?: "/link",
): Response {
	const back = backTo ? `\n<p><a href="${backTo}">Back to linked accounts</a></p>` : "";
	return renderPage(
		title,
		`<h2>${escapeHtml(title)}</h2>\n<p>${escapeHtml(message)}</p>${back}`,
		status,
		extraHeaders,
	);
}
