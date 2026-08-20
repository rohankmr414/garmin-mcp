import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { api, exchange, type OAuth1Token, type OAuth2Token } from "./garmin";
import { authHandler } from "./auth";
import type { Ctx, ToolDef } from "./toolkit";
import { tools as profileTools } from "./tools/profile";
import { tools as activityTools } from "./tools/activities";
import { tools as healthTools } from "./tools/health";
import { tools as trainingTools } from "./tools/training";
import { tools as workoutTools, resources as workoutResources } from "./tools/workouts";
import { tools as nutritionTools } from "./tools/nutrition";
import { tools as communityTools } from "./tools/community";
import { tools as bodyTools } from "./tools/body";
import { tools as analysisTools } from "./tools/analysis";

// Env comes from worker-configuration.d.ts (wrangler types)

// Garmin OAuth1 token arrives per-request from the MCP client's Authorization header
type Props = { oauth1: OAuth1Token };

const ALL_TOOLS: ToolDef[] = [
  ...profileTools,
  ...activityTools,
  ...healthTools,
  ...trainingTools,
  ...workoutTools,
  ...nutritionTools,
  ...communityTools,
  ...bodyTools,
  ...analysisTools,
];

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

export class GarminMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "garmin", version: "0.2.0" });
  private oauth2?: OAuth2Token;
  private dn?: string;
  private principal?: string;

  // drop cached tokens if this request's grant differs from the one they were derived from,
  // so a reused Durable Object never serves one principal's data under another's credential
  private syncPrincipal() {
    if (this.principal !== this.props.oauth1.oauth_token) {
      this.principal = this.props.oauth1.oauth_token;
      this.oauth2 = undefined;
      this.dn = undefined;
    }
  }

  private async accessToken(): Promise<string> {
    this.syncPrincipal();
    if (!this.oauth2 || this.oauth2.expires_at - 300 <= Date.now() / 1000) {
      this.oauth2 = await exchange(this.props.oauth1);
    }
    return this.oauth2.access_token;
  }

  async init() {
    const ctx: Ctx = {
      api: async (path, opts) => api(await this.accessToken(), path, opts),
      displayName: async () => {
        this.syncPrincipal();
        if (!this.dn) {
          const profile = (await api(
            await this.accessToken(),
            "/userprofile-service/socialProfile"
          )) as { displayName: string };
          this.dn = encodeURIComponent(profile.displayName);
        }
        return this.dn;
      },
    };

    const seen = new Set<string>();
    for (const t of ALL_TOOLS) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      if (t.params) {
        this.server.registerTool(
          t.name,
          { description: t.desc, inputSchema: t.params },
          async (args: Record<string, unknown>) => json(await t.run(args, ctx))
        );
      } else {
        this.server.registerTool(t.name, { description: t.desc }, async () =>
          json(await t.run({}, ctx))
        );
      }
    }

    for (const r of workoutResources) {
      this.server.registerResource(r.name, r.uri, { mimeType: "application/json" }, async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: r.text }],
      }));
    }
  }
}

// OAuth 2.1 only: /authorize serves the Garmin connect page; grants carry oauth1 as encrypted
// props; every /mcp request is gated on a provider-validated access token (no raw-header path).
export default new OAuthProvider({
  apiRoute: "/mcp",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: GarminMCP.serve("/mcp") as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: authHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
});
