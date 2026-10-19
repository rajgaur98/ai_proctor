//! Time sources. Agent logic never calls `Utc::now()` directly, so tests can drive
//! hours of shift time in microseconds with `FakeClock`.

use std::sync::Mutex;
use std::time::Instant;

use chrono::{DateTime, Duration, Utc};

pub trait Clock: Send + Sync {
    /// Wall-clock time (may jump when the user changes the clock).
    fn now(&self) -> DateTime<Utc>;
    /// Monotonic milliseconds since the agent started, for skew repair (LLD 03).
    fn mono_ms(&self) -> u64;
}

pub struct SystemClock {
    started: Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }

    fn mono_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// A clock that only moves when told to.
pub struct FakeClock {
    state: Mutex<(DateTime<Utc>, u64)>,
}

impl FakeClock {
    pub fn at(rfc3339: &str) -> Self {
        let now = DateTime::parse_from_rfc3339(rfc3339)
            .expect("valid RFC 3339 time")
            .with_timezone(&Utc);
        Self {
            state: Mutex::new((now, 0)),
        }
    }

    pub fn advance(&self, by: Duration) {
        let mut state = self.state.lock().unwrap();
        state.0 += by;
        state.1 += by.num_milliseconds().max(0) as u64;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> DateTime<Utc> {
        self.state.lock().unwrap().0
    }

    fn mono_ms(&self) -> u64 {
        self.state.lock().unwrap().1
    }
}
