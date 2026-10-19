//! Structured logging: JSON lines to a daily-rotating file (7 kept) plus a readable
//! stderr stream. Window titles and file paths must never be logged (tech-stack 3).

use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

pub const LOG_FILE_PREFIX: &str = "agent";
pub const LOG_FILES_KEPT: usize = 7;

/// Initializes the global subscriber. Keep the returned guard alive for the life of
/// the process, or buffered lines are lost on exit.
pub fn init(dir: &Path) -> Result<WorkerGuard, Box<dyn std::error::Error + Send + Sync>> {
    let appender = file_appender(dir)?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer().json().with_writer(writer))
        .with(fmt::layer().with_writer(std::io::stderr))
        .try_init()?;
    Ok(guard)
}

fn file_appender(
    dir: &Path,
) -> Result<tracing_appender::rolling::RollingFileAppender, tracing_appender::rolling::InitError> {
    Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix("log")
        .max_log_files(LOG_FILES_KEPT)
        .build(dir)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn writes_into_a_dated_file_in_the_log_dir() {
        let dir = tempfile::tempdir().unwrap();
        let mut appender = file_appender(dir.path()).unwrap();
        writeln!(appender, "{{\"msg\":\"hello\"}}").unwrap();
        appender.flush().unwrap();

        let files: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(files.len(), 1);
        assert!(
            files[0].starts_with("agent.") && files[0].ends_with(".log"),
            "{files:?}"
        );
    }
}
