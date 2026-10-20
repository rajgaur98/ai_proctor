// Pure helpers for the data request dialogs (#54); no imports from lib/supabase so they
// can be unit tested without an environment.

/** Whether what was typed is the person's email (the confirmation both dialogs ask for). */
export function emailConfirmed(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/** Total rows in a deletion's counts. */
export function rowsRemoved(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}
