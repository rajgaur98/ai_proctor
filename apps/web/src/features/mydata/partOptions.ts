// What an employee can remove from one of their own check-ins (#253, EMP-06), and the
// words the dialog uses. Pure, so it is unit tested; the dialog is DeleteParts.tsx.
import type { Part, RemovedParts } from "../day/removedText";
import { PART_ORDER } from "../day/removedText";
import { filesOf } from "./helpers";

export interface PartOption {
  part: Part;
  label: string;
  /** What exactly goes, for the confirmation list. */
  detail: string;
}

/**
 * The parts still there to remove from a passed check-in. Images past retention are
 * already deleted, so they aren't offered. Domains go with the apps, so they aren't
 * offered on their own once the apps are gone. `minute` is when it was answered (HH:mm).
 */
export function partOptions(
  c: { outcome: string; objectKeys: string[]; removed: RemovedParts },
  imagesExpired: boolean,
  minute: string,
): PartOption[] {
  if (c.outcome !== "pass") return [];
  const files = filesOf(c.objectKeys);
  const options: PartOption[] = [];
  if (files.webcam && !imagesExpired && c.removed.webcam === null) {
    options.push({
      part: "webcam",
      label: "Webcam frame",
      detail: "the webcam frame",
    });
  }
  if (files.screens > 0 && !imagesExpired && c.removed.screen === null) {
    options.push({
      part: "screen",
      label: files.screens > 1 ? `Screen captures (${files.screens} displays)` : "Screen capture",
      detail: files.screens > 1 ? `the ${files.screens} screen captures` : "the screen capture",
    });
  }
  if (c.removed.apps === null) {
    options.push({
      part: "apps",
      label: "Apps",
      detail: `the apps recorded in the minute you answered (${minute}), with their window titles and sites`,
    });
    if (c.removed.domains === null) {
      options.push({
        part: "domains",
        label: "Browser domains",
        detail: `the sites and page titles recorded in that minute (${minute}); the app names stay`,
      });
    }
  }
  return options;
}

/** The picked parts in a fixed order, as the function takes them. */
export function pickedParts(picked: ReadonlySet<Part>): Part[] {
  return PART_ORDER.filter((p) => picked.has(p));
}
