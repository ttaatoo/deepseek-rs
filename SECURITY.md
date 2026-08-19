# Security policy

This policy covers the `deepseek-rs` source tree and app artifacts built from it. The project is an unofficial wrapper. It has no published signed release or production security validation.

## Required private report route

GitHub private vulnerability reporting is a required repository setting for a public release. Maintainers must enable and test it before they publish a version tag. The intended form is [GitHub private vulnerability reporting](https://github.com/ttaatoo/deepseek-rs/security/advisories/new). This file does not claim that the form is enabled now.

If the form is not available, do not post sensitive details in an issue. Use the [maintainer profile](https://github.com/ttaatoo) to request a private channel. The project publishes no security email. A release is blocked until private reporting is enabled and verified.

Do not open a public issue for an unpatched vulnerability.

Do not include API keys, OAuth tokens, `~/.dsh` files, `~/.grok/auth.json`, `$DSH_HOME/grok-oauth.json`, or full session logs in a report. Replace secrets with placeholders.

## Include

Provide the affected commit or app build, macOS version and CPU architecture, reproduction steps, expected and actual results, and a redacted log. State whether the report affects the packaged app, `pnpm tauri dev`, the `dsh-llm-grok` plugin, or an upstream `dsh` package.

The maintainer will acknowledge a report when practical, confirm the affected component, and coordinate a fix or an upstream report. Do not assume a response time or a backport.

## User safety

The Host inherits the environment of the app process and reads the files used by `dsh`. Treat local token files as credentials. The Grok plugin stores its token at `$DSH_HOME/grok-oauth.json` with mode `0600`, and may reuse `~/.grok/auth.json`; these files remain readable by the local account and trusted processes. The app does not provide a keychain or remote secret vault.

The app accepts local launch overrides such as `DSH_BIN`, `DSH_REPO`, `DSH_PACKAGE`, and `DSH_NODE`. Use them only with trusted files. A malicious executable, checkout, plugin, or local process can run with the same user permissions as the app.

The Host is restricted to an HTTP loopback URL selected at runtime. Loopback is not an authentication boundary: another local process may connect to a loopback port. Do not expose the Host port or forward it to a network interface.
