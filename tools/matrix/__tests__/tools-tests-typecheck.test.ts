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

type Opts = Record<string, unknown>;

/** The flags `strict` turns on. Any one set to `false` beside `strict: true` quietly un-strictens the program. */
const STRICT_FAMILY = ["noImplicitAny", "strictNullChecks", "strictFunctionTypes", "strictBindCallApply", "strictPropertyInitialization", "noImplicitThis", "useUnknownInCatchVariables", "alwaysStrict"] as const;

/** What would make a tests type-check lenient, from the EFFECTIVE options (`tsc --showConfig`, i.e. after `extends`):
 *  `strict` not true, a member of its family switched off, or `skipLibCheck` turned ON where the config it extends
 *  has it off (a widening: library and declaration errors stop being reported). A config that is STRICTER than its
 *  base is no fault. `base` is the config this one extends, read the same way, never typed in here. */
function strictnessFaults(effective: Opts, base: Opts): string[] {
  const out: string[] = [];
  if (effective.strict !== true) out.push(`strict is ${JSON.stringify(effective.strict)}, not true`);
  for (const flag of STRICT_FAMILY) if (effective[flag] === false) out.push(`${flag} is false`);
  if (effective.skipLibCheck === true && base.skipLibCheck !== true) out.push("skipLibCheck is on, and the config it extends has it off");
  return out;
}

/** `tsc --showConfig -p <project>`'s compilerOptions: the options that program is really checked under. */
function effectiveOptions(project: string): Opts {
  const r = spawnSync(process.execPath, [TSC, "--showConfig", "-p", project], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { compilerOptions: Opts }).compilerOptions;
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

  // Task 10 carry (routed to Task 16): the root has a `typecheck:scripts` script and the new config had none, so
  // the check CI runs could not be run by name. The script is the step's own command, pinned equal to ci.yml's so
  // the two cannot drift apart (ci-wiring.test.ts pins the step's text; this pins the script to the step).
  it("package.json has a typecheck:tools-tests script, and it is the command the gates step runs", () => {
    const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    const ci = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");
    const steps = ci.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.includes("tsconfig.tools-tests.json"));
    // anti-vacuity: the step exists exactly once, so there is a command to compare against
    expect(steps).toHaveLength(1);
    const stepCommand = steps[0]!.replace(/^\s*- run:\s*/, "").trim();
    expect(stepCommand).toMatch(/^node node_modules\/typescript-native\/bin\/tsc -p tsconfig\.tools-tests\.json$/);
    expect(scripts["typecheck:tools-tests"]).toBe(stepCommand);
    // its neighbour is the same shape, so the script sits where a reader looks for it
    expect(Object.keys(scripts).indexOf("typecheck:tools-tests")).toBe(Object.keys(scripts).indexOf("typecheck:scripts") + 1);
  });

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

// Task 10 carry (routed to Task 16): the reach test above proves every test is IN the program, and nothing proved the
// program is STRICT. A flipped `strict`, a switched-off family flag or a widened `skipLibCheck` in the config keeps
// every reach assertion green and the gates step green, while the tests stop being type-checked in earnest.
describe("tsconfig.tools-tests.json strictness (W1d Task 10 carry, Task 16)", () => {
  it("the family list is the eight flags `strict` turns on (a literal, so a dropped name reds)", () => {
    expect(STRICT_FAMILY).toHaveLength(8);
  });

  it.each<[string, Opts, Opts, number]>([
    ["strict, same skipLibCheck as its base: clean", { strict: true, skipLibCheck: true }, { strict: true, skipLibCheck: true }, 0],
    ["strict, skipLibCheck off in both: clean", { strict: true }, { strict: true }, 0],
    ["a family flag set true explicitly is no fault", { strict: true, noImplicitAny: true }, { strict: true }, 0],
    ["stricter than its base on skipLibCheck (off where the base has it on) is no fault", { strict: true, skipLibCheck: false }, { strict: true, skipLibCheck: true }, 0],
    ["strict false", { strict: false, skipLibCheck: true }, { strict: true, skipLibCheck: true }, 1],
    ["strict absent (a config that lost its `extends`)", { skipLibCheck: true }, { strict: true, skipLibCheck: true }, 1],
    ["strict not a boolean", { strict: "true", skipLibCheck: true }, { strict: true, skipLibCheck: true }, 1],
    ["skipLibCheck widened: on, where its base has it off", { strict: true, skipLibCheck: true }, { strict: true }, 1],
    ["skipLibCheck widened: on, where its base has it explicitly false", { strict: true, skipLibCheck: true }, { strict: true, skipLibCheck: false }, 1],
    ["strict false and widened skipLibCheck: both named", { strict: false, skipLibCheck: true }, { strict: true }, 2],
  ])("strictnessFaults: %s", (_name, effective, base, faults) => {
    expect(strictnessFaults(effective, base)).toHaveLength(faults);
  });

  it.each(STRICT_FAMILY.map((f) => [f]))("strictnessFaults: %s switched off beside strict: true is a fault, and names the flag", (flag) => {
    expect(strictnessFaults({ strict: true, [flag]: false }, { strict: true })).toEqual([`${flag} is false`]);
  });

  it("the real config is strict and does not widen skipLibCheck over the config it extends", () => {
    const effective = effectiveOptions("tsconfig.tools-tests.json");
    const base = effectiveOptions("tsconfig.scripts.json");
    // anti-vacuity: the options were really read, from the config this file is about (bundler resolution is its own)
    expect(Object.keys(effective).length).toBeGreaterThan(5);
    expect(effective.moduleResolution).toBe("bundler");
    expect(base).not.toEqual(effective); // two different programs: the base is the scripts config, not this one again
    expect(strictnessFaults(effective, base)).toEqual([]);
  });
});
