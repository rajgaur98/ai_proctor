// deliver-webhooks (#320, #335; API-06): sends the webhook deliveries that are due. Called
// every minute by the webhooks_kick cron job (internal.webhooks_kick, through pg_net), and at
// once after an admin sends a test event or redelivers one, with the service-role key as the
// bearer token; nobody else may call it.
//
// It claims due deliveries with webhook_claim (which counts the attempt and sets when the
// next one is due), POSTs each to its endpoint and records the result with webhook_record
// (20261105700000_webhooks_and_time_off_api.sql: retries, failure, turning an endpoint off).
//
// Each request:
//   POST <endpoint URL>
//   Content-Type: application/json
//   X-AIProctor-Event: timesheet.approved         the event type (ping for a test event)
//   X-AIProctor-Event-Id: <uuid>                   the same in every retry and redelivery: dedupe on it
//   X-AIProctor-Delivery: <uuid>                   this endpoint's delivery of the event
//   X-AIProctor-Timestamp: 1730800000              Unix seconds when this attempt was signed
//   X-AIProctor-Signature: v1=<hex>                HMAC-SHA256(secret, "<timestamp>.<body>")
//   body: { id, type, created_at, api_version, data }
// For 24 hours after a rotation the signature header carries two values, "v1=<hex with the
// new secret>,v1=<hex with the previous one>" (20261105800000_webhooks_test_redeliver_grace.sql).
// A 2xx answer within 10 seconds is delivered; anything else (another status, a redirect,
// a timeout, no connection, a TLS certificate that isn't valid for the host) is a failed
// attempt. Response bodies are never read.
//
// The connection is pinned (pin.ts): the host is resolved once, every address it resolves to
// must be public (address.ts) unless the stack allows private hosts (local only, webhook_claim's
// allow_private), and the request goes to that checked address with the original Host header
// and TLS validated for the host name, so a name can't answer differently when we connect.
// The URL must be https (http only on a local stack); redirects are not followed.
// Reply: { claimed, delivered, failed }.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { type Conn, type Net, type Outcome, postPinned } from "./pin.ts";

const BATCH = 25;
const CONCURRENCY = 5;
const TIMEOUT_MS = 10_000;
// Claim more batches while there is time left in this run.
const RUN_BUDGET_MS = 60_000;

interface Claimed {
  id: string;
  url: string;
  secret: string | null;
  previous_secret: string | null;
  payload: unknown;
  event_type: string;
  event_id: string;
  attempt: number;
  allow_private: boolean;
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

const net: Net = {
  resolve: (host, type) => Deno.resolveDns(host, type),
  connect: (address, port) => Deno.connect({ hostname: address, port, transport: "tcp" }),
  tls: async (conn, hostname) => {
    const tls = await Deno.startTls(conn as Deno.TcpConn, { hostname });
    try {
      await tls.handshake();
    } catch (e) {
      tls.close();
      throw e;
    }
    return tls as Conn;
  },
};

async function deliver(row: Claimed): Promise<Outcome> {
  if (!row.secret) return { ok: false, status: null, error: "no signing secret" };
  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signed = `${timestamp}.${body}`;
  // The current secret first; the previous one too while its grace period lasts.
  const signatures = [`v1=${await hmacHex(row.secret, signed)}`];
  if (row.previous_secret) signatures.push(`v1=${await hmacHex(row.previous_secret, signed)}`);
  return await postPinned(
    {
      url: row.url,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AIProctor-Webhooks/1.0",
        "X-AIProctor-Event": row.event_type,
        "X-AIProctor-Event-Id": row.event_id,
        "X-AIProctor-Delivery": row.id,
        "X-AIProctor-Timestamp": timestamp,
        "X-AIProctor-Signature": signatures.join(","),
      },
      body,
      allowPrivate: row.allow_private,
      timeoutMs: TIMEOUT_MS,
    },
    net,
  );
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
