// The decisions behind pack-proof/canary.mjs (engine-split Task 1b-4, D16), which .github/workflows/engine-canary.yml runs between
// "build dist" and "publish". No network and no registry here: a version, a manifest edit, and the verdict on a tarball, each held
// to a failing input by test/canary.test.ts. canary.mjs is the only importer; nothing here is part of the published package.
//
// WHAT A CANARY IS. `0.0.0-canary.<run number>.g<9 hex of the commit>`, published under the dist-tag `canary` and never `latest`.
//   * The run number comes first and is a semver NUMERIC identifier, so precedence follows the merge order (run 10 is newer than 9;
//     a sha alone would order canaries by hash). Unique per (run, commit); a re-run of the same run and commit re-derives the same
//     version, which the registry refuses a second time, so it can never overwrite.
//   * The commit is `g` + hex (git-describe's spelling) because 9 hex digits can be all digits, and an all-digit identifier with a
//     leading zero is NOT valid semver ("Numeric identifiers MUST NOT include leading zeroes"): about 1 commit in 700 would
//     otherwise fail to publish. With the `g` the identifier is alphanumeric for every sha.
//   * The base is 0.0.0, so no canary ranks above a stable release (1.0.0 comes from the engine repo at 2b).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { checkTarballExports, requireChecked } from "./lib.mjs";

export const CANARY_BASE = "0.0.0";

/** A positive integer with no sign, fraction, exponent, padding or leading zero: exactly what a semver numeric identifier may be. */
const RUN_NUMBER = /^[1-9][0-9]*$/;
/** Lower-case hex, as `git` prints it. GITHUB_SHA is 40 (sha1) or 64 (sha256) characters; 9 is all a canary uses. */
const COMMIT = /^[0-9a-f]{9,64}$/;
const CANARY_VERSION = /^0\.0\.0-canary\.[1-9][0-9]*\.g[0-9a-f]{9}$/;

/** The version of the canary published for this workflow run and commit. Throws on anything that would not give a valid, ordered one. */
export function canaryVersion({ runNumber, sha }) {
  // Both come from the environment, so both are strings: a number here is a caller that did not read the env, and is refused.
  if (typeof runNumber !== "string" || !RUN_NUMBER.test(runNumber)) throw new Error(`GITHUB_RUN_NUMBER must be a positive integer without leading zeros, got ${JSON.stringify(runNumber)}`);
  if (typeof sha !== "string" || !COMMIT.test(sha)) throw new Error(`GITHUB_SHA must be at least 9 lower-case hex characters, got ${JSON.stringify(sha)}`);
  return assertCanaryVersion(`${CANARY_BASE}-canary.${runNumber}.g${sha.slice(0, 9)}`);
}

/** The one shape of version this tooling may write into a manifest or accept on a tarball: a stable or arbitrary version must never
 *  come out of the canary path, whatever called it. Returns `version`. */
export function assertCanaryVersion(version) {
  if (typeof version !== "string" || !CANARY_VERSION.test(version)) {
    throw new Error(`${JSON.stringify(version)} is not a canary version (0.0.0-canary.<run number>.g<9 hex>): only a canary may be written or published from here`);
  }
  return version;
}

/** `manifestText` (a package.json) with its `version` replaced and every other field, and their order, kept. Throws on a version that
 *  is not a canary, on text that is not JSON, and on a manifest with no version to replace. */
export function withVersion(manifestText, version) {
  assertCanaryVersion(version);
  const manifest = JSON.parse(manifestText);
  if (manifest === null || typeof manifest !== "object" || typeof manifest.version !== "string") throw new Error("the manifest has no string `version` to replace");
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const MAX_BUFFER = 512 * 1024 * 1024;

/** The manifest and the file list of a `.tgz` as `pnpm pack` writes it (everything under `package/`), read with `tar` and without
 *  unpacking. `files` are paths relative to the package root, directories excluded. Throws when the file is not a tarball or holds
 *  no `package/package.json`. */
export function readTarball(tgz) {
  const names = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] })
    .split("\n")
    .filter((n) => n !== "");
  const files = new Set(names.filter((n) => n.startsWith("package/") && !n.endsWith("/")).map((n) => n.slice("package/".length)));
  if (!files.has("package.json")) throw new Error(`${tgz} holds no package/package.json`);
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] }));
  return { manifest, files };
}

/** The verdict on a tarball about to be published: it is `name`, at exactly the derived canary `version`, it holds dist/ files, and
 *  its exports are exactly the workspace's keys with every target a present dist/ file - none at ./src (what `npm pack` would ship)
 *  and none dangling. Throws on the first failure; returns the counts judged. `files` is any iterable of package-relative paths. */
export function checkCanaryTarball({ manifest, files, expectedKeys, name, version }) {
  assertCanaryVersion(version);
  const present = new Set(files);
  if (manifest.name !== name) throw new Error(`the tarball is ${String(manifest.name)}, expected ${name}`);
  if (manifest.version !== version) throw new Error(`the tarball's version is ${String(manifest.version)}, expected ${version} (set-version did not take effect)`);
  const dist = [...present].filter((f) => f.startsWith("dist/"));
  if (dist.length === 0) throw new Error("the tarball holds no dist/ file: refusing to publish an empty build");
  const exportTargets = requireChecked("canary tarball exports", checkTarballExports({ manifest, files: present, expectedKeys }));
  return { files: present.size, distFiles: dist.length, exportTargets };
}

const USAGE = ["usage: canary.mjs version                      print the canary version for $GITHUB_RUN_NUMBER and $GITHUB_SHA", "       canary.mjs set-version <version>       write a canary version into the engine's package.json (the runner's checkout)", "       canary.mjs check <tarball> <version>   refuse a tarball that must not be published"].join("\n");

/** The command line behind canary.mjs, with its environment, output and manifest passed in. Returns the exit code: 0 done, 1 refused
 *  (the reason on `io.err`, nothing on `io.out`), 2 misuse. `manifestFile` is the engine's package.json: the one `set-version` edits
 *  and the source of the name and export keys `check` compares a tarball against. */
export function main(argv, env, io, { manifestFile }) {
  const [command, ...args] = argv;
  // An unknown command (or none) has no arity, and no argument count equals `undefined`: it is refused by the same comparison.
  const arity = new Map([["version", 0], ["set-version", 1], ["check", 2]]);
  if (args.length !== arity.get(command)) {
    io.err(USAGE);
    return 2;
  }
  try {
    if (command === "version") {
      io.out(canaryVersion({ runNumber: env.GITHUB_RUN_NUMBER, sha: env.GITHUB_SHA }));
    } else if (command === "set-version") {
      writeFileSync(manifestFile, withVersion(readFileSync(manifestFile, "utf8"), args[0]));
      io.out(`canary: package.json version is now ${args[0]}`);
    } else {
      const [tarball, version] = args;
      const workspace = JSON.parse(readFileSync(manifestFile, "utf8"));
      const { manifest, files } = readTarball(tarball);
      const r = checkCanaryTarball({ manifest, files, expectedKeys: Object.keys(workspace.exports ?? {}), name: workspace.name, version });
      io.out(`canary tarball ok: ${r.files} files, ${r.distFiles} under dist/, ${r.exportTargets} export targets`);
    }
    return 0;
  } catch (e) {
    io.err(`canary: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
