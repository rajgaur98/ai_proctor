// Writes the public API's OpenAPI document (#306) to docs/api/openapi.json, from the same
// route table the api-v1 Edge Function serves it from. `--check` fails instead of writing
// when the committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { openApiDocument } from "../supabase/functions/api-v1/openapi.ts";

const file = new URL("../docs/api/openapi.json", import.meta.url);
const text = `${JSON.stringify(openApiDocument(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    // Missing counts as stale.
  }
  if (current !== text) {
    console.error("docs/api/openapi.json is stale: run `pnpm api:openapi` and commit it.");
    process.exit(1);
  }
  console.log("docs/api/openapi.json is up to date.");
} else {
  writeFileSync(file, text);
  console.log("wrote docs/api/openapi.json");
}
