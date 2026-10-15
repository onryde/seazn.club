// Engine-split Task 1b-4 (D16). pack-proof/canary.mjs is what .github/workflows/engine-canary.yml runs between "build dist" and "publish":
// it derives the canary version, writes it into the RUNNER's checkout, and refuses a tarball that must not reach the registry. The
// workflow's own wiring is held in scripts/__tests__/engine-canary-workflow.test.ts; the DECISIONS are held here, each to a failing
// input, with no network and no registry: a version that is not valid semver or does not go up with the run number, a stable
// version smuggled in, a tarball whose exports point at source, an empty dist, a name or version that is not the one derived.
//
// Single-sport reason: no sport is involved - this is publish tooling.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assertCanaryVersion, canaryVersion, checkCanaryTarball, readTarball, withVersion } from "../pack-proof/canary-lib.mjs";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROOF = join(ENGINE, "pack-proof");
const manifestFile = join(ENGINE, "package.json");
const pkg = JSON.parse(readFileSync(manifestFile, "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, string>;
  publishConfig: { exports: Record<string, Record<string, string>> };
};

const scratch = mkdtempSync(join(tmpdir(), "canary-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string) => {
  const dir = join(scratch, `${label}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// ---------------------------------------------------------------------------------------------- the rulebook, not the code

/** semver.org's own grammar for a version, copied from the spec (https://semver.org, "Is there a suggested regular expression"). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** semver.org section 11 precedence of two PRERELEASE strings of equal core: numeric identifiers compare as integers and rank below
 *  alphanumeric ones, alphanumeric compare in ASCII order, and a shorter list ranks below a longer one it is a prefix of. */
function comparePrerelease(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [p, q] = [x[i]!, y[i]!];
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) {
      if (BigInt(p) !== BigInt(q)) return BigInt(p) < BigInt(q) ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return Math.sign(x.length - y.length);
}
const prereleaseOf = (version: string) => SEMVER.exec(version)![4]!;

// A commit sha whose first nine characters are all digits (a numeric identifier), one that also starts with 0 (a numeric identifier
// with a leading zero, which semver forbids), letters only, and an ordinary mix. 40 hex characters each, as GITHUB_SHA is.
const SHAS = [
  "012345678abcdef0123456789abcdef012345678",
  "123456789abcdef0123456789abcdef012345678",
  "abcdefabcdef0123456789abcdef0123456789ab",
  "9f2c1d7e03a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8",
];
// 9 -> 10 and 99 -> 100 are the digit-count steps where a lexical (string) ordering of the run number goes wrong.
const RUNS = ["1", "2", "9", "10", "11", "99", "100", "101", "999", "1000", "12345", "100000"];

describe("canaryVersion (the version a canary is published under)", () => {
  it("is valid semver for every run number and commit, including a sha that is all digits or starts with 0", () => {
    let checked = 0;
    for (const runNumber of RUNS) {
      for (const sha of SHAS) {
        const v = canaryVersion({ runNumber, sha });
        expect(v, `${runNumber} ${sha}`).toMatch(SEMVER);
        expect(v.startsWith("0.0.0-canary."), v).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(RUNS.length * SHAS.length);
  });

  it("goes up with the run number under semver precedence, whatever the commit (9 < 10 < 100), so the registry's order is the merge order", () => {
    let pairs = 0;
    for (const lo of RUNS) {
      for (const hi of RUNS) {
        if (lo === hi) continue;
        for (const a of SHAS) {
          for (const b of SHAS) {
            const [va, vb] = [canaryVersion({ runNumber: lo, sha: a }), canaryVersion({ runNumber: hi, sha: b })];
            expect(comparePrerelease(prereleaseOf(va), prereleaseOf(vb)), `${va} vs ${vb}`).toBe(Math.sign(Number(lo) - Number(hi)));
            pairs++;
          }
        }
      }
    }
    expect(pairs).toBe(RUNS.length * (RUNS.length - 1) * SHAS.length * SHAS.length);
    // the differential case, stated outright: run 10 is NEWER than run 9 even though "10" < "9" as strings
    const nine = canaryVersion({ runNumber: "9", sha: SHAS[3]! });
    const ten = canaryVersion({ runNumber: "10", sha: SHAS[0]! });
    expect(comparePrerelease(prereleaseOf(ten), prereleaseOf(nine))).toBe(1);
    expect("10" < "9").toBe(true);
  });

  it("is unique per (run, commit): two runs, or two commits, never share a version", () => {
    const seen = new Map<string, string>();
    for (const runNumber of RUNS) {
      for (const sha of SHAS) {
        const v = canaryVersion({ runNumber, sha });
        expect(seen.has(v), `${v} was already derived from ${seen.get(v)}`).toBe(false);
        seen.set(v, `${runNumber}/${sha}`);
      }
    }
    expect(seen.size).toBe(RUNS.length * SHAS.length);
  });

  it("uses the first nine characters of the sha and only those: a longer sha changes nothing after them, a shorter nine-char sha is accepted", () => {
    expect(canaryVersion({ runNumber: "7", sha: "0123456789abcdef" })).toBe("0.0.0-canary.7.g012345678");
    expect(canaryVersion({ runNumber: "7", sha: "012345678ffffffff" })).toBe("0.0.0-canary.7.g012345678");
    expect(canaryVersion({ runNumber: "7", sha: "012345678" })).toBe("0.0.0-canary.7.g012345678");
  });

  it("refuses a run number that is not a plain positive integer, naming GITHUB_RUN_NUMBER (the run guard itself, not the check on the finished version)", () => {
    const refused = [undefined, null, "", "0", "007", "-1", "1.5", "1e3", "12 ", " 12", "12a", "\u0663", 7, 0, -3, 1.5]; // a number is refused too: GITHUB_RUN_NUMBER is always a string
    for (const runNumber of refused) expect(() => canaryVersion({ runNumber, sha: SHAS[0] }), String(runNumber)).toThrow(/GITHUB_RUN_NUMBER/);
    expect(refused.length).toBeGreaterThan(10);
  });

  it("refuses a sha that is not 9+ lower-case hex characters, naming GITHUB_SHA (the commit guard itself)", () => {
    const refused = [undefined, null, "", "01234567", "012345678ABCDEF", "not-a-sha-at-all", "0123456789abcdeg", " 012345678", "012345678 ", "g012345678", 123456789];
    for (const sha of refused) expect(() => canaryVersion({ runNumber: "7", sha }), String(sha)).toThrow(/GITHUB_SHA/);
    expect(refused.length).toBeGreaterThan(8);
  });
});

describe("assertCanaryVersion (the only versions this tooling may write or publish)", () => {
  it("accepts what canaryVersion derives and nothing else: not a stable version, not a bare tag, not another prerelease", () => {
    expect(assertCanaryVersion("0.0.0-canary.12.gabcdef012")).toBe("0.0.0-canary.12.gabcdef012");
    const refused = ["1.0.0", "0.1.0", "0.0.0", "latest", "canary", "", "0.0.0-canary.12", "0.0.0-canary.12.abcdef012", "0.0.0-canary.012.gabcdef012", "0.0.0-canary.12.gabcdef01", "0.0.0-canary.12.gABCDEF012", "0.0.0-pr12.gabcdef012", "1.0.0-canary.12.gabcdef012", "0.0.0-canary.12.gabcdef012+meta", " 0.0.0-canary.12.gabcdef012", undefined, null, 12, ["0.0.0-canary.12.gabcdef012"], { toString: () => "0.0.0-canary.12.gabcdef012" }];
    for (const v of refused) expect(() => assertCanaryVersion(v), JSON.stringify(v) ?? String(v)).toThrow(/not a canary version/);
    expect(refused.length).toBeGreaterThan(10);
  });
});

describe("withVersion (the runner's package.json, edited and nothing else)", () => {
  const text = readFileSync(manifestFile, "utf8");
  const V = "0.0.0-canary.5.g0123abcde";

  it("changes the version and no other field, keeps their order and the file's shape", () => {
    const out = withVersion(text, V);
    const before = JSON.parse(text) as Record<string, unknown>;
    const after = JSON.parse(out) as Record<string, unknown>;
    expect(after.version).toBe(V);
    expect(before.version).not.toBe(V);
    expect({ ...after, version: before.version }).toEqual(before);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(out.split("\n").length).toBe(text.split("\n").length);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("a second call with the same version is the same bytes; a different version replaces, never accumulates", () => {
    const once = withVersion(text, V);
    expect(withVersion(once, V)).toBe(once);
    const other = "0.0.0-canary.6.g0123abcde";
    expect(JSON.parse(withVersion(once, other)).version).toBe(other);
  });

  it("refuses a version that is not a canary, and a manifest with no version, without producing output", () => {
    for (const v of ["1.0.0", "0.1.0", "latest", ""]) expect(() => withVersion(text, v), v).toThrow(/canary/);
    expect(() => withVersion(JSON.stringify({ name: "x" }), V)).toThrow(/version/);
    expect(() => withVersion("not json", V)).toThrow();
  });
});

// -------------------------------------------------------------------------------------------------------------- the tarball gate

const VERSION = "0.0.0-canary.42.gabcdef012";
const leaf = (v: unknown): string[] => (typeof v === "string" ? [v] : Object.values(v as Record<string, unknown>).flatMap(leaf));

/** The files a correct tarball holds: every target of the publish exports (a `*` filled in with a directory), as `dist/...` paths. */
const distFilesOf = (exportsMap: unknown): string[] => leaf(exportsMap).map((t) => t.slice(2).replace("*", "alpha/beta"));

type Manifest = { name: string; version: string; exports: unknown } & Record<string, unknown>;
const goodManifest = (): Manifest => ({ name: pkg.name, version: VERSION, exports: structuredClone(pkg.publishConfig.exports) });

/** A real .tgz in the layout `pnpm pack` writes: everything under `package/`. */
function makeTarball(manifest: Manifest | string, files: string[], emptyDirs: string[] = []): string {
  const dir = fresh("pkg");
  const root = join(dir, "package");
  mkdirSync(root, { recursive: true });
  for (const d of emptyDirs) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), `// ${f}\n`);
  }
  const tgz = join(dir, "x.tgz");
  const r = spawnSync("tar", ["-czf", tgz, "-C", dir, "package"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return tgz;
}

const expectedKeys = Object.keys(pkg.exports);
const gate = (tgz: string, version = VERSION) => {
  const { manifest, files } = readTarball(tgz);
  return checkCanaryTarball({ manifest, files, expectedKeys, name: pkg.name, version });
};

describe("checkCanaryTarball (what must not reach the registry)", () => {
  it("accepts the tarball pnpm would make, and counts what it judged", () => {
    const files = distFilesOf(pkg.publishConfig.exports);
    const r = gate(makeTarball(goodManifest(), [...files, "dist/core/extra.js"]));
    // every leaf of publishConfig.exports (a `types` and a `default` per subpath; the `*` pattern counts once) is a target that was judged
    expect(r.exportTargets).toBe(leaf(pkg.publishConfig.exports).length);
    const dataKeys = expectedKeys.filter((k) => typeof pkg.publishConfig.exports[k] === "string"); // plain-string exports: one target each
    expect(dataKeys.length, "the engine declares a data export, so the arithmetic below covers it").toBeGreaterThan(0);
    expect(r.exportTargets).toBeGreaterThanOrEqual((expectedKeys.length - dataKeys.length) * 2 + dataKeys.length);
    expect(r.distFiles).toBeGreaterThanOrEqual(files.filter((f) => f.startsWith("dist/")).length); // the data exports are package-root files, not dist/ ones
    expect(r.files).toBeGreaterThan(r.distFiles); // package.json too
  });

  it("is repeatable: the same tarball judged twice gives the same answer", () => {
    const tgz = makeTarball(goodManifest(), distFilesOf(pkg.publishConfig.exports));
    expect(gate(tgz)).toEqual(gate(tgz));
  });

  it("refuses the tarball npm would make: exports that still point at ./src/*.ts (publishConfig.exports not applied)", () => {
    const m = goodManifest();
    m.exports = structuredClone(pkg.exports);
    expect(() => gate(makeTarball(m, distFilesOf(pkg.publishConfig.exports)))).toThrow(/source|src/);
  });

  it("refuses an empty dist (a build that emitted nothing packs a tarball whose exports all dangle)", () => {
    expect(() => gate(makeTarball(goodManifest(), []))).toThrow(/holds no dist\/ file/);
    expect(() => gate(makeTarball(goodManifest(), ["README.md"]))).toThrow(/holds no dist\/ file/);
    // a dist/ DIRECTORY with nothing in it is not a dist file, and neither is a file merely named for dist
    expect(() => gate(makeTarball(goodManifest(), [], ["dist"]))).toThrow(/holds no dist\/ file/);
    expect(() => gate(makeTarball(goodManifest(), ["rules/distribution.md", "src/dist/x.js", "distro.js"]))).toThrow(/holds no dist\/ file/);
  });

  it("refuses a dangling export (one dist file missing), a missing export key, and a stray export key", () => {
    const files = distFilesOf(pkg.publishConfig.exports);
    expect(() => gate(makeTarball(goodManifest(), files.filter((f) => f !== "dist/core/index.js")))).toThrow(/dangling/);
    const missing = goodManifest();
    delete (missing.exports as Record<string, unknown>)["./core"];
    expect(() => gate(makeTarball(missing, files))).toThrow(/missing/);
    const stray = goodManifest();
    (stray.exports as Record<string, unknown>)["./extra"] = { default: "./dist/core/index.js" };
    expect(() => gate(makeTarball(stray, files))).toThrow(/extra/);
  });

  it("refuses a tarball whose exports have every right key and nothing to check under them: zero targets judged is a failure, not a pass", () => {
    const hollow = goodManifest();
    // every module key an empty conditions object: no leaf for checkTarballExports to count. A data export (a plain string, valid) must not
    // make up for them: one target judged in all is still no module judged.
    hollow.exports = Object.fromEntries(expectedKeys.map((k) => [k, typeof pkg.publishConfig.exports[k] === "string" ? pkg.publishConfig.exports[k] : {}]));
    const tgz = makeTarball(hollow, distFilesOf(pkg.publishConfig.exports));
    expect(() => gate(tgz)).toThrow(/checked nothing/);
    const r = run(["check", tgz, VERSION]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/checked nothing/);
    expect(expectedKeys.length).toBeGreaterThan(10);
  });

  it("refuses a tarball with the wrong name or a version that is not the one derived for this run", () => {
    const files = distFilesOf(pkg.publishConfig.exports);
    expect(() => gate(makeTarball({ ...goodManifest(), name: "@seazn/engine" }, files))).toThrow(/@seazn\/engine/);
    expect(() => gate(makeTarball({ ...goodManifest(), version: pkg.version }, files))).toThrow(/version/);
    expect(() => gate(makeTarball(goodManifest(), files), "0.0.0-canary.43.gabcdef012")).toThrow(/version/);
    expect(() => gate(makeTarball(goodManifest(), files), "1.0.0")).toThrow(/not a canary version/);
    // a stable version on BOTH sides agrees with itself, which must not be enough to publish it
    expect(() => gate(makeTarball({ ...goodManifest(), version: "1.0.0" }, files), "1.0.0")).toThrow(/not a canary version/);
  });

  it("refuses a tarball with no package/package.json, a file that is not a tarball, and a path that does not exist", () => {
    const dir = fresh("empty");
    mkdirSync(join(dir, "package"));
    writeFileSync(join(dir, "package", "README.md"), "x");
    const tgz = join(dir, "x.tgz");
    spawnSync("tar", ["-czf", tgz, "-C", dir, "package"]);
    expect(() => readTarball(tgz)).toThrow(/holds no package\/package\.json/);
    const notTar = join(dir, "not.tgz");
    writeFileSync(notTar, "this is not a tarball");
    expect(() => readTarball(notTar)).toThrow();
    expect(() => readTarball(join(dir, "missing.tgz"))).toThrow();
  });
});

// ----------------------------------------------------------------------------------------------------------------------- the CLI

const run = (args: string[], env: Record<string, string> = {}, bin = join(PROOF, "canary.mjs")) =>
  spawnSync(process.execPath, [bin, ...args], { cwd: fresh("cwd"), encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

describe("canary.mjs, the command the workflow runs", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("`version` prints exactly the derived version and a newline, from GITHUB_RUN_NUMBER and GITHUB_SHA", () => {
    const r = run(["version"], { GITHUB_RUN_NUMBER: "77", GITHUB_SHA: sha });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("0.0.0-canary.77.g012345678\n");
  });

  it("`version` fails with nothing on stdout when the environment cannot give a version", () => {
    const unusable: Record<string, string>[] = [{}, { GITHUB_RUN_NUMBER: "77" }, { GITHUB_SHA: sha }, { GITHUB_RUN_NUMBER: "0", GITHUB_SHA: sha }, { GITHUB_RUN_NUMBER: "77", GITHUB_SHA: "nope" }];
    expect(unusable.length).toBe(5);
    for (const env of unusable) {
      const r = run(["version"], env);
      expect(r.status, JSON.stringify(env)).toBe(1);
      expect(r.stdout, JSON.stringify(env)).toBe("");
      expect(r.stderr, JSON.stringify(env)).toMatch(/^canary: /);
    }
  });

  it("`check` exits 0 and prints the counts for a good tarball, and exits 1 naming the reason for each bad one", () => {
    const files = distFilesOf(pkg.publishConfig.exports);
    const good = run(["check", makeTarball(goodManifest(), files), VERSION]);
    expect(good.status).toBe(0);
    expect(good.stdout).toMatch(/^canary tarball ok: \d+ files, \d+ under dist\/, \d+ export targets\n$/);

    const npmMade = goodManifest();
    npmMade.exports = structuredClone(pkg.exports);
    for (const [tgz, version, why] of [
      [makeTarball(npmMade, files), VERSION, /source|src/],
      [makeTarball(goodManifest(), []), VERSION, /holds no dist\/ file/],
      [makeTarball(goodManifest(), files), "0.0.0-canary.43.gabcdef012", /version/],
    ] as const) {
      const r = run(["check", tgz, version]);
      expect(r.status, String(why)).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(why);
    }
  });

  it("`check` judges the tarball against the WORKSPACE's name and export keys, not against what the tarball says about itself", () => {
    const files = distFilesOf(pkg.publishConfig.exports);
    const renamed = run(["check", makeTarball({ ...goodManifest(), name: "@seazn/engine" }, files), VERSION]);
    expect(renamed.status).toBe(1);
    expect(renamed.stderr).toMatch(/@seazn\/engine/);
    const fewer = goodManifest();
    delete (fewer.exports as Record<string, unknown>)["./core"];
    const lacking = run(["check", makeTarball(fewer, files), VERSION]);
    expect(lacking.status).toBe(1);
    expect(lacking.stderr).toMatch(/missing/);
  });

  it("`set-version` rewrites only the version of the manifest NEXT TO the script's directory (run on a scratch copy of the tool, never the real manifest)", () => {
    // canary.mjs resolves ../package.json from its own location, so a copy of the three files beside a copy of the manifest is the real CLI path
    const engine = fresh("engine-copy");
    mkdirSync(join(engine, "pack-proof"));
    for (const f of ["canary.mjs", "canary-lib.mjs", "lib.mjs"]) cpSync(join(PROOF, f), join(engine, "pack-proof", f));
    cpSync(manifestFile, join(engine, "package.json"));
    const bin = join(engine, "pack-proof", "canary.mjs");

    const ok = run(["set-version", "0.0.0-canary.9.g0123abcde"], {}, bin);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    const edited = JSON.parse(readFileSync(join(engine, "package.json"), "utf8")) as { version: string };
    expect(edited.version).toBe("0.0.0-canary.9.g0123abcde");

    const before = readFileSync(join(engine, "package.json"), "utf8");
    const refused = run(["set-version", "1.0.0"], {}, bin);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/canary/);
    expect(readFileSync(join(engine, "package.json"), "utf8")).toBe(before);
    // and the committed manifest is untouched by all of this
    expect((JSON.parse(readFileSync(manifestFile, "utf8")) as { version: string }).version).toBe(pkg.version);
  });

  it("usage errors exit 2: no command, an unknown command, a missing or extra argument", () => {
    for (const args of [[], ["publish"], ["constructor"], ["__proto__"], ["toString"], ["set-version"], ["check", "only-one"], ["version", "extra"], ["check", "a", "b", "c"], ["set-version", "a", "b"]]) {
      const r = run(args, { GITHUB_RUN_NUMBER: "1", GITHUB_SHA: sha });
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toMatch(/usage/i);
    }
  });
});
