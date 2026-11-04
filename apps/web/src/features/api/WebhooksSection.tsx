// Settings → API → Webhooks (#320, API-06): owners and admins add endpoints with the events
// they want and get a signing secret, shown once; they change an endpoint's URL and events,
// turn it off and on, rotate its secret and delete it, and read the delivery log (status,
// attempts, response code, next retry). The database audit-logs every change and turns an
// endpoint off after 5 failed deliveries in a row, notifying owners and admins.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { DateTimeText } from "../notice/NoticeView";
import {
  createWebhook,
  type Delivery,
  deleteWebhook,
  deliveriesQuery,
  rotateSecret,
  updateWebhook,
  type Webhook,
  webhooksQuery,
} from "./webhooksData";
import {
  deliveryResult,
  deliveryStatus,
  endpointStatus,
  eventLabel,
  eventSummary,
  webhookEvents,
} from "./webhookText";

const dialogClass =
  "m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";

type Open =
  | { kind: "add" }
  | { kind: "edit"; webhook: Webhook }
  | { kind: "rotate"; webhook: Webhook }
  | { kind: "delete"; webhook: Webhook };

export function WebhooksSection() {
  const { data, error, isPending } = useQuery(webhooksQuery);
  const [open, setOpen] = useState<Open | null>(null);
  const webhooks = data ?? [];
  const close = () => setOpen(null);

  return (
    <>
      <section aria-labelledby="webhooks-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <h2 id="webhooks-title" className="text-lg font-semibold">
              Webhooks
            </h2>
            <p className="mt-1 max-w-[620px] text-[13.5px] text-ink2">
              Send events to your tools as they happen: timesheets submitted, approved or returned,
              alerts, people invited or deactivated, and time-off decisions.
            </p>
          </div>
          <Button variant="secondary" className="ml-auto" onClick={() => setOpen({ kind: "add" })}>
            Add endpoint
          </Button>
        </div>
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {error ? (
            <p role="alert" className="p-6 text-sm text-warnink">
              Couldn't load webhooks: {error.message}
            </p>
          ) : isPending ? (
            <p className="p-6 text-sm text-ink2">Loading…</p>
          ) : webhooks.length === 0 ? (
            <p className="p-6 text-[13.5px] text-ink2">No endpoints yet.</p>
          ) : (
            <table className="w-full border-collapse text-[13.5px]" aria-label="Webhook endpoints">
              <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
                <tr className="h-10 border-b border-line">
                  <th className="px-5 font-medium">Endpoint</th>
                  <th className="font-medium">Events</th>
                  <th className="font-medium">Status</th>
                  <th className="pr-5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => {
                  const status = endpointStatus(w);
                  return (
                    <tr
                      key={w.id}
                      className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
                    >
                      <td className="md:max-w-[280px] md:px-5 md:py-2">
                        <span className="flex flex-col">
                          <span className="break-all font-mono text-[12.5px]">{w.url}</span>
                          <span className="text-xs text-ink3">
                            Added <DateTimeText iso={w.createdAt} />
                            {w.createdBy ? ` by ${w.createdBy}` : ""}
                          </span>
                        </span>
                      </td>
                      <td className="max-w-[240px] py-2 text-ink2">{eventSummary(w.events)}</td>
                      <td className={status === "Active" ? "" : "text-warnink"}>
                        {status}
                        <span className="block text-xs text-ink3">
                          {w.lastDeliveryAt ? (
                            <>
                              Last event <DateTimeText iso={w.lastDeliveryAt} />
                            </>
                          ) : (
                            "No events yet"
                          )}
                          {w.pending > 0 ? ` · ${w.pending} waiting` : ""}
                        </span>
                      </td>
                      <td className="md:pr-5 md:text-right">
                        <span className="flex flex-wrap gap-2 md:justify-end">
                          <Button
                            variant="secondary"
                            className="h-9"
                            aria-label={`Edit ${w.url}`}
                            onClick={() => setOpen({ kind: "edit", webhook: w })}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="secondary"
                            className="h-9"
                            aria-label={`Rotate the secret of ${w.url}`}
                            onClick={() => setOpen({ kind: "rotate", webhook: w })}
                          >
                            Rotate secret
                          </Button>
                          <Button
                            variant="secondary"
                            className="h-9"
                            aria-label={`Delete ${w.url}`}
                            onClick={() => setOpen({ kind: "delete", webhook: w })}
                          >
                            Delete
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="px-5 py-3 text-xs text-ink3">
            Each event is a JSON POST signed with the endpoint's secret: the{" "}
            <code className="font-mono">X-AIProctor-Signature</code> header is{" "}
            <code className="font-mono">v1=</code> and the hex HMAC-SHA256 of{" "}
            <code className="font-mono">X-AIProctor-Timestamp</code>, a dot and the raw body. Answer
            with a 2xx within 10 seconds; failures are retried for about a day, and an endpoint is
            turned off after 5 failed events in a row. Changes are recorded in the audit log.
          </p>
        </div>
      </section>

      <DeliveryLog webhooks={webhooks} />

      {open?.kind === "add" && <EndpointDialog onClose={close} />}
      {open?.kind === "edit" && <EndpointDialog webhook={open.webhook} onClose={close} />}
      {open?.kind === "rotate" && <RotateDialog webhook={open.webhook} onClose={close} />}
      {open?.kind === "delete" && <DeleteDialog webhook={open.webhook} onClose={close} />}
    </>
  );
}

function DeliveryLog({ webhooks }: { webhooks: Webhook[] }) {
  const [webhookId, setWebhookId] = useState<string | null>(null);
  const { data, error, isPending } = useQuery({
    ...deliveriesQuery(webhookId),
    refetchInterval: 15_000,
  });
  const id = useId();
  const deliveries = data ?? [];

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          Delivery log
        </h2>
        <div className="ml-auto flex flex-col gap-1.5">
          <Label htmlFor={`${id}-endpoint`}>Endpoint</Label>
          <select
            id={`${id}-endpoint`}
            value={webhookId ?? ""}
            onChange={(e) => setWebhookId(e.target.value || null)}
            className="h-9 max-w-[320px] rounded-lg border border-line bg-panel px-2 text-[13.5px]"
          >
            <option value="">All endpoints</option>
            {webhooks.map((w) => (
              <option key={w.id} value={w.id}>
                {w.url}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load deliveries: {error.message}
          </p>
        ) : isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : deliveries.length === 0 ? (
          <p className="p-6 text-[13.5px] text-ink2">No deliveries in the last 30 days.</p>
        ) : (
          <table className="w-full border-collapse text-[13.5px]" aria-label="Webhook deliveries">
            <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
              <tr className="h-10 border-b border-line">
                <th className="px-5 font-medium">Event</th>
                <th className="font-medium">Status</th>
                <th className="font-medium">Attempts</th>
                <th className="font-medium">Response</th>
                <th className="pr-5 font-medium">Next retry</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <DeliveryRow key={d.id} d={d} showUrl={webhookId === null} />
              ))}
            </tbody>
          </table>
        )}
        <p className="px-5 py-3 text-xs text-ink3">
          The newest 100 deliveries. Deliveries are kept for 30 days.
        </p>
      </div>
    </section>
  );
}

