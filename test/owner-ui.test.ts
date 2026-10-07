import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aliasesNeedingRelink, deleteAccount, markNeedsRelink, saveAccount } from "../src/accounts";
import { unseal } from "../src/crypto";
import { LINK_SCOPES, TOOL_SCOPES } from "../src/google";
import { clearAccessTokenCache } from "../src/google-api";
import { OwnerPages } from "../src/owner-pages";
import { runReadTool } from "../src/tools";
import { APP_CSS, MENU_JS } from "../src/static-assets";

const BASE = "https://gobridge.test";
const OWNER_CLAIMS = { sub: "owner-sub-1", email: "owner@example.com", email_verified: true };
const OWNER_PICTURE = "https://lh3.googleusercontent.com/a/owner-picture=s96-c";
const OWNER_PAGES = ["/link", "/audit", "/clients", "/settings"];
const pictureImg = (size: number) =>
	`<img class="avatar-img" src="${OWNER_PICTURE}" alt="" width="${size}" height="${size}" referrerpolicy="no-referrer">`;
const PICTURE_IMG = pictureImg(32);

/** Fake Google for owner sign-in. `refreshStatus` makes refresh-token exchanges fail. */
function mockGoogle(refreshStatus?: number, claims: Record<string, unknown> = OWNER_CLAIMS) {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input as RequestInfo, init);
		if (request.url === "https://oauth2.googleapis.com/token") {
			const form = await request.formData();
			if (form.get("grant_type") === "refresh_token" && refreshStatus) {
				return new Response('{"error":"invalid_grant"}', { status: refreshStatus });
			}
			return Response.json({ access_token: "ya29.fake-login-access-token", expires_in: 3600 });
		}
		if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
			return Response.json(claims);
		}
		throw new Error(`Unexpected outbound fetch in test: ${new URL(request.url).origin}`);
	});
}

const cookiesFrom = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.filter((c) => !c.endsWith("="))
		.join("; ");

async function signIn(page = "/link") {
	const start = await SELF.fetch(`${BASE}${page}`, { redirect: "manual" });
	const google = new URL(start.headers.get("Location")!);
	const callback = await SELF.fetch(
		`${BASE}/callback?code=fake-login-code&state=${google.searchParams.get("state")}`,
		{ redirect: "manual", headers: { Cookie: cookiesFrom(start) } },
	);
	expect(callback.headers.get("Location")).toBe(page);
	const cookie = cookiesFrom(callback);
	const html = await (await SELF.fetch(`${BASE}${page}`, { headers: { Cookie: cookie } })).text();
	return { cookie, csrf: html.match(/name="csrf_token" value="([^"]+)"/)![1] };
}

const get = (path: string, cookie?: string) =>
	SELF.fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });

/** Renders an owner page with a modified environment (same KV, same session). */
const getWithEnv = (path: string, cookie: string, overrides: Partial<Env>) =>
	OwnerPages.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), {
		...env,
		...overrides,
	} as any);

afterEach(() => {
	vi.restoreAllMocks();
	clearAccessTokenCache();
});

