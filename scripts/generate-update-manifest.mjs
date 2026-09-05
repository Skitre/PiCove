/** Stage one accepted platform build, or aggregate staged builds into a GitHub release. */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { updaterPlatformKey } from "./release-runtime-target.mjs";

function fail(message) {
  throw new Error(`[generate-update-manifest] ${message}`);
}

function assertTagVersion(tag, version) {
  if (!/^v\d/u.test(String(tag))) fail(`tag must look like v<semver>, got ${String(tag)}`);
  if (tag !== `v${version}`) fail(`tag ${tag} does not match the packaged app version ${version}`);
}

function assertRepo(repo) {
  if (!/^[^/\\]+\/[^/\\]+$/u.test(String(repo))) {
    fail(`repo must be owner/name, got ${String(repo)}`);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyVerified(source, destination, expectedSha256) {
  if (!existsSync(source)) fail(`release asset is missing: ${source}`);
  if (sha256File(source) !== expectedSha256) fail(`release asset hash drifted: ${source}`);
  copyFileSync(source, destination);
  if (sha256File(destination) !== expectedSha256)
    fail(`release asset copy drifted: ${destination}`);
}

function assertAssetName(name, label) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    fail(`invalid ${label}: ${String(name)}`);
  }
}

function assertSha256(value, label) {
  if (!/^[0-9a-f]{64}$/u.test(String(value))) fail(`invalid ${label}: ${String(value)}`);
}

function validatePlatformDescriptor(value) {
  if (value.schemaVersion !== 1)
    fail(`unsupported platform descriptor schema ${value.schemaVersion}`);
  let expectedPlatform;
  try {
    expectedPlatform = updaterPlatformKey(value.platform, value.arch);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (value.updaterPlatform !== expectedPlatform) {
    fail(`descriptor platform ${value.updaterPlatform} does not match ${expectedPlatform}`);
  }
  assertAssetName(value.primaryName, "primary asset name");
  assertAssetName(value.updaterName, "updater asset name");
  assertAssetName(value.signatureName, "signature asset name");
  assertAssetName(value.packageManifestName, "package manifest name");
  if (value.signatureName !== `${value.updaterName}.sig`) {
    fail(`signature asset ${value.signatureName} does not match updater ${value.updaterName}`);
  }
  assertSha256(value.primarySha256, "primary asset SHA-256");
  assertSha256(value.updaterSha256, "updater asset SHA-256");
  assertSha256(value.signatureSha256, "signature asset SHA-256");
  assertSha256(value.packageManifestSha256, "package manifest SHA-256");
  if (typeof value.signature !== "string" || value.signature.trim() === "") {
    fail(`updater signature is empty for ${value.updaterPlatform}`);
  }
}

export function normalizedReleaseNames({ version, platform, arch, primaryName }) {
  if (platform === "win32" && arch === "x64") {
    return { primary: primaryName, updater: primaryName };
  }
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) {
    const releaseArch = arch === "arm64" ? "aarch64" : "x64";
    return {
      primary: `PiDeck_${version}_${releaseArch}.dmg`,
      updater: `PiDeck_${version}_${releaseArch}.app.tar.gz`,
    };
  }
  fail(`unsupported release artifact target: ${platform}-${arch}`);
}

