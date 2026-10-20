//! Watching the capture permissions (AGT-07, CAP-08).
//!
//! The agent reports the permissions it has as a `permission_change` event whenever
//! they change (raw state only; the server decides what is Tamper, STS rule 2) and
//! asks the person to fix a missing one with a notification that repeats while they
//! are working, next to the warning the tray already shows.
//!
//! Two sources: the OS's own answer, and capture failures. macOS can keep answering
//! "granted" after Screen Recording is revoked (spike #13), so a capture that fails
//! for lack of permission twice in a row counts as the permission being off until a
//! capture works again.
//!
//! What counts as missing is what this person's collection needs (`Required`), the
//! same rule the server applies (`internal.capture_needs`), so the tray, the prompt
//! and the Tamper status agree. A person who fixes a permission and finds the warning
//! still up has three ways out, none of them waiting for the next check-in: the OS
//! answer going from off to on, a test capture that works (onboarding's "Fix" flow),
//! or the permission no longer being needed.

use chrono::{DateTime, Duration, Utc};

use crate::activity::ActivityPolicy;
use crate::capture::{CapturePolicy, ScreenshotMode};
use crate::contracts::{PermissionState, Permissions, ShiftState};
use crate::platform::{CaptureError, Platform};

/// CAP-08: this many permission failures in a row report the permission as missing.
pub const FAILURES_FOR_MISSING: u32 = 2;

/// How often a missing permission is asked about again while the person is working.
pub const PROMPT_EVERY: Duration = Duration::minutes(15);

/// A permission that stops capture. `Unsupported` is not one: nothing the person
/// can do about it.
pub fn blocks(state: &PermissionState) -> bool {
    matches!(
        state,
        PermissionState::Denied | PermissionState::NotDetermined | PermissionState::Restricted
    )
}

/// What this person's collection needs from the OS (CAP-02, CAP-05, ACT-03):
/// Screen Recording for screenshots, and for window titles (on macOS they need it
/// too); the camera only while the webcam is on. A permission nothing uses is not
/// missing, so it is neither asked for nor Tamper.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Required {
    pub screen: bool,
    pub camera: bool,
}

impl Required {
    /// From the effective policies (what the person acknowledged and the org
    /// allows; nothing before they acknowledge a notice).
    pub fn for_collection(capture: &CapturePolicy, activity: &ActivityPolicy) -> Self {
        Self {
            screen: capture.screenshots != ScreenshotMode::Off
                || (activity.sampling && activity.window_titles),
            camera: capture.webcam,
        }
    }
}

/// A notification to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub title: String,
    pub body: String,
}

/// What one look at the permissions found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Poll {
    /// The permissions to report as a `permission_change` event: they changed
    /// since the last report (or nothing has been reported yet).
    pub report: Option<Permissions>,
    /// A notification to show now.
    pub prompt: Option<Prompt>,
}

#[derive(Debug, Default)]
pub struct PermissionMonitor {
    screen_failures: u32,
    camera_failures: u32,
    /// What the OS said last time, to notice a permission being switched back on.
    last_os: Option<Permissions>,
    reported: Option<Permissions>,
    last_prompt: Option<DateTime<Utc>>,
}

impl PermissionMonitor {
    /// A capture finished. Only the kinds that were attempted count (`screen`,
    /// `camera`); a permission failure adds one, a success clears it, any other
    /// failure (camera busy, no camera) says nothing about permissions.
    pub fn capture_finished(
        &mut self,
        screen: Option<&Option<CaptureError>>,
        camera: Option<&Option<CaptureError>>,
    ) {
        let count = |failures: &mut u32, error: &Option<CaptureError>| match error {
            Some(CaptureError::PermissionMissing) => *failures += 1,
            Some(_) => {}
            None => *failures = 0,
        };
        if let Some(error) = screen {
            count(&mut self.screen_failures, error);
        }
        if let Some(error) = camera {
            count(&mut self.camera_failures, error);
        }
    }

    /// The OS's answer, corrected by what captures have shown.
    pub fn effective(&self, os: Permissions) -> Permissions {
        let mut permissions = os;
        if self.screen_failures >= FAILURES_FOR_MISSING && !blocks(&permissions.screen) {
            permissions.screen = PermissionState::Denied;
        }
        if self.camera_failures >= FAILURES_FOR_MISSING && !blocks(&permissions.camera) {
            permissions.camera = PermissionState::Denied;
        }
        permissions
    }

