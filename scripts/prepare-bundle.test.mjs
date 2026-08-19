import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appProcessPattern,
  createStamp,
  nodeArchiveName,
  parseArchiveTopLevelDirectory,
  pinnedNodeArchiveSha256,
  resolveTarget,
  serializeStamp,
  stampsMatch,
  validateDshVersion,
  validateNodeVersion,
} from "./prepare-bundle-lib.mjs";
import {
  assertExecutableRegularFile,
  collectDependencyLicenseEntries,
  downloadArchive,
  runtimeFileDigests,
  thirdPartyNotices,
} from "./prepare-bundle.mjs";

test("resolveTarget uses the Tauri target triple, not the host architecture", () => {
  assert.deepEqual(
    resolveTarget(
      { TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" },
      { platform: "linux", arch: "x64" },
    ),
    {
      triple: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      nodeDistArch: "darwin-arm64",
    },
  );
});

test("resolveTarget rejects an unknown or non-macOS target with guidance", () => {
  assert.throws(
    () =>
      resolveTarget({ TAURI_ENV_TARGET_TRIPLE: "riscv64-unknown-linux-gnu" }, {
        platform: "darwin",
        arch: "arm64",
      }),
    /unsupported target triple.*riscv64-unknown-linux-gnu.*aarch64-apple-darwin.*x86_64-apple-darwin/i,
  );
});

test("the stamp records all reproducibility inputs", () => {
  const stamp = createStamp({
    dshVersion: "0.1.0-rc.7",
    packageJson: {
      name: "deepseek-rs",
      packageManager: "pnpm@10.33.0",
      dependencies: { "@deepseek-ai/dsh": "0.1.0-rc.7" },
      pnpm: { onlyBuiltDependencies: ["koffi"] },
    },
    packageJsonSha256: "package-sha",
    pnpmLockSha256: "lock-sha",
    scriptSha256: "script-sha",
    nodeVersion: "22.19.0",
    target: {
      triple: "x86_64-apple-darwin",
      platform: "darwin",
      arch: "x64",
      nodeDistArch: "darwin-x64",
    },
    nodeArchiveName: "node-v22.19.0-darwin-x64.tar.gz",
    nodeArchiveSha256: "node-sha",
    runtimeFiles: {
      "bin/node": { type: "file", mode: 0o755, sha256: "runtime-sha" },
    },
  });

  const parsed = JSON.parse(serializeStamp(stamp));
  assert.equal(parsed.dshVersion, "0.1.0-rc.7");
  assert.equal(parsed.package.packageManager, "pnpm@10.33.0");
  assert.equal(parsed.pnpmLockSha256, "lock-sha");
  assert.deepEqual(parsed.lockfile, {
    path: "pnpm-lock.yaml",
    sha256: "lock-sha",
  });
  assert.deepEqual(parsed.script, {
    path: "scripts/prepare-bundle.mjs",
    version: "2",
    sha256: "script-sha",
  });
  assert.deepEqual(parsed.node, {
    version: "22.19.0",
    targetTriple: "x86_64-apple-darwin",
    arch: "x64",
    nodeDistArch: "darwin-x64",
    archiveName: "node-v22.19.0-darwin-x64.tar.gz",
    archiveSha256: "node-sha",
  });
  assert.deepEqual(parsed.runtime.files, {
    "bin/node": { type: "file", mode: 0o755, sha256: "runtime-sha" },
  });
});

test("stamp comparison includes input changes and runtime file digests", () => {
  const base = {
    dshVersion: "0.1.0-rc.7",
    packageJson: { dependencies: { "@deepseek-ai/dsh": "0.1.0-rc.7" } },
    packageJsonSha256: "package-sha",
    pnpmLockSha256: "lock-sha",
    scriptSha256: "script-sha",
    nodeVersion: "22.19.0",
    target: {
      triple: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      nodeDistArch: "darwin-arm64",
    },
    nodeArchiveName: "node-v22.19.0-darwin-arm64.tar.gz",
    nodeArchiveSha256: "node-sha",
    runtimeFiles: { "bin/node": "runtime-sha" },
  };
  const first = createStamp(base);
  assert.equal(stampsMatch(first, createStamp(base)), true);
  assert.equal(
    stampsMatch(first, createStamp({ ...base, pnpmLockSha256: "changed" })),
    false,
  );
  assert.equal(
    stampsMatch(first, createStamp({ ...base, runtimeFiles: { "bin/node": "changed" } })),
    false,
  );
});

test("CLI smoke validation checks the embedded dsh version", () => {
  assert.equal(validateDshVersion("0.1.0-rc.7\n", "0.1.0-rc.7"), "0.1.0-rc.7");
  assert.throws(
    () => validateDshVersion("0.1.0-rc.6\n", "0.1.0-rc.7"),
    /embedded dsh reports.*0\.1\.0-rc\.6.*want.*0\.1\.0-rc\.7/,
  );
});

test("stamp invalidates when an extracted helper script changes", () => {
  const base = {
    dshVersion: "0.1.0-rc.7",
    packageJson: {},
    packageJsonSha256: "package-sha",
    pnpmLockSha256: "lock-sha",
    scriptSha256: "script-sha",
    scriptFiles: {
      "scripts/prepare-bundle.mjs": "script-sha",
      "scripts/prepare-bundle-lib.mjs": "helper-sha",
    },
    nodeVersion: "22.19.0",
    target: {
      triple: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      nodeDistArch: "darwin-arm64",
    },
    nodeArchiveName: "node-v22.19.0-darwin-arm64.tar.gz",
    nodeArchiveSha256: "node-sha",
    runtimeFiles: { "bin/node": "runtime-sha" },
  };
  assert.equal(stampsMatch(createStamp(base), createStamp(base)), true);
  assert.equal(
    stampsMatch(
      createStamp(base),
      createStamp({
        ...base,
        scriptFiles: {
          ...base.scriptFiles,
          "scripts/prepare-bundle-lib.mjs": "changed-helper-sha",
        },
      }),
    ),
    false,
  );
});

test("BUNDLE_NODE_VERSION must be strict semver", () => {
  assert.equal(validateNodeVersion("22.19.0"), "22.19.0");
  assert.equal(
    validateNodeVersion("22.19.0-rc.1+build.7"),
    "22.19.0-rc.1+build.7",
  );
  for (const value of [
    "22.19",
    "v22.19.0",
    "22.019.0",
    "22.19.0-01",
    "22.19.0foo",
    "",
  ]) {
    assert.throws(
      () => validateNodeVersion(value),
      /strict semver|BUNDLE_NODE_VERSION/,
    );
  }
});

test("Node archive cache names include target triple and architecture", () => {
  const target = resolveTarget({
    TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin",
  });
  assert.equal(
    nodeArchiveName("22.19.0", target),
    "node-v22.19.0-aarch64-apple-darwin-darwin-arm64.tar.gz",
  );
  assert.equal(
    pinnedNodeArchiveSha256("22.19.0", target),
    "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d",
  );
  assert.equal(
    pinnedNodeArchiveSha256(
      "22.19.0",
      resolveTarget({ TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" }),
    ),
    "3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c",
  );
});

test("Node archives resolve their architecture-specific top-level directory", () => {
  assert.equal(
    parseArchiveTopLevelDirectory([
      "node-v22.19.0-darwin-arm64/",
      "node-v22.19.0-darwin-arm64/bin/",
      "node-v22.19.0-darwin-arm64/bin/node",
    ]),
    "node-v22.19.0-darwin-arm64",
  );
  assert.equal(
    parseArchiveTopLevelDirectory(
      "node-v22.19.0-darwin-x64/\nnode-v22.19.0-darwin-x64/bin/node\n",
    ),
    "node-v22.19.0-darwin-x64",
  );
  assert.throws(
    () =>
      parseArchiveTopLevelDirectory([
        "node-v22.19.0-darwin-arm64/bin/node",
        "unexpected-root/LICENSE",
      ]),
    /single top-level directory/i,
  );
});

test("downloadArchive verifies before atomic rename and removes partial files", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepare-bundle-download-"));
  const destination = join(root, "node.tar.gz");
  const payload = "verified payload";
  const expected = createHash("sha256").update(payload).digest("hex");

  await downloadArchive(
    "https://example.test/node.tar.gz",
    destination,
    expected,
    async () => new Response(payload),
  );
  assert.equal(await readFile(destination, "utf8"), payload);
  const badDestination = join(root, "bad.tar.gz");
  await assert.rejects(
    downloadArchive(
      "https://example.test/bad.tar.gz",
      badDestination,
      expected,
      async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(new Error("stream failed"));
          },
        });
        return { ok: true, body };
      },
    ),
    /stream failed/,
  );
  assert.equal(
    await readFile(`${badDestination}.part`, "utf8").catch(() => undefined),
    undefined,
  );

  const mismatchDestination = join(root, "mismatch.tar.gz");
  await assert.rejects(
    downloadArchive(
      "https://example.test/mismatch.tar.gz",
      mismatchDestination,
      "not-the-payload-digest",
      async () => new Response(payload),
    ),
    /checksum mismatch/,
  );
  assert.equal(
    await readFile(mismatchDestination, "utf8").catch(() => undefined),
    undefined,
  );
  assert.equal(
    await readFile(`${mismatchDestination}.part`, "utf8").catch(() => undefined),
    undefined,
  );
});

