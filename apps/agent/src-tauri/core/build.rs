// Rebuild when the generated IPC schema changes (typify reads it at compile time).
fn main() {
    println!("cargo:rerun-if-changed=../../../../packages/contracts/generated/ipc.schema.json");
}
