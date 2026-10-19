// Status = colour + shape + label, never colour alone (NFR-UX-01). From the
// Claude Design style sheet.
import type { Enums } from "@ai-proctor/contracts";
import type { CSSProperties } from "react";

export type PresenceStatus = Enums<"presence_status">;
type Shape = "dot" | "ring" | "dash" | "square" | "diamond";

export const statusStyle: Record<PresenceStatus, { label: string; shape: Shape; color: string }> = {
  active: { label: "Active", shape: "dot", color: "var(--sactive)" },
  idle: { label: "Idle", shape: "dot", color: "var(--sidle)" },
  away: { label: "Away", shape: "dot", color: "var(--saway)" },
  away_locked: { label: "Away · locked", shape: "dot", color: "var(--slocked)" },
  on_break: { label: "On break", shape: "dot", color: "var(--sbreak)" },
  paused: { label: "Paused", shape: "square", color: "var(--spaused)" },
  in_meeting: { label: "In meeting", shape: "dot", color: "var(--smeeting)" },
  offline: { label: "Offline", shape: "ring", color: "var(--soffline)" },
  tamper: { label: "Capture blocked", shape: "diamond", color: "var(--stamper)" },
  off_shift: { label: "Off shift", shape: "dash", color: "var(--soff)" },
};

function markStyle(shape: Shape, color: string): CSSProperties {
  const base: CSSProperties = { width: 8, height: 8, flex: "none", boxSizing: "border-box" };
  switch (shape) {
    case "dot":
      return { ...base, borderRadius: "50%", background: color };
    case "square":
      return { ...base, borderRadius: 2, background: color };
    case "diamond":
      return {
        ...base,
        borderRadius: 1,
        background: color,
        transform: "rotate(45deg) scale(0.85)",
      };
    case "ring":
      return { ...base, borderRadius: "50%", border: `2px solid ${color}` };
    case "dash":
      return { ...base, borderRadius: "50%", border: `1.5px dashed ${color}` };
  }
}

export function StatusChip({ status }: { status: PresenceStatus }) {
  const { label, shape, color } = statusStyle[status];
  return (
    <span className="inline-flex h-7 items-center gap-[7px] rounded-full border border-line bg-panel pr-[11px] pl-[10px] text-[12.5px] font-medium">
      <span aria-hidden="true" style={markStyle(shape, color)} />
      {label}
    </span>
  );
}
