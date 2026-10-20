import { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "./components/AppShell";
import { AuditLog } from "./features/audit/AuditLog";
import { DayPage } from "./features/day/DayPage";
import { MyData } from "./features/mydata/MyData";
import { NoticePage } from "./features/notice/Notice";
import { People } from "./features/people/People";
import { PolicyPage } from "./features/policy/PolicyPage";
import { Projects } from "./features/projects/Projects";
import { LiveTeam } from "./features/team/LiveTeam";
import { TimesheetPage } from "./features/timesheets/TimesheetPage";
import { MyTimesheets, Timesheets } from "./features/timesheets/Timesheets";
import { homeFor, navFor } from "./lib/nav";
import { currentSession, needsMfa, type Profile, profileQuery } from "./lib/session";
import { Join } from "./routes/Join";
import { Mfa } from "./routes/Mfa";
import { Onboarding } from "./routes/Onboarding";
import { Placeholder } from "./routes/Placeholder";
import { SignIn } from "./routes/SignIn";
import { SignUp } from "./routes/SignUp";

export const queryClient = new QueryClient();

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: () => <p className="p-8 text-sm text-ink2">Page not found.</p>,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignIn,
});
const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-up",
  component: SignUp,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  beforeLoad: async ({ context }) => {
    const session = await currentSession();
    if (!session) throw redirect({ to: "/sign-in" });
    if (await context.queryClient.fetchQuery(profileQuery(session.user.id)))
      throw redirect({ to: "/" });
  },
  component: Onboarding,
});

/** Invite links land here (#28); verifies the link itself, so no session needed. */
const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join",
  component: Join,
});

const mfaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mfa",
  beforeLoad: async () => {
    if (!(await currentSession())) throw redirect({ to: "/sign-in" });
  },
  component: Mfa,
});

/** Everything behind sign-in: needs a session, an org, and MFA when required. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: async ({ context }): Promise<{ profile: Profile }> => {
    const session = await currentSession();
    if (!session) throw redirect({ to: "/sign-in" });
    const profile = await context.queryClient.fetchQuery(profileQuery(session.user.id));
    if (!profile) throw redirect({ to: "/onboarding" });
    if (await needsMfa(profile)) throw redirect({ to: "/mfa" });
    return { profile };
  },
  component: function AppLayout() {
    const { profile } = appRoute.useRouteContext();
    return (
      <AppShell profile={profile}>
        <Outlet />
      </AppShell>
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    throw redirect({ to: homeFor(context.profile.role) });
  },
});

/** A page only its roles can open; others go to their own home. */
function page(path: string, title: string, issue: number, component?: () => React.JSX.Element) {
  return createRoute({
    getParentRoute: () => appRoute,
    path,
    beforeLoad: ({ context }) => {
      if (!navFor(context.profile.role).some((l) => l.to === path)) {
        throw redirect({ to: homeFor(context.profile.role) });
      }
    },
    component: component ?? (() => <Placeholder title={title} issue={issue} />),
  });
}

/** One employee's day (#33); reached from the live grid. Employees open only their own. */
const dayRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/team/$userId",
  beforeLoad: ({ context, params }) => {
    if (context.profile.role === "employee" && params.userId !== context.profile.id) {
      throw redirect({ to: homeFor(context.profile.role) });
    }
  },
  validateSearch: (search: Record<string, unknown>): { date?: string } =>
    typeof search.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
      ? { date: search.date }
      : {},
  component: DayPage,
});

/** One person's week (#43); reached from the Timesheets tab. Employees open only their own. */
const timesheetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/timesheets/$userId",
  beforeLoad: ({ context, params }) => {
    if (context.profile.role === "employee" && params.userId !== context.profile.id) {
      throw redirect({ to: homeFor(context.profile.role) });
    }
  },
  validateSearch: (search: Record<string, unknown>): { week?: string } =>
    typeof search.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.week)
      ? { week: search.week }
      : {},
  component: TimesheetPage,
});

/** An employee's own day (#42, for manual entries): the nav link lands on their day. */
const myDayRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/my-day",
  beforeLoad: ({ context }) => {
    if (context.profile.role !== "employee") throw redirect({ to: homeFor(context.profile.role) });
    throw redirect({ to: "/team/$userId", params: { userId: context.profile.id } });
  },
});

/** Everyone with an account reads the notice they acknowledged (EMP-05, opened from the
 * tray); owners and admins also edit it there (#48), so no role gate. */
const noticeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/notice",
  component: NoticePage,
});

/** Everyone with an account sees their own data (#49, EMP-02): employees from the nav,
 * managers and admins from the account menu; the tray opens it too. Optional ?date= for
 * another day. */
const myDataRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/me",
  validateSearch: (search: Record<string, unknown>): { date?: string } =>
    typeof search.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
      ? { date: search.date }
      : {},
  component: MyData,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  signUpRoute,
  onboardingRoute,
  joinRoute,
  mfaRoute,
  appRoute.addChildren([
    indexRoute,
    page("/team", "Live team", 32, LiveTeam),
    dayRoute,
    myDayRoute,
    page("/timesheets", "Timesheets", 43, Timesheets),
    timesheetRoute,
    page("/projects", "Projects", 38, Projects),
    page("/people", "People", 28, People),
    page("/policy", "Policy", 52, PolicyPage),
    page("/audit", "Audit log", 53, AuditLog),
    myDataRoute,
    page("/my-timesheet", "My timesheet", 43, MyTimesheets),
    noticeRoute,
  ]),
]);

export const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
