// W1d Task 15, T15-SIZE (D14; rulings 66, 67): every Stryker leg is sized from Stryker's own mutant count and the MEASURED
// cost of a mutant, and none is over the 200-minute split line. The counts come from Stryker's instrumenter (the code that
// writes the "Instrumented N source file(s) with M mutant(s)" line of a dry run), never from line counts or a typed table,
// and test/stryker-coverage.ts's reading of a group's `mutate` list is checked here against a real Stryker dry run.
//
// FORMULA AGAINST MEASURED. D14's formula assumed 10 runner-seconds per mutant: est = ceil((max(dry, 344) + mutants x 10 / 3) / 60)
// minutes at CI's concurrency of 3. The probe's real run (134 mutants, 740 s wall at concurrency 5, 187 tests per mutant)
// measured 26 runner-seconds per mutant (26.04): 2.6 times the formula. The rate below is that measurement, rounded to the
// owner's ruling (T15-SIZE) of 26; it is ONE sample on a loaded machine, and Task 20 re-measures on CI.
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
/** Measured runner-seconds per mutant (T15-SIZE). The probe's own run: (740 s - 42 s dry run) x 5 / 134 = 26.04. */
const RUNNER_SECONDS_PER_MUTANT = 26;
/** D14: the dry run is taken as at least this many seconds (CI's figure; a local one is shorter). */
const DRY_RUN_FLOOR_SECONDS = 344;
/** T15-SIZE: no leg's estimate may pass this many minutes. */
const SPLIT_LINE_MINUTES = 200;
/** D14: a job's timeout is its estimate times this, capped at GitHub's 300-minute limit the workflow uses. */
const TIMEOUT_FACTOR = 1.5;
const TIMEOUT_CAP_MINUTES = 300;
/** The hosted runner mutation.yml runs on: 4 vCPUs, 16 GB. Its Stryker concurrency, by the engine's own formula. */
const CI_CONCURRENCY = strykerConcurrency({ cores: 4, memBytes: 16 * GB, workersPerSandbox: STRYKER_VITEST_WORKERS });

const estimateMinutes = (mutants: number): number => Math.ceil((DRY_RUN_FLOOR_SECONDS + (mutants * RUNNER_SECONDS_PER_MUTANT) / CI_CONCURRENCY) / 60);
/** The most mutants a leg may hold: the largest count whose estimate is still at the split line. */
const MAX_MUTANTS = Math.floor(((SPLIT_LINE_MINUTES * 60 - DRY_RUN_FLOOR_SECONDS) * CI_CONCURRENCY) / RUNNER_SECONDS_PER_MUTANT);

/** A test that runs Stryker's instrumenter over many files: one parse of a big file is under a second, and a loaded runner
 *  is several times slower, so the budget is stated, not left at vitest's 5 s. */
const INSTRUMENT_BUDGET_MS = 120_000;

/** Each leg with its `mutate` list as Stryker reads it: the parts of a split file (`file#N`) resolved to `file:a-b`. */
const legs: [string, string[]][] = Object.keys(STRYKER_GROUPS).map((g) => [g, resolveGroup(g)]);
const RECUT = "pnpm --filter @seazn/engine mutation:recut <file> <parts> [--extra <mutants of the leg's other files>]";
const counts = async () => {
  const out: Record<string, number> = {};
  for (const [g, globs] of legs) out[g] = await groupMutants(ENGINE, globs);
  return out;
};

