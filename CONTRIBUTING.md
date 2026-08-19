# Contributing

Thank you for contributing to this unofficial macOS wrapper for DeepSeek Harness.

## Scope

The app starts the published `@deepseek-ai/dsh@0.1.0-rc.7` package with the `web` profile. It opens the Host page on loopback. It does not reimplement the agent. Read [the architecture](docs/architecture.md), [the threat model](docs/threat-model.md), and [the compatibility matrix](docs/compatibility.md) before changing startup, packaging, or provider code.

This repository has no tagged release. Do not describe a local build as a signed, notarized, production-validated, or formally released product.

## Local setup

Builds require macOS 14 or later, Rust 1.88 or later, Node.js `^22.19.0 || >=24`, and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

The development app uses the local npm install. The packaged app uses the generated runtime under `Contents/Resources/dsh`.

## Checks

Run the checks that match the files you change. Run the Rust checks on macOS.

```sh
pnpm run check
pnpm run build
pnpm --dir plugins/dsh-llm-grok test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
git diff --check
```

For a packaging change, also run:

```sh
pnpm tauri build --bundles app
```

This command downloads the pinned Node.js runtime and the production `dsh` tree when the generated bundle is stale. Do not commit `vendor/runtime` or `vendor/cache`.

## Change rules

- Keep the Host command on the `web` profile and on loopback. Explain any change to this rule in the pull request.
- Keep `@deepseek-ai/dsh` at `0.1.0-rc.7` unless the change is an intentional upstream update. Update `package.json`, `pnpm-lock.yaml`, [compatibility](docs/compatibility.md), [releasing](docs/releasing.md), and [the changelog](CHANGELOG.md) together.
- Treat `plugins/dsh-llm-grok` as experimental. Test it against the current Host and state the required account and network access.
- Do not add API keys, OAuth tokens, local configuration, generated bundles, or personal data to Git.
- Keep documentation links and command examples valid. Do not add a fallback that hides a failed Host start.

## Pull requests

Use the [pull request template](.github/pull_request_template.md). Include the files changed, the commands run, and any macOS or network limitation. Redact tokens and session data from logs. A maintainer may ask for a small reproduction before review.

Report security issues through [the security process](SECURITY.md), not a public issue.
