// Name, role, direct manager and work location, shared by invite and edit.
import type { Enums } from "@ai-proctor/contracts";
import { useId } from "react";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import type { Member } from "./members";

export type MemberDraft = Pick<
  Member,
  "fullName" | "role" | "managerId" | "country" | "state" | "timezone"
>;

const roles: Enums<"user_role">[] = ["admin", "manager", "employee"];
const roleNames: Record<Enums<"user_role">, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  employee: "Employee",
};

// prettier-ignore
export const usStates = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
];

const zones: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
})();

const select =
  "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink disabled:opacity-60";

export function MemberFields<T extends MemberDraft>({
  value,
  onChange,
  managers,
  roleLocked = false,
  showName = true,
}: {
  value: T;
  onChange: (next: T) => void;
  managers: Pick<Member, "id" | "fullName" | "email">[];
  roleLocked?: boolean;
  showName?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<MemberDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {showName && (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-name`}>Full name</Label>
          <Input
            id={`${id}-name`}
            required
            maxLength={120}
            value={value.fullName}
            onChange={(e) => set({ fullName: e.target.value })}
          />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-role`}>Role</Label>
        <select
          id={`${id}-role`}
          className={select}
          disabled={roleLocked}
          value={value.role}
          onChange={(e) => set({ role: e.target.value as Enums<"user_role"> })}
        >
          {(value.role === "owner" ? (["owner"] as const) : roles).map((r) => (
            <option key={r} value={r}>
              {roleNames[r]}
            </option>
          ))}
        </select>
      </div>
      {value.role !== "owner" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-manager`}>Direct manager</Label>
          <select
            id={`${id}-manager`}
            className={select}
            required
            value={value.managerId ?? ""}
            onChange={(e) => set({ managerId: e.target.value || null })}
          >
            <option value="">Choose…</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fullName}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-country`}>Work country</Label>
        <Input
          id={`${id}-country`}
          required
          maxLength={2}
          pattern="[A-Za-z]{2}"
          title="Two-letter country code, e.g. US, IN, DE"
          value={value.country}
          onChange={(e) => {
            const country = e.target.value.toUpperCase();
            set({ country, state: country === "US" ? value.state : null });
          }}
        />
      </div>
      {value.country === "US" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-state`}>State</Label>
          <select
            id={`${id}-state`}
            className={select}
            required
            value={value.state ?? ""}
            onChange={(e) => set({ state: e.target.value || null })}
          >
            <option value="">Choose…</option>
            {usStates.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor={`${id}-tz`}>Time zone</Label>
        <select
          id={`${id}-tz`}
          className={select}
          value={value.timezone}
          onChange={(e) => set({ timezone: e.target.value })}
        >
          {(zones.includes(value.timezone) ? zones : [value.timezone, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
