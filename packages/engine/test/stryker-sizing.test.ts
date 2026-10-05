// W1d Task 15, T15-SIZE, and Task 20's pre-step T20-PRE (D14; rulings 66, 67): every Stryker leg is sized from Stryker's own
// mutant count and the MEASURED cost of a mutant on the hosted runner, and none is over the 200-minute split line. The counts
// come from Stryker's instrumenter (the code that writes the "Instrumented N source file(s) with M mutant(s)" line of a dry
// run), never from line counts or a typed table, and test/stryker-coverage.ts's reading of a group's `mutate` list is checked
// here against a real Stryker dry run.
//
// FORMULA AGAINST MEASURED. D14's formula assumed 10 runner-seconds per mutant: est = ceil((max(dry, 344) + mutants x 10 / 3) / 60)
// minutes at CI's concurrency of 3. T15-SIZE replaced the 10 with a LOCAL measurement (26), taken on a loaded laptop; the
// first HOSTED run (GitHub Actions run 37330725739, the probe job on ubuntu-latest, 4 vCPU, concurrency 3) measured 76.13,
// 2.9 times the local figure. The rate below is that run's, rounded up to a whole runner-second (77); it is ONE sample, on a
// file whose mutants survive 22% of the time, and it INCLUDES the time three runaway mutants cost (see the constants).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveGroup } from "../scripts/stryker-cuts.mjs";
import { STRYKER_GROUPS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "../stryker.groups.mjs";
import { groupMutants, mutantCount, mutantsOf, parseEntry, selected, type Selected } from "./stryker-coverage.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GB = 1024 ** 3;

// ---- the rulebook, typed here and never derived from the groups or the timeouts under test ---------------------------------
/** THE HOSTED MEASUREMENT: GitHub Actions run 37330725739, job "mutate probe" (ubuntu-latest, 4 vCPU, Stryker concurrency 3),
 *  the probe leg `src/scheduling/roundrobin.ts`: 134 mutants. Its log's own timestamps: the dry run (1,182 tests) started at
 *  15:12:58.28 and succeeded at 15:15:31.38, 153.1 s; the mutation phase ran from there to "Done in 59 minutes and 15 seconds"
 *  at 16:12:11.99, 3,400.6 s. (Stryker's "59 minutes and 15 seconds" is the WHOLE run, dry run included; the mutation phase
 *  alone is 3,400.6 s, which is what a per-mutant rate is taken from.) */
const HOSTED_DRY_RUN_SECONDS = 153.1;
const HOSTED_MUTATION_PHASE_SECONDS = 3400.6;
const HOSTED_CONCURRENCY = 3;
const HOSTED_PROBE_MUTANTS = 134;
/** Three of the 134 mutants were runaway loops (a counter turned `++` into `--`), which the hosted run crashed and retried twice
 *  each: about 838 runner-seconds of the 10,202 the phase cost. They are INCLUDED in the rate: a runaway mutant is part of a
 *  real leg (the engine has hundreds of counters), and one sample cannot say how many a leg holds; excluding them would give
 *  (10,202 - 838) / 131 = 71.5, and the rate is not rounded down to hide them. */
const HOSTED_RUNAWAY_RUNNER_SECONDS = 838;
/** Runner-seconds per mutant, hosted: 3,400.6 s x 3 sandboxes / 134 mutants = 76.13, up to 77. */
const RUNNER_SECONDS_PER_MUTANT = 77;
/** D14: the dry run is taken as at least this many seconds (CI's figure). The probe's hosted dry run was 153.1 s; a leg whose
 *  related tests are the whole engine runs 3,830 of them (a local dry run of the core leg: 72 s against the probe's local 42 s),
 *  which on the hosted core would be about 8 minutes: a few minutes on a leg of 3 hours, inside the timeout's 1.5 factor. */
const DRY_RUN_FLOOR_SECONDS = 344;
/** T15-SIZE: no leg's estimate may pass this many minutes. */
const SPLIT_LINE_MINUTES = 200;
/** D14: a job's timeout is its estimate times this, capped at GitHub's 300-minute limit the workflow uses. The probe's is by
 *  the same rule (T20-PRE retired its extra allowance for an unmeasured hosted rate: the rate is now measured). */
const TIMEOUT_FACTOR = 1.5;
const TIMEOUT_CAP_MINUTES = 300;
/** The probe's own run: 134 mutants (the PR self-proof, D3). */
const PROBE_MUTANTS = HOSTED_PROBE_MUTANTS;
/** The mutants no leg holds, from the committed list beside the sizing data (stryker-unscored.json). Where a cut falls INSIDE a
 *  declaration (a member cut, scripts/stryker-cuts.mjs) the container's own mutants (its object literal, its function body) are
 *  in no range, and Stryker keeps a mutant only if its WHOLE node is inside one. They CAN be mutated: the instrumenter
 *  makes them (`BlockStatement` to `{}`, `ObjectLiteral` to `{}`), and an emptied body or module object can be killed by any test
 *  or can survive; but no leg runs them, so no report ever scores them. The list names each one, file:line:mutator, so a reader
 *  of MUTATION.md can see what the floors never judge, and the count pins below are DERIVED from it: one list, no second count. */
interface Unscored { file: string; line: number; mutator: string; replacement: string; what: string }
const UNSCORED = JSON.parse(readFileSync(join(ENGINE, "stryker-unscored.json"), "utf8")) as Unscored[];
const unscoredKey = (u: { file: string; line: number; mutator: string }): string => `${u.file}:${u.line}:${u.mutator}`;
/** The list's count per file (a statement cut loses none, and every file not named is cut only by statements). */
const MEMBER_CUT_LOSS: Record<string, number> = {};
for (const u of UNSCORED) MEMBER_CUT_LOSS[u.file] = (MEMBER_CUT_LOSS[u.file] ?? 0) + 1;
/** The hosted runner mutation.yml runs on: 4 vCPUs, 16 GB. Its Stryker concurrency, by the engine's own formula. */
const CI_CONCURRENCY = strykerConcurrency({ cores: 4, memBytes: 16 * GB, workersPerSandbox: STRYKER_VITEST_WORKERS });

const estimateMinutes = (mutants: number): number => Math.ceil((DRY_RUN_FLOOR_SECONDS + (mutants * RUNNER_SECONDS_PER_MUTANT) / CI_CONCURRENCY) / 60);
/** The most mutants a leg may hold: the largest count whose estimate is still at the split line. */
const MAX_MUTANTS = Math.floor(((SPLIT_LINE_MINUTES * 60 - DRY_RUN_FLOOR_SECONDS) * CI_CONCURRENCY) / RUNNER_SECONDS_PER_MUTANT);

/** One leg's timeout fault, or null. */
function timeoutFault(leg: string, t: number, est: number): string | null {
  if (!Number.isInteger(t)) return `${leg}: timeout ${t} is not a whole number of minutes`;
  if (t < est) return `${leg}: timeout ${t} is below its estimate ${est}`;
  if (t > TIMEOUT_CAP_MINUTES) return `${leg}: timeout ${t} is above the ${TIMEOUT_CAP_MINUTES}-minute cap`;
  // not wildly above: 1.5 x the estimate, plus a minute or two of slack for the count drifting since it was written
  if (t > Math.min(TIMEOUT_CAP_MINUTES, Math.ceil(est * TIMEOUT_FACTOR) + 15)) return `${leg}: timeout ${t} is way over 1.5 x its estimate (${est})`;
  return null;
}
/** The timeouts file the rule produces from the legs' mutant counts: each leg min(300, ceil(1.5 x its estimate)), the probe too. */
function regeneratedTimeouts(byLeg: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [g, n] of Object.entries(byLeg)) out[g] = Math.min(TIMEOUT_CAP_MINUTES, Math.ceil(estimateMinutes(n) * TIMEOUT_FACTOR));
  return out;
}
const probeTimeout = (): number => regeneratedTimeouts({ probe: PROBE_MUTANTS }).probe as number;
/** What a failing timeouts test tells its author: the file to write, whole (FINAL-FIX M3: an engine refactor that moves a
 *  leg's mutant count reds an unrelated PR, and the author needs the next step, not the rule). */
