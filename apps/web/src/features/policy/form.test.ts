import { describe, expect, it } from "vitest";
import {
  applyPreset,
  canSave,
  changedKeys,
  confirmationsNeeded,
  facePresenceNote,
  listText,
  pick,
  validate,
} from "./form";
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

describe("face presence (CAP-07)", () => {
  const us0 = {
    face_presence_available: true,
    biometric_law_places: [
      "Colorado",
      "Illinois",
      "Texas",
      "Washington",
      "the European Economic Area",
    ],
    biometric_law_members: 2,
  };

  it("is a switch an organisation outside the EU can turn on", () => {
    expect(validate({ ...us, face_presence: true }, "us").errors).toBeNull();
    expect(validate({ ...us, face_presence: true }, "india").errors).toBeNull();
    expect(changedKeys(us, { ...us, face_presence: true })).toEqual(["face_presence"]);
    expect(pick({ ...us, face_presence: true }, ["face_presence"])).toEqual({
      face_presence: true,
    });
  });

  it("can't be on in an EU organisation, whatever the draft's preset", () => {
    expect(validate({ ...us, face_presence: true }, "eu").errors).toEqual({
      face_presence: "Face presence detection isn't available to EU organisations",
    });
    expect(validate({ ...eu, face_presence: false }, "eu").errors).toBeNull();
  });

  it("is off in every preset, so applying one switches it off", () => {
    expect(applyPreset({ ...us, face_presence: true }, us).face_presence).toBe(false);
    expect(applyPreset({ ...us, face_presence: true }, eu).face_presence).toBe(false);
  });

  it("says where it is always off and how many people work there", () => {
    expect(facePresenceNote(us0, { face_presence: false, webcam: true })).toBe(
      "Always off for people who work in Colorado, Illinois, Texas, Washington and the European Economic Area, where biometric privacy laws apply (2 people work there now).",
    );
    expect(
      facePresenceNote({ ...us0, biometric_law_members: 1 }, { face_presence: true, webcam: true }),
    ).toMatch(/\(1 person works there now\)\.$/);
    expect(
      facePresenceNote({ ...us0, biometric_law_members: 0 }, { face_presence: true, webcam: true }),
    ).toMatch(/apply\.$/);
  });

  it("notes that it needs the webcam frame", () => {
    expect(facePresenceNote(us0, { face_presence: true, webcam: false })).toMatch(
      /It only runs while the webcam frame is on\.$/,
    );
  });

  it("explains why an EU organisation can't use it", () => {
    expect(
      facePresenceNote(
        { ...us0, face_presence_available: false },
        { face_presence: false, webcam: true },
      ),
    ).toBe(
      "Not available to EU organisations: no face detection or other AI-based monitoring in the EU.",
    );
  });

  it("lists places in plain English", () => {
    expect(listText([])).toBe("");
    expect(listText(["Illinois"])).toBe("Illinois");
    expect(listText(["Illinois", "Texas"])).toBe("Illinois and Texas");
    expect(listText(["A", "B", "C"])).toBe("A, B and C");
  });
});
