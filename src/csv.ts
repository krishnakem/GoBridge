/**
 * CSV for the owner pages' "Download CSV" buttons.
 *
 * Every cell is treated as untrusted text (aliases, client names, email
 * subjects all come from outside):
 *   - a cell that a spreadsheet would run as a formula (it starts with
 *     = + - @, or a tab or carriage return) gets a leading apostrophe, so it
 *     is shown as text;
 *   - a cell holding a comma, quote or line break is quoted, with quotes doubled.
 */

/** One cell, made safe for a spreadsheet and for CSV. */
export function csvCell(value: unknown): string {
	let text = value === undefined || value === null ? "" : String(value);
	if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole document: header row, then the rows, CRLF line endings (RFC 4180). */
export function csvDocument(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
	return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** A download response. `name` is one of GoBridge's own fixed names, never input. */
export function csvResponse(name: string, body: string, now = new Date()): Response {
	return new Response(body, {
		headers: {
			"Cache-Control": "no-store",
			"Content-Disposition": `attachment; filename="gobridge-${name}-${now.toISOString().slice(0, 10)}.csv"`,
			"Content-Type": "text/csv; charset=utf-8",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
