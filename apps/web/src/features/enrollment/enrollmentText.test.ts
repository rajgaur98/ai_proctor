import { describe, expect, it } from "vitest";
import { deviceCount, explain, tokenStatus } from "./enrollmentText";

describe("enrollment tokens", () => {
  it("reads a token as active until it is revoked", () => {
    expect(tokenStatus({ revokedAt: null })).toBe("Active");
    expect(tokenStatus({ revokedAt: "2026-10-22T10:00:00Z" })).toBe("Revoked");
  });

  it("counts devices", () => {
    expect(deviceCount(0)).toBe("0 devices");
    expect(deviceCount(1)).toBe("1 device");
    expect(deviceCount(12)).toBe("12 devices");
  });

  it("explains the server's refusals and passes anything else through", () => {
    expect(explain("invalid_label")).toMatch(/80 characters/);
    expect(explain("admin_only")).toMatch(/owners and admins/);
    expect(explain("something new")).toBe("something new");
  });
});
