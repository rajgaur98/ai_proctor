// Shift schedule for one person (#29, SHF-01): weekdays and start/end in their
// time zone. A shift ending before it starts crosses midnight.
import type { ShiftRule } from "@ai-proctor/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { supabase } from "../../lib/supabase";
import { explain } from "./members";

const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const shiftsQuery = (userId: string) => ({
  queryKey: ["shifts", userId],
  queryFn: async (): Promise<ShiftRule[]> => {
    const { data, error } = await supabase
      .from("shifts")
      .select("days, start_time, end_time, timezone")
      .eq("user_id", userId)
      .order("start_time");
    if (error) throw error;
    return data.map((s) => ({
      days: s.days,
      start: s.start_time.slice(0, 5),
      end: s.end_time.slice(0, 5),
      timezone: s.timezone,
    }));
  },
});

function length(s: ShiftRule): string {
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const span = (minutes(s.end) - minutes(s.start) + 24 * 60) % (24 * 60) || 24 * 60;
  const h = span / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h${s.end <= s.start ? ", ends next day" : ""}`;
}

export function ShiftEditor({ userId, timezone }: { userId: string; timezone: string }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(shiftsQuery(userId));
  const [shifts, setShifts] = useState<ShiftRule[]>([]);
  useEffect(() => {
    if (data) setShifts(data);
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("set_shifts", {
        p_user_id: userId,
        p_shifts: shifts.map((s) => ({ ...s, timezone })),
      });
      if (error) throw new Error(explain(error.message));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shifts", userId] }),
  });

  const update = (i: number, patch: Partial<ShiftRule>) =>
    setShifts(shifts.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  if (isPending) return <p className="text-sm text-ink2">Loading schedule…</p>;

  return (
    <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
      <legend className="text-[13px] font-medium text-ink2">Shifts ({timezone})</legend>
      {shifts.length === 0 && <p className="text-sm text-ink3">No shifts yet.</p>}
      {shifts.map((s, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
          key={i}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3"
        >
          <fieldset className="flex gap-1">
            <legend className="sr-only">Shift {i + 1} days</legend>
            {dayNames.map((name, d) => {
              const day = d + 1;
              const on = s.days.includes(day);
              return (
                <label
                  key={name}
                  className={`grid h-8 w-10 cursor-pointer place-items-center rounded-md border text-xs ${
                    on ? "border-acc bg-acc text-accink" : "border-line2 text-ink2"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() =>
                      update(i, {
                        days: on ? s.days.filter((x) => x !== day) : [...s.days, day].sort(),
                      })
                    }
                  />
                  {name}
                </label>
              );
            })}
          </fieldset>
          <input
            type="time"
            aria-label={`Shift ${i + 1} start`}
            value={s.start}
            onChange={(e) => update(i, { start: e.target.value })}
            className="h-9 rounded-md border border-line2 bg-panel px-2 text-sm"
          />
          <span aria-hidden>–</span>
          <input
            type="time"
            aria-label={`Shift ${i + 1} end`}
            value={s.end}
            onChange={(e) => update(i, { end: e.target.value })}
            className="h-9 rounded-md border border-line2 bg-panel px-2 text-sm"
          />
          <span className="text-xs text-ink3">{s.start !== s.end ? length(s) : ""}</span>
          <Button
            type="button"
            variant="ghost"
            className="ml-auto h-9"
            aria-label={`Remove shift ${i + 1}`}
            onClick={() => setShifts(shifts.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      {save.error && (
        <p role="alert" className="text-sm text-warnink">
          {save.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-9"
          onClick={() =>
            setShifts([
              ...shifts,
              { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timezone },
            ])
          }
        >
          Add shift
        </Button>
        <Button
          type="button"
          className="ml-auto h-9"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isSuccess && !save.isPending ? "Schedule saved" : "Save schedule"}
        </Button>
      </div>
    </fieldset>
  );
}
