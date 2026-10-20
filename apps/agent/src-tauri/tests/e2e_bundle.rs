//! Drives the real debug bundle the way a person would, unattended (#99): launch,
//! sign in through a magic link, clock in, click a check-in card, and see the
//! result on the server. Ignored by default; `scripts/agent-e2e.sh` builds the
//! bundle and runs it against the local stack:
//!   cargo test -p ai-proctor-agent --test e2e_bundle -- --ignored --nocapture
//! Skipped unless AI_PROCTOR_SUPABASE_URL, AI_PROCTOR_SUPABASE_ANON_KEY and
//! AI_PROCTOR_MAILPIT_URL are set and the bundle is built. The agent takes its
//! commands over the debug-only control socket (`src/dev_control.rs`).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const EMAIL: &str = "lucas@acme.test";
const PASSWORD: &str = "password123";

struct Env {
    supabase: String,
    anon_key: String,
    mailpit: String,
}

fn env() -> Option<Env> {
    Some(Env {
        supabase: std::env::var("AI_PROCTOR_SUPABASE_URL").ok()?,
        anon_key: std::env::var("AI_PROCTOR_SUPABASE_ANON_KEY").ok()?,
        mailpit: std::env::var("AI_PROCTOR_MAILPIT_URL").ok()?,
    })
}

fn bundle_binary() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../target/debug/bundle/macos/AI Proctor.app/Contents/MacOS/ai-proctor-agent")
}

