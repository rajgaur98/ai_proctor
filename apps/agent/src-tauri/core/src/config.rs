//! What the server tells the agent to run with (`agent_config`, #29): org policy
//! and the person's shift schedule. Fetched when the device attaches and again
//! whenever the heartbeat reports a new `policy_version`.

use chrono::{Duration, NaiveTime};
use serde::Deserialize;
use serde_json::Value;

use crate::contracts::NoticeBody;
use crate::session::SessionPolicy;
use crate::shift::Shift;

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

    /// CAP-05: the org's webcam setting; on unless the org turned it off. The same
    /// default the server uses when deciding whether a missing camera permission counts.
    pub fn webcam_enabled(&self) -> bool {
        self.policy["webcam"].as_bool().unwrap_or(true)
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
            auto_clock_in: self.policy["auto_clock_in"]
                .as_bool()
                .unwrap_or(defaults.auto_clock_in),
            // SHF-04.
            forgotten_clock_out_after: self.policy["forgotten_clock_out_min"]
                .as_i64()
                .filter(|m| (5..=24 * 60).contains(m))
                .map(Duration::minutes)
                .unwrap_or(defaults.forgotten_clock_out_after),
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
            json!({ "forgotten_clock_out_min": 1 }),
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
}
