// Role-aware navigation, from the Claude Design WebNav component.
import type { Enums } from "@ai-proctor/contracts";

export type Role = Enums<"user_role">;

export interface NavLink {
  to: string;
  label: string;
}

const manager: NavLink[] = [
  { to: "/team", label: "Live team" },
  { to: "/timesheets", label: "Timesheets" },
  { to: "/projects", label: "Projects" },
  { to: "/policy", label: "Policy" },
];

const admin: NavLink[] = [
  { to: "/team", label: "Live team" },
  { to: "/timesheets", label: "Timesheets" },
  { to: "/people", label: "People" },
  { to: "/projects", label: "Projects" },
  { to: "/policy", label: "Policy" },
  { to: "/notice", label: "Monitoring notice" },
];

const employee: NavLink[] = [
  { to: "/me", label: "My data" },
  { to: "/my-timesheet", label: "My timesheet" },
  { to: "/notice", label: "Monitoring notice" },
];

export function navFor(role: Role): NavLink[] {
  switch (role) {
    case "owner":
    case "admin":
      return admin;
    case "manager":
      return manager;
    case "employee":
      return employee;
  }
}

/** Where each role lands after sign-in. */
export function homeFor(role: Role): string {
  return navFor(role)[0]?.to ?? "/me";
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
