import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { isAllowedEmail } from "./auth";
import { GoogleHandler } from "./google-handler";
import { registerReadTools } from "./read-tools";
import type { Props } from "./utils";
import { registerWriteTools } from "./write-tools";

export class GoBridgeMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "GoBridge",
		version: "0.0.1",
	});

	async init() {
		registerReadTools(this.server, this.env);
		registerWriteTools(this.server, this.env, () => this.props);
	}
}

const mcpHandler = GoBridgeMCP.serve("/mcp");

// Defense in depth: even with a valid GoBridge token, every /mcp request must
// belong to the current ALLOWED_EMAIL (so changing the secret locks out old grants).
const ownerOnlyMcpHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext<Props>) {
		if (!isAllowedEmail(ctx.props?.email, env.ALLOWED_EMAIL)) {
			console.warn("/mcp denied: not_allowed");
			return new Response("Forbidden", { status: 403 });
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
};
