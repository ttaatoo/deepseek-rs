#!/usr/bin/env node
/**
 * Build the Host tree that Tauri copies into Contents/Resources/dsh.
 *
 * Layout:
 *   vendor/runtime/bin/node
 *   vendor/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
 *
 * Native addons are installed with the bundled Node so ABI matches.
 * Symlinks are flattened (rsync -L) so the .app does not point at the pnpm store.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, join, relative, sep } from "node:path";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  appProcessPattern,
  createStamp,
  nodeArchiveName,
  officialNodeArchiveName,
  parseArchiveTopLevelDirectory,
  parseSpdxLicenseExpression,
  pinnedNodeArchiveSha256,
  resolveTarget,
  serializeStamp,
  stampsMatch,
  validateDshVersion,
  validateNodeVersion,
  SCRIPT_VERSION,
} from "./prepare-bundle-lib.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const NODE_VERSION = validateNodeVersion(
  process.env.BUNDLE_NODE_VERSION ?? "22.19.0",
);
const CACHE = join(ROOT, "vendor/cache");
const RUNTIME = join(ROOT, "vendor/runtime");
const STAGE = join(ROOT, "vendor/runtime.stage");

const force = process.argv.includes("--force");

function bundleInputs() {
  const packageJsonPath = join(ROOT, "package.json");
  const packageJsonText = readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonText);
  const version = packageJson.dependencies?.["@deepseek-ai/dsh"];
  if (!version) {
    throw new Error("package.json is missing dependencies['@deepseek-ai/dsh']");
  }
  return {
    dshVersion: version,
    packageJson,
    packageJsonSha256: sha256Text(packageJsonText),
    pnpmLockSha256: sha256File(join(ROOT, "pnpm-lock.yaml")),
    scriptSha256: sha256File(SCRIPT_PATH),
    scriptFiles: {
      "scripts/prepare-bundle.mjs": sha256File(SCRIPT_PATH),
      "scripts/prepare-bundle-lib.mjs": sha256File(
        join(ROOT, "scripts/prepare-bundle-lib.mjs"),
      ),
    },
  };
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeFileDigests(root = RUNTIME) {
  const files = {};

  function visit(directory) {
    if (!existsSync(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".bundle-stamp") {
        continue;
      }
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      const relativePath = relative(root, path).split(sep).join("/");
      if (stat.isDirectory()) {
        files[relativePath] = {
          type: "directory",
          mode: stat.mode & 0o7777,
        };
        visit(path);
        continue;
      }
      if (stat.isFile()) {
        files[relativePath] = {
          type: "file",
          mode: stat.mode & 0o7777,
          sha256: sha256File(path),
        };
        continue;
      }
      if (stat.isSymbolicLink()) {
        files[relativePath] = {
          type: "symlink",
          mode: stat.mode & 0o7777,
          sha256: sha256Text(readlinkSync(path)),
        };
        continue;
      }
      throw new Error(`unsupported runtime file type at ${path}`);
    }
  }

  visit(root);
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function assertExecutableRegularFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`runtime smoke is missing ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`runtime smoke requires a regular file at ${path}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`runtime smoke requires an executable file at ${path}`);
  }
}

function isRegularExecutableFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isCurrent(expected) {
  const stampPath = join(RUNTIME, ".bundle-stamp");
  if (!existsSync(stampPath)) {
    return false;
  }

  let actual;
  try {
    actual = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return false;
  }

  const { runtime: _actualRuntime, ...actualInputs } = actual;
  const { runtime: _expectedRuntime, ...expectedInputs } = expected;
  if (!stampsMatch(actualInputs, expectedInputs)) {
    return false;
  }

  const expectedFiles = actual.runtime?.files;
  if (!expectedFiles || Object.keys(expectedFiles).length === 0) {
    return false;
  }
  return stampsMatch(runtimeFileDigests(), expectedFiles);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function downloadArchive(url, dest, expectedSha256, fetchImpl = fetch) {
  const part = `${dest}.part`;
  await rm(part, { force: true });
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error(`GET ${url} returned an empty body`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    const actual = sha256File(part);
    if (actual !== expectedSha256) {
      throw new Error(
        `checksum mismatch for ${url}: got ${actual}, want ${expectedSha256}`,
      );
    }
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}

async function copyVerifiedArchive(source, dest, expectedSha256) {
  const part = `${dest}.part`;
  await rm(part, { force: true });
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(source, part);
    const actual = sha256File(part);
    if (actual !== expectedSha256) {
      throw new Error(
        `checksum mismatch for ${source}: got ${actual}, want ${expectedSha256}`,
      );
    }
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}

async function ensureNode(target) {
  const arch = target.nodeDistArch;
  const tarballName = nodeArchiveName(NODE_VERSION, target);
  const officialTarballName = officialNodeArchiveName(NODE_VERSION, target);
  const tarball = join(CACHE, tarballName);
  const legacyTarball = join(CACHE, officialTarballName);
  const extractDir = join(
    CACHE,
    `node-v${NODE_VERSION}-${target.triple}-${arch}`,
  );
  const nodeBin = join(extractDir, "bin/node");
  const licensePath = join(extractDir, "LICENSE");
  const cacheStampPath = join(extractDir, ".prepare-bundle-node.json");

  const expected = pinnedNodeArchiveSha256(NODE_VERSION, target);
  if (!existsSync(tarball)) {
    if (existsSync(legacyTarball)) {
      console.log(`migrating verified Node archive ${legacyTarball}`);
      await copyVerifiedArchive(legacyTarball, tarball, expected);
    } else {
      const url = `https://nodejs.org/dist/v${NODE_VERSION}/${officialTarballName}`;
      console.log(`downloading ${url}`);
      await downloadArchive(url, tarball, expected);
    }
  }
  const actual = sha256File(tarball);
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${tarball}: got ${actual}, want ${expected}; remove the cached archive and retry`,
    );
  }

  let cacheStamp;
  try {
    cacheStamp = JSON.parse(readFileSync(cacheStampPath, "utf8"));
  } catch {
    cacheStamp = undefined;
  }
  const cacheIsCurrent =
    isRegularExecutableFile(nodeBin) &&
    isRegularFile(licensePath) &&
    cacheStamp?.version === NODE_VERSION &&
    cacheStamp?.targetTriple === target.triple &&
    cacheStamp?.nodeDistArch === arch &&
    cacheStamp?.archiveName === tarballName &&
    cacheStamp?.officialArchiveName === officialTarballName &&
    cacheStamp?.archiveSha256 === expected &&
    cacheStamp?.nodeSha256 === sha256File(nodeBin) &&
    cacheStamp?.licenseSha256 === sha256File(licensePath);

  if (!cacheIsCurrent) {
    const archiveRootName = parseArchiveTopLevelDirectory(
      execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }),
    );
    const expectedArchiveRootName = `node-v${NODE_VERSION}-${arch}`;
    if (archiveRootName !== expectedArchiveRootName) {
      throw new Error(
        `Node archive root is ${JSON.stringify(archiveRootName)}, want ${JSON.stringify(expectedArchiveRootName)}`,
      );
    }
    const extractedArchiveDir = join(CACHE, archiveRootName);
    await rm(extractDir, { recursive: true, force: true });
    await rm(extractedArchiveDir, { recursive: true, force: true });
    await mkdir(CACHE, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", CACHE], { stdio: "inherit" });
    if (
      !existsSync(extractedArchiveDir) ||
      !lstatSync(extractedArchiveDir).isDirectory()
    ) {
      throw new Error(`extracted Node is missing ${extractedArchiveDir}`);
    }
    await rename(extractedArchiveDir, extractDir);
    if (!existsSync(nodeBin) || !existsSync(licensePath)) {
      throw new Error(
        `extracted Node is missing ${!existsSync(nodeBin) ? nodeBin : licensePath}`,
      );
    }
    await writeFile(
      cacheStampPath,
      serializeStamp({
        version: NODE_VERSION,
        targetTriple: target.triple,
        nodeDistArch: arch,
        archiveName: tarballName,
        officialArchiveName: officialTarballName,
        archiveSha256: expected,
        nodeSha256: sha256File(nodeBin),
        licenseSha256: sha256File(licensePath),
      }),
    );
  }

  if (!existsSync(nodeBin)) {
    throw new Error(`extracted Node is missing ${nodeBin}`);
  }
  assertExecutableRegularFile(nodeBin);
  const version = execFileSync(nodeBin, ["-v"], { encoding: "utf8" }).trim();
  if (version !== `v${NODE_VERSION}`) {
    throw new Error(`bundled Node reports ${version}, want v${NODE_VERSION}`);
  }
  return {
    nodeBin,
    nodeBinDir: dirname(nodeBin),
    licensePath,
    archiveName: tarballName,
    officialArchiveName: officialTarballName,
    archiveSha256: expected,
  };
}

function runPnpm(args, opts) {
  try {
    execFileSync("pnpm", args, opts);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      execFileSync("corepack", ["pnpm", ...args], opts);
      return;
    }
    throw err;
  }
}

function appIdentity() {
  const configPath = join(ROOT, "src-tauri/tauri.conf.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const packageName = readFileSync(join(ROOT, "src-tauri/Cargo.toml"), "utf8")
    .match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (!config.productName || !config.identifier || !packageName) {
    throw new Error(
      `cannot determine the bundled app identity from ${configPath} and src-tauri/Cargo.toml`,
    );
  }
  return {
    productName: config.productName,
    identifier: config.identifier,
    executable: process.env.BUNDLE_APP_EXECUTABLE ?? packageName,
    bundleName: `${config.productName}.app`,
  };
}

function processMatchesApp(args) {
  try {
    return Boolean(
      execFileSync("pgrep", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch (err) {
    if (err && err.status === 1) {
      return false;
    }
    throw new Error(
      `could not check whether the bundled app is running: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function assertAppNotRunning() {
  if (process.platform !== "darwin") {
    return;
  }
  const identity = appIdentity();
  const running =
    processMatchesApp(["-x", identity.executable]) ||
    processMatchesApp([
      "-f",
      appProcessPattern(identity),
    ]);
  if (running) {
    throw new Error(
      `${identity.productName} (${identity.identifier}) is running and would prevent Tauri from replacing the existing app. Quit the app with Command-Q, then run the build again.`,
    );
  }
}

function isPackageRootManifest(nodeModules, packageJsonPath) {
  const segments = relative(nodeModules, packageJsonPath).split(sep);
  if (segments.includes(".pnpm")) {
    return false;
  }
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  const packageSegments = segments.slice(nodeModulesIndex + 1, -1);
  return (
    packageSegments.length === 1 ||
    (packageSegments.length === 2 && packageSegments[0].startsWith("@"))
  );
}

function licenseDeclarations(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => licenseDeclarations(entry));
  }
  if (value && typeof value === "object") {
    if (value.type !== undefined) {
      return licenseDeclarations(value.type);
    }
    if (value.license !== undefined) {
      return licenseDeclarations(value.license);
    }
  }
  return [];
}

function licenseExpressionFromMetadata(value, packageJsonPath, name, version) {
  const declarations = licenseDeclarations(value)
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  if (declarations.length === 0) {
    throw new Error(
      `dependency ${name}@${version} is missing license metadata (${packageJsonPath})`,
    );
  }
  const expressions = declarations.map((declaration) => {
    try {
      return parseSpdxLicenseExpression(declaration);
    } catch (err) {
      throw new Error(
        `dependency ${name}@${version} has invalid SPDX license ${JSON.stringify(declaration)}: ${err instanceof Error ? err.message : err} (${packageJsonPath})`,
      );
    }
  });
  return [...new Set(expressions)].join(" OR ");
}

function normalizeLicenseSource(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  let source = value.trim();
  if (source.startsWith("git+https://")) {
    source = source.slice(4);
  } else if (source.startsWith("git://github.com/")) {
    source = `https://github.com/${source.slice("git://github.com/".length)}`;
  }
  if (!/^https?:\/\//i.test(source)) {
    return undefined;
  }
  try {
    const parsed = new URL(source);
    return parsed.hostname ? source : undefined;
  } catch {
    return undefined;
  }
}

function licenseSourceUrls(packageJson, licenseMetadata) {
  const urls = [];
  const add = (value) => {
    const normalized = normalizeLicenseSource(value);
    if (normalized && !urls.includes(normalized)) {
      urls.push(normalized);
    }
  };
  const visitLicenseMetadata = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visitLicenseMetadata);
    } else if (value && typeof value === "object") {
      add(value.url);
    }
  };
  visitLicenseMetadata(licenseMetadata);
  add(packageJson.licenseUrl);
  if (typeof packageJson.repository === "string") {
    add(packageJson.repository);
  } else {
    add(packageJson.repository?.url);
  }
  add(packageJson.homepage);
  return urls;
}

function repositoryKey(packageJson) {
  const repository =
    typeof packageJson.repository === "string"
      ? packageJson.repository
      : packageJson.repository?.url;
  const normalized = normalizeLicenseSource(repository);
  return normalized?.replace(/\/+$/, "").replace(/\.git$/i, "");
}

function licenseFilesForDirectory(directory, runtimeRoot) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(?:licen[cs]e|copying|notice)(?:[.\-_]|$)/i.test(entry.name) &&
        readFileSync(join(directory, entry.name), "utf8").trim().length > 0,
    )
    .map((entry) =>
      relative(runtimeRoot, join(directory, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
}

function sharedScopeLicenseSource(packageDir, nodeModules, runtimeRoot) {
  const scopeDir = dirname(packageDir);
  if (scopeDir === nodeModules || !basename(scopeDir).startsWith("@")) {
    return undefined;
  }
  const paths = licenseFilesForDirectory(scopeDir, runtimeRoot);
  return paths.length > 0
    ? { kind: "shared-scope-license", paths }
    : undefined;
}

function sharedPackageLicenseSource(entry, entries) {
  if (!entry.repositoryKey) {
    return undefined;
  }
  const owner = entries.find(
    (candidate) =>
      candidate !== entry &&
      candidate.repositoryKey === entry.repositoryKey &&
      candidate.licenseExpression === entry.licenseExpression &&
      candidate.licenseFiles.length > 0,
  );
  return owner
    ? {
        kind: "shared-package-license",
        packageName: owner.name,
        packageVersion: owner.version,
        paths: owner.licenseFiles,
      }
    : undefined;
}

function resolveLicenseSource(entry, entries, nodeModules, runtimeRoot) {
  if (entry.licenseFiles.length > 0) {
    return { kind: "local-license", paths: entry.licenseFiles };
  }
  const scopeSource = sharedScopeLicenseSource(
    entry.packageDir,
    nodeModules,
    runtimeRoot,
  );
  if (scopeSource) {
    return scopeSource;
  }
  const packageSource = sharedPackageLicenseSource(entry, entries);
  if (packageSource) {
    return packageSource;
  }
  if (entry.licenseSourceUrls.length > 0) {
    return { kind: "license-url", url: entry.licenseSourceUrls[0] };
  }
  throw new Error(
    `dependency ${entry.name}@${entry.version} has no license text or source; provide a license file or a license/repository/homepage URL (${entry.packagePath}/package.json)`,
  );
}

function collectDependencyLicenseEntries(nodeModules, runtimeRoot = RUNTIME) {
  const packageJsonPaths = [];

  function visit(directory) {
    if (!existsSync(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== ".pnpm") {
        visit(path);
      } else if (
        entry.isFile() &&
        entry.name === "package.json" &&
        isPackageRootManifest(nodeModules, path)
      ) {
        packageJsonPaths.push(path);
      }
    }
  }

  visit(nodeModules);
  return packageJsonPaths
    .map((packageJsonPath) => {
      let packageJson;
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      } catch (err) {
        throw new Error(
          `invalid dependency package JSON ${packageJsonPath}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (!packageJson.name || !packageJson.version) {
        throw new Error(
          `dependency package JSON ${packageJsonPath} is missing name or version`,
        );
      }
      const license = packageJson.license ?? packageJson.licenses;
      const licenseExpression = licenseExpressionFromMetadata(
        license,
        packageJsonPath,
        packageJson.name,
        packageJson.version,
      );
      const packageDir = dirname(packageJsonPath);
      const licenseFiles = licenseFilesForDirectory(packageDir, runtimeRoot);
      const packagePath = relative(runtimeRoot, packageDir).split(sep).join("/");
      return {
        name: packageJson.name,
        version: packageJson.version,
        packagePath,
        license,
        licenseExpression,
        licenseFiles,
        packageDir,
        repositoryKey: repositoryKey(packageJson),
        licenseSourceUrls: licenseSourceUrls(packageJson, license),
      };
    })
    .sort((left, right) =>
      left.packagePath < right.packagePath
        ? -1
        : left.packagePath > right.packagePath
          ? 1
          : 0,
    )
    .map((entry, _index, entries) => {
      const licenseSource = resolveLicenseSource(
        entry,
        entries,
        nodeModules,
        runtimeRoot,
      );
      const {
        licenseSourceUrls: _licenseSourceUrls,
        packageDir: _packageDir,
        repositoryKey: _repositoryKey,
        ...publicEntry
      } = entry;
      return { ...publicEntry, licenseSource };
    });
}

function thirdPartyNotices(nodeVersion, entries) {
  for (const entry of entries) {
    if (!entry.licenseExpression || !entry.licenseSource) {
      throw new Error(
        `dependency ${entry.name}@${entry.version} has no complete license notice source`,
      );
    }
  }
  const lines = [
    "Third-party license manifest",
    `Generated by scripts/prepare-bundle.mjs (script version ${SCRIPT_VERSION}).`,
    "Coverage: project root LICENSE, Node.js, and npm production dependencies.",
    "Cargo dependencies are not covered; this file is not an SBOM.",
    "",
    "Project license",
    "  files: licenses/root/LICENSE",
    "",
    `Node.js ${nodeVersion}`,
    "  files: licenses/node/LICENSE",
    "",
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.name}@${entry.version}`);
    lines.push(`  package: ${entry.packagePath}/package.json`);
    lines.push(`  SPDX: ${entry.licenseExpression}`);
    lines.push(`  metadata: ${JSON.stringify(entry.license)}`);
    switch (entry.licenseSource.kind) {
      case "local-license":
        lines.push(`  license text: ${entry.licenseSource.paths.join(", ")}`);
        break;
      case "shared-scope-license":
        lines.push(
          `  license text: ${entry.licenseSource.paths.join(", ")} (shared from scope LICENSE for ${entry.name}@${entry.version})`,
        );
        break;
      case "shared-package-license":
        lines.push(
          `  license text: ${entry.licenseSource.paths.join(", ")} (shared from ${entry.licenseSource.packageName}@${entry.licenseSource.packageVersion})`,
        );
        break;
      case "license-url":
        lines.push(`  license source: ${entry.licenseSource.url}`);
        break;
      default:
        throw new Error(
          `dependency ${entry.name}@${entry.version} has an unsupported license notice source`,
        );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function copyNodeLicense(nodeLicensePath) {
  const destination = join(RUNTIME, "licenses/node/LICENSE");
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(nodeLicensePath, destination);
}

async function copyProjectLicense() {
  const source = join(ROOT, "LICENSE");
  const destination = join(RUNTIME, "licenses/root/LICENSE");
  if (!existsSync(source)) {
    throw new Error(`project root license is missing: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function installedDshVersion() {
  const packagePath = join(
    RUNTIME,
    "node_modules/@deepseek-ai/dsh/package.json",
  );
  if (!existsSync(packagePath)) {
    throw new Error(`flattened tree is missing ${packagePath}`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!packageJson.version) {
    throw new Error(`${packagePath} does not contain a version`);
  }
  return packageJson.version;
}

function smokeDsh(node, bin, packageVersion) {
  assertExecutableRegularFile(node);
  const embeddedVersion = execFileSync(node, [bin, "--version"], {
    encoding: "utf8",
  }).trim();
  validateDshVersion(embeddedVersion, packageVersion);
  execFileSync(node, [bin, "--help"], { stdio: "inherit" });
}

async function installDsh(dsh, nodeBinDir) {
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await writeFile(join(STAGE, "package.json"), await readFile(join(ROOT, "package.json")));
  await writeFile(
    join(STAGE, "pnpm-lock.yaml"),
    await readFile(join(ROOT, "pnpm-lock.yaml")),
  );
  await writeFile(
    join(STAGE, ".npmrc"),
    "node-linker=hoisted\nshamefully-hoist=true\n",
  );

  const path = `${nodeBinDir}${delimiter}${process.env.PATH ?? ""}`;
  console.log(`pnpm install --prod (Node ${NODE_VERSION}, @deepseek-ai/dsh@${dsh})`);
  runPnpm(["install", "--prod", "--frozen-lockfile", "--ignore-workspace"], {
    cwd: STAGE,
    stdio: "inherit",
    env: { ...process.env, PATH: path },
  });

  const stagedBin = join(STAGE, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  if (!existsSync(stagedBin)) {
    throw new Error(`pnpm install did not produce ${stagedBin}`);
  }

  const destNm = join(RUNTIME, "node_modules");
  await mkdir(RUNTIME, { recursive: true });
  await rm(destNm, { recursive: true, force: true });
  execFileSync("rsync", ["-aL", join(STAGE, "node_modules") + "/", destNm + "/"], {
    stdio: "inherit",
  });
  await rm(STAGE, { recursive: true, force: true });
}

async function main() {
  assertAppNotRunning();
  const inputs = bundleInputs();
  const target = resolveTarget();
  // Validate the archive even when the extracted Node and runtime are reused.
  const node = await ensureNode(target);
  const expectedStamp = createStamp({
    ...inputs,
    nodeVersion: NODE_VERSION,
    target,
    nodeArchiveName: node.archiveName,
    nodeOfficialArchiveName: node.officialArchiveName,
    nodeArchiveSha256: node.archiveSha256,
  });
  if (!force && isCurrent(expectedStamp)) {
    const runtimeNode = join(RUNTIME, "bin/node");
    const runtimeBin = join(
      RUNTIME,
      "node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
    smokeDsh(runtimeNode, runtimeBin, installedDshVersion());
    console.log(
      `vendor/runtime already has @deepseek-ai/dsh@${inputs.dshVersion} + Node ${NODE_VERSION} for ${target.triple}`,
    );
    return;
  }

  await installDsh(inputs.dshVersion, node.nodeBinDir);

  const destNode = join(RUNTIME, "bin/node");
  await mkdir(dirname(destNode), { recursive: true });
  await copyFile(node.nodeBin, destNode);
  await chmod(destNode, 0o755);

  const bin = join(RUNTIME, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  if (!existsSync(bin)) {
    throw new Error(`flattened tree is missing ${bin}`);
  }
  smokeDsh(destNode, bin, installedDshVersion());
  await copyNodeLicense(node.licensePath);
  await copyProjectLicense();
  const dependencyLicenses = collectDependencyLicenseEntries(
    join(RUNTIME, "node_modules"),
  );
  await writeFile(
    join(RUNTIME, "licenses/THIRD_PARTY_NOTICES.txt"),
    thirdPartyNotices(NODE_VERSION, dependencyLicenses),
  );

  const stamp = createStamp({
    ...inputs,
    nodeVersion: NODE_VERSION,
    target,
    nodeArchiveName: node.archiveName,
    nodeOfficialArchiveName: node.officialArchiveName,
    nodeArchiveSha256: node.archiveSha256,
    runtimeFiles: runtimeFileDigests(),
  });
  await writeFile(join(RUNTIME, ".bundle-stamp"), serializeStamp(stamp));
  console.log(
    `wrote ${RUNTIME} (@deepseek-ai/dsh@${inputs.dshVersion}, node ${NODE_VERSION}, ${target.triple})`,
  );
}

export {
  assertExecutableRegularFile,
  collectDependencyLicenseEntries,
  createStamp,
  downloadArchive,
  resolveTarget,
  runtimeFileDigests,
  serializeStamp,
  stampsMatch,
  thirdPartyNotices,
  validateDshVersion,
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