/// Polls `f` until it returns something, or panics after `secs`.
fn wait_for<T>(secs: u64, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(found) = f() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out ({secs} s): {what}");
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The running bundle; killed when dropped.
struct Agent {
    child: Child,
    control: UnixStream,
    reader: BufReader<UnixStream>,
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Agent {
    fn launch(binary: &Path, dir: &Path, env: &Env) -> Self {
        let socket = dir.join("control.sock");
        let mut child = Command::new(binary)
            .env("AI_PROCTOR_SUPABASE_URL", &env.supabase)
            .env("AI_PROCTOR_SUPABASE_ANON_KEY", &env.anon_key)
            .env("AI_PROCTOR_DEV_DATA_DIR", dir.join("data"))
            .env("AI_PROCTOR_DEV_KEYSTORE", dir.join("keys"))
            .env("AI_PROCTOR_DEV_CONTROL", &socket)
            .env("AI_PROCTOR_DEV_CHECKIN_S", "5")
            .env("AI_PROCTOR_DEV_ACTIVE_SESSION", "1")
            .spawn()
            .expect("launch the bundle");
        let control = wait_for(30, "the control socket", || {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("the agent exited at launch: {status}");
            }
            UnixStream::connect(&socket).ok()
        });
        let reader = BufReader::new(control.try_clone().unwrap());
        Self {
            child,
            control,
            reader,
        }
    }

    /// Sends one command; the reply's `result`, or the error it carried.
    fn try_send(&mut self, command: Value) -> Result<Value, String> {
        writeln!(self.control, "{command}").unwrap();
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        let reply: Value = serde_json::from_str(&line).expect("a JSON reply");
        match reply["ok"].as_bool() {
            Some(true) => Ok(reply["result"].clone()),
            _ => Err(reply["error"]
                .as_str()
                .unwrap_or("no error given")
                .to_owned()),
        }
    }

    fn send(&mut self, command: Value) -> Value {
        self.try_send(command.clone())
            .unwrap_or_else(|e| panic!("{command} failed: {e}"))
    }

    fn status(&mut self) -> Value {
        self.send(json!({ "cmd": "status" }))
    }

    fn card(&mut self) -> Option<Value> {
        Some(self.send(json!({ "cmd": "card" }))).filter(|c| !c.is_null())
    }

    fn click(&mut self, value: &Value) -> Value {
        self.send(json!({ "cmd": "click", "value": value }))
    }
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

/// The aiproctor:// redirect of the newest magic link for `email`, which is what
/// the browser would hand to the OS.
fn redirect_from_email(mailpit: &str, email: &str) -> String {
    let http = http();
    wait_for(10, &format!("a magic link for {email}"), || {
        let list: Value = http
            .get(format!("{mailpit}/api/v1/search"))
            .query(&[("query", format!("to:{email}"))])
            .send()
            .ok()?
            .json()
            .ok()?;
        let id = list["messages"][0]["ID"].as_str()?;
        let message: Value = http
            .get(format!("{mailpit}/api/v1/message/{id}"))
            .send()
            .ok()?
            .json()
            .ok()?;
        let text = message["Text"].as_str().unwrap_or_default();
        let link: String = text[text.find("http")?..]
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != ')')
            .collect();
        let response = http.get(&link).send().ok()?;
        Some(response.headers()["location"].to_str().ok()?.to_owned())
    })
}

/// A password session for `EMAIL`: (user id, access token).
fn server_session(env: &Env) -> (String, String) {
    let session: Value = http()
        .post(format!("{}/auth/v1/token", env.supabase))
        .query(&[("grant_type", "password")])
        .header("apikey", &env.anon_key)
        .json(&json!({ "email": EMAIL, "password": PASSWORD }))
        .send()
        .unwrap()
        .json()
        .unwrap();
    (
        session["user"]["id"]
            .as_str()
            .expect("password sign-in")
            .to_owned(),
        session["access_token"].as_str().unwrap().to_owned(),
    )
}

#[test]
#[ignore = "drives the real bundle; run by scripts/agent-e2e.sh"]
fn the_bundle_launches_signs_in_and_checks_in() {
    let Some(env) = env() else {
        eprintln!("skipped: AI_PROCTOR_SUPABASE_URL / _ANON_KEY / _MAILPIT_URL not set");
        return;
    };
    let binary = bundle_binary();
    if !binary.exists() {
        eprintln!("skipped: no bundle at {}", binary.display());
        return;
    }
    let started = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let dir = tempfile::tempdir().unwrap();

    // Launch smoke: the socket answers and the process stays up.
    let mut agent = Agent::launch(&binary, dir.path(), &env);
    assert_eq!(agent.status()["signed_in"], false);
    std::thread::sleep(Duration::from_secs(5));
    assert!(agent.child.try_wait().unwrap().is_none(), "the agent died");
    agent.status();

    // Sign in through the emailed link, handed over as the OS deep link would.
    let _ = http()
        .delete(format!("{}/api/v1/messages", env.mailpit))
        .send();
    agent.send(json!({ "cmd": "sign_in_start", "email": EMAIL }));
    let redirect = redirect_from_email(&env.mailpit, EMAIL);
    agent.send(json!({ "cmd": "deep_link", "url": redirect }));
    wait_for(30, "signed in", || {
        let status = agent.status();
        (status["signed_in"] == true).then_some(status)
    });
    assert_eq!(agent.status()["account_email"], EMAIL);

    // A check-in card: one wrong click, then the right one.
    agent.send(json!({ "cmd": "clock_in" }));
    assert_eq!(agent.status()["shift"], "working");
    let card = wait_for(30, "a check-in card", || agent.card());
    let wrong = card["options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| **n != card["target"])
        .unwrap()
        .clone();
    assert_eq!(agent.click(&wrong), "wrong");
    let again = agent.card().expect("the card stays up after a wrong click");
    assert_eq!(again["card_id"], card["card_id"]);
    assert_eq!(again["wrong_clicks"], 1);
    assert_eq!(agent.click(&card["target"]), "pass");
    assert!(agent.card().is_none(), "a pass takes the card down");

    // The server has the check-in, marked as a control-socket click.
    let (user_id, token) = server_session(&env);
    let row = wait_for(30, "the check-in on the server", || {
        let rows: Value = http()
            .get(format!("{}/rest/v1/checkin_events", env.supabase))
            .query(&[
                ("select", "outcome,wrong_clicks,flags"),
                ("user_id", &format!("eq.{user_id}")),
                ("created_at", &format!("gte.{started}")),
            ])
            .header("apikey", &env.anon_key)
            .bearer_auth(&token)
            .send()
            .ok()?
            .json()
            .ok()?;
        rows.as_array()?.first().cloned()
    });
    assert_eq!(row["outcome"], "pass");
    assert_eq!(row["wrong_clicks"], 1);
    assert!(
        row["flags"]
            .as_array()
            .unwrap()
            .contains(&json!("dev_control")),
        "flags: {}",
        row["flags"]
    );

    // Only now: the server refuses a check-in that arrives after clock-out.
    agent.send(json!({ "cmd": "clock_out" }));
    assert_eq!(agent.status()["shift"], "off_shift");
    agent.send(json!({ "cmd": "sign_out" }));
    let status = agent.status();
    assert_eq!(status["signed_in"], false);
    assert!(status["account_email"].is_null());
}
