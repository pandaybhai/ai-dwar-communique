import type { SupabaseClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CORS_HEADERS,
  bearerToken,
  unauthorized,
  verifyMcpToken,
  type McpCaller,
  type TokenVerifier,
} from "@/lib/mcp-auth.server";
import {
  mcpAccessOn,
  mcpUseAllowed,
  memberWorkspaces,
  pickWorkspace,
  takeCallRate,
  type Workspace,
} from "@/lib/mcp-access.server";
import { MCP_TOOLS, type ToolContext, type ToolDef, type ToolOutcome } from "@/lib/mcp-tools.server";
import { ROUND2_TOOLS } from "@/lib/mcp-tools-r2.server";

/** Batch 52's tools and Batch 54's round 2, in the order clients list them. */
export const ALL_MCP_TOOLS: ToolDef[] = [...MCP_TOOLS, ...ROUND2_TOOLS];

/**
 * Batch 52: AiDwar MCP over Streamable HTTP, stateless — a new McpServer and
 * transport per request (JSON responses, no sessions), so it runs on the
 * Worker like every other route. The request is authenticated before the
 * SDK sees it; each tool call then passes, in order:
 *   the per-person rate limit -> the workspace (a membership; asked for when
 *   there are several) -> the mcp_access kill switch -> mcp.use -> the tool's
 *   own permission -> the tool -> an activity_log row for every change.
 */

export const SERVER_INFO = { name: "aidwar", title: "AiDwar", version: "1.0.0" };

export const INSTRUCTIONS =
  "AiDwar is a WhatsApp business platform (campaigns, chat flows, an AI employee called Aiden, a shared inbox). " +
  "You act as the signed-in user, with exactly their permissions. Read freely. To send a campaign: create_campaign_draft, " +
  "show the user the recipients, cost and wallet, and call send_campaign only after they clearly confirm. To switch a flow on: " +
  "create_flow_draft, show the steps, and call activate_flow only after they confirm. The same for templates (create_template_draft, " +
  "then submit_template), scheduled campaigns (preview_campaign_change, then update_scheduled_campaign or cancel_scheduled_campaign), " +
  "tags (tag_contacts without, then with its confirm_code) and Aiden's questions (answer_aiden_question): a confirm_code is used only " +
  "after the user clearly confirms what the preview showed. An answer to Aiden must be the user's own words, passed exactly. " +
  "Never invent figures: if a tool says there is no data, say so. You cannot message individual customers yourself, " +
  "change Aiden's mode, billing, team, keys or settings, or delete anything — point the user to the AiDwar link instead.";

export type McpDeps = {
  verifier: TokenVerifier;
  /** Service-role client (permission checks and the app's write paths). */
  service: SupabaseClient;
  /** A client acting with this access token (reads under RLS). */
  userClient: (token: string) => SupabaseClient;
  /** The OAuth client's display name, when known. */
  clientName?: (clientId: string) => Promise<string | null>;
  now?: () => number;
  confirmSecret?: string;
};

function result(outcome: ToolOutcome): CallToolResult {
  if (!outcome.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: outcome.data ? `${outcome.error}\n\n${JSON.stringify(outcome.data, null, 2)}` : outcome.error,
        },
      ],
    };
  }
  return {
    content: [{ type: "text", text: `${outcome.summary}\n\n${JSON.stringify(outcome.data, null, 2)}` }],
    structuredContent: outcome.data,
  };
}

function workspaceList(ws: Workspace[]) {
  return { workspaces: ws.map((w) => ({ workspace_id: w.id, name: w.name, role: w.role })) };
}

/** One tool call, with every gate. Exported for tests. */
export async function runTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  env: { caller: McpCaller & { clientName: string | null }; deps: McpDeps; user: SupabaseClient; origin: string },
): Promise<ToolOutcome> {
  const { deps, caller } = env;
  const service = deps.service;
  const rate = await takeCallRate(service, caller.userId);
  if (!rate.allowed)
    return { ok: false, error: `Too many AiDwar requests: at most 60 a minute. Try again in ${rate.retryAfter} seconds.` };

  const workspaces = await memberWorkspaces(env.user, caller.userId);
  const pick = pickWorkspace(workspaces, (args["workspace_id"] as string | undefined) ?? null);
  let workspace: Workspace | null = null;
  if (pick.ok) workspace = pick.workspace;
  else if (!tool.noWorkspace || pick.reason === "not_member") {
    if (pick.reason === "none") return { ok: false, error: "Your AiDwar account isn't a member of any workspace yet." };
    if (pick.reason === "not_member")
      return { ok: false, error: "You aren't a member of that workspace. Use list_workspaces to see yours.", data: workspaceList(workspaces) };
    return {
      ok: false,
      error: "You belong to several workspaces. Ask the user which one, then call again with workspace_id.",
      data: workspaceList(workspaces),
    };
  }

  const now = deps.now ?? Date.now;
  const ctx: ToolContext = {
    caller,
    service,
    user: env.user,
    origin: env.origin,
    now,
    workspace: workspace ?? { id: "", name: "", role: "" },
    workspaces,
    permissions: new Set(),
    ...(deps.confirmSecret ? { confirmSecret: deps.confirmSecret } : {}),
  };

  if (workspace) {
    if (!(await mcpAccessOn(service, workspace.id)))
      return {
        ok: false,
        error: `AiDwar MCP is switched off for ${workspace.name}. Your AI assistant can't use this workspace until AiDwar support switches it back on.`,
      };
    const { resolveEffectivePermissions } = await import("@/lib/permissions.server");
    const perms = await resolveEffectivePermissions(service, workspace.id, caller.userId);
    if (!(await mcpUseAllowed(service, perms.keys)))
      return { ok: false, error: `You don't have permission to use AiDwar from an AI assistant in ${workspace.name}. Ask an owner or admin.` };
    ctx.permissions = new Set(perms.keys);
  }

  let outcome: ToolOutcome;
  try {
    outcome = await tool.run(ctx, args);
  } catch (error) {
    console.error(JSON.stringify({ at: "mcp_tool_failed", tool: tool.name, error: error instanceof Error ? error.message : String(error) }));
    outcome = { ok: false, error: "Something went wrong in AiDwar. Nothing was sent; please try again." };
  }

  if (outcome.ok && outcome.audit && workspace) {
    const { logServerActivity } = await import("@/lib/whatsapp-api.server");
    await logServerActivity(service, workspace.id, caller.userId, outcome.audit.action, {
      source: "mcp",
      tool: tool.name,
      client_id: caller.clientId,
      client_name: caller.clientName,
      object_id: outcome.audit.objectId,
      ...(outcome.audit.details ?? {}),
    });
  }
  return outcome;
}

