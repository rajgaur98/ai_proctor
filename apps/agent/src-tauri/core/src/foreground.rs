//! Rules for the frontmost window on Windows (#167; ACT-01..03, CHK-03): the app
//! name from the executable, window title limits, which browsers expose an address
//! bar and how to read a domain from it, and which window titles mean a screen
//! share or a slideshow. The OS reads live in `agent-platform`; this runs in CI on
//! every OS. (macOS keeps its own copies of the domain helpers in its platform file.)

/// Longest window title we keep (the `foreground` contract's maximum).
pub const MAX_TITLE_CHARS: usize = 500;

/// UI Automation: Chromium's address bar is a views `Edit` of this class; Firefox's
/// is an `Edit` with this automation id. Neither depends on the UI language.
pub const CHROMIUM_OMNIBOX_CLASS: &str = "OmniboxViewViews";
pub const FIREFOX_URLBAR_ID: &str = "urlbar-input";

/// How a browser shows its address bar to UI Automation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserKind {
    Chromium,
    Firefox,
}

/// The app name for an executable path: the file name without `.exe`, as the
/// excluded-apps list spells it ("1Password", "KeePassXC"). Handles both separators
/// so a Windows path parses the same on any OS.
pub fn app_name(image_path: &str) -> Option<String> {
    let file = image_path.rsplit(['\\', '/']).next()?.trim();
    let stem = match file.len().checked_sub(4) {
        Some(at) if file.is_char_boundary(at) && file[at..].eq_ignore_ascii_case(".exe") => {
            &file[..at]
        }
        _ => file,
    };
    (!stem.is_empty()).then(|| stem.to_owned())
}

/// The window title as stored: trimmed, `None` when empty, capped at
/// `MAX_TITLE_CHARS` characters.
pub fn clean_title(title: &str) -> Option<String> {
    let title = title.trim();
    (!title.is_empty()).then(|| title.chars().take(MAX_TITLE_CHARS).collect())
}

/// The browsers whose address we read, by app name (see `app_name`).
pub fn browser_kind(app: &str) -> Option<BrowserKind> {
    match app.to_ascii_lowercase().as_str() {
        "chrome" | "msedge" | "brave" | "vivaldi" | "opera" | "chromium" | "arc" => {
            Some(BrowserKind::Chromium)
        }
        "firefox" | "zen" | "waterfox" | "librewolf" => Some(BrowserKind::Firefox),
        _ => None,
    }
}

/// Domain from an address-bar value. Chromium hides the `https://` scheme, so a
/// value without one is tried as a host: it must look like one (contain a dot, or
/// be `localhost`), which drops typed search text and `about:blank`.
pub fn domain_of_address(value: &str) -> Option<String> {
    let value = value.trim();
    if value.contains("://") {
        return domain_of(value);
    }
    let host = value.split(['/', '?', '#', ':']).next().unwrap_or("");
    if !(host.contains('.') || host.eq_ignore_ascii_case("localhost")) {
        return None;
    }
    domain_of(&format!("https://{value}"))
}

