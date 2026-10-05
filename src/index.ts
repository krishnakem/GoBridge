import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GoogleHandler } from "./google-handler";
import type { Props } from "./utils";

export class GoBridgeMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "GoBridge",
		version: "0.0.1",
	});

	async init() {
		// Tools are added in later milestones (read tools: step 4, write tools: step 5).
	}
}

function createProvider(env: Env) {
	return new OAuthProvider({
		apiHandler: GoBridgeMCP.serve("/mcp"),
		apiRoute: "/mcp",
		authorizeEndpoint: "/authorize",
		clientRegistrationEndpoint: "/register",
		defaultHandler: GoogleHandler as any,
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
