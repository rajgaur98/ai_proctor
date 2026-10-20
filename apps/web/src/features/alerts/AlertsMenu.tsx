// ALR-01 in-app alerts: a bell in the top bar for managers and admins, with the
// unread count and a list that links to the employee's day. Alerts are marked read
// one by one or all at once.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Time } from "../../lib/time";
import { type Alert, alertsQuery, markAlertsRead } from "./alertData";
import { alertText, dayLabel } from "./alertText";

function Bell() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11Z" />
      <path d="M6.5 14a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

export function AlertsMenu({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { data: alerts = [], isError } = useQuery(alertsQuery(userId));
  const unread = alerts.filter((a) => !a.read).length;

  const markRead = useMutation({
    mutationFn: markAlertsRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts", userId] }),
  });

  // Close on Escape or a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={unread > 0 ? `Alerts, ${unread} unread` : "Alerts"}
        aria-expanded={open}
        aria-controls="alerts-panel"
        onClick={() => setOpen(!open)}
        className="relative flex h-8 w-8 items-center justify-center rounded-full border border-line bg-sunk text-ink2"
      >
        <Bell />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-acc px-1 font-mono text-[10px] font-semibold text-accink"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <section
          id="alerts-panel"
          aria-label="Alerts"
          className="absolute right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-[13.5px] font-semibold">Alerts</h2>
            <button
              type="button"
              disabled={unread === 0 || markRead.isPending}
              onClick={() => markRead.mutate(undefined)}
              className="rounded-md px-2 py-1 text-[12.5px] font-medium text-acctext disabled:text-ink3"
            >
              Mark all read
            </button>
          </div>
          {isError ? (
            <p className="px-4 py-6 text-sm text-ink2">Couldn't load alerts.</p>
          ) : alerts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink2">No alerts.</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {alerts.map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  busy={markRead.isPending}
                  onOpen={() => setOpen(false)}
                  onMarkRead={() => markRead.mutate([a.id])}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function AlertRow({
  alert: a,
  busy,
  onOpen,
  onMarkRead,
}: {
  alert: Alert;
  busy: boolean;
  onOpen: () => void;
  onMarkRead: () => void;
}) {
  const text = alertText(a.kind, a.details);
  return (
    <li className="flex items-start gap-2 border-b border-line px-4 py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 flex-none rounded-full ${a.read ? "bg-transparent" : "bg-acc"}`}
      />
      <div className="min-w-0 flex-1">
        <Link
          to="/team/$userId"
          params={{ userId: a.userId }}
          onClick={onOpen}
          className={`block text-[13.5px] ${a.read ? "text-ink2" : "font-semibold text-ink"}`}
        >
          {a.employeeName}
          <span className="block font-normal text-ink2">{text}</span>
        </Link>
        <span className="mt-0.5 block text-[12px] text-ink3">
          {dayLabel(a.triggeredAt)} <Time iso={a.triggeredAt} employeeZone={a.employeeZone} />
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