const regenerateHint = (byLeg: Record<string, number>): string =>
  `regenerate: write this to packages/engine/stryker-timeouts.json (each leg is min(${TIMEOUT_CAP_MINUTES}, ceil(${TIMEOUT_FACTOR} x its estimate)), the probe too; counts from this run):\n${JSON.stringify(regeneratedTimeouts(byLeg), null, 2)}`;

/** A test that runs Stryker's instrumenter over many files: one parse of a big file is under a second, and a loaded runner
 *  is several times slower, so the budget is stated, not left at vitest's 5 s. */
const INSTRUMENT_BUDGET_MS = 120_000;

/** Each leg with its `mutate` list as Stryker reads it: the parts of a split file (`file#N`) resolved to `file:a-b`. */
const legs: [string, string[]][] = Object.keys(STRYKER_GROUPS).map((g) => [g, resolveGroup(g)]);
const RECUT = "pnpm --filter @seazn/engine mutation:recut <file> <parts> [--extra <mutants of the leg's other files>] [--open <Host,...>]";
const counts = async () => {
  const out: Record<string, number> = {};
  for (const [g, globs] of legs) out[g] = await groupMutants(ENGINE, globs);
  return out;
};

describe("the sizing rule itself, on numbers from the hosted measurement (so the tests below cannot pass on a wrong formula)", () => {
  it("the rate is the hosted run's: 3,400.6 s of mutation phase x 3 sandboxes / 134 mutants = 76.13, rounded UP to 77, crash retries included", () => {
    const perMutant = (HOSTED_MUTATION_PHASE_SECONDS * HOSTED_CONCURRENCY) / HOSTED_PROBE_MUTANTS;
    expect(perMutant).toBeCloseTo(76.13, 2);
    expect(RUNNER_SECONDS_PER_MUTANT, "rounded up, never down").toBe(Math.ceil(perMutant));
    expect(RUNNER_SECONDS_PER_MUTANT).toBe(77);
    // Stryker's "59 minutes and 15 seconds" is the whole run: the dry run's 153.1 s and the phase's 3,400.6 s are its two parts,
    // and the 1.3 s left over is the instrumenting and the runners starting before the dry run
    expect(59 * 60 + 15 - (HOSTED_DRY_RUN_SECONDS + HOSTED_MUTATION_PHASE_SECONDS)).toBeGreaterThan(0);
    expect(59 * 60 + 15 - (HOSTED_DRY_RUN_SECONDS + HOSTED_MUTATION_PHASE_SECONDS)).toBeLessThan(3);
    // the three runaway mutants are part of the 77, not taken out of it: without them the rate would be 71.5, and 77 is above that
    expect((HOSTED_MUTATION_PHASE_SECONDS * HOSTED_CONCURRENCY - HOSTED_RUNAWAY_RUNNER_SECONDS) / (HOSTED_PROBE_MUTANTS - 3)).toBeCloseTo(71.5, 1);
    expect(RUNNER_SECONDS_PER_MUTANT).toBeGreaterThan(71.5);
    // the measured cost against the local one and D14's: 77 / 26 = 2.96 (hosted is about 3x local), 77 / 10 = 7.7
    expect(RUNNER_SECONDS_PER_MUTANT / 26).toBeCloseTo(2.96, 2);
  });

  it("CI runs 3 sandboxes at once, and the largest leg is the count whose estimate is exactly the split line: 454 mutants", () => {
    expect(CI_CONCURRENCY).toBe(HOSTED_CONCURRENCY);
    // 77 runner-s / 3 = 25.67 s of wall time per mutant: 454 mutants is 11,652.7 s + the 344 s floor = 11,996.7 s = 199.9 min
    expect(MAX_MUTANTS).toBe(454);
    expect(estimateMinutes(MAX_MUTANTS)).toBe(200);
    expect(estimateMinutes(MAX_MUTANTS + 1), "one mutant more is over the line").toBe(201);
    // the probe: 134 mutants is 3,783 s = 63.06 minutes, up to 64; the rule predicts at least what the hosted run it came from took (3,553.7 s)
    expect(estimateMinutes(HOSTED_PROBE_MUTANTS)).toBe(64);
    expect(estimateMinutes(HOSTED_PROBE_MUTANTS) * 60, "the prediction covers the run it was derived from").toBeGreaterThanOrEqual(HOSTED_DRY_RUN_SECONDS + HOSTED_MUTATION_PHASE_SECONDS);
    // its timeout, by the same rule as every leg's: ceil(64 x 1.5) = 96
    expect(Math.min(TIMEOUT_CAP_MINUTES, Math.ceil(estimateMinutes(HOSTED_PROBE_MUTANTS) * TIMEOUT_FACTOR))).toBe(96);
  });
});

