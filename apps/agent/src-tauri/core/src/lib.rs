//! Platform-independent agent core. Everything here runs in CI on Linux with
//! `FakePlatform`; OS calls live behind the `Platform` trait in `agent-platform`.

pub mod activity;
pub mod anticheat;
pub mod auth;
pub mod camera_privacy;
pub mod capture;
pub mod checkin;
pub mod clock;
pub mod config;
pub mod consent_store;
pub mod contracts;
pub mod displays;
#[cfg(any(test, feature = "fake"))]
pub mod fake;
pub mod foreground;
pub mod frame_hash;
pub mod keystore;
pub mod liveness;
pub mod logging;
pub mod notice;
pub mod onboarding;
pub mod outbox;
pub mod permissions;
pub mod pixels;
pub mod platform;
pub mod presence;
pub mod scheduler;
pub mod session;
pub mod session_signals;
pub mod shift;
pub mod status;
pub mod sync;
pub mod toast;
pub mod watchdog;
