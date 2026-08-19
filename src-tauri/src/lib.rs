//! macOS window that boots `dsh --profile web` and opens its loopback GUI.

#[cfg(not(target_os = "macos"))]
compile_error!("deepseek-rs targets macOS only");

mod host;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use host::{resolve_launch, start_host_with_cancel, HostProcess, LaunchSpec};
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent};
use url::Url;

/// How long to wait for the splash page's listeners before emitting host
/// events anyway (they are normally up within a second).
const SPLASH_READY_TIMEOUT: Duration = Duration::from_secs(30);
/// A host that stayed up this long resets the restart budget.
const STABLE_UPTIME: Duration = Duration::from_secs(60);
/// How many rapid crashes to tolerate before giving up.
const MAX_RESTARTS: u32 = 3;
/// Child-exit poll interval for the supervisor.
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Set once the splash page has registered its `host-ready`/`host-error`
/// listeners; events emitted before that would be lost.
struct SplashGate {
    ready: Mutex<bool>,
    signal: Condvar,
    timeout: Duration,
}

impl SplashGate {
    fn new(timeout: Duration) -> Self {
        Self {
            ready: Mutex::new(false),
            signal: Condvar::new(),
            timeout,
        }
    }

    fn mark_ready(&self) {
        match self.ready.lock() {
            Ok(mut ready) => {
                *ready = true;
                self.signal.notify_all();
            }
            Err(_) => eprintln!("deepseek-rs: splash gate lock is poisoned"),
        }
    }

    fn reset(&self) -> Result<(), String> {
        let mut ready = self
            .ready
            .lock()
            .map_err(|_| "splash gate lock is poisoned".to_string())?;
        *ready = false;
        Ok(())
    }

    #[cfg(test)]
    fn wait(&self) -> Result<bool, String> {
        static NEVER_CANCELLED: AtomicBool = AtomicBool::new(false);
        self.wait_with_cancel(&NEVER_CANCELLED)
    }

    fn wait_with_cancel(&self, cancelled: &AtomicBool) -> Result<bool, String> {
        let deadline = Instant::now() + self.timeout;
        let guard = self
            .ready
            .lock()
            .map_err(|_| "splash gate lock is poisoned".to_string())?;
        let mut guard = guard;
        loop {
            if *guard {
                return Ok(true);
            }
            if cancelled.load(Ordering::SeqCst) {
                return Ok(false);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            let wait = Duration::from_millis(50).min(remaining);
            guard = self
                .signal
                .wait_timeout(guard, wait)
                .map_err(|_| "splash gate lock is poisoned".to_string())?
                .0;
        }
    }
}

struct HostState {
    process: Mutex<Option<Arc<Mutex<HostProcess>>>>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
    shutdown_cleanup: Mutex<()>,
    shutdown_requested: AtomicBool,
    shutdown_completed: AtomicBool,
}

impl HostState {
    fn new() -> Self {
        Self {
            process: Mutex::new(None),
            supervisor: Mutex::new(None),
            shutdown_cleanup: Mutex::new(()),
            shutdown_requested: AtomicBool::new(false),
            shutdown_completed: AtomicBool::new(false),
        }
    }

