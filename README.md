# DeepSeek RS — Unofficial macOS wrapper

An **unofficial macOS wrapper** for the published [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) web profile. This project is independent of DeepSeek, deepseek-ai, and the DeepSeek Harness project. It is not affiliated with, endorsed by, or distributed by them.

This app does not reimplement the agent. It starts `@deepseek-ai/dsh@0.1.0-rc.7` (`dsh --profile web`), waits for the `dsh web:` URL, and opens that loopback GUI in WKWebView.

The upstream [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) project publishes that npm package. This repo does **not** clone that monorepo and does **not** `import` it as a library. The GitHub tree is a Cordis workspace; the product CLI is the published `dsh` bin. Upstream ownership does not make this wrapper an official DeepSeek product.

Plugins, presets, and `~/.dsh` stay with `dsh`. Add a plugin the same way you do for the browser:

```sh
pnpm exec dsh plugin --profile web add <package>
```

This repo ships `plugins/dsh-llm-grok`, an experimental and unofficial SuperGrok / X Premium+ OAuth plugin. It uses no xAI Console API key. Install it into the `web` profile, then restart the app:

```sh
pnpm --dir plugins/dsh-llm-grok pack --pack-destination "$HOME/.dsh/profiles/web"
pnpm exec dsh plugin --profile web add "$HOME/.dsh/profiles/web/dsh-llm-grok-0.1.0.tgz"
```

Do not use `link:`. Node follows the symlink to the repo, then cannot see `@deepseek-ai/schemastery` inside the `.app`. The tarball installs a real directory under `~/.dsh/profiles/web/node_modules`, so resolution walks up to `~/.dsh/profiles/node_modules`. Reinstalling the same `0.1.0` tarball can keep the old files; remove the package first, then add.

Open **Settings → Grok**, sign in, start a new session, and pick `Grok 4.6`.

This is not the JSON-RPC SDK client.

## Compatibility and release status

- Supported dsh runtime: **only** `@deepseek-ai/dsh@0.1.0-rc.7`. The exact dependency is pinned in `package.json` and `pnpm-lock.yaml`.
- The upstream dsh package is a **Developer Preview**. Its web profile, package APIs, plugin patch format, and provider behavior can change without notice. This wrapper does not provide compatibility for another dsh version until it is tested and its exact pin is updated.
- The Grok plugin is experimental and unofficial. Its tested host ranges are dsh packages `0.1.0-rc.7`, Cordis `4.0.1`, schemastery `3.18.1`, and React `18.3.1`.
- The release workflow targets **macOS arm64 only**. No signed release artifact is claimed yet; after the maintainer configures the Apple signing and notarization credentials, the workflow is intended to publish `DeepSeek-RS-<version>-aarch64-apple-darwin-ARM64.app.zip`. Local builds for another architecture are development builds, not release support.

## Requirements

- macOS 14+
- To **build** this repo: Rust 1.88+ (required by the locked Cargo dependency set), Node 22.19+ or ≥24, pnpm
- To **run a packaged `.app`**: macOS 14+ only. Node and `@deepseek-ai/dsh` are inside the app.

Host resolution order:

1. `DSH_BIN` — a `dsh` executable
2. `DSH_REPO` — an explicit harness checkout override for development, usable from source or a packaged app; formal releases do not depend on it
3. `DSH_PACKAGE` — a `@deepseek-ai/dsh` package directory (or its `lib/bin.js` directly)
4. the packaged tree `Contents/Resources/dsh` (`.app` only)
5. this repo's `node_modules/@deepseek-ai/dsh/lib/bin.js` (`pnpm tauri dev`)
6. `dsh` on `PATH`

`pnpm install` pulls the pinned `@deepseek-ai/dsh@0.1.0-rc.7` from the npm registry. A checkout under `~/Github/deepseek-harness` is not auto-selected; set `DSH_REPO` to use it as a development override. Formal releases use the embedded runtime and do not depend on that checkout.

