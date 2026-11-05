// Demo seed generator (#351). Prints one SQL script (stdout) that loads the plan for
// the demo data into a scratch `demo` schema: the people, the org's catalogue, the
// leave/holiday/manual-entry/timesheet plans, and ~4 weeks of raw agent events per
// person, ending now. The SQL files next to it (10_setup.sql, 20_replay.sql, ...) turn
// that plan into real data through the server's own RPCs and internal.apply_event.
//
// Every agent event is checked here against the events contract (packages/contracts,
// AgentEvent: the Zod source of truth the database's JSON Schema is generated from).
// Deterministic: a person's day comes from a PRNG seeded with their key and the day
// offset, so reruns give the same story, shifted to the current time. Times are built
// in each person's own time zone (never UTC days).
//
// Usage: node supabase/demo/generate.ts [now-ms] > plan.sql   (scripts/demo-seed.sh)

import { AgentEvent } from "../../packages/contracts/src/events.ts";
import {
  between,
  chance,
  type Day,
  dayOf,
  dayString,
  hm,
  int,
  iso,
  isoDow,
  localToUtc,
  pick,
  type Rand,
  rng,
  uuid,
  weighted,
} from "./lib.ts";
import {
  apps,
  byKey,
  clients,
  type Habits,
  type Person,
  people,
  projects,
  type ShiftDef,
  steady,
  teams,
} from "./roster.ts";

const MIN = 60_000;
const NOW = Number(process.argv[2] ?? Date.now());
/** Nothing is generated after this: the agent's last word is a few seconds old. */
const CUTOFF = NOW - 20_000;
const HISTORY_DAYS = 28;
/** One app_session bucket every SAMPLE minutes of focused work (the agent sends one per minute). */
const SAMPLE_RECENT = 4;
const SAMPLE_OLD = 10;
const CHECKIN_MIN = 20;
const CHECKIN_MAX = 90;
const RESPONSE_S = 90;

const today = (p: Person) => dayOf(p.tz, NOW);
const orgToday = dayOf("America/New_York", NOW);

/** Nearest weekday at or before (back) / after (forward) a day. */
function weekday(d: Day, back = true): Day {
  let x = d;
  while (isoDow(x) > 5) x += back ? -1 : 1;
  return x;
}

// ---- plans ------------------------------------------------------------------------------

interface Holiday {
  day: Day;
  name: string;
  country: string | null;
  state: string | null;
  /** Created during the replay at this instant (a holiday that is today), else up front. */
  at?: number;
}
const ana = byKey.get("ana") as Person;
const holidays: Holiday[] = [
  { day: weekday(orgToday - 17), name: "Company wellness day", country: null, state: null },
  { day: weekday(orgToday + 9, false), name: "Founders' Day", country: null, state: null },
  { day: weekday(orgToday - 12), name: "Nevada Day", country: "US", state: "NV" },
  { day: weekday(orgToday - 20), name: "Texas office closure", country: "US", state: "TX" },
  { day: weekday(orgToday + 6, false), name: "Remembrance Day", country: "CA", state: null },
  {
    day: weekday(orgToday + 21, false),
    name: "California office closure",
    country: "US",
    state: "CA",
  },
  {
    day: today(ana),
    name: "Hawaii office holiday",
    country: "US",
    state: "HI",
    at: localToUtc(ana.tz, today(ana), 0),
  },
];
function holidayFor(p: Person, d: Day): boolean {
  return holidays.some(
    (h) =>
      h.day === d &&
      (h.country === null ||
        (h.country === p.country && (h.state === null || h.state === p.state))),
  );
}

