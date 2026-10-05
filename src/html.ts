import { sanitizeText } from "./workers-oauth-utils";

/**
 * Security headers for every HTML page GoBridge serves.
 * form-action allows Google because the sign-in form's POST redirects there.
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

/** A minimal GoBridge-branded message page. `message` is escaped. */
export function renderMessagePage(
	title: string,
	message: string,
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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GoBridge | ${sanitizeText(title)}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
h1 { font-size: 1.25rem; }
</style>
</head>
<body>
<h1>GoBridge</h1>
<h2>${sanitizeText(title)}</h2>
<p>${sanitizeText(message)}</p>
</body>
</html>`;
	return new Response(html, { status, headers });
}
