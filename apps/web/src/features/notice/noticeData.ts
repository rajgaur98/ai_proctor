import { NoticeBody } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export interface Notice {
  id: string;
  version: number;
  region: string;
  body: NoticeBody;
  publishedAt: string;
  /** Null for the template version and for versions a policy change published. */
  publishedBy: string | null;
}

/** Every version of the org's notice, newest first (everyone in the org may read them). */
export const noticesQuery = queryOptions({
  queryKey: ["notices"],
  queryFn: async (): Promise<Notice[]> => {
    const { data, error } = await supabase
      .from("notices")
      .select(
        "id, version, region, body, published_at, published_by, users:published_by(full_name)",
      )
      .order("version", { ascending: false });
    if (error) throw error;
    return data.flatMap((n) => {
      const body = NoticeBody.safeParse(n.body);
      if (!body.success) return [];
      return [
        {
          id: n.id,
          version: n.version,
          region: n.region,
          body: body.data,
          publishedAt: n.published_at,
          publishedBy: n.users?.full_name ?? null,
        },
      ];
    });
  },
});

export interface Ack {
  userId: string;
  noticeId: string;
  acknowledgedAt: string;
}

/** Acknowledgements the viewer may see: their own, plus their reports' (admins: everyone's). */
export const acksQuery = queryOptions({
  queryKey: ["notice-acks"],
  queryFn: async (): Promise<Ack[]> => {
    const { data, error } = await supabase
      .from("notice_acks")
      .select("user_id, notice_id, acknowledged_at");
    if (error) throw error;
    return data.map((a) => ({
      userId: a.user_id,
      noticeId: a.notice_id,
      acknowledgedAt: a.acknowledged_at,
    }));
  },
});

/** The org's template for its region, filled from its policy (ADM-06). */
export async function noticeTemplate(): Promise<NoticeBody> {
  const { data, error } = await supabase.rpc("notice_template");
  if (error) throw new Error(explain(error.message));
  return NoticeBody.parse(data);
}

/** Publishes the next version; everyone has to acknowledge it. Returns its number. */
export async function publishNotice(body: NoticeBody): Promise<number> {
  const { data, error } = await supabase.rpc("publish_notice", { p_body: body });
  if (error) throw new Error(explain(error.message));
  return data;
}

const messages: Record<string, string> = {
  admin_only: "Only admins can publish the notice.",
  invalid_notice: "Fill in every section (up to 4000 characters each).",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}

/** The sections in the order the design shows them, with their labels. */
export const noticeSections = [
  { key: "collected", label: "What's collected", required: true },
  { key: "when", label: "When", required: true },
  { key: "who", label: "Who can see it", required: true },
  { key: "retention", label: "How long it's kept", required: true },
  { key: "rights", label: "Your rights", required: true },
  { key: "grievance", label: "Questions and complaints", required: false },
] as const;

export type NoticeSection = (typeof noticeSections)[number]["key"] | "intro";