export function buildUpdateManifest({ tag, version, artifacts, repo, publishedAt }) {
  assertTagVersion(tag, version);
  assertRepo(repo);
  if (!Array.isArray(artifacts) || artifacts.length === 0) fail("no platform artifacts provided");
  const platforms = {};
  for (const artifact of artifacts) {
    const platform = artifact.updaterPlatform;
    if (!/^(?:windows|darwin)-(?:x86_64|aarch64)$/u.test(String(platform))) {
      fail(`invalid updater platform ${String(platform)}`);
    }
    if (platforms[platform]) fail(`duplicate updater platform ${platform}`);
    if (typeof artifact.signature !== "string" || artifact.signature.trim() === "") {
      fail(`updater signature is empty for ${platform}`);
    }
    if (typeof artifact.updaterName !== "string" || artifact.updaterName.includes("/")) {
      fail(`invalid updater asset name for ${platform}: ${String(artifact.updaterName)}`);
    }
    platforms[platform] = {
      signature: artifact.signature.trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(artifact.updaterName)}`,
    };
  }
  return { version, pub_date: publishedAt, platforms };
}

export function stageCurrentPlatform({ root, tag, outputDir }) {
  const stagingDir = join(root, "apps/desktop/src-tauri/target/release-staging");
  const packageManifestPath = join(stagingDir, "PACKAGE_RELEASE.json");
  if (!existsSync(packageManifestPath))
    fail("PACKAGE_RELEASE.json missing — run pnpm package:release first");
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  if (packageManifest.status !== "ok")
    fail(`refusing a ${packageManifest.status} package:release run`);
  if (packageManifest.platform !== process.platform || packageManifest.arch !== process.arch) {
    fail(
      `package manifest target ${packageManifest.platform}-${packageManifest.arch} does not match runner ${process.platform}-${process.arch}`,
    );
  }

  const version = JSON.parse(
    readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  ).version;
  assertTagVersion(tag, version);
  const platform = updaterPlatformKey(packageManifest.platform, packageManifest.arch);
  if (packageManifest.updaterPlatform && packageManifest.updaterPlatform !== platform) {
    fail(
      `package manifest updater platform ${packageManifest.updaterPlatform} does not match ${platform}`,
    );
  }

  const primary = packageManifest.primaryInstaller;
  if (!primary || !existsSync(primary)) fail("accepted primary installer is missing");
  if (sha256File(primary) !== packageManifest.primaryInstallerSha256) {
    fail("accepted primary installer hash drifted since packaging");
  }
  const updater = packageManifest.updaterBundle ?? primary;
  const updaterSha256 =
    packageManifest.updaterBundleSha256 ?? packageManifest.primaryInstallerSha256;
  if (!existsSync(updater) || sha256File(updater) !== updaterSha256) {
    fail("accepted updater bundle is missing or hash drifted");
  }
  const signaturePath =
    packageManifest.updaterSignatureFile ?? `${packageManifest.sourceInstaller}.sig`;
  if (!signaturePath || !existsSync(signaturePath))
    fail(`updater signature missing: ${signaturePath}`);
  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!signature) fail(`updater signature is empty: ${signaturePath}`);

  const names = normalizedReleaseNames({
    version,
    platform: packageManifest.platform,
    arch: packageManifest.arch,
    primaryName: basename(primary),
  });
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  copyVerified(primary, join(outputDir, names.primary), packageManifest.primaryInstallerSha256);
  if (names.updater !== names.primary) {
    copyVerified(updater, join(outputDir, names.updater), updaterSha256);
  }
  const signatureName = `${names.updater}.sig`;
  copyFileSync(signaturePath, join(outputDir, signatureName));
  const packageManifestName = `installer-manifest-${platform}.json`;
  copyFileSync(packageManifestPath, join(outputDir, packageManifestName));

  const descriptor = {
    schemaVersion: 1,
    tag,
    version,
    platform: packageManifest.platform,
    arch: packageManifest.arch,
    updaterPlatform: platform,
    primaryName: names.primary,
    primarySha256: packageManifest.primaryInstallerSha256,
    updaterName: names.updater,
    updaterSha256,
    signatureName,
    signatureSha256: sha256File(join(outputDir, signatureName)),
    signature,
    packageManifestName,
    packageManifestSha256: sha256File(join(outputDir, packageManifestName)),
  };
  const descriptorName = `release-platform-${platform}.json`;
  writeFileSync(join(outputDir, descriptorName), `${JSON.stringify(descriptor, null, 2)}\n`);
  return { descriptor, descriptorName, outputDir };
}

function findDescriptors(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findDescriptors(path));
    if (entry.isFile() && /^release-platform-.+\.json$/u.test(entry.name)) found.push(path);
  }
  return found;
}

export function aggregateRelease({ inputDir, outputDir, tag, repo, publishedAt }) {
  assertRepo(repo);
  const descriptorPaths = findDescriptors(inputDir);
  if (descriptorPaths.length === 0) fail(`no release platform descriptors under ${inputDir}`);
  const descriptors = descriptorPaths.map((path) => ({
    path,
    directory: dirname(path),
    value: JSON.parse(readFileSync(path, "utf8")),
  }));
  for (const { value } of descriptors) validatePlatformDescriptor(value);
  const versions = new Set(descriptors.map(({ value }) => value.version));
  if (versions.size !== 1)
    fail(`platform artifacts disagree on version: ${[...versions].join(", ")}`);
  const [version] = versions;
  assertTagVersion(tag, version);
  for (const { value } of descriptors) {
    if (value.tag !== tag)
      fail(`platform ${value.updaterPlatform} was staged for ${value.tag}, not ${tag}`);
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const copiedNames = new Set();
  const copyDescriptorAsset = (descriptor, name, sha256 = null) => {
    if (copiedNames.has(name)) fail(`duplicate release asset name: ${name}`);
    copiedNames.add(name);
    const source = join(descriptor.directory, name);
    const destination = join(outputDir, name);
    if (sha256) copyVerified(source, destination, sha256);
    else copyFileSync(source, destination);
  };
  for (const descriptor of descriptors) {
    const value = descriptor.value;
    copyDescriptorAsset(descriptor, value.primaryName, value.primarySha256);
    if (value.updaterName !== value.primaryName) {
      copyDescriptorAsset(descriptor, value.updaterName, value.updaterSha256);
    }
    copyDescriptorAsset(descriptor, value.signatureName, value.signatureSha256);
    const signature = readFileSync(join(descriptor.directory, value.signatureName), "utf8").trim();
    if (signature !== value.signature.trim()) {
      fail(`signature content drifted for ${value.updaterPlatform}`);
    }
    copyDescriptorAsset(descriptor, value.packageManifestName, value.packageManifestSha256);
    copyDescriptorAsset(descriptor, basename(descriptor.path));
  }

  const manifest = buildUpdateManifest({
    tag,
    version,
    artifacts: descriptors.map(({ value }) => value),
    repo,
    publishedAt,
  });
  writeFileSync(join(outputDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(outputDir, "installer-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        tag,
        version,
        generatedAt: publishedAt,
        platforms: Object.fromEntries(
          descriptors.map(({ value }) => [
            value.updaterPlatform,
            {
              primaryName: value.primaryName,
              primarySha256: value.primarySha256,
              updaterName: value.updaterName,
              updaterSha256: value.updaterSha256,
              packageManifestName: value.packageManifestName,
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  return { manifest, descriptors: descriptors.map(({ value }) => value), outputDir };
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const tag = readArg(args, "--tag") ?? fail("--tag is required (e.g. --tag v0.1.1)");
  const repo = readArg(args, "--repo") ?? process.env.GITHUB_REPOSITORY ?? "Skitre/PiCove";
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (args.includes("--stage-platform")) {
    const outputDir =
      readArg(args, "--output-dir") ??
      join(root, "apps/desktop/src-tauri/target/release-staging/github-release-platform");
    const result = stageCurrentPlatform({ root, tag, outputDir });
    console.log(
      `[generate-update-manifest] staged ${result.descriptor.updaterPlatform} at ${outputDir}`,
    );
    return;
  }
  const inputDir = readArg(args, "--input-dir") ?? fail("--input-dir is required when aggregating");
  const outputDir =
    readArg(args, "--output-dir") ??
    join(root, "apps/desktop/src-tauri/target/release-staging/github-release");
  const result = aggregateRelease({
    inputDir,
    outputDir,
    tag,
    repo,
    publishedAt: new Date().toISOString(),
  });
  console.log(
    `[generate-update-manifest] aggregated ${result.descriptors.length} platforms at ${outputDir}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
