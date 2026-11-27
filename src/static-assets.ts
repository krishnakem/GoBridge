/**
 * The static files GoBridge serves from its own origin, so the CSP can stay at
 * style-src 'self', script-src 'self' and img-src 'self' (nothing inline, no
 * third-party hosts).
 *
 *   GET /static/app.css        layout and components for every page
 *   GET /static/menu.js        keyboard + click behaviour for the account menu,
 *                              the detail modal and inline rename, and the
 *                              profile-picture fallback
 *   GET /static/logo.svg       the GoBridge logo (MCP connector icon, page brand)
 *   GET /static/logo-256.png   the logo at 256x256 (MCP connector icon)
 *   GET /static/logo-512.png   the logo at 512x512 (MCP connector icon)
 *   GET /static/icon-192.png   opaque square logo at 192x192 (web manifest, MCP icon)
 *   GET /static/icon-512.png   opaque square logo at 512x512 (web manifest)
 *   GET /favicon.ico           opaque square logo as a 16/32/48 px icon
 *   GET /favicon.png           opaque square logo at 64x64
 *   GET /favicon.svg           opaque square logo as SVG
 *   GET /apple-touch-icon.png  opaque square logo at 180x180
 *   GET /site.webmanifest      web app manifest naming the icons above
 *
 * These are public: they contain no data, no secrets, and nothing about the
 * owner. Nothing else is served under /static/, and the five root paths are
 * the only files served outside it. The favicon / manifest set is opaque
 * (favicon services and AI clients composite icons on their own background);
 * logo.svg and logo-256/512.png keep the rounded, transparent artwork. The
 * logo bytes come from assets/logo/,
 * bundled into the Worker as Data modules (wrangler.jsonc "rules"); the
 * derived files are built by scripts/build-favicon.mjs and committed.
 */
import { Hono } from "hono";
import appleTouchIcon from "../assets/logo/apple-touch-icon.png";
import favicon64 from "../assets/logo/favicon-64.png";
import faviconIco from "../assets/logo/favicon.ico";
import faviconSvg from "../assets/logo/favicon.svg";
import icon192 from "../assets/logo/icon-192.png";
import icon512 from "../assets/logo/icon-512.png";
import logo256 from "../assets/logo/logo-256.png";
import logo512 from "../assets/logo/logo-512.png";
import logoSvg from "../assets/logo/logo.svg";