`pnpm tauri build` runs `scripts/prepare-bundle.mjs`. That script downloads Node `22.19.0` and a hoisted production install of the pinned `@deepseek-ai/dsh`, then Tauri copies `vendor/runtime` to `Contents/Resources/dsh`. The packaged process uses that `bin/node`, not the system Node. The app resource root also contains `LICENSE` and `THIRD_PARTY_NOTICES.md`; the generated runtime notice is `Contents/Resources/dsh/licenses/THIRD_PARTY_NOTICES.txt`.

The app uses the macOS hardened runtime. The bundled Node/V8 process needs JIT for normal execution, so `src-tauri/entitlements.plist` keeps `com.apple.security.cs.allow-jit`. V8 on Intel macOS can also require unsigned executable memory, and dsh loads native addons such as `node-pty`, `koffi`, and `node-addon-require-builtin`; the related entitlements are kept for those runtime paths. No app data, network, camera, microphone, or automation entitlement is requested.

Set `DEEPSEEK_API_KEY` in the environment that launches this app, or in the Harness home files `dsh` already loads (`~/.dsh`). Finder does not pass your shell env. The child inherits whatever the app process has.

`DSH_NODE` overrides the Node interpreter used to run `lib/bin.js`.

## Develop

```sh
cd ~/Github/deepseek-rs
pnpm install
pnpm tauri dev
```

## Build an app locally

```sh
pnpm tauri build --bundles app
```

This command builds `src-tauri/target/release/bundle/macos/DeepSeek RS.app`. Without release credentials it is an unsigned local build for development and testing. After the maintainer configures the Apple credentials, the release workflow is intended to sign, notarize, staple, and publish `DeepSeek-RS-<version>-aarch64-apple-darwin-ARM64.app.zip`; no current formal artifact is implied, and no other bundle target is configured.

The `.app` includes Node and `@deepseek-ai/dsh`. Install that app; do not install the `deepseek-harness` git repo. First build downloads Node and the npm tree (about 400MB under `vendor/runtime`, gitignored). Rebuilds skip the download when the stamp still matches.

`pnpm tauri dev` still uses this repo's `node_modules` and the Node on `PATH`.

Plugins stay in `~/.dsh`. Adding a plugin still needs pnpm on the machine (`dsh plugin` forwards to it).

## Upgrade and rollback

Keep the dsh version exact. Treat an upstream Developer Preview upgrade as a compatibility change:

1. Review the upstream release notes and test the new dsh version in a source checkout.
2. Change the exact `@deepseek-ai/dsh` value in `package.json`, run `pnpm install --lockfile-only`, and update the compatibility note and plugin peer pins when the host contracts change.
3. Run `pnpm run quality`, `pnpm --dir plugins/dsh-llm-grok run quality`, and a packaged-app smoke test. Keep the previous `.app`, `package.json`, lockfile, and plugin tarball until this passes.

To roll back, restore the previous exact dsh value and matching lockfile, run `pnpm install --frozen-lockfile`, and rebuild or reopen the previous `.app`. If the plugin was upgraded too, remove it from the profile and add the archived previous tarball. Do not run an unconstrained install during rollback.

## Tests

Run the root checks and the plugin checks before a release candidate:

```sh
pnpm run quality
pnpm --dir plugins/dsh-llm-grok run quality
```

## Layout

| Path                    | Role                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `src/`                         | Splash page. Navigates away once the Host URL arrives.                       |
| `scripts/prepare-bundle.mjs`    | Download Node and flatten a production `@deepseek-ai/dsh` tree.              |
| `vendor/runtime`                | Generated Host tree copied into the `.app`.                                  |
| `src-tauri/src/host.rs`         | Find `dsh`, spawn it, parse the URL, stop the process group.                 |
| `src-tauri/src/lib.rs`          | Tauri setup and shutdown; supervises the host and restarts it after a crash. |

The dsh web page loaded from `http://127.0.0.1` has no Tauri command access. Native pickers and `open` stay on the Host.

## License

This wrapper is MIT licensed; see [`LICENSE`](LICENSE). The app carries that file, [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), and the generated runtime notice listed above. The upstream dsh and DeepSeek Harness projects remain separate projects with their own licenses.
