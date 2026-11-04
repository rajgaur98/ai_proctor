// Owners and admins keep the leave types (LV-01: paid or unpaid, archived instead of
// deleted) and the holiday calendar (LV-02: a date and name, for everyone or one work
// location). Shown as tabs of the Time off page. Every change is audit-logged by the
// database, which also tells the affected people's agents (no auto clock-in on a holiday).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { usStates } from "../people/MemberFields";
import { holidayPlace } from "./leaveText";
import {
  deleteHoliday,
  type Holiday,
  holidaysQuery,
  type LeaveType,
  leaveTypesQuery,
  saveHoliday,
  saveLeaveType,
} from "./timeOffData";

const fieldClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";
const dialogClass =
  "m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";

function Panel({
  title,
  note,
  action,
  children,
}: {
  title: string;
  note: string;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="overflow-hidden rounded-xl border border-line bg-panel"
    >
      <div className="flex flex-wrap items-start gap-3 px-5 pt-4 pb-3">
        <div>
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-ink3">{note}</p>
        </div>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

// Leave types ---------------------------------------------------------------------------------

export function LeaveTypesPanel() {
  const types = useQuery(leaveTypesQuery);
  const [editing, setEditing] = useState<LeaveType | "new" | null>(null);
  const rows = [...(types.data ?? [])].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name),
  );
  return (
    <Panel
      title="Leave types"
      note="What people can ask for, paid or unpaid. A request keeps the paid setting it was made with. Types are archived, never deleted."
      action={<Button onClick={() => setEditing("new")}>New leave type</Button>}
    >
      {types.error ? (
        <p role="alert" className="px-5 pb-5 text-sm text-warnink">
          Couldn't load leave types: {types.error.message}
        </p>
      ) : (
        <table className="w-full border-collapse text-[13.5px]">
          <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
            <tr className="h-10 border-y border-line">
              <th className="px-5 font-medium">Name</th>
              <th className="font-medium">Paid</th>
              <th className="font-medium">Status</th>
              <th className="pr-5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.id}
                className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
              >
                <td className="font-medium md:px-5">{t.name}</td>
                <td>{t.paid ? "Paid" : "Unpaid"}</td>
                <td className={t.archived ? "text-ink3" : ""}>
                  {t.archived ? "Archived" : "Active"}
                </td>
                <td className="md:pr-5 md:text-right">
                  <Button
                    variant="secondary"
                    className="h-9"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => setEditing(t)}
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <LeaveTypeDialog
          type={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}

function LeaveTypeDialog({ type, onClose }: { type: LeaveType | null; onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(type?.name ?? "");
  const [paid, setPaid] = useState(type?.paid ?? true);
  const [archived, setArchived] = useState(type?.archived ?? false);
  const save = useMutation({
    mutationFn: () => saveLeaveType({ id: type?.id ?? null, name, paid, archived }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leaveTypesQuery.queryKey });
      onClose();
    },
  });
  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      className={dialogClass}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {type ? `Edit ${type.name}` : "New leave type"}
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={paid}
            onChange={(e) => setPaid(e.target.checked)}
            className="h-4 w-4"
          />
          Paid
        </label>
        {type && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
              className="h-4 w-4"
            />
            Archived (nobody can ask for it; past requests keep it)
          </label>
        )}
        {save.error && (
          <p role="alert" className="text-sm text-warnink">
            {save.error.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

// Holidays ------------------------------------------------------------------------------------

export function HolidaysPanel() {
  const holidays = useQuery(holidaysQuery);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Holiday | "new" | null>(null);
  const remove = useMutation({
    mutationFn: deleteHoliday,
    onSettled: () => queryClient.invalidateQueries({ queryKey: holidaysQuery.queryKey }),
  });
  const rows = holidays.data ?? [];
  return (
    <Panel
      title="Holidays"
      note="Days off for everyone, or for one work location. Nobody is late or auto clocked in on a holiday, and they show as On leave."
      action={<Button onClick={() => setEditing("new")}>Add holiday</Button>}
    >
      {holidays.error ? (
        <p role="alert" className="px-5 pb-5 text-sm text-warnink">
          Couldn't load holidays: {holidays.error.message}
        </p>
      ) : rows.length === 0 ? (
        <p className="border-t border-line px-5 py-6 text-sm text-ink2">
          No holidays yet. The calendar starts empty.
        </p>
      ) : (
        <table className="w-full border-collapse text-[13.5px]">
          <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
            <tr className="h-10 border-y border-line">
              <th className="px-5 font-medium">Date</th>
              <th className="font-medium">Name</th>
              <th className="font-medium">For</th>
              <th className="pr-5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr
                key={h.id}
                className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
              >
                <td className="md:px-5 tabular-nums">
                  {DateTime.fromISO(h.day).toFormat("ccc d LLL yyyy")}
                </td>
                <td className="font-medium">{h.name}</td>
                <td className="text-ink2">{holidayPlace(h.country, h.state)}</td>
                <td className="flex gap-2 md:table-cell md:pr-5 md:text-right">
                  <Button
                    variant="secondary"
                    className="h-9 md:mr-2"
                    aria-label={`Edit ${h.name}`}
                    onClick={() => setEditing(h)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-9"
                    disabled={remove.isPending}
                    aria-label={`Remove ${h.name}`}
                    onClick={() => remove.mutate(h.id)}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {remove.error && (
        <p role="alert" className="px-5 py-3 text-sm text-warnink">
          {remove.error.message}
        </p>
      )}
      {editing && (
        <HolidayDialog
          holiday={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}

function HolidayDialog({ holiday, onClose }: { holiday: Holiday | null; onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [day, setDay] = useState(holiday?.day ?? "");
  const [name, setName] = useState(holiday?.name ?? "");
  const [country, setCountry] = useState(holiday?.country ?? "");
  const [state, setState] = useState(holiday?.state ?? "");
  const save = useMutation({
    mutationFn: () =>
      saveHoliday({
        id: holiday?.id ?? null,
        day,
        name,
        country: country || null,
        state: country === "US" && state ? state : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: holidaysQuery.queryKey });
      onClose();
    },
  });
  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      className={dialogClass}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {holiday ? `Edit ${holiday.name}` : "Add holiday"}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-day`}>Date</Label>
            <Input
              id={`${id}-day`}
              type="date"
              required
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-country`}>Country (empty: everyone)</Label>
            <Input
              id={`${id}-country`}
              maxLength={2}
              pattern="[A-Za-z]{2}"
              title="Two-letter country code, e.g. US, IN, DE"
              value={country}
              onChange={(e) => {
                const next = e.target.value.toUpperCase();
                setCountry(next);
                if (next !== "US") setState("");
              }}
            />
          </div>
          {country === "US" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-state`}>State</Label>
              <select
                id={`${id}-state`}
                className={fieldClass}
                value={state}
                onChange={(e) => setState(e.target.value)}
              >
                <option value="">All states</option>
                {usStates.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <p className="text-xs text-ink3">
          A holiday is each person's whole day in their own time zone, for the people whose work
          location matches.
        </p>
        {save.error && (
          <p role="alert" className="text-sm text-warnink">
            {save.error.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save holiday"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
