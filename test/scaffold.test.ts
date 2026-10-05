import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Scaffold smoke tests. The full security test list in SPEC.md is added
// milestone by milestone.
describe("scaffold", () => {
	it("rejects /mcp without a token: 401 + WWW-Authenticate", async () => {
		const res = await SELF.fetch("https://gobridge.test/mcp", { method: "POST" });
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
	});

	it("rejects /mcp with a garbage token: 401", async () => {
		const res = await SELF.fetch("https://gobridge.test/mcp", {
			method: "POST",
			headers: { Authorization: "Bearer not-a-real-token" },
		});
		expect(res.status).toBe(401);
	});

	it("returns 404 for unknown routes", async () => {
		const res = await SELF.fetch("https://gobridge.test/definitely-not-a-route");
		expect(res.status).toBe(404);
	});

	it("never issues a grant from /callback before the allowlist exists", async () => {
		const res = await SELF.fetch("https://gobridge.test/callback?code=x&state=y", {
			redirect: "manual",
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.headers.get("Location")).toBeNull();
	});
});
