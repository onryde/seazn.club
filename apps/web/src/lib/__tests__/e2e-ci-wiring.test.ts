// A Playwright spec that no CI project selects is not coverage — it is a file
// that goes green by never running.
//
// `playwright.config.ts` has claimed since #597 that "apps/web/src/lib/
// __tests__/e2e-ci-wiring.test.ts pins that property". IT DID NOT EXIST. The
// claim was written beside the carve-out it describes and read as true by
// every session since; R3/task D found it while confirming a new spec joins a
// CI project that actually runs. This file is that pin, written to the
// properties the config's own comment asserts.
//
// WHAT CAN GO WRONG, and why each is worth a test rather than a comment:
//
//  1. `e2e.yml` runs the `parallel` project as THREE jobs — one "heavy" leg
//     naming a handful of expensive files, and two "rest" legs sharding
//     everything else. "rest" is a CATCH-ALL by construction (it ignores
//     PARALLEL_HEAVY and nothing else), which is the ONLY reason a new spec
//     file joins CI without anybody editing a list. Turn that into three
//     explicit per-shard file lists and a new spec silently runs nowhere.
//  2. A TYPO inside PARALLEL_HEAVY costs nothing visible: the heavy leg simply
//     selects fewer files and passes, while the mistyped file runs on the
//     "rest" legs it was carved out of for being slow. The balance the carve-
//     out exists for quietly stops holding.
//  3. A spec added to `SERIAL_SPECS` but never removed from the parallel
//     project's ignore list — or vice versa — is either run twice against
//     shared org state or not at all.
//
// Sibling of db-suite-ci-wiring.test.ts / redis-suite-ci-wiring.test.ts and
// deliberately the same shape: pure (no DB, no network, no browser), so it
// runs in every job and can never self-skip — the property that makes a
// wiring guard worth having at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** apps/web — this file lives at apps/web/src/lib/__tests__/. */
const WEB = resolve(import.meta.dirname, "../../..");
const E2E_DIR = join(WEB, "e2e");
const REPO_ROOT = resolve(WEB, "../..");

type Pattern = RegExp | string | (RegExp | string)[] | undefined;

interface ProjectLike {
  name?: string;
  testMatch?: Pattern;
  testIgnore?: Pattern;
}

function asRegExps(pattern: Pattern): RegExp[] {
  if (pattern === undefined) return [];
  const list = Array.isArray(pattern) ? pattern : [pattern];
  return list.map((p) => (p instanceof RegExp ? p : new RegExp(p)));
}

/**
 * Playwright's own file selection, applied to a bare filename.
 *
 * `testMatch` ABSENT is not the same as `testMatch: undefined` handed to the
 * runner — the config spreads the key in conditionally for exactly that
 * reason — and an absent one falls back to the runner's default, which is what
 * makes "rest" a catch-all. Reimplemented here rather than driving the real
 * runner because the whole point is to check the CONFIG's selection, in a pure
 * unit test that needs no browser and no server.
 */
const DEFAULT_TEST_MATCH = /\.(spec|test)\.[cm]?[jt]sx?$/;

function selects(project: ProjectLike, file: string): boolean {
  if (asRegExps(project.testIgnore).some((re) => re.test(file))) return false;
  const match = asRegExps(project.testMatch);
  return match.length === 0 ? DEFAULT_TEST_MATCH.test(file) : match.some((re) => re.test(file));
}

/** The config is built at MODULE EVALUATION from `process.env
 *  .E2E_PARALLEL_SLICE`, so each slice needs its own fresh evaluation. */
async function configFor(slice: string | undefined): Promise<{ projects: ProjectLike[] }> {
  vi.resetModules();
  if (slice === undefined) vi.stubEnv("E2E_PARALLEL_SLICE", "");
  else vi.stubEnv("E2E_PARALLEL_SLICE", slice);
  // An empty string is falsy for the config's `=== "heavy"` / `=== "rest"`
  // comparisons, which is exactly the unset behaviour, but delete it outright
  // so the unset case is genuinely unset.
  if (slice === undefined) delete process.env.E2E_PARALLEL_SLICE;
  const mod = (await import("../../../playwright.config")) as { default: { projects: ProjectLike[] } };
  return mod.default;
}

function projectNamed(config: { projects: ProjectLike[] }, name: string): ProjectLike {
  const found = config.projects.find((p) => p.name === name);
  if (!found) throw new Error(`playwright.config.ts declares no "${name}" project`);
  return found;
}

