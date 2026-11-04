// Settings → API (#306, API-01, API-02): owners and admins make org API keys for the public
// API, with a name, what each key may read or change, and an optional expiry; a key is
// shown once, when it is made, and can be revoked. Making, revoking and every request a
// key makes are recorded in the audit log by the database.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useId, useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { exportTime } from "../../lib/exportFile";
import { DateTimeText } from "../notice/NoticeView";
import {
  type ApiKey,
  apiBaseUrl,
  apiKeysQuery,
  type CreatedKey,
  createKey,
  revokeKey,
} from "./apiKeysData";
import { endOfDay, keyStatus, scopeGroups, scopeSummary } from "./apiText";

export function ApiPage() {
  const { profile } = useRouteContext({ from: "/_app" });
  const { data, error, isPending } = useQuery(apiKeysQuery);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const keys = data ?? [];

  return (
    <section className="flex max-w-[960px] flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="text-xs font-medium text-ink3">Settings</p>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">API</h1>
          <p className="mt-1 max-w-[620px] text-[13.5px] text-ink2">
            Keys for connecting payroll, BI and HR tools to {profile.orgName}'s data. A key reads
            and changes only what you allow, sees the whole organization, and acts as the person who
            made it. The API never returns captures or window titles.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <ExportButton
            title="API keys"
            ready={!isPending && !error}
            spec={{
              page: "api-keys",
              filters: {},
              // The prefix only: the key itself is never stored.
              table: () => ({
                sheet: "API keys",
                header: [
                  "Name",
                  "Key prefix",
                  "Access",
                  "Created",
                  "Created by",
                  "Expires",
                  "Last used",
                  "Status",
                  "Revoked",
                ],
                rows: keys.map((k) => [
                  k.name,
                  k.prefix,
                  scopeSummary(k.scopes),
                  exportTime(k.createdAt),
                  k.createdBy ?? "",
                  exportTime(k.expiresAt),
                  exportTime(k.lastUsedAt),
                  keyStatus(k),
                  exportTime(k.revokedAt),
                ]),
              }),
            }}
          />
          <Button variant="secondary" onClick={() => setCreating(true)}>
            New API key
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load API keys: {error.message}
          </p>
        ) : isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="p-6 text-[13.5px] text-ink2">No API keys yet.</p>
        ) : (
          <table className="w-full border-collapse text-[13.5px]" aria-label="API keys">
            <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
              <tr className="h-10 border-b border-line">
                <th className="px-5 font-medium">Name</th>
                <th className="font-medium">Key</th>
                <th className="font-medium">Access</th>
                <th className="font-medium">Last used</th>
                <th className="font-medium">Status</th>
                <th className="pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const status = keyStatus(k);
                return (
                  <tr
                    key={k.id}
                    className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
                  >
                    <td className="md:px-5">
                      <span className="flex flex-col">
                        <span className="font-medium">{k.name}</span>
                        <span className="text-xs text-ink3">
                          Created <DateTimeText iso={k.createdAt} />
                          {k.createdBy ? ` by ${k.createdBy}` : ""}
                        </span>
                      </span>
                    </td>
                    <td className="font-mono text-[12.5px] text-ink2">{k.prefix}…</td>
                    <td className="max-w-[260px] py-2 text-ink2">{scopeSummary(k.scopes)}</td>
                    <td className="text-ink2">
                      {k.lastUsedAt ? <DateTimeText iso={k.lastUsedAt} /> : "Never"}
                    </td>
                    <td className={status === "Active" ? "" : "text-ink3"}>
                      {status}
                      {status === "Active" && k.expiresAt && (
                        <span className="block text-xs text-ink3">
                          Expires <DateTimeText iso={k.expiresAt} />
                        </span>
                      )}
                    </td>
                    <td className="md:pr-5 md:text-right">
                      {!k.revokedAt && (
                        <Button
                          variant="secondary"
                          className="h-9"
                          aria-label={`Revoke ${k.name}`}
                          onClick={() => setRevoking(k)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="px-5 py-3 text-xs text-ink3">
          A key stops working when it is revoked, when it expires, or when the person who made it is
          no longer an active owner or admin. Keys, revocations and every request are recorded in
          the audit log.
        </p>
      </div>

      <section
        aria-labelledby="api-usage-title"
        className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-5 text-[13.5px]"
      >
        <h2 id="api-usage-title" className="text-sm font-semibold">
          Using the API
        </h2>
        <p className="text-ink2">
          Send the key as a bearer token. Lists are paged with a cursor and take{" "}
          <code className="font-mono text-[12.5px]">updated_since</code> for syncing; times are ISO
          8601 with a zone and durations are exact seconds. Each key may make 120 requests a minute.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-sunk p-3 font-mono text-[12.5px] text-ink">
          {`curl -H "Authorization: Bearer aip_…" \\\n  ${apiBaseUrl}/v1/people`}
        </pre>
        <p className="text-ink2">
          Every operation, parameter and field is in the{" "}
          <a
            className="underline"
            href={`${apiBaseUrl}/v1/openapi.json`}
            target="_blank"
            rel="noreferrer"
          >
            OpenAPI document
          </a>
          .
        </p>
      </section>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {revoking && <RevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} />}
    </section>
  );
}

const dialogClass =
  "m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";

function CreateDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [expires, setExpires] = useState("");
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const id = useId();
  const create = useMutation<CreatedKey>({
    mutationFn: () => createKey(name, [...scopes], expires ? endOfDay(expires) : null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey }),
  });
  const created = create.data;

  const toggle = (scope: string, on: boolean) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (on) next.add(scope);
      else next.delete(scope);
      return next;
    });

  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
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
      aria-labelledby={`${id}-title`}
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
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          New API key
        </h2>
        {created ? (
          <>
            <p className="text-sm text-ink2">
              Put this key in the tool that connects to AI Proctor. Copy it now: it isn't shown
              again.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-value`}>Key for {created.name}</Label>
              <Input
                id={`${id}-value`}
                readOnly
                value={created.key}
                onFocus={(e) => e.target.select()}
                className="font-mono text-[12.5px]"
              />
            </div>
            <p role="status" className="min-h-5 text-xs text-ink3">
              {copied === "yes"
                ? "Copied."
                : copied === "failed"
                  ? "Couldn't copy. Select the key and copy it."
                  : ""}
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={80}
                placeholder="Payroll sync"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-medium">What it may use</legend>
              <div className="max-h-[300px] overflow-y-auto rounded-lg border border-line">
                {scopeGroups.map((g) => (
                  <div
                    key={g.read}
                    className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-0"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm">{g.resource}</span>
                      <span className="text-xs text-ink3">{g.about}</span>
                    </span>
                    {[g.read, g.write].map(
                      (scope) =>
                        scope && (
                          <label
                            key={scope}
                            className="flex h-9 cursor-pointer items-center gap-1.5 text-[13px]"
                          >
                            <input
                              type="checkbox"
                              checked={scopes.has(scope)}
                              onChange={(e) => toggle(scope, e.target.checked)}
                              aria-label={`${g.resource}: ${scope.endsWith(":write") ? "write" : "read"}`}
                            />
                            {scope.endsWith(":write") ? "Write" : "Read"}
                          </label>
                        ),
                    )}
                  </div>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-expires`}>Expires on (optional)</Label>
              <Input
                id={`${id}-expires`}
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                className="w-[200px]"
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
                onClick={() => copy(created.key)}
              >
                Copy key
              </Button>
              <Button type="submit">Done</Button>
            </>
          ) : (
            <>
              <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || scopes.size === 0 || create.isPending}
              >
                {create.isPending ? "Creating…" : "Create key"}
              </Button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

function RevokeDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeKey(apiKey.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
      onClose();
    },
  });

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby="revoke-key-title"
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
        <h2 id="revoke-key-title" className="text-lg font-semibold">
          Revoke {apiKey.name}?
        </h2>
        <p className="text-sm text-ink2">
          Every tool using this key stops getting data at once. This can't be undone: make a new key
          to connect again.
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
            {revoke.isPending ? "Revoking…" : "Revoke key"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
