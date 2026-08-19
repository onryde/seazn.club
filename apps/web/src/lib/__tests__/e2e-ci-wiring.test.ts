// Two properties of e2e.yml that fail SILENTLY, which is why they are pinned
// here rather than left to review.
//
// 1. A job with no `timeout-minutes` inherits GitHub's 360-minute default. It
//    does not go red, it does not look wrong in the YAML, and it is invisible
//    until the bill arrives: over the 100 runs to 2026-08-19, fifteen e2e jobs
//    ran past thirty minutes and burned 46% of this workflow's entire runner
//    time, five of them going the full 360 (runs 32157900228, 32084592754).
//
// 2. The `parallel` project is now split across three jobs by
//    E2E_PARALLEL_SLICE instead of `--shard=N/3`. The split is only safe
//    because "rest" is a CATCH-ALL — it ignores PARALLEL_HEAVY and nothing
//    else, so a new spec file joins the sharded remainder on its own. Rewrite
//    it as explicit per-shard file lists and a new spec runs in NO job, which
//    reports as neither a pass nor a failure but as silence. Same failure mode
//    the sibling db-suite-ci-wiring.test.ts exists to catch, one file over.
//
// Pure: no DB, no network, no browser. Runs in every job and can never
// self-skip, which is the property that makes a guard worth having.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Repo root: up out of __tests__ / lib / src / web / apps. */
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const E2E_YML = join(REPO_ROOT, ".github/workflows/e2e.yml");
const WARM_YML = join(REPO_ROOT, ".github/workflows/e2e-cache-warm.yml");
const PW_CONFIG = join(REPO_ROOT, "apps/web/playwright.config.ts");

/**
 * YAML with its COMMENTS removed, for the same reason the db/redis guards
 * strip them: this workflow's prose is unusually long and names almost every
 * token these assertions look for — `--with-deps`, `timeout-minutes`,
 * `scorepad-v3-cricket`, the removed Next.js cache step. A raw substring
 * search over the file would be satisfied by the commentary alone, so deleting
 * the executable line would leave the guard green.
 *
 * YAML's actual comment rule (`#` at line start or after whitespace), so a `#`
 * inside a quoted command survives.
 */
const stripComments = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

/**
 * Comment-stripped YAML split into one block per job. A job is a two-space
 * key under `jobs:`; its body runs to the next such key.
 */
function jobBlocks(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  let started = false;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      current = header[1];
      out[current] = "";
      continue;
    }
    if (current) out[current] += line + "\n";
  }
  return out;
}

const e2eText = () => stripComments(readFileSync(E2E_YML, "utf8"));
const configText = () => readFileSync(PW_CONFIG, "utf8");