type LeaveOutcome = "approved" | "rejected" | "pending" | "cancelled" | "approved_cancelled";
interface Leave {
  who: string;
  type: "Vacation" | "Sick" | "Personal" | "Unpaid";
  from: number;
  to: number;
  part?: [string, string];
  outcome: LeaveOutcome;
  decider?: string;
  note?: string;
  decisionNote?: string;
  /** setup: before the replay; action: when it starts (covers today); later: after the replay. */
  when: "setup" | "action" | "later";
}
const leaves: Leave[] = [
  {
    who: "emily",
    type: "Vacation",
    from: -1,
    to: 2,
    outcome: "approved",
    decider: "kenji",
    note: "Family trip",
    when: "action",
  },
  {
    who: "nina",
    type: "Sick",
    from: 0,
    to: 0,
    outcome: "approved",
    decider: "daniel",
    note: "Flu",
    when: "action",
  },
  {
    who: "grace",
    type: "Vacation",
    from: -2,
    to: 3,
    outcome: "approved",
    decider: "ada",
    note: "Out of office, Daniel covers",
    when: "action",
  },
  {
    who: "isabella",
    type: "Vacation",
    from: -17,
    to: -15,
    outcome: "approved",
    decider: "kenji",
    when: "setup",
  },
  {
    who: "carlos",
    type: "Sick",
    from: -6,
    to: -6,
    outcome: "approved",
    decider: "max",
    when: "setup",
  },
  {
    who: "hannah",
    type: "Personal",
    from: -11,
    to: -11,
    outcome: "approved",
    decider: "max",
    note: "Moving day",
    when: "setup",
  },
  {
    who: "andre",
    type: "Vacation",
    from: -24,
    to: -22,
    outcome: "approved",
    decider: "priya",
    when: "setup",
  },
  {
    who: "malik",
    type: "Unpaid",
    from: -9,
    to: -8,
    outcome: "approved",
    decider: "omar",
    when: "setup",
  },
  {
    who: "owen",
    type: "Sick",
    from: -2,
    to: -2,
    outcome: "approved",
    decider: "priya",
    when: "setup",
  },
  {
    who: "priyanka",
    type: "Personal",
    from: -4,
    to: -4,
    part: ["13:00", "17:00"],
    outcome: "approved",
    decider: "priya",
    note: "Doctor's appointment",
    when: "setup",
  },
  {
    who: "jamal",
    type: "Vacation",
    from: -13,
    to: -13,
    outcome: "rejected",
    decider: "grace",
    decisionNote: "Quarter-end push, sorry",
    when: "setup",
  },
  { who: "catherine", type: "Personal", from: -7, to: -7, outcome: "cancelled", when: "setup" },
  {
    who: "priyanka",
    type: "Vacation",
    from: 5,
    to: 9,
    outcome: "pending",
    note: "Visiting family",
    when: "later",
  },
  {
    who: "chloe",
    type: "Personal",
    from: 3,
    to: 3,
    part: ["09:00", "12:00"],
    outcome: "pending",
    when: "later",
  },
  {
    who: "sofia",
    type: "Vacation",
    from: 6,
    to: 10,
    outcome: "approved",
    decider: "daniel",
    when: "later",
  },
  {
    who: "ravi",
    type: "Vacation",
    from: 14,
    to: 16,
    outcome: "rejected",
    decider: "sofia",
    decisionNote: "Release week; can we move it?",
    when: "later",
  },
  {
    who: "aisha",
    type: "Vacation",
    from: 20,
    to: 21,
    outcome: "approved_cancelled",
    decider: "max",
    when: "later",
  },
  {
    who: "erin",
    type: "Vacation",
    from: 12,
    to: 13,
    outcome: "approved",
    decider: "max",
    when: "later",
  },
  { who: "ada", type: "Personal", from: 30, to: 30, outcome: "approved", when: "later" },
];
function leaveFor(p: Person, d: Day): Leave | undefined {
  const t = today(p);
  return leaves.find(
    (l) =>
      l.who === p.key &&
      (l.outcome === "approved" || l.outcome === "approved_cancelled") &&
      d >= t + l.from &&
      d <= t + l.to,
  );
}

// ---- event output -------------------------------------------------------------------------

interface Row {
  person: string;
  device: number;
  seq: number;
  id: string;
  at: number;
  type: string;
  payload: unknown;
}
const rows: Row[] = [];
const seqs = new Map<string, number>();
const actions: { at: number; kind: string; person: string; args: Record<string, unknown> }[] = [];
const manual: {
  person: string;
  start: number;
  end: number;
  project: string;
  reason: string;
  note: string | null;
  outcome: string;
}[] = [];
const sessions = new Map<string, { start: number; end: number }[]>();
const historyStart = NOW - (HISTORY_DAYS + 1) * 86_400_000;

function emit(p: Person, device: number, at: number, type: string, payload: unknown, r: Rand) {
  // Pseudo-events (a missed contact, a restored one) carry no envelope.
  if (type.startsWith("_")) {
    rows.push({ person: p.key, device, seq: 0, id: uuid(r), at, type, payload });
    return;
  }
  const k = `${p.key}/${device}`;
  const seq = (seqs.get(k) ?? 0) + 1;
  seqs.set(k, seq);
  const ev = { id: uuid(r), seq, at: iso(at), mono_ms: at - historyStart, type, payload };
  const parsed = AgentEvent.safeParse(ev);
  if (!parsed.success) {
    throw new Error(`invalid ${type} for ${p.key}: ${parsed.error.message}\n${JSON.stringify(ev)}`);
  }
  rows.push({ person: p.key, device, seq, id: ev.id, at, type, payload });
}

// ---- one block of work ---------------------------------------------------------------------

type Kind = "break" | "pause" | "idle" | "lock" | "call" | "sleep" | "drop" | "kill";
interface Gap {
  a: number;
  b: number;
  kind: Kind;
  planned?: number | undefined;
}

function teamProjects(p: Person) {
  return projects.filter((x) => !x.archived && p.team !== null && x.teams.includes(p.team));
}

interface BlockOpts {
  start: number;
  end: number;
  /** A planned shift: the person may be late, leave early or stay longer. */
  scheduled: boolean;
  /** Still clocked in at the cutoff with this live state to finish on. */
  live?: Person["live"];
  device: number;
}