describe("every leg is under the 200-minute split line, from Stryker's own mutant count (T15-SIZE)", () => {
  it("no leg holds more mutants than the line allows, and no leg is empty (an empty leg measures nothing)", async () => {
    const byLeg = await counts();
    const rows = legs.map(([g]) => ({ leg: g, mutants: byLeg[g] as number, minutes: estimateMinutes(byLeg[g] as number) }));
    const table = rows.map((r) => `${r.leg}: ${r.mutants} mutants, ${r.minutes} min`).join("\n");
    expect(rows.length, "legs counted").toBe(legs.length);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.mutants === 0).map((r) => r.leg), `legs with zero mutants: cut the file again with ${RECUT}, or fix the leg's globs\n${table}`).toEqual([]);
    expect(rows.filter((r) => r.minutes > SPLIT_LINE_MINUTES).map((r) => `${r.leg} (${r.mutants} mutants, ${r.minutes} min)`), `legs over ${SPLIT_LINE_MINUTES} min: cut the file again with ${RECUT}, paste the STRYKER_SPLITS line into stryker.groups.mjs, add or drop the legs' \`file#N\` entries, re-derive stryker-timeouts.json from this table\n${table}`).toEqual([]);
    // the line is not vacuous: before the split a single file was over it (cricket.ts, 4,248 mutants)
    const whole = await mutantCount(ENGINE, "src/sports/cricket/cricket.ts", "all");
    expect(estimateMinutes(whole), "cricket.ts alone, unsplit, is over the line").toBeGreaterThan(SPLIT_LINE_MINUTES);
  }, INSTRUMENT_BUDGET_MS);

  it("splitting a file by range loses a mutant only where a cut falls inside a declaration, and the loss is exactly the mutants whose node spans a cut (T20-PRE: member cuts)", async () => {
    const files = new Map<string, Selected[]>();
    // the probe is not a home (roundrobin.ts is in a draws leg too): a PR runs it alone
    for (const [g, globs] of legs) if (g !== "probe") for (const [f, sel] of selected(ENGINE, globs)) files.set(f, [...(files.get(f) ?? []), sel]);
    let split = 0;
    let ranges = 0;
    let lost = 0;
    const lossByFile: Record<string, number> = {};
    const unscored: string[] = [];
    for (const [f, sels] of files) {
      if (sels.length === 1 && sels[0] === "all") continue;
      split++;
      const whole = await mutantsOf(ENGINE, f, "all");
      const parts: [number, number][] = [];
      for (const sel of sels) {
        expect(sel, `${f}: a split file's every owner holds ranges`).not.toBe("all");
        parts.push(...(sel as [number, number][]));
      }
      parts.sort((x, y) => x[0] - y[0]);
      let sum = 0;
      for (const range of parts) {
        sum += await mutantCount(ENGINE, f, [range]);
        ranges++;
      }
      // the expected loss, from the INSTRUMENTER's own locations of the whole file (never from the cuts): a mutant is kept only
      // when its whole node lies inside one range, so it is lost exactly when its node runs across the last line of a part
      // (`start` and `end` are 0-based lines; a range is 1-based and inclusive)
      const boundaries = parts.slice(0, -1).map(([, to]) => to);
      const spanning = whole.filter((m) => boundaries.some((b) => m.start.line + 1 <= b && m.end.line + 1 > b));
      expect(whole.length - sum, `${f}: the mutants lost are the ones whose node spans a cut`).toBe(spanning.length);
      if (spanning.length > 0) lossByFile[f] = spanning.length;
      lost += spanning.length;
      for (const m of spanning) unscored.push(unscoredKey({ file: f, line: m.start.line + 1, mutator: m.mutator }));
    }
    expect(split, "files split by range").toBeGreaterThanOrEqual(5);
    expect(ranges, "ranges summed").toBeGreaterThan(split);
    // The accepted blind spot, enumerated: a cut BETWEEN statements loses nothing (every other split file, all 8, is exact), and a
    // cut between the members of one big declaration loses the container's own mutants, the object literal or the function body
    // that holds the cut (a whole range cannot hold them: Stryker keeps a mutant only if its whole node is inside). Measured
    // 2026-10-05 on the cuts committed with this task; a file that starts losing, or loses more, must be argued here.
    expect(lossByFile).toEqual(MEMBER_CUT_LOSS);
    // and by NAME: the committed list is exactly the instrumenter's mutants that no range holds, file:line:mutator (line 1-based)
    expect(unscored.sort(), "stryker-unscored.json names exactly the mutants no leg holds").toEqual(UNSCORED.map(unscoredKey).sort());
    expect(UNSCORED.length, "the list is not empty: member cuts exist, and each one costs its container's mutants").toBeGreaterThan(0);
    expect(new Set(UNSCORED.map(unscoredKey)).size, "no mutant is listed twice").toBe(UNSCORED.length);
    expect(lost, "mutants no leg holds: as many as the list names").toBe(UNSCORED.length);
  }, INSTRUMENT_BUDGET_MS);

  it("the legs together hold every mutant of every file they select, none twice, and none lost but the member cuts' enumerated few", async () => {
    const byLeg = await counts();
    const sumLegs = legs.filter(([g]) => g !== "probe").reduce((n, [g]) => n + (byLeg[g] as number), 0);
    const files = new Set<string>();
    for (const [g, globs] of legs) if (g !== "probe") for (const f of selected(ENGINE, globs).keys()) files.add(f);
    let sumFiles = 0;
    for (const f of files) sumFiles += await mutantCount(ENGINE, f, "all");
    expect(files.size, "files the legs select").toBeGreaterThan(50);
    // none twice: the legs can only hold FEWER than the files do, and by exactly the member-cut loss (the test above derives it)
    const loss = Object.values(MEMBER_CUT_LOSS).reduce((n, x) => n + x, 0);
    expect(sumFiles - sumLegs, "the files' own mutants less the legs'").toBe(loss);
    expect(sumLegs, "the legs' mutants").toBeGreaterThan(24_000);
  }, INSTRUMENT_BUDGET_MS);
});

