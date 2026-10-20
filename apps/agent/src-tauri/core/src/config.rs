//! What the server tells the agent to run with (`agent_config`, #29): org policy
//! and the person's shift schedule. Fetched when the device attaches and again
//! whenever the heartbeat reports a new `policy_version`.
//!
//! `policy` is the org's policy with the collection keys (`screenshots`, `webcam`,
//! `window_titles`, `excluded_apps`, `activity_sampling`) replaced by what this
//! person has acknowledged (#48, AGT-05), so those keys are what may run. Every key
//! is read here into the typed policy the module that uses it takes (#144), with the
//! ranges `update_policy` enforces on the server (`packages/contracts/src/policy.ts`):
//! a number outside its range is clamped, a key that is missing or of the wrong type
//! (an org that never set it) falls back to the built-in default.

use chrono::{Duration, NaiveTime};
use serde::Deserialize;
use serde_json::Value;

use crate::activity::ActivityPolicy;
use crate::capture::{default_excluded_apps, CapturePolicy, ScreenshotMode};
use crate::checkin::{CardPolicy, DEFAULT_COUNTDOWN, MAX_COUNTDOWN, MIN_COUNTDOWN};
use crate::contracts::NoticeBody;
use crate::presence::DEFAULT_IDLE_THRESHOLD;
use crate::scheduler::SchedulePolicy;
use crate::session::SessionPolicy;
use crate::shift::Shift;

/// Server ranges, in minutes unless noted (`POLICY_LIMITS`).
const CHECKIN_INTERVAL_MIN: (i64, i64) = (10, 240);
const CHECKIN_RESPONSE_S: (i64, i64) = (MIN_COUNTDOWN.num_seconds(), MAX_COUNTDOWN.num_seconds());
const IDLE_THRESHOLD_MIN: (i64, i64) = (3, 60);
const FORGOTTEN_CLOCK_OUT_MIN: (i64, i64) = (10, 120);

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct AgentConfig {
    pub policy: Value,
    pub policy_version: i64,
    pub timezone: String,
    pub shifts: Vec<ShiftConfig>,
    /// Projects the person can log to (PRJ-02), for the tray and the card.
    #[serde(default)]
    pub projects: Vec<ProjectConfig>,
    /// The monitoring notice (#48, AGT-04/05). Without one nothing may be collected.
    #[serde(default)]
    pub notice: Option<NoticeConfig>,
}

