import type { NoticeBody } from "@ai-proctor/contracts";
import { DateTime } from "luxon";
import { cn } from "../../lib/cn";
import { noticeSections } from "./noticeData";

/** "20 Oct 2026, 14:03" in the viewer's zone. */
export function DateTimeText({ iso }: { iso: string }) {
  return <time dateTime={iso}>{DateTime.fromISO(iso).toFormat("d LLL yyyy, HH:mm")}</time>;
}

/** The notice as the agent shows it: an intro and the labelled sections. */
export function NoticeView({ body }: { body: NoticeBody }) {
  const sections = noticeSections.filter(({ key }) => body[key]);
  return (
    <div className="flex flex-col gap-4">
      {body.intro && <p className="text-[13.5px] leading-[1.45] text-ink2">{body.intro}</p>}
      <dl className="grid grid-cols-1 overflow-hidden rounded-[10px] border border-line text-[13.5px] leading-[1.4] md:grid-cols-[170px_minmax(0,1fr)]">
        {sections.map(({ key, label }, i) => (
          <div key={key} className="contents">
            <dt
              className={cn("bg-sunk px-3.5 py-2.5 font-semibold", i > 0 && "border-t border-line")}
            >
              {label}
            </dt>
            <dd className={cn("px-3.5 py-2.5 text-ink2", i > 0 && "md:border-t md:border-line")}>
              {body[key]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