describe("stryker-timeouts.json covers each leg's estimate (T15-SIZE, D14)", () => {
  const timeouts = JSON.parse(readFileSync(join(ENGINE, "stryker-timeouts.json"), "utf8")) as Record<string, number>;

  it("one timeout per leg, none below its estimate, none above the 300-minute cap, and each within the factor of D14 of the estimate", async () => {
    expect(Object.keys(timeouts)).toEqual(legs.map(([g]) => g));
    const byLeg = await counts();
    const faults: string[] = [];
    let checked = 0;
    for (const [g] of legs) {
      const f = timeoutFault(g, timeouts[g] as number, estimateMinutes(byLeg[g] as number));
      if (f !== null) faults.push(f);
      checked++;
    }
    expect(checked).toBe(legs.length);
    expect(faults, `${faults.join("\n")}\n${regenerateHint(byLeg)}`).toEqual([]);
  }, INSTRUMENT_BUDGET_MS);

  it("the probe's timeout is by the same rule as every leg's, from the hosted rate: 134 mutants, 64 minutes, 96 (T20-PRE retired the 2x allowance)", () => {
    // typed from the rulebook above (ceil(64 x 1.5) = 96), never from the file under test
    expect(estimateMinutes(PROBE_MUTANTS)).toBe(64);
    expect(probeTimeout()).toBe(96);
    expect(timeouts.probe).toBe(96);
    // 96 minutes is above what the hosted run it was measured on took (59.25 min, whole run) with the install and upload around it
    expect(timeouts.probe as number).toBeGreaterThan((HOSTED_DRY_RUN_SECONDS + HOSTED_MUTATION_PHASE_SECONDS) / 60);
    expect(timeouts.probe as number).toBeLessThanOrEqual(TIMEOUT_CAP_MINUTES);
  });

  it("every timeout is the rule's value for its leg's measured count, to the minute, and the cap bites only where 1.5 x the estimate passes 300", async () => {
    const byLeg = await counts();
    const want = regeneratedTimeouts(byLeg);
    expect(Object.keys(want).length).toBe(legs.length);
    expect(timeouts, regenerateHint(byLeg)).toEqual(want);
    // the largest leg's estimate is inside the line, so 1.5 x it is under the cap: the cap is the workflow's own limit, not a clip
    const biggest = Math.max(...Object.entries(byLeg).filter(([g]) => g !== "probe").map(([, n]) => estimateMinutes(n)));
    expect(biggest).toBeLessThanOrEqual(SPLIT_LINE_MINUTES);
    expect(Math.ceil(biggest * TIMEOUT_FACTOR)).toBeLessThanOrEqual(TIMEOUT_CAP_MINUTES);
  }, INSTRUMENT_BUDGET_MS);
});

