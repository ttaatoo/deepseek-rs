# Compatibility

This matrix describes the current source tree. It is not a promise that an unsigned local build works on every machine.

| Area | Supported or tested target | Notes |
| --- | --- | --- |
| Operating system | macOS 14 or later | Tauri sets `minimumSystemVersion` to `14.0`. The Rust crate fails to compile on non-macOS targets. |
| CPU | Development bundle inputs: Apple Silicon (`darwin-arm64`) and Intel (`darwin-x64`) | [`scripts/prepare-bundle.mjs`](../scripts/prepare-bundle.mjs) selects one of these official Node archives. A public release is arm64-only: `aarch64-apple-darwin` on an Apple Silicon `macos-14` runner. No Intel artifact is published. |
| Build Node.js | `^22.19.0 || >=24` | The package manifest declares this range. The packaged app uses Node.js 22.19.0 from the bundle, not the system Node.js. |
| Build tools | pnpm 10.33.0 and Rust 1.88 or later | The package manager field pins pnpm. The crate manifest declares Rust 1.88. |
| Harness package | `@deepseek-ai/dsh@0.1.0-rc.7` | The current package and lockfile pin this version. The app starts its `web` profile only. |
| Host URL | `http://127.0.0.1:<port>` or `http://localhost:<port>` | The native Host asks `dsh` to bind `127.0.0.1` and port `0`, then accepts only a loopback readiness line. |
| Grok provider | Experimental optional `dsh-llm-grok` plugin | The plugin uses a SuperGrok or X Premium+ login flow and the `auth.x.ai` and `cli-chat-proxy.grok.com` endpoints. It is not in the default app bundle. |
| Development overrides | `DSH_BIN`, `DSH_REPO`, `DSH_PACKAGE`, and `DSH_NODE` | These are trusted local controls. They do not define a supported published-app configuration. |
| Published artifact policy | Apple Silicon `.app.zip` only | A future release must use the exact version tag, nested Mach-O signing, notarization, stapling, and Gatekeeper checks in [releasing](releasing.md). This repository has no completed release evidence. |

## Not supported or not established

- Windows and Linux are not supported by this crate.
- macOS versions before 14 are not supported by the app bundle configuration.
- An Intel public artifact is not supported or established. The release target is `aarch64-apple-darwin` only.
- A newer `dsh` version is not supported until the package, lockfile, web profile, plugin path, and release checks are reviewed together.
- The repository has no formal release, signed artifact, notarization record, SBOM, or production validation record.

## Compatibility updates

When upstream `dsh` changes, update the pinned dependency and lockfile in one change. Run the web-profile smoke check, Rust and TypeScript checks, the Grok plugin tests when relevant, and a fresh bundle build. Update this matrix, [CHANGELOG.md](../CHANGELOG.md), and [the release procedure](releasing.md) before publishing any artifact.
