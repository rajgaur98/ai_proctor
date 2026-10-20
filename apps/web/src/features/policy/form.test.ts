import { describe, expect, it } from "vitest";
import { applyPreset, canSave, changedKeys, confirmationsNeeded, pick, validate } from "./form";
import { eu, us } from "./testPolicies";

describe("validate", () => {
  it("returns the policy when it is valid", () => {
    expect(validate(eu, "eu").data).toEqual(eu);
  });

  it("names the first problem per key", () => {
    const r = validate({ ...us, checkin_response_s: 20, idle_threshold_min: Number.NaN }, "us");
    expect(r.data).toBeNull();
    expect(r.errors).toEqual({
      checkin_response_s: "Enter a whole number from 30 to 300",
      idle_threshold_min: "Enter a whole number from 3 to 60",
    });
  });

  it("flags a longest interval below the shortest on the longest", () => {
    expect(
      validate({ ...us, checkin_min_interval_min: 100, checkin_max_interval_min: 60 }, "us").errors,
    ).toEqual({ checkin_max_interval_min: "Must be at least the shortest interval" });
  });

  it("refuses more than 30 days of images in an EU org, whatever the draft's preset", () => {
    expect(validate({ ...us, image_retention_days: 60 }, "eu").errors).toEqual({
      image_retention_days: "EU organisations keep images 30 days at most",
    });
    expect(validate({ ...us, image_retention_days: 60 }, "us").errors).toBeNull();
  });

  it("takes an empty daily break limit", () => {
    expect(validate({ ...us, break_daily_max_min: null }, "us").errors).toBeNull();
    expect(validate({ ...us, break_daily_max_min: Number.NaN }, "us").errors).toEqual({
      break_daily_max_min: "Enter a whole number from 1 to 1440",
    });
  });
});

describe("reminders_enabled (#177)", () => {
  it("is a switch: either value is valid, anything else is not", () => {
    expect(validate({ ...us, reminders_enabled: false }, "us").errors).toBeNull();
    expect(validate({ ...us, reminders_enabled: "no" as unknown as boolean }, "us").errors).toEqual(
      { reminders_enabled: "Invalid input: expected boolean, received string" },
    );
  });

  it("shows as a change, and is the only one", () => {
    expect(changedKeys(us, { ...us, reminders_enabled: false })).toEqual(["reminders_enabled"]);
  });

  it("is filled from the preset, which has reminders on", () => {
    expect(applyPreset({ ...us, reminders_enabled: false }, eu).reminders_enabled).toBe(true);
  });
});

describe("changedKeys and pick", () => {
  it("lists the keys that differ, including list values", () => {
    const draft = { ...us, webcam: false, excluded_apps: ["1Password"] };
    expect(changedKeys(us, draft)).toEqual(["webcam", "excluded_apps"]);
    expect(changedKeys(us, { ...us, excluded_apps: [...us.excluded_apps] })).toEqual([]);
  });

  it("picks only those keys", () => {
    expect(pick({ ...us, webcam: false }, ["webcam"])).toEqual({ webcam: false });
  });
});

describe("applyPreset", () => {
  it("fills the form from the preset", () => {
    const filled = applyPreset({ ...us, auto_clock_in: true }, eu);
    expect(filled).toEqual(eu);
    expect(filled.excluded_apps).not.toBe(eu.excluded_apps);
  });

  it("leaves admin two-factor as it was", () => {
    expect(applyPreset({ ...us, require_admin_mfa: true }, eu).require_admin_mfa).toBe(true);
  });
});

describe("confirmationsNeeded (CAP-05)", () => {
  const eu0 = { region_preset: "eu" as const, webcam_confirmed: false, works_council_members: 0 };

  it("needs the DPIA when the webcam is on in an EU org that hasn't confirmed one", () => {
    expect(confirmationsNeeded(eu0, { webcam: true })).toEqual({ dpia: true, worksCouncil: false });
    expect(confirmationsNeeded(eu0, { webcam: false })).toEqual({
      dpia: false,
      worksCouncil: false,
    });
  });

  it("also needs the works council where someone works in a country that has one", () => {
    expect(confirmationsNeeded({ ...eu0, works_council_members: 2 }, { webcam: true })).toEqual({
      dpia: true,
      worksCouncil: true,
    });
  });

  it("needs nothing once the stored policy has the webcam on, or outside the EU", () => {
    expect(confirmationsNeeded({ ...eu0, webcam_confirmed: true }, { webcam: true }).dpia).toBe(
      false,
    );
    for (const region of ["us", "india"] as const) {
      expect(
        confirmationsNeeded(
          { ...eu0, region_preset: region, works_council_members: 3 },
          { webcam: true },
        ),
      ).toEqual({ dpia: false, worksCouncil: false });
    }
  });
});

describe("canSave", () => {
  const base = {
    valid: true,
    dirty: true,
    needed: { dpia: false, worksCouncil: false },
    confirmed: { dpia: false, worksCouncil: false },
  };

  it("needs a valid, changed policy", () => {
    expect(canSave(base)).toBe(true);
    expect(canSave({ ...base, valid: false })).toBe(false);
    expect(canSave({ ...base, dirty: false })).toBe(false);
  });

  it("waits for each confirmation that is needed", () => {
    const needed = { dpia: true, worksCouncil: true };
    expect(canSave({ ...base, needed })).toBe(false);
    expect(canSave({ ...base, needed, confirmed: { dpia: true, worksCouncil: false } })).toBe(
      false,
    );
    expect(canSave({ ...base, needed, confirmed: { dpia: true, worksCouncil: true } })).toBe(true);
  });
});
