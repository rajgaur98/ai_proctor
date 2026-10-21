import { describe, expect, it } from "vitest";
import { noticePreview } from "./preview";
import { eu, us } from "./testPolicies";

const text = (p: Parameters<typeof noticePreview>[0], label: string) =>
  noticePreview(p).find((r) => r.label === label)?.text;

describe("noticePreview", () => {
  it("describes the check-ins", () => {
    expect(text(eu, "Check-ins")).toBe(
      "Every 45 to 120 min while clocked in, at random times. 90 s to respond.",
    );
    expect(
      text({ ...us, checkin_min_interval_min: 30, checkin_max_interval_min: 30 }, "Check-ins"),
    ).toMatch(/^Every 30 min while/);
  });

  it("lists what a passed check-in captures", () => {
    expect(text(us, "On a passed check-in")).toBe(
      "A screenshot of each screen and one webcam frame.",
    );
    expect(text({ ...us, screenshots: "blurred", webcam: false }, "On a passed check-in")).toBe(
      "A blurred screenshot of each screen.",
    );
    expect(text({ ...us, screenshots: "off" }, "On a passed check-in")).toBe("One webcam frame.");
    expect(text({ ...us, screenshots: "off", webcam: false }, "On a passed check-in")).toBe(
      "Nothing but the time of the check-in.",
    );
  });

  it("says when the webcam frame is checked for a face (CAP-07), and only with the webcam", () => {
    expect(text({ ...us, face_presence: true }, "On a passed check-in")).toBe(
      "A screenshot of each screen and one webcam frame. The webcam frame is checked on their computer for whether a face is in view (detection only, nobody is identified); only yes or no is kept.",
    );
    expect(text({ ...us, face_presence: true, webcam: false }, "On a passed check-in")).toBe(
      "A screenshot of each screen.",
    );
  });

  it("follows window titles and activity sampling", () => {
    expect(text(us, "App activity")).toMatch(/and window titles\.$/);
    expect(text(eu, "App activity")).not.toMatch(/window titles/);
    expect(text({ ...us, activity_sampling: false }, "App activity")).toBe("Not recorded.");
  });

  it("shows excluded apps only when there are some", () => {
    expect(text(us, "Excluded apps")).toBe(
      "1Password, Bitwarden: never shown in screenshots, no window titles.",
    );
    expect(text({ ...us, excluded_apps: [] }, "Excluded apps")).toBeUndefined();
  });

  it("states retention, breaks and pauses", () => {
    expect(text({ ...us, image_retention_days: 14 }, "Kept for")).toBe(
      "Images 14 days. Time records with timesheets.",
    );
    expect(text({ ...us, screenshots: "off", webcam: false }, "Kept for")).toBe(
      "Time records with timesheets.",
    );
    expect(text(us, "Breaks")).toBe("Unpaid.");
    expect(text({ ...us, breaks_paid: true, break_daily_max_min: 45 }, "Breaks")).toBe(
      "Paid, up to 45 min per day.",
    );
    expect(text(us, "Pauses")).toBe("Up to 15 min each, 60 min per day.");
  });

  it("copes with a number still being typed", () => {
    expect(text({ ...us, checkin_response_s: Number.NaN }, "Check-ins")).toMatch(/… s to respond/);
  });
});
