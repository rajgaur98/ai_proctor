// The monitoring notice (#48; AGT-04, AGT-05): step 1 of the Onboarding design. The text
// comes from the Rust core; "I've read this" (in the footer, OnboardingWindow.tsx) sends
// the version on screen, and the core refuses it if a newer one has arrived meanwhile.
import type { NoticeContent } from "@ai-proctor/contracts";
import { noticeIntro, noticeRows } from "./noticeModel";

export function NoticeStep({ content }: { content: NoticeContent | null | undefined }) {
  // undefined: loading; null: the server hasn't sent a notice.
  if (content === undefined) return <p className="n-state">Loading…</p>;
  if (content === null) return <p className="n-state">There is no notice to review yet.</p>;
  return (
    <>
      <header>
        <h1>Monitoring notice</h1>
        <p className="n-intro">{noticeIntro(content.body)}</p>
      </header>
      <dl className="n-table">
        {noticeRows(content.body).map((row) => (
          <div className="n-row" key={row.key}>
            <dt>{row.label}</dt>
            <dd>{row.text}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
