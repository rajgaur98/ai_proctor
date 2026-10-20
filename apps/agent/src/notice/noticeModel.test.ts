import type { NoticeBody, NoticeContent } from "@ai-proctor/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_INTRO, noticeFooter, noticeIntro, noticeRows } from "./noticeModel";

const body: NoticeBody = {
  collected: "A screenshot when you pass a check-in.",
  when: "Only while clocked in.",
  who: "Your direct manager and admins.",
  retention: "Images are deleted after 30 days.",
  rights: "See and export everything from My data.",
};

describe("noticeRows", () => {
  it("lists the five sections in the design's order", () => {
    expect(noticeRows(body).map((r) => r.label)).toEqual([
      "What's collected",
      "When",
      "Who can see it",
      "How long it's kept",
      "Your rights",
    ]);
  });

  it("adds the grievance contact when the notice has one", () => {
    const rows = noticeRows({ ...body, grievance: "Contact your admin." });
    expect(rows.at(-1)).toEqual({
      key: "grievance",
      label: "Questions and complaints",
      text: "Contact your admin.",
    });
  });

  it("skips a section that is blank", () => {
    expect(noticeRows({ ...body, grievance: "   " })).toHaveLength(5);
  });
});

describe("noticeIntro", () => {
  it("uses the org's introduction", () => {
    expect(noticeIntro({ ...body, intro: " Acme uses AI Proctor. " })).toBe(
      "Acme uses AI Proctor.",
    );
  });
  it("falls back to a plain line", () => {
    expect(noticeIntro(body)).toBe(DEFAULT_INTRO);
    expect(noticeIntro({ ...body, intro: "" })).toBe(DEFAULT_INTRO);
  });
});

describe("noticeFooter", () => {
  const content: NoticeContent = { version: 3, acknowledged: false, body };
  it("offers the button until the version is acknowledged", () => {
    expect(noticeFooter(content)).toEqual({ text: "Version 3", canAcknowledge: true });
    expect(noticeFooter({ ...content, acknowledged: true })).toEqual({
      text: "Version 3 · acknowledged",
      canAcknowledge: false,
    });
  });
});
