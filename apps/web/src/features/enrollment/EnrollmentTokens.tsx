// Device enrollment for MDM installs (#86, AGT-01), on the People page: owners and
// admins create org tokens for Intune, Jamf or Kandji, and revoke them. A token is
// shown once, when it is created. Creating, revoking and every enrollment are
// recorded in the audit log by the database.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { exportTime } from "../../lib/exportFile";
import { DateTimeText } from "../notice/NoticeView";
import {
  type CreatedToken,
  createToken,
  type EnrollmentToken,
  revokeToken,
  tokensQuery,
} from "./enrollmentData";
import { deviceCount, tokenStatus } from "./enrollmentText";

export function EnrollmentTokens({ orgName }: { orgName: string }) {
  const { data, error, isPending } = useQuery(tokensQuery);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<EnrollmentToken | null>(null);
  const tokens = data ?? [];

  return (
    <section aria-labelledby="enrollment-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h2 id="enrollment-title" className="text-lg font-semibold">
            Device enrollment
          </h2>
          <p className="mt-1 max-w-[640px] text-[13.5px] text-ink2">
            Tokens for installing the agent silently with Intune, Jamf or Kandji. A computer
            installed with a token only accepts people from {orgName}; they still sign in with their
            work email.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <ExportButton
            title="Enrollment tokens"
            ready={!isPending && !error}
            spec={{
              page: "enrollment-tokens",
              filters: {},
              // The prefix only: the token itself is never stored.
              table: () => ({
                sheet: "Enrollment tokens",
                header: [
                  "Name",
                  "Token prefix",
                  "Created",
                  "Created by",
                  "Enrolled devices",
                  "Last used",
                  "Status",
                  "Revoked",
                ],
                rows: tokens.map((t) => [
                  t.label,
                  t.prefix,
                  exportTime(t.createdAt),
                  t.createdBy ?? "",
                  t.devices,
                  exportTime(t.lastUsedAt),
                  tokenStatus(t),
                  exportTime(t.revokedAt),
                ]),
              }),
            }}
          />
          <Button variant="secondary" onClick={() => setCreating(true)}>
            New enrollment token
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load enrollment tokens: {error.message}
          </p>
        ) : isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="p-6 text-[13.5px] text-ink2">
            No enrollment tokens yet. Installs without one sign in the usual way.
          </p>
        ) : (
          <table className="w-full border-collapse text-[13.5px]" aria-label="Enrollment tokens">
            <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
              <tr className="h-10 border-b border-line">
                <th className="px-5 font-medium">Name</th>
                <th className="font-medium">Token</th>
                <th className="font-medium">Enrolled</th>
                <th className="font-medium">Last used</th>
                <th className="font-medium">Status</th>
                <th className="pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr
                  key={t.id}
                  className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
                >
                  <td className="md:px-5">
                    <span className="flex flex-col">
                      <span className="font-medium">{t.label}</span>
                      <span className="text-xs text-ink3">
                        Created <DateTimeText iso={t.createdAt} />
                        {t.createdBy ? ` by ${t.createdBy}` : ""}
                      </span>
                    </span>
                  </td>
                  <td className="font-mono text-[12.5px] text-ink2">{t.prefix}…</td>
                  <td className="tabular-nums text-ink2">{deviceCount(t.devices)}</td>
                  <td className="text-ink2">
                    {t.lastUsedAt ? <DateTimeText iso={t.lastUsedAt} /> : "Never"}
                  </td>
                  <td className={t.revokedAt ? "text-ink3" : ""}>{tokenStatus(t)}</td>
                  <td className="md:pr-5 md:text-right">
                    {!t.revokedAt && (
                      <Button
                        variant="secondary"
                        className="h-9"
                        aria-label={`Revoke ${t.label}`}
                        onClick={() => setRevoking(t)}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-5 py-3 text-xs text-ink3">
          Revoking a token stops new installs from enrolling; computers it already enrolled keep
          working. Tokens, revocations and enrollments are recorded in the audit log.
        </p>
      </div>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {revoking && <RevokeDialog token={revoking} onClose={() => setRevoking(null)} />}
    </section>
  );
}

const dialogClass =
  "m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";

function CreateDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const create = useMutation<CreatedToken>({
    mutationFn: () => createToken(label),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey }),
  });
  const created = create.data;

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby="new-token-title"
      className={dialogClass}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (created) onClose();
          else if (!create.isPending) create.mutate();
        }}
      >
        <h2 id="new-token-title" className="text-lg font-semibold">
          New enrollment token
        </h2>
        {created ? (
          <>
            <p className="text-sm text-ink2">
              Put this token in the AI Proctor configuration of your MDM (the setup guide lists the
              key for each tool). Copy it now: it isn't shown again.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-token-value">Token for {created.label}</Label>
              <Input
                id="new-token-value"
                readOnly
                value={created.token}
                onFocus={(e) => e.target.select()}
                className="font-mono text-[12.5px]"
              />
            </div>
            <p role="status" className="min-h-5 text-xs text-ink3">
              {copied === "yes"
                ? "Copied."
                : copied === "failed"
                  ? "Couldn't copy. Select the token and copy it."
                  : ""}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-ink2">
              Name it after where it's used, so you can tell tokens apart later.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-token-label">Name</Label>
              <Input
                id="new-token-label"
                value={label}
                maxLength={80}
                placeholder="Jamf: engineering Macs"
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </>
        )}
        {create.error && (
          <p role="alert" className="text-sm text-warnink">
            {create.error.message}
          </p>
        )}
        <div className="flex gap-2">
          {created ? (
            <>
              <Button
                type="button"
                variant="secondary"
                className="ml-auto"
                onClick={() => copy(created.token)}
              >
                Copy token
              </Button>
              <Button type="submit">Done</Button>
            </>
          ) : (
            <>
              <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!label.trim() || create.isPending}>
                {create.isPending ? "Creating…" : "Create token"}
              </Button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

function RevokeDialog({ token, onClose }: { token: EnrollmentToken; onClose: () => void }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeToken(token.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey });
      onClose();
    },
  });

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby="revoke-token-title"
      className={dialogClass}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!revoke.isPending) revoke.mutate();
        }}
      >
        <h2 id="revoke-token-title" className="text-lg font-semibold">
          Revoke {token.label}?
        </h2>
        <p className="text-sm text-ink2">
          New installs with this token can't enroll any more; remove it from your MDM too. The{" "}
          {deviceCount(token.devices)} it enrolled keep working. This can't be undone: make a new
          token to enroll more computers.
        </p>
        {revoke.error && (
          <p role="alert" className="text-sm text-warnink">
            {revoke.error.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={revoke.isPending}>
            {revoke.isPending ? "Revoking…" : "Revoke token"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
