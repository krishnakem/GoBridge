/**
 * The two static files the HTML pages load, served from this origin so the CSP
 * can stay at style-src 'self' and script-src 'self' (nothing inline).
 *
 *   GET /static/app.css   layout and components for every page
 *   GET /static/menu.js   keyboard + click behaviour for the account menu,
 *                         and the profile-picture fallback
 *
 * These are public: they contain no data, no secrets, and nothing about the
 * owner. Nothing else is served under /static/.
 */
import { Hono } from "hono";

export const APP_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:#18181b;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
code,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:.92em}
a{color:#0369a1}
h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 16px}
h2{font-size:15px;font-weight:600;margin:32px 0 8px}
p{margin:0 0 12px}
.muted{color:#71717a}
.small{font-size:13px}
.brand{font-size:15px;font-weight:600;letter-spacing:-.01em}
.icon{width:18px;height:18px;flex:none}

/* Layout: phone first */
.shell{display:flex;min-height:100vh}
.sidebar{display:none}
.main-col{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;height:52px;padding:0 4px 0 16px;background:#fff;border-bottom:1px solid #e4e4e7}
.content{width:100%;max-width:960px;padding:20px 16px calc(80px + env(safe-area-inset-bottom))}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:10;display:grid;grid-template-columns:repeat(4,1fr);background:#fff;border-top:1px solid #e4e4e7;padding-bottom:env(safe-area-inset-bottom)}
.tabbar a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;height:56px;font-size:11px;color:#71717a;text-decoration:none}
.tabbar a[aria-current=page]{color:#0369a1;font-weight:500}

/* Avatar and attention dot */
.avatar-wrap{position:relative;display:inline-flex;flex:none}
.avatar{position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:9999px;background:#e4e4e7;color:#3f3f46;font-weight:500;font-size:12px;line-height:1}
.avatar-22{width:22px;height:22px;font-size:10px}
.avatar-32{width:32px;height:32px}
/* The picture sits over the initial letter; a broken picture is hidden so the letter shows */
.avatar-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:9999px}
.avatar-img.failed{display:none}
.dot{position:absolute;top:-1px;right:-1px;z-index:1;width:10px;height:10px;border-radius:9999px;background:#dc2626;box-shadow:0 0 0 2px #fff}
.avatar-22+.dot{width:8px;height:8px}

/* Account menu: a <details>, so it opens without JavaScript */
.account-menu{position:relative}
.account-menu>summary{list-style:none;cursor:pointer;-webkit-user-select:none;user-select:none}
.account-menu>summary::-webkit-details-marker{display:none}
.account-menu[open]>summary{position:relative;z-index:35}
.avatar-button{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:9999px}
.avatar-button:focus-visible{outline:2px solid #0284c7;outline-offset:2px}
.account-row{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 8px;border-radius:6px;font-size:14px;color:#3f3f46}
.account-row:hover,.account-menu[open]>.account-row{background:#fafafa}
.account-row:focus-visible{outline:2px solid #0284c7}
.account-row .avatar-wrap{margin-left:-2px}
.account-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu-backdrop{position:fixed;inset:0;z-index:30;background:rgba(24,24,27,.2)}
.menu{position:fixed;left:0;right:0;bottom:0;z-index:40;background:#fff;border-top:1px solid #e4e4e7;border-radius:12px 12px 0 0;padding-top:8px;padding-bottom:max(8px,env(safe-area-inset-bottom))}
.menu form{margin:0}
.menu-header{padding:10px 16px;font-size:14px;color:#71717a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu-divider{height:1px;margin:4px 0;background:#f4f4f5}
.menu-item{display:flex;align-items:center;justify-content:space-between;width:100%;height:48px;padding:0 16px;margin:0;border:0;border-radius:0;background:none;font:inherit;font-size:15px;color:#27272a;text-align:left;text-decoration:none;cursor:pointer}
.menu-item:hover,.menu-item:focus{background:#fafafa;outline:none}
.nav-flag{margin-left:auto;font-size:12px;color:#b91c1c;white-space:nowrap}

/* Content components */
.table-wrap{overflow-x:auto;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-size:12px;font-weight:500;color:#71717a;text-align:left;padding:8px 16px 8px 0;border-bottom:1px solid #e4e4e7;white-space:nowrap}
td{padding:10px 16px 10px 0;border-bottom:1px solid #f4f4f5;vertical-align:top;overflow-wrap:break-word}
td:last-child,th:last-child{padding-right:0}
.notice,.warn{padding:10px 12px;border-radius:6px;border:1px solid #e4e4e7;background:#f0f9ff;color:#0369a1;margin:0 0 16px}
.warn{background:#fff;border-color:#dc2626;color:#b91c1c}
.badge{display:inline-block;padding:1px 8px;border-radius:9999px;background:#f4f4f5;color:#52525b;font-size:12px;white-space:nowrap}
.badge-ok{background:#f0f9ff;color:#0369a1}
.badge-alert{background:#fff;color:#b91c1c;box-shadow:inset 0 0 0 1px #dc2626}
.btn,button{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border:1px solid #e4e4e7;border-radius:6px;background:#fff;color:#27272a;font:inherit;font-size:14px;font-weight:500;text-decoration:none;cursor:pointer}
.btn:hover,button:hover{background:#fafafa}
.btn:focus-visible,button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid #0284c7;outline-offset:2px}
.btn-primary{background:#0284c7;border-color:#0284c7;color:#fff}
.btn-primary:hover{background:#0369a1;border-color:#0369a1}
.btn-danger{color:#b91c1c}
form.inline{display:inline}
form.inline input[type=text]{width:8rem;margin-right:4px}
.account-cell{display:inline-flex;align-items:center;gap:8px;max-width:100%}
.account-cell .avatar{flex:none}
.field{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px}
input[type=text]{height:32px;width:14rem;max-width:100%;padding:0 10px;border:1px solid #e4e4e7;border-radius:6px;font:inherit;color:#18181b}
.facts{display:grid;grid-template-columns:1fr;gap:2px 24px;margin:0 0 12px}
.facts dt{color:#71717a;font-size:13px;margin-top:10px}
.facts dd{margin:0}

/* Pages without a session */
.simple-main{max-width:420px;margin:0 auto;padding:15vh 20px 40px}
.simple-main .brand{margin-bottom:24px}

@media (min-width:768px){
.sidebar{display:flex;flex-direction:column;position:sticky;top:0;flex:none;width:224px;height:100vh;background:#fff;border-right:1px solid #e4e4e7}
.sidebar .brand{padding:20px 16px 16px}
.side-nav{display:flex;flex-direction:column;gap:2px;padding:0 8px}
.side-nav a{display:flex;align-items:center;gap:10px;height:36px;padding:0 8px;border-radius:6px;font-size:14px;color:#52525b;text-decoration:none;transition:color .1s,background-color .1s}
.side-nav a:hover{background:#fafafa;color:#18181b}
.side-nav a[aria-current=page]{background:#f0f9ff;color:#0369a1;font-weight:500}
.side-account{margin-top:auto;padding:8px 8px 12px}
.topbar,.tabbar,.menu-backdrop{display:none}
.content{padding:32px 40px 48px}
.menu{position:absolute;left:0;right:auto;bottom:100%;width:256px;margin-bottom:4px;padding:4px 0;border:1px solid #e4e4e7;border-radius:8px;box-shadow:0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1)}
.menu-header{padding:8px 12px}
.menu-item{height:36px;padding:0 12px;font-size:14px}
.facts{grid-template-columns:220px 1fr}
.facts dt{margin-top:0;font-size:14px}
.facts dt,.facts dd{padding:8px 0;border-bottom:1px solid #f4f4f5}
}

@media (prefers-reduced-motion:reduce){
*,*::before,*::after{transition:none!important;animation:none!important}
}
`;

export const MENU_JS = `(function () {
	"use strict";
	// Profile pictures: hide any that fail to load so the initial letter shows.
	var pictures = document.querySelectorAll("img.avatar-img");
	Array.prototype.forEach.call(pictures, function (img) {
		function failed() {
			img.className += " failed";
		}
		img.addEventListener("error", failed);
		// Already finished (before this script ran) without any pixels: broken.
		if (img.complete && img.naturalWidth === 0) failed();
	});

	var menus = document.querySelectorAll("details[data-account-menu]");
	Array.prototype.forEach.call(menus, function (details) {
		var trigger = details.querySelector("summary");
		var menu = details.querySelector("[role=menu]");
		if (!trigger || !menu) return;

		function items() {
			return Array.prototype.slice.call(menu.querySelectorAll("[role=menuitem]"));
		}
		function close(returnFocus) {
			if (!details.open) return;
			details.open = false;
			if (returnFocus) trigger.focus();
		}

		trigger.setAttribute("aria-expanded", "false");
		details.addEventListener("toggle", function () {
			trigger.setAttribute("aria-expanded", details.open ? "true" : "false");
			if (details.open) {
				var first = items()[0];
				if (first) first.focus();
			}
		});

		details.addEventListener("keydown", function (event) {
			if (!details.open) return;
			if (event.key === "Escape") {
				event.preventDefault();
				close(true);
				return;
			}
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			var list = items();
			if (!list.length) return;
			event.preventDefault();
			var index = list.indexOf(document.activeElement);
			var next;
			if (index === -1) next = event.key === "ArrowDown" ? 0 : list.length - 1;
			else next = event.key === "ArrowDown" ? index + 1 : index - 1;
			list[(next + list.length) % list.length].focus();
		});

		// Tabbing out of the menu closes it.
		details.addEventListener("focusout", function (event) {
			var to = event.relatedTarget;
			if (details.open && to && !details.contains(to)) close(false);
		});

		// Clicking outside, or tapping the phone backdrop, closes it.
		document.addEventListener("click", function (event) {
			if (!details.open) return;
			var target = event.target;
			var onBackdrop = target && target.closest && target.closest("[data-menu-close]");
			if (!details.contains(target) || onBackdrop) close(false);
		});
	});
})();
`;

/**
 * A short content hash, so the pages can link /static/app.css?v=<hash> and a
 * browser never keeps an old stylesheet or script after a deploy.
 */
function contentHash(text: string): string {
	let hash = 0x811c9dc5; // FNV-1a
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
export const STATIC_VERSION = contentHash(APP_CSS + MENU_JS);

const STATIC_HEADERS = {
	// Safe to cache for a day: the pages link each file by content version.
	"Cache-Control": "public, max-age=86400",
	"X-Content-Type-Options": "nosniff",
};

const app = new Hono<{ Bindings: Env }>();

app.get("/static/app.css", (c) =>
	c.body(APP_CSS, 200, { ...STATIC_HEADERS, "Content-Type": "text/css; charset=utf-8" }),
);
app.get("/static/menu.js", (c) =>
	c.body(MENU_JS, 200, { ...STATIC_HEADERS, "Content-Type": "text/javascript; charset=utf-8" }),
);

export { app as StaticAssets };
