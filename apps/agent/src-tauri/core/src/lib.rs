//! Platform-independent agent core. Everything here runs in CI on Linux with
//! `FakePlatform`; OS calls live behind the `Platform` trait in `agent-platform`.

pub mod auth;
pub mod capture;
pub mod checkin;
pub mod clock;
pub mod contracts;
#[cfg(any(test, feature = "fake"))]
pub mod fake;
pub mod keystore;
pub mod logging;
pub mod outbox;
pub mod platform;
pub mod scheduler;
pub mod session;
pub mod shift;
pub mod status;
pub mod sync;