    /// Publish a freshly started host. Returns the shared handle the
    /// supervisor polls, or `None` — killing the process — when the app is
    /// already shutting down.
    fn attach(&self, mut process: HostProcess) -> Result<Option<Arc<Mutex<HostProcess>>>, String> {
        let mut slot = match self.process.lock() {
            Ok(slot) => slot,
            Err(poisoned) => {
                let previous = poisoned.into_inner().take();
                let mut failure = "host state lock is poisoned".to_string();
                if let Err(err) = process.terminate() {
                    failure.push_str(&format!("; failed to terminate new dsh: {err}"));
                }
                drop(previous);
                return Err(failure);
            }
        };
        if self.is_shutting_down() {
            drop(slot);
            process
                .terminate()
                .map_err(|err| format!("failed to terminate dsh during shutdown: {err}"))?;
            return Ok(None);
        }
        let shared = Arc::new(Mutex::new(process));
        if let Some(previous) = slot.replace(shared.clone()) {
            let result = match previous.lock() {
                Ok(mut previous) => previous
                    .terminate()
                    .map_err(|err| format!("failed to terminate previous dsh: {err}")),
                Err(_) => Err("host process lock is poisoned".to_string()),
            };
            if let Err(err) = result {
                // Do not publish a new process when retiring the old one
                // failed. Both the old and new handles are dropped below;
                // HostProcess::Drop performs a final group cleanup.
                slot.take();
                drop(slot);
                let cleanup = terminate_shared(&shared, "new dsh after attach failure");
                drop(previous);
                return match cleanup {
                    Ok(()) => Err(err),
                    Err(cleanup) => Err(format!("{err}; cleanup failed: {cleanup}")),
                };
            }
        }
        Ok(Some(shared))
    }

    fn request_shutdown(&self) -> bool {
        !self.shutdown_requested.swap(true, Ordering::SeqCst)
    }

    fn is_shutting_down(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }

    fn mark_shutdown_completed(&self) {
        self.shutdown_completed.store(true, Ordering::SeqCst);
    }

    fn is_shutdown_completed(&self) -> bool {
        self.shutdown_completed.load(Ordering::SeqCst)
    }