function simulate(p: Person, d: Day, o: BlockOpts, r: Rand) {
  const h: Habits = { ...steady, ...p.habits };
  const off = d - today(p);
  const recent = off >= -6;
  const sample = recent ? SAMPLE_RECENT : SAMPLE_OLD;

  let cin = o.start;
  let cout = o.end;
  if (o.scheduled) {
    cin += (chance(r, h.late) ? int(r, 12, 48) : int(r, -9, 3)) * MIN;
    if (chance(r, h.early)) cout -= int(r, 30, 95) * MIN;
    else if (chance(r, h.overtime)) cout += int(r, 15, 70) * MIN;
    else cout += int(r, -4, 9) * MIN;
  }
  const part = leaveFor(p, d)?.part;
  if (part && o.scheduled) cout = Math.min(cout, localToUtc(p.tz, d, hm(part[0])));
  if (cin >= CUTOFF) return;
  if (cout - cin < 45 * MIN) return;
  // Clocked in after the 15-minute grace: the late clock-in alert's moment (ALR-01).
  if (o.scheduled && cin > o.start + 15 * MIN && o.start + 16 * MIN <= CUTOFF) {
    emit(p, o.device, o.start + 16 * MIN, "_tick", {}, r);
  }

  const forgot = !o.live && chance(r, h.forget);
  const sessionEnd = !o.live && !forgot && chance(r, 0.03);
  // A forgotten clock-out: they walk away at `cout`, the agent closes the shift later.
  const workEnd = cout;
  if (forgot) cout = workEnd + int(r, 30, 36) * MIN;
  const liveFrom = o.live ? o.end - 65 * MIN : Number.POSITIVE_INFINITY;
  const planEnd = Math.min(workEnd, liveFrom);

  // Interruptions, placed so they never overlap (5 min apart).
  const gaps: Gap[] = [];
  const place = (len: number, kind: Kind, centre?: number, planned?: number) => {
    for (let i = 0; i < 25; i++) {
      const a =
        centre !== undefined && i < 8
          ? centre + int(r, -40, 40) * MIN
          : cin + 20 * MIN + r() * (planEnd - cin - 40 * MIN - len);
      const b = a + len;
      if (a < cin + 15 * MIN || b > planEnd - 15 * MIN) continue;
      if (gaps.some((g) => a < g.b + 5 * MIN && b > g.a - 5 * MIN)) continue;
      gaps.push({ a: Math.round(a / 1000) * 1000, b: Math.round(b / 1000) * 1000, kind, planned });
      return;
    }
  };
  const poisson = (mean: number) => {
    let k = 0;
    const x = r();
    let pk = Math.exp(-mean);
    let cum = pk;
    while (x > cum && k < 8) {
      k += 1;
      pk *= mean / k;
      cum += pk;
    }
    return k;
  };
  const span = planEnd - cin;
  if (span >= 6 * 60 * MIN) {
    const planned = weighted(r, [
      [30, 6],
      [60, 4],
    ] as const);
    place((planned + int(r, -3, 7)) * MIN, "break", cin + span * between(r, 0.42, 0.58), planned);
    if (chance(r, 0.35)) place((15 + int(r, -2, 4)) * MIN, "break", undefined, 15);
  }
  if (h.longPauseDays.includes(off)) {
    for (let i = 0; i < 4; i++) place(int(r, 17, 24) * MIN, "pause", undefined, 15);
  } else {
    for (let i = 0; i < poisson(h.pauses); i++) {
      const planned = pick(r, [5, 10, 15] as const);
      place(
        (planned + (chance(r, 0.2) ? int(r, 1, 8) : int(r, -2, 0))) * MIN,
        "pause",
        undefined,
        planned,
      );
    }
  }
  for (let i = 0; i < poisson(h.calls); i++) place(int(r, 25, 60) * MIN, "call");
  for (let i = 0; i < poisson(h.idle); i++) place(int(r, 14, 35) * MIN, "idle");
  for (let i = 0; i < poisson(h.locks); i++) place(int(r, 4, 15) * MIN, "lock");
  if (chance(r, h.sleep)) place(int(r, 15, 45) * MIN, "sleep");
  if (chance(r, h.drop)) place(int(r, 22, 45) * MIN, "drop");
  if (chance(r, h.kill)) place(int(r, 8, 25) * MIN, "kill");
  gaps.sort((x, y) => x.a - y.a);

  // The live crew's last hour: a clean run into the state they are in now.
  if (o.live) {
    const L = o.end; // = now
    const add = (a: number, b: number, kind: Kind, planned?: number) =>
      gaps.push({ a, b, kind, planned });
    switch (o.live) {
      case "on_break":
        add(L - 12 * MIN, L + 30 * MIN, "break", 30);
        break;
      case "paused":
        add(L - 6 * MIN, L + 10 * MIN, "pause", 10);
        break;
      case "idle":
        add(L - 24 * MIN, L + 60 * MIN, "idle");
        break;
      case "away_locked":
        add(L - 8 * MIN, L + 60 * MIN, "lock");
        break;
      case "in_meeting":
        add(L - 20 * MIN, L + 40 * MIN, "call");
        break;
      case "offline":
        add(L - 45 * MIN, L + 60 * MIN, "drop");
        break;
      default:
        break;
    }
  }
  const gapAt = (t: number) => gaps.find((g) => t >= g.a && t < g.b);

  // Projects: the day starts on one, and may switch once or twice.
  const mine = teamProjects(p);
  const work = mine.filter((x) => x.billable);
  const pool = work.length > 0 ? work : mine;
  const switches: { at: number; project: string; task: string | null }[] = [];
  const chooseTask = (proj: (typeof projects)[number]) =>
    proj.tasks.length > 0 && chance(r, 0.75) ? pick(r, proj.tasks).fake : null;
  let first = pick(r, pool);
  let firstTask = chooseTask(first);
  const nSwitch = int(r, 0, 2);
  for (let i = 0; i < nSwitch; i++) {
    const t = cin + r() * (planEnd - cin);
    if (gapAt(t) || t > planEnd - 10 * MIN) continue;
    const proj = chance(r, 0.25)
      ? (mine.find((x) => x.key === "internal") ?? first)
      : pick(r, mine);
    switches.push({ at: Math.round(t / 1000) * 1000, project: proj.fake, task: chooseTask(proj) });
  }
  switches.sort((x, y) => x.at - y.at);
  if (mine.length === 0) {
    first = projects[1] as (typeof projects)[number];
    firstTask = null;
  }
  const projectAt = (t: number) => {
    let cur = first.fake;
    for (const s of switches) if (s.at <= t) cur = s.project;
    return cur;
  };

  // Events --------------------------------------------------------------------------------
  const ev = (at: number, type: string, payload: unknown) => {
    if (at <= CUTOFF) emit(p, o.device, at, type, payload, r);
  };
  // Night Ops has auto clock-in on (team policy): the agent clocks them in at shift start.
  ev(cin, "clock_in", {
    project_id: first.fake,
    reason: p.team === "nightops" && o.scheduled ? "auto" : "manual",
  });
  if (firstTask) ev(cin + 4000, "project_switch", { project_id: first.fake, task_id: firstTask });
  for (const s of switches) ev(s.at, "project_switch", { project_id: s.project, task_id: s.task });

  for (const g of gaps) {
    switch (g.kind) {
      case "break":
        ev(g.a, "break_start", { planned_min: g.planned ?? null });
        ev(g.b, "break_end", {});
        break;
      case "pause":
        ev(g.a, "pause_start", {
          planned_min: g.planned ?? 10,
          ...(chance(r, 0.4)
            ? {
                reason: pick(r, [
                  "School pickup",
                  "Delivery at the door",
                  "Quick errand",
                  "Phone call",
                ]),
              }
            : {}),
        });
        ev(g.b, "pause_end", {});
        break;
      case "idle": {
        // The agent reports idle once the threshold (10 min) is reached.
        ev(g.a + 10 * MIN, "idle_start", { since: iso(g.a) });
        ev(g.b, "idle_end", {});
        break;
      }
      case "lock":
        ev(g.a, "lock", {});
        ev(g.b, "unlock", {});
        break;
      case "call": {
        const source = weighted(r, [
          ["camera", 5],
          ["mic", 3],
          ["screen_share", 2],
        ] as const);
        ev(g.a, "call_start", { source });
        ev(g.b, "call_end", { source });
        break;
      }
      case "sleep":
        ev(g.a, "sleep", {});
        ev(g.a + 3 * MIN + 30_000, "_offline", {});
        if (g.b > g.a + 19 * MIN) ev(g.a + 19 * MIN, "_tick", {});
        ev(g.b, "wake", {});
        break;
      case "drop":
        ev(g.a + 3 * MIN + 30_000, "_offline", {});
        if (g.b > g.a + 19 * MIN) ev(g.a + 19 * MIN, "_tick", {});
        ev(g.b, "_contact", {});
        break;
      case "kill":
        ev(g.a + 3 * MIN + 30_000, "_offline", {});
        if (g.b > g.a + 19 * MIN) ev(g.a + 19 * MIN, "_tick", {});
        ev(g.b, "agent_restart", { last_alive_at: iso(g.a), reason: "killed" });
        ev(g.b + 1000, "_tick", {});
        break;
    }
  }
  // The daily pause cap (60 min) crossed: the pause alert's moment.
  const pauses = gaps.filter((g) => g.kind === "pause");
  if (pauses.reduce((t, g) => t + g.b - g.a, 0) > 60 * MIN) {
    ev((pauses[pauses.length - 1] as Gap).b + 1000, "_tick", {});
  }

  // Check-ins (CHK-01): every 20-90 minutes of working time.
  const missRun = h.missRunDays.includes(off);
  let runLeft = missRun ? 3 : 0;
  let s = cin + between(r, CHECKIN_MIN, CHECKIN_MAX) * MIN;
  let lastOutcome: string | null = null;
  let missStreak = 0;
  // The minutes a card was answered in: the activity sample there names the app in front.
  const answered = new Set<number>();
  const end = o.live ? liveFrom : workEnd;
  let n = 0;
  while (s < end - 3 * MIN) {
    s = Math.round(s / 1000) * 1000;
    const g =
      gapAt(s) ??
      gaps.find((x) => (x.kind === "break" || x.kind === "pause") && x.a > s && x.a < s + 100_000);
    if (g && g.kind !== "lock" && g.kind !== "idle") {
      if (g.kind === "call" && s >= g.a) {
        ev(s, "checkin", {
          scheduled_at: iso(s),
          shown_at: null,
          responded_at: null,
          outcome: "deferred",
          deferral_reason: "call",
          response_ms: null,
          wrong_clicks: 0,
          idle_s_at_show: null,
          device_state: null,
          object_keys: [],
          project_id: projectAt(s),
          flags: [],
        });
        missStreak = 0;
      }
      s = g.b + int(r, 1, 5) * MIN;
      continue;
    }
    n += 1;
    const shown = s + int(r, 0, 2) * 1000;
    const idleS = g?.kind === "idle" ? Math.max(0, Math.round((s - g.a) / 1000)) : int(r, 0, 40);
    let outcome: "pass" | "miss" | "failed";
    if (runLeft > 0 && n >= 2) {
      outcome = "miss";
      runLeft -= 1;
    } else if (g?.kind === "lock") outcome = "miss";
    else if (g?.kind === "idle") outcome = chance(r, 0.7) ? "miss" : "pass";
    else
      outcome = weighted(r, [
        ["pass", 1 - h.miss - h.fail],
        ["miss", h.miss],
        ["failed", h.fail],
      ] as const);
    // ANT-04: a robot-steady responder (low variance), some days inhumanly fast.
    const responseMs = h.fast
      ? off % 5 === 0
        ? int(r, 210, 290)
        : int(r, 860, 960)
      : g?.kind === "idle"
        ? int(r, 20_000, 70_000)
        : Math.round(1500 + 9000 * r() ** 2.2);
    const base = {
      scheduled_at: iso(s),
      shown_at: iso(shown),
      idle_s_at_show: idleS,
      device_state: g?.kind === "lock" ? "locked" : null,
      project_id: projectAt(s),
    };
    if (outcome === "miss") {
      ev(shown + RESPONSE_S * 1000, "checkin", {
        ...base,
        responded_at: null,
        outcome,
        response_ms: null,
        wrong_clicks: chance(r, 0.2) ? 1 : 0,
        object_keys: [],
        flags: [],
      });
      missStreak += 1;
      // Three misses in a row: the consecutive-misses alert's moment.
      if (missStreak >= 3) ev(shown + RESPONSE_S * 1000 + 1000, "_tick", {});
    } else if (outcome === "failed") {
      ev(shown + responseMs, "checkin", {
        ...base,
        responded_at: iso(shown + responseMs),
        outcome,
        response_ms: responseMs,
        wrong_clicks: 2,
        object_keys: [],
        flags: [],
      });
    } else {
      const busy = chance(r, h.cameraBusy);
      const keys = chance(r, h.dual) ? ["screen-1.webp", "screen-2.webp"] : ["screen-1.webp"];
      if (!busy) keys.push("webcam.webp");
      const flags = h.flags.filter(([, pr]) => chance(r, pr)).map(([f]) => f);
      ev(shown + responseMs, "checkin", {
        ...base,
        responded_at: iso(shown + responseMs),
        outcome,
        response_ms: responseMs,
        wrong_clicks: chance(r, 0.05) ? 1 : 0,
        object_keys: keys,
        flags,
        ...(busy
          ? { capture_errors: { webcam: "camera_busy" } }
          : { face_present: !chance(r, h.noFace) }),
      });
    }
    if (outcome !== "miss") {
      missStreak = 0;
      answered.add(Math.floor((shown + responseMs) / MIN) * MIN);
    }
    lastOutcome = outcome;
    s += between(r, CHECKIN_MIN, CHECKIN_MAX) * MIN;
  }

  // The crew's final hour.
  if (o.live) {
    if (lastOutcome !== "pass" && o.live !== "away") {
      const at = liveFrom + 2 * MIN;
      ev(at + 4200, "checkin", {
        scheduled_at: iso(at),
        shown_at: iso(at),
        responded_at: iso(at + 4200),
        outcome: "pass",
        response_ms: 4200,
        wrong_clicks: 0,
        idle_s_at_show: 3,
        device_state: null,
        object_keys: ["screen-1.webp", "webcam.webp"],
        project_id: projectAt(at),
        flags: [],
        face_present: true,
      });
    }
    if (o.live === "away") {
      const at = o.end - 7 * MIN;
      ev(at + RESPONSE_S * 1000, "checkin", {
        scheduled_at: iso(at),
        shown_at: iso(at),
        responded_at: null,
        outcome: "miss",
        response_ms: null,
        wrong_clicks: 0,
        idle_s_at_show: 0,
        device_state: null,
        object_keys: [],
        project_id: projectAt(at),
        flags: [],
      });
    }
    if (o.live === "tamper") {
      ev(o.end - 25 * MIN, "permission_change", { screen: "denied", camera: "granted" });
      ev(o.end - 25 * MIN + 1000, "_tick", {});
    }
  }

  // Activity (ACT-01): one-minute buckets of the app in front, while working.
  const palette = apps[p.team ?? "product"] ?? (apps.product as (typeof apps)[string]);
  let current = weighted(
    r,
    palette.map((a) => [a, a[3]] as const),
  );
  const stop = o.live ? o.end : workEnd;
  const firstMinute = Math.ceil(cin / MIN) * MIN + MIN;
  for (let m = firstMinute; m + MIN <= stop; m += MIN) {
    if (((m - firstMinute) / MIN) % sample !== 0 && !answered.has(m)) continue;
    const g = gaps.find((x) => m < x.b && m + MIN > x.a);
    if (g && g.kind !== "call") continue;
    if (chance(r, 0.3))
      current = weighted(
        r,
        palette.map((a) => [a, a[3]] as const),
      );
    const [app, domain, titles] =
      g?.kind === "call" ? (["Zoom", null, ["Zoom Meeting"], 1] as const) : current;
    const startS = int(r, 0, 20);
    ev(m + 60_000 + int(r, 1, 6) * 1000, "app_session", {
      app,
      title: pick(r, titles),
      domain,
      start: iso(m + startS * 1000),
      end: iso(m + 60_000),
    });
  }

  if (!o.live) {
    if (forgot) ev(workEnd + 10 * MIN, "idle_start", { since: iso(workEnd) });
    ev(cout, "clock_out", { reason: forgot ? "auto" : sessionEnd ? "session_end" : "manual" });
    const list = sessions.get(p.key) ?? [];
    list.push({ start: cin, end: cout });
    sessions.set(p.key, list);
  }
}

