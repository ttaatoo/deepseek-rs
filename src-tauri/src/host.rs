//! Resolve and supervise the `dsh --profile web` Host process.

use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// How long to wait for the `dsh web:` readiness line.
pub const HOST_READY_TIMEOUT: Duration = Duration::from_secs(90);

const WEB_URL_MARK: &str = "dsh web: ";
const SOURCE_BIN: &str = "apps/cli/src/bin.ts";
const SIGTERM_GRACE: Duration = Duration::from_secs(6);

/// How the Host binary is launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchSpec {
    /// A `dsh` executable on `PATH` or `DSH_BIN`.
    Binary(PathBuf),
    /// A harness git checkout. Launched with `node --import tsx/esm`.
    Source(PathBuf),
}

/// Why the Host did not become ready.
#[derive(Debug)]
pub enum HostError {
    /// No `DSH_BIN`, `DSH_REPO`, sibling checkout, home checkout, or `dsh` on `PATH`.
    NotFound,
    /// `Command::spawn` failed.
    Spawn(std::io::Error),
    /// The process exited before printing the URL.
    Exited {
        /// Process exit code, if the OS reported one.
        code: Option<i32>,
        /// Trailing stderr (and leftover stdout) lines.
        tail: String,
    },
    /// [`HOST_READY_TIMEOUT`] elapsed with no URL line.
    Timeout {
        /// Trailing log lines collected while waiting.
        tail: String,
    },
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(
                f,
                "Could not find DeepSeek Harness.\n\n\
                 Set DSH_REPO to a deepseek-harness checkout, set DSH_BIN to a dsh executable, \
                 or put dsh on PATH."
            ),
            Self::Spawn(err) => write!(f, "Failed to start dsh: {err}"),
            Self::Exited { code, tail } => {
                let code = code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
                if tail.is_empty() {
                    write!(f, "dsh exited (code {code}) before printing the web URL.")
                } else {
                    write!(f, "dsh exited (code {code}) before printing the web URL.\n\n{tail}")
                }
            }
            Self::Timeout { tail } => {
                if tail.is_empty() {
                    write!(f, "Timed out waiting for the dsh web URL.")
                } else {
                    write!(f, "Timed out waiting for the dsh web URL.\n\n{tail}")
                }
            }
        }
    }
}

impl std::error::Error for HostError {}

/// A running Host whose process group this app owns.
pub struct HostProcess {
    child: Child,
}

impl HostProcess {
    /// Send SIGTERM to the process group, then SIGKILL after [`SIGTERM_GRACE`].
    pub fn terminate(&mut self) {
        terminate_group(&mut self.child);
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        terminate_group(&mut self.child);
    }
}

/// Pick a launch spec from the environment and well-known locations.
///
/// Order: `DSH_BIN`, `DSH_REPO`, `../deepseek-harness` from the process cwd,
/// `$HOME/Github/deepseek-harness`, `$HOME/github/deepseek-harness`, `dsh` on `PATH`.
pub fn resolve_launch() -> Result<LaunchSpec, HostError> {
    if let Some(bin) = env::var_os("DSH_BIN") {
        let path = PathBuf::from(bin);
        if path.is_file() {
            return Ok(LaunchSpec::Binary(path));
        }
    }
    if let Some(repo) = env::var_os("DSH_REPO") {
        let path = PathBuf::from(repo);
        if is_harness_repo(&path) {
            return Ok(LaunchSpec::Source(path));
        }
    }
    if let Ok(cwd) = env::current_dir() {
        let sibling = cwd.join("..").join("deepseek-harness");
        if is_harness_repo(&sibling) {
            return Ok(LaunchSpec::Source(dunce_canonicalize(&sibling)));
        }
        // `tauri dev` often starts with cwd = src-tauri.
        let from_src_tauri = cwd.join("..").join("..").join("deepseek-harness");
        if is_harness_repo(&from_src_tauri) {
            return Ok(LaunchSpec::Source(dunce_canonicalize(&from_src_tauri)));
        }
    }
    if let Some(home) = env::var_os("HOME") {
        for name in ["Github", "github"] {
            let candidate = Path::new(&home).join(name).join("deepseek-harness");
            if is_harness_repo(&candidate) {
                return Ok(LaunchSpec::Source(candidate));
            }
        }
    }
    if let Some(bin) = look_path("dsh") {
        return Ok(LaunchSpec::Binary(bin));
    }
    Err(HostError::NotFound)
}

/// A checkout is a harness tree when the source CLI entry exists.
pub fn is_harness_repo(path: &Path) -> bool {
    path.join(SOURCE_BIN).is_file() && path.join("package.json").is_file()
}

