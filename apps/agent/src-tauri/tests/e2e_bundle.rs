//! Drives the real debug bundle the way a person would, unattended (#99): launch,
//! sign in through a magic link, clock in, click a check-in card, and see the
//! result on the server. Ignored by default; `scripts/agent-e2e.sh` builds the
//! bundle and runs it against the local stack:
//!   cargo test -p ai-proctor-agent --test e2e_bundle -- --ignored --nocapture
//! Skipped unless AI_PROCTOR_SUPABASE_URL, AI_PROCTOR_SUPABASE_ANON_KEY and
//! AI_PROCTOR_MAILPIT_URL are set and the bundle is built. The agent takes its
//! commands over the debug-only control socket (`src/dev_control.rs`).
//!
//! Two ways to start it (`AI_PROCTOR_E2E_LAUNCH`):
//! - `bundle` (the default, macOS): through LaunchServices (`open -n`), so the
//!   bundle's own Screen Recording and Camera grants apply (#227). The check-in's
//!   captures must then reach Storage; that check reads Storage with
//!   AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY. The grants survive rebuilds only with
//!   the stable signing identity (#108).
//! - `direct`: the binary started from this process, with the shell's
//!   permissions. Runs where nothing has been granted; captures aren't checked.
#![cfg(unix)]

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const EMAIL: &str = "lucas@acme.test";
const PASSWORD: &str = "password123";

/// What a missing grant fails with in bundle mode.
const GRANT_ONCE: &str =
    "Grant Screen Recording/Camera to the AI Proctor bundle once (see PR #226 steps)";

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Launch {
    /// Through LaunchServices: the bundle's own macOS grants.
    Bundle,
    /// From this process: the shell's permissions, no capture checks.
    Direct,
}

fn launch_mode() -> Launch {
    match std::env::var("AI_PROCTOR_E2E_LAUNCH").as_deref() {
        Err(_) | Ok("") | Ok("bundle") => Launch::Bundle,
        Ok("direct") => Launch::Direct,
        Ok(other) => panic!("AI_PROCTOR_E2E_LAUNCH={other}: expected bundle or direct"),
    }
}

/// Canonical, so it matches the path a LaunchServices-started process runs from.
fn bundle_app() -> PathBuf {
    let app = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../target/debug/bundle/macos/AI Proctor.app");
    std::fs::canonicalize(&app).unwrap_or(app)
}

fn bundle_binary() -> PathBuf {
    bundle_app().join("Contents/MacOS/ai-proctor-agent")
}

/// Running processes started from `binary` (pgrep matches the full command line).
fn pids_of(binary: &Path) -> BTreeSet<u32> {
    let out = Command::new("pgrep")
        .arg("-f")
        .arg(binary)
        .output()
        .expect("run pgrep");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect()
}

/// The last lines of a log file, for a failure message.
fn tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(20)..].join("\n")
}

/// Polls `f` until it returns something, or panics after `secs`.
fn wait_for<T>(secs: u64, what: &str, f: impl FnMut() -> Option<T>) -> T {
    wait_for_or(secs, || what.to_owned(), f)
}

