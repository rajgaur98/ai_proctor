// The captures list of My data as a file (#255 part 2, TS-27/28): the employee's own
// check-ins of the day as the Check-ins card lists them, with their captures as metadata
// only (which parts were taken, which they removed, #253, whether retention deleted the
// images) and who viewed them. Never images or links. Pure, so it is unit-tested.
import { type ExportTable, exportTime, yesNo } from "../../lib/exportFile";
import { outcomeWord } from "../day/checkinText";
import { CAPTURE_HEADER, captureCells } from "../day/dayExport";
import { type CaptureView, imagesExpired, viewerLabel } from "./helpers";
import type { MyCheckin } from "./queries";

export const CAPTURES_HEADER = [
  "Time",
  "Outcome",
  ...CAPTURE_HEADER,
  "Images deleted (retention)",
  "App",
  "Project",
  "Viewed by",
  "Views",
  "Last viewed",
];

/**
 * One row per check-in. `app` is the app in front when it was answered (null when not
 * recorded); `views` are every view of the person's captures (each check-in takes its own).
 */
export function capturesTable(
  checkins: readonly MyCheckin[],
  app: (id: string) => string | null,
  projectName: (id: string | null) => string,
  views: readonly CaptureView[],
  retentionDays: number,
  now: number,
  zone: string,
): ExportTable {
  return {
    sheet: "Captures",
    header: CAPTURES_HEADER,
    rows: checkins.map((c) => {
      const mine = views
        .filter((v) => v.checkinId === c.id)
        .sort((a, b) => Date.parse(b.viewedAt) - Date.parse(a.viewedAt));
      const viewers = [...new Set(mine.map(viewerLabel))];
      const hasImages = c.outcome === "pass" && c.objectKeys.length > 0;
      return [
        exportTime(c.shownAt ?? c.scheduledAt, zone),
        outcomeWord[c.outcome],
        ...captureCells(c, zone),
        hasImages ? yesNo(imagesExpired(c.scheduledAt, retentionDays, now)) : "",
        c.removed.apps !== null ? "" : (app(c.id) ?? ""),
        projectName(c.projectId),
        viewers.join("; "),
        mine.length,
        exportTime(mine[0]?.viewedAt ?? null, zone),
      ];
    }),
  };
}
