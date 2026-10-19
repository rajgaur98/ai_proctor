// CI: fails if the agent-event schema stored in the database (by migrations)
// differs from generated/agent-event.schema.json, i.e. someone changed events.ts
// without `pnpm contracts:migration`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const dbUrl = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const query = "select schema::text from internal.contract_schemas where name = 'agent_event'";

const stored = execFileSync("psql", [dbUrl, "-At", "-c", query], { encoding: "utf8" }).trim();
const generated = readFileSync(
  new URL("../generated/agent-event.schema.json", import.meta.url),
  "utf8",
);

if (!stored || !isDeepStrictEqual(JSON.parse(stored), JSON.parse(generated))) {
  console.error(
    "internal.contract_schemas['agent_event'] differs from generated/agent-event.schema.json.\n" +
      "Run `pnpm contracts:gen && pnpm contracts:migration` and commit the new migration.",
  );
  process.exit(1);
}
console.log("agent_event schema in the database matches the contracts");
