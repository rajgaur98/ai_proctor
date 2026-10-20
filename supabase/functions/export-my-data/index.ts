// export-my-data (#49; EMP-04, AUD-01): a ZIP with a copy of the caller's own data,
// for data-subject access requests (GDPR, DPDP, CPRA). POST with the caller's token,
// no body. It reads every table with that token, so row-level security decides what
// is theirs (their own rows only; a manager's private "keep" decisions stay hidden, as
// in the dashboard). The capture images still inside the retention window are
// downloaded with the service role, but only from the caller's own folder: the paths
// come from their own check-ins and export_capture_objects (service role only) checks
// the folder prefix again.
//
// ZIP layout:
//   README.txt
//   data/<name>.json and data/<name>.csv for each dataset below
//   captures/<YYYY-MM-DD>/<check-in id>/<file>.webp
//   captures/manifest.json  (what was included, and what could not be fetched)
//
// Before anything is returned the export is audit-logged as my_data.exported with the
// row counts. Over MAX_IMAGE_BYTES of images the reply is 413 export_too_large and
// nothing is sent. The ZIP is streamed, one file at a time.
//
// ../_shared/core is generated from packages/core (`pnpm core:fn`).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { Zip, ZipDeflate, ZipPassThrough } from "npm:fflate@0.8.2";
import { columnsOf, recordsToCsv } from "../_shared/core/csv.ts";

const MAX_IMAGE_BYTES = 200 * 1024 * 1024;
const PAGE = 1000;
const DEFAULT_RETENTION_DAYS = 30;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Disposition",
};

type Row = Record<string, unknown>;
type Result = PromiseLike<{ data: unknown; error: { message: string } | null }>;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Every row of a query, a page at a time (the API caps a response at 1000 rows). */
async function fetchAll(page: (from: number, to: number) => Result): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const got = (data ?? []) as Row[];
    rows.push(...got);
    if (got.length < PAGE) return rows;
  }
}

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

const readme = (
  userName: string,
  generatedAt: string,
  counts: Record<string, number>,
  images: number,
  retentionDays: number,
) =>
  `AI Proctor: a copy of the data held about ${userName}
Generated ${generatedAt} (all times are UTC, ISO 8601; durations are in seconds).

data/*.json and data/*.csv   the same records in both formats, one pair per dataset:
${Object.entries(counts)
  .map(([k, v]) => `  ${k}: ${v} record(s)`)
  .join("\n")}
captures/                    ${images} screenshot and webcam image(s) from your passed check-ins that
                             are still inside the ${retentionDays}-day retention period, by date and
                             check-in id. Older images have been deleted.
captures/manifest.json       what was included, and anything that could not be fetched.

In the CSV files a text cell that starts with = + - @ has a leading apostrophe added so a
spreadsheet does not run it as a formula. The JSON files are exact.
`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const me = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: auth, error: authError } = await me.auth.getUser(token);
  if (authError || !auth.user) return reply({ error: "unauthorized" }, 401);
  const userId = auth.user.id;

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    return await exportData(me, admin, userId);
  } catch (e) {
    console.error("export-my-data failed", e);
    return reply({ error: "export_failed", message: "The export failed. Try again." }, 500);
  }
});

