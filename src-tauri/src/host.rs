//! Resolve and supervise the `dsh --profile web` Host process.

use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use url::Url;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// How long to wait for the `dsh web:` readiness line.
pub const HOST_READY_TIMEOUT: Duration = Duration::from_secs(90);

const WEB_URL_MARK: &str = "dsh web: ";
const SOURCE_BIN: &str = "apps/cli/src/bin.ts";
const NPM_DSH_BIN: &str = "node_modules/@deepseek-ai/dsh/lib/bin.js";
const SIGTERM_GRACE: Duration = Duration::from_secs(6);
const SIGKILL_GRACE: Duration = Duration::from_secs(1);
const GROUP_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How the Host is launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchSpec {
    /// A `dsh` executable on `PATH` or `DSH_BIN`.
    Binary(PathBuf),
    /// Published `@deepseek-ai/dsh` (`node lib/bin.js`).
    Npm {
        /// `lib/bin.js` of `@deepseek-ai/dsh`.
        bin: PathBuf,
        /// Node interpreter. Bundled `bin/node` when the package came from
        /// the app resources; otherwise `node` on `PATH`.
        node: PathBuf,
    },
    /// A harness git checkout. Only used when `DSH_REPO` is set.
    Source(PathBuf),
}

impl LaunchSpec {
    fn npm(bin: PathBuf) -> Self {
        let node = node_for(&bin);
        Self::Npm { bin, node }
    }
}

/// Why the Host did not become ready.
#[derive(Debug)]
pub enum HostError {
    /// No `DSH_BIN`, `DSH_REPO`, `DSH_PACKAGE`, packaged tree, local install, or `dsh` on `PATH`.
    NotFound,
    /// `Command::spawn` failed.
    Spawn(std::io::Error),
    /// Checking whether the process has exited failed.
    TryWait(std::io::Error),
    /// The child did not provide a pipe required by the supervisor.
    Pipe(&'static str),
    /// A reader thread could not be started.
    ReaderSpawn(std::io::Error),
    /// Reading a child output pipe failed.
    Read(std::io::Error),
    /// Startup was cancelled before the child became ready.
    Cancelled,
    /// Terminating the process group failed.
    Terminate(std::io::Error),
    /// Cleaning up after a startup failure also failed.
    Cleanup {
        /// The original startup failure.
        startup: Box<Self>,
        /// The cleanup failure.
        cleanup: Box<Self>,
    },
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
                 The packaged app includes dsh under Contents/Resources/dsh. \
                 From source, run `pnpm install`, or set DSH_BIN, DSH_PACKAGE, or DSH_REPO."
            ),
            Self::Spawn(err) => write!(f, "Failed to start dsh: {err}"),
            Self::TryWait(err) => write!(f, "Failed to check dsh status: {err}"),
            Self::Pipe(name) => write!(f, "dsh did not provide its {name} pipe."),
            Self::ReaderSpawn(err) => write!(f, "Failed to monitor dsh output: {err}"),
            Self::Read(err) => write!(f, "Failed to read dsh output: {err}"),
            Self::Cancelled => write!(f, "dsh startup was cancelled."),
            Self::Terminate(err) => write!(f, "Failed to terminate dsh: {err}"),
            Self::Cleanup { startup, cleanup } => {
                write!(f, "{startup}\n\nCleanup also failed: {cleanup}")
            }
            Self::Exited { code, tail } => {
                let code = code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "unknown".into());
                if tail.is_empty() {
                    write!(f, "dsh exited (code {code}) before printing the web URL.")
                } else {
                    write!(
                        f,
                        "dsh exited (code {code}) before printing the web URL.\n\n{tail}"
                    )
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
    pgid: Option<i32>,
    reader_error: Arc<Mutex<Option<String>>>,
}

impl HostProcess {
    pub(crate) fn from_child(child: Child) -> Self {
        #[cfg(unix)]
        let pgid = Some(child.id() as i32);
        #[cfg(not(unix))]
        let pgid = None;
        Self {
            child,
            pgid,
            reader_error: Arc::new(Mutex::new(None)),
        }
    }

