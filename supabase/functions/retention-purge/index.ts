// retention-purge (#51; ADM-03, ADM-04): the nightly retention job. pg_cron calls it
// through pg_net with the service role key (internal.invoke_retention_purge).
// 1. Deletes the capture files of check-ins past their org's image retention through
//    the Storage API, in batches, and marks each check-in once its files are gone.
// 2. Calls retention_purge_rows for the expired rows (events, status periods, shift
//    records, timesheets and their segments). It runs even when step 1 failed:
//    check-ins whose files are still in Storage are kept for the next night.
// Counts are logged in retention_runs and audit_log by the database functions.
// Request: POST, bearer = SUPABASE_SERVICE_ROLE_KEY, any body. Reply: { captures:
// files deleted, rows: counts per table, errors } (500 when anything failed).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const BATCH = 200;
const MAX_BATCHES = 50;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Compares SHA-256 digests, so timing depends on neither content nor length. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer /i, "");
  if (!serviceKey || !(await sameSecret(bearer, serviceKey))) {
    return reply({ error: "unauthorized" }, 401);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, {
    auth: { persistSession: false },
  });
  const errors: string[] = [];
  let captures = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data: expired, error: listError } = await admin.rpc("retention_expired_captures", {
      p_limit: BATCH,
    });
    if (listError) {
      errors.push(`list: ${listError.message}`);
      break;
    }
    const batch = (expired ?? []) as { checkin_id: string; paths: string[] }[];
    if (batch.length === 0) break;

    // Removing a file that is already gone is not an error, so a retry is safe.
    const { error: removeError } = await admin.storage
      .from("captures")
      .remove(batch.flatMap((c) => c.paths));
    if (removeError) {
      errors.push(`remove: ${removeError.message}`);
      break;
    }
    const { data: files, error: markError } = await admin.rpc("retention_mark_captures_purged", {
      p_checkin_ids: batch.map((c) => c.checkin_id),
    });
    if (markError) {
      errors.push(`mark: ${markError.message}`);
      break;
    }
    captures += Number(files ?? 0);
    if (batch.length < BATCH) break;
  }

  const { data: rows, error: rowsError } = await admin.rpc("retention_purge_rows");
  if (rowsError) errors.push(`rows: ${rowsError.message}`);

  return reply({ captures, rows: rows ?? {}, errors }, errors.length > 0 ? 500 : 200);
});
