// Writes the generated JSON Schemas; CI fails if the committed files differ.
// - generated/ipc.schema.json: every IPC type under `definitions`, for
//   typify::import_types! in the Rust core.
// - generated/agent-event.schema.json: one agent_events element, stored in the
//   database (see contract-migration.ts) and checked with pg_jsonschema.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { AgentEvent } from "../src/events.ts";
import {
  AgentStatus,
  CardChallenge,
  CardClickResult,
  CheckinOutcome,
  CommandResult,
  LastCheckin,
  MissedCheckin,
  PermissionState,
  Permissions,
  ProjectRef,
  ShiftState,
} from "../src/ipc.ts";

const registry = z.registry<{ id: string }>();
for (const schema of [
  PermissionState,
  Permissions,
  ShiftState,
  ProjectRef,
  CheckinOutcome,
  LastCheckin,
  MissedCheckin,
  AgentStatus,
  CommandResult,
  CardChallenge,
  CardClickResult,
]) {
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

function write(file: string, value: unknown) {
  const out = new URL(`../generated/${file}`, import.meta.url);
  writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${out.pathname}`);
}

write("ipc.schema.json", doc);
write("agent-event.schema.json", {
  ...z.toJSONSchema(AgentEvent, { target: "draft-7" }),
  title: "AI Proctor agent event",
});
