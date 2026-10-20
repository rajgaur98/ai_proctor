//! Idle time, lock, sleep and session end on Windows (#167, #159; ACT-01, ANT-01). The Win32 reads and
//! the hidden window that receives session and power notifications live in
//! `agent-platform`; what the numbers and messages mean is here, so it runs in CI on
//! every OS.

use crate::platform::SessionState;

/// `WM_WTSSESSION_CHANGE` `wParam` values.
const WTS_SESSION_LOGOFF: usize = 0x6;
const WTS_SESSION_LOCK: usize = 0x7;
const WTS_SESSION_UNLOCK: usize = 0x8;
/// `WM_ENDSESSION` `lParam` flag: an installer's Restart Manager is closing the app
/// to update it, not the session ending.
const ENDSESSION_CLOSEAPP: usize = 0x1;
/// `WM_POWERBROADCAST` `wParam` values.
const PBT_APMSUSPEND: usize = 0x4;
const PBT_APMRESUMESUSPEND: usize = 0x7;
const PBT_APMRESUMEAUTOMATIC: usize = 0x12;

/// `WTSINFOEX_LEVEL1.SessionFlags`: 0 locked, 1 unlocked (Windows 8 and later).
const WTS_SESSIONSTATE_LOCK: i32 = 0;

/// Whole seconds since the last keyboard or mouse input, from the 32-bit tick counts
/// of `GetLastInputInfo` and `GetTickCount`. The counters wrap every ~49.7 days; the
/// wrapping difference is still right.
pub fn idle_seconds(last_input_tick: u32, now_tick: u32) -> u64 {
    (now_tick.wrapping_sub(last_input_tick) / 1000) as u64
}

/// `WTSINFOEX_LEVEL1.SessionFlags` as "the screen is locked".
pub fn session_flags_locked(flags: i32) -> bool {
    flags == WTS_SESSIONSTATE_LOCK
}

/// Something that changes `SessionFlags`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionEvent {
    Locked,
    Unlocked,
    Suspended,
    Resumed,
}

/// The event for a `WM_WTSSESSION_CHANGE` message's `wParam`, if it matters.
pub fn session_event(wparam: usize) -> Option<SessionEvent> {
    match wparam {
        WTS_SESSION_LOCK => Some(SessionEvent::Locked),
        WTS_SESSION_UNLOCK => Some(SessionEvent::Unlocked),
        _ => None,
    }
}

/// The event for a `WM_POWERBROADCAST` message's `wParam`, if it matters. Both
/// resume notifications count: a wake the person caused and one the system did.
pub fn power_event(wparam: usize) -> Option<SessionEvent> {
    match wparam {
        PBT_APMSUSPEND => Some(SessionEvent::Suspended),
        PBT_APMRESUMESUSPEND | PBT_APMRESUMEAUTOMATIC => Some(SessionEvent::Resumed),
        _ => None,
    }
}

/// Whether a `WM_WTSSESSION_CHANGE` message's `wParam` says this session is being
/// logged off (#159). It can't be cancelled, unlike the query before `WM_ENDSESSION`.
pub fn session_logoff(wparam: usize) -> bool {
    wparam == WTS_SESSION_LOGOFF
}

/// Whether a `WM_ENDSESSION` message really ends the session (#159). `wParam` is
/// non-zero when it does and zero when another app vetoed `WM_QUERYENDSESSION` and
/// the session carries on. A close for an installer update (`ENDSESSION_CLOSEAPP`)
/// is the app being restarted, not a logout, restart or shutdown.
pub fn ends_session(wparam: usize, lparam: usize) -> bool {
    wparam != 0 && lparam & ENDSESSION_CLOSEAPP == 0
}

/// What the notifications have said so far.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SessionFlags {
    pub asleep: bool,
    pub locked: bool,
}

impl SessionFlags {
    pub fn apply(self, event: SessionEvent) -> Self {
        match event {
            SessionEvent::Locked => Self {
                locked: true,
                ..self
            },
            SessionEvent::Unlocked => Self {
                locked: false,
                ..self
            },
            SessionEvent::Suspended => Self {
                asleep: true,
                ..self
            },
            SessionEvent::Resumed => Self {
                asleep: false,
                ..self
            },
        }
    }

    /// Asleep wins over locked: a device that is asleep is usually locked too.
    pub fn state(self) -> SessionState {
        if self.asleep {
            SessionState::Asleep
        } else if self.locked {
            SessionState::Locked
        } else {
            SessionState::Active
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_is_whole_seconds() {
        assert_eq!(idle_seconds(10_000, 10_999), 0);
        assert_eq!(idle_seconds(10_000, 13_500), 3);
        assert_eq!(idle_seconds(5, 5), 0);
    }

    #[test]
    fn idle_survives_the_tick_counter_wrapping() {
        assert_eq!(idle_seconds(u32::MAX - 1_999, 1_000), 3);
    }

    #[test]
    fn the_session_flag_zero_is_locked() {
        assert!(session_flags_locked(0));
        assert!(!session_flags_locked(1));
        assert!(!session_flags_locked(-1), "unknown");
    }

    #[test]
    fn session_messages_map_to_events() {
        assert_eq!(session_event(0x7), Some(SessionEvent::Locked));
        assert_eq!(session_event(0x8), Some(SessionEvent::Unlocked));
        assert_eq!(session_event(0x5), None, "logon");
    }

    #[test]
    fn a_logoff_notification_ends_the_session() {
        assert!(session_logoff(0x6));
        assert!(!session_logoff(0x7), "lock");
        assert!(!session_logoff(0x4), "remote disconnect");
    }

    #[test]
    fn end_session_counts_only_when_it_is_going_ahead() {
        let logoff = 0x8000_0000;
        let shutdown = 0;
        assert!(ends_session(1, logoff));
        assert!(ends_session(1, shutdown));
        assert!(!ends_session(0, logoff), "another app vetoed it");
        assert!(!ends_session(1, 0x1), "an installer closing the app");
        assert!(ends_session(1, logoff | 0x4000_0000), "critical");
    }

    #[test]
    fn power_messages_map_to_events() {
        assert_eq!(power_event(0x4), Some(SessionEvent::Suspended));
        assert_eq!(power_event(0x7), Some(SessionEvent::Resumed));
        assert_eq!(power_event(0x12), Some(SessionEvent::Resumed));
        assert_eq!(power_event(0xA), None, "power status change");
    }

    #[test]
    fn events_move_the_state() {
        let mut flags = SessionFlags::default();
        assert_eq!(flags.state(), SessionState::Active);
        flags = flags.apply(SessionEvent::Locked);
        assert_eq!(flags.state(), SessionState::Locked);
        flags = flags.apply(SessionEvent::Suspended);
        assert_eq!(flags.state(), SessionState::Asleep, "asleep wins");
        flags = flags.apply(SessionEvent::Resumed);
        assert_eq!(flags.state(), SessionState::Locked, "still locked on wake");
        flags = flags.apply(SessionEvent::Unlocked);
        assert_eq!(flags.state(), SessionState::Active);
    }

    #[test]
    fn repeated_events_are_harmless() {
        let flags = SessionFlags::default()
            .apply(SessionEvent::Resumed)
            .apply(SessionEvent::Unlocked);
        assert_eq!(flags.state(), SessionState::Active);
    }
}
