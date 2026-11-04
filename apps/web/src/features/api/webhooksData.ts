// Webhook endpoints and their delivery log (#320, API-06). The signing secret comes back only
// from createWebhook and rotateSecret; the database keeps it in Vault for signing and never
// returns it again. Creating, changing, deleting and rotating are audit-logged by the
// database.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { explainWebhook } from "./webhookText";

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  /** "admin" (an admin turned it off) or "failing" (5 deliveries in a row failed). */
  disabledReason: string | null;
  disabledAt: string | null;
  createdAt: string;
  createdBy: string | null;
  secretRotatedAt: string | null;
  lastDeliveryAt: string | null;
  pending: number;
}

export interface Delivery {
  id: string;
  webhookId: string;
  url: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
}

export interface CreatedWebhook {
  id: string;
  url: string;
  secret: string;
}

export const webhooksQuery = queryOptions({
  queryKey: ["webhooks"],
  queryFn: async (): Promise<Webhook[]> => {
    const { data, error } = await supabase.rpc("list_webhooks");
    if (error) throw new Error(explainWebhook(error.message));
    // Generated types mark every returned column non-null; these may be null.
    return data.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      enabled: w.enabled,
      disabledReason: (w.disabled_reason as string | null) ?? null,
      disabledAt: (w.disabled_at as string | null) ?? null,
      createdAt: w.created_at,
      createdBy: (w.created_by_name as string | null) ?? null,
      secretRotatedAt: (w.secret_rotated_at as string | null) ?? null,
      lastDeliveryAt: (w.last_delivery_at as string | null) ?? null,
      pending: w.pending,
    }));
  },
});

/** The newest 100 deliveries: one endpoint's, or every endpoint's when webhookId is null. */
export const deliveriesQuery = (webhookId: string | null) =>
  queryOptions({
    queryKey: ["webhook-deliveries", webhookId],
    queryFn: async (): Promise<Delivery[]> => {
      const { data, error } = await supabase.rpc("list_webhook_deliveries", {
        ...(webhookId ? { p_webhook_id: webhookId } : {}),
        p_limit: 100,
      });
      if (error) throw new Error(explainWebhook(error.message));
      return data.map((d) => ({
        id: d.id,
        webhookId: d.webhook_id,
        url: d.url,
        eventId: d.event_id,
        eventType: d.event_type,
        status: d.status,
        attempts: d.attempts,
        responseStatus: (d.response_status as number | null) ?? null,
        lastError: (d.last_error as string | null) ?? null,
        nextAttemptAt: (d.next_attempt_at as string | null) ?? null,
        lastAttemptAt: (d.last_attempt_at as string | null) ?? null,
        createdAt: d.created_at,
      }));
    },
  });

export async function createWebhook(url: string, events: string[]): Promise<CreatedWebhook> {
  const { data, error } = await supabase.rpc("create_webhook", { p_url: url, p_events: events });
  if (error) throw new Error(explainWebhook(error.message));
  const row = data[0];
  if (!row) throw new Error("The endpoint wasn't added. Try again.");
  return { id: row.id, url: row.url, secret: row.secret };
}

export async function updateWebhook(id: string, url: string, events: string[], enabled: boolean) {
  const { error } = await supabase.rpc("update_webhook", {
    p_id: id,
    p_url: url,
    p_events: events,
    p_enabled: enabled,
  });
  if (error) throw new Error(explainWebhook(error.message));
}

export async function deleteWebhook(id: string) {
  const { error } = await supabase.rpc("delete_webhook", { p_id: id });
  if (error) throw new Error(explainWebhook(error.message));
}

/** A new signing secret, shown once. */
export async function rotateSecret(id: string): Promise<string> {
  const { data, error } = await supabase.rpc("rotate_webhook_secret", { p_id: id });
  if (error) throw new Error(explainWebhook(error.message));
  return data;
}