// ---- days ----------------------------------------------------------------------------------

function shiftsOn(p: Person, d: Day): ShiftDef[] {
  const off = d - today(p);
  const defs = p.shiftChange && off >= p.shiftChange.fromDay ? p.shiftChange.shifts : p.shifts;
  return defs.filter((s) => s.days.includes(isoDow(d)));
}

function deviceFor(p: Person, d: Day): number {
  if (p.devices < 2) return 1;
  if (p.replaceDeviceDay !== undefined) return d - today(p) >= p.replaceDeviceDay ? 2 : 1;
  return isoDow(d) <= 3 ? 1 : 2;
}

for (const p of people) {
  if (!p.tracked || p.invitedOnly) continue;
  const t = today(p);
  const first = p.joinDay !== undefined ? t + p.joinDay : t - (HISTORY_DAYS - 1);
  const last = p.lastDay !== undefined ? t + p.lastDay : t;
  // The live crew works now, whatever the hour; their earlier days end well before.
  const liveStart = p.live
    ? Math.round((NOW - (3 * 60 + int(rng(`${p.key}/live`), 0, 90)) * MIN) / 1000) * 1000
    : 0;
  for (let d = first; d <= last; d++) {
    const r = rng(`${p.key}/${d - t}`);
    const off = d - t;
    const leave = leaveFor(p, d);
    if ((leave && !leave.part) || holidayFor(p, d)) continue;
    if (p.shifts.length === 0 && !p.shiftChange) {
      // Flexible hours: weekdays (the odd Saturday), starting 8:00-10:30, 7.5-9 hours.
      if (off >= 0) continue;
      if ((isoDow(d) > 5 && !chance(r, 0.08)) || chance(r, 0.02)) continue;
      const start = localToUtc(p.tz, d, int(r, 480, 630));
      const end = start + int(r, 450, 540) * MIN;
      if (p.live && end > liveStart - 60 * MIN) continue;
      simulate(p, d, { start, end, scheduled: false, device: deviceFor(p, d) }, r);
      continue;
    }
    for (const sh of shiftsOn(p, d)) {
      const startMin = hm(sh.start);
      const endMin = hm(sh.end) <= startMin ? hm(sh.end) + 1440 : hm(sh.end);
      const start = localToUtc(p.tz, d, startMin);
      const end = localToUtc(p.tz, d, endMin);
      if (start > CUTOFF) continue;
      // An unannounced absence (no leave): the late clock-in alert's case.
      if (off < 0 && chance(r, p.habits.noShow ?? steady.noShow)) {
        if (start + 16 * MIN <= CUTOFF) emit(p, 1, start + 16 * MIN, "_tick", {}, r);
        continue;
      }
      simulate(p, d, { start, end, scheduled: true, device: deviceFor(p, d) }, r);
    }
  }
  if (p.live) {
    simulate(
      p,
      t,
      { start: liveStart, end: NOW, scheduled: false, live: p.live, device: deviceFor(p, t) },
      rng(`${p.key}/now`),
    );
  }
}

