//! macOS window that boots `dsh --profile web` and opens its loopback GUI.

#[cfg(not(target_os = "macos"))]
compile_error!("deepseek-rs targets macOS only");

mod host;

use std::sync::Mutex;

use host::{resolve_launch, start_host, HostProcess, LaunchSpec};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

struct HostState(Mutex<Option<HostProcess>>);

impl HostState {
    fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn attach(&self, process: HostProcess) {
        let mut slot = self.0.lock().expect("host state lock");
        if let Some(mut previous) = slot.replace(process) {
            previous.terminate();
        }
    }

    fn terminate(&self) {
        if let Some(mut process) = self.0.lock().expect("host state lock").take() {
            process.terminate();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(HostState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("dsh-host".into())
                .spawn(move || boot_host(handle))
                .expect("spawn host thread");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building deepseek-rs");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            app.state::<HostState>().terminate();
        }
    });
}

fn boot_host(app: AppHandle) {
    let spec = match resolve_launch() {
        Ok(spec) => spec,
        Err(err) => {
            let _ = app.emit("host-error", err.to_string());
            return;
        }
    };
    eprintln!("deepseek-rs: launching {}", describe(&spec));
    match start_host(&spec) {
        Ok((process, url)) => {
            eprintln!("deepseek-rs: host ready at {url}");
            app.state::<HostState>().attach(process);
            let _ = app.emit("host-ready", url);
        }
        Err(err) => {
            eprintln!("deepseek-rs: host failed: {err}");
            let _ = app.emit("host-error", err.to_string());
        }
    }
}

fn describe(spec: &LaunchSpec) -> String {
    match spec {
        LaunchSpec::Binary(path) => format!("binary {}", path.display()),
        LaunchSpec::Source(path) => format!("source checkout {}", path.display()),
    }
}
