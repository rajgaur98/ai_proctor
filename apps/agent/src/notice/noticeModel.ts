// Pure helpers for the notice window (#48, rendered by NoticeWindow.tsx).
import type { NoticeBody, NoticeContent } from "@ai-proctor/contracts";

/** The sections in the order of the Onboarding design's first step. */
const sectionLabels = [
  { key: "collected", label: "What's collected" },
  { key: "when", label: "When" },
  { key: "who", label: "Who can see it" },
  { key: "retention", label: "How long it's kept" },
  { key: "rights", label: "Your rights" },
  { key: "grievance", label: "Questions and complaints" },
] as const;

export interface NoticeRow {
  key: string;
  label: string;
  text: string;
}

/** The rows to show; optional sections the admin left out are skipped. */
export function noticeRows(body: NoticeBody): NoticeRow[] {
  return sectionLabels.flatMap(({ key, label }) => {
    const text = body[key]?.trim();
    return text ? [{ key, label, text }] : [];
  });
}

export const DEFAULT_INTRO = "Here is exactly what AI Proctor collects about you.";

/** The line under the title: the org's introduction, or a plain default. */
export function noticeIntro(body: NoticeBody): string {
  return body.intro?.trim() || DEFAULT_INTRO;
}

/** What the footer says and whether the button is there. */
export function noticeFooter(content: NoticeContent): { text: string; canAcknowledge: boolean } {
  return content.acknowledged
    ? { text: `Version ${content.version} · acknowledged`, canAcknowledge: false }
    : { text: `Version ${content.version}`, canAcknowledge: true };
}
