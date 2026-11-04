// deliver-webhooks (#320; API-06): sends the webhook deliveries that are due. Called every
// minute by the webhooks_kick cron job (internal.webhooks_kick, through pg_net) with the
// service-role key as the bearer token; nobody else may call it.
//
// It claims due deliveries with webhook_claim (which counts the attempt and sets when the
// next one is due), POSTs each to its endpoint and records the result with webhook_record
// (20261105700000_webhooks_and_time_off_api.sql: retries, failure, turning an endpoint off).
//
// Each request:
//   POST <endpoint URL>
//   Content-Type: application/json
//   X-AIProctor-Event: timesheet.approved         the event type
//   X-AIProctor-Event-Id: <uuid>                   the same in every retry: dedupe on it
//   X-AIProctor-Delivery: <uuid>                   this endpoint's delivery of the event
//   X-AIProctor-Timestamp: 1730800000              Unix seconds when this attempt was signed
//   X-AIProctor-Signature: v1=<hex>                HMAC-SHA256(secret, "<timestamp>.<body>")
//   body: { id, type, created_at, api_version, data }
// A 2xx answer within 10 seconds is delivered; anything else (another status, a redirect,
// a timeout, no connection) is a failed attempt. Response bodies are never kept.
//
// Unless the stack allows private hosts (local only, webhook_claim's allow_private), the URL
// must be https and its host must not resolve to a private, loopback or link-local address
// (address.ts); redirects are not followed.
// Reply: { claimed, delivered, failed }.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { blockedAddress } from "./address.ts";

const BATCH = 25;
const CONCURRENCY = 5;
const TIMEOUT_MS = 10_000;
// Claim more batches while there is time left in this run.
const RUN_BUDGET_MS = 60_000;

interface Claimed {
  id: string;
  url: string;
  secret: string | null;
  payload: unknown;
  event_type: string;
  event_id: string;
  attempt: number;
  allow_private: boolean;
}

interface Outcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Compares without stopping at the first difference. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Why the URL may not be called in production, or null when it may. fetch resolves the
 * host again, so a name that changes its answer between the two lookups (DNS rebinding) is
 * not caught here; the save-time check and https still apply. */
async function refusal(url: URL): Promise<string | null> {
  if (url.protocol !== "https:") return "the URL must use https";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    return blockedAddress(host) ? "the host is a private or local address" : null;
  }
  const found: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      found.push(...(await Deno.resolveDns(host, type)));
    } catch {
      // No records of this type.
    }
  }
  if (found.length === 0) return "the host name did not resolve";
  return found.some(blockedAddress) ? "the host resolves to a private or local address" : null;
}

async function deliver(row: Claimed): Promise<Outcome> {
  if (!row.secret) return { ok: false, status: null, error: "no signing secret" };
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    return { ok: false, status: null, error: "not a URL" };
  }
  if (!row.allow_private) {
    const why = await refusal(url);
    if (why) return { ok: false, status: null, error: `refused: ${why}` };
  }

  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacHex(row.secret, `${timestamp}.${body}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AIProctor-Webhooks/1.0",
        "X-AIProctor-Event": row.event_type,
        "X-AIProctor-Event-Id": row.event_id,
        "X-AIProctor-Delivery": row.id,
        "X-AIProctor-Timestamp": timestamp,
        "X-AIProctor-Signature": `v1=${signature}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
    return {
      ok: false,
      status: res.status,
      error:
        res.status >= 300 && res.status < 400
          ? `HTTP ${res.status} (redirects are not followed)`
          : `HTTP ${res.status}`,
    };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, status: null, error: `no answer within ${TIMEOUT_MS / 1000} seconds` };
    }
    return { ok: false, status: null, error: "could not connect" };
  }
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (serviceKey === "" || !sameSecret(bearer, serviceKey)) {
    return reply({ error: "forbidden" }, 403);
  }
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, {
    auth: { persistSession: false },
  });
  const started = Date.now();
  let claimed = 0;
  let delivered = 0;
  let failed = 0;

  while (Date.now() - started < RUN_BUDGET_MS) {
    const batch = await db.rpc("webhook_claim", { p_limit: BATCH });
    if (batch.error) {
      console.error("webhook_claim", batch.error.message);
      return reply({ error: "claim_failed", claimed, delivered, failed }, 500);
    }
    const rows = (batch.data ?? []) as Claimed[];
    claimed += rows.length;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(
        rows.slice(i, i + CONCURRENCY).map(async (row) => {
          const outcome = await deliver(row);
          if (outcome.ok) delivered++;
          else failed++;
          const recorded = await db.rpc("webhook_record", {
            p_id: row.id,
            p_ok: outcome.ok,
            p_status: outcome.status,
            p_error: outcome.error,
          });
          if (recorded.error) console.error("webhook_record", row.id, recorded.error.message);
        }),
      );
    }
    if (rows.length < BATCH) break;
  }
  return reply({ claimed, delivered, failed });
});
