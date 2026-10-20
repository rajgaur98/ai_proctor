// Monitoring notice (#48, AGT-04/05, ADM-06, EMP-05). Everyone sees the version they
// acknowledged (the tray's "Monitoring notice" link opens this page); owners and
// admins also edit the text, publish a new version and see the history.
import type { NoticeBody } from "@ai-proctor/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { membersQuery } from "../people/members";
import { AckReport } from "./AckReport";
import { DateTimeText, NoticeView } from "./NoticeView";
import {
  type Ack,
  ackReportQuery,
  acksQuery,
  type Notice,
  type NoticeSection,
  noticeSections,
  noticesQuery,
  noticeTemplate,
  publishNotice,
} from "./noticeData";

export function NoticePage() {
  const { profile } = useRouteContext({ from: "/_app" });
  const notices = useQuery(noticesQuery);
  const acks = useQuery(acksQuery);
  const isAdmin = profile.role === "owner" || profile.role === "admin";
  const error = notices.error ?? acks.error;

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">Monitoring notice</h1>
        <p className="mt-1 text-[13.5px] text-ink2">{profile.orgName}</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load the notice: {error.message}
        </p>
      ) : !notices.data || !acks.data ? (
        <p className="text-sm text-ink2">Loading…</p>
      ) : (
        <>
          <MyNotice notices={notices.data} acks={acks.data} userId={profile.id} />
          {isAdmin && <NoticeEditor notices={notices.data} />}
          {isAdmin && notices.data[0] && <AckReport currentVersion={notices.data[0].version} />}
          {isAdmin && <History notices={notices.data} acks={acks.data} />}
        </>
      )}
    </section>
  );
}

/** EMP-05: the version this person acknowledged, and the current one if it differs. */
function MyNotice({ notices, acks, userId }: { notices: Notice[]; acks: Ack[]; userId: string }) {
  const current = notices[0];
  const mine = acks.filter((a) => a.userId === userId);
  const acknowledged = notices
    .filter((n) => mine.some((a) => a.noticeId === n.id))
    .sort((a, b) => b.version - a.version)[0];
  const at = acknowledged && mine.find((a) => a.noticeId === acknowledged.id)?.acknowledgedAt;

  if (!current) return <p className="text-sm text-ink2">No notice has been published yet.</p>;
  return (
    <div className="flex flex-col gap-5">
      {acknowledged && at ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5">
          <h2 className="text-base font-semibold">
            What you acknowledged{" "}
            <span className="font-normal text-ink3">· version {acknowledged.version}</span>
          </h2>
          <p className="text-[13.5px] text-ink2">
            You acknowledged this on <DateTimeText iso={at} />.
          </p>
          <NoticeView body={acknowledged.body} />
        </div>
      ) : (
        <p
          role="status"
          className="rounded-xl border border-warnline bg-warnbg p-4 text-[13.5px] text-warnink"
        >
          You haven't acknowledged a notice yet. Open the AI Proctor app to read and acknowledge it;
          nothing is collected before that.
        </p>
      )}
      {acknowledged?.id !== current.id && (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5">
          <h2 className="text-base font-semibold">
            Current notice{" "}
            <span className="font-normal text-ink3">· version {current.version}</span>
          </h2>
          <p className="text-[13.5px] text-ink2">
            Published <DateTimeText iso={current.publishedAt} />.{" "}
            {acknowledged
              ? "Open the AI Proctor app to review and acknowledge it. Until then, what is collected stays as you acknowledged it."
              : ""}
          </p>
          <NoticeView body={current.body} />
        </div>
      )}
    </div>
  );
}

const fieldHints: Partial<Record<NoticeSection, string>> = {
  grievance: "Optional. Under India's DPDP Act, name a grievance contact here.",
  intro: "Optional. Who runs the monitoring and why.",
};