describe("a failing timeouts file tells its author what to write (FINAL-FIX M3)", () => {
  // synthetic counts, so this needs no instrumenter: one leg whose count fell (its timeout is now far over), one that grew
  // (its timeout is now below its estimate), one in band, one so large 1.5 x its estimate passes the cap, and the probe
  const byLeg = { shrunk: 120, grown: 440, steady: 300, capped: 460, probe: PROBE_MUTANTS };

  it("a map with a timeout too high, one too low, one in band and a probe below its estimate names exactly the three, and the hint it prints is a file that passes", () => {
    const ok = regeneratedTimeouts(byLeg);
    // by hand from the hosted rate's arithmetic, never from the helper: est(m) = ceil((344 + m x 77 / 3) / 60):
    // est(120) = 58, x 1.5 = 87; est(440) = 194, x 1.5 = 291; est(300) = 135, x 1.5 = 202.5, up to 203;
    // est(460) = 203, x 1.5 = 304.5, up to 305, which the 300-minute cap holds to 300; the probe 64, x 1.5 = 96
    expect(ok).toEqual({ shrunk: 87, grown: 291, steady: 203, capped: 300, probe: 96 });
    const doctored = { ...ok, shrunk: (ok.shrunk as number) + 120, grown: estimateMinutes(440) - 1, probe: estimateMinutes(PROBE_MUTANTS) - 1 };
    const faults = Object.entries(doctored).flatMap(([g, t]) => timeoutFault(g, t, estimateMinutes(byLeg[g as keyof typeof byLeg])) ?? []);
    expect(faults.map((f) => f.split(":")[0])).toEqual(["shrunk", "grown", "probe"]);
    // the hint carries the regenerated file whole, so the author pastes rather than derives
    const hint = regenerateHint(byLeg);
    expect(hint).toContain("stryker-timeouts.json");
    expect(JSON.parse(hint.slice(hint.indexOf("{")))).toEqual(ok);
    // and what it regenerates satisfies the very band that failed (anti-circular: the band is the rulebook's, not the hint's)
    const regenerated = Object.entries(ok).flatMap(([g, t]) => timeoutFault(g, t, estimateMinutes(byLeg[g as keyof typeof byLeg])) ?? []);
    expect(regenerated).toEqual([]);
    expect(Object.keys(ok).length, "legs regenerated").toBe(5);
  });
});

