// Why an import's apply step failed, in plain words (#256). The database raises its error
// code as the message and the file's rows as DETAIL ("rows: 3,4"); the import-people
// function passes both on as { error, detail }.

/** An apply that failed: the database's error code and the file rows it was about. */
export class ImportError extends Error {
  constructor(
    readonly code: string,
    readonly rows: number[],
  ) {
    super(code);
  }
}

export const rowsOf = (detail: unknown): number[] =>
  typeof detail === "string"
    ? (detail
        .match(/^rows: ([\d,]+)/)?.[1]
        ?.split(",")
        .map(Number) ?? [])
    : [];

const MESSAGES: Record<string, string> = {
  admin_only: "Only owners and admins can import.",
  not_signed_in: "Sign in again and retry.",
  invalid_import: "The import was refused as malformed. Check the file again.",
  too_many_invites: "One import can invite at most 500 new people. Split the file.",
  already_a_member: "Someone in the file has joined since you checked it.",
  email_exists: "That email already has an account here or in another organisation.",
  user_not_found: "Someone in the file isn't in your organisation any more.",
  user_inactive: "Someone in the file has been deactivated.",
  manager_not_found: "A manager in the file isn't in your organisation, or is deactivated.",
  manager_must_be_manager_or_admin: "A manager in the file is an employee.",
  manager_required: "Someone in the file has no manager.",
  reporting_loop: "The file makes a reporting loop.",
  cannot_change_owner: "The owner's role can't be changed here.",
  cannot_change_own_role: "You can't change your own role.",
  owner_only: "Only the owner can change the owner.",
  has_reports: "A manager made an employee still has people reporting to them.",
  team_not_found: "A team in the file doesn't exist any more.",
  client_not_found: "A client in the file doesn't exist any more.",
  name_taken: "A name in the file is already taken.",
  invalid_name: "A name in the file is empty or too long.",
  invalid_timezone: "A time zone in the file isn't one the server knows.",
  invalid_shifts: "A shift in the file isn't valid.",
  us_state_required: "A US work location needs a state.",
  state_only_for_us: "Only US work locations have a state.",
  invalid_country: "A country code in the file isn't valid.",
  user_not_visible: "Someone in the file isn't visible to you.",
  // Time entries (#282): request_manual_entry's refusals.
  project_not_found: "A project in the file doesn't exist any more.",
  project_not_allowed: "Someone in the file can't log time to their project any more.",
  task_not_found: "A task in the file doesn't exist any more.",
  task_not_allowed: "A task in the file has been archived.",
  overlaps_clocked_time: "An entry in the file now overlaps clocked time.",
  overlaps_manual_entry: "An entry in the file now overlaps another entry.",
  day_locked: "An entry in the file is in a week that has since been approved.",
  entry_exists: "An entry for the same person and times now exists with other details.",
  in_the_future: "An entry in the file ends in the future.",
  invalid_range: "An entry in the file ends before it starts.",
  range_too_long: "An entry in the file is longer than 24 hours.",
  invalid_reason: "A reason in the file is empty or too long.",
  invalid_note: "A note in the file is too long.",
};

/** What went wrong, in plain words, with the rows when the database named them. */
export function explainImportError(e: unknown): string {
  if (!(e instanceof ImportError)) return "The import failed. Nothing was changed. Try again.";
  const what = MESSAGES[e.code] ?? `The import failed (${e.code}).`;
  const where =
    e.rows.length > 0 ? ` ${e.rows.length === 1 ? "Row" : "Rows"} ${e.rows.join(", ")}.` : "";
  return `${what}${where} Nothing was changed; check the file again.`;
}
