// People imports (#256, ORG-03..06, ORG-08): invite new people and update existing ones,
// matched on email. An empty cell keeps the person's current value (update) or takes the
// import's default (create), the way the invite dialog fills in its defaults. Checks the
// rules add_invited_member and update_member check, across the whole file: a manager must
// be in the file or the org, active, and not an employee; no reporting loops; the owner
// keeps their role; nobody changes their own role; a manager made an employee has no
// one left reporting to them.
import { ImportPerson } from "@ai-proctor/contracts";
import type { RowCells } from "./columns";
import { addIssues, RowResult } from "./rows";
import type { ImportContext, UserRole } from "./types";
import {
  nameKey,
  parseCountry,
  parseEmail,
  parseLocation,
  parseRole,
  parseState,
  parseTimeZone,
} from "./values";

const COLUMN_OF: Record<string, string> = {
  email: "email",
  full_name: "name",
  role: "role",
  manager_email: "manager_email",
  team: "team",
  work_country: "country",
  work_state: "state",
  timezone: "timezone",
};

interface Final {
  email: string;
  full_name: string;
  role: UserRole;
  manager_email: string | null;
  team: string | null;
  work_country: string;
  work_state: string | null;
  timezone: string;
}

interface Parsed {
  result: RowResult;
  email?: string;
  isNew: boolean;
  role?: UserRole;
  manager?: string | null;
  final?: Final;
}

const place = (country: string, state: string | null) => (state ? `${country}-${state}` : country);

