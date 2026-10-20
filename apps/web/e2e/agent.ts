// Test helper: acts as an employee's agent by calling the real sync RPCs.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function env(): { url: string; anonKey: string } {
  const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const get = (k: string) => file.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  return { url: get("VITE_SUPABASE_URL"), anonKey: get("VITE_SUPABASE_ANON_KEY") };
}

/** A signed-in API client for a seed user, to call the RPCs a test needs directly. */
export async function clientFor(email: string) {
  const { url, anonKey } = env();
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: "password123" });
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
  let seq = 0;
  return async (type: string, payload: Record<string, unknown> = {}, id = crypto.randomUUID()) => {
    seq += 1;
    const { data: reply, error } = await client.rpc("agent_events", {
      device_id: data.device_id,
      events: [{ id, seq, type, at: new Date().toISOString(), mono_ms: seq, payload }],
    });
    if (error) throw error;
    return reply;
  };
}