// Joiners register their laptop the morning they start; a replaced laptop is revoked and
// the new one registered; a leaver hands theirs back the evening of their last day.
for (const p of people) {
  const t = today(p);
  if (p.joinDay !== undefined) {
    actions.push({
      at: localToUtc(p.tz, t + p.joinDay, 7 * 60),
      kind: "register_device",
      person: p.key,
      args: { device: 1 },
    });
  }
  if (p.replaceDeviceDay !== undefined) {
    const at = localToUtc(p.tz, t + p.replaceDeviceDay, 7 * 60);
    actions.push({ at, kind: "revoke_device", person: p.key, args: { device: 1, by: "tom" } });
    actions.push({ at: at + MIN, kind: "register_device", person: p.key, args: { device: 2 } });
  }
  if (p.lastDay !== undefined) {
    actions.push({
      at: localToUtc(p.tz, t + p.lastDay, 20 * 60),
      kind: "revoke_device",
      person: p.key,
      args: { device: 1, by: "tom" },
    });
  }
}
for (const l of leaves.filter((x) => x.when === "action")) {
  const p = byKey.get(l.who) as Person;
  actions.push({
    at: localToUtc(p.tz, today(p) + l.from, 0) + MIN,
    kind: "leave",
    person: l.who,
    args: { leave: leaves.indexOf(l) },
  });
}
for (const h of holidays.filter((x) => x.at !== undefined)) {
  actions.push({
    at: h.at as number,
    kind: "holiday",
    person: "ada",
    args: { holiday: holidays.indexOf(h) },
  });
}

