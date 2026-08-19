# deepseek-rs

macOS window for the DeepSeek Harness **web** profile.

This app does not reimplement the agent. It starts `dsh --profile web`, waits for the `dsh web:` URL, and opens that loopback GUI in WKWebView.

Plugins, presets, and `~/.dsh` stay with `dsh`. Add a plugin the same way you do for the browser:

```sh
dsh plugin --profile web add <package>
```

This is not the JSON-RPC SDK client.

## Requirements

- macOS 14+
- Rust 1.77+ (for `cargo` / `tauri`)
- Node 22.19+ or 24+ (only when launching a source checkout)
- A DeepSeek Harness install, in this order:
  1. `DSH_BIN` — path to a `dsh` executable
  2. `DSH_REPO` — path to a `deepseek-harness` checkout
  3. `../deepseek-harness` next to this repo (also works when cwd is `src-tauri`)
  4. `~/Github/deepseek-harness` or `~/github/deepseek-harness`
  5. `dsh` on `PATH`

The checkout path runs:

```sh
node --import tsx/esm apps/cli/src/bin.ts --profile web --host 127.0.0.1 --port 0
```

from that directory. Run `pnpm install` in the checkout first.

Set `DEEPSEEK_API_KEY` in the environment that launches this app. The child inherits it.

## Develop

```sh
cd ~/Github/deepseek-rs
pnpm install
pnpm tauri dev
```

## Build a .app

```sh
pnpm tauri build --bundles app
```

The product is `src-tauri/target/release/bundle/macos/DeepSeek Harness.app`.

The packaged app still needs a Host on the machine (`DSH_BIN`, `DSH_REPO`, a sibling checkout, or `dsh` on `PATH`). It does not embed Node or the plugin tree.

## Layout

| Path | Role |
|---|---|
| `src/` | Splash page. Navigates away once the Host URL arrives. |
| `src-tauri/src/host.rs` | Find `dsh`, spawn it, parse the URL, stop the process group. |
| `src-tauri/src/lib.rs` | Tauri setup and shutdown. |

The Harness page loaded from `http://127.0.0.1` has no Tauri command access. Native pickers and `open` stay on the Host.

## License

MIT. DeepSeek Harness is a separate project with its own license.
