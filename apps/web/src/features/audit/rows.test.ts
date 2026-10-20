import { describe, expect, it } from "vitest";
import { parseCsv } from "../people/csv";
import { type AuditRow, auditCsv, csvHeader } from "./rows";

const row = (patch: Partial<AuditRow>): AuditRow => ({
  id: 1,
  at: "2026-03-10T03:30:00.123456+00:00",
  action: "member.role_changed",
  actorId: "a1",
  actorName: "Ada Admin",
  targetId: "c1",
  targetName: 'Erin "E" Employee',
  metadata: { from: "employee", to: "manager" },
  ...patch,
});

describe("auditCsv", () => {
  it("writes ISO times with the offset of the zone, and escapes values", () => {
    const [header, first, system] = parseCsv(
      auditCsv(
        [
          row({}),
          row({
            id: 2,
            actorId: null,
            actorName: null,
            at: "2026-07-01T12:00:00+00:00",
            metadata: {},
          }),
        ],
        "America/New_York",
      ),
    );
    expect(header).toEqual(csvHeader);
    expect(first).toEqual([
      "2026-03-09T23:30:00.123-04:00",
      "America/New_York",
      "Ada Admin",
      "a1",
      "member.role_changed",
      'Erin "E" Employee',
      "c1",
      '{"from":"employee","to":"manager"}',
    ]);
    expect(system?.slice(0, 4)).toEqual(["2026-07-01T08:00:00-04:00", "America/New_York", "", ""]);
  });
});
