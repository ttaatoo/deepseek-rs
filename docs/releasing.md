# Releasing

No successful release run or published artifact is recorded in this repository. The steps below are release gates. A local build is not a release.

## Release gates

Before a public tag, the maintainer must confirm all of these items:

- GitHub private vulnerability reporting is enabled and tested. Use the [private report form](https://github.com/ttaatoo/deepseek-rs/security/advisories/new). If it is not available, stop the release.
- The source tree is clean. Keep certificates, passwords, tokens, user plugins, `~/.dsh`, and generated local state out of the commit and artifact.
- The tag is an exact `vMAJOR.MINOR.PATCH` match for `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
- The build runs on an Apple Silicon `macos-14` runner and targets `aarch64-apple-darwin`.
- The published app artifact is one stapled `.app.zip`. Do not publish a DMG or an Intel artifact.
- Every Mach-O object inside the app is signed and verified. Sign nested objects before the outer app.
- The app contains the complete npm and Cargo notice records and a generated SBOM. The short list in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) is not enough.
- Apple signing and notarization secrets are present in the release environment.
- Notarization, stapling, signature checks, and Gatekeeper assessment pass.

The [release workflow](../.github/workflows/release.yml) encodes many of these gates. This repository has no successful-run evidence. The maintainer must check the private-reporting setting and confirm that the workflow still fails closed for every gate before publishing.

## Version and build

Use a clean macOS 14 or later environment. Confirm the fixed Harness pin and version values before the build:

```bash
pnpm install --frozen-lockfile
TAG="${GITHUB_REF_NAME:?set GITHUB_REF_NAME to the release tag}"
VERSION="${TAG#v}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
test "$(node -p "require('./package.json').version")" = "$VERSION"
test "$(node -p "require('./src-tauri/tauri.conf.json').version")" = "$VERSION"
test "$(awk -F'"' '/^[[:space:]]*version[[:space:]]*=/ { print $2; exit }' src-tauri/Cargo.toml)" = "$VERSION"
node -p "require('./package.json').dependencies['@deepseek-ai/dsh']" | grep -Fx '0.1.0-rc.7'
```

Run the checks before signing:

```sh
pnpm run check
pnpm run build
pnpm --dir plugins/dsh-llm-grok test
pnpm audit --prod
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo install cargo-audit --locked --version 0.21.2
(cd src-tauri && cargo audit)
git diff --check
```

Build the unsigned arm64 app. The `--bundles app` option is required. The release job must fail if a DMG appears:

```sh
TARGET_TRIPLE=aarch64-apple-darwin
pnpm exec tauri build --target "$TARGET_TRIPLE" --ci --bundles app --no-sign
APP_PATH="$(find "src-tauri/target/$TARGET_TRIPLE/release/bundle/macos" -maxdepth 1 -type d -name '*.app' -print -quit)"
test -n "$APP_PATH"
test -x "$APP_PATH/Contents/MacOS/deepseek-rs"
test -z "$(find "src-tauri/target/$TARGET_TRIPLE/release/bundle/macos" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
```

Run the packaged-app smoke check. Confirm that the app starts the `web` profile, reports a loopback URL, opens the WebView, and shuts down the Host when the window closes. A missing Host must show an error. It must not navigate to a non-loopback URL.

## Notices and SBOM

Generate the notice records before signing. Retain the repository license, the complete npm notice set, the complete Cargo notice set, and a generated SBOM in the app resources. Keep the SBOM as a release asset as well. The generated records must come from the locked `pnpm-lock.yaml` and `src-tauri/Cargo.lock` inputs. Fail closed when any record is missing or empty.

The bundle script writes an npm notice manifest under `Contents/Resources/dsh/licenses`. It does not make the hand-written [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) a complete inventory. Do not publish until the release job has generated and checked both npm and Cargo notices and `SBOM.cdx.json`.

Record the app version, source commit, dsh package version, Node.js version, target triple, checksum, notice files, SBOM path, signing identity, notarization result, and test commands. Do not call a local build a release until these records exist.

## Signing and notarization

The release environment must provide these secrets. Do not put their values in the repository:

- `APPLE_CERTIFICATE`: base64 Developer ID Application `.p12` data.
- `APPLE_CERTIFICATE_PASSWORD`.
- `APPLE_SIGNING_IDENTITY`.
- `APPLE_ID`.
- `APPLE_PASSWORD`: Apple app-specific password.
- `APPLE_TEAM_ID`.

Import the certificate into a temporary keychain. Sign every Mach-O file under `Contents` from the deepest path to the outer app. Use the Node entitlement from [`src-tauri/entitlements.plist`](../src-tauri/entitlements.plist) for the bundled Node binary when required by the build. The outer app is signed last.

Verify each nested object and then the app. A single `--deep` check is not a substitute for the per-file check:

```sh
while IFS= read -r -d '' path; do
  if file -b "$path" | grep -q 'Mach-O'; then
    codesign --verify --strict --verbose=2 "$path"
    codesign -dvv "$path" 2>&1 | grep -F "Authority=$APPLE_SIGNING_IDENTITY"
    codesign -dvv "$path" 2>&1 | grep -F "TeamIdentifier=$APPLE_TEAM_ID"
  fi
done < <(find "$APP_PATH/Contents" -type f -print0)
codesign --verify --strict --verbose=2 "$APP_PATH"
```

Create a temporary zip for notarization. Staple the ticket to the app. Recreate the final app zip after stapling:

```sh
NOTARIZATION_ZIP="$RUNNER_TEMP/app-notarization.zip"
RELEASE_ZIP="$RUNNER_TEMP/DeepSeek-RS-${VERSION}-aarch64-apple-darwin-ARM64.app.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$NOTARIZATION_ZIP"
xcrun notarytool submit "$NOTARIZATION_ZIP" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
codesign --verify --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$RELEASE_ZIP"
shasum -a 256 "$RELEASE_ZIP"
```

`spctl` is the Gatekeeper check. Do not publish when it, notarization, stapling, or any signature check fails. The repository currently contains no completed signing or notarization evidence.

## Upstream updates

Treat a `dsh` update as a compatibility change. Review the upstream release notes and security notices. Update `package.json` and `pnpm-lock.yaml`, rebuild the generated runtime, run the web-profile smoke check, test plugin installation and login when relevant, and update [compatibility](compatibility.md) and [`CHANGELOG.md`](../CHANGELOG.md). Keep the current `0.1.0-rc.7` pin until that review is complete.

To update Node.js, set `BUNDLE_NODE_VERSION` for the build. Confirm the official `SHASUMS256.txt` entry for the downloaded archive. Record the new runtime version and its notices. Do not change the default as a side effect of another dependency update.

## Rollback

1. Stop publishing the affected artifact. Keep its source commit and checksums for investigation.
2. Select the last known-good source commit and release record, if one exists. Use a reviewed `git revert` for a bad dependency change. Do not rewrite shared history.
3. Reinstall with `pnpm install --frozen-lockfile`. Rebuild the pinned runtime and arm64 app.
4. Rerun all checks, notice and SBOM generation, nested signing, notarization, stapling, Gatekeeper assessment, and app-zip checksum steps.
5. Replace the affected download only after the replacement passes every gate. Record the rollback in the release notes.

If the failure is only in the optional Grok plugin, remove it from the `web` profile with `pnpm exec dsh plugin --profile web remove dsh-llm-grok`, restart the Host, and report the plugin version. Do not remove or publish user token files while diagnosing the issue.
