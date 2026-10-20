// What an anti-cheat flag says on the day page (ANT-08). Flags are "needs review"
// signals for the manager, never verdicts: the wording stays neutral and nothing
// here touches status, hours or timesheets. Details come from anticheat_eval and
// the injected-click trigger.
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
  }
}