type ToolRegistrar = {
  registerTool: (
    name: string,
    config: Record<string, unknown>,
    cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ) => unknown;
};

export function buildMcpServer(env: {
  caller: McpCaller & { clientName: string | null };
  deps: McpDeps;
  user: SupabaseClient;
  origin: string;
}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    // No elicitation or output schemas here: a validator that never compiles
    // code keeps the SDK off Ajv (code generation isn't allowed on Workers).
    jsonSchemaValidator: {
      getValidator: () => (input: unknown) => ({ valid: true, data: input, errorMessage: undefined }),
    } as never,
  });
  // Typed loosely on purpose: the SDK's zod generics make the checker run out
  // of memory; the schemas are still the tools' own zod shapes at runtime.
  const registrar = server as unknown as ToolRegistrar;
  for (const tool of ALL_MCP_TOOLS) {
    registrar.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive,
          idempotentHint: tool.readOnly,
          openWorldHint: false,
        },
      },
      async (args) => result(await runTool(tool, args ?? {}, env)),
    );
  }
  return server;
}

const withCors = (res: Response): Response => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

/** /mcp: OPTIONS, the 401 challenge, then one stateless MCP exchange. */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const origin = new URL(request.url).origin;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const token = bearerToken(request);
  const check = await verifyMcpToken(token, { ...deps.verifier, ...(deps.now ? { now: deps.now } : {}) });
  if (!check.ok) return unauthorized(origin, token ? { error: check.error, description: check.description } : undefined);

  if (request.method !== "POST") {
    // Stateless: no server-to-client stream and no session to end.
    return withCors(
      Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: AiDwar MCP is stateless; POST JSON-RPC to /mcp." }, id: null },
        { status: 405, headers: { allow: "POST, OPTIONS" } },
      ),
    );
  }

  const clientName = deps.clientName ? await deps.clientName(check.caller.clientId).catch(() => null) : null;
  const { APP_PUBLIC_URL } = await import("@/lib/app-url");
  const env = {
    caller: { ...check.caller, clientName },
    deps,
    user: deps.userClient(token!),
    // Links in answers go to the live site (as every outbound link does);
    // the resource metadata above keeps the address the client used.
    origin: APP_PUBLIC_URL,
  };
  const server = buildMcpServer(env);
  // No sessionIdGenerator = stateless (no Mcp-Session-Id).
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(request, {
      authInfo: { token: token!, clientId: check.caller.clientId, scopes: [], extra: { userId: check.caller.userId } },
    });
    return withCors(res);
  } finally {
    void server.close().catch(() => undefined);
  }
}

/** The real dependencies: the project's Supabase Auth and clients. */
export async function liveMcpDeps(): Promise<McpDeps> {
  const { supabaseTokenVerifier } = await import("@/lib/mcp-auth.server");
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { createClient } = await import("@supabase/supabase-js");
  const url = new URL(process.env["AIDWAR_SUPABASE_URL"] ?? "").origin;
  const anon =
    process.env["AIDWAR_SUPABASE_ANON_KEY"] ??
    (import.meta.env?.["VITE_AIDWAR_SUPABASE_ANON_KEY"] as string | undefined) ??
    "";
  const service = getServiceClient();
  const names = new Map<string, string | null>();
  return {
    verifier: await supabaseTokenVerifier(),
    service,
    userClient: (token) =>
      createClient(url, anon, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    clientName: async (clientId) => {
      if (names.has(clientId)) return names.get(clientId) ?? null;
      const { data } = await service.auth.admin.oauth.getClient(clientId);
      const name = (data as { client_name?: string | null } | null)?.client_name ?? null;
      names.set(clientId, name);
      return name;
    },
  };
}
