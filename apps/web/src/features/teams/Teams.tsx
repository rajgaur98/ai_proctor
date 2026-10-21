// Teams (#66, ORG-08, ADM-02): groups of people for filtering the live grid, reports and
// exports, and per-team overrides of the check-in settings. Owners and admins only. A
// person is in one team at most; the database audit-logs every change and the members'
// apps pick up new overrides at their next sync.
import type { Policy } from "@ai-proctor/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { type Member, membersQuery } from "../people/members";
import { Check, NumberField, OnOff } from "../policy/fields";
import { policySettingsQuery } from "../policy/policyData";
import {
  draftFrom,
  type OverrideDraft,
  type OverrideGroup,
  orgValues,
  overrideSummary,
  sameOverrides,
  validateOverrides,
} from "./overrides";
import {
  deleteTeam,
  saveTeam,
  setTeamMembers,
  setTeamPolicy,
  type Team,
  teamsQuery,
} from "./teamData";

export function Teams() {
  const { profile } = useRouteContext({ from: "/_app" });
  const teams = useQuery(teamsQuery);
  const members = useQuery(membersQuery);
  const settings = useQuery(policySettingsQuery);
  // null: closed, "new": blank form, else the team being edited.
  const [editing, setEditing] = useState<Team | "new" | null>(null);

  const rows = teams.data ?? [];
  const people = members.data ?? [];
  const count = (id: string) => people.filter((m) => m.teamId === id).length;
  const error = teams.error ?? members.error ?? settings.error;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Teams</h1>
          <p className="mt-1 text-[13.5px] text-ink2">
            {profile.orgName} · {rows.length} {rows.length === 1 ? "team" : "teams"}
          </p>
        </div>
        <Button className="ml-auto" disabled={!settings.data} onClick={() => setEditing("new")}>
          New team
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load teams: {error.message}
          </p>
        ) : teams.isPending || members.isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <span
              aria-hidden
              className="mb-1.5 h-10 w-10 rounded-full border-[1.5px] border-dashed border-line2"
            />
            <p className="text-base font-semibold">No teams yet</p>
            <p className="max-w-[380px] text-[13.5px] text-ink2">
              Group people into teams to filter the live team, reports and exports, and to give a
              team its own check-in settings.
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
              <tr className="h-10 border-b border-line">
                <th className="px-5 font-medium">Team</th>
                <th className="font-medium">People</th>
                <th className="font-medium">Policy</th>
                <th className="pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const summary = overrideSummary(t.policy);
                return (
                  <tr
                    key={t.id}
                    className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
                  >
                    <td className="font-medium md:px-5">{t.name}</td>
                    <td className="text-ink2 tabular-nums">{count(t.id)}</td>
                    <td className="text-ink2">
                      {summary.length ? summary.join(" · ") : "Org policy"}
                    </td>
                    <td className="md:pr-5 md:text-right">
                      <Button
                        variant="secondary"
                        className="h-9"
                        aria-label={`Edit ${t.name}`}
                        disabled={!settings.data}
                        onClick={() => setEditing(t)}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="px-5 py-3 text-xs text-ink3">
          A person is in one team at most. Team, member and policy changes are recorded in the audit
          log; overrides reach each member's app at its next sync.
        </p>
      </div>

      {editing && settings.data && (
        <TeamDialog
          team={editing === "new" ? null : editing}
          teams={rows}
          members={people}
          org={settings.data.policy}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

const groupTitle: Record<OverrideGroup, string> = {
  interval: "Check-in interval",
  response: "Response window",
  idle: "Idle threshold",
  autoClockIn: "Auto clock-in",
  clockOut: "Forgotten clock-out",
};

/** What the org's policy says for a group, for a team that doesn't override it. */
function orgText(group: OverrideGroup, org: Policy): string {
  switch (group) {
    case "interval":
      return org.checkin_min_interval_min === org.checkin_max_interval_min
        ? `every ${org.checkin_min_interval_min} min`
        : `every ${org.checkin_min_interval_min} to ${org.checkin_max_interval_min} min`;
    case "response":
      return `${org.checkin_response_s} s`;
    case "idle":
      return `${org.idle_threshold_min} min`;
    case "autoClockIn":
      return org.auto_clock_in ? "on" : "off";
    case "clockOut":
      return `${org.forgotten_clock_out_min} min after a shift`;
  }
}

function TeamDialog({
  team,
  teams,
  members,
  org,
  onClose,
}: {
  team: Team | null;
  teams: Team[];
  members: Member[];
  org: Policy;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(team?.name ?? "");
  const initial = members.filter((m) => team && m.teamId === team.id).map((m) => m.id);
  const [picked, setPicked] = useState(() => new Set(initial));
  const [draft, setDraft] = useState<OverrideDraft>(() =>
    draftFrom(team?.policy ?? {}, orgValues(org)),
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Set once the team row exists, so a retry after a failed members or policy save doesn't
  // create it twice.
  const savedId = useRef<string | null>(team?.id ?? null);

  const checked = validateOverrides(draft);
  const errors = checked.errors ?? {};
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  // Active people, plus anyone already in the team who has since been deactivated.
  const people = members.filter((m) => m.active || picked.has(m.id));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: teamsQuery.queryKey });
    queryClient.invalidateQueries({ queryKey: membersQuery.queryKey });
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!checked.data) throw new Error("Fix the highlighted settings first.");
      let teamId = savedId.current;
      if (!teamId) {
        teamId = await saveTeam(null, name);
        savedId.current = teamId;
      } else if (team && name.trim() !== team.name) {
        await saveTeam(teamId, name);
      }
      const ids = [...picked];
      if (ids.length !== initial.length || ids.some((m) => !initial.includes(m)) || !team) {
        await setTeamMembers(teamId, ids);
      }
      if (!sameOverrides(team?.policy ?? {}, checked.data)) {
        await setTeamPolicy(teamId, checked.data);
      }
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteTeam(team?.id ?? ""),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const setOn = (g: OverrideGroup, on: boolean) =>
    setDraft((d) => ({ ...d, on: { ...d.on, [g]: on } }));
  const setValue = <K extends keyof OverrideDraft["values"]>(k: K, v: OverrideDraft["values"][K]) =>
    setDraft((d) => ({ ...d, values: { ...d.values, [k]: v } }));

  const fields: Record<OverrideGroup, React.ReactNode> = {
    interval: (
      <div className="flex flex-wrap gap-3">
        <NumberField
          label="Shortest interval"
          unit="min"
          value={draft.values.checkin_min_interval_min}
          error={errors.checkin_min_interval_min}
          onChange={(v) => setValue("checkin_min_interval_min", v as number)}
        />
        <NumberField
          label="Longest interval"
          unit="min"
          value={draft.values.checkin_max_interval_min}
          error={errors.checkin_max_interval_min}
          onChange={(v) => setValue("checkin_max_interval_min", v as number)}
        />
      </div>
    ),
    response: (
      <NumberField
        label="Response window"
        unit="s"
        value={draft.values.checkin_response_s}
        error={errors.checkin_response_s}
        onChange={(v) => setValue("checkin_response_s", v as number)}
      />
    ),
    idle: (
      <NumberField
        label="Idle threshold"
        unit="min"
        value={draft.values.idle_threshold_min}
        error={errors.idle_threshold_min}
        onChange={(v) => setValue("idle_threshold_min", v as number)}
      />
    ),
    autoClockIn: (
      <OnOff
        label="Auto clock-in"
        value={draft.values.auto_clock_in}
        onChange={(v) => setValue("auto_clock_in", v)}
      />
    ),
    clockOut: (
      <NumberField
        label="Clock out after"
        unit="min"
        value={draft.values.forgotten_clock_out_min}
        error={errors.forgotten_clock_out_min}
        onChange={(v) => setValue("forgotten_clock_out_min", v as number)}
      />
    ),
  };

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      className="m-auto max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
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
          {team ? `Edit ${team.name}` : "New team"}
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Team name</Label>
          <Input
            id={`${id}-name`}
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-[13px] font-medium text-ink2">People</legend>
          {people.length === 0 ? (
            <p className="text-sm text-ink2">No one to add yet.</p>
          ) : (
            <div className="flex max-h-[200px] flex-col gap-2 overflow-y-auto rounded-[9px] border border-line2 p-3">
              {people.map((m) => {
                const other = m.teamId && m.teamId !== team?.id ? teamName.get(m.teamId) : null;
                return (
                  <label key={m.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.has(m.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(m.id);
                        else next.delete(m.id);
                        setPicked(next);
                      }}
                      className="h-4 w-4"
                    />
                    {m.fullName}
                    {m.active ? "" : " · deactivated"}
                    {other && <span className="text-ink3"> · in {other}</span>}
                  </label>
                );
              })}
            </div>
          )}
          <p className="text-xs text-ink3">Someone already in another team moves to this one.</p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-[13px] font-medium text-ink2">Policy overrides</legend>
          <p className="text-xs text-ink3">
            Anything not overridden follows the org policy. What is captured, retention and alerts
            stay the same for everyone.
          </p>
          {(Object.keys(groupTitle) as OverrideGroup[]).map((g) => (
            <div
              key={g}
              className="flex flex-col gap-2 rounded-[9px] border border-line2 px-3 py-1"
            >
              <Check
                label={`Override ${groupTitle[g].toLowerCase()}`}
                checked={draft.on[g]}
                onChange={(on) => setOn(g, on)}
              />
              {draft.on[g] ? (
                <div className="pb-3">{fields[g]}</div>
              ) : (
                <p className="-mt-2 pb-2 text-[12.5px] text-ink2">
                  {groupTitle[g]} follows the org: {orgText(g, org)}.
                </p>
              )}
            </div>
          ))}
        </fieldset>

        {confirmingDelete && (
          <div
            role="alertdialog"
            aria-label="Delete team"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-warnline bg-warnbg p-4 text-[13.5px] text-warnink"
          >
            <span className="font-medium">
              Delete {team?.name}? Its {initial.length}{" "}
              {initial.length === 1 ? "member is" : "members are"} left without a team.
            </span>
            <span className="ml-auto flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setConfirmingDelete(false)}>
                Keep team
              </Button>
              <Button type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Delete team
              </Button>
            </span>
          </div>
        )}
        {(save.error ?? remove.error) && (
          <p role="alert" className="text-sm text-warnink">
            {(save.error ?? remove.error)?.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {team && !confirmingDelete && (
            <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          )}
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || checked.data === null}>
            {save.isPending ? "Saving…" : "Save team"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