    /// Detach and terminate the currently published host before reporting a
    /// watch/attach failure. The slot is empty even when termination fails.
    fn detach_and_terminate(&self) -> Result<(), String> {
        let mut failure = None;
        let process = match self.process.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => {
                failure = Some("host state lock is poisoned".to_string());
                poisoned.into_inner().take()
            }
        };
        if let Some(process) = process {
            if let Err(err) = terminate_shared(&process, "dsh") {
                if failure.is_none() {
                    failure = Some(err);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Kill the host and join the supervisor. Blocks until the process group
    /// is gone; call from a thread that may block.
    fn terminate(&self) -> Result<(), String> {
        // ExitRequested and Exit can arrive on different threads. Serialize
        // the cleanup so shutdown_completed cannot become true while another
        // caller is still terminating or joining the supervisor.
        let _cleanup_guard = match self.shutdown_cleanup.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        self.request_shutdown();
        let mut failure = None;
        let process = match self.process.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => {
                failure = Some("host state lock is poisoned".to_string());
                poisoned.into_inner().take()
            }
        };
        if let Some(process) = process {
            if let Err(err) = terminate_shared(&process, "dsh") {
                if failure.is_none() {
                    failure = Some(err);
                }
            }
        }
        let supervisor = match self.supervisor.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => {
                if failure.is_none() {
                    failure = Some("supervisor lock is poisoned".to_string());
                }
                poisoned.into_inner().take()
            }
        };
        if let Some(supervisor) = supervisor {
            if supervisor.join().is_err() && failure.is_none() {
                failure = Some("dsh supervisor thread panicked".to_string());
            }
        }
        self.mark_shutdown_completed();
        failure.map_or(Ok(()), Err)
    }
}

fn terminate_shared(process: &Arc<Mutex<HostProcess>>, name: &str) -> Result<(), String> {
    match process.lock() {
        Ok(mut process) => process
            .terminate()
            .map_err(|err| format!("failed to terminate {name}: {err}")),
        Err(_) => Err(format!("{name} process lock is poisoned")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = match tauri::Builder::default()
        .manage(HostState::new())
        .setup(|app| {
            let gate = Arc::new(SplashGate::new(SPLASH_READY_TIMEOUT));
            let listener_gate = gate.clone();
            let _ = app.listen("splash-ready", move |_| listener_gate.mark_ready());
            let splash_url = app
                .get_webview_window("main")
                .and_then(|window| window.url().ok());
            let handle = app.handle().clone();
            let supervisor = std::thread::Builder::new()
                .name("dsh-host".into())
                .spawn(move || supervise_host(handle, gate, splash_url))?;
            app.state::<HostState>()
                .supervisor
                .lock()
                .map_err(|_| std::io::Error::other("supervisor lock is poisoned"))?
                .replace(supervisor);
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(err) => {
            eprintln!("deepseek-rs: error while building application: {err}");
            return;
        }
    };

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            // Termination can take seconds (SIGTERM grace), so it runs on a
            // side thread; the app exits for real once the host is gone.
            let state = app.state::<HostState>();
            if state.is_shutdown_completed() {
                return;
            }
            api.prevent_exit();
            if !state.request_shutdown() {
                return;
            }
            let handle = app.clone();
            match std::thread::Builder::new()
                .name("dsh-shutdown".into())
                .spawn(move || {
                    if let Err(err) = handle.state::<HostState>().terminate() {
                        eprintln!("deepseek-rs: shutdown failed: {err}");
                    }
                    handle.exit(0);
                }) {
                Ok(_) => {}
                Err(err) => {
                    eprintln!("deepseek-rs: failed to start shutdown thread: {err}");
                    if let Err(cleanup) = state.terminate() {
                        eprintln!("deepseek-rs: synchronous shutdown failed: {cleanup}");
                    }
                    app.exit(1);
                }
            }
        }
        RunEvent::Exit => {
            let state = app.state::<HostState>();
            if !state.is_shutdown_completed() {
                if let Err(err) = state.terminate() {
                    eprintln!("deepseek-rs: shutdown failed: {err}");
                }
            }
        }
        _ => {}
    });
}

fn supervise_host(app: AppHandle, gate: Arc<SplashGate>, splash_url: Option<Url>) {
    let mut restarts = 0u32;
    loop {
        let resource_dir = app.path().resource_dir().ok();
        let spec = match resolve_launch(resource_dir.as_deref()) {
            Ok(spec) => spec,
            Err(err) => {
                show_host_error(&app, &gate, splash_url.as_ref(), err.to_string());
                return;
            }
        };
        eprintln!("deepseek-rs: launching {}", describe(&spec));
        let cancellation = &app.state::<HostState>().shutdown_requested;
        let (process, url) = match start_host_with_cancel(&spec, cancellation) {
            Ok(ok) => ok,
            Err(err) => {
                eprintln!("deepseek-rs: host failed: {err}");
                let state = app.state::<HostState>();
                if !state.is_shutting_down() {
                    let message = cleanup_with_message(&state, err.to_string());
                    show_host_error(&app, &gate, splash_url.as_ref(), message);
                }
                return;
            }
        };
        eprintln!("deepseek-rs: host ready at {url}");
        let shared = match app.state::<HostState>().attach(process) {
            Ok(Some(shared)) => shared,
            Ok(None) => return,
            Err(err) => {
                let state = app.state::<HostState>();
                if state.is_shutting_down() {
                    if let Err(cleanup) = state.detach_and_terminate() {
                        eprintln!("deepseek-rs: attach cleanup failed during shutdown: {cleanup}");
                    }
                    return;
                }
                let message = cleanup_with_message(&state, err);
                show_host_error(&app, &gate, splash_url.as_ref(), message);
                return;
            }
        };
        if restarts == 0 {
            match gate.wait_with_cancel(cancellation) {
                Ok(true) => {
                    if let Err(err) = app.emit("host-ready", url) {
                        let state = app.state::<HostState>();
                        if state.is_shutting_down() {
                            if let Err(cleanup) = state.detach_and_terminate() {
                                eprintln!(
                                    "deepseek-rs: host-ready cleanup failed during shutdown: {cleanup}"
                                );
                            }
                            return;
                        }
                        let message = cleanup_with_message(
                            &state,
                            format!("Failed to emit host-ready: {err}"),
                        );
                        show_host_error(&app, &gate, splash_url.as_ref(), message);
                        return;
                    }
                }
                Ok(false) => {
                    let state = app.state::<HostState>();
                    if state.is_shutting_down() {
                        if let Err(cleanup) = state.detach_and_terminate() {
                            eprintln!(
                                "deepseek-rs: splash cleanup failed during shutdown: {cleanup}"
                            );
                        }
                        return;
                    }
                    let message = cleanup_with_message(
                        &state,
                        "Timed out waiting for splash listeners.".to_string(),
                    );
                    show_host_error(&app, &gate, splash_url.as_ref(), message);
                    return;
                }
                Err(err) => {
                    let state = app.state::<HostState>();
                    let message = cleanup_with_message(&state, err);
                    show_host_error(&app, &gate, splash_url.as_ref(), message);
                    return;
                }
            }
        } else {
            // The splash page navigated away already; point the window at the
            // new host directly. A failed navigation must not leave the
            // supervisor watching a page that cannot display this host.
            let navigation = match app.get_webview_window("main") {
                Some(window) => match url.parse::<Url>() {
                    Ok(parsed) => window
                        .navigate(parsed)
                        .map_err(|err| format!("cannot navigate to {url}: {err}")),
                    Err(err) => Err(format!("cannot parse {url}: {err}")),
                },
                None => Err("main window is unavailable for host navigation".to_string()),
            };
            if !restart_navigation_can_continue(
                app.state::<HostState>().is_shutting_down(),
                navigation.is_ok(),
            ) {
                let state = app.state::<HostState>();
                if state.is_shutting_down() {
                    if let Err(cleanup) = state.detach_and_terminate() {
                        eprintln!("deepseek-rs: restart cleanup failed during shutdown: {cleanup}");
                    }
                    return;
                }
                let failure = match navigation {
                    Err(failure) => failure,
                    Ok(()) => "restart navigation was cancelled".to_string(),
                };
                let message = cleanup_with_message(
                    &state,
                    format!("Failed to navigate to restarted dsh: {failure}"),
                );
                show_host_error(&app, &gate, splash_url.as_ref(), message);
                return;
            }
        }
        let up_since = Instant::now();
        match watch_host(&app, &shared) {
            Ok(true) => return,
            Ok(false) => {}
            Err(err) => {
                let state = app.state::<HostState>();
                if state.is_shutting_down() {
                    if let Err(cleanup) = state.detach_and_terminate() {
                        eprintln!("deepseek-rs: watch cleanup failed during shutdown: {cleanup}");
                    }
                    return;
                }
                let message = cleanup_with_message(&state, format!("Failed to monitor dsh: {err}"));
                show_host_error(&app, &gate, splash_url.as_ref(), message);
                return;
            }
        }
        if up_since.elapsed() >= STABLE_UPTIME {
            restarts = 0;
        }
        restarts += 1;
        if restarts > MAX_RESTARTS {
            let state = app.state::<HostState>();
            if state.is_shutting_down() {
                if let Err(cleanup) = state.detach_and_terminate() {
                    eprintln!("deepseek-rs: restart cleanup failed during shutdown: {cleanup}");
                }
                return;
            }
            let message =
                cleanup_with_message(&state, "dsh crashed repeatedly; giving up.".to_string());
            show_host_error(&app, &gate, splash_url.as_ref(), message);
            return;
        }
        let backoff = Duration::from_secs(1 << (restarts - 1));
        eprintln!("deepseek-rs: restarting host ({restarts}/{MAX_RESTARTS}) in {backoff:?}");
        let deadline = Instant::now() + backoff;
        while Instant::now() < deadline {
            if app.state::<HostState>().is_shutting_down() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}
/// Poll the child until it exits or shutdown begins; `true` means the exit
/// was an intentional shutdown.
fn watch_host(app: &AppHandle, shared: &Arc<Mutex<HostProcess>>) -> Result<bool, String> {
    loop {
        std::thread::sleep(POLL_INTERVAL);
        if app.state::<HostState>().is_shutting_down() {
            return Ok(true);
        }
        let status = shared
            .lock()
            .map_err(|_| "host process lock is poisoned".to_string())?
            .poll_exit()
            .map_err(|err| err.to_string())?;
        if let Some(status) = status {
            eprintln!("deepseek-rs: host exited unexpectedly ({status})");
            return Ok(false);
        }
    }
}

/// Return to the local splash before reporting an error. The splash emits a
/// fresh `splash-ready` event after navigation, so the error cannot be lost
/// while the webview reloads. A navigation or readiness failure exits instead
/// of pretending that a remote page is ready for the error event.
fn show_host_error(
    app: &AppHandle,
    gate: &SplashGate,
    splash_url: Option<&Url>,
    message: String,
) -> bool {
    let Some(url) = splash_url else {
        eprintln!("deepseek-rs: no local splash URL is available");
        app.exit(1);
        return false;
    };
    if let Err(err) = gate.reset() {
        eprintln!("deepseek-rs: cannot reset splash gate: {err}");
        app.exit(1);
        return false;
    }
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("deepseek-rs: main window is unavailable for splash navigation");
        app.exit(1);
        return false;
    };
    if let Err(err) = window.navigate(url.clone()) {
        eprintln!("deepseek-rs: cannot navigate to splash: {err}");
        app.exit(1);
        return false;
    }
    match gate.wait_with_cancel(&app.state::<HostState>().shutdown_requested) {
        Ok(ready) => {
            if can_emit_host_error(true, ready) {
                if let Err(err) = app.emit("host-error", message) {
                    eprintln!("deepseek-rs: failed to emit host-error: {err}");
                    app.exit(1);
                    return false;
                }
                return true;
            }
            if !app.state::<HostState>().is_shutting_down() {
                eprintln!("deepseek-rs: splash did not report ready after navigation");
                app.exit(1);
            }
            false
        }
        Err(err) => {
            eprintln!("deepseek-rs: cannot wait for splash listeners: {err}");
            app.exit(1);
            false
        }
    }
}

fn can_emit_host_error(navigated_to_splash: bool, splash_ready: bool) -> bool {
    navigated_to_splash && splash_ready
}

fn restart_navigation_can_continue(shutting_down: bool, navigation_succeeded: bool) -> bool {
    !shutting_down && navigation_succeeded
}

fn append_cleanup_error(message: String, cleanup: Result<(), String>) -> String {
    match cleanup {
        Ok(()) => message,
        Err(cleanup) => format!("{message}\n\nCleanup also failed: {cleanup}"),
    }
}

fn cleanup_with_message(state: &HostState, message: String) -> String {
    append_cleanup_error(message, state.detach_and_terminate())
}

fn describe(spec: &LaunchSpec) -> String {
    match spec {
        LaunchSpec::Binary(path) => format!("binary {}", path.display()),
        LaunchSpec::Npm { bin, node } => {
            format!("npm package {} via {}", bin.display(), node.display())
        }
        LaunchSpec::Source(path) => format!("source checkout {}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    #[cfg(unix)]
    use std::process::{Command, Stdio};

    #[test]
    fn splash_gate_timeout_is_not_ready() {
        let gate = SplashGate::new(Duration::from_millis(5));
        assert!(!gate.wait().expect("splash wait"));
        gate.mark_ready();
        assert!(gate.wait().expect("splash wait"));
    }

    #[test]
    fn splash_gate_reset_requires_a_new_ready_signal() {
        let gate = SplashGate::new(Duration::from_millis(5));
        gate.mark_ready();
        assert!(gate.wait().expect("splash wait"));
        gate.reset().expect("splash reset");
        assert!(!gate.wait().expect("splash wait"));
    }

    #[test]
    fn splash_gate_cancellation_does_not_wait_for_timeout() {
        let gate = SplashGate::new(Duration::from_secs(30));
        let cancelled = AtomicBool::new(true);
        let start = Instant::now();
        assert!(!gate.wait_with_cancel(&cancelled).expect("splash wait"));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn splash_navigation_failure_cannot_emit_remote_error() {
        assert!(!can_emit_host_error(false, true));
        assert!(!can_emit_host_error(true, false));
        assert!(can_emit_host_error(true, true));
    }

    #[test]
    fn restart_navigation_failure_cannot_continue_watching_host() {
        assert!(!restart_navigation_can_continue(false, false));
        assert!(!restart_navigation_can_continue(true, true));
        assert!(restart_navigation_can_continue(false, true));
    }

    #[test]
    fn cleanup_error_is_appended_to_original_failure() {
        let message = append_cleanup_error(
            "watch failed".to_string(),
            Err("TERM; KILL; wait failed".to_string()),
        );
        assert!(message.contains("watch failed"));
        assert!(message.contains("TERM; KILL; wait failed"));
    }

    #[test]
    fn shutdown_request_and_completion_are_distinct() {
        let state = HostState::new();
        assert!(state.request_shutdown());
        assert!(!state.request_shutdown());
        assert!(!state.is_shutdown_completed());
        state.mark_shutdown_completed();
        assert!(state.is_shutdown_completed());
    }

    #[test]
    fn shutdown_cleanup_is_serialized_across_exit_race() {
        let state = Arc::new(HostState::new());
        let first = state.clone();
        let second = state.clone();
        let first = std::thread::spawn(move || first.terminate());
        let second = std::thread::spawn(move || second.terminate());
        assert!(first.join().expect("first shutdown").is_ok());
        assert!(second.join().expect("second shutdown").is_ok());
        assert!(state.is_shutdown_completed());
    }

    #[test]
    #[cfg(unix)]
    fn attach_failure_rolls_back_slot_and_terminates_new_process() {
        let state = HostState::new();
        let (previous, previous_pid) = test_host_process();
        let previous = Arc::new(Mutex::new(previous));
        let poison = previous.clone();
        std::thread::spawn(move || {
            let _guard = poison.lock().expect("previous process lock");
            panic!("poison previous process lock");
        })
        .join()
        .expect_err("poisoning thread should panic");
        state
            .process
            .lock()
            .expect("host state lock")
            .replace(previous);

        let (incoming, incoming_pid) = test_host_process();
        assert!(state.attach(incoming).is_err());
        assert!(state.process.lock().expect("host state lock").is_none());
        assert!(poll_until_gone(previous_pid));
        assert!(poll_until_gone(incoming_pid));
    }

    #[test]
    #[cfg(unix)]
    fn detach_terminates_and_clears_published_process() {
        let state = HostState::new();
        let (process, pid) = test_host_process();
        assert!(state.attach(process).expect("attach").is_some());
        state.detach_and_terminate().expect("detach");
        assert!(state.process.lock().expect("host state lock").is_none());
        assert!(poll_until_gone(pid));
    }

    #[test]
    #[cfg(unix)]
    fn real_poll_error_is_preserved_for_supervisor() {
        let (child, pid) = test_child();
        let mut status = 0;
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        assert_eq!(waited, pid);
        let mut process = HostProcess::from_child(child);
        match process.poll_exit() {
            Err(host::HostError::TryWait(err)) => {
                assert_eq!(err.raw_os_error(), Some(libc::ECHILD));
            }
            other => panic!("expected real poll error, got {other:?}"),
        }
        // The test reaped this child through libc to force ECHILD. Do not run
        // HostProcess::Drop, which would only report that expected condition.
        std::mem::forget(process);
    }

    #[cfg(unix)]
    fn test_host_process() -> (HostProcess, i32) {
        let (child, pid) = test_child_with_script("sleep 60");
        (HostProcess::from_child(child), pid)
    }

    #[cfg(unix)]
    fn test_child() -> (std::process::Child, i32) {
        test_child_with_script("exit 0")
    }

    #[cfg(unix)]
    fn test_child_with_script(script: &str) -> (std::process::Child, i32) {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let child = command.spawn().expect("spawn test child");
        let pid = child.id() as i32;
        (child, pid)
    }

    #[cfg(unix)]
    fn poll_until_gone(pid: i32) -> bool {
        for _ in 0..30 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}
