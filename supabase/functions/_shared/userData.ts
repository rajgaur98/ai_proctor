// What export-my-data (EMP-04, #49) and export-user-data (ADM-05, #54) share, so the two
// exports are the same ZIP: the datasets, the retention-window images, the README and
// the streaming. They differ in who reads (the employee with their own token, so
// row-level security decides what is theirs; an admin through the service role, scoped
// to one user and one org in every query) and in a few details marked "admin" below.
//
// ZIP layout:
//   README.txt
//   data/<name>.json and data/<name>.csv for each dataset
//   captures/<YYYY-MM-DD>/<check-in id>/<file>.webp
//   captures/manifest.json  (what was included, and what could not be fetched)
//
// ../_shared/core is generated from packages/core (`pnpm core:fn`).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { Zip, ZipDeflate, ZipPassThrough } from "npm:fflate@0.8.2";
import { columnsOf, recordsToCsv } from "./core/csv.ts";

const MAX_IMAGE_BYTES = 200 * 1024 * 1024;
const PAGE = 1000;
const DEFAULT_RETENTION_DAYS = 30;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Disposition",
};

export type Row = Record<string, unknown>;
type Result = PromiseLike<{ data: unknown; error: { message: string } | null }>;

export function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Status and wording for the errors the data request functions in SQL raise. */
const REQUEST_ERRORS: Record<string, { status: number; message: string }> = {
  admin_only: { status: 403, message: "Only owners and admins can do this." },
  mfa_required: { status: 403, message: "Verify with your authenticator app first." },
  owner_only: { status: 403, message: "Only the owner can do this for the owner." },
  user_not_found: { status: 404, message: "That person isn't in your organisation." },
  email_mismatch: { status: 400, message: "The email doesn't match that person's email." },
  invalid_action: { status: 400, message: "Unknown request." },
  cannot_delete_self: { status: 409, message: "You can't delete your own data here." },
  last_owner: { status: 409, message: "The last owner can't be deleted." },
  has_reports: {
    status: 409,
    message: "People still report to them. Move their reports to another manager first.",
  },
  captures_remain: { status: 409, message: "Images were added during deletion. Try again." },
};

/** A reply for an error from the SQL side of a request (its message is the code). */
export function requestError(error: { message: string; details?: string | null }) {
  const known = REQUEST_ERRORS[error.message];
  if (!known) return null;
  return reply(
    {
      error: error.message,
      message: known.message,
      ...(error.message === "has_reports" && error.details ? { reports: error.details } : {}),
    },
    known.status,
  );
}

