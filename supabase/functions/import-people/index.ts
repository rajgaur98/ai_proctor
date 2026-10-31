// import-people (#256, ORG-03): applies a people import (ImportPayload with kind
// "people", packages/contracts/src/imports.ts) and invites the new people with the
// normal invite email, only once the import is in the database.
//
// 1. Each new person gets an Auth user from generateLink (type invite), which sends no
//    email. An email Auth already knows is refused for that row.
// 2. import_apply runs as the caller (it checks they're an admin) with those users' ids,
//    all or nothing. If it fails, the Auth users made in step 1 are deleted.
// 3. After it commits, inviteUserByEmail sends each new person the usual invite email
//    (for an invited user who hasn't signed in, Auth sends the invite again to the same
//    user). A failed email doesn't undo the import; it is reported per address.
//
// Request: { payload }. Reply 200: { result: { kind, created, updated },
// invites: { email, ok, error? }[] }. Reply 4xx: { error, detail? } where detail is
// import_apply's ("rows: 3") or the row of the email Auth refused.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MAX_ITEMS = 5000;
// Two Auth calls per new person; keeps one request well inside the function's time limit.
const MAX_INVITES = 500;
const PARALLEL = 5;

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

interface Item {
  rows: number[];
  action: "create" | "update";
  email: string;
  full_name: string;
}

function isItem(v: unknown): v is Item {
  if (typeof v !== "object" || v === null) return false;
  const i = v as Record<string, unknown>;
  return (
    Array.isArray(i.rows) &&
    i.rows.every((r) => Number.isInteger(r)) &&
    (i.action === "create" || i.action === "update") &&
    typeof i.email === "string" &&
    i.email.length <= 254 &&
    typeof i.full_name === "string"
  );
}

/** Runs `task` over `list`, a few at a time, results in order. */
async function each<T, R>(list: T[], task: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await task(list[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
  return out;
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
  // import_apply checks again; this only avoids making Auth users for a non-admin.
  if (!me?.active || (me.role !== "owner" && me.role !== "admin")) {
    return reply({ error: "admin_only" }, 403);
  }

  const body = await req.json().catch(() => null);
  const payload = body?.payload;
  const items: unknown[] = Array.isArray(payload?.items) ? payload.items : [];
  if (
    payload?.kind !== "people" ||
    items.length === 0 ||
    items.length > MAX_ITEMS ||
    !items.every(isItem)
  ) {
    return reply({ error: "invalid_import" }, 400);
  }
  const creates = (items as Item[]).filter((i) => i.action === "create");
  if (creates.length > MAX_INVITES) return reply({ error: "too_many_invites" }, 400);

  const origin = req.headers.get("Origin");
  const redirectTo = origin ? `${origin}/join` : undefined;
  const made = new Map<string, string>();
  const undo = () => each([...made.values()], (id) => admin.auth.admin.deleteUser(id));

  // 1. Auth users, no email yet.
  const linked = await each(creates, async (item) => {
    const email = item.email.trim().toLowerCase();
    const { data, error } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: {
        data: { full_name: item.full_name.trim() },
        ...(redirectTo ? { redirectTo } : {}),
      },
    });
    if (error || !data.user) return { item, error: error?.code ?? "invite_failed" };
    made.set(email, data.user.id);
    return { item, error: null };
  });
  const refused = linked.find((l) => l.error);
  if (refused) {
    await undo();
    // email_exists: Auth already has this address (a member of some org, or signed up).
    return reply({ error: refused.error, detail: `rows: ${refused.item.rows.join(",")}` }, 422);
  }

  // 2. The import, all or nothing.
  const { data: result, error } = await caller.rpc("import_apply", {
    p_payload: payload,
    p_new_users: Object.fromEntries(made),
  });
  if (error) {
    await undo();
    return reply({ error: error.message, detail: error.details ?? null }, 422);
  }

  // 3. Committed: the invite emails.
  const invites = await each(creates, async (item) => {
    const email = item.email.trim().toLowerCase();
    const { error: sendError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: item.full_name.trim() },
      ...(redirectTo ? { redirectTo } : {}),
    });
    return sendError
      ? { email, ok: false, error: sendError.code ?? "invite_failed" }
      : { email, ok: true };
  });
  return reply({ result, invites });
});