    /// Send SIGTERM to the process group, then SIGKILL after [`SIGTERM_GRACE`].
    pub fn terminate(&mut self) -> Result<(), HostError> {
        if self.pgid.is_none() {
            return Ok(());
        }
        let report = terminate_group_report(&mut self.child, self.pgid);
        if report.group_gone {
            self.pgid = None;
        }
        report
            .error
            .map_or(Ok(()), |error| Err(HostError::Terminate(error)))
    }

    /// Non-blocking exit check for the supervisor loop.
    pub fn poll_exit(&mut self) -> Result<Option<ExitStatus>, HostError> {
        if let Some(error) = self.take_reader_error()? {
            return Err(HostError::Read(std::io::Error::other(error)));
        }
        let status = self.child.try_wait().map_err(HostError::TryWait)?;
        if status.is_some() {
            let report = terminate_group_report(&mut self.child, self.pgid);
            if report.group_gone {
                self.pgid = None;
            }
            if let Some(error) = report.error {
                return Err(HostError::Terminate(error));
            }
        }
        Ok(status)
    }

    fn take_reader_error(&self) -> Result<Option<String>, HostError> {
        self.reader_error
            .lock()
            .map_err(|_| HostError::Read(std::io::Error::other("reader error lock poisoned")))
            .map(|mut error| error.take())
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if self.pgid.is_some() {
            let report = terminate_group_report(&mut self.child, self.pgid);
            if report.group_gone {
                self.pgid = None;
            }
            if let Some(err) = report.error {
                eprintln!("deepseek-rs: failed to terminate dsh during drop: {err}");
            }
        }
    }
}

/// Pick a launch spec.
///
/// Order: `DSH_BIN`, `DSH_REPO`, `DSH_PACKAGE`, the packaged
/// `Contents/Resources/dsh` tree, this app's `@deepseek-ai/dsh` install,
/// then `dsh` on `PATH`. A sibling or `$HOME/.../deepseek-harness` checkout
/// is not used unless `DSH_REPO` names it.
pub fn resolve_launch(resource_dir: Option<&Path>) -> Result<LaunchSpec, HostError> {
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
    if let Some(bin) = env_dsh_package() {
        return Ok(LaunchSpec::npm(bin));
    }
    if let Some(dir) = resource_dir {
        if let Some(bin) = find_bundled_dsh(dir) {
            return Ok(LaunchSpec::npm(bin));
        }
    }
    if let Some(bin) = find_bundled_dsh_from_exe() {
        return Ok(LaunchSpec::npm(bin));
    }
    if let Some(bin) = find_npm_dsh() {
        return Ok(LaunchSpec::npm(bin));
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

/// Walk `start` and its parents for `node_modules/@deepseek-ai/dsh/lib/bin.js`.
pub fn find_npm_dsh_from(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|dir| {
        let bin = dir.join(NPM_DSH_BIN);
        bin.is_file().then(|| dunce_canonicalize(&bin))
    })
}

fn env_dsh_package() -> Option<PathBuf> {
    let raw = env::var_os("DSH_PACKAGE")?;
    let given = PathBuf::from(raw);
    let bin = if given.ends_with("bin.js") {
        given
    } else {
        given.join("lib/bin.js")
    };
    bin.is_file().then(|| dunce_canonicalize(&bin))
}

/// Packaged layout: `$resource_dir/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`.
pub fn find_bundled_dsh(resource_dir: &Path) -> Option<PathBuf> {
    let bin = resource_dir.join("dsh").join(NPM_DSH_BIN);
    bin.is_file().then(|| dunce_canonicalize(&bin))
}

fn find_bundled_dsh_from_exe() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    find_bundled_dsh(&contents.join("Resources"))
}

fn find_npm_dsh() -> Option<PathBuf> {
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(found) = find_npm_dsh_from(dir) {
                return Some(found);
            }
        }
    }
    env::current_dir()
        .ok()
        .and_then(|cwd| find_npm_dsh_from(&cwd))
}