test("runtime manifest records file type, mode, and detects chmod changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepare-bundle-runtime-"));
  await mkdir(join(root, "bin"));
  const nodePath = join(root, "bin/node");
  await writeFile(nodePath, "node");
  await chmod(nodePath, 0o755);
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules/.bundle-stamp"), "package stamp");
  const executable = runtimeFileDigests(root);
  assert.deepEqual(executable["bin/node"], {
    type: "file",
    mode: 0o755,
    sha256: createHash("sha256").update("node").digest("hex"),
  });
  assert.deepEqual(executable["node_modules/.bundle-stamp"], {
    type: "file",
    mode: 0o644,
    sha256: createHash("sha256").update("package stamp").digest("hex"),
  });
  await chmod(nodePath, 0o644);
  const nonExecutable = runtimeFileDigests(root);
  assert.notDeepEqual(nonExecutable["bin/node"], executable["bin/node"]);
  assert.equal(nonExecutable["bin/node"].mode, 0o644);
});

test("runtime smoke requires bin/node to be a regular executable file", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepare-bundle-smoke-"));
  const nodePath = join(root, "node");
  await writeFile(nodePath, "node");
  assert.throws(
    () => assertExecutableRegularFile(nodePath),
    /requires an executable file/,
  );
  await chmod(nodePath, 0o755);
  assert.doesNotThrow(() => assertExecutableRegularFile(nodePath));

  const directoryPath = join(root, "node-directory");
  await mkdir(directoryPath);
  assert.throws(
    () => assertExecutableRegularFile(directoryPath),
    /requires a regular file/,
  );
});

