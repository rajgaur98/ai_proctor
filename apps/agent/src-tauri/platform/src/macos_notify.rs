//! OS notifications on macOS through UserNotifications (#104).
//!
//! `UNUserNotificationCenter` is thread-safe and its calls are asynchronous, so
//! `notify` works from the agent's worker threads. It needs a real app bundle: a
//! bare binary (`cargo test`, `tauri dev`) has no bundle identifier and the center
//! would raise, so every entry point does nothing there.
//!
//! The permission prompt is never shown by `notify`; only `request_permission`
//! asks. Without authorization `notify` does nothing (logged at debug).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationSettings,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

/// Moves an Objective-C object into a static; the delegate is only held, never
/// messaged from Rust.
struct Held(#[allow(dead_code)] Retained<NotificationDelegate>);
unsafe impl Send for Held {}

/// The center keeps its delegate weakly, so it is held here for the process.
static DELEGATE: Mutex<Option<Held>> = Mutex::new(None);
static COUNTER: AtomicU64 = AtomicU64::new(0);

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "AIProctorNotificationDelegate"]
    #[ivars = ()]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        /// The agent is a menu-bar app that is often "frontmost" while its popover
        /// is open; without this macOS would swallow the banner then.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }
    }
);

impl NotificationDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// The notification center, only when this process is an app bundle.
fn center() -> Option<Retained<UNUserNotificationCenter>> {
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        tracing::debug!("not an app bundle, notifications unavailable");
        return None;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    if let Ok(mut held) = DELEGATE.lock() {
        if held.is_none() {
            let delegate = NotificationDelegate::new();
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            *held = Some(Held(delegate));
        }
    }
    Some(center)
}

/// Shows the system prompt the first time; afterwards macOS remembers the answer.
pub fn request_permission() {
    let Some(center) = center() else { return };
    let block = RcBlock::new(|granted: Bool, _error: *mut NSError| {
        tracing::info!(granted = granted.as_bool(), "asked for Notifications");
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &block,
    );
}

/// Posts a notification if the user allowed them. Asynchronous: returns at once.
/// Callers keep URLs and window titles out of `title` and `body`.
pub fn notify(title: &str, body: &str) {
    let Some(center) = center() else { return };
    let (title, body) = (title.to_owned(), body.to_owned());
    let add_to = center.clone();
    let block = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        if !is_allowed(status) {
            tracing::debug!(title = %title, "notifications not allowed, skipped");
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        let id = format!("aiproctor-{}", COUNTER.fetch_add(1, Ordering::Relaxed));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None,
        );
        let title = title.clone();
        let done = RcBlock::new(move |error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                tracing::warn!(title = %title, error = %error.localizedDescription(), "notification failed");
            }
        });
        add_to.addNotificationRequest_withCompletionHandler(&request, Some(&done));
    });
    center.getNotificationSettingsWithCompletionHandler(&block);
}

/// Authorized, or provisional (delivered quietly): both may post.
fn is_allowed(status: UNAuthorizationStatus) -> bool {
    status == UNAuthorizationStatus::Authorized || status == UNAuthorizationStatus::Provisional
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_authorized_or_provisional_may_post() {
        assert!(is_allowed(UNAuthorizationStatus::Authorized));
        assert!(is_allowed(UNAuthorizationStatus::Provisional));
        assert!(!is_allowed(UNAuthorizationStatus::NotDetermined));
        assert!(!is_allowed(UNAuthorizationStatus::Denied));
    }

    #[test]
    fn without_an_app_bundle_notify_does_nothing() {
        // `cargo test` runs a bare binary: no bundle identifier, so no center.
        assert!(center().is_none());
        notify("Title", "Body");
        request_permission();
    }
}