/// Pull the loopback URL out of a `dsh web:` readiness line.
pub fn parse_web_url(line: &str) -> Option<&str> {
    let idx = line.find(WEB_URL_MARK)?;
    let rest = &line[idx + WEB_URL_MARK.len()..];
    let url = rest.split_whitespace().next()?;
    if url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:") {
        Some(url)
    } else {
        None
    }
}

/// Spawn the Host and block until it prints the loopback URL.
pub fn start_host(spec: &LaunchSpec) -> Result<(HostProcess, String), HostError> {
    let mut child = spawn_host(spec)?;
    match wait_for_url(&mut child, HOST_READY_TIMEOUT) {
        Ok(url) => Ok((HostProcess { child }, url)),
        Err(err) => {
            terminate_group(&mut child);
            Err(err)
        }
    }
}

fn spawn_host(spec: &LaunchSpec) -> Result<Child, HostError> {
    let mut cmd = match spec {
        LaunchSpec::Binary(program) => Command::new(program),
        LaunchSpec::Source(repo) => {
            let mut cmd = Command::new("node");
            cmd.arg("--import")
                .arg("tsx/esm")
                .arg(SOURCE_BIN)
                .current_dir(repo);
            cmd
        }
    };
    cmd.args(["--profile", "web", "--host", "127.0.0.1", "--port", "0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    cmd.spawn().map_err(HostError::Spawn)
}

fn wait_for_url(child: &mut Child, timeout: Duration) -> Result<String, HostError> {
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let (tx, rx) = mpsc::channel::<String>();
    spawn_line_reader(stdout, tx.clone());
    spawn_line_reader(stderr, tx);

    let deadline = Instant::now() + timeout;
    let mut tail: Vec<String> = Vec::new();
    loop {
        if let Some(status) = child.try_wait().ok().flatten() {
            return Err(HostError::Exited {
                code: status.code(),
                tail: join_tail(&tail),
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(HostError::Timeout {
                tail: join_tail(&tail),
            });
        }
        match rx.recv_timeout(Duration::from_millis(50).min(remaining)) {
            Ok(line) => {
                if let Some(url) = parse_web_url(&line) {
                    let url = url.to_string();
                    drain_after_ready(rx);
                    return Ok(url);
                }
                push_tail(&mut tail, line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = child.wait().ok();
                return Err(HostError::Exited {
                    code: status.and_then(|s| s.code()),
                    tail: join_tail(&tail),
                });
            }
        }
    }
}

fn spawn_line_reader<R>(reader: R, tx: mpsc::Sender<String>)
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut lines = BufReader::new(reader).lines();
        while let Some(Ok(line)) = lines.next() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

fn drain_after_ready(rx: mpsc::Receiver<String>) {
    std::thread::spawn(move || {
        while rx.recv().is_ok() {}
    });
}

fn push_tail(tail: &mut Vec<String>, line: String) {
    const MAX: usize = 40;
    if tail.len() == MAX {
        tail.remove(0);
    }
    tail.push(line);
}

fn join_tail(tail: &[String]) -> String {
    tail.join("\n")
}

fn look_path(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    env::split_paths(&paths).find_map(|dir| {
        let candidate = dir.join(name);
        candidate.is_file().then_some(candidate)
    })
}

fn dunce_canonicalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn terminate_group(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            libc::killpg(pid, libc::SIGTERM);
        }
        let start = Instant::now();
        while start.elapsed() < SIGTERM_GRACE {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_plain_loopback_line() {
        assert_eq!(
            parse_web_url("dsh web: http://127.0.0.1:4312"),
            Some("http://127.0.0.1:4312")
        );
    }

    #[test]
    fn parse_line_with_lan_suffix() {
        assert_eq!(
            parse_web_url("dsh web: http://127.0.0.1:8080 (LAN: http://10.0.0.2:8080)"),
            Some("http://127.0.0.1:8080")
        );
    }

    #[test]
    fn parse_prefixed_log_line() {
        assert_eq!(
            parse_web_url("info dsh web: http://localhost:9 ready"),
            Some("http://localhost:9")
        );
    }

    #[test]
    fn reject_non_loopback() {
        assert_eq!(parse_web_url("dsh web: http://10.0.0.2:8080"), None);
        assert_eq!(parse_web_url("listening on 8080"), None);
    }

    #[test]
    fn repo_probe_requires_cli_entry() {
        let tmp = std::env::temp_dir().join(format!("dsh-rs-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("apps/cli/src")).unwrap();
        std::fs::write(tmp.join("package.json"), "{}\n").unwrap();
        assert!(!is_harness_repo(&tmp));
        std::fs::write(tmp.join(SOURCE_BIN), "// bin\n").unwrap();
        assert!(is_harness_repo(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
