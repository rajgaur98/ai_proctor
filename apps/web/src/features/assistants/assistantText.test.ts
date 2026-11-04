import { describe, expect, it } from "vitest";
import { explainAccessError, noticeOutcome, returnHost, safeReturnPath } from "./assistantText";

describe("safeReturnPath", () => {
  it("keeps a path in this dashboard", () => {
    expect(safeReturnPath("/oauth/consent?authorization_id=abc")).toBe(
      "/oauth/consent?authorization_id=abc",
    );
  });
  it("refuses anything that could leave it", () => {
    for (const bad of ["https://evil.test/", "//evil.test", "/\\evil.test", "evil", "", null, 3]) {
      expect(safeReturnPath(bad)).toBeNull();
    }
  });
});

describe("returnHost", () => {
  it("shows the host the assistant returns to", () => {
    expect(returnHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(returnHost("http://localhost:6274/oauth/callback")).toBe("localhost:6274");
  });
  it("keeps a custom scheme visible", () => {
    expect(returnHost("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(
      "cursor://anysphere.cursor-mcp",
    );
  });
  it("falls back to the text", () => {
    expect(returnHost("not a url")).toBe("not a url");
  });
});

describe("noticeOutcome", () => {
  it("says a new notice version was published", () => {
    expect(noticeOutcome({ enabled: true, notice_version: 7, notice_edited: false })).toBe(
      "AI assistant access is on. Monitoring notice version 7 was published to say so; everyone acknowledges it again.",
    );
  });
  it("asks for an edited notice to be updated", () => {
    expect(noticeOutcome({ enabled: false, notice_version: null, notice_edited: true })).toMatch(
      /^AI assistant access is off\. Your monitoring notice has your own text/,
    );
  });
  it("says only the state otherwise", () => {
    expect(noticeOutcome({ enabled: true, notice_version: null, notice_edited: false })).toBe(
      "AI assistant access is on.",
    );
  });
});

describe("explainAccessError", () => {
  it("explains refusals", () => {
    expect(explainAccessError("admin_only")).toBe("Only owners and admins can change this.");
    expect(explainAccessError("mfa_required")).toMatch(/authenticator/);
    expect(explainAccessError("boom")).toBe("boom");
  });
});
