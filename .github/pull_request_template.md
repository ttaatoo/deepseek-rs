## Summary

<!-- State the user-visible result and the files in scope. -->

## Related issue

<!-- Link an issue, or write "None". Do not paste private security details. -->

## Checks run

- [ ] `pnpm run build`
- [ ] `pnpm run check`
- [ ] `pnpm --dir plugins/dsh-llm-grok test` (when the plugin is affected)
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` (when Rust is affected)
- [ ] `cargo test --locked --manifest-path src-tauri/Cargo.toml` (when Rust is affected)
- [ ] `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` (when Rust is affected)
- [ ] `git diff --check`
- [ ] Packaged-app smoke test on macOS (when packaging or startup is affected)

## Documentation and compatibility

- [ ] Updated the relevant README or document.
- [ ] Updated [compatibility](../docs/compatibility.md) for runtime or upstream changes.
- [ ] Updated [CHANGELOG.md](../CHANGELOG.md) for user-visible changes.
- [ ] No release, signing, notarization, SBOM, or production claim is made without evidence.

## Security and data

- [ ] No API keys, OAuth tokens, local config, session data, or generated runtime files are included.
- [ ] Loopback and `--profile web` behavior remains explicit, or the security impact is documented.
- [ ] Security reports use [SECURITY.md](../SECURITY.md), not a public issue.

## Reviewer notes

<!-- Add limitations, manual steps, or follow-up maintainer decisions. -->
