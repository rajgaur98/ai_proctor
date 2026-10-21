// Events the agent sends through the agent_events RPC (LLD section 03/04). These Zod
// schemas are the source of truth: `pnpm contracts:gen` exports them to
// generated/agent-event.schema.json, which the database stores and checks every
// incoming event against (pg_jsonschema), and which the Rust agent will use for
// its serde types.
import { z } from "zod";
import { PermissionState } from "./ipc.ts";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const nonNegativeInt = z.int().min(0);

/** Why a due check-in was held back: a call, a screen share or a presentation (CHK-03). */
export const DeferralReason = z.enum(["call", "screen_share", "presenting"]);

/**
 * What is making the device count as in a call (STS rule 8): the camera or mic in use
 * by another app, a screen share, or a full-screen presentation. Raw state only; the
 * server decides In meeting while any source is on.
 */
export const CallSource = z.enum(["camera", "mic", "screen_share", "presenting"]);

/**
 * The anti-cheat flags an agent puts on a `checkin` (#26, #63), each turned into a
 * "needs review" row by `internal.anticheat_from_checkin` and never into a penalty
 * (ANT-08). `<n>` is a count, `<name>` a camera name of at most 24 plain characters.
 */
export const CheckinFlag = {
  /** ANT-02 (Windows): n injected clicks on the card were blocked. */
  injected_click: "injected_click:<n>",
  /** ANT-03 (macOS): n clicks on the card looked synthetic; let through, flag only. */
  synthetic_click: "synthetic_click:<n>",
  /** ANT-05: the webcam frame came from a known virtual camera. */
  virtual_camera: "virtual_camera:<name>",
  /** ANT-06: the webcam frame is near-identical to an earlier pass's; n differing bits of 256. */
  duplicate_frame: "duplicate_frame:<n>",
  /** ANT-07: the agent ran in a virtual machine. */
  virtual_machine: "virtual_machine",
  /** ANT-07: the session was remote (Remote Desktop) or remotely controlled. */
  remote_session: "remote_session",
  /** CAP-04: an excluded app was in front, so its screen was replaced (not anti-cheat). */
  excluded_app: "excluded_app",
} as const;

function checkinFlagsHelp(): string {
  return `Raw anti-cheat flags; unknown ones are ignored. Known: ${Object.values(CheckinFlag).join(", ")}.`;
}

/** Why a capture failed; the check-in still passes (CAP-08). */
export const CaptureFailure = z.enum(["permission_missing", "camera_busy", "no_camera", "failed"]);

const payloads = {
  clock_in: z.strictObject({
    project_id: uuid.nullable().optional(),
    reason: z.enum(["manual", "auto"]),
  }),
  clock_out: z.strictObject({
    // auto: forgotten clock-out (SHF-04); session_end: the OS ended the session (logout,
    // restart, shutdown), so the shift ends there (ANT-01), never as Tamper
    reason: z.enum(["manual", "auto", "session_end"]),
  }),
  break_start: z.strictObject({
    planned_min: z
      .union([z.literal(15), z.literal(30), z.literal(60)])
      .nullable()
      .optional(),
  }),
  break_end: z.strictObject({}),
  pause_start: z.strictObject({
    planned_min: z.union([z.literal(5), z.literal(10), z.literal(15)]),
    // Private to the employee: managers and admins cannot read it (BRK-03).
    reason: z.string().max(200).optional(),
  }),
  pause_end: z.strictObject({}),
  project_switch: z.strictObject({ project_id: uuid.nullable() }),
  checkin: z.strictObject({
    scheduled_at: timestamp,
    shown_at: timestamp.nullable().optional(),
    responded_at: timestamp.nullable().optional(),
    // deferred: held for a call, share or presentation; nothing shown or captured.
    outcome: z.enum(["pass", "miss", "failed", "deferred"]),
    // Required with `deferred` and only then (the database enforces both).
    deferral_reason: DeferralReason.nullable().optional(),
    response_ms: nonNegativeInt.nullable().optional(),
    wrong_clicks: z.int().min(0).max(2),
    idle_s_at_show: nonNegativeInt.nullable().optional(),
    device_state: z.string().max(32).nullable().optional(),
    // File names only; only a pass captures anything (the database enforces it).
    object_keys: z.array(z.string().regex(/^[a-z0-9-]{1,40}\.webp$/)).max(8),
    capture_errors: z
      .strictObject({ screen: CaptureFailure.optional(), webcam: CaptureFailure.optional() })
      .optional(),
    project_id: uuid.nullable().optional(),
    // Raw anti-cheat state; the server decides what it means (ANT-08). Free text on
    // purpose: a flag the server doesn't know is ignored rather than failing the event,
    // so a newer agent never loses check-ins to an older server. The known ones are in
    // `CheckinFlag` (and in the schema's description).
    flags: z.array(z.string().max(40)).max(10).meta({ description: checkinFlagsHelp() }),
  }),
  idle_start: z.strictObject({ since: timestamp }),
  idle_end: z.strictObject({}),
  lock: z.strictObject({}),
  unlock: z.strictObject({}),
  sleep: z.strictObject({}),
  wake: z.strictObject({}),
  call_start: z.strictObject({ source: CallSource }),
  call_end: z.strictObject({ source: CallSource }),
  app_session: z.strictObject({
    app: z.string().min(1).max(200),
    title: z.string().max(500).nullable().optional(),
    domain: z.string().max(253).nullable().optional(),
    start: timestamp,
    end: timestamp,
  }),
  permission_change: z.strictObject({ screen: PermissionState, camera: PermissionState }),
  // The watchdog started the agent again after a run that ended during a shift (ANT-01).
  // killed: it never exited normally (a kill, or a quit while clocked in that the OS did not
  // announce); exited: a normal exit; session_end: the OS announced a logout, restart or
  // shutdown but the clock-out was not recorded; rebooted: the device started up since.
  // Only killed is Tamper, for the time since last_alive_at.
  agent_restart: z.strictObject({
    last_alive_at: timestamp,
    reason: z.enum(["killed", "exited", "session_end", "rebooted"]),
  }),
} as const;

export type AgentEventType = keyof typeof payloads;
export const agentEventTypes = Object.keys(payloads) as AgentEventType[];

const envelope = {
  // UUIDv7 generated on the device; the server deduplicates on it.
  id: uuid,
  // Per device, +1 per event.
  seq: z.int().min(1),
  // Device wall clock.
  at: timestamp,
  // Monotonic clock, for skew repair.
  mono_ms: nonNegativeInt,
};

function event<T extends AgentEventType>(type: T) {
  return z.strictObject({ ...envelope, type: z.literal(type), payload: payloads[type] });
}

export const AgentEvent = z
  .discriminatedUnion(
    "type",
    agentEventTypes.map((t) => event(t)) as unknown as [
      ReturnType<typeof event>,
      ...ReturnType<typeof event>[],
    ],
  )
  .meta({ id: "AgentEvent" });

export type AgentEvent = {
  [T in AgentEventType]: {
    id: string;
    seq: number;
    at: string;
    mono_ms: number;
    type: T;
    payload: z.infer<(typeof payloads)[T]>;
  };
}[AgentEventType];

/** Maximum events per agent_events call (LLD: ≤ 100 events or 256 KB). */
export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_BATCH_BYTES = 256 * 1024;
