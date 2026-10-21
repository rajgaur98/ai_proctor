// "Top apps today" (ACT-04, #67) for one person's day: the manager's day page and the
// employee's own My data. Time only, in order, no scores. Empty while the person's
// activity sampling is off (the server returns nothing then).
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { formatDuration } from "../timesheets/summary";
import { topAppRows } from "./appsData";
import { topAppsQuery } from "./dayData";

export function TopApps({
  userId,
  from,
  to,
  isToday,
  live,
  className = "",
}: {
  userId: string;
  /** The day's bounds, ISO instants. */
  from: string;
  to: string;
  isToday: boolean;
  /** Refetch interval in ms, or false. */
  live: number | false;
  className?: string;
}) {
  const titleId = useId();
  const apps = useQuery({ ...topAppsQuery(userId, from, to), refetchInterval: live });
  const rows = topAppRows(apps.data ?? []);

  return (
    <section
      aria-labelledby={titleId}
      className={`overflow-hidden rounded-xl border border-line bg-panel ${className}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-[15px] font-semibold">
          {isToday ? "Top apps today" : "Top apps"}
        </h2>
        <span className="text-[12.5px] text-ink2">Time in front while clocked in.</span>
      </div>
      {apps.error ? (
        <p role="alert" className="px-5 py-4 text-sm text-warnink">
          Couldn't load apps: {apps.error.message}
        </p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink2">
          {apps.isPending ? "Loading…" : "No app activity recorded on this day."}
        </p>
      ) : (
        <ol>
          {rows.map((a) => (
            <li
              key={a.appName}
              className="flex items-center gap-4 border-b border-line px-5 py-2.5 text-[13px] last:border-0"
            >
              <span className="w-40 min-w-0 truncate font-medium">{a.appName}</span>
              <span aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-sunk">
                <span
                  className="block h-full rounded-full bg-acc"
                  style={{ width: `${a.width}%` }}
                />
              </span>
              <span className="w-24 text-right font-mono text-[12.5px]">
                {formatDuration(a.seconds)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