    /// What the tray warns about: `effective`, with a permission this person's
    /// collection doesn't need shown as `Unsupported` (nothing for them to fix), so
    /// the warning and "Capture blocked" match what the server counts as Tamper.
    pub fn for_tray(&self, os: Permissions, required: Required) -> Permissions {
        let mut permissions = self.effective(os);
        if !required.screen {
            permissions.screen = PermissionState::Unsupported;
        }
        if !required.camera {
            permissions.camera = PermissionState::Unsupported;
        }
        permissions
    }

    /// One look: what to report and whether to ask. Call every few seconds.
    /// Reports from the first look after launch, once signed in, then on changes.
    pub fn poll(
        &mut self,
        platform: &dyn Platform,
        required: Required,
        signed_in: bool,
        shift: ShiftState,
        now: DateTime<Utc>,
    ) -> Poll {
        let os = platform.permissions();
        // Switched back on by the person: forget the failures from before, so the
        // warning doesn't wait for the next capture to go away.
        if let Some(before) = &self.last_os {
            if blocks(&before.screen) && !blocks(&os.screen) {
                self.screen_failures = 0;
            }
            if blocks(&before.camera) && !blocks(&os.camera) {
                self.camera_failures = 0;
            }
        }
        // Nothing needs it any more (the org turned a setting off): failures from
        // when it did must not come back with the setting.
        if !required.screen {
            self.screen_failures = 0;
        }
        if !required.camera {
            self.camera_failures = 0;
        }
        self.last_os = Some(os.clone());
        let permissions = self.effective(os);

        let report = (signed_in && self.reported.as_ref() != Some(&permissions)).then(|| {
            self.reported = Some(permissions.clone());
            permissions.clone()
        });

        let missing = missing_names(&permissions, required);
        let prompt = match shift {
            // Nothing is expected of the person off shift, and a later shift asks
            // from the start.
            ShiftState::OffShift => {
                self.last_prompt = None;
                None
            }
            _ if missing.is_empty() => {
                self.last_prompt = None;
                None
            }
            // A break or a pause collects nothing; ask again once work resumes.
            ShiftState::OnBreak | ShiftState::Paused => None,
            ShiftState::Working => {
                let due = self
                    .last_prompt
                    .is_none_or(|last| now >= last + PROMPT_EVERY || now < last);
                due.then(|| {
                    self.last_prompt = Some(now);
                    prompt_for(&missing)
                })
            }
        };
        Poll { report, prompt }
    }

    /// The report from the last `poll` couldn't be queued: report it again next time.
    pub fn report_failed(&mut self) {
        self.reported = None;
    }

    /// Another person is about to sign in on this device: they get the permissions
    /// reported afresh, and asked about from the start.
    pub fn reset(&mut self) {
        self.reported = None;
        self.last_prompt = None;
    }
}

fn missing_names(permissions: &Permissions, required: Required) -> Vec<&'static str> {
    let mut names = Vec::new();
    if required.screen && blocks(&permissions.screen) {
        names.push("Screen Recording");
    }
    if required.camera && blocks(&permissions.camera) {
        names.push("Camera");
    }
    names
}