fn node_for(dsh_bin: &Path) -> PathBuf {
    if let Some(raw) = env::var_os("DSH_NODE") {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return dunce_canonicalize(&path);
        }
    }
    find_bundled_node(dsh_bin).unwrap_or_else(|| PathBuf::from("node"))
}

/// `bin.js` lives at `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`.
/// The bundled interpreter is `runtime/bin/node` — five parents up.
/// Do not walk further: `/bin/node` must not win.
fn find_bundled_node(dsh_bin: &Path) -> Option<PathBuf> {
    let runtime_root = dsh_bin.parent()?.parent()?.parent()?.parent()?.parent()?;
    let node = runtime_root.join("bin/node");
    node.is_file().then(|| dunce_canonicalize(&node))
}

/// Pull the loopback URL out of a `dsh web:` readiness line.
pub fn parse_web_url(line: &str) -> Option<&str> {
    let idx = line.find(WEB_URL_MARK)?;
    let rest = &line[idx + WEB_URL_MARK.len()..];
    let url = rest.split_whitespace().next()?;
    let parsed = Url::parse(url).ok()?;
    let authority_start = url.find("://")? + 3;
    let authority = &url[authority_start..];
    let authority = authority.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None;
    }
    let (raw_host, raw_port) = authority.rsplit_once(':')?;
    let port = raw_port.parse::<u16>().ok()?;
    if parsed.scheme() != "http"
        || !matches!(raw_host, "127.0.0.1" | "localhost")
        || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"))
        || port == 0
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    Some(url)
}

/// Spawn the Host and block until it prints the loopback URL.
#[allow(dead_code)]
pub fn start_host(spec: &LaunchSpec) -> Result<(HostProcess, String), HostError> {
    let cancelled = AtomicBool::new(false);
    start_host_with_cancel(spec, &cancelled)
}

/// Spawn the Host and stop readiness polling when `cancelled` is set.
pub fn start_host_with_cancel(
    spec: &LaunchSpec,
    cancelled: &AtomicBool,
) -> Result<(HostProcess, String), HostError> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(HostError::Cancelled);
    }
    let mut process = spawn_host(spec)?;
    match wait_for_url_with_cancel(
        &mut process.child,
        HOST_READY_TIMEOUT,
        cancelled,
        process.reader_error.clone(),
    ) {
        Ok(url) => Ok((process, url)),
        Err(err) => match process.terminate() {
            Ok(()) => Err(err),
            Err(cleanup) => Err(HostError::Cleanup {
                startup: Box::new(err),
                cleanup: Box::new(cleanup),
            }),
        },
    }
}

