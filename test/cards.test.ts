import { describe, expect, it } from "vitest";
import { clientLogoHtml, KNOWN_CLIENTS, knownClientFor } from "../src/client-logos";
import { ICONS } from "../src/html";
import { meterHtml } from "../src/components";

describe("client logos", () => {
	it("recognises a client by the host of its redirect URLs, never by its name", () => {
		expect(knownClientFor(["https://claude.ai/api/mcp/auth_callback"])?.name).toBe("Claude");
		expect(knownClientFor(["https://claude.com/api/mcp/auth_callback"])?.name).toBe("Claude");
		expect(knownClientFor(["https://chatgpt.com/connector_platform_oauth_redirect"])?.name).toBe("ChatGPT");
		// A client that only calls itself Claude gets the letter tile.
		const fake = clientLogoHtml(["https://evil.example/cb"], "Claude");
		expect(fake).toBe('<span class="client-logo" aria-hidden="true">C</span>');
	});

	it("gives no logo unless every URL is https on a host of the same known client", () => {
		for (const uris of [
			[],
			["https://claude.ai/cb", "https://evil.example/cb"],
			["https://claude.ai/cb", "https://chatgpt.com/cb"],
			["http://claude.ai/cb"],
			["https://claude.ai:8443/cb"],
			["https://claude.ai.evil.example/cb"],
			["https://evil.example/claude.ai"],
			["https://sub.claude.ai/cb"],
			["https://claude.ai@evil.example/cb"],
			["not a url"],
		]) {
			expect(knownClientFor(uris), uris.join(" ")).toBeNull();
		}
	});

	it("escapes the fallback letter and falls back to ? for an empty name", () => {
		expect(clientLogoHtml([], "<script>")).toBe('<span class="client-logo" aria-hidden="true">&lt;</span>');
		expect(clientLogoHtml([], "  ")).toBe('<span class="client-logo" aria-hidden="true">?</span>');
	});

	it("keeps logo and icon markup inert: path data only, nothing loaded or run", () => {
		for (const client of KNOWN_CLIENTS) {
			expect(client.path, client.name).toMatch(/^[MmLlHhVvCcSsAaZz0-9 .\-]+$/);
			expect(client.className).toMatch(/^logo-[a-z]+$/);
		}
		const markup =
			clientLogoHtml(["https://claude.ai/cb"], "x") +
			clientLogoHtml(["https://chatgpt.com/cb"], "x") +
			Object.values(ICONS).join("");
		expect(markup).not.toMatch(/https?:|url\(|<script|\sstyle=|\son[a-z]+=|href|xmlns|<image|<use|<foreignObject/i);
	});
});

describe("usage meters", () => {
	it("fills in tenths, never empty when something was used, never past full", () => {
		expect(meterHtml("Sent", 0, 25)).toContain("meter-fill meter-0");
		expect(meterHtml("Sent", 1, 300)).toContain("meter-fill meter-1");
		expect(meterHtml("Sent", 12, 25)).toContain("meter-fill meter-5");
		expect(meterHtml("Sent", 999, 25)).toContain("meter-fill meter-10");
		expect(meterHtml("Sent", 3, 0)).toContain("meter-fill meter-10");
	});

	it("turns red from 90% and says unavailable when the count cannot be read", () => {
		expect(meterHtml("Sent", 22, 25)).not.toContain("meter-high");
		expect(meterHtml("Sent", 23, 25)).toContain('<div class="meter-high">');
		expect(meterHtml("Sent", undefined, 25)).toContain("<span>unavailable</span>");
	});
});