/// Host of an http(s) URL, lower-case, without a leading "www.", port, userinfo,
/// path, query or fragment. Anything else (file:, about:, chrome://, ...) is `None`.
/// This is the only part of a URL that ever leaves the agent.
pub fn domain_of(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")) {
        return None;
    }
    let authority = rest.split(['/', '?', '#', '\\']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = if host_port.starts_with('[') {
        // IPv6 literal: keep the bracketed address, drop any port.
        &host_port[..host_port.find(']')? + 1]
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    let host = host.trim_end_matches('.').to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    Some(host.to_string())
}

/// A window title that suggests an active screen share (Meet/Chrome "... is sharing
/// your screen", Zoom share toolbar, Teams sharing bar). Only the indicator wording:
/// broad words ("presenting", "screen share") also match page and document titles
/// and would hold check-ins back for as long as such a window is open. The Chrome
/// wording is verified on macOS (spike #14); Zoom's and Teams' Windows titles are
/// unverified (device checklist, #167).
pub fn is_sharing_title(title: &str) -> bool {
    const HINTS: [&str; 6] = [
        "is sharing your screen",
        "is sharing a window",
        "is sharing a tab",
        "is sharing this tab",
        "zoom share toolbar",
        "sharing control bar",
    ];
    let title = title.to_lowercase();
    HINTS.iter().any(|h| title.contains(h))
}

/// A slideshow window (PowerPoint's is class `screenClass`, titled "PowerPoint
/// Slide Show - ..."). Together with "it covers a whole monitor" this is a
/// presentation (CHK-03); an ordinary full-screen app is not.
pub fn is_slide_show(class: &str, title: &str) -> bool {
    class == "screenClass" || title.to_lowercase().starts_with("powerpoint slide show")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_name_is_the_executable_without_extension() {
        assert_eq!(
            app_name(r"C:\Program Files\1Password\app\8\1Password.exe").as_deref(),
            Some("1Password")
        );
        assert_eq!(
            app_name(r"C:\x\KeePassXC.EXE").as_deref(),
            Some("KeePassXC")
        );
        assert_eq!(app_name("C:/x/chrome.exe").as_deref(), Some("chrome"));
        assert_eq!(app_name("notepad").as_deref(), Some("notepad"));
        assert_eq!(
            app_name(r"C:\x\app.exe.bak").as_deref(),
            Some("app.exe.bak")
        );
        assert_eq!(app_name(r"C:\x\.exe"), None);
        assert_eq!(app_name(""), None);
    }

    #[test]
    fn titles_are_trimmed_and_capped_by_characters() {
        assert_eq!(
            clean_title("  Inbox - Mail \r\n").as_deref(),
            Some("Inbox - Mail")
        );
        assert_eq!(clean_title("   "), None);
        assert_eq!(clean_title(""), None);
        let long = "é".repeat(MAX_TITLE_CHARS + 20);
        assert_eq!(clean_title(&long).unwrap().chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn browsers_are_recognised_by_app_name() {
        assert_eq!(browser_kind("chrome"), Some(BrowserKind::Chromium));
        assert_eq!(browser_kind("msedge"), Some(BrowserKind::Chromium));
        assert_eq!(browser_kind("Brave"), Some(BrowserKind::Chromium));
        assert_eq!(browser_kind("firefox"), Some(BrowserKind::Firefox));
        assert_eq!(browser_kind("notepad"), None);
        assert_eq!(browser_kind("explorer"), None);
    }

    #[test]
    fn address_bar_value_without_scheme_is_read_as_https_host() {
        assert_eq!(
            domain_of_address("github.com/rajgaur98/ai_proctor").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            domain_of_address("localhost:5173/x").as_deref(),
            Some("localhost")
        );
        assert_eq!(
            domain_of_address("www.Example.com?q=1").as_deref(),
            Some("example.com")
        );
    }

    #[test]
    fn address_bar_value_with_a_scheme_follows_domain_of() {
        assert_eq!(
            domain_of_address("https://mail.google.com/mail/u/0/#inbox").as_deref(),
            Some("mail.google.com")
        );
        assert_eq!(domain_of_address("chrome://settings"), None);
        assert_eq!(domain_of_address("file:///C:/x.html"), None);
    }

    #[test]
    fn address_bar_text_that_is_not_a_host_gives_no_domain() {
        assert_eq!(domain_of_address("how to cook rice"), None);
        assert_eq!(domain_of_address("about:blank"), None);
        assert_eq!(domain_of_address(""), None);
        assert_eq!(domain_of_address("  "), None);
    }

    #[test]
    fn domain_drops_everything_but_the_host() {
        assert_eq!(
            domain_of("https://user:pw@www.Example.com:8443/a/b?q=1#f").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            domain_of("http://example.com.").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            domain_of("HTTP://EXAMPLE.COM/path").as_deref(),
            Some("example.com")
        );
    }

    #[test]
    fn domain_keeps_ip_literals() {
        assert_eq!(
            domain_of("http://127.0.0.1:3000/").as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(domain_of("http://[::1]:8080/x").as_deref(), Some("[::1]"));
    }

    #[test]
    fn domain_is_none_for_other_schemes_and_junk() {
        assert_eq!(domain_of("ftp://example.com"), None);
        assert_eq!(domain_of("example.com"), None);
        assert_eq!(domain_of("https://"), None);
        assert_eq!(domain_of("https://exa mple.com"), None);
    }

    #[test]
    fn sharing_indicators_match_case_insensitively() {
        assert!(is_sharing_title("meet.google.com is sharing your screen."));
        assert!(is_sharing_title("Zoom Share Toolbar"));
        assert!(is_sharing_title("Microsoft Teams Sharing control bar"));
        assert!(is_sharing_title("Brave is SHARING A TAB"));
    }

    #[test]
    fn ordinary_titles_are_not_sharing() {
        assert!(!is_sharing_title(""));
        assert!(!is_sharing_title(
            "Screen sharing best practices - Google Docs"
        ));
        assert!(!is_sharing_title("Presenting - Slides"));
    }

    #[test]
    fn slide_show_windows_are_recognised() {
        assert!(is_slide_show("screenClass", ""));
        assert!(is_slide_show("Other", "PowerPoint Slide Show - Q3.pptx"));
        assert!(!is_slide_show("PPTFrameClass", "Q3.pptx - PowerPoint"));
        assert!(!is_slide_show("Chrome_WidgetWin_1", "YouTube - Brave"));
    }
}
