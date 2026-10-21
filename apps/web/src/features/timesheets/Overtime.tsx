// Overtime highlighting (#65, TS-19): worked time above the org's daily or weekly
// threshold is drawn in the warning style and says so to screen readers. Nothing is
// paid, deducted or recalculated; the number is the same raw seconds as elsewhere.
import { isOver, type OvertimeThresholds, thresholdLabel } from "@ai-proctor/core";
import { formatDuration } from "./summary";

/** A worked duration, highlighted when it is above `thresholdHours` (null: never). */
export function WorkedTime({
  seconds,
  thresholdHours,
  period,
  empty,
}: {
  seconds: number;
  thresholdHours: number | null;
  period: "daily" | "weekly";
  /** What to show for no time at all (the day table shows a dash). */
  empty?: string;
}) {
  const text = seconds === 0 && empty !== undefined ? empty : formatDuration(seconds);
  if (thresholdHours === null || !isOver(seconds, thresholdHours)) return <>{text}</>;
  return (
    <span className="inline-flex h-6 items-center rounded-full border border-warnline bg-warnbg px-2.5 text-warnink">
      {text}
      <span className="sr-only">
        , over the {thresholdLabel(thresholdHours)} {period} overtime threshold
      </span>
    </span>
  );
}

/** One line naming the thresholds the page highlights, or nothing when they are off. */
export function OvertimeNote({
  overtime,
  weeklyOnly = false,
}: {
  overtime: OvertimeThresholds | undefined;
  /** A page that shows only weekly totals. */
  weeklyOnly?: boolean;
}) {
  const parts = [
    overtime?.dailyHours && !weeklyOnly ? `${thresholdLabel(overtime.dailyHours)} a day` : null,
    overtime?.weeklyHours ? `${thresholdLabel(overtime.weeklyHours)} a week` : null,
  ].filter((p) => p !== null);
  if (parts.length === 0) return null;
  return (
    <p className="text-[12.5px] text-ink3">
      Highlighted: worked time above the overtime threshold ({parts.join(", ")}). Nothing is paid or
      deducted.
    </p>
  );
}