/** ADM-06: edit the latest text and publish it as the next version. */
function NoticeEditor({ notices }: { notices: Notice[] }) {
  const id = useId();
  const queryClient = useQueryClient();
  const latest = notices[0];
  const [draft, setDraft] = useState<Record<string, string>>(() => toDraft(latest?.body));
  const [published, setPublished] = useState<number | null>(null);

  const reset = useMutation({
    mutationFn: noticeTemplate,
    onSuccess: (body) => {
      setPublished(null);
      setDraft(toDraft(body));
    },
  });
  const publish = useMutation({
    mutationFn: () => publishNotice(fromDraft(draft)),
    onSuccess: (version) => {
      setPublished(version);
      queryClient.invalidateQueries({ queryKey: noticesQuery.queryKey });
      queryClient.invalidateQueries({ queryKey: acksQuery.queryKey });
      queryClient.invalidateQueries({ queryKey: ackReportQuery.queryKey });
    },
  });
  const complete = noticeSections
    .filter((s) => s.required)
    .every((s) => (draft[s.key] ?? "").trim().length > 0);

  return (
    <form
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setPublished(null);
        publish.mutate();
      }}
    >
      <div>
        <h2 className="text-base font-semibold">Edit the notice</h2>
        <p className="mt-1 text-[13px] text-ink2">
          Publishing creates a new version. Everyone has to acknowledge it before it applies to
          them. A change to what is collected in Policy publishes a new version too; review the
          wording when that happens.
        </p>
      </div>
      {[{ key: "intro", label: "Introduction", required: false }, ...noticeSections].map((s) => (
        <div key={s.key} className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-${s.key}`}>{s.label}</Label>
          <textarea
            id={`${id}-${s.key}`}
            rows={s.key === "collected" ? 5 : 3}
            maxLength={4000}
            required={s.required}
            value={draft[s.key] ?? ""}
            onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
            className="w-full rounded-[9px] border border-line2 bg-panel px-3 py-2.5 text-sm leading-[1.4] text-ink"
          />
          {fieldHints[s.key as NoticeSection] && (
            <p className="text-xs text-ink3">{fieldHints[s.key as NoticeSection]}</p>
          )}
        </div>
      ))}
      <p className="text-xs text-ink3">
        The templates are a starting point. Have a privacy lawyer review the wording before you rely
        on it.
      </p>
      {(publish.error || reset.error) && (
        <p role="alert" className="text-sm text-warnink">
          {(publish.error ?? reset.error)?.message}
        </p>
      )}
      {published !== null && (
        <p role="status" className="text-sm text-ink">
          Published version {published}. Everyone will be asked to acknowledge it.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          className="ml-auto"
          disabled={reset.isPending}
          onClick={() => reset.mutate()}
        >
          Start from the template
        </Button>
        <Button type="submit" disabled={!complete || publish.isPending}>
          {publish.isPending ? "Publishing…" : "Publish new version"}
        </Button>
      </div>
    </form>
  );
}

function toDraft(body: NoticeBody | undefined): Record<string, string> {
  return {
    intro: body?.intro ?? "",
    collected: body?.collected ?? "",
    when: body?.when ?? "",
    who: body?.who ?? "",
    retention: body?.retention ?? "",
    rights: body?.rights ?? "",
    grievance: body?.grievance ?? "",
  };
}

/** Blank optional sections are left out of the notice. */
function fromDraft(draft: Record<string, string>): NoticeBody {
  const text = (k: string) => (draft[k] ?? "").trim();
  return {
    ...(text("intro") && { intro: text("intro") }),
    collected: text("collected"),
    when: text("when"),
    who: text("who"),
    retention: text("retention"),
    rights: text("rights"),
    ...(text("grievance") && { grievance: text("grievance") }),
  };
}

/** Versions with who published them, when and how many people have acknowledged. */
function History({ notices, acks }: { notices: Notice[]; acks: Ack[] }) {
  const members = useQuery(membersQuery).data ?? [];
  const active = new Set(members.filter((m) => m.active).map((m) => m.id));
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5">
      <h2 className="text-base font-semibold">Version history</h2>
      <ul className="flex flex-col divide-y divide-line">
        {notices.map((n) => {
          const count = new Set(
            acks.filter((a) => a.noticeId === n.id && active.has(a.userId)).map((a) => a.userId),
          ).size;
          return (
            <li key={n.id} className="py-3 first:pt-0 last:pb-0">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 text-[13.5px]">
                  <span className="font-semibold">Version {n.version}</span>
                  <span className="text-ink2">
                    <DateTimeText iso={n.publishedAt} />
                  </span>
                  <span className="text-ink2">{n.publishedBy ?? "System"}</span>
                  <span className="text-ink3">
                    {count} of {active.size} acknowledged
                  </span>
                </summary>
                <div className="mt-3">
                  <NoticeView body={n.body} />
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