function DeliveryRow({ d, showUrl }: { d: Delivery; showUrl: boolean }) {
  const status = deliveryStatus(d);
  return (
    <tr className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-12 md:p-0">
      <td className="md:px-5 md:py-2">
        <span className="flex flex-col">
          <span>{eventLabel(d.eventType)}</span>
          <span className="text-xs text-ink3">
            <DateTimeText iso={d.createdAt} />
            {showUrl ? ` · ${d.url}` : ""}
          </span>
        </span>
      </td>
      <td className={status === "Failed" ? "text-warnink" : ""}>{status}</td>
      <td className="text-ink2">
        <span className="md:hidden">Attempts: </span>
        {d.attempts}
      </td>
      <td className="text-ink2">{deliveryResult(d)}</td>
      <td className="text-ink2 md:pr-5">
        {d.nextAttemptAt ? <DateTimeText iso={d.nextAttemptAt} /> : "—"}
      </td>
    </tr>
  );
}

function SecretField({ id, label, secret }: { id: string; label: string; secret: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <>
      <p className="text-sm text-ink2">
        Use this secret to check the signature of each request. Copy it now: it isn't shown again.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          readOnly
          value={secret}
          onFocus={(e) => e.target.select()}
          className="font-mono text-[12.5px]"
        />
      </div>
      <div className="flex items-center gap-2">
        <p role="status" className="min-h-5 text-xs text-ink3">
          {copied === "yes"
            ? "Copied."
            : copied === "failed"
              ? "Couldn't copy. Select the secret and copy it."
              : ""}
        </p>
        <Button type="button" variant="secondary" className="ml-auto" onClick={copy}>
          Copy secret
        </Button>
      </div>
    </>
  );
}

function useRefreshWebhooks() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: webhooksQuery.queryKey });
    queryClient.invalidateQueries({ queryKey: ["webhook-deliveries"] });
  };
}

