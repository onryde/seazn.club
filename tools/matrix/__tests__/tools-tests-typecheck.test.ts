// W1d Task 10 (item 7, D9): `tsconfig.scripts.json` excludes every `*.test.ts`
// (they run under vitest, not strip-types), so a type error in a test reached
// main — five did. `tsconfig.tools-tests.json` is the config that checks them,
// and ci.yml's gates job runs `tsc -p` on it (ci-wiring.test.ts pins that step).
//
// This file proves the config's REACH, not the type-check itself: a full `tsc -p`
// inside the unit step would repeat the gates step's minutes against this step's
// timeout (review m12). `--listFilesOnly` resolves the same file set without
// checking it, in seconds. A config whose `include` silently dropped a tree would
// type-check nothing there and still exit 0, so every tracked test is looked up.
// Single-sport reason: no sport is involved — this is a file-set guard.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSC = resolve(REPO, "node_modules/typescript-native/bin/tsc");
const ESLINT = resolve(REPO, "node_modules/eslint/bin/eslint.js");
// tsc resolves the whole program: seconds when idle, longer under a loaded machine.
const LISTING_MS = 120_000;

/** Every tracked file matching a git pathspec (a pathspec `*` crosses `/`, so `a/*.test.ts` is recursive). */
const tracked = (pathspec: string) =>
  spawnSync("git", ["ls-files", pathspec], { cwd: REPO, encoding: "utf8" }).stdout.split("\n").filter(Boolean);

/** What the config's program contains, as repo-relative paths. One listing serves every case. */
let listing: { status: number | null; stderr: string; listed: Set<string> } | null = null;
function listFiles() {
  if (listing === null) {
    const r = spawnSync(process.execPath, [TSC, "-p", "tsconfig.tools-tests.json", "--listFilesOnly"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    listing = {
      status: r.status,
      stderr: r.stderr,
      listed: new Set(r.stdout.split("\n").map((f) => f.trim()).filter(Boolean).map((f) => relative(REPO, f))),
    };
  }
  return listing;
}

describe("tsconfig.tools-tests.json reach (W1d Task 10, item 7 D9)", () => {
  it("covers every tracked matrix test and every tracked scripts test, counted separately (review m13)", () => {
    const l = listFiles();
    expect(l.status, l.stderr).toBe(0);
    const matrix = tracked("tools/matrix/__tests__/*.test.ts");
    const scripts = tracked("scripts/*.test.ts");
    // anti-vacuity: each tree has tests, counted on its own so one tree's count cannot cover the other's
    expect(matrix.length).toBeGreaterThan(0);
    expect(scripts.length).toBeGreaterThan(0);
    for (const f of [...matrix, ...scripts]) expect(l.listed.has(f), `${f} is not in tsconfig.tools-tests.json's program`).toBe(true);
  }, LISTING_MS);

  it("…and none of bench's TESTS (bench's lib is allowed: HM/run.ts imports it, R3; review I7)", () => {
    const l = listFiles();
    expect(l.status, l.stderr).toBe(0);
    const benchTests = tracked("tools/bench/*.test.ts");
    // a negative needs its positive pair: bench has tests, and they are what is shown absent
    expect(benchTests.length).toBeGreaterThan(0);
    for (const f of benchTests) expect(l.listed.has(f), `${f} must stay out of the tools-tests program`).toBe(false);
    // and nothing else of bench's that is a test or lives in a `__tests__` directory
    expect([...l.listed].filter((f) => /^tools\/bench\//.test(f) && /\.test\.ts$|\/__tests__\//.test(f))).toEqual([]);
  }, LISTING_MS);

  // The declaration file is only checked where something imports a name from it, and tools-import-guard.test.ts
  // hands `TOOLS_PACKAGES` to `expect(...)`, which takes anything, so a wrong or missing declaration passes tsc.
  // The runtime module is the authority for what exists and what kind of value each export is.
  it("scripts/lib/tools-import-guard.d.mts declares exactly the .mjs's exports, each as the runtime value's kind", async () => {
    const real = Object.entries(await import("../../../scripts/lib/tools-import-guard.mjs"));
    expect(real.length).toBeGreaterThan(0);
    const dts = readFileSync(resolve(REPO, "scripts/lib/tools-import-guard.d.mts"), "utf8");
    const declared = new Map([...dts.matchAll(/^export const (\w+): ([^\n]*)$/gm)].map((m) => [m[1]!, m[2]!.trim()] as const));
    expect([...declared.keys()].sort()).toEqual(real.map(([name]) => name).sort());
    for (const [name, value] of real) {
      const kind = Array.isArray(value) ? "string[];" : typeof value === "string" ? "string;" : "{";
      if (Array.isArray(value)) expect(value.every((v) => typeof v === "string"), `${name} holds only strings`).toBe(true);
      expect(declared.get(name), `${name}'s declared type`).toBe(kind);
    }
  });

  // scripts/lib/tools-import-guard.d.mts types the guard's .mjs for the type-check above. typescript-eslint's
  // base config matches every `*.mts`, so `eslint scripts` (the lint:scripts gate) picks the declaration file
  // up too, and without a block that turns typed rules off for it ESLint CRASHES on it rather than reporting.
  it("every tracked scripts/ declaration file is linted by `eslint scripts/lib` (the lint:scripts path) without a crash", () => {
    const decls = tracked("scripts/*.d.mts");
    expect(decls.length).toBeGreaterThan(0);
    const r = spawnSync(process.execPath, [ESLINT, "-f", "json", "scripts/lib"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr.slice(0, 600)).toBe(0);
    const results = JSON.parse(r.stdout) as { filePath: string; errorCount: number }[];
    const linted = new Set(results.map((x) => relative(REPO, x.filePath)));
    for (const f of decls) expect(linted.has(f), `${f} was not linted`).toBe(true);
    expect(results.reduce((n, x) => n + x.errorCount, 0)).toBe(0);
  }, LISTING_MS);
});
