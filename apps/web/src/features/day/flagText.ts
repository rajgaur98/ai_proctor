// What an anti-cheat flag says on the day page (ANT-08). Flags are "needs review"
// signals for the manager, never verdicts: the wording stays neutral and nothing
// here touches status, hours or timesheets. Details come from anticheat_eval and
// the check-in trigger (injected clicks #26; synthetic clicks, virtual cameras,
// duplicate frames, virtual machines and remote sessions #63).
import type { Enums, Json } from "@ai-proctor/contracts";

export type FlagKind = Enums<"anticheat_kind">;

function num(details: Json, key: string): number | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const v = details[key];
  return typeof v === "number" ? v : null;
}

/** The check-ins a flag points at (empty for a flag about the whole day). */
export function flagCheckinIds(details: Json): string[] {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  const ids = details.checkin_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function strings(details: Json, key: string): string[] {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  const v = details[key];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/** "at 2 check-ins", or nothing when the count is unknown. */
function atCheckins(count: number | null): string {
  return count === null ? "" : ` at ${plural(count, "check-in", "check-ins")}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A short title and one sentence of detail for a flag. */
export function flagText(kind: FlagKind, details: Json): { title: string; detail: string } {
  switch (kind) {
    case "injected_click": {
      const clicks = num(details, "clicks");
      return {
        title: "Check-in clicks from another program",
        detail: `${clicks === null ? "Some clicks" : plural(clicks, "click", "clicks")} on the card didn't come from a mouse or trackpad and ${clicks === 1 ? "was" : "were"} blocked.`,
      };
    }
    case "fast_response": {
      const count = num(details, "count");
      const min = num(details, "min_response_ms");
      return {
        title: "Very fast check-in responses",
        detail: `${count === null ? "Some check-ins were" : `${plural(count, "check-in was", "check-ins were")}`} answered in under 0.3 s${min === null ? "" : ` (fastest ${min} ms)`}.`,
      };
    }
    case "low_variance": {
      const passes = num(details, "passes");
      const mean = num(details, "mean_ms");
      const cv = num(details, "cv");
      const stats =
        mean === null || cv === null
          ? ""
          : `: average ${(mean / 1000).toFixed(1)} s, spread ${(cv * 100).toFixed(1)}%`;
      return {
        title: "Very even response times",
        detail: `${passes === null ? "Check-ins" : `${passes} check-ins`} were answered in almost the same time${stats}.`,
      };
    }
    case "synthetic_click": {
      const clicks = num(details, "clicks");
      return {
        title: "Check-in clicks that looked automated",
        detail: `${clicks === null ? "Some clicks" : plural(clicks, "click", "clicks")} on the card looked like ${clicks === 1 ? "it" : "they"} came from another program rather than a mouse or trackpad. The check-in counted as usual.`,
      };
    }
    case "virtual_camera": {
      const cameras = strings(details, "cameras");
      return {
        title: "Webcam was a virtual camera",
        detail: `The webcam image came from ${cameras.length > 0 ? cameras.join(", ") : "a virtual camera"}${atCheckins(num(details, "count"))}. A virtual camera can show any video, not just the room.`,
      };
    }
    case "duplicate_frame": {
      const count = num(details, "count");
      return {
        title: "Webcam images look the same",
        detail: `${count === null ? "Some webcam images were" : plural(count, "webcam image was", "webcam images were")} almost identical to an earlier check-in's. Compare the images.`,
      };
    }
    case "virtual_machine":
      return {
        title: "Running in a virtual machine",
        detail: `The app was running inside a virtual machine${atCheckins(num(details, "count"))}.`,
      };
    case "remote_session":
      return {
        title: "Remote session",
        detail: `The computer was being used or controlled remotely (such as Remote Desktop or Screen Sharing)${atCheckins(num(details, "count"))}.`,
      };
  }
}