// Manual entries (MAN-01): time away from the laptop, after a day's clock-out.
const manualPlan: [string, number, string, string | null, string, number][] = [
  [
    "hannah",
    -3,
    "Customer call from my phone between shifts",
    "Escalation for Umbrella",
    "approved",
    50,
  ],
  ["carlos", -5, "Worked on tickets offline after my shift", null, "rejected", 80],
  ["marcus", -1, "Training webinar without the laptop", "Zendesk admin course", "pending", 60],
  ["isabella", -2, "Design review at the client's office", null, "pending", 90],
  ["aisha", -9, "Onsite customer visit", "Umbrella HQ", "approved", 120],
  ["william", -10, "Conference talk prep offline", "Slides for DevDays", "approved", 75],
  ["zara", -4, "Pairing session on my phone", null, "cancelled", 30],
  ["valentina", -16, "Client lunch meeting", "Initech renewal", "approved", 60],
  ["leah", -8, "Overnight incident follow-up", null, "rejected", 45],
  ["rosa", -1, "User interviews in person", "3 interviews", "pending", 90],
  ["amara", -15, "Bank visit for payroll", null, "approved", 40],
  ["jamal", -18, "Trade show booth", "Day 1", "approved", 180],
];
for (const [who, off, reason, note, outcome, len] of manualPlan) {
  const p = byKey.get(who) as Person;
  const t = today(p);
  const dayStart = localToUtc(p.tz, t + off, 0);
  const dayEnd = localToUtc(p.tz, t + off + 1, 0);
  const s = (sessions.get(who) ?? []).find((x) => x.start >= dayStart && x.start < dayEnd);
  const start = s ? s.end + 25 * MIN : localToUtc(p.tz, t + off, 10 * 60);
  const end = start + len * MIN;
  if (end > CUTOFF) continue;
  const proj =
    teamProjects(p).find((x) => x.billable) ?? (projects[1] as (typeof projects)[number]);
  manual.push({ person: who, start, end, project: proj.fake, reason, note, outcome });
}