describe("owner page layout and account menu", () => {
	it("renders the account menu with a CSRF-protected POST sign-out form on every owner page", async () => {
		mockGoogle();
		const owner = await signIn();
		for (const page of OWNER_PAGES) {
			const res = await get(page, owner.cookie);
			expect(res.status, page).toBe(200);
			const html = await res.text();

			// One menu for the desktop sidebar and one for the phone top bar.
			expect(html.match(/<details class="account-menu" data-account-menu>/g)).toHaveLength(2);
			expect(html.match(/role="menu" aria-label="Account"/g)).toHaveLength(2);
			const forms = html.match(/<form method="POST" action="\/logout">[\s\S]*?<\/form>/g)!;
			expect(forms).toHaveLength(2);
			for (const form of forms) {
				expect(form).toContain(`<input type="hidden" name="csrf_token" value="${owner.csrf}">`);
				expect(form).toMatch(/<button class="menu-item" role="menuitem" type="submit">Sign Out<\/button>/);
			}
			for (const item of ["/link", "/audit", "/clients", "/settings"]) {
				expect(html).toContain(`<a class="menu-item" role="menuitem" href="${item}">`);
			}
			expect(html).toContain('<div class="menu-header">owner@example.com</div>');
			expect(html).toContain('role="separator"');
			expect(html).toContain('aria-haspopup="menu" aria-label="Account"');
			// Initial of the owner email, no profile photo.
			expect(html).toContain('<span class="avatar avatar-22" aria-hidden="true">O</span>');
			expect(html).not.toContain("<img");
			expect(html).not.toContain("googleusercontent");

			// Sidebar + bottom tabs, with the current page marked (Settings is menu-only).
			const current = html.match(/aria-current="page"/g) ?? [];
			expect(current.length, page).toBe(page === "/settings" ? 0 : 2);
			if (page !== "/settings") {
				expect(html).toContain(`<a href="${page}" aria-current="page">`);
			}
		}
	});

	it("keeps a strict CSP: nothing inline, styles and script from this origin only", async () => {
		mockGoogle();
		const owner = await signIn();
		for (const page of [...OWNER_PAGES, "/signed-out"]) {
			const res = await get(page, page === "/signed-out" ? undefined : owner.cookie);
			const csp = res.headers.get("Content-Security-Policy")!;
			expect(csp, page).not.toContain("unsafe-inline");
			expect(csp).not.toContain("unsafe-eval");
			expect(csp).toContain("default-src 'none'");
			expect(csp).toContain("script-src 'self'");
			expect(csp).toContain("style-src 'self'");
			expect(csp).toContain("frame-ancestors 'none'");
			expect(csp).toContain("base-uri 'none'");
			expect(csp).toContain("form-action 'self' https://accounts.google.com");
			// Profile pictures: owner pages may load images from this origin and
			// Google's picture host only. The public page has no images at all.
			if (page === "/signed-out") expect(csp).not.toContain("img-src");
			else expect(csp).toContain("img-src 'self' https://lh3.googleusercontent.com");
			expect(csp).not.toMatch(/img-src[^;]*\*/);
			expect(res.headers.get("X-Frame-Options")).toBe("DENY");
			expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");

			const html = await res.text();
			expect(html).toMatch(/<link rel="stylesheet" href="\/static\/app\.css\?v=[0-9a-f]{8}">/);
			expect(html).toMatch(/<script src="\/static\/menu\.js\?v=[0-9a-f]{8}" defer><\/script>/);
			// No inline scripts, inline styles, or inline event handlers.
			expect(html.match(/<script/g)).toHaveLength(1);
			expect(html).not.toMatch(/<style/i);
			expect(html).not.toMatch(/\sstyle=/i);
			expect(html).not.toMatch(/\son[a-z]+=/i);
			expect(html).not.toMatch(/https?:\/\/(?!gobridge\.test)/);
		}
	});
});