describe("a `file:a-b` range is 1-based and inclusive of both lines (the boundary legs are cut with it)", () => {
  it("a range of one line holds exactly the mutants that sit wholly on that line, one line either side included", async () => {
    // the file's own mutants, from the whole-file run: a single-line mutant gives a line that certainly has one
    const file = "src/scheduling/roundrobin.ts";
    const whole = await mutantsOf(ENGINE, file, "all");
    const own = whole.find((m) => m.start.line === m.end.line);
    expect(own, "roundrobin.ts has a mutant that sits on one line").toBeDefined();
    const zeroBased = own!.start.line;
    const wholly = (zero: number) => whole.filter((m) => m.start.line === zero && m.end.line === zero).length;
    let withMutants = 0;
    for (const line of [zeroBased, zeroBased + 1, zeroBased + 2]) {
      // 1-based line `line` is 0-based line `line - 1`
      expect(await mutantCount(ENGINE, file, [[line, line]]), `the range ${line}-${line}`).toBe(wholly(line - 1));
      if (wholly(line - 1) > 0) withMutants++;
    }
    expect(withMutants, "the lines checked include one that holds a mutant (the mutant's own line)").toBeGreaterThan(0);
    expect(wholly(zeroBased), "the mutant's own line is the middle one").toBeGreaterThan(0);
  }, INSTRUMENT_BUDGET_MS);
});