/// `wait_for`, with the message built only on a timeout.
fn wait_for_or<T>(secs: u64, what: impl Fn() -> String, mut f: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(found) = f() {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "timed out ({secs} s): {}",
            what()
        );
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// How the agent was started, and how to stop it.
enum Process {
    Direct(Child),
    /// `open -n -W`, which exits when the app does. The app itself isn't our child:
    /// it is the one process of the bundle's binary that wasn't running before.
    Bundle {
        open: Child,
        before: BTreeSet<u32>,
    },
}

/// The running bundle; killed when dropped.
struct Agent {
    process: Process,
    control: UnixStream,
    reader: BufReader<UnixStream>,
}

impl Drop for Agent {
    fn drop(&mut self) {
        match &mut self.process {
            Process::Direct(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            Process::Bundle { open, before } => {
                for pid in pids_of(&bundle_binary()).difference(before) {
                    let _ = Command::new("kill").arg(pid.to_string()).status();
                }
                // `open -W` ends with the app; never hang here if it doesn't.
                let deadline = Instant::now() + Duration::from_secs(10);
                while open.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = open.kill();
                let _ = open.wait();
            }
        }
    }
}

impl Process {
    fn exited(&mut self) -> Option<ExitStatus> {
        match self {
            Process::Direct(child) | Process::Bundle { open: child, .. } => {
                child.try_wait().unwrap()
            }
        }
    }
}

fn path_str(path: &Path) -> String {
    path.to_str().expect("a UTF-8 temp path").to_owned()
}

impl Agent {
    fn launch(mode: Launch, dir: &Path, env: &Env) -> Self {
        let socket = dir.join("control.sock");
        let vars = [
            ("AI_PROCTOR_SUPABASE_URL", env.supabase.clone()),
            ("AI_PROCTOR_SUPABASE_ANON_KEY", env.anon_key.clone()),
            ("AI_PROCTOR_DEV_DATA_DIR", path_str(&dir.join("data"))),
            ("AI_PROCTOR_DEV_KEYSTORE", path_str(&dir.join("keys"))),
            ("AI_PROCTOR_DEV_CONTROL", path_str(&socket)),
            ("AI_PROCTOR_DEV_CHECKIN_S", "5".into()),
            ("AI_PROCTOR_DEV_ACTIVE_SESSION", "1".into()),
            // No LaunchAgent from a throwaway bundle (#58).
            ("AI_PROCTOR_WATCHDOG", "off".into()),
        ];
        let stderr = dir.join("agent.stderr");
        let mut process = match mode {
            Launch::Direct => Process::Direct(
                Command::new(bundle_binary())
                    .envs(vars.iter().map(|(k, v)| (k, v)))
                    .spawn()
                    .expect("launch the bundle's binary"),
            ),
            Launch::Bundle => {
                let before = pids_of(&bundle_binary());
                let mut open = Command::new("open");
                // -n: a new instance, -W: `open` lives as long as the app, -g: no focus.
                open.args(["-n", "-W", "-g"]);
                open.arg("--stdout").arg(dir.join("agent.stdout"));
                open.arg("--stderr").arg(&stderr);
                for (key, value) in &vars {
                    open.arg("--env").arg(format!("{key}={value}"));
                }
                let open = open.arg(bundle_app()).spawn().expect("run open");
                Process::Bundle { open, before }
            }
        };
        let control = wait_for_or(
            30,
            || match mode {
                Launch::Direct => "the control socket".to_owned(),
                Launch::Bundle => format!(
                    "the control socket at {}: the app didn't start, or `open --env` \
                     didn't reach it. Agent stderr:\n{}",
                    socket.display(),
                    tail(&stderr)
                ),
            },
            || {
                if let Some(status) = process.exited() {
                    panic!(
                        "the agent exited at launch: {status}. Agent stderr:\n{}",
                        tail(&stderr)
                    );
                }
                UnixStream::connect(&socket).ok()
            },
        );
        let reader = BufReader::new(control.try_clone().unwrap());
        Self {
            process,
            control,
            reader,
        }
    }

    /// Whether the agent has exited (in bundle mode, `open -W` exits with it).
    fn exited(&mut self) -> Option<ExitStatus> {
        self.process.exited()
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

/// What a pass should capture: (screenshots, webcam frame).
#[derive(Clone, Copy, Debug)]
struct Expected {
    screen: bool,
    webcam: bool,
}

/// From the agent's status: a permission this person's policy doesn't need reads
/// `unsupported`; one it needs must be granted to the bundle.
fn expected_captures(status: &Value) -> Expected {
    let permissions = &status["permissions"];
    let needed = |kind: &str| permissions[kind] != "unsupported";
    let missing: Vec<&str> = [("screen", "Screen Recording"), ("camera", "Camera")]
        .into_iter()
        .filter(|(kind, _)| needed(kind) && permissions[kind] != "granted")
        .map(|(_, name)| name)
        .collect();
    assert!(
        missing.is_empty(),
        "{GRANT_ONCE}. Missing: {} (permissions: {permissions})",
        missing.join(", ")
    );
    let expected = Expected {
        screen: needed("screen"),
        webcam: needed("camera"),
    };
    assert!(
        expected.screen || expected.webcam,
        "the seed policy captures nothing: {status}"
    );
    expected
}

/// The check-in row lists the files the pass took, and Storage has each of them,
/// non-empty, under {org}/{user}/{YYYY-MM-DD}/{checkin_id}/.
fn assert_captures(env: &Env, service_key: &str, user_id: &str, row: &Value, expected: Expected) {
    if let Some(errors) = row["capture_errors"].as_object() {
        let denied = errors.values().any(|e| e == "permission_missing");
        assert!(
            !denied,
            "{GRANT_ONCE}. The capture failed for lack of permission: {}",
            row["capture_errors"]
        );
        panic!("the capture failed: {}", row["capture_errors"]);
    }
    let keys: BTreeSet<String> = row["object_keys"]
        .as_array()
        .expect("object_keys")
        .iter()
        .map(|k| k.as_str().unwrap().to_owned())
        .collect();
    let screens = keys
        .iter()
        .filter(|k| k.starts_with("screen-") && k.ends_with(".webp"))
        .count();
    assert_eq!(screens > 0, expected.screen, "screenshots in {keys:?}");
    assert_eq!(
        keys.contains("webcam.webp"),
        expected.webcam,
        "webcam frame in {keys:?}"
    );
    assert_eq!(
        keys.len(),
        screens + usize::from(expected.webcam),
        "unexpected files in {keys:?}"
    );

    let date = chrono::DateTime::parse_from_rfc3339(row["scheduled_at"].as_str().unwrap())
        .expect("scheduled_at")
        .with_timezone(&chrono::Utc)
        .format("%Y-%m-%d");
    let folder = format!(
        "{}/{user_id}/{date}/{}",
        row["org_id"].as_str().unwrap(),
        row["id"].as_str().unwrap()
    );
    // Uploads follow the server's ack of the check-in: give them a moment.
    let stored = wait_for_or(
        60,
        || format!("{keys:?} in Storage at captures/{folder}/"),
        || {
            let objects: Value = http()
                .post(format!("{}/storage/v1/object/list/captures", env.supabase))
                .header("apikey", service_key)
                .bearer_auth(service_key)
                .json(&json!({ "prefix": format!("{folder}/"), "limit": 100 }))
                .send()
                .ok()?
                .json()
                .ok()?;
            let stored: Vec<(String, u64)> = objects
                .as_array()?
                .iter()
                .filter_map(|o| {
                    Some((
                        o["name"].as_str()?.to_owned(),
                        o["metadata"]["size"].as_u64()?,
                    ))
                })
                .collect();
            let names: BTreeSet<String> = stored.iter().map(|(n, _)| n.clone()).collect();
            (names == keys).then_some(stored)
        },
    );
    for (name, size) in stored {
        assert!(size > 0, "captures/{folder}/{name} is empty");
        eprintln!("stored captures/{folder}/{name}: {size} bytes");
    }
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
    let mode = launch_mode();
    // Captures are checked in bundle mode, with the service role (Storage is
    // write-only for the person).
    let service_key = (mode == Launch::Bundle).then(|| {
        std::env::var("AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY").unwrap_or_else(|_| {
            panic!(
                "bundle mode reads Storage with AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY \
                 (scripts/agent-e2e.sh sets it); or run with AI_PROCTOR_E2E_LAUNCH=direct"
            )
        })
    });
    eprintln!("launch mode: {mode:?}");
    let started = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let dir = tempfile::tempdir().unwrap();

    // Launch smoke: the socket answers and the process stays up.
    let mut agent = Agent::launch(mode, dir.path(), &env);
    assert_eq!(agent.status()["signed_in"], false);
    std::thread::sleep(Duration::from_secs(5));
    assert!(agent.exited().is_none(), "the agent died");
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
    // The policy is in by now: what the pass should capture, and whether this
    // bundle may. Checked before the click, so no capture runs without a grant.
    let expected = (mode == Launch::Bundle).then(|| expected_captures(&agent.status()));
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
                (
                    "select",
                    "id,org_id,scheduled_at,outcome,wrong_clicks,flags,object_keys,capture_errors",
                ),
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

    // Bundle mode: the pass captured what the policy asks for, and it reached the
    // person's own Storage folder.
    if let (Some(expected), Some(service_key)) = (expected, &service_key) {
        assert_captures(&env, service_key, &user_id, &row, expected);
    }

    // Only now: the server refuses a check-in that arrives after clock-out.
    agent.send(json!({ "cmd": "clock_out" }));
    assert_eq!(agent.status()["shift"], "off_shift");
    agent.send(json!({ "cmd": "sign_out" }));
    let status = agent.status();
    assert_eq!(status["signed_in"], false);
    assert!(status["account_email"].is_null());
}
