// Test helper: acts as an employee's agent by calling the real sync RPCs.
import { readFileSync } from "node:fs";
import type { Database } from "@ai-proctor/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function env(): { url: string; anonKey: string } {
  const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const get = (k: string) => file.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  return { url: get("VITE_SUPABASE_URL"), anonKey: get("VITE_SUPABASE_ANON_KEY") };
}

/** Acknowledges the org's current monitoring notice as the signed-in user (clock-in needs it). */
export async function acknowledgeLatestNotice(client: SupabaseClient<Database>) {
  const { data, error } = await client
    .from("notices")
    .select("id")
    .order("version", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  const { error: ackError } = await client.rpc("acknowledge_notice", { p_notice_id: data.id });
  if (ackError) throw ackError;
}

/** A client signed in as a seed user (or `password`), for setting up or checking state outside the page. */
export async function clientFor(email: string, password = "password123") {
  const { url, anonKey } = env();
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

export async function agentFor(email: string) {
  const client = await clientFor(email);
  const { data, error: regError } = await client.rpc("register_device", {
    platform: "macos",
    os_version: "26.7",
    agent_version: "0.1.0",
    hardware_hash: `e2e-${email}-${Date.now()}`,
  });
  if (regError) throw regError;
  await acknowledgeLatestNotice(client as unknown as SupabaseClient<Database>);
  let seq = 0;
  // `at` backdates the event (an agent that queued it, or a shift that began earlier).
  return async (
    type: string,
    payload: Record<string, unknown> = {},
    id = crypto.randomUUID(),
    at = new Date().toISOString(),
  ) => {
    seq += 1;
    const { data: reply, error } = await client.rpc("agent_events", {
      device_id: data.device_id,
      events: [{ id, seq, type, at, mono_ms: seq, payload }],
    });
    if (error) throw error;
    return reply;
  };
}

/** Runs `f` with a client signed in as `email` (seed password), failing on errors. */
export async function asEmployee(
  email: string,
  f: (db: SupabaseClient<Database>) => PromiseLike<{ error: unknown }>,
) {
  const { url, anonKey } = env();
  const db = createClient<Database>(url, anonKey, { auth: { persistSession: false } });
  const { error: signInError } = await db.auth.signInWithPassword({
    email,
    password: "password123",
  });
  if (signInError) throw signInError;
  const { error } = await f(db);
  if (error) throw error;
}
