// mcp (#307; API-07, API-08, AUD-01): the MCP server for AI assistants, read-only v1. A
// remote MCP server over Streamable HTTP (JSON responses only, no SSE stream, no
// sessions) at /functions/v1/mcp, answering initialize, ping, tools/list and tools/call.
//
// Authorization follows the MCP spec: OAuth 2.1 with Supabase Auth as the authorization
// server ([auth.oauth_server] in config.toml). A request without a valid token gets 401
// with `WWW-Authenticate: Bearer resource_metadata=...`, pointing at this server's
// Protected Resource Metadata (RFC 9728, GET .../mcp/.well-known/oauth-protected-resource),
// which names Auth as the authorization server; the assistant registers itself there,
// sends the person to the dashboard's consent page, and comes back with a token. The token
// is checked with Auth (GET /auth/v1/user: signature, expiry, a live session) and must be
// one Auth issued to an OAuth client (a `client_id` claim): a dashboard session token is
// refused, as tokens not issued for this server must be.
//
// The database does the rest, as the service role: public.mcp_call(person, client, aal,
// tool, arguments) checks the org's AI assistant access and the person's rate limit, runs
// the tool as the person and audit-logs it (20261105600000_mcp_server.sql). This function
// never sends the token anywhere but Auth.
//
// Locally it is served at http://127.0.0.1:<api port>/functions/v1/mcp. JWT verification
// is off for this function (supabase/config.toml) so the 401 can carry the header above.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { instructions, protocolVersions, toolNames, tools } from "./tools.ts";

const MAX_BODY = 64 * 1024;
const SERVER_INFO = { name: "ai-proctor", title: "AI Proctor", version: "1.0.0" };
const WELL_KNOWN = "/.well-known/oauth-protected-resource";

type Json = Record<string, unknown>;
type Id = string | number | null;

// Any origin may call: the server takes only a bearer token in a header (no cookies), so
// a page can't make a browser act for someone, and it isn't a local server a DNS rebinding
// attack could reach. Browser-based MCP clients need these headers.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS,
      ...headers,
    },
  });
}

function rpcError(id: Id, code: number, message: string, status = 200) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

/** The path below the function: "" for the MCP endpoint (locally /mcp, behind the gateway
 * /functions/v1/mcp). */
function subPath(pathname: string): string | null {
  const m = /^(?:\/functions\/v1)?\/mcp(\/.*)?$/.exec(pathname);
  return m ? (m[1] ?? "").replace(/\/+$/, "") : null;
}

/** The public origin people reach the backend at. Behind the local gateway the function
 * sees an internal URL, so the gateway's forwarded headers win; MCP_PUBLIC_URL (set at
 * deploy) wins over both. */
function publicOrigin(req: Request): string {
  const configured = Deno.env.get("MCP_PUBLIC_URL");
  if (configured) return configured.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    const port = req.headers.get("x-forwarded-port");
    const withPort =
      port &&
      !host.includes(":") &&
      !(proto === "https" && port === "443") &&
      !(proto === "http" && port === "80")
        ? `${host}:${port}`
        : host;
    return `${proto}://${withPort}`;
  }
  return (Deno.env.get("SUPABASE_URL") ?? new URL(req.url).origin).replace(/\/+$/, "");
}

function resourceUrl(origin: string) {
  return `${origin}/functions/v1/mcp`;
}

function unauthorized(origin: string, error?: { code: string; description: string }) {
  const params = [`resource_metadata="${resourceUrl(origin)}${WELL_KNOWN}"`, `scope="email"`];
  if (error) {
    params.unshift(`error="${error.code}"`, `error_description="${error.description}"`);
  }
  return json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: error?.description ?? "Sign in to AI Proctor: connect this assistant with OAuth.",
      },
    },
    401,
    { "WWW-Authenticate": `Bearer ${params.join(", ")}` },
  );
}

/** The token's claims, without checking them (Auth has already checked the token). */
function claimsOf(token: string): Json | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const text = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(text, (c) => c.charCodeAt(0))),
    );
    return typeof claims === "object" && claims !== null ? claims : null;
  } catch {
    return null;
  }
}

interface Caller {
  userId: string;
  clientId: string;
  aal: string;
}

