// People (#28, ORG-03..06): members with role, manager and work location; admins
// invite, edit and deactivate. Changes are audit-logged by the database.
import type { Enums } from "@ai-proctor/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { initials } from "../../lib/nav";
import { DataRequests } from "./DataRequests";
import { InviteDialog } from "./InviteDialog";
import { MemberFields } from "./MemberFields";
import {
  type Member,
  managersOf,
  membersQuery,
  setActive,
  setApprovalRequired,
  updateMember,
} from "./members";
import { ShiftEditor } from "./ShiftEditor";

export const roleLabel: Record<Enums<"user_role">, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  employee: "Employee",
};

export function People() {
  const { profile } = useRouteContext({ from: "/_app" });
  const { data, error, isPending } = useQuery(membersQuery);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Member | null>(null);
  const inviteRef = useRef<HTMLDialogElement>(null);
  const members = data ?? [];
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const visible = members.filter((m) =>
    `${m.fullName} ${m.email}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">People</h1>
          <p className="mt-1 text-[13.5px] text-ink2">
            {profile.orgName} · {members.filter((m) => m.active).length} active
          </p>
        </div>
        <Button className="ml-auto" onClick={() => inviteRef.current?.showModal()}>
          Invite people
        </Button>
      </div>

      <input
        type="search"
        aria-label="Search people"
        placeholder="Search people"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-10 w-full rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px] md:w-[280px]"
      />

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load people: {error.message}
          </p>
        ) : isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : (
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
              <tr className="h-10 border-b border-line">
                <th className="px-5 font-medium">Person</th>
                <th className="font-medium">Role</th>
                <th className="font-medium">Manager</th>
                <th className="font-medium">Work location</th>
                <th className="pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m) => (
                <tr
                  key={m.id}
                  className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
                >
                  <td className="md:px-5">
                    <span className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className="grid h-8 w-8 place-items-center rounded-full bg-sunk text-xs font-semibold text-ink2"
                      >
                        {initials(m.fullName)}
                      </span>
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {m.fullName}
                          {m.active ? "" : " · deactivated"}
                        </span>
                        <span className="text-xs text-ink3">{m.email}</span>
                      </span>
                    </span>
                  </td>
                  <td>{roleLabel[m.role]}</td>
                  <td className="text-ink2">
                    {m.managerId ? (byId.get(m.managerId)?.fullName ?? "—") : "—"}
                  </td>
                  <td className="text-ink2">
                    {m.country}
                    {m.state ? ` · ${m.state}` : ""}
                  </td>
                  <td className="md:pr-5 md:text-right">
                    <Button
                      variant="secondary"
                      className="h-9"
                      aria-label={`Edit ${m.fullName}`}
                      onClick={() => setEditing(m)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-5 py-3 text-xs text-ink3">
          Role, manager, location and approval changes are recorded in the audit log.
        </p>
      </div>

      <InviteDialog dialogRef={inviteRef} members={members} />
      {editing && (
        <EditDialog
          member={editing}
          members={members}
          isSelf={editing.id === profile.id}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function EditDialog({
  member,
  members,
  isSelf,
  onClose,
}: {
  member: Member;
  members: Member[];
  isSelf: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(member);
  const done = () => {
    queryClient.invalidateQueries({ queryKey: membersQuery.queryKey });
    onClose();
  };
  const save = useMutation({
    mutationFn: async () => {
      await updateMember(draft);
      if (draft.approvalRequired !== member.approvalRequired) {
        await setApprovalRequired(member.id, draft.approvalRequired);
      }
    },
    onSuccess: done,
  });
  const toggle = useMutation({
    mutationFn: () => setActive(member.id, !member.active),
    onSuccess: done,
  });
  const error = save.error ?? toggle.error;

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby="edit-title"
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 id="edit-title" className="text-lg font-semibold">
          Edit {member.fullName}
        </h2>
        <MemberFields
          value={draft}
          onChange={setDraft}
          managers={managersOf(members).filter((m) => m.id !== member.id)}
          roleLocked={isSelf || member.role === "owner"}
        />
        {member.role !== "owner" && (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={!draft.approvalRequired}
              onChange={(e) => setDraft({ ...draft, approvalRequired: !e.target.checked })}
              className="mt-0.5 h-5 w-5 flex-none accent-acc"
            />
            <span>
              <span className="font-medium">Approval not required</span>
              <span className="block text-[12.5px] text-ink2">
                Their weekly timesheet is approved as soon as they submit it. The change is recorded
                in the audit log.
              </span>
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-warnink">
            {error.message}
          </p>
        )}
        <ShiftEditor userId={member.id} timezone={draft.timezone} />
        {!isSelf && <DataRequests member={member} onDeleted={done} />}
        <div className="flex flex-wrap gap-2">
          {!isSelf && member.role !== "owner" && (
            <Button
              type="button"
              variant="ghost"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate()}
            >
              {member.active ? "Deactivate" : "Reactivate"}
            </Button>
          )}
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save details"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
