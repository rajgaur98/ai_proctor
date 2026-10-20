//! Text for Windows notifications (#174): the toast XML and the limits of the
//! balloon fallback. Pure, so it runs in CI on every OS; showing them is in
//! `agent-platform`.

/// Longest balloon title and text, in UTF-16 units, without the terminating NUL
/// (`NOTIFYICONDATAW.szInfoTitle` is 64 units, `szInfo` 256).
pub const BALLOON_TITLE_MAX: usize = 63;
pub const BALLOON_TEXT_MAX: usize = 255;

/// `text` escaped for an XML text node. Control characters XML 1.0 forbids become
/// spaces; tab, newline and carriage return stay.
pub fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// The toast payload: the generic template with the title and, when there is one,
/// the body as two text lines.
pub fn toast_xml(title: &str, body: &str) -> String {
    let body = if body.is_empty() {
        String::new()
    } else {
        format!("<text>{}</text>", xml_escape(body))
    };
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text>{body}</binding></visual></toast>",
        xml_escape(title)
    )
}

/// `text` cut to at most `max_units` UTF-16 units without splitting a character.
pub fn truncate_utf16(text: &str, max_units: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max_units {
            break;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_characters_are_escaped() {
        assert_eq!(
            xml_escape(r#"a & b <c> "d" 'e'"#),
            "a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"
        );
        assert_eq!(
            xml_escape("Pause over \u{2014} back at work"),
            "Pause over \u{2014} back at work"
        );
    }

    #[test]
    fn forbidden_control_characters_become_spaces() {
        assert_eq!(xml_escape("a\u{0}b\u{7}c\td\ne"), "a b c\td\ne");
    }

    #[test]
    fn the_toast_has_a_title_and_a_body() {
        assert_eq!(
            toast_xml("Check-in", "Click <7>"),
            "<toast><visual><binding template=\"ToastGeneric\"><text>Check-in</text>\
             <text>Click &lt;7&gt;</text></binding></visual></toast>"
        );
    }

    #[test]
    fn an_empty_body_is_left_out() {
        assert_eq!(
            toast_xml("Signed out", ""),
            "<toast><visual><binding template=\"ToastGeneric\"><text>Signed out</text>\
             </binding></visual></toast>"
        );
    }

    #[test]
    fn balloon_text_is_cut_by_utf16_units() {
        assert_eq!(truncate_utf16("hello", 10), "hello");
        assert_eq!(truncate_utf16("hello", 3), "hel");
        assert_eq!(truncate_utf16("", 3), "");
        // A character outside the BMP is two units: it fits whole or not at all.
        assert_eq!(truncate_utf16("a\u{1F600}b", 3), "a\u{1F600}");
        assert_eq!(truncate_utf16("a\u{1F600}b", 2), "a");
        let long = "\u{e9}".repeat(300);
        assert_eq!(
            truncate_utf16(&long, BALLOON_TEXT_MAX).chars().count(),
            BALLOON_TEXT_MAX
        );
    }
}
