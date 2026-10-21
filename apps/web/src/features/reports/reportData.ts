// Reports (#47, DSH-07): reads `report_rows`. The access check and every number are the
// database's (it honours can_view_user per person); this only fetches and maps.
import { type DbReport, fromDbReportRow, type ReportRow } from "@ai-proctor/core";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export interface Report {
  rows: ReportRow[];
  /** Median over all the people's passed check-ins together, in ms. */
  teamMedianResponseMs: number | null;
  /** Minutes after shift start a clock-in may be before it counts as late. */
  lateGraceMin: number;
}

const messages: Record<string, string> = {
  invalid_range: "Choose a start date and an end date that is the same or later, up to a year.",
  forbidden: "You can't see that team's numbers.",
  too_many_people: "That is more people than one report can hold. Choose a team to narrow it down.",
};

export const reportQuery = (from: string, to: string, teamId: string) =>
  queryOptions({
    queryKey: ["report", from, to, teamId],
    // Its errors (a bad range, a team you can't see, too many people) don't go away on a
    // retry, so show them at once.
    retry: false,
    queryFn: async (): Promise<Report> => {
      const { data, error } = await supabase.rpc("report_rows", {
        p_from: from,
        p_to: to,
        ...(teamId ? { p_team_id: teamId } : {}),
      });
      if (error) throw new Error(messages[error.message] ?? error.message);
      const report = data as unknown as DbReport;
      return {
        rows: report.rows.map(fromDbReportRow),
        teamMedianResponseMs:
          report.team_median_response_ms === null ? null : Number(report.team_median_response_ms),
        lateGraceMin: Number(report.late_grace_min),
      };
    },
  });