async function exportData(me: SupabaseClient, admin: SupabaseClient, userId: string) {
  const own = (table: string, order: string[], columns = "*") =>
    fetchAll((from, to) => {
      let q = me.from(table).select(columns).eq("user_id", userId);
      for (const col of order) q = q.order(col);
      return q.range(from, to);
    });

  const profileQuery = me
    .from("users")
    .select(
      "id, org_id, full_name, email, role, manager_id, timezone, work_country, work_state, approval_required, active, created_at",
    )
    .eq("id", userId);
  const [
    profile,
    checkIns,
    clockSessions,
    breaks,
    pauses,
    statusPeriods,
    segments,
    manualEntries,
    timesheets,
    edits,
    activity,
    acks,
    views,
    notifications,
    editors,
    org,
  ] = await Promise.all([
    fetchAll((from, to) => profileQuery.range(from, to)),
    own("checkin_events", ["scheduled_at", "id"]),
    own("clock_sessions", ["start_at", "id"]),
    own("breaks", ["start_at", "id"]),
    // The view with the pause reasons, which only the employee can read.
    own("my_pauses", ["start_at", "id"]),
    own("status_periods", ["start_at", "id"]),
    own("time_segments", ["start_at", "id"]),
    own("manual_entries", ["created_at", "id"]),
    own("timesheets", ["period_start", "id"]),
    own("timesheet_edits", ["seq"]),
    own("activity_samples", ["minute", "id"]),
    own(
      "notice_acks",
      ["acknowledged_at", "notice_id"],
      "*, notices(version, region, published_at)",
    ),
    me.rpc("my_capture_views", { p_days: 3650 }),
    own("notifications", ["created_at", "id"]),
    me.rpc("my_edit_history", { p_limit: 500 }),
    me.from("orgs").select("policy").limit(1).maybeSingle(),
  ]);
  if (views.error) throw new Error(views.error.message);
  if (editors.error) throw new Error(editors.error.message);
  if (org.error) throw new Error(org.error.message);

  const editorName = new Map(
    (editors.data as { id: string; editor_name: string | null }[]).map((e) => [
      e.id,
      e.editor_name,
    ]),
  );
  const datasets: Record<string, Row[]> = {
    profile,
    "check-ins": checkIns,
    "clock-sessions": clockSessions,
    breaks,
    pauses,
    "status-periods": statusPeriods,
    "time-segments": segments,
    "manual-entries": manualEntries,
    timesheets,
    // Who made each edit, by name (the employee can't read their manager's row).
    "timesheet-edits": edits.map((e) => ({
      ...e,
      editor_name: editorName.get(String(e.id)) ?? null,
    })),
    "activity-samples": activity,
    "notice-acknowledgements": acks.map(({ notices, ...a }) => {
      const n = (notices ?? {}) as Row;
      return {
        ...a,
        notice_version: n.version ?? null,
        notice_region: n.region ?? null,
        notice_published_at: n.published_at ?? null,
      };
    }),
    // Other people's views of these captures (your own are logged but not listed).
    "capture-views": views.data as Row[],
    notifications,
  };

  // Images still inside the retention window, from the caller's own check-ins.
  const policy = (org.data?.policy ?? {}) as { image_retention_days?: unknown };
  const retentionDays =
    typeof policy.image_retention_days === "number" && policy.image_retention_days > 0
      ? Math.floor(policy.image_retention_days)
      : DEFAULT_RETENTION_DAYS;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const orgId = String(profile[0]?.org_id ?? "");
  const wanted = new Map<string, string>(); // storage path -> path inside the ZIP
  for (const c of checkIns) {
    const at = new Date(String(c.scheduled_at));
    if (at.getTime() < cutoff) continue;
    const day = at.toISOString().slice(0, 10);
    for (const file of (c.object_keys as string[] | null) ?? []) {
      wanted.set(`${orgId}/${userId}/${day}/${c.id}/${file}`, `captures/${day}/${c.id}/${file}`);
    }
  }
  const found = wanted.size
    ? await admin.rpc("export_capture_objects", { p_user_id: userId, p_paths: [...wanted.keys()] })
    : { data: [], error: null };
  if (found.error) throw new Error(found.error.message);
  const images = (found.data as { name: string; bytes: number }[]).map((o) => ({
    path: o.name,
    zipPath: wanted.get(o.name) ?? "",
    bytes: Number(o.bytes),
  }));
  const imageBytes = images.reduce((sum, i) => sum + i.bytes, 0);
  if (imageBytes > MAX_IMAGE_BYTES) {
    return reply(
      {
        error: "export_too_large",
        message: `Your images add up to ${megabytes(imageBytes)}, over the ${megabytes(MAX_IMAGE_BYTES)} limit for one download. Ask your admin for an export in parts.`,
      },
      413,
    );
  }

  const counts = Object.fromEntries(Object.entries(datasets).map(([k, v]) => [k, v.length]));
  // Logged before anything is returned (AUD-01).
  const logged = await admin.rpc("record_my_data_export", {
    p_user_id: userId,
    p_counts: {
      ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k.replaceAll("-", "_"), v])),
      capture_images: images.length,
      capture_image_bytes: imageBytes,
    },
  });
  if (logged.error) throw new Error(logged.error.message);

  const encoder = new TextEncoder();
  const generatedAt = new Date().toISOString();
  const texts: { name: string; data: Uint8Array }[] = [
    {
      name: "README.txt",
      data: encoder.encode(
        readme(
          String(profile[0]?.full_name ?? "you"),
          generatedAt,
          counts,
          images.length,
          retentionDays,
        ),
      ),
    },
  ];
  for (const [name, rows] of Object.entries(datasets)) {
    texts.push({
      name: `data/${name}.json`,
      data: encoder.encode(JSON.stringify(rows, null, 2)),
    });
    texts.push({
      name: `data/${name}.csv`,
      data: encoder.encode(recordsToCsv(columnsOf(rows), rows)),
    });
  }

  const included: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let zip: Zip;
  let nextText = 0;
  let nextImage = 0;
  let manifestDone = false;
  let ended = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) return controller.error(err);
        controller.enqueue(chunk);
        if (final) controller.close();
      });
    },
    async pull() {
      if (ended) return;
      const text = texts[nextText];
      if (text) {
        nextText += 1;
        const file = new ZipDeflate(text.name, { level: 6 });
        zip.add(file);
        file.push(text.data, true);
        return;
      }
      const image = images[nextImage];
      if (image) {
        nextImage += 1;
        // WebP is already compressed: stored, not deflated.
        const got = await admin.storage.from("captures").download(image.path);
        if (got.error || !got.data) {
          skipped.push({ path: image.zipPath, reason: got.error?.message ?? "not found" });
          return;
        }
        const file = new ZipPassThrough(image.zipPath);
        zip.add(file);
        file.push(new Uint8Array(await got.data.arrayBuffer()), true);
        included.push(image.zipPath);
        return;
      }
      if (!manifestDone) {
        manifestDone = true;
        const file = new ZipDeflate("captures/manifest.json", { level: 6 });
        zip.add(file);
        file.push(
          encoder.encode(
            JSON.stringify({ retention_days: retentionDays, included, skipped }, null, 2),
          ),
          true,
        );
        return;
      }
      ended = true;
      zip.end();
    },
  });

  return new Response(stream, {
    headers: {
      ...cors,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="ai-proctor-my-data-${generatedAt.slice(0, 10)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
