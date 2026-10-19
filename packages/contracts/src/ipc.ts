// IPC between the agent's React windows and its Rust core. These Zod schemas are the
// source of truth: `pnpm --filter @ai-proctor/contracts gen` writes them to
// generated/ipc.schema.json, which the Rust core turns into serde types at compile time.
import { z } from "zod";

export const PermissionState = z
  .enum(["granted", "denied", "not_determined", "restricted", "unsupported"])
  .meta({ id: "PermissionState" });

export const Permissions = z
  .object({
    screen: PermissionState,
    camera: PermissionState,
  })
  .meta({ id: "Permissions" });

// Shift states from the LLD state machine (section 02).
export const ShiftState = z
  .enum(["off_shift", "working", "on_break", "paused"])
  .meta({ id: "ShiftState" });

// What the tray popover shows. Never includes the next check-in time.
export const AgentStatus = z
  .object({
    shift: ShiftState,
    signed_in: z.boolean(),
    /** The signed-in account, shown in the popover. */
    account_email: z.string().nullable(),
    agent_version: z.string(),
    permissions: Permissions,
  })
  .meta({ id: "AgentStatus" });

/** Result of a command that only succeeds or fails with a message for the user. */
export const CommandResult = z
  .object({ ok: z.boolean(), error: z.string().nullable() })
  .meta({ id: "CommandResult" });

/** Commands the UI can `invoke`, with their argument and result schemas. */
export const ipcCommands = {
  get_status: { args: z.object({}), result: AgentStatus },
  /** Emails a magic link (AGT-02); sign-in completes when the link opens the agent. */
  sign_in_start: { args: z.object({ email: z.string() }), result: CommandResult },
  sign_out: { args: z.object({}), result: CommandResult },
} as const;

/** Events the core `emit`s to the UI, with their payload schemas. */
export const ipcEvents = {
  status_changed: AgentStatus,
} as const;

export type PermissionState = z.infer<typeof PermissionState>;
export type Permissions = z.infer<typeof Permissions>;
export type ShiftState = z.infer<typeof ShiftState>;
export type AgentStatus = z.infer<typeof AgentStatus>;
export type CommandResult = z.infer<typeof CommandResult>;
export type IpcCommand = keyof typeof ipcCommands;
export type IpcEvent = keyof typeof ipcEvents;
export type IpcArgs<C extends IpcCommand> = z.infer<(typeof ipcCommands)[C]["args"]>;
export type IpcResult<C extends IpcCommand> = z.infer<(typeof ipcCommands)[C]["result"]>;
export type IpcPayload<E extends IpcEvent> = z.infer<(typeof ipcEvents)[E]>;
