// The alerts page (#135, ALR-01): the recipient's whole alert history with filters
// (kind, person, dates, read or unread), a page at a time, mark read one by one or for
// everything the filters match, and a link to the person's day. The bell shows the
// latest few. New alerts reach both through the bell's useLiveAlerts, which
// invalidates every ["alerts", userId] query.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { Time } from "../../lib/time";
import { membersQuery } from "../people/members";
import { type Alert, alertPageQuery, markAlertsRead, markMatchingAlertsRead } from "./alertData";
import { type AlertFilters, filtersActive, NO_FILTERS, type ReadFilter } from "./alertFilters";
import {
  ALERT_KINDS,
  type AlertKind,
  alertDay,
  alertText,
  dayLabel,
  KIND_LABELS,
} from "./alertText";

const field =
  "h-10 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px] text-ink disabled:opacity-60";

export function AlertsPage() {
  const { profile } = useRouteContext({ from: "/_app" });
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<AlertFilters>(NO_FILTERS);
  const set = <K extends keyof AlertFilters>(key: K, value: AlertFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const people = useQuery(membersQuery);
  const list = useInfiniteQuery(alertPageQuery(profile.id, filters));
  const alerts = list.data?.pages.flatMap((p) => p.rows) ?? [];

  const done = () => queryClient.invalidateQueries({ queryKey: ["alerts", profile.id] });
  const markOne = useMutation({
    mutationFn: (id: string) => markAlertsRead([id]),
    onSuccess: done,
  });
  const markMatching = useMutation({
    mutationFn: () => markMatchingAlertsRead(filters),
    onSuccess: done,
  });

  const ids = {
    kind: useId(),
    person: useId(),
    from: useId(),
    to: useId(),
    read: useId(),
  };
  const active = filtersActive(filters);
  const error = list.error ?? people.error;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Alerts</h1>
          <p className="mt-1 text-[13.5px] text-ink2">{profile.orgName}</p>
        </div>
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={filters.read === "read" || markMatching.isPending}
          onClick={() => markMatching.mutate()}
        >
          {active ? "Mark all matching read" : "Mark all read"}
        </Button>
      </div>

      <form
        aria-label="Filter alerts"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-panel p-4"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.kind}>Kind</Label>
          <select
            id={ids.kind}
            value={filters.kind}
            onChange={(e) => set("kind", e.target.value as AlertKind | "")}
            className={field}
          >
            <option value="">All kinds</option>
            {ALERT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.person}>Employee</Label>
          <select
            id={ids.person}
            value={filters.userId}
            onChange={(e) => set("userId", e.target.value)}
            className={field}
          >
            <option value="">Everyone</option>
            {(people.data ?? [])
              .filter((m) => m.id !== profile.id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName}
                </option>
              ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.from}>From</Label>
          <input
            id={ids.from}
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => set("from", e.target.value)}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.to}>To</Label>
          <input
            id={ids.to}
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => set("to", e.target.value)}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.read}>Status</Label>
          <select
            id={ids.read}
            value={filters.read}
            onChange={(e) => set("read", e.target.value as ReadFilter)}
            className={field}
          >
            <option value="all">Read and unread</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
        </div>
        {active && (
          <Button variant="ghost" className="h-10 px-3" onClick={() => setFilters(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
      </form>

      <section
        aria-label="Alert history"
        className="overflow-hidden rounded-xl border border-line bg-panel"
      >
        {error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load alerts: {error.message}
          </p>
        ) : list.isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : alerts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <span
              aria-hidden
              className="mb-1.5 h-10 w-10 rounded-full border-[1.5px] border-dashed border-line2"
            />
            <p className="text-base font-semibold">
              {active ? "No alerts match" : "No alerts yet"}
            </p>
            <p className="max-w-[380px] text-[13.5px] text-ink2">
              {active
                ? "Try other filters."
                : "You'll be told here when someone you manage misses check-ins, goes offline or trips another alert."}
            </p>
          </div>
        ) : (
          <>
            <ul>
              {alerts.map((a) => (
                <AlertItem
                  key={a.id}
                  alert={a}
                  busy={markOne.isPending}
                  onMarkRead={() => markOne.mutate(a.id)}
                />
              ))}
            </ul>
            {list.hasNextPage && (
              <div className="border-t border-line p-4 text-center">
                <Button
                  variant="secondary"
                  disabled={list.isFetchingNextPage}
                  onClick={() => list.fetchNextPage()}
                >
                  {list.isFetchingNextPage ? "Loading…" : "Load older alerts"}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </section>
  );
}

function AlertItem({
  alert: a,
  busy,
  onMarkRead,
}: {
  alert: Alert;
  busy: boolean;
  onMarkRead: () => void;
}) {
  const text = alertText(a.kind, a.details);
  const date = alertDay(a.triggeredAt, a.employeeZone);
  return (
    <li className="flex items-start gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 flex-none rounded-full ${a.read ? "bg-transparent" : "bg-acc"}`}
      />
      <div className="min-w-0 flex-1">
        <Link
          to="/team/$userId"
          params={{ userId: a.userId }}
          search={date ? { date } : {}}
          className={`block text-[13.5px] ${a.read ? "text-ink2" : "font-semibold text-ink"}`}
        >
          {a.employeeName}
          <span className="block font-normal text-ink2">{text}</span>
        </Link>
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-ink3">
          <span>{KIND_LABELS[a.kind]}</span>
          <span>
            {dayLabel(a.triggeredAt)} <Time iso={a.triggeredAt} employeeZone={a.employeeZone} />
          </span>
        </span>
      </div>
      {!a.read && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Mark read: ${a.employeeName}, ${text}`}
          onClick={onMarkRead}
          className="flex-none rounded-md px-2 py-1 text-[12.5px] font-medium text-acctext"
        >
          Mark read
        </button>
      )}
    </li>
  );
}
