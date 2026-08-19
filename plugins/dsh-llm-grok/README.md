# dsh-llm-grok — Experimental unofficial plugin

An experimental, unofficial plugin for the published `@deepseek-ai/dsh` web profile. Sign in with a SuperGrok or X Premium+ account and run Grok models. No xAI Console API key is required.

This plugin is maintained independently. It is not affiliated with, endorsed by, or distributed by DeepSeek, deepseek-ai, xAI, or the upstream DeepSeek Harness project.

This plugin owns the `grok` provider route. It does not replace the built-in `xai` API-key card.

## Compatibility and status

The tested host is **exactly** `@deepseek-ai/dsh@0.1.0-rc.7` with `@deepseek-ai/cordis@4.0.1`. The package declares these exact, optional host peers: dsh-llm, dsh-settings, and dsh-timeout `0.1.0-rc.7`; schemastery `3.18.1`; and React `18.3.1`. Optional means that the dsh host injects them and npm does not install a duplicate. It is not a wildcard: any missing or different peer is outside the tested contract. The plugin itself provides no compatibility guarantee; maintainers must test and update the exact pins before adopting another host version.

The upstream dsh web profile is a **Developer Preview**. Its plugin loader, patch schema, UI modules, and provider APIs can change without notice. Treat this plugin as experimental and expect to retest after every host upgrade.

## Install

From a `deepseek-rs` checkout:

```sh
cd ~/Github/deepseek-rs
pnpm --dir plugins/dsh-llm-grok pack --pack-destination "$HOME/.dsh/profiles/web"
pnpm exec dsh plugin --profile web add "$HOME/.dsh/profiles/web/dsh-llm-grok-0.1.0.tgz"
pnpm exec dsh --version  # must print 0.1.0-rc.7
```

From another machine that already has `dsh`:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-llm-grok-0.1.0.tgz
```

Do not install with `link:`. Node resolves ESM imports from the real file path. A symlink into this repo does not see `@deepseek-ai/schemastery` (and the other peers) from the packaged `.app`. A packed tarball copies the plugin under the profile, and Node then finds the host packages at `~/.dsh/profiles/node_modules`.

Restart `dsh web` or the **DeepSeek RS — Unofficial DSH wrapper** app after install. Client modules load at process start. The served `src/client.js` is a classic-script factory: it must call `window.__ModuleLoader__.load({ id: 'dsh-llm-grok', factory })`. An ESM `import`/`export` file loads but never registers.

If you reinstall the same `0.1.0` tarball, pnpm may keep the old files. Remove first, then add:

```sh
pnpm exec dsh plugin --profile web remove dsh-llm-grok
pnpm exec dsh plugin --profile web add "$HOME/.dsh/profiles/web/dsh-llm-grok-0.1.0.tgz"
```

## Use

1. Open **Settings → Grok**.
2. Click **使用 Grok 账号登录**. The system browser opens `auth.x.ai`.
3. Confirm the device code.
4. Start a **new** session and pick `Grok 4.6` or `Grok 4.5`.

The Host process must reach `https://auth.x.ai` and `https://cli-chat-proxy.grok.com`. If a browser works but login fails, set `HTTPS_PROXY` in the environment that launches `dsh`.

If the upstream Grok CLI is already signed in, this plugin reuses `~/.grok/auth.json` and does not delete it on sign-out. Tokens owned by this plugin live at `$DSH_HOME/grok-oauth.json` (mode `0600`).

## Upgrade and rollback

Upgrade only after the wrapper has adopted and tested a new exact dsh pin. Re-pack the plugin, update its exact dsh/Cordis peer pins when needed, remove the old profile copy, and add the new tarball. Keep the previous tarball and the previous `.app`.

To roll back, remove `dsh-llm-grok`, add the archived tarball, and restart dsh or the wrapper app. If the host itself was upgraded, restore the previous exact dsh package and lockfile before starting the app.

The release workflow targets macOS arm64 only; no signed wrapper artifact is claimed yet. A local `pnpm tauri build --bundles app` is unsigned unless signing credentials are configured, so it is for development and testing. After the maintainer configures Apple signing and notarization credentials, the workflow is intended to sign, notarize, staple, and publish `DeepSeek-RS-<version>-aarch64-apple-darwin-ARM64.app.zip`. The plugin tarball is separate from the app and carries its own license and notices.

## Uninstall

```sh
pnpm exec dsh plugin --profile web remove dsh-llm-grok
```

Restart after uninstall.

## Tests

```sh
pnpm --dir plugins/dsh-llm-grok run quality
```

## License

MIT; see the package-local [`LICENSE`](LICENSE). The tarball also contains [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), which records the exact host peer versions and their license metadata. The plugin is not bundled into the default app runtime.
