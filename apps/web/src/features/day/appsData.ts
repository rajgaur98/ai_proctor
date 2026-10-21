// "Top apps today" (ACT-04, #67): the apps a person had in front the longest over a
// day, time only. The server (top_apps, read by dayData's topAppsQuery) adds the seconds
// up per app name and returns nothing while the person's activity sampling is off; this
// only shapes the rows. Pure, so it is tested without a server.

export interface TopApp {
  appName: string;
  seconds: number;
}

export interface TopAppRow extends TopApp {
  /** Bar length, as a percentage of the longest app (time only, no score). */
  width: number;
}

/** The rows in the server's order, each with a bar relative to the first. */
export function topAppRows(apps: readonly TopApp[]): TopAppRow[] {
  const longest = Math.max(0, ...apps.map((a) => a.seconds));
  return apps.map((a) => ({
    ...a,
    width: longest > 0 ? Math.max(2, Math.round((a.seconds / longest) * 100)) : 0,
  }));
}
