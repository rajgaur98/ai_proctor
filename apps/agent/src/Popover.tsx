// Tray popover skeleton (#15). The full popover (clock, break, pause, project) is #37.
import type { AgentStatus, PermissionState, ShiftState } from "@ai-proctor/contracts";
import { useEffect, useState } from "react";
import { invoke, listen } from "./ipc";

const shiftLabel: Record<ShiftState, string> = {
  off_shift: "Off shift",
  working: "Working",
  on_break: "On break",
  paused: "Paused",
};

const permissionLabel: Record<PermissionState, string> = {
  granted: "Allowed",
  denied: "Blocked",
  not_determined: "Not set up",
  restricted: "Restricted",
  unsupported: "Not available yet",
};

export function Popover() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke("get_status", {}).then(setStatus, (e: unknown) => setError(String(e)));
    const unlisten = listen("status_changed", setStatus);
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  if (error) return <main className="popover">Couldn't load status: {error}</main>;
  if (!status) return <main className="popover">Loading…</main>;

  return (
    <main className="popover">
      <header>
        <span className="title">AI Proctor</span>
        <span className="status">{shiftLabel[status.shift]}</span>
      </header>
      <section>
        <h2>Permissions</h2>
        <dl>
          <dt>Screen recording</dt>
          <dd>{permissionLabel[status.permissions.screen]}</dd>
          <dt>Camera</dt>
          <dd>{permissionLabel[status.permissions.camera]}</dd>
        </dl>
      </section>
      <footer>
        {status.signed_in ? "Signed in" : "Not signed in"} · v{status.agent_version}
      </footer>
    </main>
  );
}
