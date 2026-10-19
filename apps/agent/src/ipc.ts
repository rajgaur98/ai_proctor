// Typed IPC to the Rust core. Names and payload shapes come from
// @ai-proctor/contracts; every reply is validated, so a contract drift fails loudly.
import {
  type IpcArgs,
  type IpcCommand,
  type IpcEvent,
  type IpcPayload,
  type IpcResult,
  ipcCommands,
  ipcEvents,
} from "@ai-proctor/contracts";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

type RawInvoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
type RawListen = (event: string, handler: (e: { payload: unknown }) => void) => Promise<UnlistenFn>;

export async function invoke<C extends IpcCommand>(
  command: C,
  args: IpcArgs<C>,
  raw: RawInvoke = tauriInvoke,
): Promise<IpcResult<C>> {
  const reply = await raw(command, args);
  return ipcCommands[command].result.parse(reply) as IpcResult<C>;
}

export function listen<E extends IpcEvent>(
  event: E,
  handler: (payload: IpcPayload<E>) => void,
  raw: RawListen = tauriListen,
): Promise<UnlistenFn> {
  return raw(event, (e) => handler(ipcEvents[event].parse(e.payload) as IpcPayload<E>));
}