describe("the sizing rule itself, on numbers from the ruling (so the tests below cannot pass on a wrong formula)", () => {
  it("CI runs 3 sandboxes at once, and the largest leg is the count whose estimate is exactly the split line", () => {
    expect(CI_CONCURRENCY).toBe(3);
    // 26 runner-s / 3 = 8.67 s of wall time per mutant: 1,344 mutants is 11,648 s + the 344 s floor = 11,992 s = 199.9 min
    expect(MAX_MUTANTS).toBe(1344);
    expect(estimateMinutes(MAX_MUTANTS)).toBe(200);
    expect(estimateMinutes(MAX_MUTANTS + 1), "one mutant more is over the line").toBe(201);
    // the measured cost against D14's: 26 / 3 against 10 / 3 per mutant, 2.6 times
    expect(RUNNER_SECONDS_PER_MUTANT / 10).toBeCloseTo(2.6, 5);
    // the probe: 134 mutants is 26 minutes (and its recorded timeout is 1.5 times that)
    expect(estimateMinutes(134)).toBe(26);
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
    // the line is not vacuous: before the split a single file was over it (cricket.ts, 4,248 mutants at the time)
    const whole = await mutantCount(ENGINE, "src/sports/cricket/cricket.ts", "all");
    expect(estimateMinutes(whole), "cricket.ts alone, unsplit, is over the line").toBeGreaterThan(SPLIT_LINE_MINUTES);
  }, INSTRUMENT_BUDGET_MS);

  it("splitting a file by range loses no mutant: each split file's ranges add up to the whole file's count (a cut inside a statement drops the mutants of every node that spans it)", async () => {
    const files = new Map<string, Selected[]>();
    // the probe is not a home (roundrobin.ts is in draws-pairing too): a PR runs it alone
    for (const [g, globs] of legs) if (g !== "probe") for (const [f, sel] of selected(ENGINE, globs)) files.set(f, [...(files.get(f) ?? []), sel]);
    let split = 0;
    let ranges = 0;
    for (const [f, sels] of files) {
      if (sels.length === 1 && sels[0] === "all") continue;
      split++;
      const whole = await mutantCount(ENGINE, f, "all");
      let sum = 0;
      for (const sel of sels) {
        expect(sel, `${f}: a split file's every owner holds ranges`).not.toBe("all");
        for (const range of sel as readonly (readonly [number, number])[]) {
          sum += await mutantCount(ENGINE, f, [range]);
          ranges++;
        }
      }
      expect(sum, `${f}: ${whole - sum} mutant(s) lost to a boundary that falls inside a statement; the cuts are anchored to statements by scripts/stryker-cuts.mjs, so a loss means the resolver or a hand-written \`file:a-b\` is wrong (re-cut with ${RECUT})`).toBe(whole);
    }
    expect(split, "files split by range").toBeGreaterThanOrEqual(5);
    expect(ranges, "ranges summed").toBeGreaterThan(split);
  }, INSTRUMENT_BUDGET_MS);

  it("the legs together hold every mutant of every file they select, none twice and none lost", async () => {
    const byLeg = await counts();
    const sumLegs = legs.filter(([g]) => g !== "probe").reduce((n, [g]) => n + (byLeg[g] as number), 0);
    const files = new Set<string>();
    for (const [g, globs] of legs) if (g !== "probe") for (const f of selected(ENGINE, globs).keys()) files.add(f);
    let sumFiles = 0;
    for (const f of files) sumFiles += await mutantCount(ENGINE, f, "all");
    expect(files.size, "files the legs select").toBeGreaterThan(50);
    expect(sumLegs, "the legs' mutants against the files' own").toBe(sumFiles);
  }, INSTRUMENT_BUDGET_MS);
});

describe("stryker-timeouts.json covers each leg's estimate (T15-SIZE, D14)", () => {
  const timeouts = JSON.parse(readFileSync(join(ENGINE, "stryker-timeouts.json"), "utf8")) as Record<string, number>;

  it("one timeout per leg, none below its estimate, none above the 300-minute cap, and each within the factor of D14 of the estimate", async () => {
    expect(Object.keys(timeouts)).toEqual(legs.map(([g]) => g));
    const byLeg = await counts();
    let checked = 0;
    for (const [g] of legs) {
      const est = estimateMinutes(byLeg[g] as number);
      const t = timeouts[g] as number;
      expect(Number.isInteger(t), `${g} timeout ${t}`).toBe(true);
      expect(t, `${g}: timeout against estimate ${est}`).toBeGreaterThanOrEqual(est);
      expect(t, `${g}: timeout against the cap`).toBeLessThanOrEqual(TIMEOUT_CAP_MINUTES);
      // not wildly above: 1.5 x the estimate, plus a minute or two of slack for the count drifting since it was written
      expect(t, `${g}: timeout is way over 1.5 x its estimate (${est})`).toBeLessThanOrEqual(Math.min(TIMEOUT_CAP_MINUTES, Math.ceil(est * TIMEOUT_FACTOR) + 15));
      checked++;
    }
    expect(checked).toBe(legs.length);
  }, INSTRUMENT_BUDGET_MS);

  it("the probe keeps its timeout from its own measured run: 134 mutants, 26 minutes, 39 with the factor", () => {
    expect(timeouts.probe).toBe(Math.ceil(estimateMinutes(134) * TIMEOUT_FACTOR));
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

  // The legs that stress the reading: a pure range, a negation list, a glob with a negation and then a range of the negated
  // file (the order Stryker reads them in), two sports' tails, and a leg whose directory glob has a file ranged elsewhere.
  const probed = ["sports-cricket-kernel-3", "competition", "sports-football-3", "sports-setbased-2", "sports-nested-2", "sports-period-3"];

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
