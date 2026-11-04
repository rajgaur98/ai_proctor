// api-v1 (#306; API-01..05, AUD-01): the public API, version 1. JSON over HTTPS with an org
// API key: `Authorization: Bearer aip_...`.
//
// This function only speaks HTTP: it routes `/v1/...` (routes.ts), turns the query string
// or JSON body into parameters, and hashes the key (SHA-256; the key itself never reaches
// the database). The database does the rest, as the service role:
//   api_v1_authenticate(hash)          the key, its creator and its rate limit;
//   api_v1_call(key, operation, params) the scope, the operation as the key's creator, and
//                                      the audit row (20261105200000_public_api.sql).
// GET /v1/openapi.json is the OpenAPI document (no key needed).
//
// Locally it is served at /functions/v1/api-v1/v1/...; the production `/api/v1` host is set
// at deploy (M6). JWT verification is off for this function (supabase/config.toml): callers
// bring an API key, not a session.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { openApiDocument } from "./openapi.ts";
import { allowedMethods, matchRoute } from "./routes.ts";

const KEY = /^aip_[A-Za-z0-9_-]{43}$/;
const MAX_BODY = 64 * 1024;

interface Rate {
  limit: number;
  remaining: number;
  reset: number;
}

function reply(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function fail(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return reply({ error: { code, message } }, status, headers);
}

function rateHeaders(rate: Rate | undefined, retryAfter?: number): Record<string, string> {
  if (!rate) return {};
  return {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(rate.remaining),
    "X-RateLimit-Reset": String(rate.reset),
    ...(retryAfter !== undefined ? { "Retry-After": String(retryAfter) } : {}),
  };
}

/** The API path (`/v1/...`) of a request, served locally under /functions/v1/api-v1 and in
 * production under /api. */
function apiPath(pathname: string): string | null {
  const m = /^(?:\/functions\/v1)?\/api(?:-v1)?(\/v1(?:\/.*)?)$/.exec(pathname);
  return m ? m[1].replace(/\/+$/, "") || "/v1" : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The request's parameters: the query string (each name once), or a POST's JSON object. */
async function readParams(
  req: Request,
  url: URL,
): Promise<{ params: Record<string, unknown> } | { error: Response }> {
  const params: Record<string, unknown> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1) {
      return { error: fail(400, "invalid_param", `${name}: give it once`) };
    }
    params[name] = values[0];
  }
  if (req.method !== "POST") return { params };
  if (Object.keys(params).length > 0) {
    return { error: fail(400, "invalid_param", "POST takes a JSON body, not query parameters") };
  }
  const text = await req.text();
  if (text.length > MAX_BODY) return { error: fail(413, "too_large", "The body is too large.") };
  if (!text.trim()) return { params };
  try {
    const body = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { error: fail(400, "invalid_json", "The body must be a JSON object.") };
    }
    return { params: body };
  } catch {
    return { error: fail(400, "invalid_json", "The body is not valid JSON.") };
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = apiPath(url.pathname);
  if (!path) return fail(404, "not_found", "Not an API path. Requests start with /v1/.");

  if (path === "/v1/openapi.json") {
    if (req.method !== "GET") return fail(405, "method_not_allowed", "Use GET.", { Allow: "GET" });
    return reply(openApiDocument(), 200, { "Cache-Control": "public, max-age=300" });
  }

  const route = matchRoute(req.method, path);
  if (route === null) return fail(404, "not_found", "There is no such API operation.");
  if (route === "method") {
    const allow = allowedMethods(path).join(", ");
    return fail(405, "method_not_allowed", `Use ${allow}.`, { Allow: allow });
  }

  const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!auth) {
    return fail(401, "missing_key", "Send your API key as `Authorization: Bearer aip_...`.", {
      "WWW-Authenticate": "Bearer",
    });
  }
  if (!KEY.test(auth[1])) return fail(401, "invalid_key", "The API key is not valid.");

  const read = await readParams(req, url);
  if ("error" in read) return read.error;
  const params = route.id === undefined ? read.params : { ...read.params, id: route.id };
  if (route.id !== undefined && "id" in read.params) {
    return fail(400, "invalid_param", "id: give it in the path only");
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const checked = await db.rpc("api_v1_authenticate", { p_key_hash: await sha256Hex(auth[1]) });
  if (checked.error) {
    console.error("api_v1_authenticate", checked.error.message);
    return fail(500, "internal_error", "Something went wrong. Try again later.");
  }
  const key = checked.data as {
    status: number;
    key_id?: string;
    rate?: Rate;
    retry_after?: number;
    body?: unknown;
  };
  if (key.status !== 200 || !key.key_id) {
    return reply(key.body, key.status, rateHeaders(key.rate, key.retry_after));
  }

  const called = await db.rpc("api_v1_call", {
    p_key_id: key.key_id,
    p_operation: route.operation.id,
    p_params: params,
  });
  if (called.error) {
    console.error("api_v1_call", route.operation.id, called.error.message);
    return fail(
      500,
      "internal_error",
      "Something went wrong. Try again later.",
      rateHeaders(key.rate),
    );
  }
  const result = called.data as { status: number; body: unknown };
  return reply(result.body, result.status, rateHeaders(key.rate));
});