describe("e2e.yml jobs cannot run away", () => {
  it("splits e2e.yml into the three jobs this guard reads", () => {
    // Vacuity guard on the reader itself. If jobBlocks silently returned {},
    // every assertion below would pass against an empty set.
    const jobs = jobBlocks(e2eText());
    expect(Object.keys(jobs).sort()).toEqual(["e2e-mobile", "e2e-parallel", "e2e-serial"]);
  });

  it("gives every job an explicit timeout-minutes", () => {
    const jobs = jobBlocks(e2eText());
    const untimed = Object.entries(jobs)
      .filter(([, block]) => !/(^|\n)\s{4}timeout-minutes:\s*\d+/.test(block))
      .map(([name]) => name);
    expect(
      untimed,
      `no timeout-minutes, so these inherit GitHub's 360-minute default and a ` +
        `hung Playwright run bills six hours of a 4-vCPU runner: ${untimed.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps those timeouts well above a real run and well under the default", () => {
    // p95 job is ~7 minutes; 360 is the thing being defended against. A
    // timeout inside the p95 would turn a slow run into a red one.
    const found = [...e2eText().matchAll(/\n\s{4}timeout-minutes:\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(found.length).toBe(3);
    for (const t of found) {
      expect(t).toBeGreaterThanOrEqual(15);
      expect(t).toBeLessThanOrEqual(60);
    }
  });

  it("catches a job that declares a timeout only in a comment", () => {
    // The false negative a plain "the file mentions timeout-minutes" check
    // would allow, on a fixture so it asserts the RULE and not today's file.
    const fixture = ["jobs:", "  e2e-parallel:", "    # timeout-minutes: 20", "    steps: []"].join(
      "\n",
    );
    expect(fixture).toContain("timeout-minutes");
    const block = jobBlocks(stripComments(fixture))["e2e-parallel"];
    expect(/(^|\n)\s{4}timeout-minutes:\s*\d+/.test(block)).toBe(false);
  });
});

describe("the parallel project's three legs cover all of it", () => {
  it("reads a config that still branches on E2E_PARALLEL_SLICE", () => {
    // Vacuity guard on the other half of the pairing. If the config stopped
    // using the env var, e2e.yml's `slice:` values would be inert and every
    // leg would silently run the WHOLE project — three times.
    const cfg = configText();
    expect(cfg).toMatch(/process\.env\.E2E_PARALLEL_SLICE/);
    expect(cfg).toMatch(/PARALLEL_SLICE === "heavy"/);
    expect(cfg).toMatch(/PARALLEL_SLICE === "rest"/);
  });

  it("runs exactly the slices the config understands", () => {
    const slices = [...e2eText().matchAll(/\n\s+slice:\s*(\S+)/g)].map((m) => m[1]);
    // Two "rest" legs sharded 1/2 and 2/2, one "heavy" leg for the carve-out.
    expect(slices.sort()).toEqual(["heavy", "rest", "rest"]);
  });

  it("shards the rest over exactly as many legs as there are rest legs", () => {
    // --shard=N/2 with three rest legs, or with one, silently drops or repeats
    // tests. Tie the denominator to the leg count rather than to the literal.
    const text = e2eText();
    const restLegs = [...text.matchAll(/\n\s+slice:\s*rest/g)].length;
    const shards = [...text.matchAll(/--shard=(\d+)\/(\d+)/g)];
    expect(shards.length).toBe(restLegs);
    expect(shards.map((m) => Number(m[2]))).toEqual(Array(restLegs).fill(restLegs));
    expect(shards.map((m) => Number(m[1])).sort()).toEqual(
      Array.from({ length: restLegs }, (_, i) => i + 1),
    );
  });

  it("keeps 'rest' a catch-all, so a new spec file cannot be orphaned", () => {
    // THE property this split rests on. `rest` must exclude the heavy
    // carve-out and nothing else — any additional exclusion, or a switch to
    // explicit per-shard file lists, means a newly added spec belongs to no
    // leg and runs nowhere.
    const cfg = configText();
    const restIgnores = cfg.match(/PARALLEL_SLICE === "rest" \? \[([^\]]*)\] : \[\]/);
    expect(restIgnores, "the 'rest' slice no longer ignores a single named constant").not.toBeNull();
    expect(restIgnores![1].trim()).toBe("PARALLEL_HEAVY");
  });

  it("carves out only real spec files", () => {
    const heavy = configText().match(/const PARALLEL_HEAVY = \/\(?([^)/]+)\)?\\\.spec\\\.ts\//);
    expect(heavy, "PARALLEL_HEAVY is no longer an alternation of spec-file stems").not.toBeNull();
    const stems = heavy![1].split("|");
    expect(stems.length).toBeGreaterThan(0);
    for (const stem of stems) {
      // A typo here does not fail anything on its own: the heavy leg simply
      // runs fewer tests than it thinks and goes green, while the misnamed
      // file falls into "rest" and the balance this split exists for is lost.
      expect(
        readFileSync(join(REPO_ROOT, "apps/web/e2e", `${stem}.spec.ts`), "utf8").length,
        `PARALLEL_HEAVY names ${stem}.spec.ts, which does not exist`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("the Playwright browser cache has exactly one writer", () => {
  it("never lets a PR job save the key", () => {
    // A save in e2e.yml puts the cache back in the PR's own ref scope, where
    // no other branch can read it, and puts all seven jobs back in the save
    // race. Restores are fine; saves are not.
    const text = e2eText();
    // `(?!\s+uses:)` stops the scan at the next step. Without it the match
    // starts at the *Flyway* cache step above and runs on to the Playwright
    // key, reporting the wrong step's action — which is exactly what the
    // first version of this assertion did.
    const pwSteps = [
      ...text.matchAll(
        /uses: actions\/cache(\/restore)?@v4\n(?:(?!\s+uses:).*\n)*?\s+key: playwright-[^\n]*/g,
      ),
    ];
    expect(pwSteps.length).toBe(3);
    for (const step of pwSteps) {
      expect(step[1], "e2e.yml must RESTORE the Playwright cache, never save it").toBe("/restore");
    }
  });

  it("warms that exact key on main", () => {
    // Key and path must match byte for byte or the warm job fills a cache
    // nobody reads — a failure that looks like nothing at all.
    const warm = stripComments(readFileSync(WARM_YML, "utf8"));
    const key = "key: playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}";
    expect(warm).toContain(key);
    expect(warm).toContain("path: ~/.cache/ms-playwright");
    expect(warm).toMatch(/uses: actions\/cache@v4/);
    expect(e2eText().split(key).length - 1).toBe(3);
  });

  it("stops paying apt for dependencies the runner image already has", () => {
    // `--with-deps` installed nothing on this image on run 32272599493 —
    // every package came back "is already the newest version" — while still
    // running a full apt-get update in all seven jobs.
    expect(e2eText()).not.toContain("--with-deps");
    expect(stripComments(readFileSync(WARM_YML, "utf8"))).not.toContain("--with-deps");
  });
});
