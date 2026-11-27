import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAllowedRedirect, normalizeRedirectUri } from "../src/allowed-clients";
import { HTML_SECURITY_HEADERS, LANDING_PAGE_CSP } from "../src/html";
import {
	ICON_FILES,
	ICON_LINKS_HTML,
	ICON_VERSION,
	iconHref,
	mcpServerIcons,
	WEB_MANIFEST,
} from "../src/static-assets";

const BASE = "https://gobridge.test";
const CLIENT_REDIRECT = "https://client.example/callback";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: ArrayBuffer): { width: number; height: number } {
	const view = new DataView(bytes);
	for (let i = 0; i < PNG_SIGNATURE.length; i++) expect(view.getUint8(i)).toBe(PNG_SIGNATURE[i]);
	expect(new TextDecoder().decode(bytes.slice(12, 16))).toBe("IHDR");
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** PNG colour type from IHDR: 2 is RGB with no alpha channel, so every pixel is opaque. */
function pngColourType(bytes: ArrayBuffer): number {
	pngSize(bytes);
	return new DataView(bytes).getUint8(25);
}

/** The directory entries of an ICO container. */
function icoEntries(bytes: ArrayBuffer): { size: number; png: ArrayBuffer }[] {
	const view = new DataView(bytes);
	expect(view.getUint16(0, true)).toBe(0); // reserved
	expect(view.getUint16(2, true)).toBe(1); // type: icon
	const count = view.getUint16(4, true);
	const entries = [];
	for (let i = 0; i < count; i++) {
		const at = 6 + 16 * i;
		const width = view.getUint8(at) || 256;
		expect(view.getUint8(at + 1) || 256).toBe(width);
		expect(view.getUint16(at + 6, true)).toBe(32); // bits per pixel
		const length = view.getUint32(at + 8, true);
		const offset = view.getUint32(at + 12, true);
		entries.push({ size: width, png: bytes.slice(offset, offset + length) });
	}
	return entries;
}

const get = (path: string, headers: Record<string, string> = {}) =>
	SELF.fetch(`${BASE}${path}`, { redirect: "manual", headers });

let logSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
		vi.spyOn(console, level),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("logo files", () => {
	it("are served at exactly the nine expected paths", () => {
		expect(ICON_FILES.map((file) => [file.path, file.contentType])).toEqual([
			["/favicon.ico", "image/x-icon"],
			["/favicon.png", "image/png"],
			["/apple-touch-icon.png", "image/png"],
			["/static/logo.svg", "image/svg+xml"],
			["/static/logo-256.png", "image/png"],
			["/static/logo-512.png", "image/png"],
			["/favicon.svg", "image/svg+xml"],
			["/static/icon-192.png", "image/png"],
			["/static/icon-512.png", "image/png"],
		]);
	});

	it("answer without any session, with the right type, caching and no cookies", async () => {
		for (const file of ICON_FILES) {
			const res = await get(file.path);
			expect(res.status, file.path).toBe(200);
			expect(res.headers.get("Content-Type"), file.path).toBe(file.contentType);
			expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
			expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{8}"$/);
			expect(res.headers.get("ETag")).toBe(file.etag);
			expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(res.headers.getSetCookie()).toHaveLength(0);
			expect(res.headers.get("Location")).toBeNull();
			const body = await res.arrayBuffer();
			expect(body.byteLength).toBe(file.bytes.byteLength);
			expect(new Uint8Array(body)).toEqual(new Uint8Array(file.bytes));
		}
		// Nothing about these requests is logged.
		expect(logSpies.flatMap((spy) => spy.mock.calls)).toEqual([]);
	});

	it("ignore cookies and auth headers: same bytes, no session lookup", async () => {
		const res = await get("/favicon.ico", {
			Cookie: "__Host-GOBRIDGE_SESSION=not-a-real-session",
			Authorization: "Bearer not-a-real-token",
		});
		expect(res.status).toBe(200);
		expect(res.headers.getSetCookie()).toHaveLength(0);
		expect((await res.arrayBuffer()).byteLength).toBe(ICON_FILES[0].bytes.byteLength);
	});

	it("revalidate with If-None-Match: 304 for the current ETag, 200 for any other", async () => {
		for (const file of ICON_FILES) {
			const fresh = await get(file.path, { "If-None-Match": file.etag });
			expect(fresh.status, file.path).toBe(304);
			expect(fresh.headers.get("ETag")).toBe(file.etag);
			expect(fresh.headers.get("Cache-Control")).toBe("public, max-age=86400");
			expect(await fresh.text()).toBe("");

			const weak = await get(file.path, { "If-None-Match": `W/${file.etag}, "other"` });
			expect(weak.status, file.path).toBe(304);
			await weak.body?.cancel();

			const stale = await get(file.path, { "If-None-Match": '"00000000"' });
			expect(stale.status, file.path).toBe(200);
			await stale.body?.cancel();
		}
	});

	it("have the advertised pixel sizes", async () => {
		const png = async (path: string) => pngSize(await (await get(path)).arrayBuffer());
		expect(await png("/favicon.png")).toEqual({ width: 64, height: 64 });
		expect(await png("/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
		expect(await png("/static/logo-256.png")).toEqual({ width: 256, height: 256 });
		expect(await png("/static/logo-512.png")).toEqual({ width: 512, height: 512 });
		expect(await png("/static/icon-192.png")).toEqual({ width: 192, height: 192 });
		expect(await png("/static/icon-512.png")).toEqual({ width: 512, height: 512 });

		const ico = icoEntries(await (await get("/favicon.ico")).arrayBuffer());
		expect(ico.map((entry) => entry.size)).toEqual([16, 32, 48]);
		for (const entry of ico) {
			expect(pngSize(entry.png)).toEqual({ width: entry.size, height: entry.size });
		}
	});

	it("are opaque in the favicon / manifest set (clients composite icons on their own background)", async () => {
		for (const path of ["/favicon.png", "/apple-touch-icon.png", "/static/icon-192.png", "/static/icon-512.png"]) {
			expect(pngColourType(await (await get(path)).arrayBuffer()), path).toBe(2);
		}
		for (const entry of icoEntries(await (await get("/favicon.ico")).arrayBuffer())) {
			expect(pngColourType(entry.png), `favicon.ico ${entry.size}px`).toBe(2);
		}
		// /favicon.svg is the same drawing clipped to a square, not the rounded one.
		const svg = await (await get("/favicon.svg")).text();
		expect(svg).toContain('<clipPath id="cl"><rect x="0" y="74" width="400" height="400"/></clipPath>');
		expect(svg).not.toContain("<metadata>");
	});

	it("serve an SVG with no scripts or outside references, sandboxed when opened directly", async () => {
		for (const path of ["/static/logo.svg", "/favicon.svg"]) {
			const res = await get(path);
			expect(res.headers.get("Content-Security-Policy")).toBe(
				"default-src 'none'; style-src 'unsafe-inline'; sandbox",
			);
			const svg = await res.text();
			expect(svg.startsWith("<svg ")).toBe(true);
			expect(svg).toContain("<title>GoBridge</title>");
			expect(svg).not.toMatch(/<script|<foreignObject|<iframe|<image|<use|xlink:href|\bon[a-z]+=/i);
			// The only URLs are XML namespaces; every url(...) is a same-document gradient.
			expect(svg.match(/https?:\/\/[^"'\s<)]+/g)?.every((url) => /\/\/(www\.w3\.org|c2pa\.org)\//.test(url))).toBe(true);
			expect(svg.match(/url\(([^)]*)\)/g)?.every((ref) => ref.startsWith("url(#"))).toBe(true);
		}
	});

	it("exist only at their own path, for GET", async () => {
		for (const file of ICON_FILES) {
			const post = await SELF.fetch(`${BASE}${file.path}`, { method: "POST" });
			expect(post.status, file.path).toBe(404);
			const trailing = await get(`${file.path}/`);
			expect(trailing.status, file.path).toBe(404);
			const upper = await get(file.path.toUpperCase());
			expect(upper.status, file.path).toBe(404);
		}
		// The MCP and OAuth routes are untouched.
		const mcp = await SELF.fetch(`${BASE}/mcp`, { method: "POST" });
		expect(mcp.status).toBe(401);
		await mcp.body?.cancel();
	});
});

describe("web manifest", () => {
	it("is public fixed JSON naming the opaque 192 and 512 px icons", async () => {
		const res = await get("/site.webmanifest", { Cookie: "__Host-GOBRIDGE_SESSION=not-a-real-session" });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/manifest+json");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{8}"$/);
		expect(res.headers.getSetCookie()).toHaveLength(0);
		const text = await res.text();
		expect(text).toBe(WEB_MANIFEST);
		const manifest = JSON.parse(text);
		expect(manifest).toMatchObject({
			name: "GoBridge",
			short_name: "GoBridge",
			theme_color: expect.stringMatching(/^#[0-9a-f]{6}$/),
			background_color: expect.stringMatching(/^#[0-9a-f]{6}$/),
		});
		expect(manifest.icons).toEqual([
			{ src: "/static/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/static/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
		]);
		for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
			const file = await get(icon.src);
			expect(file.status, icon.src).toBe(200);
			expect(file.headers.get("Content-Type")).toBe(icon.type);
			const { width, height } = pngSize(await file.arrayBuffer());
			expect(`${width}x${height}`).toBe(icon.sizes);
		}
		// Nothing secret or owner-specific, and no outside URLs.
		expect(text).not.toContain(env.ALLOWED_EMAIL);
		expect(text).not.toMatch(/https?:|@/);
		expect(logSpies.flatMap((spy) => spy.mock.calls)).toEqual([]);
	});

	it("revalidates with its ETag and answers GET only", async () => {
		const first = await get("/site.webmanifest");
		const etag = first.headers.get("ETag")!;
		await first.body?.cancel();
		const fresh = await get("/site.webmanifest", { "If-None-Match": etag });
		expect(fresh.status).toBe(304);
		expect(await fresh.text()).toBe("");
		const stale = await get("/site.webmanifest", { "If-None-Match": '"00000000"' });
		expect(stale.status).toBe(200);
		await stale.body?.cancel();
		for (const method of ["POST", "PUT", "DELETE"]) {
			const other = await SELF.fetch(`${BASE}/site.webmanifest`, { method });
			expect(other.status, method).toBe(404);
			await other.body?.cancel();
		}
		const head = await SELF.fetch(`${BASE}/site.webmanifest`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("Content-Type")).toBe("application/manifest+json");
		expect(await head.text()).toBe("");
	});
});

describe("landing page (GET /)", () => {
	it("is public, fixed and data-free, with the icon links and the manifest", async () => {
		const res = await get("/");
		expect(res.status).toBe(200);
		expect(res.headers.getSetCookie()).toHaveLength(0);
		expect(res.headers.get("Location")).toBeNull();
		const html = await res.text();
		expect(html).toContain("<title>GoBridge</title>");
		expect(html).toContain(ICON_LINKS_HTML);
		expect(html).toContain('<link rel="manifest" href="/site.webmanifest">');
		expect(html).toContain(`<img class="landing-logo" src="${iconHref("/static/logo.svg")}" alt="" width="96" height="96">`);
		expect(html).toContain('<a class="btn btn-primary" href="/link">Manage</a>');
		// No owner data, secrets or session-dependent content, and no form.
		for (const secret of [env.ALLOWED_EMAIL, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]) {
			if (secret) expect(html).not.toContain(secret);
		}
		expect(html).not.toMatch(/@|<form|csrf|https?:\/\//i);
		// Every image and link stays on this origin.
		for (const ref of html.match(/(?:src|href)="[^"]*"/g) ?? []) expect(ref, ref).toMatch(/^(src|href)="\//);
		// Nothing about the request is logged.
		expect(logSpies.flatMap((spy) => spy.mock.calls)).toEqual([]);
	});

	it("sends the same security headers as other public pages, plus manifest-src 'self'", async () => {
		const res = await get("/");
		await res.body?.cancel();
		for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) {
			if (name === "Content-Security-Policy") continue;
			expect(res.headers.get(name), name).toBe(value);
		}
		const csp = res.headers.get("Content-Security-Policy")!;
		expect(csp).toBe(LANDING_PAGE_CSP);
		expect(csp).toBe(
			"default-src 'none'; img-src 'self'; manifest-src 'self'; style-src 'self'; script-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
		);
		expect(csp).not.toContain("unsafe-inline");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	it("answers HEAD with the headers and no body", async () => {
		const head = await SELF.fetch(`${BASE}/`, { method: "HEAD", redirect: "manual" });
		expect(head.status).toBe(200);
		expect(head.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(head.headers.get("Content-Security-Policy")).toBe(LANDING_PAGE_CSP);
		expect(head.headers.getSetCookie()).toHaveLength(0);
		expect(await head.text()).toBe("");
	});

	it("is not a redirect into sign-in any more, and every icon it names answers", async () => {
		const html = await (await get("/")).text();
		const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/g)].map((m) => m[1]);
		expect(hrefs.length).toBe(4);
		for (const href of hrefs) {
			const res = await get(href);
			expect(res.status, href).toBe(200);
			await res.body?.cancel();
		}
		// The crawler-facing defaults also answer, without a session.
		for (const path of ["/favicon.ico", "/favicon.svg", "/favicon.png", "/apple-touch-icon.png"]) {
			const res = await get(path, { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" });
			expect(res.status, path).toBe(200);
			await res.body?.cancel();
		}
	});
});

describe("icon advertisement", () => {
	it("gives the MCP client absolute https URLs on this environment's own origin", async () => {
		const icons = mcpServerIcons(env.BASE_URL);
		expect(icons).toEqual([
			{ src: `${BASE}/static/logo.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
			{ src: `${BASE}/static/logo-256.png`, mimeType: "image/png", sizes: ["256x256"] },
			{ src: `${BASE}/static/logo-512.png`, mimeType: "image/png", sizes: ["512x512"] },
			{ src: `${BASE}/static/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] },
		]);
		// Dev and production each name themselves: nothing is hardcoded.
		expect(mcpServerIcons("https://gobridge-dev.example.workers.dev")[0].src).toBe(
			"https://gobridge-dev.example.workers.dev/static/logo.svg",
		);
		for (const icon of icons) {
			const res = await SELF.fetch(icon.src);
			expect(res.status, icon.src).toBe(200);
			expect(res.headers.get("Content-Type")).toBe(icon.mimeType);
			await res.body?.cancel();
		}
	});

	it("links the favicon from every GoBridge page, versioned like the other static files", async () => {
		expect(ICON_VERSION).toMatch(/^[0-9a-f]{8}$/);
		expect(iconHref("/favicon.png")).toBe(`/favicon.png?v=${ICON_VERSION}`);
		expect(ICON_LINKS_HTML).toBe(
			`<link rel="icon" href="/favicon.png?v=${ICON_VERSION}" sizes="64x64" type="image/png">\n` +
				`<link rel="icon" href="/static/logo.svg?v=${ICON_VERSION}" type="image/svg+xml">\n` +
				`<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_VERSION}">`,
		);
		// Public pages: /signed-out and the "not allowed" refusal both include them,
		// and allow images from this origin only.
		const signedOut = await get("/signed-out");
		expect(await signedOut.text()).toContain(ICON_LINKS_HTML);
		expect(signedOut.headers.get("Content-Security-Policy")).toContain("img-src 'self';");
		// The versioned files answer.
		for (const path of ["/favicon.png", "/static/logo.svg", "/apple-touch-icon.png"] as const) {
			const res = await get(iconHref(path));
			expect(res.status, path).toBe(200);
			await res.body?.cancel();
		}
	});

	it("shows the logo on the AI-client approval page, from this origin only", async () => {
		await env.AUDIT_DB.prepare("DELETE FROM allowed_redirect_uris").run();
		const normalized = normalizeRedirectUri(CLIENT_REDIRECT);
		if (!normalized.ok) throw new Error("test setup: bad URL");
		await addAllowedRedirect(env, normalized.uri);

		const registered = await SELF.fetch(`${BASE}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Test Client",
				redirect_uris: [CLIENT_REDIRECT],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(registered.status).toBe(201);
		const { client_id } = (await registered.json()) as { client_id: string };
		const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("verifier")))))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const dialog = await SELF.fetch(
			`${BASE}/authorize?${new URLSearchParams({
				response_type: "code",
				client_id,
				redirect_uri: CLIENT_REDIRECT,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "client-state",
				resource: `${BASE}/mcp`,
			})}`,
		);
		expect(dialog.status).toBe(200);
		const csp = dialog.headers.get("Content-Security-Policy")!;
		expect(csp).toContain("default-src 'none'; img-src 'self'; style-src 'unsafe-inline';");
		expect(csp).not.toContain("script-src");
		expect(csp.match(/img-src/g)).toHaveLength(1);
		const html = await dialog.text();
		expect(html).toContain(ICON_LINKS_HTML);
		expect(html).toContain(`<img src="${BASE}/static/logo-256.png" alt="GoBridge Logo" class="logo">`);
		// No image from anywhere else.
		expect(html.match(/<img [^>]*src="([^"]*)"/g)).toHaveLength(1);
	});
});
