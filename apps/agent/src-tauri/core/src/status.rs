//! Builds the `AgentStatus` the tray popover shows. Raw state only: the dashboard's
//! status (Active, Idle, Away…) is computed on the server, not here.

use crate::contracts::{AgentStatus, LastCheckin, MissedCheckin, ProjectRef, ShiftState};
use crate::platform::Platform;

/// Everything the tray shows beyond the platform's permissions (EMP-01).
#[derive(Clone, Debug, Default)]
pub struct Tray {
    pub account_email: Option<String>,
    pub clocked_in_at: Option<String>,
    pub phase_started_at: Option<String>,
    pub pause_ends_at: Option<String>,
    pub pause_planned_min: Option<u32>,
    pub worked_today_s: i64,
    pub pause_used_today_s: i64,
    pub pause_daily_cap_s: i64,
    pub project: Option<ProjectRef>,
    pub projects: Vec<ProjectRef>,
    pub last_checkin: Option<LastCheckin>,
    pub missed_checkin: Option<MissedCheckin>,
}

pub fn agent_status(
    platform: &dyn Platform,
    shift: ShiftState,
    signed_in: bool,
    agent_version: &str,
    tray: Tray,
) -> AgentStatus {
    AgentStatus {
        shift,
        signed_in,
        account_email: tray.account_email,
        agent_version: agent_version.to_owned(),
        permissions: platform.permissions(),
        clocked_in_at: tray.clocked_in_at,
        phase_started_at: tray.phase_started_at,
        pause_ends_at: tray.pause_ends_at,
        pause_planned_min: tray.pause_planned_min.map(i64::from),
        worked_today_s: tray.worked_today_s.max(0),
        pause_used_today_s: tray.pause_used_today_s.max(0),
        pause_daily_cap_s: tray.pause_daily_cap_s.max(0),
        project: tray.project,
        projects: tray.projects,
        last_checkin: tray.last_checkin,
        missed_checkin: tray.missed_checkin,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::PermissionState;
    use crate::fake::FakePlatform;

    #[test]
    fn reports_current_permissions_from_the_platform() {
        let fake = FakePlatform::default();
        fake.update(|s| s.permissions.screen = PermissionState::NotDetermined);

        let status = agent_status(&fake, ShiftState::OffShift, false, "0.1.0", Tray::default());

        assert_eq!(status.permissions.screen, PermissionState::NotDetermined);
        assert_eq!(status.permissions.camera, PermissionState::Granted);
        assert_eq!(status.shift, ShiftState::OffShift);
        assert_eq!(status.agent_version, "0.1.0");
    }

    #[test]
    fn serializes_to_the_contract_shape() {
        let status = agent_status(
            &FakePlatform::default(),
            ShiftState::Working,
            true,
            "0.1.0",
            Tray {
                account_email: Some("lucas@acme.test".into()),
                ..Tray::default()
            },
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["shift"], "working");
        assert_eq!(json["permissions"]["screen"], "granted");
        assert_eq!(json["signed_in"], true);
        assert_eq!(json["account_email"], "lucas@acme.test");
    }
}