// Timesheets (TS-07): weeks back from the current one. The current week stays a draft.
type Sheet = "approved" | "submitted" | "returned" | "draft" | "resubmitted";
function sheetFor(p: Person, week: number): Sheet {
  if (week === 0) return "draft";
  // Arjun's last week is approved: a late check-in for it arrives today (40_timesheets.sql).
  if (p.key === "arjun" && week === 1) return "approved";
  const r = rng(`${p.key}/sheet/${week}`)();
  if (week === 1) {
    if (r < 0.5) return "submitted";
    if (r < 0.7) return "approved";
    if (r < 0.82) return "returned";
    return "draft";
  }
  if (week === 2) {
    if (r < 0.75) return "approved";
    if (r < 0.9) return "submitted";
    return "resubmitted";
  }
  return r < 0.9 ? "approved" : "resubmitted";
}

// ---- SQL out ---------------------------------------------------------------------------------

const out: string[] = [];
const q = (v: unknown) =>
  v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`;
const copyText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");

out.push("-- Generated by supabase/demo/generate.ts; loaded by scripts/demo-seed.sh.");
out.push(`select set_config('demo.now', ${q(iso(NOW))}, false);`);
out.push(
  "insert into demo.people (key, id, seed, full_name, email, role, manager_key, team_key, country, state, tz, shifts, shift_change, tracked, devices, live, invited_only, join_day, last_day, approval_required) values",
);
out.push(
  `${people
    .map((p) => {
      const t = today(p);
      const change = p.shiftChange
        ? JSON.stringify({
            from: dayString(t + p.shiftChange.fromDay),
            shifts: p.shiftChange.shifts.map((s) => ({ ...s, timezone: p.tz })),
          })
        : null;
      return `(${[
        q(p.key),
        q(p.id),
        p.seed ? "true" : "false",
        q(p.name),
        q(p.email),
        q(p.role),
        q(p.manager),
        q(p.team),
        q(p.country),
        q(p.state),
        q(p.tz),
        q(JSON.stringify(p.shifts.map((s) => ({ ...s, timezone: p.tz })))),
        q(change),
        p.tracked ? "true" : "false",
        p.devices,
        q(p.live ?? null),
        p.invitedOnly ? "true" : "false",
        p.joinDay !== undefined ? q(dayString(t + p.joinDay)) : "null",
        p.lastDay !== undefined ? q(dayString(t + p.lastDay)) : "null",
        p.approvalRequired === false ? "false" : "true",
      ].join(", ")})`;
    })
    .join(",\n")};`,
);
out.push("insert into demo.teams (key, name, billable_target) values");
out.push(
  `${teams.map((t) => `(${q(t.key)}, ${q(t.name)}, ${t.billableTarget ?? "null"})`).join(",\n")};`,
);
out.push("insert into demo.clients (key, name, seed_id) values");
out.push(
  `${clients.map((c) => `(${q(c.key)}, ${q(c.name)}, ${q(c.seedId ?? null)})`).join(",\n")};`,
);
out.push(
  "insert into demo.projects (key, fake, name, client_key, billable, archived, seed_id, teams) values",
);
out.push(
  `${projects
    .map(
      (p) =>
        `(${q(p.key)}, ${q(p.fake)}, ${q(p.name)}, ${q(p.client)}, ${p.billable}, ${p.archived === true}, ${q(p.seedId ?? null)}, ${q(`{${p.teams.join(",")}}`)})`,
    )
    .join(",\n")};`,
);
out.push("insert into demo.tasks (fake, project_key, name, ord) values");
out.push(
  `${projects
    .flatMap((p) => p.tasks.map((t, i) => `(${q(t.fake)}, ${q(p.key)}, ${q(t.name)}, ${i})`))
    .join(",\n")};`,
);
out.push("insert into demo.holidays (n, day, name, country, state, at) values");
out.push(
  `${holidays
    .map(
      (h, i) =>
        `(${i}, ${q(dayString(h.day))}, ${q(h.name)}, ${q(h.country)}, ${q(h.state)}, ${q(h.at !== undefined ? iso(h.at) : null)})`,
    )
    .join(",\n")};`,
);
out.push(
  "insert into demo.leaves (n, person, leave_type, first_day, last_day, start_time, end_time, outcome, decider, note, decision_note, phase) values",
);
out.push(
  `${leaves
    .map((l, i) => {
      const t = today(byKey.get(l.who) as Person);
      return `(${[
        i,
        q(l.who),
        q(l.type),
        q(dayString(t + l.from)),
        q(dayString(t + l.to)),
        q(l.part?.[0] ?? null),
        q(l.part?.[1] ?? null),
        q(l.outcome),
        q(l.decider ?? null),
        q(l.note ?? null),
        q(l.decisionNote ?? null),
        q(l.when),
      ].join(", ")})`;
    })
    .join(",\n")};`,
);
if (manual.length > 0) {
  out.push(
    "insert into demo.manual (person, start_at, end_at, project_fake, reason, note, outcome) values",
  );
  out.push(
    `${manual
      .map(
        (m) =>
          `(${q(m.person)}, ${q(iso(m.start))}, ${q(iso(m.end))}, ${q(m.project)}, ${q(m.reason)}, ${q(m.note)}, ${q(m.outcome)})`,
      )
      .join(",\n")};`,
  );
}
out.push("insert into demo.sheets (person, week, outcome) values");
out.push(
  `${people
    .filter((p) => p.tracked && !p.invitedOnly)
    .flatMap((p) => [0, 1, 2, 3, 4].map((w) => `(${q(p.key)}, ${w}, ${q(sheetFor(p, w))})`))
    .join(",\n")};`,
);
out.push("insert into demo.actions (at, kind, person, args) values");
out.push(
  `${actions.map((a) => `(${q(iso(a.at))}, ${q(a.kind)}, ${q(a.person)}, ${q(JSON.stringify(a.args))})`).join(",\n")};`,
);

rows.sort((a, b) => a.at - b.at || a.seq - b.seq);
out.push("copy demo.events (person, device_no, seq, id, at, type, payload) from stdin;");
for (const e of rows) {
  out.push(
    [e.person, e.device, e.seq, e.id, iso(e.at), e.type, copyText(JSON.stringify(e.payload))].join(
      "\t",
    ),
  );
}
out.push("\\.");

process.stdout.write(`${out.join("\n")}\n`);
const counts = new Map<string, number>();
for (const e of rows) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
process.stderr.write(
  `demo plan: ${people.length} people, ${rows.length} events (${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")})\n`,
);