fn prompt_for(missing: &[&str]) -> Prompt {
    let (verb, pronoun) = if missing.len() == 1 {
        ("is", "it")
    } else {
        ("are", "them")
    };
    Prompt {
        title: format!("{} {verb} off", missing.join(" and ")),
        body: format!(
            "Check-ins can't be captured until you turn {pronoun} on, and your manager sees \"Capture blocked\". Click the AI Proctor icon in the menu bar and choose Fix."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::FakePlatform;

    const NEEDS_BOTH: Required = Required {
        screen: true,
        camera: true,
    };

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn deny_screen(fake: &FakePlatform) {
        fake.update(|s| s.permissions.screen = PermissionState::Denied);
    }

    fn grant_screen(fake: &FakePlatform) {
        fake.update(|s| s.permissions.screen = PermissionState::Granted);
    }

    #[test]
    fn the_first_look_reports_and_an_unchanged_one_does_not() {
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let first = m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::Working,
            t("2026-10-20T09:00:00Z"),
        );
        assert_eq!(
            first.report,
            Some(Permissions {
                screen: PermissionState::Granted,
                camera: PermissionState::Granted
            })
        );
        let again = m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::Working,
            t("2026-10-20T09:00:05Z"),
        );
        assert_eq!(again, Poll::default());
    }

    #[test]
    fn nothing_is_reported_before_sign_in() {
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        assert_eq!(
            m.poll(&fake, NEEDS_BOTH, false, ShiftState::OffShift, now)
                .report,
            None
        );
        assert!(m
            .poll(&fake, NEEDS_BOTH, true, ShiftState::OffShift, now)
            .report
            .is_some());
    }

    #[test]
    fn a_revoked_permission_is_reported_at_once_and_so_is_its_return() {
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let t0 = t("2026-10-20T09:00:00Z");
        m.poll(&fake, NEEDS_BOTH, true, ShiftState::Working, t0);

        deny_screen(&fake);
        let revoked = m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::Working,
            t0 + Duration::seconds(5),
        );
        assert_eq!(revoked.report.unwrap().screen, PermissionState::Denied);

        grant_screen(&fake);
        let back = m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::Working,
            t0 + Duration::seconds(10),
        );
        assert_eq!(back.report.unwrap().screen, PermissionState::Granted);
    }

    #[test]
    fn a_reset_reports_and_asks_again_for_the_next_person() {
        let fake = FakePlatform::default();
        deny_screen(&fake);
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        let first = m.poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now);
        assert!(first.report.is_some() && first.prompt.is_some());
        m.reset();
        let next = m.poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now);
        assert!(next.report.is_some() && next.prompt.is_some());
    }

    #[test]
    fn a_report_that_could_not_be_queued_is_tried_again() {
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        assert!(m
            .poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now)
            .report
            .is_some());
        m.report_failed();
        assert!(m
            .poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now)
            .report
            .is_some());
    }

    #[test]
    fn a_missing_permission_is_asked_about_at_once_then_every_quarter_hour_while_working() {
        let fake = FakePlatform::default();
        deny_screen(&fake);
        let mut m = PermissionMonitor::default();
        let t0 = t("2026-10-20T09:00:00Z");

        let first = m
            .poll(&fake, NEEDS_BOTH, true, ShiftState::Working, t0)
            .prompt
            .unwrap();
        assert_eq!(first.title, "Screen Recording is off");
        assert!(first.body.contains("Capture blocked"));

        for secs in [5, 60, 14 * 60] {
            assert_eq!(
                m.poll(
                    &fake,
                    NEEDS_BOTH,
                    true,
                    ShiftState::Working,
                    t0 + Duration::seconds(secs)
                )
                .prompt,
                None,
                "no nagging at {secs} s"
            );
        }
        assert!(m
            .poll(
                &fake,
                NEEDS_BOTH,
                true,
                ShiftState::Working,
                t0 + Duration::minutes(15)
            )
            .prompt
            .is_some());
        assert_eq!(
            m.poll(
                &fake,
                NEEDS_BOTH,
                true,
                ShiftState::Working,
                t0 + Duration::minutes(16)
            )
            .prompt,
            None
        );
    }

    #[test]
    fn both_missing_are_named_together() {
        let fake = FakePlatform::default();
        fake.update(|s| {
            s.permissions.screen = PermissionState::Denied;
            s.permissions.camera = PermissionState::NotDetermined;
        });
        let mut m = PermissionMonitor::default();
        let p = m
            .poll(
                &fake,
                NEEDS_BOTH,
                true,
                ShiftState::Working,
                t("2026-10-20T09:00:00Z"),
            )
            .prompt
            .unwrap();
        assert_eq!(p.title, "Screen Recording and Camera are off");
    }

    #[test]
    fn the_camera_only_counts_while_the_webcam_setting_is_on() {
        let fake = FakePlatform::default();
        fake.update(|s| s.permissions.camera = PermissionState::Denied);
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        let no_webcam = Required {
            screen: true,
            camera: false,
        };
        assert_eq!(
            m.poll(&fake, no_webcam, true, ShiftState::Working, now)
                .prompt,
            None
        );
        assert!(m
            .poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now)
            .prompt
            .is_some());
    }

    #[test]
    fn nothing_the_person_can_fix_is_not_a_prompt() {
        let fake = FakePlatform::default();
        fake.update(|s| {
            s.permissions.screen = PermissionState::Unsupported;
            s.permissions.camera = PermissionState::Unsupported;
        });
        let mut m = PermissionMonitor::default();
        let p = m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::Working,
            t("2026-10-20T09:00:00Z"),
        );
        assert_eq!(p.prompt, None);
        assert!(p.report.is_some(), "still reported, raw");
    }

    #[test]
    fn no_prompt_off_shift_on_a_break_or_in_a_pause_and_the_next_shift_asks_at_once() {
        let fake = FakePlatform::default();
        deny_screen(&fake);
        let mut m = PermissionMonitor::default();
        let t0 = t("2026-10-20T09:00:00Z");

        for (i, shift) in [
            ShiftState::OffShift,
            ShiftState::OnBreak,
            ShiftState::Paused,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                m.poll(
                    &fake,
                    NEEDS_BOTH,
                    true,
                    shift,
                    t0 + Duration::seconds(i as i64)
                )
                .prompt,
                None
            );
        }
        // Back at work after the break: asked now.
        assert!(m
            .poll(
                &fake,
                NEEDS_BOTH,
                true,
                ShiftState::Working,
                t0 + Duration::seconds(10)
            )
            .prompt
            .is_some());
        // Clock out, clock in again 5 minutes later: asked again straight away.
        m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::OffShift,
            t0 + Duration::minutes(3),
        );
        assert!(m
            .poll(
                &fake,
                NEEDS_BOTH,
                true,
                ShiftState::Working,
                t0 + Duration::minutes(5)
            )
            .prompt
            .is_some());
    }

    #[test]
    fn once_fixed_the_next_revoke_asks_at_once() {
        let fake = FakePlatform::default();
        deny_screen(&fake);
        let mut m = PermissionMonitor::default();
        let t0 = t("2026-10-20T09:00:00Z");
        assert!(m
            .poll(&fake, NEEDS_BOTH, true, ShiftState::Working, t0)
            .prompt
            .is_some());
        grant_screen(&fake);
        assert_eq!(
            m.poll(
                &fake,
                NEEDS_BOTH,
                true,
                ShiftState::Working,
                t0 + Duration::minutes(1)
            )
            .prompt,
            None
        );
        deny_screen(&fake);
        assert!(m
            .poll(
                &fake,
                NEEDS_BOTH,
                true,
                ShiftState::Working,
                t0 + Duration::minutes(2)
            )
            .prompt
            .is_some());
    }

    #[test]
    fn two_permission_failures_in_a_row_override_a_stale_granted() {
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let failed = Some(CaptureError::PermissionMissing);
        m.capture_finished(Some(&failed), Some(&None));
        assert_eq!(
            m.effective(fake.permissions()).screen,
            PermissionState::Granted
        );
        m.capture_finished(Some(&failed), Some(&None));
        let effective = m.effective(fake.permissions());
        assert_eq!(effective.screen, PermissionState::Denied);
        assert_eq!(effective.camera, PermissionState::Granted);

        m.capture_finished(Some(&None), Some(&None));
        assert_eq!(
            m.effective(fake.permissions()).screen,
            PermissionState::Granted
        );
    }

    #[test]
    fn switching_it_back_on_clears_the_failures_at_once() {
        let fake = FakePlatform::default();
        deny_screen(&fake);
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        m.poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now);
        let failed = Some(CaptureError::PermissionMissing);
        m.capture_finished(Some(&failed), None);
        m.capture_finished(Some(&failed), None);

        grant_screen(&fake);
        let back = m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::Working,
            now + Duration::seconds(5),
        );
        assert_eq!(back.report.unwrap().screen, PermissionState::Granted);
    }

    #[test]
    fn other_capture_failures_say_nothing_about_permissions() {
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let busy = Some(CaptureError::CameraBusy);
        for _ in 0..5 {
            m.capture_finished(None, Some(&busy));
        }
        assert_eq!(
            m.effective(fake.permissions()).camera,
            PermissionState::Granted
        );
        // And a capture that wasn't attempted doesn't clear a count either.
        let denied = Some(CaptureError::PermissionMissing);
        m.capture_finished(Some(&denied), None);
        m.capture_finished(Some(&denied), None);
        m.capture_finished(None, None);
        assert_eq!(
            m.effective(fake.permissions()).screen,
            PermissionState::Denied
        );
    }

    #[test]
    fn the_failure_override_is_what_gets_reported() {
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        m.poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now);
        let failed = Some(CaptureError::PermissionMissing);
        m.capture_finished(Some(&failed), None);
        m.capture_finished(Some(&failed), None);
        let p = m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::Working,
            now + Duration::seconds(5),
        );
        assert_eq!(p.report.unwrap().screen, PermissionState::Denied);
        assert!(p.prompt.is_some());
    }

    fn collection(
        screenshots: ScreenshotMode,
        webcam: bool,
        sampling: bool,
        titles: bool,
    ) -> Required {
        Required::for_collection(
            &CapturePolicy {
                screenshots,
                webcam,
                ..CapturePolicy::default()
            },
            &ActivityPolicy {
                sampling,
                window_titles: titles,
                ..ActivityPolicy::default()
            },
        )
    }

    #[test]
    fn screen_recording_is_needed_for_screenshots_and_for_window_titles() {
        use ScreenshotMode::{Blurred, Full, Off};
        let screen = |r: Required| r.screen;
        assert!(screen(collection(Full, false, false, false)));
        assert!(screen(collection(Blurred, false, false, false)));
        assert!(
            screen(collection(Off, false, true, true)),
            "titles need it on macOS"
        );
        assert!(
            !screen(collection(Off, false, true, false)),
            "the app name alone doesn't"
        );
        assert!(
            !screen(collection(Off, false, false, true)),
            "titles aren't read when sampling is off"
        );
        assert!(!screen(collection(Off, false, false, false)));
        assert!(collection(Off, true, false, false).camera);
        assert!(!collection(Full, false, true, true).camera);
        assert_eq!(
            Required::for_collection(&CapturePolicy::off(), &ActivityPolicy::off()),
            Required {
                screen: false,
                camera: false
            },
            "nothing acknowledged yet: nothing is needed"
        );
    }

    #[test]
    fn a_screen_permission_nothing_uses_is_neither_asked_for_nor_warned_about() {
        let fake = FakePlatform::default();
        deny_screen(&fake);
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        let nothing = Required {
            screen: false,
            camera: true,
        };
        let p = m.poll(&fake, nothing, true, ShiftState::Working, now);
        assert_eq!(p.prompt, None);
        assert_eq!(
            p.report.unwrap().screen,
            PermissionState::Denied,
            "the report stays raw: the server decides"
        );
        assert_eq!(
            m.for_tray(fake.permissions(), nothing).screen,
            PermissionState::Unsupported,
            "and the tray has nothing to show"
        );
        assert_eq!(
            m.for_tray(fake.permissions(), NEEDS_BOTH).screen,
            PermissionState::Denied
        );
        // The setting comes back on: asked at once.
        assert!(m
            .poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now)
            .prompt
            .is_some());
    }

    #[test]
    fn failures_from_before_a_setting_was_turned_off_do_not_return_with_it() {
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        let failed = Some(CaptureError::PermissionMissing);
        m.capture_finished(Some(&failed), Some(&failed));
        m.capture_finished(Some(&failed), Some(&failed));
        assert_eq!(
            m.effective(fake.permissions()).camera,
            PermissionState::Denied
        );

        let no_camera = Required {
            screen: true,
            camera: false,
        };
        m.poll(&fake, no_camera, true, ShiftState::Working, now);
        m.poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now);
        let back = m.effective(fake.permissions());
        assert_eq!(
            back.camera,
            PermissionState::Granted,
            "the camera starts clean"
        );
        assert_eq!(
            back.screen,
            PermissionState::Denied,
            "Screen Recording was needed throughout: still counted"
        );
    }

    #[test]
    fn a_stale_denied_is_cleared_by_a_capture_that_works_without_the_os_changing_its_answer() {
        // The OS said "granted" the whole time (so the off-to-on rule never fires),
        // two captures failed, and a test capture (the Fix flow) then works.
        let fake = FakePlatform::default();
        let mut m = PermissionMonitor::default();
        let now = t("2026-10-20T09:00:00Z");
        let failed = Some(CaptureError::PermissionMissing);
        m.capture_finished(Some(&failed), None);
        m.capture_finished(Some(&failed), None);
        let p = m.poll(&fake, NEEDS_BOTH, true, ShiftState::Working, now);
        assert_eq!(p.report.unwrap().screen, PermissionState::Denied);
        assert!(p.prompt.is_some());

        m.capture_finished(Some(&None), None);
        let p = m.poll(
            &fake,
            NEEDS_BOTH,
            true,
            ShiftState::Working,
            now + Duration::seconds(5),
        );
        assert_eq!(p.report.unwrap().screen, PermissionState::Granted);
        assert_eq!(
            m.for_tray(fake.permissions(), NEEDS_BOTH).screen,
            PermissionState::Granted,
            "the banner is gone"
        );
        // The next failed capture starts a fresh count.
        m.capture_finished(Some(&failed), None);
        assert_eq!(
            m.effective(fake.permissions()).screen,
            PermissionState::Granted
        );
    }
}
