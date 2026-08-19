# Third-party notices

This file names only the direct components that the app build places in or links into the app. It is not a complete dependency or license inventory. The repository has no published release artifact, complete notice archive, or SBOM. This hand-written file must not be published as the complete notice inventory.

Before publishing an artifact, a release job must enumerate the resolved npm and Cargo dependencies, collect their license and notice files, and place the result next to the app. Do not use this short list as a substitute for that generated inventory.

## Direct app components

| Component | Version or source | Role | License source and artifact requirement |
| --- | --- | --- | --- |
| Node.js | 22.19.0; downloaded by [`scripts/prepare-bundle.mjs`](scripts/prepare-bundle.mjs) | Runs the packaged `dsh` CLI | For the arm64 target, the extracted build input is `vendor/cache/node-v22.19.0-aarch64-apple-darwin-darwin-arm64/LICENSE`; the script copies it to `vendor/runtime/licenses/node/LICENSE`. See the [Node.js 22.19.0 license](https://github.com/nodejs/node/blob/v22.19.0/LICENSE). |
| `@deepseek-ai/dsh` | 0.1.0-rc.7; pinned in [`package.json`](package.json) | Provides the `dsh --profile web` Host | The generated production tree contains `vendor/runtime/node_modules/@deepseek-ai/dsh/LICENSE` after `prepare-bundle`. See the [published package metadata](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.0-rc.7). The release job must retain this file in the app's notice bundle. |
| Tauri | 2.x; resolved in [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock) | Native macOS shell and WebView host | The resolved crate metadata and license files are the source of record. See [Tauri on crates.io](https://crates.io/crates/tauri/2.11.5). The current build does not create a complete notice directory; the release job must collect the Tauri license and notices. |
| `url` | 2.5.8; locked in [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock) | Parses and validates the loopback Host URL | Cargo metadata declares `MIT OR Apache-2.0`. See the Rust URL [MIT](https://github.com/servo/rust-url/blob/v2.5.8/LICENSE-MIT) and [Apache-2.0](https://github.com/servo/rust-url/blob/v2.5.8/LICENSE-APACHE) license files. The release job must retain both license options and all required notices. |
| `libc` | 0.2.189; locked in [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock) | Sends signals to the Host process group on Unix | Cargo metadata declares `MIT OR Apache-2.0`. See the libc [MIT](https://github.com/rust-lang/libc/blob/0.2.189/LICENSE-MIT) and [Apache-2.0](https://github.com/rust-lang/libc/blob/0.2.189/LICENSE-APACHE) license files. The release job must retain both license options and all required notices. |
| `@tauri-apps/api` | 2.x; pinned by [`package.json`](package.json) and [`pnpm-lock.yaml`](pnpm-lock.yaml) | Frontend event bridge used by [`src/main.ts`](src/main.ts) | The installed package license is the source of record. See [the published package metadata](https://www.npmjs.com/package/@tauri-apps/api/v/2.11.1). The release job must copy it with the other direct runtime notices. |

The generated runtime also contains `vendor/runtime/licenses/THIRD_PARTY_NOTICES.txt`, which covers npm package metadata and retained package license files. It does not cover all native Cargo components or provide an SBOM. A release job must generate the complete Cargo and npm notice inventory and an SBOM before publication, then fail closed when either record is missing. The optional [`dsh-llm-grok` plugin](plugins/dsh-llm-grok/README.md) is packed and installed by the user. It is not copied into the default app runtime. Its package license and dependency notices must travel with its plugin tarball.

`tauri-build` is a build-time dependency and is not a direct app component. The complete release inventory must still inspect it and every resolved transitive dependency from `pnpm-lock.yaml` and `src-tauri/Cargo.lock`.

The repository's own MIT license is [`LICENSE`](LICENSE). A future release artifact must include it as well.
