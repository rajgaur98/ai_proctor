// Demo seed (#351): the steps that go over HTTP, as production does them.
//
//   node supabase/demo/http.ts rebuild
//     Calls the rebuild-segments Edge Function the way the segments_kick cron does
//     (service-role key, oldest due dirty days first) until no day is due, so
//     time_segments are current when the script ends.
//   node supabase/demo/http.ts retention
//     Runs the nightly retention job (the retention-purge Edge Function, as pg_cron
//     calls it): check-ins older than the image retention get their captures marked
//     deleted (their files were never uploaded, see below).
//   node supabase/demo/http.ts captures <file>
//     Uploads a placeholder image for every object a passed check-in named, the way the
//     agent does after the event was acked: signed in as that person, into the captures
//     bucket, at internal.capture_path. The storage policy (can_upload_capture) checks
//     each one. The images are solid colours generated here (no screens, no faces).
//     <file>: tab-separated email, org_id, user_id, UTC day, check-in id, object name.
//
// Env: AI_PROCTOR_SUPABASE_URL, _ANON_KEY, _SERVICE_ROLE_KEY (scripts/demo-seed.sh sets them).
import { readFileSync } from "node:fs";
import { rng, solidWebp } from "./lib.ts";

const api = process.env.AI_PROCTOR_SUPABASE_URL ?? "";
const anon = process.env.AI_PROCTOR_SUPABASE_ANON_KEY ?? "";
const service = process.env.AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!api || !anon || !service) {
  console.error(
    "Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY and _SERVICE_ROLE_KEY (scripts/demo-seed.sh does).",
  );
  process.exit(2);
}

async function rebuild() {
  let rebuilt = 0;
  let failed = 0;
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${api}/functions/v1/rebuild-segments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 200 }),
    });
    const body = (await res.json()) as {
      rebuilt?: number;
      failed?: number;
      locked?: number;
      days?: unknown[];
    };
    if (!res.ok) throw new Error(`rebuild-segments: ${res.status} ${JSON.stringify(body)}`);
    rebuilt += body.rebuilt ?? 0;
    failed += body.failed ?? 0;
    if ((body.days ?? []).length === 0) break;
  }
  console.log(`segments rebuilt for ${rebuilt} days${failed > 0 ? `, ${failed} failed` : ""}`);
  if (failed > 0) process.exitCode = 1;
}

async function retention() {
  const res = await fetch(`${api}/functions/v1/retention-purge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`retention-purge: ${res.status} ${body}`);
}

// Muted desktop colours for screens; a warm grey for the webcam frame.
const screens: [number, number, number][] = [
  [52, 73, 94],
  [44, 62, 80],
  [96, 125, 139],
  [69, 90, 100],
  [38, 70, 83],
  [62, 80, 110],
  [84, 110, 122],
  [55, 71, 79],
  [70, 90, 120],
  [33, 47, 61],
];
const webcam = solidWebp(320, 240, [128, 116, 104]);
const screenImages = screens.map((c) => solidWebp(640, 400, c));

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${api}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok || !body.access_token)
    throw new Error(`sign-in ${email}: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

async function captures(file: string) {
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.split("\t") as [string, string, string, string, string, string]);
  const tokens = new Map<string, string>();
  for (const email of new Set(rows.map((r) => r[0]))) tokens.set(email, await signIn(email));

  let next = 0;
  let ok = 0;
  const errors: string[] = [];
  async function worker() {
    while (next < rows.length) {
      const [email, org, user, day, checkin, name] = rows[next++] as (typeof rows)[number];
      const path = `${org}/${user}/${day}/${checkin}/${name}`;
      const image =
        name === "webcam.webp"
          ? webcam
          : (screenImages[
              Math.floor(rng(`${user}/${name}`)() * screenImages.length)
            ] as Uint8Array<ArrayBuffer>);
      const res = await fetch(`${api}/storage/v1/object/captures/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.get(email)}`,
          apikey: anon,
          "Content-Type": "image/webp",
        },
        body: image,
      });
      if (res.ok) ok += 1;
      else errors.push(`${path}: ${res.status} ${await res.text()}`);
    }
  }
  await Promise.all(Array.from({ length: 48 }, worker));
  console.log(`captures uploaded: ${ok} of ${rows.length}`);
  if (errors.length > 0) {
    console.error(errors.slice(0, 5).join("\n"));
    process.exitCode = 1;
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "rebuild") await rebuild();
else if (cmd === "retention") await retention();
else if (cmd === "captures" && arg) await captures(arg);
else {
  console.error("usage: http.ts rebuild | retention | captures <file>");
  process.exit(2);
}
