# Architecture

`deepseek-rs` is an unofficial macOS shell for the published DeepSeek Harness CLI. It does not clone the Harness repository or implement the agent. The app starts `@deepseek-ai/dsh@0.1.0-rc.7`, asks it for the `web` profile, and displays the returned local page in a Tauri WebView.

## Runtime components

| Component | Responsibility | Source |
| --- | --- | --- |
| Tauri application | Creates the macOS window, supervises the Host, and handles shutdown | [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) |
| Host resolver | Selects a `dsh` binary, package, source checkout, or packaged runtime | [`src-tauri/src/host.rs`](../src-tauri/src/host.rs) |
| Host process | Runs `dsh --profile web --host 127.0.0.1 --port 0` | [`src-tauri/src/host.rs`](../src-tauri/src/host.rs) |
| Splash page | Waits for a Tauri event, then navigates to the loopback URL | [`src/main.ts`](../src/main.ts) and [`index.html`](../index.html) |
| Packaged runtime | Supplies Node.js 22.19.0 and the production `dsh` tree | [`scripts/prepare-bundle.mjs`](../scripts/prepare-bundle.mjs) |

The app's native capability grants core Tauri permissions to the splash window. The Harness page loaded from loopback receives no Tauri command access. See [`src-tauri/capabilities/default.json`](../src-tauri/capabilities/default.json).

## Startup and shutdown

1. Tauri creates the splash window and starts the Host supervisor.
2. The resolver checks `DSH_BIN`, `DSH_REPO`, `DSH_PACKAGE`, the packaged `Contents/Resources/dsh` tree, a local npm install, and `dsh` on `PATH` in that order. `DSH_NODE` can override the Node interpreter for a package launch.
3. The selected process starts with the `web` profile, binds to `127.0.0.1`, and asks the Host to choose a free port.
4. The native Host reads stdout and stderr until it finds a `dsh web:` line with an `http://127.0.0.1:<port>` or `http://localhost:<port>` URL. It rejects non-loopback URLs and times out after 90 seconds.
5. The splash page emits `splash-ready`. The native side emits `host-ready`, and the page navigates away from the splash screen to the Host URL.
6. If the Host exits, the supervisor waits with 1, 2, and 4 second backoffs and allows three rapid restarts. A Host that runs for 60 seconds resets the rapid-restart counter. Repeated failure emits `host-error`.
7. On app exit, the native side sends `SIGTERM` to the Host process group, waits up to six seconds, then sends `SIGKILL` and waits for the group to end.

## State and extension points

The Harness owns its sessions, settings, plugins, and credential files under its normal home paths. The wrapper does not move or proxy that state. The `dsh-llm-grok` package is an optional plugin installed into the `web` profile; it is not part of the default generated runtime. See [`plugins/dsh-llm-grok/README.md`](../plugins/dsh-llm-grok/README.md).

The app has two launch planes. A packaged app uses the flattened runtime under `Contents/Resources/dsh`. Development can use the local npm tree, a trusted `DSH_BIN`, a trusted `DSH_PACKAGE`, or a trusted `DSH_REPO`. These overrides are local execution controls, not release compatibility promises.

## Build and release boundary

[`scripts/prepare-bundle.mjs`](../scripts/prepare-bundle.mjs) downloads the official Node.js archive, verifies its SHA-256 entry from `SHASUMS256.txt`, installs the pinned production npm tree, flattens symlinks, copies Node to `vendor/runtime/bin/node`, and writes the Node license and generated npm notice manifest under `vendor/runtime/licenses`. Tauri copies that tree into the app resources. Cargo/Tauri notice collection, signing, notarization, and artifact verification remain release tasks; this repository does not record a completed release for them. See [`docs/releasing.md`](releasing.md).