/** The person and assistant behind a token, or why it is refused. */
async function authenticate(token: string): Promise<Caller | { refused: string }> {
  const claims = claimsOf(token);
  const clientId = typeof claims?.client_id === "string" ? claims.client_id : "";
  if (!claims) return { refused: "The access token is not valid." };
  if (!clientId) {
    return {
      refused:
        "This server takes tokens AI Proctor issued to an AI assistant. Connect the assistant with OAuth.",
    };
  }
  const auth = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user || data.user.id !== claims.sub) {
    return { refused: "The access token is not valid or has expired." };
  }
  return {
    userId: data.user.id,
    clientId,
    aal: typeof claims.aal === "string" ? claims.aal : "aal1",
  };
}

async function callTool(caller: Caller, name: string, args: unknown) {
  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const { data, error } = await db.rpc("mcp_call", {
    p_user_id: caller.userId,
    p_client_id: caller.clientId,
    p_aal: caller.aal,
    p_tool: name,
    p_args: args ?? {},
  });
  if (error) {
    console.error("mcp_call", name, error.message);
    return toolError("Something went wrong in AI Proctor. Try again later.");
  }
  const reply = data as {
    ok: boolean;
    result?: Json;
    error?: { code: string; message: string };
  };
  if (!reply.ok || !reply.result) {
    return toolError(reply.error?.message ?? "The tool failed.", reply.error?.code);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(reply.result) }],
    structuredContent: reply.result,
    isError: false,
  };
}

/** A tool's own failure, which the model sees and can act on (MCP: not a protocol error). */
function toolError(message: string, code?: string) {
  return {
    content: [{ type: "text", text: code ? `${message} (${code})` : message }],
    isError: true,
  };
}

async function handle(message: Json, caller: Caller): Promise<Json | null> {
  const id = (message.id ?? null) as Id;
  const method = message.method;
  const params = (message.params ?? {}) as Json;
  // Notifications (no id) and responses get no reply.
  if (!("id" in message)) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok({
        protocolVersion: protocolVersions.includes(asked) ? asked : protocolVersions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !toolNames.has(name)) {
        return err(-32602, `Unknown tool: ${String(name)}`);
      }
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return ok(toolError("arguments: expected a JSON object", "invalid_param"));
      }
      return ok(await callTool(caller, name, args));
    }
    default:
      return err(-32601, `Method not found: ${String(method)}`);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = subPath(url.pathname);
  if (path === null) return json({ error: "not_found" }, 404);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const origin = publicOrigin(req);
  if (path === WELL_KNOWN) {
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
    return json(
      {
        resource: resourceUrl(origin),
        authorization_servers: [`${origin}/auth/v1`],
        bearer_methods_supported: ["header"],
        scopes_supported: ["email"],
        resource_name: "AI Proctor",
      },
      200,
      { "Cache-Control": "public, max-age=300" },
    );
  }
  if (path !== "") return json({ error: "not_found" }, 404);
  // No server-to-client stream (GET) and no sessions to end (DELETE).
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });

  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!bearer) return unauthorized(origin);
  const caller = await authenticate(bearer[1]);
  if ("refused" in caller) {
    return unauthorized(origin, { code: "invalid_token", description: caller.refused });
  }

  const version = req.headers.get("mcp-protocol-version");
  if (version && !protocolVersions.includes(version)) {
    return rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${version}`, 400);
  }

  const text = await req.text();
  if (text.length > MAX_BODY) return rpcError(null, -32600, "The request is too large.", 413);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "Parse error: the body is not valid JSON.", 400);
  }
  if (Array.isArray(message)) {
    return rpcError(null, -32600, "Batches are not supported: send one message per request.", 400);
  }
  if (typeof message !== "object" || message === null || (message as Json).jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid request: expected a JSON-RPC 2.0 message.", 400);
  }
  const m = message as Json;
  if (typeof m.method !== "string") {
    // A response to a request this server never sends; accept and ignore it.
    return new Response(null, { status: 202, headers: CORS });
  }
  const reply = await handle(m, caller);
  if (reply === null) return new Response(null, { status: 202, headers: CORS });
  return json(reply);
});
