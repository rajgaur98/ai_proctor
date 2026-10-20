// Data subject requests for one person (#54, ADM-05), in the member editor: export
// everything held about them, or delete it permanently. Both ask the admin to type the
// person's email; the Edge Functions check it again, with the admin's role and MFA.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { type Member, membersQuery } from "./members";
import { emailConfirmed, rowsRemoved } from "./requestHelpers";
import { type DeletedData, deleteUserData, exportUserData } from "./userDataApi";

type Kind = "export" | "delete";

export function DataRequests({
  member,
  onDeleted,
}: {
  member: Member;
  /** After a deletion, when the admin closes the result. */
  onDeleted: () => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  return (
    <section aria-labelledby="data-requests-title" className="flex flex-col gap-2">
      <h3 id="data-requests-title" className="text-sm font-semibold">
        Data requests
      </h3>
      <p className="text-xs text-ink3">
        Export a copy of everything held about {member.fullName}, or delete it for good. Both are
        recorded in the audit log.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-9"
          aria-label={`Export data for ${member.fullName}`}
          onClick={() => setKind("export")}
        >
          Export data
        </Button>
        {member.role !== "owner" && (
          <Button
            type="button"
            variant="secondary"
            className="h-9 border-warnline text-warnink"
            aria-label={`Delete data permanently for ${member.fullName}`}
            onClick={() => setKind("delete")}
          >
            Delete data permanently
          </Button>
        )}
      </div>
      {kind &&
        // Outside the editor's form: dialogs inside it would nest forms.
        createPortal(
          <RequestDialog
            kind={kind}
            member={member}
            onClose={() => setKind(null)}
            onDeleted={onDeleted}
          />,
          document.body,
        )}
    </section>
  );
}

function RequestDialog({
  kind,
  member,
  onClose,
  onDeleted,
}: {
  kind: Kind;
  member: Member;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const confirmed = emailConfirmed(typed, member.email);
  const queryClient = useQueryClient();
  const run = useMutation<DeletedData | null>({
    mutationFn: async () => {
      if (kind === "export") {
        await exportUserData(member.id, typed.trim());
        return null;
      }
      return deleteUserData(member.id, typed.trim());
    },
    // The person is gone from the list behind this dialog.
    onSuccess: () => {
      if (kind === "delete") queryClient.invalidateQueries({ queryKey: membersQuery.queryKey });
    },
  });
  const finished = run.isSuccess;
  const titleId = `request-${kind}-title`;
  const close = () => {
    onClose();
    if (kind === "delete" && finished) onDeleted();
  };

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={close}
      // A running request isn't cancelled by Escape: the deletion in particular.
      onCancel={(e) => run.isPending && e.preventDefault()}
      aria-labelledby={titleId}
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          // React events bubble out of a portal into the editor's own form.
          e.stopPropagation();
          if (confirmed && !run.isPending && !finished) run.mutate();
        }}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {kind === "export"
            ? `Export data for ${member.fullName}`
            : `Delete data permanently for ${member.fullName}`}
        </h2>

        {finished ? (
          <p role="status" className="text-sm">
            {kind === "export"
              ? "The download has started. The export is recorded in the audit log."
              : deletedText(run.data)}
          </p>
        ) : (
          <>
            {kind === "export" ? (
              <p className="text-sm text-ink2">
                A ZIP with everything held about {member.fullName}: profile, check-ins, clock
                sessions, breaks, timesheets and edits, activity, notifications, who viewed their
                captures, and the capture images still inside the retention period. It is the same
                file they get from My data, except for their private pause reasons.
              </p>
            ) : (
              <div className="flex flex-col gap-2 text-sm text-ink2">
                <p>This deletes everything held about {member.fullName} and cannot be undone:</p>
                <ul className="list-disc pl-5">
                  <li>
                    check-in images, check-ins, activity, time, timesheets and their edits,
                    notifications and alerts
                  </li>
                  <li>their devices and their sign-in: they can no longer sign in</li>
                  <li>
                    the audit log keeps what it recorded about them (with their name) and adds one
                    entry that this was deleted and by whom, without their email
                  </li>
                </ul>
                <p>Export their data first if it is needed.</p>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`confirm-${kind}`}>Type {member.email} to confirm</Label>
              <Input
                id={`confirm-${kind}`}
                type="email"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          </>
        )}

        {run.error && (
          <p role="alert" className="text-sm text-warnink">
            {run.error.message}
          </p>
        )}

        <div className="flex gap-2">
          {finished ? (
            <Button type="button" className="ml-auto" onClick={() => close()}>
              Close
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                className="ml-auto"
                disabled={run.isPending}
                onClick={() => close()}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!confirmed || run.isPending}>
                {run.isPending
                  ? kind === "export"
                    ? "Preparing…"
                    : "Deleting…"
                  : kind === "export"
                    ? "Export data"
                    : "Delete permanently"}
              </Button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

function deletedText(result: DeletedData | null | undefined): string {
  if (!result) return "Deleted.";
  const rows = rowsRemoved(result.counts);
  return `Deleted: ${rows} ${rows === 1 ? "record" : "records"} and ${result.images_removed} ${
    result.images_removed === 1 ? "image" : "images"
  }, and their sign-in. The audit log has an entry for it.`;
}