test("app matching uses escaped bundle path and executable, not the old app name", () => {
  const pattern = appProcessPattern({
    bundleName: "DeepSeek RS.app",
    executable: "deepseek-rs",
  });
  const matcher = new RegExp(pattern);
  assert.match(
    "/Applications/DeepSeek RS.app/Contents/MacOS/deepseek-rs",
    matcher,
  );
  assert.doesNotMatch(
    "/Applications/DeepSeek Harness.app/Contents/MacOS/deepseek-rs",
    matcher,
  );
  assert.doesNotMatch(
    "/Applications/DeepSeek RS.app/Contents/MacOS/deepseek-rs-evil",
    matcher,
  );
});

test("license scan reports malformed or missing package license data", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepare-bundle-license-"));
  const nodeModules = join(root, "node_modules");
  const packageDir = join(nodeModules, "example");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "example", version: "1.0.0" }),
  );
  assert.throws(
    () => collectDependencyLicenseEntries(nodeModules, root),
    /missing license metadata.*example/i,
  );

  const malformedRoot = await mkdtemp(join(tmpdir(), "prepare-bundle-malformed-"));
  const malformedModules = join(malformedRoot, "node_modules");
  const malformedDir = join(malformedModules, "malformed");
  await mkdir(malformedDir, { recursive: true });
  await writeFile(join(malformedDir, "package.json"), "{not-json");
  assert.throws(
    () => collectDependencyLicenseEntries(malformedModules, malformedRoot),
    /invalid dependency package JSON.*malformed/i,
  );

  const emptyRoot = await mkdtemp(join(tmpdir(), "prepare-bundle-empty-license-"));
  const emptyModules = join(emptyRoot, "node_modules");
  const emptyLicenseDir = join(emptyModules, "empty-license");
  await mkdir(emptyLicenseDir, { recursive: true });
  await writeFile(
    join(emptyLicenseDir, "package.json"),
    JSON.stringify({ name: "empty-license", version: "1.0.0", license: [] }),
  );
  assert.throws(
    () => collectDependencyLicenseEntries(emptyModules, emptyRoot),
    /missing license metadata.*empty-license/i,
  );
});