fn spawn_host(spec: &LaunchSpec) -> Result<HostProcess, HostError> {
    let mut cmd = match spec {
        LaunchSpec::Binary(program) => Command::new(program),
        LaunchSpec::Npm { bin, node } => {
            let mut cmd = Command::new(node);
            cmd.arg(bin);
            cmd
        }
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
    apply_host_env(&mut cmd, spec);
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    cmd.spawn()
        .map(HostProcess::from_child)
        .map_err(HostError::Spawn)
}

fn apply_host_env(cmd: &mut Command, spec: &LaunchSpec) {
    if let LaunchSpec::Npm { node, .. } = spec {
        if let Some(dir) = node_bin_dir(node) {
            prepend_path(cmd, &dir);
        }
    }
    if let Ok(cwd) = env::current_dir() {
        if cwd == Path::new("/") {
            if let Some(home) = env::var_os("HOME") {
                cmd.current_dir(home);
            }
        }
    }
}

fn node_bin_dir(node: &Path) -> Option<PathBuf> {
    if node == Path::new("node") {
        return None;
    }
    node.parent().map(Path::to_path_buf)
}

fn prepend_path(cmd: &mut Command, first: &Path) {
    let mut parts = vec![first.to_path_buf()];
    if let Some(path) = env::var_os("PATH") {
        parts.extend(env::split_paths(&path));
    }
    for extra in ["/usr/local/bin", "/opt/homebrew/bin"] {
        let extra = PathBuf::from(extra);
        if extra.is_dir() && !parts.iter().any(|p| p == &extra) {
            parts.push(extra);
        }
    }
    if let Ok(joined) = env::join_paths(&parts) {
        cmd.env("PATH", joined);
    }
}

#[allow(dead_code)]
fn wait_for_url(child: &mut Child, timeout: Duration) -> Result<String, HostError> {
    let cancelled = AtomicBool::new(false);
    wait_for_url_with_cancel(child, timeout, &cancelled, Arc::new(Mutex::new(None)))
}

fn wait_for_url_with_cancel(
    child: &mut Child,
    timeout: Duration,
    cancelled: &AtomicBool,
    reader_error: Arc<Mutex<Option<String>>>,
) -> Result<String, HostError> {
    let stdout = child.stdout.take().ok_or(HostError::Pipe("stdout"))?;
    let stderr = child.stderr.take().ok_or(HostError::Pipe("stderr"))?;
    let (tx, rx) = mpsc::channel::<ReaderMessage>();
    let _stdout_reader = spawn_line_reader(stdout, tx.clone()).map_err(HostError::ReaderSpawn)?;
    let _stderr_reader = spawn_line_reader(stderr, tx).map_err(HostError::ReaderSpawn)?;

    let deadline = Instant::now() + timeout;
    let mut tail: Vec<String> = Vec::new();
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(HostError::Cancelled);
        }
        if let Some(status) = child.try_wait().map_err(HostError::TryWait)? {
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
            Ok(ReaderMessage::Line(line)) => {
                if let Some(url) = parse_web_url(&line) {
                    let url = url.to_string();
                    let _drain =
                        drain_after_ready(rx, reader_error).map_err(HostError::ReaderSpawn)?;
                    return Ok(url);
                }
                push_tail(&mut tail, line);
            }
            Ok(ReaderMessage::Error(err)) => return Err(HostError::Read(err)),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                std::thread::sleep(Duration::from_millis(10).min(remaining));
            }
        }
    }
}

#[derive(Debug)]
enum ReaderMessage {
    Line(String),
    Error(std::io::Error),
}

fn spawn_line_reader<R>(
    reader: R,
    tx: mpsc::Sender<ReaderMessage>,
) -> std::io::Result<JoinHandle<()>>
where
    R: Read + Send + 'static,
{
    std::thread::Builder::new()
        .name("dsh-host-reader".into())
        .spawn(move || {
            for line in BufReader::new(reader).lines() {
                match line {
                    Ok(line) => {
                        if tx.send(ReaderMessage::Line(line)).is_err() {
                            break;
                        }
                    }
                    Err(err) => {
                        let _ = tx.send(ReaderMessage::Error(err));
                        break;
                    }
                }
            }
        })
}

