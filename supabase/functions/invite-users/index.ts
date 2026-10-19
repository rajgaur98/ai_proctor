// invite-users (#28, ORG-03): an owner or admin invites people by email. Auth's
// invite needs the service role, so it runs here; the member row and its rules
// are add_invited_member's (supabase/migrations/*_org_members_and_audit.sql).
// Request: { invites: Invite[] } (packages/contracts/src/invites.ts), at most 200.
// Reply: { results: { email, ok, error? }[] }, one per invite, in order.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

interface Invite {
  email: string;
  full_name: string;
  role: "admin" | "manager" | "employee";
  manager_id: string;
  work_country: string;
  work_state: string | null;
  timezone: string;
}

const MAX_INVITES = 200;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function isInvite(v: unknown): v is Invite {
  if (typeof v !== "object" || v === null) return false;
  const i = v as Record<string, unknown>;
  const str = (k: string, max: number) =>
    typeof i[k] === "string" && (i[k] as string).length <= max;
  return (
    str("email", 254) &&
    str("full_name", 120) &&
    ["admin", "manager", "employee"].includes(i.role as string) &&
    str("manager_id", 36) &&
    str("work_country", 2) &&
    (i.work_state === null || str("work_state", 2)) &&
    str("timezone", 64)
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return reply({ error: "not_signed_in" }, 401);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const { data: me } = await admin
    .from("users")
    .select("id, role, active")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (!me?.active || (me.role !== "owner" && me.role !== "admin")) {
    return reply({ error: "admin_only" }, 403);
  }

  const body = await req.json().catch(() => null);
  const invites: unknown[] = Array.isArray(body?.invites) ? body.invites : [];
  if (invites.length === 0 || invites.length > MAX_INVITES || !invites.every(isInvite)) {
    return reply({ error: "invalid_request" }, 400);
  }

  // The join page verifies the link; only redirect URLs Auth allows are used.
  const origin = req.headers.get("Origin");
  const redirectTo = origin ? `${origin}/join` : undefined;

  const results = [];
  for (const invite of invites as Invite[]) {
    const email = invite.email.trim().toLowerCase();
    const member = (userId: string | null) =>
      admin.rpc("add_invited_member", {
        p_inviter_id: me.id,
        p_user_id: userId,
        p_email: email,
        p_full_name: invite.full_name,
        p_role: invite.role,
        p_manager_id: invite.manager_id,
        p_work_country: invite.work_country,
        p_work_state: invite.work_state,
        p_timezone: invite.timezone,
      });
    // Check first, so a refused invite never sends an email.
    const { error: checkError } = await member(null);
    if (checkError) {
      results.push({ email, ok: false, error: checkError.message });
      continue;
    }
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { full_name: invite.full_name.trim() },
    });
    if (error || !data.user) {
      results.push({ email, ok: false, error: error?.code ?? "invite_failed" });
      continue;
    }
    const { error: addError } = await member(data.user.id);
    if (addError) {
      // Don't leave an Auth user behind that belongs to no org.
      await admin.auth.admin.deleteUser(data.user.id);
      results.push({ email, ok: false, error: addError.message });
      continue;
    }
    results.push({ email, ok: true });
  }
  return reply({ results });
});
