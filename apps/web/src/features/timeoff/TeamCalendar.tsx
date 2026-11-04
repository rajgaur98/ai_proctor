// Who's off this week and next (#304, LV-06), for managers, owners and admins: approved
// time off of the people they can see, and the holidays (with the place each is for).
import { useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useId, useMemo } from "react";
import { type DayOff, offByDay, twoWeeks } from "./calendar";
import { holidayPlace } from "./leaveText";
import { holidaysQuery, leaveRequestsQuery } from "./timeOffData";

export function TeamCalendar({ zone }: { zone: string }) {
  const headingId = useId();
  const today = DateTime.now().setZone(zone).toISODate() ?? "";
  const days = useMemo(() => twoWeeks(today), [today]);
  const requests = useQuery(leaveRequestsQuery(days[0], days[13]));
  const holidays = useQuery(holidaysQuery);
  const weeks = useMemo(() => {
    const all = offByDay(days, requests.data ?? [], holidays.data ?? []);
    return [all.slice(0, 7), all.slice(7)];
  }, [days, requests.data, holidays.data]);
  const error = requests.error ?? holidays.error;

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-xl border border-line bg-panel"
    >
      <div className="px-5 pt-4 pb-3">
        <h2 id={headingId} className="text-base font-semibold">
          Who's off
        </h2>
        <p className="mt-0.5 text-[12.5px] text-ink3">
          Approved time off this week and next, and the holidays. Days are each person's own.
        </p>
      </div>
      {error ? (
        <p role="alert" className="px-5 pb-5 text-sm text-warnink">
          Couldn't load the calendar: {error.message}
        </p>
      ) : (
        <div className="grid gap-0 border-t border-line md:grid-cols-2">
          {weeks.map((week, i) => (
            <Week
              key={week[0]?.day ?? i}
              title={i === 0 ? "This week" : "Next week"}
              days={week}
              today={today}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Week({ title, days, today }: { title: string; days: DayOff[]; today: string }) {
  return (
    <table className="w-full border-collapse text-[13.5px] md:[&:first-child]:border-r md:border-line">
      <caption className="px-5 pt-3 pb-1 text-left text-xs font-medium text-ink3">{title}</caption>
      <tbody>
        {days.map((d) => (
          <tr key={d.day} className="border-b border-line last:border-0 align-top">
            <th
              scope="row"
              className={`w-[110px] px-5 py-2 text-left font-medium ${d.day === today ? "" : "text-ink2"}`}
            >
              {DateTime.fromISO(d.day).toFormat("ccc d LLL")}
            </th>
            <td className="py-2 pr-5">
              {d.people.length === 0 && d.holidays.length === 0 ? (
                <span className="text-ink3">—</span>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {d.holidays.map((h) => (
                    <li key={h.id}>
                      {h.name}{" "}
                      <span className="text-ink3">
                        · holiday, {holidayPlace(h.country, h.state)}
                      </span>
                    </li>
                  ))}
                  {d.people.map((p) => (
                    <li key={`${p.name}-${p.typeName}`}>
                      {p.name}{" "}
                      <span className="text-ink3">
                        · {p.typeName}
                        {p.partDay ? ", part of the day" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
