//! Activity sampling (#25; ACT-01..03, LLD `activity` module).
//!
//! Every few seconds while working, the frontmost app, window title and browser
//! domain are sampled; time is added up per app, title and domain within each
//! minute and sent as one `app_session` per bucket when the minute is over. Titles
//! are never kept for excluded apps, or at all when the org turns them off.

use chrono::{DateTime, Duration, DurationRound, Utc};
use serde_json::{json, Value};

use crate::capture::DEFAULT_EXCLUDED_APPS;
use crate::platform::Foreground;

/// How often the app samples (LLD: 5 s).
pub const SAMPLE_EVERY: std::time::Duration = std::time::Duration::from_secs(5);
/// A longer gap between samples (sleep, a stalled thread) isn't counted.
const MAX_GAP: Duration = Duration::seconds(15);

#[derive(Clone, Debug, PartialEq)]
pub struct ActivityPolicy {
    /// ACT-03: org setting; the EU preset turns titles off.
    pub window_titles: bool,
    /// ACT-02: the capture exclusion list (CAP-04); app name only for these.
    pub excluded_apps: Vec<String>,
}

impl Default for ActivityPolicy {
    fn default() -> Self {
        Self {
            window_titles: true,
            excluded_apps: DEFAULT_EXCLUDED_APPS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

/// One minute's time on one app / title / domain: an `app_session` event.
#[derive(Clone, Debug, PartialEq)]
pub struct AppSession {
    pub app: String,
    pub title: Option<String>,
    pub domain: Option<String>,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

impl AppSession {
    pub fn payload(&self) -> Value {
        json!({
            "app": self.app,
            "title": self.title,
            "domain": self.domain,
            "start": self.start,
            "end": self.end,
        })
    }
}

#[derive(Debug)]
struct Bucket {
    app: String,
    title: Option<String>,
    domain: Option<String>,
    first: DateTime<Utc>,
    ms: i64,
}

#[derive(Debug)]
pub struct Sampler {
    policy: ActivityPolicy,
    minute: Option<DateTime<Utc>>,
    buckets: Vec<Bucket>,
    last: Option<DateTime<Utc>>,
}

impl Sampler {
    pub fn new(policy: ActivityPolicy) -> Self {
        Self {
            policy,
            minute: None,
            buckets: Vec::new(),
            last: None,
        }
    }

    /// `foreground` was in front since the previous sample. Returns the buckets of
    /// minutes that are now over.
    pub fn sample(
        &mut self,
        now: DateTime<Utc>,
        foreground: Option<Foreground>,
    ) -> Vec<AppSession> {
        let Some(previous) = self.last.replace(now) else {
            return Vec::new();
        };
        if now <= previous || now - previous > MAX_GAP {
            return Vec::new();
        }
        let mut done = Vec::new();
        let mut from = previous;
        while from < now {
            let minute = floor_minute(from);
            if self.minute != Some(minute) {
                done.extend(self.flush());
                self.minute = Some(minute);
            }
            let to = now.min(minute + Duration::minutes(1));
            if let Some(fg) = &foreground {
                self.add(fg, from, (to - from).num_milliseconds());
            }
            from = to;
        }
        done
    }

    /// Working stopped (break, pause, clock-out, lock): send what was collected.
    /// The time since the last sample isn't counted.
    pub fn stop(&mut self) -> Vec<AppSession> {
        self.last = None;
        self.minute = None;
        self.flush()
    }

    fn add(&mut self, fg: &Foreground, at: DateTime<Utc>, ms: i64) {
        let excluded = self
            .policy
            .excluded_apps
            .iter()
            .any(|app| app.eq_ignore_ascii_case(&fg.app));
        let title = fg
            .title
            .as_deref()
            .filter(|_| self.policy.window_titles && !excluded)
            .map(|t| truncate(t, 500));
        let app = truncate(&fg.app, 200);
        let domain = fg.domain.as_deref().map(|d| truncate(d, 253));
        match self
            .buckets
            .iter_mut()
            .find(|b| b.app == app && b.title == title && b.domain == domain)
        {
            Some(bucket) => bucket.ms += ms,
            None => self.buckets.push(Bucket {
                app,
                title,
                domain,
                first: at,
                ms,
            }),
        }
    }

    fn flush(&mut self) -> Vec<AppSession> {
        let mut sessions: Vec<AppSession> = self
            .buckets
            .drain(..)
            .filter(|b| b.ms >= 1000)
            .map(|b| {
                let minute_end = floor_minute(b.first) + Duration::minutes(1);
                AppSession {
                    start: b.first,
                    end: (b.first + Duration::milliseconds(b.ms)).min(minute_end),
                    app: b.app,
                    title: b.title,
                    domain: b.domain,
                }
            })
            .collect();
        sessions.sort_by_key(|s| s.start);
        sessions
    }
}

fn floor_minute(t: DateTime<Utc>) -> DateTime<Utc> {
    t.duration_trunc(Duration::minutes(1)).unwrap_or(t)
}

fn truncate(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn fg(app: &str, title: Option<&str>, domain: Option<&str>) -> Option<Foreground> {
        Some(Foreground {
            app: app.into(),
            title: title.map(Into::into),
            domain: domain.map(Into::into),
        })
    }

    /// Samples every 5 s from `from` for `n` samples with the same app.
    fn run(s: &mut Sampler, from: &str, n: i64, app: Option<Foreground>) -> Vec<AppSession> {
        let start = t(from);
        (0..n)
            .flat_map(|i| s.sample(start + Duration::seconds(5 * i), app.clone()))
            .collect()
    }

    #[test]
    fn time_is_bucketed_per_minute_and_sent_when_the_minute_ends() {
        let mut s = Sampler::new(ActivityPolicy::default());
        let docs = fg("Safari", Some("Plan - Docs"), Some("docs.example.com"));
        // 10:00:10 .. 10:00:40 Safari, then Slack until 10:01:20.
        let mut out = run(&mut s, "2026-10-20T10:00:10Z", 7, docs.clone());
        out.extend(run(
            &mut s,
            "2026-10-20T10:00:45Z",
            8,
            fg("Slack", Some("general"), None),
        ));
        assert_eq!(out.len(), 2, "minute 10:00 is over: {out:?}");
        assert_eq!(out[0].app, "Safari");
        assert_eq!(out[0].domain.as_deref(), Some("docs.example.com"));
        assert_eq!(out[0].start, t("2026-10-20T10:00:10Z"));
        assert_eq!(out[0].end - out[0].start, Duration::seconds(30));
        assert_eq!(out[1].app, "Slack");
        assert_eq!(
            out[1].end,
            t("2026-10-20T10:01:00Z"),
            "never past the minute"
        );

        let rest = s.stop();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].start, t("2026-10-20T10:01:00Z"));
        assert_eq!(rest[0].end - rest[0].start, Duration::seconds(20));
    }

    #[test]
    fn every_bucket_stays_inside_its_minute() {
        let mut s = Sampler::new(ActivityPolicy::default());
        let mut out = run(&mut s, "2026-10-20T10:00:03Z", 60, fg("Xcode", None, None));
        out.extend(s.stop());
        for session in &out {
            assert_eq!(
                floor_minute(session.start),
                floor_minute(session.end - Duration::milliseconds(1))
            );
            assert!(session.end - session.start >= Duration::seconds(1));
        }
        let total: i64 = out.iter().map(|s| (s.end - s.start).num_seconds()).sum();
        assert_eq!(total, 295, "59 intervals of 5 s");
    }

    #[test]
    fn excluded_apps_and_the_org_setting_drop_titles() {
        let mut s = Sampler::new(ActivityPolicy::default());
        run(
            &mut s,
            "2026-10-20T10:00:00Z",
            3,
            fg("1Password", Some("Bank"), None),
        );
        let out = s.stop();
        assert_eq!(
            (out[0].app.as_str(), out[0].title.as_deref()),
            ("1Password", None)
        );

        let mut s = Sampler::new(ActivityPolicy {
            window_titles: false,
            ..ActivityPolicy::default()
        });
        run(
            &mut s,
            "2026-10-20T10:00:00Z",
            3,
            fg("Mail", Some("Re: salary"), Some("mail.example.com")),
        );
        let out = s.stop();
        assert_eq!(out[0].title, None);
        assert_eq!(
            out[0].domain.as_deref(),
            Some("mail.example.com"),
            "domains are always kept"
        );
    }

    #[test]
    fn gaps_and_unknown_foregrounds_are_not_counted() {
        let mut s = Sampler::new(ActivityPolicy::default());
        let mut out = s.sample(t("2026-10-20T10:00:00Z"), fg("Notes", None, None));
        out.extend(s.sample(t("2026-10-20T10:00:05Z"), fg("Notes", None, None)));
        // Asleep for a minute: not counted.
        out.extend(s.sample(t("2026-10-20T10:01:30Z"), fg("Notes", None, None)));
        out.extend(s.sample(t("2026-10-20T10:01:35Z"), None));
        out.extend(s.stop());
        let total: i64 = out.iter().map(|s| (s.end - s.start).num_seconds()).sum();
        assert_eq!(total, 5);
    }

    #[test]
    fn stop_forgets_the_open_interval() {
        let mut s = Sampler::new(ActivityPolicy::default());
        run(&mut s, "2026-10-20T10:00:00Z", 3, fg("Notes", None, None));
        assert_eq!(s.stop().len(), 1);
        assert!(s.stop().is_empty());
        assert!(s
            .sample(t("2026-10-20T10:00:20Z"), fg("Notes", None, None))
            .is_empty());
        assert!(
            s.stop().is_empty(),
            "the first sample after a stop only starts the clock"
        );
    }

    #[test]
    fn payload_matches_the_contract() {
        let session = AppSession {
            app: "Safari".into(),
            title: None,
            domain: Some("example.com".into()),
            start: t("2026-10-20T10:00:00Z"),
            end: t("2026-10-20T10:00:30Z"),
        };
        assert_eq!(
            session.payload(),
            json!({ "app": "Safari", "title": null, "domain": "example.com",
                    "start": "2026-10-20T10:00:00Z", "end": "2026-10-20T10:00:30Z" })
        );
    }
}
