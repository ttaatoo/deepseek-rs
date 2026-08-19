# Threat model

This document describes the current `deepseek-rs` wrapper. It is not a security certification or a claim of production validation.

## Assets

- DeepSeek API keys and other provider credentials inherited by the Host process.
- Grok OAuth access and refresh tokens in `$DSH_HOME/grok-oauth.json` and a reused `~/.grok/auth.json`.
- Harness settings, session transcripts, prompts, tool inputs, and local plugin files.
- The loopback Host page and the native app that starts it.
- Build inputs, npm packages, the Node.js runtime, and the signed release identity required for distribution.

## Trust boundaries

| Boundary | Trusted side | Other side | Main concern |
| --- | --- | --- | --- |
| User environment to native app | The app process | Environment variables and local paths | `DSH_BIN`, `DSH_REPO`, `DSH_PACKAGE`, and `DSH_NODE` can select executable code. |
| Native app to Host | The Rust supervisor | Node.js and `dsh` plugins | The child inherits the app environment and user permissions. |
| Host to WebView | Loopback `dsh` server | Local browser processes | Loopback is reachable by other local processes and is not an authentication boundary. |
| Host to providers | The local Host | DeepSeek, xAI, and other configured endpoints | Credentials and user data leave the machine according to provider behavior. |
| Build to app artifact | Maintainer build environment | npm, Node.js, Cargo, and downloaded archives | A compromised dependency or build machine can alter the app. |

## Mitigations in the current code

- The native command uses `--profile web`, `--host 127.0.0.1`, and `--port 0`. URL parsing accepts only loopback HTTP URLs before the WebView navigates.
- The Host runs as a child process group. Shutdown sends `SIGTERM`, then `SIGKILL` after a six-second grace period. The supervisor bounds rapid restarts.
- The packaged build pins `@deepseek-ai/dsh` to `0.1.0-rc.7`. The bundle script verifies the downloaded Node.js archive against the official SHA-256 list and uses a flattened production install.
- The Harness page has no Tauri command permission. Native events are limited to the splash page's readiness, success, and error flow.
- The Grok plugin writes its own token file with mode `0600` and does not delete the official Grok CLI file on sign-out.

## Session and token-file invariants

Grok login, refresh, cancel, and logout can overlap. The plugin must protect the session file as one shared state machine:

- Each login or refresh captures the current session generation. `cancel` and `logout` invalidate that generation before they abort work.
- An async completion may write only when its captured generation is still current. A stale refresh must not restore a session after logout or a new login.
- An `invalid_grant` result may delete a file only when the file still contains the refresh token used by that request. It must not delete a newer login.
- Serialize file mutations and keep one refresh flight for a session identity. Keep regression tests for logout during refresh, new login over an old refresh, and stale `invalid_grant` handling.

The plugin-owned `$DSH_HOME/grok-oauth.json` file has these file-system requirements:

- It is a regular file owned by the current user with exact mode `0600`.
- Reads use `O_NOFOLLOW` and a second metadata check. Reject symlinks, non-regular files, and other modes.
- Writes use an exclusive temporary file with mode `0600`, flush the file, rename it atomically, and sync the directory.
- Logout removes the plugin file and syncs the directory. It does not remove the upstream `~/.grok/auth.json` file.

The imported `~/.grok/auth.json` file is upstream-owned. The wrapper does not add the same no-symlink or mode checks to that file. Treat both token files as local credentials. A same-account process or compromised host can still read them.

These invariants and tests are release requirements. They are not production validation.

## Residual risks

- A local account, malware, or another process with suitable access may read token files, observe the loopback port, inject a plugin, or replace a development override. File mode `0600` does not protect against the same account or a compromised host.
- The app process inherits its launch environment. Finder and shells can provide different variables, and a secret placed in an environment remains available to the child process.
- The current source sets hardened-runtime and JIT-related entitlements, but the repository has no completed signing or notarization evidence. An unsigned or tampered artifact must not be treated as trusted distribution.
- The default bundle does not install `dsh-llm-grok`, and the plugin is experimental. A plugin runs inside the Host process and can access the permissions available to that process.
- Provider endpoints, upstream `dsh`, the npm registry, the Cargo registry, and the build machine remain external dependencies. The wrapper cannot prove their behavior.
- A missing generation or token-identity check can recreate a token after logout or delete a newer login. Treat a regression in these checks as a release blocker.

## Out of scope

This model does not cover a compromised macOS kernel, a compromised user account, provider-side retention or abuse, vulnerabilities in upstream Harness code, or a maintainer's signing account. Report wrapper vulnerabilities through [SECURITY.md](../SECURITY.md); report an upstream-only issue to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Safe operating rules

Run only trusted launch overrides. Keep the Host on loopback. Do not publish token files or unredacted logs. Use a signed and notarized artifact only after the checks in [`docs/releasing.md`](releasing.md) pass.