export const APP_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
[hidden]{display:none!important}
body{margin:0;background:#fff;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
code,.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.92em}
a{color:#0369a1}
h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 16px}
h2{font-size:15px;font-weight:600;margin:32px 0 8px}
h3{font-size:13px;font-weight:600;color:#3f3f46;margin:20px 0 10px}
p{margin:0 0 12px}
.muted{color:#71717a}
.small{font-size:13px}
.brand{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;letter-spacing:-.01em}
.brand-logo{width:22px;height:22px;flex:none;border-radius:5px}
.icon{width:18px;height:18px;flex:none}

/* Layout: phone first */
.shell{display:flex;min-height:100vh}
.sidebar{display:none}
.main-col{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;height:52px;padding:0 4px 0 16px;background:#fff;border-bottom:1px solid #e4e4e7}
.content{width:100%;max-width:960px;padding:20px 16px calc(80px + env(safe-area-inset-bottom))}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:10;display:grid;grid-template-columns:repeat(3,1fr);background:#fff;border-top:1px solid #e4e4e7;padding-bottom:env(safe-area-inset-bottom)}
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
.notice,.warn{padding:10px 12px;border-radius:8px;border:1px solid #e4e4e7;background:#f0f9ff;color:#0369a1;margin:0 0 16px}
.warn{background:#fff;border-color:#dc2626;color:#b91c1c}
.badge{display:inline-block;padding:1px 8px;border-radius:9999px;background:#f4f4f5;color:#52525b;font-size:12px;white-space:nowrap}
.badge-ok{background:#f0f9ff;color:#0369a1}
.badge-alert{background:#fff;color:#b91c1c;box-shadow:inset 0 0 0 1px #dc2626}
.btn,button{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;color:#27272a;font:inherit;font-size:14px;font-weight:500;text-decoration:none;cursor:pointer}
.btn:hover,button:hover{background:#fafafa}
.btn:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #0284c7;outline-offset:2px}
.btn-primary{background:#0284c7;border-color:#0284c7;color:#fff}
.btn-primary:hover{background:#0369a1;border-color:#0369a1}
.btn-danger{color:#b91c1c}
.btn-danger-solid{background:#dc2626;border-color:#dc2626;color:#fff}
.btn-danger-solid:hover{background:#b91c1c;border-color:#b91c1c}
form.inline{display:inline}
form.inline input[type=text]{width:8rem;margin-right:4px}
.account-cell{display:inline-flex;align-items:center;gap:8px;max-width:100%}
.account-cell .avatar{flex:none}
.field{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px}
input[type=text],input[type=url]{height:32px;width:14rem;max-width:100%;padding:0 10px;border:1px solid #e4e4e7;border-radius:8px;font:inherit;color:#18181b}
input[type=url]{width:28rem}
select{height:32px;max-width:100%;padding:0 8px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;font:inherit;color:#18181b}
label{font-size:13px;color:#52525b}
.check{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#27272a}
.check input{margin-top:3px}
.stack{display:grid;gap:8px;justify-items:start}
.nowrap{white-space:nowrap}
.facts{display:grid;grid-template-columns:1fr;gap:2px 24px;margin:0 0 12px}
.facts dt{color:#71717a;font-size:13px;margin-top:10px}
.facts dd{margin:0}

/* Cards: linked accounts, AI clients, allowed URLs, usage */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin:0 0 12px}
.card{position:relative;display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px;border:1px solid #e4e4e7;border-radius:12px;background:#fff}
.card form{margin:0}
.card-alert{border-color:#fca5a5}
.card-empty{background:#fafafa}
.card p{margin:0}
/* A card whose title link covers the whole card; its own controls stay clickable above it */
.card-click{transition:border-color .1s}
.card-click:hover{border-color:#a1a1aa}
.card-link{color:inherit;text-decoration:none}
.card-link::after{content:"";position:absolute;inset:0;border-radius:12px}
.card-link:focus-visible{outline:none}
.card-link:focus-visible::after{outline:2px solid #0284c7;outline-offset:2px}
.card-click .icon-btn,.card-click form,.card-click details,.card-click time{position:relative;z-index:1}
/* The "+" card: a <details> whose summary is the whole card until it is opened */
.card-add{border-style:dashed}
.card-add>summary,.card-add>.add-face{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:76px;text-align:center;border-radius:8px;color:#52525b;font-weight:500;cursor:pointer}
.card-add>summary:hover,.card-add:hover>.add-face{color:#18181b}
/* The same card as a link (Add a new AI client): no underline, the usual focus ring */
a.card-add{color:inherit;text-decoration:none}
a.card-add:focus-visible{outline:2px solid #0284c7;outline-offset:2px}
.card-add[open]>summary{flex:none;flex-direction:row;justify-content:flex-start;min-height:0;padding:4px 6px}
.plus .icon{width:28px;height:28px}
.card-add[open] .plus .icon{width:18px;height:18px}
.status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#52525b;white-space:nowrap}
.status-dot{width:8px;height:8px;flex:none;border-radius:9999px;background:#16a34a}
.status-alert{color:#b91c1c}
.status-alert .status-dot{background:#dc2626}
.card-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.has-info .card-head{padding-right:30px}
.card-main{flex:1;min-width:0}
.card-title{display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;min-height:28px}
.card-title strong{font-weight:600;overflow-wrap:anywhere}
.card-sub{color:#71717a;font-size:13px;overflow-wrap:anywhere}
.card-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:auto}
.card-foot .push{margin-left:auto}
.card .field{margin:0}
.card input[type=text],.card input[type=url]{flex:1;width:auto;min-width:0}
.icon-btn{display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:none;color:#71717a;cursor:pointer}
.icon-btn .icon{width:16px;height:16px}
.icon-btn:hover{background:#fafafa;color:#18181b}
.icon-btn:focus-visible{outline:2px solid #0284c7;outline-offset:2px}
.icon-btn-danger:hover,.icon-btn-danger:focus-visible{background:#fef2f2;color:#b91c1c}
/* Disclosures are <details>, so they open without JavaScript */
.disclose>summary{list-style:none;-webkit-user-select:none;user-select:none}
.disclose>summary::-webkit-details-marker{display:none}
.disclose[open]>summary{background:#f4f4f5;color:#18181b}
/* The rename pencil: shown when the alias is hovered or focused; always shown where there is no hover */
.reveal{opacity:0;transition:opacity .1s}
.card-title:hover .reveal,.card-title:focus-within .reveal{opacity:1}
@media (hover:none){.reveal{opacity:1}}
.rename-view{display:inline-flex;align-items:center;gap:4px;min-width:0}
.rename-inline{display:grid;gap:8px;width:100%}
.rename-confirm{display:grid;gap:8px}
.actions{display:flex;flex-wrap:wrap;gap:6px}
/* Two-step confirm: a <details> whose summary looks like a button */
.confirm>summary{display:inline-flex;cursor:pointer}
.confirm>summary.btn-danger{color:#b91c1c}
.confirm form{display:grid;gap:8px;justify-items:start;margin-top:8px;padding:10px;border:1px solid #fca5a5;border-radius:8px;background:#fff}
.card-foot .confirm[open]{flex-basis:100%}
.card-foot .push:has(.confirm[open]){flex-basis:100%;margin-left:0}
.row-details>summary{cursor:pointer;color:#0369a1;font-size:13px}
.row-details>div{margin-top:4px;overflow-wrap:anywhere}
/* Settings sections */
.panel{margin:0 0 16px;padding:16px;border:1px solid #e4e4e7;border-radius:12px}
.panel>h2{margin:0 0 8px}
.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;margin:0 0 12px}
.filters label{display:grid;gap:2px}
.filters .check{display:flex;align-items:center;height:32px}
.filters .check input{margin:0}
/* Detail view: a centered modal card over a dimmed backdrop; near full screen on phones */
.modal-backdrop{position:fixed;inset:0;z-index:50;background:rgba(24,24,27,.45);cursor:default}
.modal{position:fixed;z-index:60;top:8px;right:8px;bottom:8px;left:8px;overflow-y:auto;overscroll-behavior:contain;padding:16px 16px max(20px,env(safe-area-inset-bottom));border-radius:12px;background:#fff;box-shadow:0 20px 40px rgba(0,0,0,.2)}
.modal:focus{outline:none}
.modal-head{display:flex;align-items:flex-start;gap:12px;padding-bottom:16px}
.modal-head h2{margin:0;font-size:17px;overflow-wrap:anywhere}
.modal-head .icon-btn{width:36px;height:36px}
.modal-section{padding:16px 0;border-top:1px solid #f4f4f5}
.modal-section:last-child{padding-bottom:0}
.modal-section h3{margin:0 0 10px}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px}
.section-head h3{margin:0}
.pager{display:flex;align-items:center;gap:4px}
.pager .icon-btn{border:1px solid #e4e4e7}
.pager .icon-btn:disabled{opacity:.4;cursor:default;background:none}
.pager-count{min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.modal-section form{margin:0}
/* Dialogs kept in the page: closed until opened by menu.js (.open) or, without it, by #id (:target) */
.dialog{display:none}
.dialog.open,html:not(.js) .dialog:target{display:block}
.copy-row{display:flex;gap:8px;margin:0 0 16px}
.copy-row input{flex:1;width:auto;min-width:0;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;background:#fafafa}
.segmented{display:flex;gap:2px;padding:2px;margin:0 0 12px;border-radius:8px;background:#f4f4f5}
.segmented button{flex:1;height:28px;padding:0 8px;border:0;border-radius:6px;background:none;color:#52525b;font-size:13px}
.segmented button:hover{background:none;color:#18181b}
.segmented button[aria-selected=true]{background:#fff;color:#18181b;box-shadow:0 1px 2px rgba(24,24,27,.12)}
.setup-app{margin:12px 0 6px}
.tabbed .setup-app{display:none}
.setup-steps{display:grid;gap:6px;margin:0;padding-left:20px;font-size:14px}
.setup-steps code{overflow-wrap:anywhere}
.setup-foot{margin:16px 0 0;padding-top:12px;border-top:1px solid #f4f4f5}
.modal-section .confirm[open]{flex-basis:100%}
.list-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:12px}
.rows{display:grid;gap:12px;margin:0;padding:0;list-style:none}
.row{display:flex;align-items:center;gap:10px;min-width:0}
.row-main{flex:1;min-width:0;overflow-wrap:anywhere}
.rows+p{margin:12px 0 0}
.connections .info-panel{margin:0;padding:12px;border:1px solid #f4f4f5;border-radius:8px}
.info-panel{display:grid;gap:8px;margin:12px 0 0;padding-top:12px;border-top:1px solid #f4f4f5;font-size:13px}
.info-panel dt{color:#71717a;font-size:12px}
.info-panel dd{margin:0;overflow-wrap:anywhere}
.url-list{display:grid;gap:6px}
.client-logo{display:flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;color:#3f3f46;font-size:15px;font-weight:600}
.client-logo svg{width:20px;height:20px}
.logo-claude{fill:#d97757}
.logo-chatgpt{fill:#18181b}
.meters{display:grid;gap:10px}
.meter-top{display:flex;justify-content:space-between;gap:8px;font-size:13px;font-variant-numeric:tabular-nums}
.meter-top span:first-child{color:#52525b}
.meter-track{display:block;height:4px;margin-top:4px;border-radius:9999px;background:#e4e4e7;overflow:hidden}
.meter-fill{display:block;height:100%;border-radius:9999px;background:#0284c7}
.meter-0{width:0}.meter-1{width:10%}.meter-2{width:20%}.meter-3{width:30%}.meter-4{width:40%}.meter-5{width:50%}.meter-6{width:60%}.meter-7{width:70%}.meter-8{width:80%}.meter-9{width:90%}.meter-10{width:100%}
.meter-high .meter-fill{background:#dc2626}

/* Pages without a session */
.simple-main{max-width:420px;margin:0 auto;padding:15vh 20px 40px}
.simple-main .brand{margin-bottom:24px}
.landing-logo{display:block;width:96px;height:96px;margin:0 0 20px}

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
.modal{top:50%;right:auto;bottom:auto;left:50%;width:560px;max-width:calc(100vw - 48px);max-height:calc(100vh - 64px);padding:24px;transform:translate(-50%,-50%)}
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

	// Detail view (modal): the server renders it and makes the page behind it
	// inert, which keeps focus inside. Here: move focus in, and close on
	// Escape by following the Close link (a fixed same-page address).
	var modal = document.querySelector("[data-modal]");
	var target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
	if (modal) {
		var closeLink = modal.querySelector("a[data-modal-close]");
		var field = target && modal.contains(target) ? target.querySelector("input[type=text]") : null;
		(field || modal).focus();
		document.addEventListener("keydown", function (event) {
			if (event.key !== "Escape" || event.defaultPrevented || !closeLink) return;
			// An open confirm inside the modal closes first.
			var open = event.target && event.target.closest ? event.target.closest("details[open]") : null;
			if (open && modal.contains(open)) {
				event.preventDefault();
				open.open = false;
				var summary = open.querySelector("summary");
				if (summary) summary.focus();
				return;
			}
			event.preventDefault();
			window.location.assign(closeLink.getAttribute("href"));
		});
	} else if (target && target.className === "card-link") {
		// After a modal closes, the address names the card that opened it:
		// put focus back there.
		target.focus();
	}

	// Dialogs kept in the page ("Add a new AI client"): open and close in place,
	// so closing leaves the page exactly as it was (no reload, no address
	// change). The page behind is inert while one is open. Without this
	// script the dialog still opens and closes through its #id (CSS :target).
	if (document.documentElement) document.documentElement.className += " js";
	var dialogs = document.querySelectorAll("[data-dialog]");
	Array.prototype.forEach.call(dialogs, function (dialog) {
		var box = dialog.querySelector("[role=dialog]");
		var opener = document.querySelector("[data-dialog-open=" + dialog.id + "]");
		var behind = document.querySelectorAll(".shell, .tabbar");
		var wasInert = [];
		var isOpen = false;
		if (!box) return;
		function open() {
			if (isOpen) return;
			isOpen = true;
			wasInert = Array.prototype.map.call(behind, function (el) {
				var before = el.hasAttribute("inert");
				el.setAttribute("inert", "");
				return before;
			});
			dialog.className = "dialog open";
			box.focus();
		}
		function close() {
			if (!isOpen) return;
			isOpen = false;
			dialog.className = "dialog";
			Array.prototype.forEach.call(behind, function (el, i) {
				if (!wasInert[i]) el.removeAttribute("inert");
			});
			if (opener) opener.focus();
		}
		if (opener) {
			opener.addEventListener("click", function (event) {
				event.preventDefault();
				open();
			});
		}
		Array.prototype.forEach.call(dialog.querySelectorAll("[data-dialog-close]"), function (link) {
			link.addEventListener("click", function (event) {
				event.preventDefault();
				close();
			});
		});
		document.addEventListener("keydown", function (event) {
			if (!isOpen || event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			close();
		});

		// Copy: puts the field's value on the clipboard; the button says
		// "Copied" for two seconds.
		var copy = dialog.querySelector("[data-copy]");
		var field = copy ? document.getElementById(copy.getAttribute("data-copy")) : null;
		if (copy && field) {
			var timer = 0;
			copy.hidden = false;
			field.addEventListener("focus", function () {
				field.select();
			});
			copy.addEventListener("click", function () {
				function show(text) {
					copy.textContent = text;
					clearTimeout(timer);
					timer = setTimeout(function () {
						copy.textContent = "Copy";
					}, 2000);
				}
				function done() {
					show("Copied");
				}
				// The browser refused: leave the URL selected and say how to copy it.
				function fallback() {
					field.select();
					var copied = false;
					try {
						copied = document.execCommand("copy");
					} catch (e) {}
					show(copied ? "Copied" : "Press \u2318C");
				}
				if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(field.value).then(done, fallback);
				else fallback();
			});
		}

		// App tabs: one app's steps at a time. Arrow keys, Home and End move
		// between tabs (and do not reach other arrow-key handlers).
		var tablist = dialog.querySelector("[data-setup-tabs]");
		var tabs = tablist ? tablist.querySelectorAll("[role=tab]") : [];
		function select(index, focus) {
			Array.prototype.forEach.call(tabs, function (tab, i) {
				var on = i === index;
				tab.setAttribute("aria-selected", on ? "true" : "false");
				tab.tabIndex = on ? 0 : -1;
				var panel = document.getElementById(tab.getAttribute("aria-controls"));
				if (panel) panel.hidden = !on;
			});
			if (focus) tabs[index].focus();
		}
		if (tabs.length) {
			tablist.hidden = false;
			box.className += " tabbed";
			Array.prototype.forEach.call(tabs, function (tab, i) {
				tab.addEventListener("click", function () {
					select(i, false);
				});
				tab.addEventListener("keydown", function (event) {
					var to = event.key === "ArrowRight" ? i + 1 : event.key === "ArrowLeft" ? i - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
					if (to === null) return;
					event.preventDefault();
					event.stopPropagation();
					select((to + tabs.length) % tabs.length, true);
				});
			});
			select(0, false);
		}

		// Arrived with the dialog's #id in the address: open it the scripted way.
		if (window.location.hash === "#" + dialog.id) {
			history.replaceState(null, "", window.location.pathname + window.location.search);
			open();
		}
	});

	// One-at-a-time lists (an AI client's registrations): the arrows, the
	// "2 of 15" counter, and the left and right arrow keys while it is shown.
	// Only the hidden flag, disabled state and counter text change.
	var pagers = document.querySelectorAll("[data-pager]");
	Array.prototype.forEach.call(pagers, function (root) {
		var pages = root.querySelectorAll("[data-page]");
		var prev = root.querySelector("[data-page-prev]");
		var next = root.querySelector("[data-page-next]");
		var count = root.querySelector("[data-page-count]");
		if (pages.length < 2 || !prev || !next || !count) return;
		var at = 0;
		function show(index) {
			if (index < 0 || index >= pages.length) return;
			at = index;
			Array.prototype.forEach.call(pages, function (page, i) {
				page.hidden = i !== at;
			});
			prev.disabled = at === 0;
			next.disabled = at === pages.length - 1;
			count.textContent = at + 1 + " of " + pages.length;
			// A button that just became disabled cannot keep focus: hand it over.
			if (document.activeElement === prev && prev.disabled) next.focus();
			if (document.activeElement === next && next.disabled) prev.focus();
		}
		prev.addEventListener("click", function () {
			show(at - 1);
		});
		next.addEventListener("click", function () {
			show(at + 1);
		});
		document.addEventListener("keydown", function (event) {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			var target = event.target;
			if (target && target.closest && target.closest("input, textarea, select, [contenteditable]")) return;
			event.preventDefault();
			show(event.key === "ArrowLeft" ? at - 1 : at + 1);
		});
	});

	// Inline rename on an account card: the pencil turns the alias into a text
	// field. Enter asks for confirmation, Enter again (or the Rename button)
	// saves, Escape cancels. Without this script the pencil is a plain link to
	// the rename form in the detail view. Text is only ever set as text.
	var renames = document.querySelectorAll("[data-rename]");
	Array.prototype.forEach.call(renames, function (root) {
		var opener = root.querySelector("[data-rename-open]");
		var view = root.querySelector("[data-rename-view]");
		var form = root.querySelector("form[data-rename-form]");
		if (!opener || !view || !form) return;
		var input = form.querySelector("input[name=newAlias]");
		var confirm = form.querySelector("[data-rename-confirm]");
		var shown = form.querySelector("[data-rename-new]");
		var cancelButton = form.querySelector("[data-rename-cancel]");
		var submit = confirm ? confirm.querySelector("button[type=submit]") : null;
		if (!input || !confirm || !shown || !submit) return;
		var original = input.value;

		function edit() {
			view.hidden = true;
			form.hidden = false;
			confirm.hidden = true;
			input.readOnly = false;
			input.value = original;
			input.focus();
			input.select();
		}
		function cancel() {
			form.hidden = true;
			view.hidden = false;
			opener.focus();
		}
		opener.addEventListener("click", function (event) {
			event.preventDefault();
			edit();
		});
		function review(event) {
			if (!confirm.hidden) return; // second step: let the form post
			event.preventDefault();
			if (input.value === original) {
				cancel();
				return;
			}
			if (!form.checkValidity()) {
				form.reportValidity();
				return;
			}
			shown.textContent = input.value;
			input.readOnly = true;
			confirm.hidden = false;
			submit.focus();
		}
		form.addEventListener("submit", review);
		form.addEventListener("keydown", function (event) {
			if (event.key === "Enter" && event.target === input) review(event);
			if (event.key !== "Escape") return;
			event.preventDefault();
			cancel();
		});
		if (cancelButton) cancelButton.addEventListener("click", cancel);
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
/** The same hash over raw bytes, for the logo files. */
function bytesHash(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let hash = 0x811c9dc5; // FNV-1a
	for (let i = 0; i < view.length; i++) {
		hash ^= view[i];
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
export const STATIC_VERSION = contentHash(APP_CSS + MENU_JS);

// ---------- Logo files ----------

export type IconFile = {
	/** Exact request path. */
	path: string;
	bytes: ArrayBuffer;
	contentType: string;
	/** Strong ETag: a content hash, so a day-old copy revalidates with a 304. */
	etag: string;
};

function iconFile(path: string, bytes: ArrayBuffer, contentType: string): IconFile {
	return { path, bytes, contentType, etag: `"${bytesHash(bytes)}"` };
}

/** Every logo file GoBridge serves, each at exactly one path. */
export const ICON_FILES: readonly IconFile[] = [
	iconFile("/favicon.ico", faviconIco, "image/x-icon"),
	iconFile("/favicon.png", favicon64, "image/png"),
	iconFile("/apple-touch-icon.png", appleTouchIcon, "image/png"),
	iconFile("/static/logo.svg", logoSvg, "image/svg+xml"),
	iconFile("/static/logo-256.png", logo256, "image/png"),
	iconFile("/static/logo-512.png", logo512, "image/png"),
	iconFile("/favicon.svg", faviconSvg, "image/svg+xml"),
	iconFile("/static/icon-192.png", icon192, "image/png"),
	iconFile("/static/icon-512.png", icon512, "image/png"),
];

/** Changes whenever any logo file changes: the pages link the icons with ?v=<this>. */
export const ICON_VERSION = contentHash(ICON_FILES.map((file) => file.etag).join(""));

/**
 * The web app manifest (GET /site.webmanifest), linked from the public landing
 * page so browsers and favicon crawlers find the opaque 192 / 512 px icons.
 * Fixed text: names and colours only, nothing about the owner. Icon paths are
 * origin-relative, so dev and production each point at themselves.
 */
export const WEB_MANIFEST = JSON.stringify({
	name: "GoBridge",
	short_name: "GoBridge",
	start_url: "/",
	display: "browser",
	theme_color: "#c4261e",
	background_color: "#ffffff",
	icons: [
		{ src: "/static/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
		{ src: "/static/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
	],
});
const MANIFEST_FILE = iconFile(
	"/site.webmanifest",
	new TextEncoder().encode(WEB_MANIFEST).buffer as ArrayBuffer,
	"application/manifest+json",
);

/** A versioned same-origin href for one of the ICON_FILES paths. */
export function iconHref(path: "/favicon.png" | "/apple-touch-icon.png" | "/static/logo.svg"): string {
	return `${path}?v=${ICON_VERSION}`;
}

/** The <link> tags every GoBridge HTML page puts in its <head>. */
export const ICON_LINKS_HTML = `<link rel="icon" href="${iconHref("/favicon.png")}" sizes="64x64" type="image/png">
<link rel="icon" href="${iconHref("/static/logo.svg")}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${iconHref("/apple-touch-icon.png")}">`;

/**
 * The icons advertised in the MCP initialize response (serverInfo.icons), as
 * absolute URLs on this environment's own origin (BASE_URL): dev and
 * production each point at themselves.
 */
export function mcpServerIcons(baseUrl: string): { src: string; mimeType: string; sizes: string[] }[] {
	const absolute = (path: string) => new URL(path, baseUrl).href;
	return [
		{ src: absolute("/static/logo.svg"), mimeType: "image/svg+xml", sizes: ["any"] },
		{ src: absolute("/static/logo-256.png"), mimeType: "image/png", sizes: ["256x256"] },
		{ src: absolute("/static/logo-512.png"), mimeType: "image/png", sizes: ["512x512"] },
		{ src: absolute("/static/icon-192.png"), mimeType: "image/png", sizes: ["192x192"] },
	];
}

// ---------- Routes ----------

const STATIC_HEADERS = {
	// Safe to cache for a day: the pages link each file by content version.
	"Cache-Control": "public, max-age=86400",
	"X-Content-Type-Options": "nosniff",
};

/** True when an If-None-Match header names this ETag (strong or weak form, in a list or "*"). */
function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
	if (!ifNoneMatch) return false;
	return ifNoneMatch.split(",").some((candidate) => {
		const tag = candidate.trim().replace(/^W\//, "");
		return tag === "*" || tag === etag;
	});
}

const app = new Hono<{ Bindings: Env }>();

app.get("/static/app.css", (c) =>
	c.body(APP_CSS, 200, { ...STATIC_HEADERS, "Content-Type": "text/css; charset=utf-8" }),
);
app.get("/static/menu.js", (c) =>
	c.body(MENU_JS, 200, { ...STATIC_HEADERS, "Content-Type": "text/javascript; charset=utf-8" }),
);

for (const file of [...ICON_FILES, MANIFEST_FILE]) {
	app.get(file.path, (c) => {
		const headers: Record<string, string> = { ...STATIC_HEADERS, ETag: file.etag };
		if (file.contentType === "image/svg+xml") {
			// An SVG opened directly is a document: forbid scripts and loads, and
			// sandbox it. Presentation attributes are unaffected; <img> use is too.
			headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
		}
		if (etagMatches(c.req.header("If-None-Match"), file.etag)) {
			return c.body(null, 304, headers);
		}
		return c.body(file.bytes, 200, { ...headers, "Content-Type": file.contentType });
	});
}

export { app as StaticAssets };
