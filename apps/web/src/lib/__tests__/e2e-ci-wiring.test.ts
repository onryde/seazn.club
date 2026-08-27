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
  // Playwright matches against the file's ABSOLUTE path, so a pattern may be
  // anchored on a directory (`/e2e/walkthrough/`) and not merely a basename.
  // `file` arrives relative to e2e/, so put the segment back before testing —
  // otherwise a directory-anchored pattern silently matches nothing here and
  // this guard reports selection that the real runner does not perform.
  const path = `/e2e/${file}`;
  if (asRegExps(project.testIgnore).some((re) => re.test(path))) return false;
  const match = asRegExps(project.testMatch);
  return match.length === 0 ? DEFAULT_TEST_MATCH.test(path) : match.some((re) => re.test(path));
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
  // RECURSIVE, and returns paths RELATIVE TO e2e/ — both load-bearing since
  // the walkthrough specs moved into e2e/walkthrough/.
  //
  // A bare `readdirSync` does not descend, so every spec in a subdirectory
  // becomes invisible to `orphans` below and this guard goes green while
  // those specs run nowhere — which is the exact failure it exists to catch,
  // reintroduced by a directory move rather than a config edit. And the paths
  // must stay relative rather than bare basenames, because a project that
  // selects or ignores a DIRECTORY (`/walkthrough\//`) can only be tested
  // against a path that still contains it.
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        : entry.name.endsWith(".spec.ts")
          ? [`${prefix}${entry.name}`]
          : [],
    );
  return walk(E2E_DIR, "").sort();
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
    const walkthrough = projectNamed(unset, "walkthrough");
    const mobile = unset.projects.filter((p) => p.name?.startsWith("mobile-") || p.name?.startsWith("tablet-"));

    const orphans = specFiles().filter(
      (file) =>
        !selects(heavy, file) &&
        !selects(rest, file) &&
        !selects(serial, file) &&
        !selects(walkthrough, file) &&
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

    // The partition covers the parallel project only. The walkthrough specs
    // are ignored by all three slices and belong to their own project — if
    // they ever leak back in they would run twice, once here and once there.
    expect(files.filter((f) => f.startsWith("walkthrough/")).filter((f) => selects(whole, f))).toEqual([]);
  });

  it("gives the walkthrough specs a project of their own, and it is not empty", async () => {
    // These are the suite's product-level proofs — a whole match played by
    // hand through the decider. They are also the specs most likely to be
    // moved or renamed, and a walkthrough project that selects nothing is
    // indistinguishable from a green one.
    const unset = await configFor(undefined);
    const walkthrough = projectNamed(unset, "walkthrough");
    const selected = specFiles().filter((f) => selects(walkthrough, f));
    expect(selected.length, "the walkthrough project selects no specs at all").toBeGreaterThan(0);
    expect(
      selected.every((f) => f.startsWith("walkthrough/")),
      "the walkthrough project selected something outside e2e/walkthrough/",
    ).toBe(true);
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
    // A project declared in the config but never dispatched runs nowhere —
    // the same orphan defect one level up, at the workflow rather than the
    // spec. The matrix carries the project name per leg for this reason.
    expect(yml, "e2e.yml dispatches no walkthrough leg").toContain("project: walkthrough");
    expect(yml, "the matrix must pass its project through to Playwright").toContain("--project=${{ matrix.project }}");
    // The two "rest" legs shard between themselves; the heavy leg does not.
    expect(yml).toContain("--shard=1/2");
    expect(yml).toContain("--shard=2/2");
  });

  // RS007. The Connect walkthrough is the ONLY place in the suite that
  // genuinely produces `checkout.session.completed`, and it can only do so
  // with a real key AND a webhook forwarder — the webhook is registrations'
  // sole fulfilment path, so without a forwarder a paid entry stays `pending`.
  // Both halves are asserted here because either one missing degrades the leg
  // to a silent skip, which reads in the summary exactly like a leg that ran.
  it("wires the Connect walkthrough's real key and its webhook forwarder", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8");

    // Comments are NOT stripped here, unlike the slice test above: this
    // assertion is about wiring that only the walkthrough leg may receive, and
    // the surrounding prose is what stops the next reader handing the real key
    // to every leg.
    expect(
      yml,
      "the walkthrough leg no longer receives a real STRIPE_SECRET_KEY — the Connect walkthrough cannot reach checkout.stripe.com with the dummy",
    ).toContain("matrix.project == 'walkthrough' && secrets.STRIPE_SECRET_KEY");
    expect(
      yml,
      "STRIPE_CONNECT_TEST_ACCOUNT is not wired — a fabricated account id is rejected by Stripe as a transfer destination",
    ).toContain("STRIPE_CONNECT_TEST_ACCOUNT");
    expect(
      yml,
      "no `stripe listen` forwarder — without it a paid entry stays `pending` and the spec fails at the webhook wait",
    ).toContain("stripe listen");
    // The forwarder must publish the session's own secret to LATER steps: the
    // server reads STRIPE_WEBHOOK_SECRET at boot, so a forwarder started after
    // it, or one that never exports, silently verifies against the wrong key.
    expect(
      yml,
      "the forwarder does not export STRIPE_WEBHOOK_SECRET to subsequent steps",
    ).toContain('echo "STRIPE_WEBHOOK_SECRET=$secret" >> "$GITHUB_ENV"');
    expect(
      yml,
      "nothing enables CONNECT_WALKTHROUGH, so the spec skips even when the secrets are present",
    ).toContain("CONNECT_WALKTHROUGH=1");
    // A missing secret must ANNOUNCE that the money path went unexercised,
    // rather than leaving a green leg that proves nothing about fulfilment.
    expect(
      yml,
      "an unconfigured Connect walkthrough skips silently — no ::warning:: telling the reader the money path was not exercised",
    ).toMatch(/::warning::Connect walkthrough NOT run/);
  });

  // The spec moved out of e2e/ into e2e/walkthrough/ (RS007). The project is
  // directory-anchored, so the move is what enrols it — but a rename or a
  // revert would leave the wiring above pointing at nothing.
  it("keeps the Connect walkthrough inside the walkthrough project", async () => {
    const { default: unset } = await import("../../../playwright.config");
    const walkthrough = projectNamed(unset, "walkthrough");
    const selected = specFiles().filter((f) => selects(walkthrough, f));
    expect(
      selected,
      "registration-connect.spec.ts is not selected by the walkthrough project",
    ).toContain("walkthrough/registration-connect.spec.ts");
  });
});