/** Every e2e spec file, by bare filename. `auth.setup.ts` and
 *  `gallery.capture.ts` are deliberately NOT specs — neither carries
 *  `spec`/`test` in its name, which is how the default `testMatch` keeps the
 *  gallery harness from ever being selected by accident. */
function specFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("e2e CI wiring", () => {
  it("has spec files to check at all", () => {
    // Guards the guard: an empty list would make every assertion below
    // vacuously true, which is the failure mode a directory rename produces.
    expect(specFiles().length).toBeGreaterThan(50);
  });

  it("runs every spec file in at least one CI leg", async () => {
    // The three legs e2e.yml actually dispatches for `--project=parallel`,
    // plus the two projects it runs whole.
    const heavy = projectNamed(await configFor("heavy"), "parallel");
    const rest = projectNamed(await configFor("rest"), "parallel");
    const unset = await configFor(undefined);
    const serial = projectNamed(unset, "serial");
    const mobile = unset.projects.filter((p) => p.name?.startsWith("mobile-") || p.name?.startsWith("tablet-"));

    const orphans = specFiles().filter(
      (file) =>
        !selects(heavy, file) &&
        !selects(rest, file) &&
        !selects(serial, file) &&
        !mobile.some((p) => selects(p, file)),
    );
    expect(orphans, "a spec no CI leg selects runs nowhere and can never fail").toEqual([]);
  });

  it("splits the parallel project into heavy + rest with nothing lost and nothing run twice", async () => {
    const whole = projectNamed(await configFor(undefined), "parallel");
    const heavy = projectNamed(await configFor("heavy"), "parallel");
    const rest = projectNamed(await configFor("rest"), "parallel");
    const files = specFiles();

    const inWhole = files.filter((f) => selects(whole, f));
    const inHeavy = files.filter((f) => selects(heavy, f));
    const inRest = files.filter((f) => selects(rest, f));

    // The split is a PARTITION of the unsliced project: their union is it, and
    // their intersection is empty. Either half failing means CI runs something
    // twice or not at all, while a local `npm run test:e2e` still looks right.
    expect([...inHeavy, ...inRest].sort()).toEqual(inWhole);
    expect(inHeavy.filter((f) => inRest.includes(f))).toEqual([]);
    expect(inHeavy.length).toBeGreaterThan(0);
  });

  it("names only REAL files in the heavy carve-out", async () => {
    const heavy = projectNamed(await configFor("heavy"), "parallel");
    const sources = asRegExps(heavy.testMatch).map((re) => re.source);
    expect(sources, "the heavy slice must carve out by an explicit testMatch").toHaveLength(1);

    // `(a|b|c)\.spec\.ts` — the alternation is the hand-maintained half, so
    // this is where a typo lands. A mistyped name costs nothing visible
    // otherwise: the heavy leg just selects fewer files and goes green.
    const alternation = /\(([^)]+)\)/.exec(sources[0]!);
    expect(alternation, `unexpected PARALLEL_HEAVY shape: ${sources[0]}`).not.toBeNull();
    const named = alternation![1]!.split("|");
    const present = specFiles();
    for (const name of named) {
      expect(present, `PARALLEL_HEAVY names "${name}.spec.ts", which does not exist`).toContain(`${name}.spec.ts`);
    }

    // And the leg must actually select one file per name — a regex that parses
    // but matches nothing is the same defect wearing a different hat.
    expect(present.filter((f) => selects(heavy, f))).toHaveLength(named.length);
  });

  it("is dispatched by e2e.yml with exactly the slices this config understands", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8")
      // YAML comments stripped: the workflow's own prose names "heavy" and
      // "rest" in the block above the matrix, so a raw substring search would
      // stay green with the `slice:` keys deleted — precisely the failure this
      // exists to catch.
      .split("\n")
      .map((line) => line.replace(/(^|\s)#.*$/, ""))
      .join("\n");

    expect(yml, "e2e.yml must still pass the slice through to the config").toContain("E2E_PARALLEL_SLICE");
    for (const slice of ["heavy", "rest"]) {
      expect(yml, `e2e.yml dispatches no "${slice}" leg`).toContain(`slice: ${slice}`);
    }
    // The two "rest" legs shard between themselves; the heavy leg does not.
    expect(yml).toContain("--shard=1/2");
    expect(yml).toContain("--shard=2/2");
  });
});
