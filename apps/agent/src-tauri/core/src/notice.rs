//! The monitoring notice on this device (#48; AGT-04, AGT-05, EMP-05). The server
//! sends the current notice with every config and says what this person has
//! acknowledged. Nothing is collected, and clocking in is refused, until they have
//! acknowledged a notice. A newer version after that asks for a review but changes
//! nothing meanwhile: the policy in the config only carries the collection they
//! acknowledged.

use crate::config::NoticeConfig;
use crate::contracts::{NoticeContent, NoticeStatus};

#[derive(Debug, Default)]
pub struct NoticeState {
    current: Option<NoticeConfig>,
    /// The version the notice window was last opened for on its own, so closing it
    /// doesn't bring it straight back.
    prompted: Option<i64>,
}

impl NoticeState {
    pub fn update(&mut self, notice: Option<NoticeConfig>) {
        self.current = notice;
    }

    /// Signing out: the next person starts from nothing.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// May anything be collected for this person: they have acknowledged some version.
    pub fn collection_allowed(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|n| n.acknowledged_version.is_some())
    }

    pub fn id_and_version(&self) -> Option<(uuid::Uuid, i64)> {
        self.current.as_ref().map(|n| (n.id, n.version))
    }

    pub fn status(&self) -> Option<NoticeStatus> {
        self.current.as_ref().map(|n| NoticeStatus {
            version: n.version,
            acknowledged: n.acknowledged,
            required: n.acknowledged_version.is_none(),
        })
    }

    pub fn content(&self) -> Option<NoticeContent> {
        self.current.as_ref().map(|n| NoticeContent {
            version: n.version,
            acknowledged: n.acknowledged,
            body: n.body.clone(),
        })
    }

    /// True once per unacknowledged version: the notice window should open now.
    pub fn take_prompt(&mut self) -> bool {
        let Some(n) = self.current.as_ref().filter(|n| !n.acknowledged) else {
            return false;
        };
        if self.prompted == Some(n.version) {
            return false;
        }
        self.prompted = Some(n.version);
        true
    }
}

#[cfg(test)]
pub fn sample(version: i64, acknowledged: bool, acknowledged_version: Option<i64>) -> NoticeConfig {
    serde_json::from_value(serde_json::json!({
        "id": "0190f5b0-0000-7000-8000-0000000000a1",
        "version": version,
        "acknowledged": acknowledged,
        "acknowledged_version": acknowledged_version,
        "body": {
            "collected": "A screenshot when you pass a check-in.",
            "when": "Only while clocked in.",
            "who": "Your manager.",
            "retention": "30 days.",
            "rights": "See and export it."
        }
    }))
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_allowed_before_the_first_acknowledgement() {
        let mut state = NoticeState::default();
        assert!(!state.collection_allowed(), "no notice yet");
        state.update(Some(sample(1, false, None)));
        assert!(!state.collection_allowed());
        let status = state.status().unwrap();
        assert_eq!(
            (status.version, status.acknowledged, status.required),
            (1, false, true)
        );
        state.update(Some(sample(1, true, Some(1))));
        assert!(state.collection_allowed());
        assert!(!state.status().unwrap().required);
    }

    #[test]
    fn a_newer_version_asks_for_a_review_without_blocking() {
        let mut state = NoticeState::default();
        state.update(Some(sample(2, false, Some(1))));
        assert!(state.collection_allowed(), "version 1 was acknowledged");
        let status = state.status().unwrap();
        assert_eq!(
            (status.version, status.acknowledged, status.required),
            (2, false, false)
        );
        assert!(!state.content().unwrap().acknowledged);
    }

    #[test]
    fn the_window_opens_once_per_unacknowledged_version() {
        let mut state = NoticeState::default();
        assert!(!state.take_prompt(), "no notice");
        state.update(Some(sample(1, false, None)));
        assert!(state.take_prompt());
        assert!(!state.take_prompt(), "closing it doesn't bring it back");
        state.update(Some(sample(2, false, Some(1))));
        assert!(state.take_prompt(), "a new version does");
        state.update(Some(sample(2, true, Some(2))));
        assert!(!state.take_prompt(), "acknowledged");
    }

    #[test]
    fn signing_out_forgets_everything() {
        let mut state = NoticeState::default();
        state.update(Some(sample(1, true, Some(1))));
        state.clear();
        assert!(!state.collection_allowed());
        assert!(state.status().is_none());
    }
}
