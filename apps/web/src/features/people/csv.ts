// Bulk invites from a CSV (#28, ORG-03). Columns by header name, any order:
// email, full_name (or name), role, manager_email, country, state, timezone.
// Missing role / manager / country / time zone fall back to the defaults chosen
// in the invite dialog.
import { Invite } from "@ai-proctor/contracts";

/** RFC 4180-ish: commas, quoted fields with "" escapes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export interface InviteDefaults {
  role: Invite["role"];
  managerId: string;
  country: string;
  state: string | null;
  timezone: string;
}

export interface CsvResult {
  invites: Invite[];
  /** 1-based line numbers (the header is line 1) with what's wrong. */
  errors: { line: number; message: string }[];
}

const columns: Record<string, string> = {
  email: "email",
  full_name: "full_name",
  name: "full_name",
  role: "role",
  manager_email: "manager_email",
  manager: "manager_email",
  country: "country",
  state: "state",
  timezone: "timezone",
  time_zone: "timezone",
};

export function invitesFromCsv(
  text: string,
  managersByEmail: Map<string, string>,
  defaults: InviteDefaults,
): CsvResult {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { invites: [], errors: [{ line: 1, message: "The file is empty." }] };
  const keys = header.map((h) => columns[h.trim().toLowerCase().replace(/\s+/g, "_")]);
  if (!keys.includes("email") || !keys.includes("full_name")) {
    return {
      invites: [],
      errors: [{ line: 1, message: "The header needs at least email and full_name columns." }],
    };
  }

  const result: CsvResult = { invites: [], errors: [] };
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const line = i + 2;
    const get = (key: string) => {
      const at = keys.indexOf(key);
      const value = at >= 0 ? row[at]?.trim() : "";
      return value ? value : undefined;
    };
    const managerEmail = get("manager_email")?.toLowerCase();
    const managerId = managerEmail ? managersByEmail.get(managerEmail) : defaults.managerId;
    if (!managerId) {
      result.errors.push({ line, message: `No manager or admin with email ${managerEmail}.` });
      return;
    }
    const country = get("country")?.toUpperCase() ?? defaults.country;
    const state =
      get("state")?.toUpperCase() ?? (country === defaults.country ? defaults.state : null);
    const parsed = Invite.safeParse({
      email: get("email")?.toLowerCase(),
      full_name: get("full_name"),
      role: get("role")?.toLowerCase() ?? defaults.role,
      manager_id: managerId,
      work_country: country,
      work_state: state,
      timezone: get("timezone") ?? defaults.timezone,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result.errors.push({ line, message: `${issue?.path.join(".")}: ${issue?.message}` });
      return;
    }
    if (seen.has(parsed.data.email)) {
      result.errors.push({ line, message: `${parsed.data.email} is listed twice.` });
      return;
    }
    seen.add(parsed.data.email);
    result.invites.push(parsed.data);
  });
  return result;
}