describe("test/stryker-coverage.ts reads a group's mutate list as Stryker does (checked against a real dry run)", () => {
  /** Runs `stryker run --dryRunOnly` for one group, reads its "Instrumented F source file(s) with M mutant(s)" line, and
   *  kills the process group there: the dry run's own tests never run. The sandbox goes to a scratch directory. */
  async function dryRun(group: string): Promise<{ files: number; mutants: number }> {
    const sandbox = mkdtempSync(join(tmpdir(), "stryker-sizing-"));
    try {
      return await new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, ["node_modules/@stryker-mutator/core/bin/stryker.js", "run", "stryker.config.mjs", "--dryRunOnly", "--tempDirName", join(sandbox, "sandbox")], {
          cwd: ENGINE,
          env: { ...process.env, STRYKER_GROUP: group },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            process.kill(-(child.pid as number), "SIGKILL");
          } catch {
            // the group is already gone
          }
          fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`stryker dry run of ${group} did not report its mutants in ${SPAWN_MS} ms:\n${out.slice(-600)}`))), SPAWN_MS);
        const onData = (d: Buffer) => {
          out += d.toString();
          const m = /Instrumented (\d+) source file\(s\) with (\d+) mutant\(s\)/.exec(out);
          if (m) finish(() => resolveRun({ files: Number(m[1]), mutants: Number(m[2]) }));
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("exit", () => finish(() => reject(new Error(`stryker dry run of ${group} exited before reporting its mutants:\n${out.slice(-600)}`))));
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // The legs that stress the reading: a pure range (a member cut's), a directory glob with a negation list, a glob with a
  // negation and then a range of the negated file (the order Stryker reads them in), two sports' tails, and a leg that holds
  // the ranges of two different files.
  const probed = ["sports-cricket-2", "competition-2", "sports-football-5", "sports-setbased-1", "sports-nested-1", "sports-period-3"];

  it(`${probed.length} legs: the files and mutants a real Stryker dry run reports are the files and mutants this reading finds`, async () => {
    const tail = resolveGroup("sports-nested-2");
    let checked = 0;
    for (const g of probed) {
      const globs = resolveGroup(g);
      const real = await dryRun(g);
      const expected = { files: selected(ENGINE, globs).size, mutants: await groupMutants(ENGINE, globs) };
      expect(real, g).toEqual(expected);
      expect(real.mutants, `${g} holds mutants`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(probed.length);
    // the ranges are honoured by Stryker itself: the tail of nested/kernel.ts holds fewer mutants than the whole file
    const kernel = "src/sports/nested/kernel.ts";
    expect(tail.some((e) => parseEntry(e).lines !== null), "sports-nested-2 carries a range").toBe(true);
    expect(await groupMutants(ENGINE, tail), "the tail leg, not the whole kernel").toBeLessThan(await mutantCount(ENGINE, kernel, "all"));
  }, spawnBudget(probed.length) + INSTRUMENT_BUDGET_MS);
});

// T20-FIX1, M2 (a comment is a hypothesis): the notes that QUOTE the rate were written for the local rate (26) and the 1,344-mutant
// ceiling it gave, and stayed that way after T20-PRE pinned 77 and 454. A comment cannot fail a test, so the figures a comment
// quotes are held to the pinned ones here, and the retired ones are refused by name.
describe("the comments that quote the sizing quote the pinned figures (T20-FIX1, M2)", () => {
  const read = (f: string): string => readFileSync(join(ENGINE, f), "utf8");
  /** Every file whose comments speak of the rate, the ceiling, the timeouts' calibration or what a cut loses. */
  const NOTES = ["stryker.groups.mjs", "stryker.config.mjs", "scripts/stryker-matrix.mjs", "scripts/stryker-cuts.mjs"];
  /** What the notes said before the hosted measurement: each phrase is a claim the pinned figures falsify. */
  const RETIRED: [RegExp, string][] = [
    [/\b26 runner-second/, "the local rate of 26 runner-seconds per mutant (hosted: 77)"],
    [/1,344/, "the 1,344-mutant ceiling that rate gave (now 454)"],
    [/not yet calibrated/i, "timeouts 'not yet calibrated on a hosted runner' (run 37330725739 calibrated them)"],
    [/further x2/, "the probe's x2 allowance (retired: its timeout is by the same rule as every leg's)"],
    [/Task 20 re-measures/, "'Task 20 re-measures' (the hosted measurement is in)"],
    [/\(26\)/, "the local rate quoted as the rate the timeouts rest on"],
    [/or lose a mutant to it/, "'a part cannot lose a mutant' stated of every part (member cuts lose 9: stryker-unscored.json)"],
  ];

  it("no note still says a retired figure, across every file that speaks of the sizing", () => {
    let checked = 0;
    for (const f of NOTES) {
      const text = read(f);
      expect(text.length, `${f} was read`).toBeGreaterThan(500);
      for (const [re, what] of RETIRED) {
        expect(re.test(text), `${f} still says ${what}`).toBe(false);
        checked++;
      }
    }
    expect(checked, "files x retired phrases checked").toBe(NOTES.length * RETIRED.length);
  });

  it("stryker.groups.mjs's SIZING note quotes the pinned rate and the pinned ceiling, and the cuts note says what a member cut never scores", () => {
    const groups = read("stryker.groups.mjs");
    expect(groups, "the pinned rate").toContain(`${RUNNER_SECONDS_PER_MUTANT} runner-seconds`);
    expect(groups, "the pinned ceiling (the most mutants a leg may hold)").toContain(`${MAX_MUTANTS.toLocaleString("en-US")} mutants`);
    expect(groups, "member cuts are named where cuts are described").toMatch(/member/i);
    expect(groups, "and the list of what they never score").toContain("stryker-unscored.json");
    const cuts = read("scripts/stryker-cuts.mjs");
    expect(cuts, "the cuts note says never scored").toMatch(/never scored/);
    expect(cuts, "and where the list is").toContain("stryker-unscored.json");
    expect(MAX_MUTANTS, "the ceiling the note quotes is the one the formula gives").toBe(454);
  });
});
