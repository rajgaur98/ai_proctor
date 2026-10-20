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

/** Why a capture failed; the check-in still passes (CAP-08). */
export const CaptureFailure = z.enum(["permission_missing", "camera_busy", "no_camera", "failed"]);

const payloads = {
  clock_in: z.strictObject({
    project_id: uuid.nullable().optional(),
    reason: z.enum(["manual", "auto"]),
  }),
  clock_out: z.strictObject({
    // auto: forgotten clock-out (SHF-04)
    reason: z.enum(["manual", "auto"]),
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
    // Raw anti-cheat state; the server decides what it means (ANT-08). The Windows
    // agent adds `injected_click:<n>` when it blocked n injected clicks on the card.
    flags: z.array(z.string().max(40)).max(10),
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
  // killed: it never exited normally; exited: a normal exit; rebooted: the device started
  // up since. Only killed is Tamper, for the time since last_alive_at.
  agent_restart: z.strictObject({
    last_alive_at: timestamp,
    reason: z.enum(["killed", "exited", "rebooted"]),
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