/** Every row of a query, a page at a time (the API caps a response at 1000 rows). */
export async function fetchAll(page: (from: number, to: number) => Result): Promise<Row[]> {
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

export interface ExportOptions {
  /** self: the employee's own token (RLS); admin: the service role, scoped by user and org. */
  mode: "self" | "admin";
  /** The client the datasets are read with. */
  reader: SupabaseClient;
  /** Service role: capture sizes and files. */
  admin: SupabaseClient;
  userId: string;
  /** Null for self: found from the caller's own user row. */
  orgId: string | null;
  /** Audit-logs the export, with the counts; called before anything is returned. */
  record: (counts: Record<string, number>) => Promise<void>;
}

const readme = (
  mode: "self" | "admin",
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
captures/                    ${images} screenshot and webcam image(s) from ${mode === "self" ? "your" : "their"} passed check-ins that
                             are still inside the ${retentionDays}-day retention period, by date and
                             check-in id. Older images have been deleted.
captures/manifest.json       what was included, and anything that could not be fetched.

In the CSV files a text cell that starts with = + - @ has a leading apostrophe added so a
spreadsheet does not run it as a formula. The JSON files are exact.
${
  mode === "admin"
    ? `
The reasons ${userName} gave for pausing are not in this export: they are the employee's
own, and not readable by admins. They can download them from My data.
`
    : ""
}`;

/** Builds the export and streams it as a ZIP. Replies 413 when the images are too many. */
export async function exportResponse(o: ExportOptions): Promise<Response> {
  const { mode, reader, admin, userId } = o;

  // Every read is limited to this user and, where the table has one, this org.
  let orgId = o.orgId;
  if (!orgId) {
    const { data, error } = await reader.from("users").select("org_id").eq("id", userId).single();
    if (error) throw new Error(error.message);
    orgId = String((data as Row).org_id);
  }
  const org = orgId;
  const scoped = (table: string, order: string[], columns = "*", inOrg = true) =>
    fetchAll((from, to) => {
      let q = reader.from(table).select(columns).eq("user_id", userId);
      if (inOrg) q = q.eq("org_id", org);
      for (const col of order) q = q.order(col);
      return q.range(from, to);
    });

  const profileQuery = reader
    .from("users")
    .select(
      "id, org_id, full_name, email, role, manager_id, timezone, work_country, work_state, approval_required, active, created_at",
    )
    .eq("id", userId)
    .eq("org_id", org);
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
    dayNotes,
    comments,
    edits,
    activity,
    acks,
    views,
    notifications,
    lateClockIns,
    favourites,
    editors,
    orgRow,
  ] = await Promise.all([
    fetchAll((from, to) => profileQuery.range(from, to)),
    scoped("checkin_events", ["scheduled_at", "id"]),
    scoped("clock_sessions", ["start_at", "id"]),
    scoped("breaks", ["start_at", "id"]),
    // Self: the view with the pause reasons, which only the employee can read. Admin:
    // the table without that column.
    mode === "self"
      ? scoped("my_pauses", ["start_at", "id"])
      : fetchAll((from, to) =>
          reader
            .from("pauses")
            .select(
              "id, org_id, user_id, clock_session_id, start_at, end_at, planned_min, over_cap_s",
            )
            .eq("user_id", userId)
            .eq("org_id", org)
            .order("start_at")
            .order("id")
            .range(from, to),
        ),
    scoped("status_periods", ["start_at", "id"]),
    scoped("time_segments", ["start_at", "id"]),
    scoped("manual_entries", ["created_at", "id"]),
    scoped("timesheets", ["period_start", "id"]),
    // #254 (TS-25): what the person wrote about each day.
    scoped("timesheet_day_notes", ["day"]),
    // #265 (TS-33): the comments on their weeks, theirs and their reviewers', with the
    // author's name as it was written.
    scoped("timesheet_comments", ["created_at", "id"]),
    // 'keep' is a manager's private review decision, not an edit: never in an export
    // (the employee can't read it; row-level security hides it from them).
    fetchAll((from, to) =>
      reader
        .from("timesheet_edits")
        .select("*")
        .eq("user_id", userId)
        .eq("org_id", org)
        .neq("kind", "keep")
        .order("seq")
        .range(from, to),
    ),
    scoped("activity_samples", ["minute", "id"]),
    scoped(
      "notice_acks",
      ["acknowledged_at", "notice_id"],
      "*, notices(version, region, published_at)",
      false,
    ),
    mode === "self"
      ? reader.rpc("my_capture_views", { p_days: 3650 })
      : reader.rpc("export_user_capture_views", { p_user_id: userId, p_days: 3650 }),
    scoped("notifications", ["created_at", "id"]),
    // SHF-06 (#67): one row per late shift occurrence, as stored (seconds, not minutes).
    scoped("late_clock_ins", ["shift_start", "id"]),
    // #264 (TS-34): the rows they pinned to their week grid.
    scoped("timesheet_favourites", ["created_at", "id"]),
    // Who made each edit, by name (the employee can't read their manager's row). The
    // admin path looks the names up below, for the editors that appear.
    mode === "self"
      ? reader.rpc("my_edit_history", { p_limit: 500 })
      : Promise.resolve({ data: [] as Row[], error: null }),
    reader.from("orgs").select("policy").eq("id", org).maybeSingle(),
  ]);
  if (views.error) throw new Error(views.error.message);
  if (editors.error) throw new Error(editors.error.message);
  if (orgRow.error) throw new Error(orgRow.error.message);

  // Edit id -> editor name (self), editor id -> name (admin; gone users have none).
  const editorName = new Map<string, string | null>(
    (editors.data as { id: string; editor_name: string | null }[]).map((e) => [
      e.id,
      e.editor_name,
    ]),
  );
  if (mode === "admin") {
    const ids = [...new Set(edits.map((e) => e.editor_id).filter((id) => isUuid(id)))];
    if (ids.length) {
      const names = await reader
        .from("users")
        .select("id, full_name")
        .eq("org_id", org)
        .in("id", ids);
      if (names.error) throw new Error(names.error.message);
      for (const u of names.data as { id: string; full_name: string }[]) {
        editorName.set(u.id, u.full_name);
      }
    }
  }
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
    "timesheet-day-notes": dayNotes,
    "timesheet-comments": comments,
    "timesheet-edits": edits.map((e) => ({
      ...e,
      editor_name:
        mode === "self"
          ? (editorName.get(String(e.id)) ?? null)
          : (editorName.get(String(e.editor_id)) ?? null),
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
    // Other people's views of these captures (the person's own are logged but not listed).
    "capture-views": views.data as Row[],
    notifications,
    "late-clock-ins": lateClockIns,
    "timesheet-favourites": favourites,
  };

  // Images still inside the retention window, from the person's own check-ins.
  const policy = (orgRow.data?.policy ?? {}) as { image_retention_days?: unknown };
  const retentionDays =
    typeof policy.image_retention_days === "number" && policy.image_retention_days > 0
      ? Math.floor(policy.image_retention_days)
      : DEFAULT_RETENTION_DAYS;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const wanted = new Map<string, string>(); // storage path -> path inside the ZIP
  for (const c of checkIns) {
    const at = new Date(String(c.scheduled_at));
    if (at.getTime() < cutoff) continue;
    const day = at.toISOString().slice(0, 10);
    for (const file of (c.object_keys as string[] | null) ?? []) {
      wanted.set(`${org}/${userId}/${day}/${c.id}/${file}`, `captures/${day}/${c.id}/${file}`);
    }
  }
  const found = wanted.size
    ? await admin.rpc("export_capture_objects", { p_user_id: userId, p_paths: [...wanted.keys()] })
    : { data: [], error: null };
  if (found.error) throw new Error(found.error.message);
  const images = (found.data as { name: string; bytes: number }[]).map((i) => ({
    path: i.name,
    zipPath: wanted.get(i.name) ?? "",
    bytes: Number(i.bytes),
  }));
  const imageBytes = images.reduce((sum, i) => sum + i.bytes, 0);
  if (imageBytes > MAX_IMAGE_BYTES) {
    return reply(
      {
        error: "export_too_large",
        message:
          mode === "self"
            ? `Your images add up to ${megabytes(imageBytes)}, over the ${megabytes(MAX_IMAGE_BYTES)} limit for one download. Ask your admin for an export in parts.`
            : `Their images add up to ${megabytes(imageBytes)}, over the ${megabytes(MAX_IMAGE_BYTES)} limit for one download.`,
      },
      413,
    );
  }

  const counts = Object.fromEntries(Object.entries(datasets).map(([k, v]) => [k, v.length]));
  // Logged before anything is returned (AUD-01).
  await o.record({
    ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k.replaceAll("-", "_"), v])),
    capture_images: images.length,
    capture_image_bytes: imageBytes,
  });

  const encoder = new TextEncoder();
  const generatedAt = new Date().toISOString();
  const texts: { name: string; data: Uint8Array }[] = [
    {
      name: "README.txt",
      data: encoder.encode(
        readme(
          mode,
          String(profile[0]?.full_name ?? (mode === "self" ? "you" : "this person")),
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
      "Content-Disposition": `attachment; filename="${
        mode === "self"
          ? `ai-proctor-my-data-${generatedAt.slice(0, 10)}.zip`
          : `ai-proctor-user-data-${userId.slice(0, 8)}-${generatedAt.slice(0, 10)}.zip`
      }"`,
      "Cache-Control": "no-store",
    },
  });
}
