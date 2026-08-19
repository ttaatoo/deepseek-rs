# Changelog

There is no tagged or formal release in this repository. The section below records the current unreleased tree. It is not a release promise.

## [Unreleased]

### Added

- A Tauri macOS window that starts `@deepseek-ai/dsh@0.1.0-rc.7` with the `web` profile and opens its loopback page.
- A generated app runtime with Node.js 22.19.0 and the production `dsh` npm tree.
- Host process supervision, loopback URL filtering, graceful group shutdown, and bounded restart handling.
- The optional `dsh-llm-grok` provider plugin for SuperGrok or X Premium+ accounts.
- Contributor, security, compatibility, architecture, threat-model, and release documentation.

### Notes

- `dsh-llm-grok` is experimental and is not part of the default app bundle.
- Local `dsh` and Grok token files remain the user's responsibility. See [the threat model](docs/threat-model.md).
- No signed, notarized, production-validated, SBOM-backed, or formally released artifact is recorded here.
