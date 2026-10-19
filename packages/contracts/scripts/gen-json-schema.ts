// Writes generated/ipc.schema.json: one JSON Schema document whose `definitions` hold
// every IPC type, for typify::import_types! in the Rust core. CI fails if the
// committed file differs from what this script produces.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { AgentStatus, PermissionState, Permissions, ShiftState } from "../src/ipc.ts";

const registry = z.registry<{ id: string }>();
for (const schema of [PermissionState, Permissions, ShiftState, AgentStatus]) {
  const id = schema.meta()?.id;
  if (typeof id !== "string") throw new Error("every IPC schema needs a meta id");
  registry.add(schema, { id });
}

const { schemas } = z.toJSONSchema(registry, {
  target: "draft-7",
  uri: (id) => `#/definitions/${id}`,
});

const definitions = Object.fromEntries(
  Object.entries(schemas).map(([id, schema]) => {
    const { $schema: _ignored, $id: _id, ...rest } = schema as Record<string, unknown>;
    return [id, rest];
  }),
);

const doc = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AI Proctor agent IPC",
  definitions,
};

const out = new URL("../generated/ipc.schema.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
