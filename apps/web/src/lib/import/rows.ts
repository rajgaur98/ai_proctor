// Bookkeeping shared by the import kinds (#256): one result per row, then its status.
import type { FieldError, PreviewRow, RowStatus } from "./types";

export class RowResult {
  readonly errors: FieldError[] = [];
  readonly changes: string[] = [];
  /** Set once the row passed every check: create, update or unchanged. */
  action: Exclude<RowStatus, "error"> | null = null;

  constructor(
    readonly row: number,
    public key: string,
  ) {}

  error(field: string | null, message: string): void {
    this.errors.push({ field, message });
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }

  preview(): PreviewRow {
    const status: RowStatus = this.ok ? (this.action ?? "unchanged") : "error";
    return {
      row: this.row,
      key: this.key,
      status,
      errors: this.errors,
      changes: status === "update" ? this.changes : [],
    };
  }
}

/** A Zod-style result's problems on the row, under the column each one is about. */
export function addIssues(
  result: RowResult,
  issues: { path: PropertyKey[]; message: string }[],
  columnOf: (key: string) => string | null,
): void {
  for (const issue of issues) {
    const key = issue.path[0];
    const column = typeof key === "string" ? columnOf(key) : null;
    result.error(column, `${column ?? "This row"}: ${issue.message}.`);
  }
}

/** "a" -> "a"; "a", "b" -> "a and b"; "a", "b", "c" -> "a, b and c". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