function EndpointDialog({ webhook, onClose }: { webhook?: Webhook; onClose: () => void }) {
  const refresh = useRefreshWebhooks();
  const [url, setUrl] = useState(webhook?.url ?? "");
  const [events, setEvents] = useState<Set<string>>(new Set(webhook?.events ?? []));
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const id = useId();
  const title = webhook ? "Edit endpoint" : "Add endpoint";
  const save = useMutation({
    mutationFn: async () => {
      if (webhook) {
        await updateWebhook(webhook.id, url, [...events], enabled);
        return null;
      }
      return createWebhook(url, [...events]);
    },
    onSuccess: (created) => {
      refresh();
      if (!created) onClose();
    },
  });
  const created = save.data ?? null;

  const toggle = (type: string, on: boolean) =>
    setEvents((prev) => {
      const next = new Set(prev);
      if (on) next.add(type);
      else next.delete(type);
      return next;
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
          if (created) onClose();
          else if (!save.isPending) save.mutate();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        {created ? (
          <SecretField
            id={`${id}-secret`}
            label={`Signing secret for ${created.url}`}
            secret={created.secret}
          />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-url`}>Endpoint URL</Label>
              <Input
                id={`${id}-url`}
                type="url"
                value={url}
                maxLength={2000}
                placeholder="https://example.com/ai-proctor"
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-medium">Events to send</legend>
              <div className="rounded-lg border border-line">
                {webhookEvents.map((e) => (
                  <label
                    key={e.type}
                    className="flex h-10 cursor-pointer items-center gap-3 border-b border-line px-3 text-sm last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={events.has(e.type)}
                      onChange={(ev) => toggle(e.type, ev.target.checked)}
                    />
                    {e.label}
                    <code className="ml-auto font-mono text-xs text-ink3">{e.type}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            {webhook && (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Send events to this endpoint
              </label>
            )}
            {webhook?.disabledReason === "failing" && !webhook.enabled && (
              <p className="text-xs text-ink3">
                It was turned off after 5 failed events in a row. Turn it back on once the receiver
                works.
              </p>
            )}
          </>
        )}
        {save.error && (
          <p role="alert" className="text-sm text-warnink">
            {save.error.message}
          </p>
        )}
        <div className="flex gap-2">
          {created ? (
            <Button type="submit" className="ml-auto">
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!url.trim() || events.size === 0 || save.isPending}>
                {save.isPending ? "Saving…" : webhook ? "Save" : "Add endpoint"}
              </Button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

function RotateDialog({ webhook, onClose }: { webhook: Webhook; onClose: () => void }) {
  const refresh = useRefreshWebhooks();
  const id = useId();
  const rotate = useMutation({ mutationFn: () => rotateSecret(webhook.id), onSuccess: refresh });
  const secret = rotate.data ?? null;

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
          if (secret) onClose();
          else if (!rotate.isPending) rotate.mutate();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          Rotate the signing secret?
        </h2>
        {secret ? (
          <SecretField
            id={`${id}-secret`}
            label={`New signing secret for ${webhook.url}`}
            secret={secret}
          />
        ) : (
          <p className="text-sm text-ink2">
            Events to <span className="break-all font-mono text-[12.5px]">{webhook.url}</span> are
            signed with a new secret from now on, and the old one stops working. Update your
            receiver; events it refuses in the meantime are retried.
          </p>
        )}
        {rotate.error && (
          <p role="alert" className="text-sm text-warnink">
            {rotate.error.message}
          </p>
        )}
        <div className="flex gap-2">
          {secret ? (
            <Button type="submit" className="ml-auto">
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={rotate.isPending}>
                {rotate.isPending ? "Rotating…" : "Rotate secret"}
              </Button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

function DeleteDialog({ webhook, onClose }: { webhook: Webhook; onClose: () => void }) {
  const refresh = useRefreshWebhooks();
  const id = useId();
  const remove = useMutation({
    mutationFn: () => deleteWebhook(webhook.id),
    onSuccess: () => {
      refresh();
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
          if (!remove.isPending) remove.mutate();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          Delete this endpoint?
        </h2>
        <p className="text-sm text-ink2">
          <span className="break-all font-mono text-[12.5px]">{webhook.url}</span> stops getting
          events at once, and its delivery log is deleted. This can't be undone.
        </p>
        {remove.error && (
          <p role="alert" className="text-sm text-warnink">
            {remove.error.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={remove.isPending}>
            {remove.isPending ? "Deleting…" : "Delete endpoint"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
