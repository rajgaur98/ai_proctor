import { describe, expect, it } from "vitest";
import { explainImportError, ImportError, rowsOf } from "./importErrors";

describe("import errors", () => {
  it("reads the rows from the database's DETAIL", () => {
    expect(rowsOf("rows: 4")).toEqual([4]);
    expect(rowsOf("rows: 3,4")).toEqual([3, 4]);
    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf("something else")).toEqual([]);
  });

  it("explains a known code with its rows", () => {
    expect(explainImportError(new ImportError("manager_not_found", [3]))).toBe(
      "A manager in the file isn't in your organisation, or is deactivated. Row 3. Nothing was changed; check the file again.",
    );
    expect(explainImportError(new ImportError("name_taken", [2, 5]))).toBe(
      "A name in the file is already taken. Rows 2, 5. Nothing was changed; check the file again.",
    );
  });

  it("falls back to the code, or a generic message", () => {
    expect(explainImportError(new ImportError("something_new", []))).toBe(
      "The import failed (something_new). Nothing was changed; check the file again.",
    );
    expect(explainImportError(new Error("network"))).toBe(
      "The import failed. Nothing was changed. Try again.",
    );
  });
});
