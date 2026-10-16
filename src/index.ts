import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { checkClient } from "./allowed-clients";
import { isAllowedEmail } from "./auth";
import { GoogleHandler } from "./google-handler";
import { purgeOldAudit } from "./guardrails";
import { mcpServerIcons } from "./static-assets";
import type { Props } from "./utils";
import { registerTools } from "./tools";

export { UsageCounter } from "./usage-counter";

export class GoBridgeMCP extends McpAgent<Env, Record<string, never>, Props> {
	// serverInfo for the MCP initialize response. The icons are absolute URLs
	// on this environment's own origin (BASE_URL), served by src/static-assets.ts.
	server = new McpServer({
		name: "GoBridge",
		title: "GoBridge",
		version: "0.0.1",
		websiteUrl: this.env.BASE_URL,
		icons: mcpServerIcons(this.env.BASE_URL),
	});

	async init() {
		registerTools(this.server, this.env, () => this.props);
	}
}

const mcpHandler = GoBridgeMCP.serve("/mcp");

// Defense in depth: even with a valid GoBridge token, every /mcp request must
// belong to the current ALLOWED_EMAIL (so changing the secret locks out old grants)
// and come from a client that is still on the owner's allowed list (/settings),
// so removing a client's redirect URL cuts it off at once. Both fail closed.
const ownerOnlyMcpHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext<Props>) {
		if (!isAllowedEmail(ctx.props?.email, env.ALLOWED_EMAIL)) {
			console.warn("/mcp denied: not_allowed");
			return new Response("Forbidden", { status: 403 });
		}
		const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;
		const clientId = ctx.props?.clientId;
		const client = helpers && clientId ? await helpers.lookupClient(clientId) : null;
		const verdict = await checkClient(env, client);
		if (!verdict.ok) {
			console.warn(`/mcp denied: client_${verdict.reason} client=${clientId ?? "unknown"}`);
			return new Response(
				verdict.reason === "list_unavailable"
					? "GoBridge could not check its list of allowed apps. Try again in a moment."
					: "Forbidden: this AI client is not on GoBridge's allowed list. The owner can add its redirect URL on /settings.",
				{ status: verdict.reason === "list_unavailable" ? 503 : 403 },
			);
		}
		return mcpHandler.fetch(request, env, ctx);
	},
};

function createProvider(env: Env) {
	return new OAuthProvider({
		apiHandler: ownerOnlyMcpHandler as any,
		apiRoute: "/mcp",
		authorizeEndpoint: "/authorize",
		clientRegistrationEndpoint: "/register",
		defaultHandler: GoogleHandler as any,
		// Replace the library's default error log (which includes a free-text
		// description) with status + error code only.
		onError({ code, status }) {
			console.warn(`oauth error: status=${status} code=${code}`);
		},
		// Tokens are audience-bound to this environment's own /mcp URL.
		resourceMetadata: {
			resource: `${env.BASE_URL}/mcp`,
			resource_name: "GoBridge",
		},
		tokenEndpoint: "/token",
	});
}

let provider: ReturnType<typeof createProvider> | undefined;

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		provider ??= createProvider(env);
		return provider.fetch(request, env, ctx);
	},

	// Daily cron: delete audit rows older than 90 days.
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
		try {
			const deleted = await purgeOldAudit(env);
			console.log(`cron audit_cleanup ok: deleted=${deleted}`);
		} catch (_e) {
			console.error("cron audit_cleanup error: internal");
		}
	},
};
