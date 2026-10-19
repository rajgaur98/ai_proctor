//! Builds the `AgentStatus` the tray popover shows. Raw state only: the dashboard's
//! status (Active, Idle, Away…) is computed on the server, not here.

use crate::contracts::{AgentStatus, ShiftState};
use crate::platform::Platform;

pub fn agent_status(
    platform: &dyn Platform,
    shift: ShiftState,
    signed_in: bool,
    account_email: Option<String>,
    agent_version: &str,
) -> AgentStatus {
    AgentStatus {
        shift,
        signed_in,
        account_email,
        agent_version: agent_version.to_owned(),
        permissions: platform.permissions(),
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

        let status = agent_status(&fake, ShiftState::OffShift, false, None, "0.1.0");

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
            Some("lucas@acme.test".into()),
            "0.1.0",
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["shift"], "working");
        assert_eq!(json["permissions"]["screen"], "granted");
        assert_eq!(json["signed_in"], true);
        assert_eq!(json["account_email"], "lucas@acme.test");
    }
}
