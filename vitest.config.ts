import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc", environment: "dev" },
			miniflare: {
				// Fake values for tests only. These override anything from local config.
				bindings: {
					BASE_URL: "https://gobridge.test",
					WRITES_ENABLED: "true",
					DAILY_SEND_CAP: "25",
					READ_RATE_LIMIT_PER_HOUR: "300",
					GOOGLE_CLIENT_ID: "test-google-client-id",
					GOOGLE_CLIENT_SECRET: "test-google-client-secret",
					ALLOWED_EMAIL: "owner@example.com",
					COOKIE_ENCRYPTION_KEY: "test-cookie-key-not-a-real-secret-0000",
					// 64 hex zeros: a valid key shape that is obviously not a real key.
					TOKEN_ENCRYPTION_KEY: "0".repeat(64),
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
