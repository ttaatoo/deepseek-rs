# Support

This project is an unofficial macOS wrapper around the published DeepSeek Harness CLI. It has no service-level agreement and no formal release support window.

## Before asking

Check [the README](README.md), [the compatibility matrix](docs/compatibility.md), and [the architecture](docs/architecture.md). Confirm that you use macOS 14 or later and the pinned `@deepseek-ai/dsh@0.1.0-rc.7` package. For Grok, read the [plugin guide](plugins/dsh-llm-grok/README.md) and confirm that the required account and network endpoints are reachable.

Do not expose a Host port to the network. Do not attach token files or unredacted logs.

## Ask a question

Use a GitHub issue with a short question, your macOS version and CPU architecture, the app or development mode, and the exact command or screen that failed. Remove API keys, OAuth tokens, local paths that contain private data, and session content. Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) when the request changes product behavior.

## Report a bug

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include a minimal reproduction and the command output after redaction. The template separates wrapper failures from failures in the upstream `dsh` package.

## Upstream and security

Report a problem in the published `dsh` CLI or its web profile to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) when the wrapper only forwards the failure. Report vulnerabilities privately through [SECURITY.md](SECURITY.md). Do not use a public issue for credentials or an unpatched vulnerability.

The current repository does not provide a signed or notarized release, production validation, or an SBOM. Maintainers must confirm those items before treating a future artifact as a release.
