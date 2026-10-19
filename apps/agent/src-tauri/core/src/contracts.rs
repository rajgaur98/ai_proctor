//! IPC types generated at compile time from `packages/contracts` (Zod → JSON Schema).
//! Change the Zod schemas and run `pnpm contracts:gen`; never edit types here.

typify::import_types!(
    schema = "../../../../packages/contracts/generated/ipc.schema.json",
    derives = [PartialEq, Eq]
);