test("third-party notices identify root, Node, npm, and uncovered license scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepare-bundle-notices-"));
  const nodeModules = join(root, "node_modules");
  const dshDir = join(nodeModules, "@deepseek-ai/dsh");
  const metadataOnlyDir = join(nodeModules, "metadata-only");
  await mkdir(dshDir, { recursive: true });
  await mkdir(metadataOnlyDir, { recursive: true });
  await writeFile(
    join(dshDir, "package.json"),
    JSON.stringify({
      name: "@deepseek-ai/dsh",
      version: "0.1.0-rc.7",
      license: "MIT",
    }),
  );
  await writeFile(join(dshDir, "LICENSE"), "MIT");
  await writeFile(
    join(metadataOnlyDir, "package.json"),
    JSON.stringify({
      name: "metadata-only",
      version: "1.0.0",
      license: "ISC",
      repository: "https://example.test/metadata-only",
    }),
  );

  const entries = collectDependencyLicenseEntries(nodeModules, root);
  const notices = thirdPartyNotices("22.19.0", entries);
  assert.match(notices, /licenses\/root\/LICENSE/);
  assert.match(notices, /licenses\/node\/LICENSE/);
  assert.match(notices, /@deepseek-ai\/dsh@0\.1\.0-rc\.7/);
  assert.match(notices, /metadata-only@1\.0\.0/);
  assert.match(notices, /license source: https:\/\/example\.test\/metadata-only/);
  assert.doesNotMatch(notices, /files: none/);
  assert.match(notices, /Cargo dependencies are not covered/);
  assert.match(notices, /not an SBOM/);
});

test("license notices reject unknown SPDX and packages without a license source", async () => {
  const unknownRoot = await mkdtemp(join(tmpdir(), "prepare-bundle-unknown-license-"));
  const unknownModules = join(unknownRoot, "node_modules");
  const unknownDir = join(unknownModules, "unknown-license");
  await mkdir(unknownDir, { recursive: true });
  await writeFile(
    join(unknownDir, "package.json"),
    JSON.stringify({
      name: "unknown-license",
      version: "1.0.0",
      license: "Not-A-Real-SPDX-License",
      repository: "https://example.test/unknown-license",
    }),
  );
  await writeFile(join(unknownDir, "LICENSE"), "unknown");
  assert.throws(
    () => collectDependencyLicenseEntries(unknownModules, unknownRoot),
    /unknown SPDX license.*Not-A-Real-SPDX-License/i,
  );

  const missingRoot = await mkdtemp(join(tmpdir(), "prepare-bundle-missing-license-source-"));
  const missingModules = join(missingRoot, "node_modules");
  const missingDir = join(missingModules, "missing-source");
  await mkdir(missingDir, { recursive: true });
  await writeFile(
    join(missingDir, "package.json"),
    JSON.stringify({
      name: "missing-source",
      version: "1.0.0",
      license: "MIT",
      repository: "https://",
    }),
  );
  assert.throws(
    () => collectDependencyLicenseEntries(missingModules, missingRoot),
    /no license text or source.*missing-source/i,
  );

  const emptyTextRoot = await mkdtemp(join(tmpdir(), "prepare-bundle-empty-license-text-"));
  const emptyTextModules = join(emptyTextRoot, "node_modules");
  const emptyTextDir = join(emptyTextModules, "empty-license-text");
  await mkdir(emptyTextDir, { recursive: true });
  await writeFile(
    join(emptyTextDir, "package.json"),
    JSON.stringify({ name: "empty-license-text", version: "1.0.0", license: "MIT" }),
  );
  await writeFile(join(emptyTextDir, "LICENSE"), "\n");
  assert.throws(
    () => collectDependencyLicenseEntries(emptyTextModules, emptyTextRoot),
    /no license text or source.*empty-license-text/i,
  );
});

test("scoped packages may explicitly share a scope LICENSE", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepare-bundle-shared-license-"));
  const nodeModules = join(root, "node_modules");
  const scopeDir = join(nodeModules, "@shared");
  const packageDir = join(scopeDir, "package");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(scopeDir, "LICENSE"), "shared license text");
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@shared/package", version: "1.2.3", license: "MIT" }),
  );

  const entries = collectDependencyLicenseEntries(nodeModules, root);
  assert.deepEqual(entries[0].licenseSource, {
    kind: "shared-scope-license",
    paths: ["node_modules/@shared/LICENSE"],
  });
  const notices = thirdPartyNotices("22.19.0", entries);
  assert.match(notices, /shared from scope LICENSE/);
  assert.match(notices, /@shared\/package@1\.2\.3/);
});
