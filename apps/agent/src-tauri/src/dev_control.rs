//! A control socket for tests that drive the real bundle (#99), enabled in debug
//! builds by `AI_PROCTOR_DEV_CONTROL=<path>`. One JSON object per line in, one
//! reply per line out: `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`.
//! Every command goes through the code the UI, tray and OS call.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    click_card, end_session, handle_deep_links, AgentState, EVENT_STATUS_CHANGED, POPOVER,
};

/// Added to the `flags` of a check-in clicked through the socket, so it can never
/// pass for a real click.
const FLAG: &str = "dev_control";

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Command {
    Status,
    Card,
    Click { value: i64 },
    SignInStart { email: String },
    DeepLink { url: String },
    ClockIn,
    ClockOut,
    BreakStart,
    BreakEnd,
    Pause { minutes: u32 },
    SignOut,
}

/// Starts serving on `path` (a stale socket file there is replaced).
pub fn spawn(app: AppHandle, path: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    tracing::warn!(path = %path.display(), "dev control socket");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || serve(&app, stream));
        }
    });
    Ok(())
}

fn serve(app: &AppHandle, stream: UnixStream) {
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    for line in BufReader::new(stream).lines().map_while(Result::ok) {
        let reply = match serde_json::from_str::<Command>(&line) {
            Ok(command) => run(app, command),
            Err(error) => Err(format!("bad command: {error}")),
        };
        let reply = match reply {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        if writeln!(writer, "{reply}").is_err() {
            return;
        }
    }
}

fn run(app: &AppHandle, command: Command) -> Result<Value, String> {
    let state = app.state::<AgentState>();
    let done = Ok(Value::Null);
    match command {
        Command::Status => to_json(state.status()),
        Command::Card => to_json(state.current_challenge()),
        Command::Click { value } => {
            let card = state.current_challenge().ok_or("no card is up")?;
            state.flag_card(FLAG);
            to_json(click_card(app, &card.card_id, value, true))
        }
        Command::SignInStart { email } => state.start_sign_in(&email).map(|()| Value::Null),
        Command::DeepLink { url } => {
            let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
            handle_deep_links(app, vec![url]);
            done
        }
        Command::ClockIn => act(app, "clock in", |s| s.clock_in(None)),
        Command::ClockOut => act(app, "clock out", |s| s.clock_out()),
        Command::BreakStart => act(app, "start a break", |s| s.start_break(None)),
        Command::BreakEnd => act(app, "end the break", |s| s.end_break()),
        Command::Pause { minutes } => act(app, "pause", |s| s.start_pause(minutes)),
        Command::SignOut => {
            end_session(app);
            done
        }
    }
}

/// A session transition, announced to the popover as the tray does.
fn act(
    app: &AppHandle,
    what: &str,
    f: impl FnOnce(
        &mut agent_core::session::Session,
    ) -> Result<(), agent_core::session::TransitionError>,
) -> Result<Value, String> {
    let state = app.state::<AgentState>();
    let result = state.act_checked(what, f);
    let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, state.status());
    result.map(|()| Value::Null).map_err(|e| e.to_string())
}

fn to_json(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}
