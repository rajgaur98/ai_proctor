// Insights (#305, INS-01): one call to `insights` per filter change. The access check and
// every number are the database's (can_view_user per person, report_rows' rules); this
// only fetches and reads the reply.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { type Insights, parseInsights } from "./model";

const messages: Record<string, string> = {
  invalid_range: "Choose a start date and an end date that is the same or later, up to a year.",
  forbidden: "You can't see that person's numbers.",
  too_many_people: "That is more people than one view can hold. Choose a team to narrow it down.",
};

/** `userIds` empty: everyone the filters allow. */
export const insightsQuery = (from: string, to: string, teamId: string, userIds: string[]) =>
  queryOptions({
    queryKey: ["insights", from, to, teamId, userIds.join(",")],
    // Its errors (a bad range, someone you can't see, too many people) don't go away on a
    // retry, so show them at once.
    retry: false,
    queryFn: async (): Promise<Insights> => {
      const { data, error } = await supabase.rpc("insights", {
        p_from: from,
        p_to: to,
        ...(teamId ? { p_team_id: teamId } : {}),
        ...(userIds.length ? { p_user_ids: userIds } : {}),
      });
      if (error) throw new Error(messages[error.message] ?? error.message);
      return parseInsights(data);
    },
  });