describe("owner profile picture", () => {
	it("asks Google for openid, email and profile for the owner pages only", async () => {
		for (const page of OWNER_PAGES) {
			const res = await get(page);
			const google = new URL(res.headers.get("Location")!);
			expect(google.searchParams.get("scope"), page).toBe("openid email profile");
			expect(google.searchParams.get("access_type")).toBeNull();
		}
	});

	it("shows the picture in both account menus, with the initial as the fallback and the dot on top", async () => {
		mockGoogle(undefined, { ...OWNER_CLAIMS, name: "Owner Name", picture: OWNER_PICTURE });
		const owner = await signIn();
		for (const page of OWNER_PAGES) {
			const html = await (await get(page, owner.cookie)).text();
			expect(html.match(/<img /g), page).toHaveLength(2);
			expect(html).toContain(
				`<span class="avatar avatar-22" aria-hidden="true">${pictureImg(22)}O</span>`,
			);
			expect(html).toContain(
				`<span class="avatar avatar-32" aria-hidden="true">${PICTURE_IMG}O</span>`,
			);
			// Only the picture is external, nothing else from the profile is rendered.
			expect(html.match(/https?:\/\/(?!gobridge\.test)[^"'\s<]+/g)).toEqual([OWNER_PICTURE, OWNER_PICTURE]);
			expect(html).not.toContain("Owner Name");
			expect(html).not.toMatch(/\son[a-z]+=/i);
			expect(html).not.toMatch(/\sstyle=/i);
		}
		// The attention dot still renders, after the image, inside the same wrapper.
		const html = await (await getWithEnv("/settings", owner.cookie, { WRITES_ENABLED: "false" })).text();
		for (const size of [22, 32]) {
			expect(html, `avatar-${size}`).toContain(`${pictureImg(size)}O</span><span class="dot"></span>`);
		}

		// The server-side record holds the picture; the cookie does not.
		const sealed = owner.cookie.split("__Host-GOBRIDGE_SESSION=")[1].split(";")[0];
		const session = (await unseal<Record<string, unknown>>(sealed, env.COOKIE_ENCRYPTION_KEY, "owner-session"))!;
		expect(session.picture).toBeUndefined();
		expect(session.name).toBeUndefined();
		const record = await env.OAUTH_KV.get(`owner:session:${session.sid}`);
		expect(JSON.parse(record!)).toEqual({ picture: OWNER_PICTURE });

		// Sessions from before pictures existed still work and show the initial.
		await env.OAUTH_KV.put(`owner:session:${session.sid}`, "1");
		const old = await (await get("/link", owner.cookie)).text();
		expect(old).toContain('<span class="avatar avatar-22" aria-hidden="true">O</span>');
		expect(old).not.toContain("<img");
	});

	it("ignores a picture that is not an https URL on Google's picture host", async () => {
		for (const picture of [
			"https://evil.example/owner.png",
			"http://lh3.googleusercontent.com/a/plain",
			"https://lh3.googleusercontent.com.evil.example/a/x",
			"https://lh3.googleusercontent.com/a/x?q=1",
			"javascript:alert(1)",
			"x".repeat(600),
			42,
		]) {
			vi.restoreAllMocks();
			mockGoogle(undefined, { ...OWNER_CLAIMS, picture });
			const owner = await signIn();
			const html = await (await get("/link", owner.cookie)).text();
			expect(html, String(picture)).not.toContain("<img");
			expect(html).not.toContain("evil.example");
			expect(html).toContain('<span class="avatar avatar-22" aria-hidden="true">O</span>');
		}
	});

	it("hides a broken picture from the script, never from an inline handler", () => {
		expect(MENU_JS).toContain('img.avatar-img');
		expect(MENU_JS).toContain('addEventListener("error"');
		expect(APP_CSS).toContain(".avatar-img.failed{display:none}");
	});
});

describe("static assets", () => {
	it("serves only the two expected files, with the right content types", async () => {
		const css = await get("/static/app.css");
		expect(css.status).toBe(200);
		expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
		expect(css.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(css.headers.getSetCookie()).toHaveLength(0);
		expect(await css.text()).toBe(APP_CSS);

		const js = await get("/static/menu.js");
		expect(js.status).toBe(200);
		expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
		expect(js.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(js.headers.getSetCookie()).toHaveLength(0);
		expect(await js.text()).toBe(MENU_JS);

		for (const path of [
			"/static",
			"/static/",
			"/static/app.css/",
			"/static/app.css.map",
			"/static/menu.js.map",
			"/static/index.html",
			"/static/package.json",
			"/static/wrangler.jsonc",
			"/static/..%2fwrangler.jsonc",
			"/static/src/index.ts",
		]) {
			const res = await get(path);
			expect(res.status, path).toBe(404);
			await res.body?.cancel();
		}
		// Dot segments are resolved before routing, so this is just /link: owner sign-in, no file.
		const traversal = await get("/static/%2e%2e/link");
		expect(traversal.status).toBe(302);
		expect(new URL(traversal.headers.get("Location")!).hostname).toBe("accounts.google.com");
		const post = await SELF.fetch(`${BASE}/static/app.css`, { method: "POST" });
		expect(post.status).toBe(404);
	});

	it("contains no secrets, owner data, or external URLs", () => {
		for (const text of [APP_CSS, MENU_JS]) {
			for (const secret of [
				env.ALLOWED_EMAIL,
				env.GOOGLE_CLIENT_ID,
				env.GOOGLE_CLIENT_SECRET,
				env.COOKIE_ENCRYPTION_KEY,
				env.TOKEN_ENCRYPTION_KEY,
				"ya29.",
				"1//",
				"Bearer ",
				"csrf",
			]) {
				expect(text).not.toContain(secret);
			}
			expect(text).not.toMatch(/https?:\/\//);
			expect(text).not.toMatch(/@import|url\(/);
		}
		// The script touches only the menu: no network, storage, or cookies.
		expect(MENU_JS).not.toMatch(/fetch|XMLHttpRequest|cookie|localStorage|sessionStorage|eval|innerHTML/);
		// Reduced motion is respected.
		expect(APP_CSS).toContain("prefers-reduced-motion:reduce");
	});
});

describe("/settings", () => {
	it("requires an owner session", async () => {
		const res = await get("/settings");
		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("Location")!).hostname).toBe("accounts.google.com");
		expect(await res.text()).toBe("");
		const forged = await get("/settings", "__Host-GOBRIDGE_SESSION=forged.value");
		expect(forged.status).toBe(302);
		// Read-only: there is nothing to POST to.
		const post = await SELF.fetch(`${BASE}/settings`, { method: "POST", redirect: "manual" });
		expect(post.status).toBe(404);
	});

	it("shows read-only status and no editable settings", async () => {
		mockGoogle();
		await saveAccount(env, {
			alias: "settings-acct",
			email: "settings@example.com",
			refreshToken: "1//fake-google-refresh-token",
			scopes: [...LINK_SCOPES],
			sub: "settings-sub",
		});
		const counter = env.USAGE_COUNTER.get(env.USAGE_COUNTER.idFromName("settings-acct"));
		for (let i = 0; i < 3; i++) await counter.take("send", 25);
		const owner = await signIn("/settings");
		const html = await (await get("/settings", owner.cookie)).text();

		expect(html).toContain("<h1>Settings</h1>");
		expect(html).toContain("25 emails per account per day");
		expect(html).toContain("60 write actions per account per hour");
		expect(html).toContain("2 hours, then you sign in again");
		expect(html).toContain('<span class="badge badge-ok">On</span>');
		expect(html).toContain("settings-acct");
		expect(html).toContain("<td>3 of 25</td>");
		expect(html).toContain("https://gobridge.test");
		// The only form on the page is sign-out (twice: sidebar and top bar).
		expect(html.match(/<form /g)).toHaveLength(2);
		expect(html).not.toMatch(/<input(?![^>]*type="hidden")/);
		for (const secret of [env.GOOGLE_CLIENT_SECRET, env.COOKIE_ENCRYPTION_KEY, env.TOKEN_ENCRYPTION_KEY, "1//"]) {
			expect(html).not.toContain(secret);
		}
		await deleteAccount(env, "settings-acct");
	});
});

describe("/audit read filter", () => {
	it("hides reads by default and shows them, without content, when asked", async () => {
		mockGoogle();
		await runReadTool(env, "list_accounts", {}, { clientId: "client-filter-1", clientName: "Filter Client" });
		const owner = await signIn("/audit");

		const hidden = await (await get("/audit", owner.cookie)).text();
		expect(hidden).toContain("<h1>Recent writes</h1>");
		expect(hidden).toContain('<a href="/audit?reads=show">Show reads too</a>');
		expect(hidden).not.toContain("client-filter-1");

		const shown = await (await get("/audit?reads=show", owner.cookie)).text();
		expect(shown).toContain("<h1>Recent writes and reads</h1>");
		expect(shown).toContain('<a href="/audit">Hide reads</a>');
		expect(shown).toContain("client-filter-1");
		expect(shown).toContain("Filter Client");
		expect(shown).toContain('<strong>list_accounts</strong> <span class="badge">read</span>');
		expect(shown).toMatch(/Items returned: \d+/);
		// The filter is a link, not a form: nothing to submit and no state change.
		expect(shown.match(/<form /g)).toHaveLength(2);
	});
});

describe("attention dot", () => {
	it("is hidden when everything is fine and shown when writes are off", async () => {
		mockGoogle();
		const owner = await signIn();
		const fine = await (await get("/audit", owner.cookie)).text();
		expect(fine).not.toContain('class="dot"');
		expect(fine).not.toContain("needs attention");
		expect(fine).not.toContain("menu-flag");

		for (const value of ["false", "", "TRUE"]) {
			const res = await getWithEnv("/settings", owner.cookie, { WRITES_ENABLED: value });
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html.match(/<span class="dot"><\/span>/g), `"${value}"`).toHaveLength(2);
			expect(html.match(/aria-label="Account \(needs attention\)"/g)).toHaveLength(2);
			expect(html).not.toContain('aria-haspopup="menu" aria-label="Account"');
			expect(html).toContain('<span>Settings</span><span class="menu-flag">Writes off</span>');
			expect(html).toContain('<span class="badge badge-alert">Off</span>');
		}
	});

	it("is shown when a linked account needs re-linking, and clears after re-link", async () => {
		mockGoogle(400);
		const account = {
			alias: "stale-acct",
			email: "stale@example.com",
			refreshToken: "1//fake-google-refresh-token",
			scopes: [...LINK_SCOPES],
			sub: "stale-sub",
		};
		await saveAccount(env, account);
		const owner = await signIn();
		expect(await (await get("/link", owner.cookie)).text()).not.toContain('class="dot"');

		// Google rejects the refresh token during a tool call: the account is flagged.
		const res = await runReadTool(env, "list_labels", { account: "stale-acct" }, { clientId: "client-stale-1" });
		expect(res.content[0].text).toContain("re-link this account at /link");
		expect(await aliasesNeedingRelink(env)).toContain("stale-acct");

		const html = await (await get("/link", owner.cookie)).text();
		expect(html.match(/<span class="dot"><\/span>/g)).toHaveLength(2);
		expect(html).toContain('aria-label="Account (needs attention)"');
		expect(html).toContain('<span class="menu-flag">Re-link needed</span>');
		expect(html).toContain('<span class="badge badge-alert">Needs re-link</span>');
		// "Writes off" wins when both apply.
		const both = await (await getWithEnv("/settings", owner.cookie, { WRITES_ENABLED: "false" })).text();
		expect(both).toContain('<span class="menu-flag">Writes off</span>');
		expect(both).toContain("Needs re-link: stale-acct");

		// A flag for an alias that is not linked is ignored; linking again clears the flag.
		await markNeedsRelink(env, "ghost-acct");
		await saveAccount(env, account);
		expect(await (await get("/link", owner.cookie)).text()).not.toContain('class="dot"');
		await deleteAccount(env, "stale-acct");
		await deleteAccount(env, "ghost-acct");
	});
});

describe("stale scopes", () => {
	it("does not flag an account linked before the profile scope existed", async () => {
		mockGoogle();
		await saveAccount(env, {
			alias: "no-profile",
			email: "noprofile@example.com",
			refreshToken: "1//fake-google-refresh-token",
			scopes: [...TOOL_SCOPES, "openid", "email"],
			sub: "no-profile-sub",
		});
		const owner = await signIn();
		const html = await (await get("/link", owner.cookie)).text();
		expect(html).toContain("no-profile");
		expect(html).not.toContain('class="dot"');
		expect(html).not.toContain("Re-link needed");
		expect(html).not.toContain("Needs re-link");
		// The initial-letter avatar stands in for the missing picture.
		expect(html).toContain('<span class="avatar avatar-22" aria-hidden="true">N</span>');
		const settings = await (await get("/settings", owner.cookie)).text();
		expect(settings).not.toContain("needing re-link");
		await deleteAccount(env, "no-profile");
	});

	it("flags an account missing a scope the tools need, whatever else it has", async () => {
		mockGoogle();
		await saveAccount(env, {
			alias: "no-freebusy",
			email: "nofreebusy@example.com",
			refreshToken: "1//fake-google-refresh-token",
			scopes: [...LINK_SCOPES].filter((s) => !s.endsWith("calendar.freebusy")),
			sub: "no-freebusy-sub",
		});
		const owner = await signIn();
		const html = await (await get("/link", owner.cookie)).text();
		expect(html).toContain("Needs re-link: no-freebusy");
		await deleteAccount(env, "no-freebusy");
	});

	it("flags an account linked with the old scope list as needing re-link", async () => {
		mockGoogle();
		await saveAccount(env, {
			alias: "old-scopes",
			email: "old@example.com",
			refreshToken: "1//fake-google-refresh-token",
			scopes: [...LINK_SCOPES.filter((s) => !s.endsWith("/drive")), "https://www.googleapis.com/auth/drive.readonly"],
			sub: "old-sub",
		});
		const owner = await signIn();
		const html = await (await get("/link", owner.cookie)).text();
		expect(html).toContain('<span class="menu-flag">Re-link needed</span>');
		expect(html).toContain("Needs re-link: old-scopes");
		const settings = await (await get("/settings", owner.cookie)).text();
		expect(settings).toContain("DIRECT_SEND_ENABLED");
		expect(settings).toContain("DRIVE_SHARE_ENABLED");
		await deleteAccount(env, "old-scopes");
	});

	it("shows Feature off when a feature switch is off", async () => {
		mockGoogle();
		const owner = await signIn();
		const html = await (await getWithEnv("/settings", owner.cookie, { FORWARD_ENABLED: "false" } as Partial<Env>)).text();
		expect(html.match(/<span class="dot"><\/span>/g)).toHaveLength(2);
		expect(html).toContain('<span class="menu-flag">Feature off</span>');
		expect(html).toContain("Switched off: FORWARD_ENABLED");
	});
});

describe("sign-out", () => {
	function logout(cookie: string | null, fields: Record<string, string>) {
		return SELF.fetch(`${BASE}/logout`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				...(cookie ? { Cookie: cookie } : {}),
			},
			body: new URLSearchParams(fields).toString(),
		});
	}

	it("rejects logout without CSRF, and GET /logout does not sign out", async () => {
		mockGoogle();
		const owner = await signIn();
		expect((await logout(owner.cookie, {})).status).toBe(403);
		expect((await logout(owner.cookie, { csrf_token: "wrong" })).status).toBe(403);
		const viaGet = await get("/logout", owner.cookie);
		expect(viaGet.status).toBe(405);
		expect(viaGet.headers.get("Allow")).toBe("POST");
		for (const page of OWNER_PAGES) expect((await get(page, owner.cookie)).status).toBe(200);
	});

	it("redirects to the Signed out page and rejects the old cookie afterwards", async () => {
		mockGoogle();
		const owner = await signIn();
		const res = await logout(owner.cookie, { csrf_token: owner.csrf });
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/signed-out");
		expect(res.headers.getSetCookie()).toContain(
			"__Host-GOBRIDGE_SESSION=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0",
		);

		const page = await get("/signed-out");
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("<h1>Signed out</h1>");
		expect(html).toContain('<a class="btn btn-primary" href="/link">Sign in</a>');
		// Public page: nothing about the owner, no menu, no forms.
		expect(html).not.toContain("owner@example.com");
		expect(html).not.toContain("account-menu");
		expect(html).not.toContain("<form");
		// It looks the same with a live or dead cookie.
		expect(await (await get("/signed-out", owner.cookie)).text()).toBe(html);

		for (const ownerPage of OWNER_PAGES) {
			const replay = await get(ownerPage, owner.cookie);
			expect(replay.status, ownerPage).toBe(302);
			expect(new URL(replay.headers.get("Location")!).hostname).toBe("accounts.google.com");
		}
		expect((await logout(owner.cookie, { csrf_token: owner.csrf })).status).toBe(403);
	});
});
