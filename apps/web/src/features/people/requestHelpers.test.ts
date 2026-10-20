import { describe, expect, it } from "vitest";
import { emailConfirmed, rowsRemoved } from "./requestHelpers";

describe("emailConfirmed", () => {
  it("accepts the person's email in any case, with stray spaces", () => {
    expect(emailConfirmed("  Erin@Acme.test ", "erin@acme.test")).toBe(true);
  });
  it("refuses anything else", () => {
    expect(emailConfirmed("", "erin@acme.test")).toBe(false);
    expect(emailConfirmed("erin", "erin@acme.test")).toBe(false);
    expect(emailConfirmed("lucas@acme.test", "erin@acme.test")).toBe(false);
  });
});

describe("rowsRemoved", () => {
  it("adds up the counts", () => {
    expect(rowsRemoved({ devices: 1, checkin_events: 4, alerts: 0 })).toBe(5);
    expect(rowsRemoved({})).toBe(0);
  });
});