fn drain_after_ready(
    rx: mpsc::Receiver<ReaderMessage>,
    reader_error: Arc<Mutex<Option<String>>>,
) -> std::io::Result<JoinHandle<()>> {
    std::thread::Builder::new()
        .name("dsh-host-output-drain".into())
        .spawn(move || {
            while let Ok(message) = rx.recv() {
                if let ReaderMessage::Error(error) = message {
                    match reader_error.lock() {
                        Ok(mut slot) => {
                            if slot.is_none() {
                                *slot = Some(error.to_string());
                            }
                        }
                        Err(_) => {
                            eprintln!("deepseek-rs: reader error lock is poisoned: {error}");
                        }
                    }
                }
            }
        })
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

#[allow(dead_code)]
fn terminate_group(child: &mut Child, pgid: Option<i32>) -> Result<(), std::io::Error> {
    terminate_group_report(child, pgid)
        .error
        .map_or(Ok(()), Err)
}

#[allow(dead_code)]
fn terminate_group_with_grace(
    child: &mut Child,
    pgid: Option<i32>,
    grace: Duration,
) -> Result<(), std::io::Error> {
    terminate_group_report_with_grace(child, pgid, grace)
        .error
        .map_or(Ok(()), Err)
}

#[derive(Debug)]
struct TerminationReport {
    group_gone: bool,
    error: Option<std::io::Error>,
}

fn terminate_group_report(child: &mut Child, pgid: Option<i32>) -> TerminationReport {
    terminate_group_report_with_grace(child, pgid, SIGTERM_GRACE)
}

fn terminate_group_report_with_grace(
    child: &mut Child,
    pgid: Option<i32>,
    grace: Duration,
) -> TerminationReport {
    let mut errors = Vec::new();
    let mut group_gone = pgid.is_none();

    #[cfg(unix)]
    if let Some(pgid) = pgid {
        // Do not use try_wait as an early exit here. The leader may have
        // already exited while its descendants still own this process group.
        match signal_group(pgid, libc::SIGTERM) {
            Ok(()) => {}
            Err(err) if is_process_gone(&err) => group_gone = true,
            Err(err) => errors.push(err),
        }

        if !group_gone {
            match wait_for_group_exit(pgid, grace) {
                Ok(gone) => group_gone = gone,
                Err(err) => errors.push(err),
            }
        }
        if !group_gone {
            match signal_group(pgid, libc::SIGKILL) {
                Ok(()) => {}
                Err(err) if is_process_gone(&err) => group_gone = true,
                Err(err) => errors.push(err),
            }
            if !group_gone {
                match wait_for_group_exit(pgid, SIGKILL_GRACE) {
                    Ok(gone) => {
                        group_gone = gone;
                        if !gone {
                            errors.push(group_timeout_error(pgid));
                        }
                    }
                    Err(err) => errors.push(err),
                }
            }
        }
    }

    #[cfg(not(unix))]
    {
        kill_direct_child(child, &mut errors);
    }

    if !group_gone || !errors.is_empty() {
        // A group operation can fail even while the direct child is still
        // alive. Make a best effort to stop and reap that child as well.
        kill_direct_child(child, &mut errors);
    }

    // Always reap the direct child, including the leader-exited case.
    if let Err(err) = child.wait() {
        errors.push(err);
    }
    TerminationReport {
        group_gone,
        error: (!errors.is_empty()).then(|| aggregate_io_errors(errors)),
    }
}

fn group_timeout_error(pgid: i32) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!("process group {pgid} remained alive after SIGKILL"),
    )
}

fn aggregate_io_errors(errors: Vec<std::io::Error>) -> std::io::Error {
    let Some(first) = errors.first() else {
        return std::io::Error::other("empty termination error");
    };
    let kind = first.kind();
    if errors.len() == 1 {
        let mut errors = errors.into_iter();
        if let Some(error) = errors.next() {
            return error;
        }
        return std::io::Error::other("empty termination error");
    }
    let message = errors
        .iter()
        .map(describe_io_error)
        .collect::<Vec<_>>()
        .join("; ");
    std::io::Error::new(kind, message)
}

fn describe_io_error(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(errno) => format!("{error} (errno {errno})"),
        None => error.to_string(),
    }
}