/// The org's current notice and where this person stands with it. The `policy` in
/// the same config already carries only the collection they have acknowledged.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct NoticeConfig {
    pub id: uuid::Uuid,
    pub version: i64,
    pub body: NoticeBody,
    /// This person acknowledged the current version.
    pub acknowledged: bool,
    /// The latest version they did acknowledge; null: none yet.
    pub acknowledged_version: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ProjectConfig {
    pub id: uuid::Uuid,
    pub name: String,
    pub client: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ShiftConfig {
    pub days: Vec<u8>,
    /// "HH:MM", local to `timezone`.
    pub start: String,
    pub end: String,
    pub timezone: String,
}

impl ShiftConfig {
    fn to_shift(&self) -> Option<Shift> {
        Some(Shift {
            days: self
                .days
                .iter()
                .copied()
                .filter(|d| (1..=7).contains(d))
                .collect(),
            start: NaiveTime::parse_from_str(&self.start, "%H:%M").ok()?,
            end: NaiveTime::parse_from_str(&self.end, "%H:%M").ok()?,
            tz: self.timezone.parse().ok()?,
        })
    }
}

impl AgentConfig {
    /// BRK-06 daily pause allowance in seconds (org default 60 min).
    pub fn pause_daily_cap_s(&self) -> i64 {
        self.policy["pause_daily_max_min"]
            .as_i64()
            .filter(|m| (0..=24 * 60).contains(m))
            .unwrap_or(60)
            * 60
    }

    /// A whole number under `key`, clamped into `(lo, hi)`; `default` when the key is
    /// missing or not a whole number.
    fn whole(&self, key: &str, (lo, hi): (i64, i64), default: i64) -> i64 {
        self.policy[key]
            .as_i64()
            .map_or(default, |v| v.clamp(lo, hi))
    }

    fn flag(&self, key: &str, default: bool) -> bool {
        self.policy[key].as_bool().unwrap_or(default)
    }

    /// CAP-05: the webcam setting; on unless it was turned off. The same default the
    /// server uses when deciding whether a missing camera permission counts.
    pub fn webcam_enabled(&self) -> bool {
        self.flag("webcam", true)
    }

    /// CAP-01..05: what a passed check-in captures. Screenshots default to full (the
    /// server's default too); `excluded_apps` replaces the built-in password-manager
    /// list when the config has one, so an admin who empties the list means it
    /// (CAP-04: the defaults live in the server's presets, not here).
    pub fn capture_policy(&self) -> CapturePolicy {
        CapturePolicy {
            screenshots: match self.policy["screenshots"].as_str() {
                Some("blurred") => ScreenshotMode::Blurred,
                Some("off") => ScreenshotMode::Off,
                _ => ScreenshotMode::Full,
            },
            webcam: self.webcam_enabled(),
            excluded_apps: self.excluded_apps(),
        }
    }

    /// ACT-02, ACT-03: activity sampling, window titles and the apps whose titles
    /// are never kept. Both default to on.
    pub fn activity_policy(&self) -> ActivityPolicy {
        ActivityPolicy {
            sampling: self.flag("activity_sampling", true),
            window_titles: self.flag("window_titles", true),
            excluded_apps: self.excluded_apps(),
        }
    }

    /// The list under `excluded_apps` (names only, blanks dropped); the built-in
    /// one when the key is missing or not a list.
    fn excluded_apps(&self) -> Vec<String> {
        match self.policy["excluded_apps"].as_array() {
            Some(apps) => apps
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(String::from)
                .collect(),
            None => default_excluded_apps(),
        }
    }

    /// CHK-01: the draw range for the next check-in, 10-240 min each, default 20-90.
    /// A minimum above the maximum (the server refuses it) pins the draw to the
    /// minimum, so check-ins are never more frequent than the org asked for.
    pub fn schedule_policy(&self) -> SchedulePolicy {
        let defaults = SchedulePolicy::default();
        let min = self.whole(
            "checkin_min_interval_min",
            CHECKIN_INTERVAL_MIN,
            defaults.min.num_minutes(),
        );
        let max = self
            .whole(
                "checkin_max_interval_min",
                CHECKIN_INTERVAL_MIN,
                defaults.max.num_minutes(),
            )
            .max(min);
        SchedulePolicy {
            min: Duration::minutes(min),
            max: Duration::minutes(max),
        }
    }

    /// CHK-13: how long the card stays up, 30-300 s, default 90.
    pub fn card_policy(&self) -> CardPolicy {
        CardPolicy {
            countdown: Duration::seconds(self.whole(
                "checkin_response_s",
                CHECKIN_RESPONSE_S,
                DEFAULT_COUNTDOWN.num_seconds(),
            )),
            ..CardPolicy::default()
        }
    }

    /// STS: how long without input before Idle, 3-60 min, default 10 (the server's
    /// default when the key is missing).
    pub fn idle_threshold(&self) -> Duration {
        Duration::minutes(self.whole(
            "idle_threshold_min",
            IDLE_THRESHOLD_MIN,
            DEFAULT_IDLE_THRESHOLD.num_minutes(),
        ))
    }

    /// Session rules from the config. Unknown or bad values fall back to the
    /// defaults; a shift that doesn't parse is skipped (and logged).
    pub fn session_policy(&self) -> SessionPolicy {
        let defaults = SessionPolicy::default();
        let shifts = self
            .shifts
            .iter()
            .filter_map(|s| {
                let shift = s.to_shift();
                if shift.is_none() {
                    tracing::warn!(?s, "shift from the server ignored");
                }
                shift
            })
            .collect();
        SessionPolicy {
            // SHF-03: org setting; off unless the org turns it on.
            auto_clock_in: self.flag("auto_clock_in", defaults.auto_clock_in),
            // SHF-04: 10-120 min.
            forgotten_clock_out_after: Duration::minutes(self.whole(
                "forgotten_clock_out_min",
                FORGOTTEN_CLOCK_OUT_MIN,
                defaults.forgotten_clock_out_after.num_minutes(),
            )),
            shifts,
            timezone: self.timezone.parse().unwrap_or(defaults.timezone),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(policy: Value, shifts: Value) -> AgentConfig {
        serde_json::from_value(json!({
            "policy": policy, "policy_version": 3, "timezone": "America/Los_Angeles", "shifts": shifts
        }))
        .unwrap()
    }

    #[test]
    fn shifts_and_policy_become_the_session_rules() {
        let c = config(
            json!({ "auto_clock_in": true, "forgotten_clock_out_min": 45 }),
            json!([
                { "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:30", "timezone": "America/Los_Angeles" },
                { "days": [6], "start": "22:00", "end": "06:00", "timezone": "America/Los_Angeles" }
            ]),
        );
        let p = c.session_policy();
        assert!(p.auto_clock_in);
        assert_eq!(p.forgotten_clock_out_after, Duration::minutes(45));
        assert_eq!(p.shifts.len(), 2);
        assert_eq!(
            p.shifts[1].start,
            NaiveTime::from_hms_opt(22, 0, 0).unwrap()
        );
        assert_eq!(p.shifts[1].tz, chrono_tz::America::Los_Angeles);
    }

    #[test]
    fn the_notice_arrives_with_the_config_and_is_optional() {
        let without = config(json!({}), json!([]));
        assert!(without.notice.is_none());

        let with: AgentConfig = serde_json::from_value(json!({
            "policy": { "webcam": false }, "policy_version": 4, "timezone": "UTC", "shifts": [],
            "notice": {
                "id": "0190f5b0-0000-7000-8000-0000000000a1", "version": 2,
                "acknowledged": false, "acknowledged_version": 1,
                "body": {
                    "intro": "Acme uses AI Proctor.",
                    "collected": "c", "when": "w", "who": "h", "retention": "r", "rights": "g"
                }
            }
        }))
        .unwrap();
        let notice = with.notice.unwrap();
        assert_eq!((notice.version, notice.acknowledged), (2, false));
        assert_eq!(notice.acknowledged_version, Some(1));
        assert_eq!(notice.body.intro.as_deref(), Some("Acme uses AI Proctor."));
        assert!(notice.body.grievance.is_none());
    }

    #[test]
    fn the_webcam_is_on_unless_the_org_turns_it_off() {
        assert!(config(json!({}), json!([])).webcam_enabled());
        assert!(config(json!({ "webcam": true }), json!([])).webcam_enabled());
        assert!(!config(json!({ "webcam": false }), json!([])).webcam_enabled());
        assert!(
            config(json!({ "webcam": "no" }), json!([])).webcam_enabled(),
            "a bad value falls back to the default"
        );
    }

    #[test]
    fn bad_values_fall_back_and_bad_shifts_are_skipped() {
        let c = config(
            json!({ "forgotten_clock_out_min": "soon", "auto_clock_in": "yes" }),
            json!([
                { "days": [1], "start": "9am", "end": "17:00", "timezone": "UTC" },
                { "days": [1], "start": "09:00", "end": "17:00", "timezone": "Mars/Base" },
                { "days": [2], "start": "09:00", "end": "17:00", "timezone": "UTC" }
            ]),
        );
        let p = c.session_policy();
        assert!(!p.auto_clock_in);
        assert_eq!(
            p.forgotten_clock_out_after,
            SessionPolicy::default().forgotten_clock_out_after
        );
        assert_eq!(p.shifts.len(), 1);
    }

    fn p(policy: Value) -> AgentConfig {
        config(policy, json!([]))
    }

    #[test]
    fn the_collection_keys_become_the_capture_and_activity_policies() {
        let c = p(json!({
            "screenshots": "blurred", "webcam": false, "window_titles": false,
            "excluded_apps": ["Slack", " Signal ", "", 7], "activity_sampling": false
        }));
        assert_eq!(
            c.capture_policy(),
            CapturePolicy {
                screenshots: ScreenshotMode::Blurred,
                webcam: false,
                excluded_apps: vec!["Slack".into(), "Signal".into()],
            }
        );
        assert_eq!(
            c.activity_policy(),
            ActivityPolicy {
                sampling: false,
                window_titles: false,
                excluded_apps: vec!["Slack".into(), "Signal".into()],
            }
        );
        assert_eq!(
            p(json!({ "screenshots": "off" }))
                .capture_policy()
                .screenshots,
            ScreenshotMode::Off
        );
        assert_eq!(
            p(json!({ "screenshots": "full" }))
                .capture_policy()
                .screenshots,
            ScreenshotMode::Full
        );
    }

    #[test]
    fn missing_or_wrongly_typed_collection_keys_fall_back_to_the_defaults() {
        for policy in [
            json!({}),
            json!(null),
            json!({
                "screenshots": "sometimes", "webcam": "yes", "window_titles": 1,
                "excluded_apps": "1Password", "activity_sampling": null
            }),
        ] {
            let c = p(policy);
            assert_eq!(c.capture_policy(), CapturePolicy::default());
            assert_eq!(c.activity_policy(), ActivityPolicy::default());
        }
    }

    #[test]
    fn an_empty_excluded_list_replaces_the_built_in_one() {
        let c = p(json!({ "excluded_apps": [] }));
        assert!(c.capture_policy().excluded_apps.is_empty());
        assert!(c.activity_policy().excluded_apps.is_empty());
    }

    #[test]
    fn check_in_intervals_are_clamped_and_never_inverted() {
        let range = |policy: Value| {
            let s = p(policy).schedule_policy();
            (s.min.num_minutes(), s.max.num_minutes())
        };
        assert_eq!(range(json!({})), (20, 90));
        assert_eq!(
            range(json!({ "checkin_min_interval_min": 45, "checkin_max_interval_min": 120 })),
            (45, 120),
            "the EU preset"
        );
        assert_eq!(
            range(json!({ "checkin_min_interval_min": 1, "checkin_max_interval_min": 999 })),
            (10, 240)
        );
        assert_eq!(
            range(json!({ "checkin_min_interval_min": 100, "checkin_max_interval_min": 30 })),
            (100, 100),
            "min above max: pinned to min"
        );
        assert_eq!(
            range(json!({ "checkin_min_interval_min": 100 })),
            (100, 100),
            "a lone minimum above the default maximum"
        );
        assert_eq!(
            range(json!({ "checkin_min_interval_min": "20", "checkin_max_interval_min": 12.5 })),
            (20, 90),
            "wrong types: defaults"
        );
    }

    #[test]
    fn the_response_window_idle_threshold_and_clock_out_are_clamped() {
        assert_eq!(p(json!({})).card_policy(), CardPolicy::default());
        let window = |v: Value| p(json!({ "checkin_response_s": v })).card_policy().window();
        assert_eq!(window(json!(45)), Duration::seconds(45));
        assert_eq!(window(json!(5)), Duration::seconds(30));
        assert_eq!(window(json!(900)), Duration::seconds(300));
        assert_eq!(window(json!("45")), Duration::seconds(90));

        let idle = |v: Value| p(json!({ "idle_threshold_min": v })).idle_threshold();
        assert_eq!(p(json!({})).idle_threshold(), Duration::minutes(10));
        assert_eq!(idle(json!(5)), Duration::minutes(5));
        assert_eq!(idle(json!(1)), Duration::minutes(3));
        assert_eq!(idle(json!(500)), Duration::minutes(60));
        assert_eq!(idle(json!(null)), Duration::minutes(10));

        let out = |v: Value| {
            p(json!({ "forgotten_clock_out_min": v }))
                .session_policy()
                .forgotten_clock_out_after
        };
        assert_eq!(out(json!(60)), Duration::minutes(60));
        assert_eq!(out(json!(1)), Duration::minutes(10));
        assert_eq!(out(json!(1000)), Duration::minutes(120));
        assert_eq!(out(json!(false)), Duration::minutes(30));
    }
}
