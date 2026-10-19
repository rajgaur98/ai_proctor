//! Platform-independent agent core. Everything here runs in CI on Linux with
//! `FakePlatform`; OS calls live behind the `Platform` trait in `agent-platform`.

pub mod contracts;
#[cfg(any(test, feature = "fake"))]
pub mod fake;
pub mod logging;
pub mod platform;
pub mod status;
