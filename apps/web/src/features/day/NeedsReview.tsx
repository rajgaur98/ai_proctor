// "Needs review" (ANT-08): anti-cheat flags on an employee's day (#26). They are
// signals for the manager to look at, never penalties: nothing here changes status,
// hours or timesheets. Marking one reviewed is audit-logged on the server.
import type { Enums, Json } from "@ai-proctor/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { supabase } from "../../lib/supabase";
import { viewerZone } from "../../lib/time";
import { flagText } from "./flagText";

export interface DayFlag {
  id: string;
  kind: Enums<"anticheat_kind">;
  details: Json;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

/** The flags on one local day of an employee's. */
export const dayFlagsQuery = (userId: string, date: string) =>
  queryOptions({
    queryKey: ["anticheat", userId, date],
    queryFn: async (): Promise<DayFlag[]> => {
      const { data, error } = await supabase
        .from("anticheat_flags")
        .select(
          "id, kind, details, reviewed_at, review_note, reviewer:users!anticheat_flags_reviewed_by_fkey(full_name)",
        )
        .eq("user_id", userId)
        .eq("day", date)
        .order("created_at");
      if (error) throw error;
      return data.map((f) => ({
        id: f.id,
        kind: f.kind,
        details: f.details,
        reviewedAt: f.reviewed_at,
        reviewedBy: f.reviewer?.full_name ?? null,
        reviewNote: f.review_note,
      }));
    },
  });

export function NeedsReviewBadge() {
  return (
    <span className="inline-flex h-6 items-center rounded-full border border-warnline bg-warnbg px-2.5 text-[12px] font-medium text-warnink">
      Needs review
    </span>
  );
}

export function NeedsReviewPanel({
  flags,
  userId,
  date,
  canReview,
}: {
  flags: DayFlag[];
  userId: string;
  date: string;
  canReview: boolean;
}) {
  return (
    <section
      aria-labelledby="needs-review-title"
      className="rounded-xl border border-warnline bg-warnbg p-5 text-warnink"
    >
      <h2 id="needs-review-title" className="text-sm font-semibold">
        Needs review
      </h2>
      <p className="mt-1 text-[13px]">
        Things worth a look. They don't change status, hours or the timesheet.
      </p>
      <ul className="mt-3 flex flex-col gap-3">
        {flags.map((f) => (
          <FlagRow key={f.id} flag={f} userId={userId} date={date} canReview={canReview} />
        ))}
      </ul>
    </section>
  );
}

function FlagRow({
  flag,
  userId,
  date,
  canReview,
}: {
  flag: DayFlag;
  userId: string;
  date: string;
  canReview: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();
  const review = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("anticheat_mark_reviewed", {
        p_flag_id: flag.id,
        // Generated types don't mark function arguments nullable; no note is null.
        p_note: (note.trim() || null) as string,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: dayFlagsQuery(userId, date).queryKey });
    },
  });
  const { title, detail } = flagText(flag.kind, flag.details);

  return (
    <li className="rounded-lg border border-warnline bg-panel p-4 text-ink">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold">{title}</h3>
          <p className="mt-0.5 text-[13.5px] text-ink2">{detail}</p>
          {flag.reviewedAt && (
            <p className="mt-1.5 text-[13px] text-ink2">
              Reviewed by {flag.reviewedBy ?? "a manager"},{" "}
              {DateTime.fromISO(flag.reviewedAt, { zone: viewerZone() }).toFormat("d LLL HH:mm")}
              {flag.reviewNote ? `: ${flag.reviewNote}` : ""}
            </p>
          )}
        </div>
        {flag.reviewedAt ? (
          <span className="text-[12.5px] font-medium text-ink3">Reviewed</span>
        ) : (
          canReview &&
          !open && (
            <Button
              variant="secondary"
              className="h-10"
              aria-label={`Mark reviewed: ${title}`}
              onClick={() => setOpen(true)}
            >
              Mark reviewed
            </Button>
          )
        )}
      </div>
      {open && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            review.mutate();
          }}
        >
          <Label htmlFor={`note-${flag.id}`}>Note (optional)</Label>
          <textarea
            id={`note-${flag.id}`}
            value={note}
            maxLength={500}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-[9px] border border-line2 bg-panel px-3 py-2 text-sm text-ink"
          />
          {review.error && (
            <p role="alert" className="text-[13px] text-warnink">
              Couldn't save: {review.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" className="h-10" disabled={review.isPending}>
              Save review
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