#[cfg(unix)]
fn signal_group(pgid: i32, signal: i32) -> Result<(), std::io::Error> {
    if unsafe { libc::killpg(pgid, signal) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn process_group_exists(pgid: i32) -> Result<bool, std::io::Error> {
    match signal_group(pgid, 0) {
        Ok(()) => Ok(true),
        Err(err) if is_process_gone(&err) => Ok(false),
        // Darwin can report EPERM for a group that contains only zombies.
        // The group is no longer actionable; child.wait below still reaps
        // the direct leader.
        Err(err) if err.raw_os_error() == Some(libc::EPERM) => Ok(false),
        Err(err) => Err(err),
    }
}

#[cfg(unix)]
fn wait_for_group_exit(pgid: i32, timeout: Duration) -> Result<bool, std::io::Error> {
    let deadline = Instant::now() + timeout;
    loop {
        if !process_group_exists(pgid)? {
            return Ok(true);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        std::thread::sleep(GROUP_POLL_INTERVAL.min(remaining));
    }
}

#[cfg(unix)]
fn is_process_gone(err: &std::io::Error) -> bool {
    err.raw_os_error() == Some(libc::ESRCH)
}

fn kill_direct_child(child: &mut Child, errors: &mut Vec<std::io::Error>) {
    if let Err(err) = child.kill() {
        if !is_process_gone_portable(&err) {
            errors.push(err);
        }
    }
}

#[cfg(unix)]
fn is_process_gone_portable(err: &std::io::Error) -> bool {
    is_process_gone(err)
}

#[cfg(not(unix))]
fn is_process_gone_portable(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
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
    fn reject_invalid_loopback_urls() {
        for line in [
            "dsh web: https://127.0.0.1:4312",
            "dsh web: http://127.0.0.1",
            "dsh web: http://127.0.0.1:0",
            "dsh web: http://127.0.0.1:65536",
            "dsh web: http://127.0.0.1:not-a-port",
            "dsh web: http://user:password@127.0.0.1:4312",
            "dsh web: http://@localhost:4312",
            "dsh web: http://127.0.0.1:4312@localhost:4312",
            "dsh web: http://2130706433:4312",
            "dsh web: http://127.1:4312",
            "dsh web: http://127.0.0.1.:4312",
        ] {
            assert_eq!(parse_web_url(line), None, "accepted invalid URL: {line}");
        }
    }

    #[test]
    fn accept_valid_loopback_urls_with_explicit_ports() {
        assert_eq!(
            parse_web_url("dsh web: http://127.0.0.1:1/path?ready=true"),
            Some("http://127.0.0.1:1/path?ready=true")
        );
        assert_eq!(
            parse_web_url("dsh web: http://localhost:65535"),
            Some("http://localhost:65535")
        );
        assert_eq!(
            parse_web_url("dsh web: http://127.0.0.1:80"),
            Some("http://127.0.0.1:80")
        );
    }

    #[test]
    #[cfg(unix)]
    fn leader_exit_does_not_leave_grandchild_running() {
        let mut child = spawn_sh("sleep 300 & echo grandchild:$!; exit 0");
        let stdout = child.stdout.take().expect("stdout piped");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("grandchild pid line");
        let pid: i32 = line
            .trim()
            .strip_prefix("grandchild:")
            .expect("prefix")
            .parse()
            .expect("pid");
        let mut process = HostProcess::from_child(child);
        let deadline = Instant::now() + Duration::from_secs(1);
        while process.poll_exit().expect("poll leader").is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(process.poll_exit().expect("poll leader").is_some());
        process.terminate().expect("terminate process group");
        assert!(
            poll_until_gone(pid),
            "grandchild {pid} survived leader exit"
        );
    }

    #[test]
    #[cfg(unix)]
    fn leader_exit_cleanup_clears_pgid_before_drop() {
        let child = spawn_sh("exit 0");
        let mut process = HostProcess::from_child(child);
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut exited = None;
        while Instant::now() < deadline {
            if let Some(status) = process.poll_exit().expect("poll leader") {
                exited = Some(status);
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(exited.is_some(), "leader did not exit");
        assert!(process.pgid.is_none(), "group id survived cleanup");
        drop(process);
    }

    #[test]
    #[cfg(unix)]
    fn pipe_disconnect_respects_readiness_deadline() {
        let mut child = spawn_sh("exec 1>&- 2>&-; sleep 2");
        let start = Instant::now();
        let result = wait_for_url(&mut child, Duration::from_millis(100));
        assert!(matches!(result, Err(HostError::Timeout { .. })));
        assert!(start.elapsed() < Duration::from_secs(1));
        terminate_test_child(&mut child);
    }

    #[test]
    fn reader_reports_io_errors() {
        struct FailingReader;

        impl Read for FailingReader {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("reader failed"))
            }
        }

        let (tx, rx) = mpsc::channel();
        let handle = spawn_line_reader(FailingReader, tx).expect("reader thread");
        match rx.recv().expect("reader event") {
            ReaderMessage::Error(err) => assert_eq!(err.to_string(), "reader failed"),
            other => panic!("expected reader error, got {other:?}"),
        }
        handle.join().expect("reader thread joined");
    }

    #[test]
    fn reader_error_after_ready_is_retained_for_supervisor() {
        let (tx, rx) = mpsc::channel();
        let error = Arc::new(Mutex::new(None));
        let drain = drain_after_ready(rx, error.clone()).expect("drain thread");
        tx.send(ReaderMessage::Error(std::io::Error::other(
            "reader failed after ready",
        )))
        .expect("reader event");
        drop(tx);
        drain.join().expect("drain thread joined");
        assert_eq!(
            error.lock().expect("reader error lock").as_deref(),
            Some("reader failed after ready")
        );
    }

    #[test]
    #[cfg(unix)]
    fn group_wait_false_is_reported_as_kill_timeout() {
        let mut child = spawn_sh("sleep 60");
        let pgid = child.id() as i32;
        assert!(!wait_for_group_exit(pgid, Duration::ZERO).expect("group probe"));
        let timeout = group_timeout_error(pgid);
        assert_eq!(timeout.kind(), std::io::ErrorKind::TimedOut);
        assert!(timeout.to_string().contains("SIGKILL"));
        terminate_test_child(&mut child);
    }

    #[test]
    fn termination_errors_are_aggregated() {
        let error = aggregate_io_errors(vec![
            std::io::Error::other("TERM failed"),
            std::io::Error::other("KILL failed"),
            std::io::Error::other("wait failed"),
        ]);
        let message = error.to_string();
        assert!(message.contains("TERM failed"));
        assert!(message.contains("KILL failed"));
        assert!(message.contains("wait failed"));
    }

    #[test]
    #[cfg(unix)]
    fn startup_cancellation_stops_readiness_wait() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("dsh-rs-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-dsh");
        std::fs::write(&script, "#!/bin/sh\nsleep 60\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let spec = LaunchSpec::Binary(script);
        let start = Instant::now();
        let runner = std::thread::spawn(move || start_host_with_cancel(&spec, &flag));
        std::thread::sleep(Duration::from_millis(100));
        cancelled.store(true, Ordering::SeqCst);
        assert!(matches!(
            runner.join().expect("startup thread"),
            Err(HostError::Cancelled)
        ));
        assert!(start.elapsed() < Duration::from_secs(2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn poll_exit_returns_process_errors_as_result() {
        let child = spawn_sh("sleep 60");
        let mut host = HostProcess::from_child(child);
        assert!(host.poll_exit().expect("poll result").is_none());
        host.terminate().expect("terminate host");
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

    #[test]
    fn bundled_dsh_reads_resource_layout() {
        let tmp = std::env::temp_dir().join(format!("dsh-rs-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let pkg = tmp.join("dsh/node_modules/@deepseek-ai/dsh/lib");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("bin.js"), "#!/usr/bin/env node\n").unwrap();
        let found = find_bundled_dsh(&tmp).expect("bundled bin.js");
        assert!(found.ends_with("lib/bin.js"));
        assert!(find_bundled_dsh(&tmp.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bundled_node_is_runtime_bin_not_root_bin() {
        let tmp = std::env::temp_dir().join(format!("dsh-rs-node-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let pkg = tmp.join("node_modules/@deepseek-ai/dsh/lib");
        std::fs::create_dir_all(&pkg).unwrap();
        let bin = pkg.join("bin.js");
        std::fs::write(&bin, "#!/usr/bin/env node\n").unwrap();
        std::fs::create_dir_all(tmp.join("bin")).unwrap();
        let node = tmp.join("bin/node");
        std::fs::write(&node, "#!/bin/sh\n").unwrap();
        let found = find_bundled_node(&bin).expect("runtime node");
        assert_eq!(found, dunce_canonicalize(&node));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bundled_node_absent_when_dev_tree_has_no_runtime_bin() {
        let tmp = std::env::temp_dir().join(format!("dsh-rs-devtree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let pkg = tmp.join("node_modules/@deepseek-ai/dsh/lib");
        std::fs::create_dir_all(&pkg).unwrap();
        let bin = pkg.join("bin.js");
        std::fs::write(&bin, "#!/usr/bin/env node\n").unwrap();
        assert!(find_bundled_node(&bin).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn npm_probe_walks_parents() {
        let tmp = std::env::temp_dir().join(format!("dsh-rs-npm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let pkg = tmp.join("node_modules/@deepseek-ai/dsh/lib");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("bin.js"), "#!/usr/bin/env node\n").unwrap();
        let nested = tmp.join("src-tauri/target/debug");
        std::fs::create_dir_all(&nested).unwrap();
        let found = find_npm_dsh_from(&nested).expect("walk to package");
        assert!(found.ends_with("lib/bin.js"));
        let empty = std::env::temp_dir().join(format!("dsh-rs-npm-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        assert!(find_npm_dsh_from(&empty).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[cfg(unix)]
    fn spawn_sh(script: &str) -> Child {
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.process_group(0);
        cmd.spawn().expect("spawn sh")
    }

    #[cfg(unix)]
    fn terminate_test_child(child: &mut Child) {
        let pgid = child.id() as i32;
        terminate_group(child, Some(pgid)).expect("terminate child");
    }

    #[cfg(unix)]
    fn poll_until_gone(pid: i32) -> bool {
        for _ in 0..20 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    #[test]
    #[cfg(unix)]
    fn wait_for_url_reads_ready_line() {
        let mut child = spawn_sh("echo 'dsh web: http://127.0.0.1:4312'; sleep 30");
        let url = wait_for_url(&mut child, Duration::from_secs(10)).expect("ready url");
        assert_eq!(url, "http://127.0.0.1:4312");
        terminate_test_child(&mut child);
    }

    #[test]
    #[cfg(unix)]
    fn wait_for_url_reports_early_exit() {
        // The sleep gives the reader thread a moment to forward the stderr line.
        let mut child = spawn_sh("echo 'boom on stderr' >&2; sleep 0.2; exit 3");
        match wait_for_url(&mut child, Duration::from_secs(10)) {
            Err(HostError::Exited { code, tail }) => {
                assert_eq!(code, Some(3));
                assert!(tail.contains("boom on stderr"), "tail was: {tail}");
            }
            other => panic!("expected Exited, got {other:?}"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn wait_for_url_times_out_without_url() {
        let mut child = spawn_sh("echo 'some log line'; sleep 30");
        let start = Instant::now();
        match wait_for_url(&mut child, Duration::from_millis(300)) {
            Err(HostError::Timeout { tail }) => {
                assert!(tail.contains("some log line"), "tail was: {tail}")
            }
            other => panic!("expected Timeout, got {other:?}"),
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        terminate_test_child(&mut child);
    }

    #[test]
    #[cfg(unix)]
    fn terminate_escalates_when_term_ignored() {
        let mut child = spawn_sh("trap '' TERM; while true; do sleep 1; done");
        std::thread::sleep(Duration::from_millis(200));
        let start = Instant::now();
        let pgid = child.id() as i32;
        terminate_group_with_grace(&mut child, Some(pgid), Duration::from_millis(300))
            .expect("terminate child");
        assert!(child.try_wait().expect("poll child").is_some());
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(250),
            "SIGTERM should not have worked: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "termination hung: {elapsed:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn terminate_kills_process_group() {
        let mut child = spawn_sh("sleep 300 & echo grandchild:$!; wait");
        let stdout = child.stdout.take().expect("stdout piped");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("grandchild pid line");
        let pid: i32 = line
            .trim()
            .strip_prefix("grandchild:")
            .expect("prefix")
            .parse()
            .expect("pid");
        terminate_test_child(&mut child);
        assert!(
            poll_until_gone(pid),
            "grandchild {pid} survived group termination"
        );
    }

    #[test]
    #[cfg(unix)]
    fn start_host_runs_script_binary() {
        let dir = std::env::temp_dir().join(format!("dsh-rs-bin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-dsh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho 'dsh web: http://127.0.0.1:4399'\nsleep 60\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (mut host, url) = start_host(&LaunchSpec::Binary(script)).expect("host starts");
        assert_eq!(url, "http://127.0.0.1:4399");
        host.terminate().expect("terminate host");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn host_process_drop_terminates_child() {
        let child = spawn_sh("sleep 60");
        let pid = child.id() as i32;
        drop(HostProcess::from_child(child));
        assert!(poll_until_gone(pid), "child survived HostProcess drop");
    }
}
