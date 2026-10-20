// Pure date-range rules for delegations, kept apart from the data layer so tests
// don't need a Supabase client.
import { DateTime } from "luxon";

export const maxDelegationDays = 90;

/** What's wrong with a range (ISO dates, `today` in the viewer's zone), or null. */
export function rangeProblem(startsOn: string, endsOn: string, today: string): string | null {
  const start = DateTime.fromISO(startsOn);
  const end = DateTime.fromISO(endsOn);
  if (!start.isValid || !end.isValid) return "Choose a first and a last day.";
  if (startsOn < today) return "The first day can't be in the past.";
  if (end < start) return "The last day can't be before the first.";
  if (end.diff(start, "days").days > maxDelegationDays) {
    return `A delegation covers at most ${maxDelegationDays} days.`;
  }
  return null;
}

/** "3 Nov – 10 Nov 2026"; a single day is just "3 Nov 2026". */
export function rangeLabel(startsOn: string, endsOn: string): string {
  const start = DateTime.fromISO(startsOn);
  const end = DateTime.fromISO(endsOn);
  if (startsOn === endsOn) return end.toFormat("d LLL yyyy");
  return `${start.toFormat(start.year === end.year ? "d LLL" : "d LLL yyyy")} – ${end.toFormat("d LLL yyyy")}`;
}

/** What the history line says about where a delegation stands. */
export function statusLabel(d: {
  status: "upcoming" | "active" | "completed" | "ended";
  endReason: "manual" | "deactivated" | "demoted" | null;
}): string {
  switch (d.status) {
    case "upcoming":
      return "Upcoming";
    case "active":
      return "Active";
    case "completed":
      return "Completed";
    case "ended":
      return d.endReason === "deactivated"
        ? "Ended early (deactivated)"
        : d.endReason === "demoted"
          ? "Ended early (made an employee)"
          : "Ended early";
  }
}