export function previewPeople(rows: RowCells[], ctx: ImportContext) {
  const existing = new Map(ctx.people.map((p) => [p.email.toLowerCase(), p]));
  const teams = new Map(ctx.teams.map((t) => [nameKey(t.name), t.name]));
  const me = ctx.me.email.toLowerCase();
  const defaults = ctx.defaults;
  const firstRow = new Map<string, number>();
  const parsed: Parsed[] = [];

  for (const cells of rows) {
    const get = cells.get;
    const result = new RowResult(cells.row, get("email").toLowerCase() || `row ${cells.row}`);
    const p: Parsed = { result, isNew: false };
    parsed.push(p);
    if (cells.overflow) result.error(null, "This row has more values than the header has columns.");

    // Email: the key.
    const emailCell = get("email");
    let email: string | undefined;
    if (!emailCell) result.error("email", "The email is missing.");
    else {
      const e = parseEmail(emailCell);
      if (!e.ok) result.error("email", e.message);
      else {
        email = e.value;
        result.key = email;
        const first = firstRow.get(email);
        if (first !== undefined) {
          result.error("email", `${email} is also on row ${first}.`);
          email = undefined;
        } else firstRow.set(email, cells.row);
      }
    }
    const ex = email ? existing.get(email) : undefined;
    if (email && ex && !ex.active) {
      result.error("email", `${email} is deactivated. Reactivate them on the People page first.`);
    }
    p.isNew = !ex;
    if (email) p.email = email;

    // Name.
    const nameCell = get("name");
    let fullName = nameCell || ex?.full_name;
    if (nameCell.length > 120) {
      result.error("name", "The name is longer than 120 characters.");
      fullName = undefined;
    } else if (!fullName) result.error("name", "The name is missing.");

    // Role.
    const roleCell = get("role");
    let role: UserRole | undefined = ex?.role ?? defaults?.role ?? "employee";
    if (roleCell) {
      const r = parseRole(roleCell);
      if (r.ok) role = r.value;
      else {
        result.error("role", r.message);
        role = undefined;
      }
    }
    const owner = ex?.role === "owner";
    if (role && owner && role !== "owner") {
      result.error("role", "The owner's role can't be changed here.");
    } else if (role === "owner" && !owner) {
      result.error("role", "Ownership can't be given by import. Use admin, manager or employee.");
    }
    if (role && ex && email === me && role !== ex.role) {
      result.error("role", "You can't change your own role.");
    }
    if (role) p.role = role;

    // Manager.
    const managerCell = get("manager_email");
    let manager: string | null | undefined = ex
      ? (ex.manager_email?.toLowerCase() ?? null)
      : (defaults?.manager_email?.toLowerCase() ?? null);
    if (managerCell) {
      const m = parseEmail(managerCell);
      if (m.ok) manager = m.value;
      else {
        result.error("manager_email", m.message);
        manager = undefined;
      }
    }
    if (owner || role === "owner") {
      if (managerCell) result.error("manager_email", "The owner has no manager.");
      manager = null;
    } else if (manager === null) {
      result.error("manager_email", "The manager's email is missing.");
      manager = undefined;
    }
    if (manager !== undefined) p.manager = manager;

    // Team: one that exists.
    const teamCell = get("team");
    let team: string | null | undefined = ex ? ex.team : null;
    if (teamCell) {
      team = teams.get(nameKey(teamCell));
      if (team === undefined) {
        result.error(
          "team",
          `There's no team named "${teamCell}". Add it on the Teams page or import teams first.`,
        );
      }
    }

    // Work location: country and state, or both in one cell.
    let country: string | undefined;
    let state: string | null | undefined;
    const locationCell = get("work_location");
    if (locationCell) {
      const l = parseLocation(locationCell);
      if (!l.ok) result.error("work_location", l.message);
      else {
        country = l.value.country;
        if (l.value.state) state = l.value.state;
      }
    }
    const countryCell = get("country");
    if (countryCell) {
      const c = parseCountry(countryCell);
      if (!c.ok) result.error("country", c.message);
      else if (country !== undefined && country !== c.value) {
        result.error(
          "country",
          `The country (${c.value}) and the work location (${country}) disagree.`,
        );
      } else country = c.value;
    }
    const stateCell = get("state");
    if (stateCell) {
      const s = parseState(stateCell);
      if (!s.ok) result.error("state", s.message);
      else if (state && state !== s.value) {
        result.error("state", `The state (${s.value}) and the work location (${state}) disagree.`);
      } else state = s.value;
    }
    const workCountry = country ?? ex?.work_country ?? defaults?.work_country;
    let workState: string | null = null;
    if (!workCountry) result.error("country", "The country is missing.");
    else if (state !== undefined) workState = state;
    else if (workCountry === "US") {
      if (ex?.work_country === "US") workState = ex.work_state;
      else if (!ex && defaults?.work_country === "US") workState = defaults.work_state;
    }
    const placeBad = result.errors.some((e) =>
      ["country", "state", "work_location"].includes(e.field ?? ""),
    );
    // When a location cell was already wrong, that message is enough.
    if (!placeBad && workCountry === "US" && !workState) {
      result.error("state", "A US work location needs a state, like NY.");
    } else if (!placeBad && workCountry && workCountry !== "US" && workState) {
      result.error("state", "Only US work locations have a state.");
    }

    // Time zone.
    const zoneCell = get("timezone");
    let timezone = ex?.timezone ?? defaults?.timezone;
    if (zoneCell) {
      const z = parseTimeZone(zoneCell);
      if (z.ok) timezone = z.value;
      else {
        result.error("timezone", z.message);
        timezone = undefined;
      }
    } else if (!timezone) result.error("timezone", "The time zone is missing.");

    if (
      email &&
      fullName &&
      role &&
      manager !== undefined &&
      team !== undefined &&
      workCountry &&
      timezone
    ) {
      p.final = {
        email,
        full_name: fullName,
        role,
        manager_email: manager,
        team,
        work_country: workCountry,
        work_state: workState,
        timezone,
      };
    }
  }

  // The org as it would be after the import: who has which role and manager.
  const roleOf = new Map<string, UserRole>();
  const managerOf = new Map<string, string | null>();
  const active = new Set<string>();
  const rowOf = new Map<string, number>();
  for (const person of ctx.people) {
    const email = person.email.toLowerCase();
    roleOf.set(email, person.role);
    managerOf.set(email, person.manager_email?.toLowerCase() ?? null);
    if (person.active) active.add(email);
  }
  for (const p of parsed) {
    if (!p.email) continue;
    rowOf.set(p.email, p.result.row);
    if (p.isNew) active.add(p.email);
    if (p.role) roleOf.set(p.email, p.role);
    if (p.manager !== undefined) managerOf.set(p.email, p.manager);
  }

  for (const p of parsed) {
    const { email, result } = p;
    if (!email) continue;
    const manager = p.manager;
    if (manager) {
      const managerRow = rowOf.get(manager);
      const where = managerRow ? ` (row ${managerRow})` : "";
      if (manager === email) result.error("manager_email", "A person can't be their own manager.");
      else if (!roleOf.has(manager)) {
        result.error(
          "manager_email",
          `No one with email ${manager} is in this file or in your organisation.`,
        );
      } else if (!active.has(manager)) {
        result.error("manager_email", `${manager} is deactivated, so they can't be a manager.`);
      } else if (roleOf.get(manager) === "employee") {
        result.error(
          "manager_email",
          `${manager}${where} is an employee. A manager must be a manager, admin or owner.`,
        );
      } else {
        const chain = [email, manager];
        let up = managerOf.get(manager) ?? null;
        while (up && chain.length <= roleOf.size + 1) {
          if (up === email) {
            result.error(
              "manager_email",
              `This makes a reporting loop: ${[...chain, email].join(" → ")}.`,
            );
            break;
          }
          chain.push(up);
          up = managerOf.get(up) ?? null;
        }
      }
    }
    const before = existing.get(email);
    if (p.role === "employee" && before && before.role !== "employee") {
      const left = ctx.people.filter(
        (x) =>
          x.active && x.manager_email?.toLowerCase() === email && !rowOf.has(x.email.toLowerCase()),
      ).length;
      if (left > 0) {
        result.error(
          "role",
          `${left} ${left === 1 ? "person still reports" : "people still report"} to ${email}. Give them another manager first.`,
        );
      }
    }
  }

  // Status, then the apply items.
  const items: ImportPerson[] = [];
  for (const p of parsed) {
    const { result, final } = p;
    if (!result.ok || !final) continue;
    const before = existing.get(final.email);
    if (!before) result.action = "create";
    else {
      const c = result.changes;
      if (final.full_name !== before.full_name)
        c.push(`name: ${before.full_name} → ${final.full_name}`);
      if (final.role !== before.role) c.push(`role: ${before.role} → ${final.role}`);
      const beforeManager = before.manager_email?.toLowerCase() ?? null;
      if (final.manager_email !== beforeManager) {
        c.push(`manager: ${beforeManager ?? "none"} → ${final.manager_email ?? "none"}`);
      }
      if (nameKey(final.team ?? "") !== nameKey(before.team ?? "")) {
        c.push(`team: ${before.team ?? "none"} → ${final.team ?? "none"}`);
      }
      const was = place(before.work_country, before.work_state);
      const now = place(final.work_country, final.work_state);
      if (was !== now) c.push(`work location: ${was} → ${now}`);
      if (final.timezone !== before.timezone)
        c.push(`time zone: ${before.timezone} → ${final.timezone}`);
      result.action = c.length > 0 ? "update" : "unchanged";
    }
    if (result.action === "unchanged") continue;
    const item = ImportPerson.safeParse({
      rows: [result.row],
      action: result.action,
      ...final,
    });
    if (item.success) items.push(item.data);
    else addIssues(result, item.error.issues, (k) => COLUMN_OF[k] ?? null);
  }

  // Managers before the people who report to them, so each manager exists when needed.
  const inPayload = new Set(items.map((i) => i.email));
  const depth = (email: string) => {
    let n = 0;
    let up = managerOf.get(email) ?? null;
    for (let steps = 0; up && steps <= managerOf.size; steps++) {
      if (inPayload.has(up)) n++;
      up = managerOf.get(up) ?? null;
    }
    return n;
  };
  const ordered = items
    .map((item, i) => ({ item, i, d: depth(item.email) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.item);

  return { rows: parsed.map((p) => p.result.preview()), items: ordered };
}
