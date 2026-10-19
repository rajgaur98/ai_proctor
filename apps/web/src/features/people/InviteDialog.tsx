// Invite one person, or many from a CSV (#28, ORG-03). The invite email links to
// /join, where they set a password and download the agent.
import type { Invite, InviteResult } from "@ai-proctor/contracts";
import { Invite as InviteSchema } from "@ai-proctor/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { type RefObject, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { invitesFromCsv } from "./csv";
import { type MemberDraft, MemberFields } from "./MemberFields";
import { type Member, managersOf, membersQuery, sendInvites } from "./members";

type Mode = "one" | "csv";

export function InviteDialog({
  dialogRef,
  members,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  members: Member[];
}) {
  const { profile } = useRouteContext({ from: "/_app" });
  const queryClient = useQueryClient();
  const me = members.find((m) => m.id === profile.id);
  const managers = managersOf(members);
  const blank: MemberDraft = {
    fullName: "",
    role: "employee",
    managerId: profile.id,
    country: me?.country ?? "US",
    state: me?.state ?? null,
    timezone: me?.timezone ?? profile.timezone,
  };
  const [mode, setMode] = useState<Mode>("one");
  const [email, setEmail] = useState("");
  const [draft, setDraft] = useState<MemberDraft>(blank);
  const [csv, setCsv] = useState("");
  const [results, setResults] = useState<InviteResult[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const fromCsv = useMemo(
    () =>
      csv.trim()
        ? invitesFromCsv(csv, new Map(managers.map((m) => [m.email.toLowerCase(), m.id])), {
            role: draft.role === "owner" ? "employee" : draft.role,
            managerId: draft.managerId ?? "",
            country: draft.country,
            state: draft.state,
            timezone: draft.timezone,
          })
        : null,
    [csv, managers, draft],
  );

  const send = useMutation({
    mutationFn: (invites: Invite[]) => sendInvites(invites),
    onSuccess: (r) => {
      setResults(r);
      queryClient.invalidateQueries({ queryKey: membersQuery.queryKey });
      if (r.every((x) => x.ok)) {
        setEmail("");
        setDraft(blank);
        setCsv("");
      }
    },
  });

  function submit() {
    setProblem(null);
    setResults(null);
    if (mode === "csv") {
      if (!fromCsv || fromCsv.invites.length === 0) {
        setProblem("No valid rows to invite.");
        return;
      }
      send.mutate(fromCsv.invites);
      return;
    }
    const parsed = InviteSchema.safeParse({
      email: email.trim().toLowerCase(),
      full_name: draft.fullName,
      role: draft.role,
      manager_id: draft.managerId,
      work_country: draft.country,
      work_state: draft.country === "US" ? draft.state : null,
      timezone: draft.timezone,
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Check the fields.");
      return;
    }
    send.mutate([parsed.data]);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="invite-title"
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="invite-title" className="text-lg font-semibold">
          Invite people
        </h2>
        <div role="radiogroup" aria-label="How to invite" className="flex gap-2">
          {(["one", "csv"] as const).map((m) => (
            <Button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              variant={mode === m ? "primary" : "secondary"}
              className="h-9"
              onClick={() => setMode(m)}
            >
              {m === "one" ? "One person" : "Upload CSV"}
            </Button>
          ))}
        </div>

        {mode === "one" ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Work email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <MemberFields value={draft} onChange={setDraft} managers={managers} />
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-csv">CSV</Label>
              <p className="text-xs text-ink3">
                Columns: email, full_name, and optionally role, manager_email, country, state,
                timezone. Empty cells use the defaults below.
              </p>
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Choose a CSV file"
                className="text-sm"
                onChange={async (e) => setCsv((await e.target.files?.[0]?.text()) ?? "")}
              />
              <textarea
                id="invite-csv"
                rows={5}
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                placeholder={"email,full_name,manager_email\nnora@example.com,Nora New,"}
                className="rounded-[9px] border border-line2 bg-panel p-3 font-mono text-[12.5px]"
              />
            </div>
            <MemberFields value={draft} onChange={setDraft} managers={managers} showName={false} />
            {fromCsv && (
              <div className="text-sm" aria-live="polite">
                <p>{fromCsv.invites.length} ready to invite</p>
                {fromCsv.errors.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-warnink">
                    {fromCsv.errors.map((e) => (
                      <li key={e.line}>
                        Line {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        {results && (
          <ul aria-label="Invite results" className="flex flex-col gap-1 text-sm">
            {results.map((r) => (
              <li key={r.email} className={r.ok ? "text-ink2" : "text-warnink"}>
                {r.email}: {r.ok ? "invited" : r.error}
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="ml-auto"
            onClick={() => {
              setResults(null);
              dialogRef.current?.close();
            }}
          >
            Close
          </Button>
          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? "Sending…" : "Send invites"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
