// Top navigation from the Claude Design WebNav: logo, role-aware links, org name,
// initials. Collapses to a menu button below 768 px.
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AlertsMenu } from "../features/alerts/AlertsMenu";
import { NotificationsMenu } from "../features/notifications/NotificationsMenu";
import { initials, navFor } from "../lib/nav";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabase";

function Mark() {
  return (
    <span
      aria-hidden="true"
      className="relative block h-[22px] w-[22px] flex-none rounded-md bg-acc"
    >
      <span className="absolute top-[5px] left-[10px] h-[7px] w-[2px] rounded-[1px] bg-accink" />
      <span className="absolute top-[10px] left-[10px] h-[2px] w-[6px] rounded-[1px] bg-accink" />
    </span>
  );
}

export function AppShell({ profile, children }: { profile: Profile; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const links = navFor(profile.role);
  const signOut = async () => {
    await supabase.auth.signOut();
    await navigate({ to: "/sign-in" });
  };
  const linkClass =
    "flex h-[34px] items-center rounded-lg px-3 text-[13.5px] font-medium text-ink2 [&.active]:bg-sunk [&.active]:text-ink";

  return (
    <div className="min-h-dvh bg-bg">
      <header className="flex h-14 items-center gap-5 border-b border-line bg-panel px-4 md:px-6">
        <Link to="/" className="flex flex-none items-center gap-[9px]">
          <Mark />
          <span className="text-[14.5px] font-semibold tracking-[-0.01em]">AI Proctor</span>
        </Link>
        <nav aria-label="Main" className="ml-3 hidden gap-0.5 md:flex">
          {links.map((l) => (
            <Link key={l.to} to={l.to} className={linkClass}>
              {l.label}
            </Link>
          ))}
        </nav>
        <span className="flex-1" />
        <span className="hidden text-[13px] text-ink3 md:inline">{profile.orgName}</span>
        <NotificationsMenu userId={profile.id} />
        {profile.role !== "employee" && <AlertsMenu userId={profile.id} />}
        <details className="relative">
          <summary
            aria-label={`Account menu for ${profile.fullName}`}
            className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-full border border-line bg-sunk text-xs font-semibold text-ink2"
          >
            {initials(profile.fullName)}
          </summary>
          <div className="absolute right-0 z-10 mt-2 flex w-56 flex-col rounded-xl border border-line bg-panel p-1 shadow-lg">
            <span className="px-3 py-2 text-[12.5px] text-ink3">{profile.fullName}</span>
            <Link to="/mfa" className="rounded-lg px-3 py-2 text-sm hover:bg-sunk">
              Two-factor authentication
            </Link>
            <button
              type="button"
              onClick={signOut}
              className="rounded-lg px-3 py-2 text-left text-sm hover:bg-sunk"
            >
              Sign out
            </button>
          </div>
        </details>
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="-mr-2.5 flex h-11 w-11 flex-col items-center justify-center gap-1 md:hidden"
        >
          <span className="h-[1.5px] w-[18px] bg-ink" />
          <span className="h-[1.5px] w-[18px] bg-ink" />
          <span className="h-[1.5px] w-[18px] bg-ink" />
        </button>
      </header>
      {open && (
        <nav
          aria-label="Main"
          className="flex flex-col border-b border-line bg-panel p-2 md:hidden"
        >
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={`${linkClass} h-11`}
              onClick={() => setOpen(false)}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      )}
      <main className="mx-auto max-w-[1440px] p-4 md:p-8">{children}</main>
    </div>
  );
}
