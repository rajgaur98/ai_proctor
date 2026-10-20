// In-app notifications (TS-13, TS-18) for everyone: an inbox button in the top bar with
// the unread count and a list that links to the week, or the Timesheets tab. A notification
// is marked read when opened, or all at once. Separate from the alerts bell (ALR-01), which
// is about employees' presence and only managers and admins have.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Time } from "../../lib/time";
import { dayLabel } from "../alerts/alertText";
import {
  type AppNotification,
  markNotificationsRead,
  notificationsQuery,
} from "./notificationData";
import { notificationNote, notificationTarget, notificationText } from "./notificationText";

// The tabs are made by page() in the router, which doesn't give them a literal path type
// (the top bar links them from a string the same way).
const TIMESHEETS_TAB: string = "/timesheets";

function Inbox() {
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
      <path d="M2.5 9.5 4.5 3h7l2 6.5V13h-11V9.5Z" />
      <path d="M2.5 9.5H6a2 2 0 0 0 4 0h3.5" />
    </svg>
  );
}

export function NotificationsMenu({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { data: items = [], isError } = useQuery(notificationsQuery(userId));
  const unread = items.filter((n) => !n.read).length;

  const markRead = useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications", userId] }),
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
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-controls="notifications-panel"
        onClick={() => setOpen(!open)}
        className="relative flex h-8 w-8 items-center justify-center rounded-full border border-line bg-sunk text-ink2"
      >
        <Inbox />
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
          id="notifications-panel"
          aria-label="Notifications"
          className="absolute right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-[13.5px] font-semibold">Notifications</h2>
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
            <p className="px-4 py-6 text-sm text-ink2">Couldn't load notifications.</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink2">No notifications.</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {items.map((n) => (
                <NotificationRow
                  key={n.id}
                  item={n}
                  viewerId={userId}
                  onOpen={() => {
                    setOpen(false);
                    if (!n.read) markRead.mutate([n.id]);
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function NotificationRow({
  item: n,
  viewerId,
  onOpen,
}: {
  item: AppNotification;
  viewerId: string;
  onOpen: () => void;
}) {
  const text = notificationText(n.kind, n.payload);
  const note = notificationNote(n.kind, n.payload);
  const target = notificationTarget(n.kind, n.payload, viewerId);
  const className = `block w-full text-left text-[13.5px] ${n.read ? "text-ink2" : "font-semibold text-ink"}`;
  const body = (
    <>
      {text}
      {note !== null && <span className="block font-normal text-ink2">{note}</span>}
    </>
  );
  return (
    <li className="flex items-start gap-2 border-b border-line px-4 py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 flex-none rounded-full ${n.read ? "bg-transparent" : "bg-acc"}`}
      />
      <div className="min-w-0 flex-1">
        {target === null ? (
          // Nothing to open: the row itself marks it read.
          <button type="button" onClick={onOpen} className={className}>
            {body}
          </button>
        ) : target.page === "week" ? (
          <Link
            to="/timesheets/$userId"
            params={{ userId: target.userId }}
            search={{ week: target.week }}
            onClick={onOpen}
            className={className}
          >
            {body}
          </Link>
        ) : (
          <Link to={TIMESHEETS_TAB} onClick={onOpen} className={className}>
            {body}
          </Link>
        )}
        <span className="mt-0.5 block text-[12px] text-ink3">
          {dayLabel(n.createdAt)} <Time iso={n.createdAt} />
        </span>
      </div>
    </li>
  );
}
