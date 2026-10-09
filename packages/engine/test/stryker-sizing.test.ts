// W1d Task 15 (T15-SIZE), Task 20's pre-step (T20-PRE) and Task 20 step 2 (D14; rulings 66, 67): every Stryker leg is held to the
// 200-minute split line and TIMED FROM MEASUREMENT. The mutant counts come from Stryker's instrumenter (the code that writes the
// "Instrumented N source file(s) with M mutant(s)" line of a dry run), never from line counts or a typed table, and
// test/stryker-coverage.ts's reading of a group's `mutate` list is checked here against a real Stryker dry run.
//
// FROM A FORMULA TO MEASUREMENTS. D14's formula, and T20-PRE's one hosted sample (the probe, 77 runner-seconds a mutant), sized the legs
// before any of them had run. The first full dispatch (GitHub run 37371368951, sha 78c7ef3e6, ubuntu-latest, 4 vCPU, concurrency 3)
// then timed 66 of the 69 legs to the end (a third attempt re-ran core-3, which had failed to start) and cancelled three at their
// timeouts, and the rate was NOT one number: 0.3 runner-seconds a mutant for a leg whose mutants a test kills at once, 114 for a leg
// whose mutants are mostly "static" (Stryker runs those against every test, after the others), so the formula was about 1.5x UNDER on the
// slowest legs and over 200x over on the fastest. packages/engine/stryker-measured.json records, per leg, what that run measured; a leg's
// timeout is now 1.5 times what it measured. A leg cut AFTER that run was first timed by a projection (a share of the measured phase,
// or the pace of a cancelled leg); T20 step 2b RAN all 17 parts, the projections were off by 0.23x to 1.5x (the note on
// PROJECTED_LINE_MINUTES below), and every part that has run is now timed from its own measured wall, like
// a leg that was never cut. The last projections went the same way: the one part the re-run cancelled at its timeout again
// (sports-period-9) was cut into three, those three were RUN, and every one of the 81 legs is now timed from its own job's wall. The
// pace rule stays in this file for the next cut, which needs a timeout before it can be dispatched at all (a part has to run once to be
// measured), and a test holds that no part is left on it when a branch merges.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveGroup, resolveSplit, topLevelStatements } from "../scripts/stryker-cuts.mjs";
import { STRYKER_GROUPS, STRYKER_SPLITS, STRYKER_VITEST_WORKERS, strykerConcurrency } from "../stryker.groups.mjs";
import { groupMutants, mutantCount, mutantsOf, mutantsOfText, parseEntry, selected, type Found, type Selected } from "./stryker-coverage.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GB = 1024 ** 3;

// ---- the rulebook, typed here and never derived from the groups or the timeouts under test ---------------------------------
/** THE PROBE'S HOSTED MEASUREMENT (the one sample T20-PRE had; the probe is not a leg of the full run, a pull request runs it
 *  alone, so its timeout is still from this): GitHub Actions run 37330725739, job "mutate probe" (ubuntu-latest, 4 vCPU, Stryker concurrency 3),
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
/** T15-SIZE: no leg's wall time may pass this many minutes (measured for a leg that ran, projected for a part cut after). */
const SPLIT_LINE_MINUTES = 200;
/** A part that has not run is a projection, and a projection is off by the model's error, so it stays this far under the line:
 *  1.5 x 175 = 262 leaves 38 minutes under the cap. How far off? T20 step 2b RAN the 17 parts T20 step 2 had projected, and the job
 *  wall came back, measured over projected: the share-of-phase model (cricket-9, -10, -15, -16, period-2, -11, -12) 0.54x to 1.16x,
 *  the pace of a cancelled leg (period-1, -10, football-7, -8, -9, nested-5, -6, -7, -8) 0.23x to 0.80x, always over, and
 *  sports-period-9's first part, projected at 144.8 min, was cancelled at its 216-minute timeout with 227 of 228 mutants tested:
 *  at least 1.5x. So 175 does not cover a miss of 1.5x, and nothing a model says does: a projection is a first guess, the part is
 *  RUN and its wall recorded, and from then on it is timed like a leg that was never cut (stryker-measured.json, `basis: measured`). */
const PROJECTED_LINE_MINUTES = 175;
/** D14: a job's timeout is what it takes times this, capped at GitHub's 300-minute limit the workflow uses. */
const TIMEOUT_FACTOR = 1.5;
const TIMEOUT_CAP_MINUTES = 300;
/** Below this a timeout is no timeout: a leg that finishes in a minute (its tests kill every mutant at once) still spends that
 *  minute on checkout, install and the upload, which a cold cache doubles. Six legs (competition-3, modules-1 to -4, draws-2)
 *  finished in under 4 minutes and would otherwise get 2 to 6. The floor only ever makes a leg's timeout longer than 1.5 x what it
 *  measured. */
const MIN_TIMEOUT_MINUTES = 10;
/** What a leg spends before its dry run starts and after its mutation phase ends (checkout, install, the upload): the run
 *  measured 20 to 38 s before the dry run, and about 5 s after. A part's timeout adds this once, on top of 1.5 x its phase. */
const SETUP_SECONDS = 60;
/** A leg's mutant count may drift this far from the one its time was measured with before the time is stale: the timeout's
 *  1.5 factor covers the growth, past it the leg must be measured (and, over the line, cut) again. */
const COUNT_DRIFT = 0.1;
/** The probe's own run: 134 mutants (the PR self-proof, D3). */
const PROBE_MUTANTS = HOSTED_PROBE_MUTANTS;
/** The mutants no leg holds, from the committed list beside the sizing data (stryker-unscored.json). Where a cut falls INSIDE a
 *  declaration (a member cut, scripts/stryker-cuts.mjs) the container's own mutants (its object literal, its function body) are
 *  in no range, and Stryker keeps a mutant only if its WHOLE node is inside one. They CAN be mutated: the instrumenter
 *  makes them (`BlockStatement` to `{}`, `ObjectLiteral` to `{}`), and an emptied body or module object can be killed by any test
 *  or can survive; but no leg runs them, so no report ever scores them. The list names each one so a reader of MUTATION.md can
 *  see what the floors never judge, and the count pins below are DERIVED from it: one list, no second count.
 *
 *  KEYED ON WHAT THE SOURCE SAYS, never on where it is (T20-FIX2, I1'): an entry is its file, its mutator, its replacement, the
 *  declaration it sits in (`host`), the TRIMMED TEXT of the source line the mutant starts on, and which such mutant it is (`nth`;
 *  T20 review M4, the text alone matched 19 lines). `line` is information only (the line when the list was written; it
 *  lags the file as soon as anything above it changes, and nothing compares it), because a line-keyed list reds the engine job
 *  of an unrelated PR that adds one comment line to cricket.ts, football.ts, the period or setbased kernels, or import/plan.ts.
 *  An edit to the TEXT of a listed line (a renamed parameter of `padSpec`) still reds, and the failure prints the list to paste. */
interface Unscored { file: string; mutator: string; replacement: string; host: string; text: string; nth: number; line: number }
const UNSCORED = JSON.parse(readFileSync(join(ENGINE, "stryker-unscored.json"), "utf8")) as Unscored[];
/** UNIQUE (T20 review M4): the line text alone is not a key, `return {` is on 19 lines of nested/kernel.ts, so the key also names the
 *  top-level declaration the mutant sits in (`host`) and which of the mutants of that file with the same mutator, replacement, host
 *  and text it is (`nth`, counted in source order): unique BY CONSTRUCTION, since `nth` numbers the mutants that share the rest,
 *  and the test "every listed key names ONE mutant" holds it on every mutant of every listed file. */
const unscoredKey = (u: Unscored): string => [u.file, u.mutator, u.replacement, u.host, u.text, u.nth].join(" | ");
/** The old key (file, mutator, replacement, line text): what ambiguity is measured against. */
const bareKey = (u: Pick<Unscored, "file" | "mutator" | "replacement" | "text">): string => [u.file, u.mutator, u.replacement, u.text].join(" | ");
/** EVERY mutant of `whole` (the instrumenter's, over `text`) with its key, in source order. A mutant outside every top-level
 *  statement is refused (the instrumenter never makes one; a place that says so is a wrong report, not a key to invent). */
function keyedMutants(file: string, text: string, whole: readonly Found[]): { m: Found; entry: Unscored }[] {
  const lines = text.split("\n");
  const statements = topLevelStatements(text);
  const hostOf = (line: number): string => {
    const at = statements.find((st) => line >= st.startLine && line <= st.endLine);
    if (at === undefined) throw new Error(`${file}:${line}: a mutant outside every top-level statement`);
    return at.names.length > 0 ? at.names.join("+") : `statement ${at.index + 1}`;
  };
  const ordered = [...whole].sort((a, b) => a.start.line - b.start.line || a.start.column - b.start.column || b.end.line - a.end.line || b.end.column - a.end.column);
  const seen = new Map<string, number>();
  const out = ordered.map((m) => {
    const base = { file, mutator: m.mutator, replacement: m.replacement, host: hostOf(m.start.line + 1), text: (lines[m.start.line] as string).trim() };
    const same = [base.mutator, base.replacement, base.host, base.text].join(" | ");
    const nth = (seen.get(same) ?? 0) + 1;
    seen.set(same, nth);
    return { m, entry: { ...base, nth, line: m.start.line + 1 } };
  });
  return out;
}
/** The mutants of `whole` whose node runs across one of `boundaries` (the LAST line of a part, 1-based): Stryker keeps a mutant only
 *  when its whole node lies inside one range, so these are in no part. Never from the cuts' own arithmetic (`start` and `end` are
 *  0-based lines). With a `window` (1-based lines, inclusive) only the mutants whose node lies inside it: the lines the leg held
 *  BEFORE it was cut, since a container that ran outside them was in no leg already. */
function lostAt(file: string, text: string, whole: readonly Found[], boundaries: readonly number[], window?: readonly [number, number]): Unscored[] {
  const inside = (m: Found): boolean => window === undefined || (m.start.line + 1 >= window[0] && m.end.line + 1 <= window[1]);
  return keyedMutants(file, text, whole).filter(({ m }) => inside(m) && boundaries.some((b) => m.start.line + 1 <= b && m.end.line + 1 > b)).map(({ entry }) => entry);
}
/** The mutants of `whole` that no part holds: those whose node runs across the last line of a part (a range is 1-based and inclusive). */
function lostBy(file: string, text: string, whole: readonly Found[], parts: readonly (readonly [number, number])[]): Unscored[] {
  return lostAt(file, text, whole, parts.slice(0, -1).map(([, to]) => to));
}
/** What a failing list pin tells its author: the file to write, whole, from this run (the timeouts test does the same). */
const unscoredHint = (found: readonly Unscored[]): string =>
  `regenerate: write this to packages/engine/stryker-unscored.json (the mutants no leg holds, keyed on file, mutator, replacement, the declaration they sit in, the trimmed text of the line and which such mutant it is; \`line\` is information only; from this run):\n${JSON.stringify([...found].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line), null, 2)}`;
/** The list's count per file (a statement cut loses none, and every file not named is cut only by statements). */
const MEMBER_CUT_LOSS: Record<string, number> = {};
for (const u of UNSCORED) MEMBER_CUT_LOSS[u.file] = (MEMBER_CUT_LOSS[u.file] ?? 0) + 1;
/** The hosted runner mutation.yml runs on: 4 vCPUs, 16 GB. Its Stryker concurrency, by the engine's own formula. */
const CI_CONCURRENCY = strykerConcurrency({ cores: 4, memBytes: 16 * GB, workersPerSandbox: STRYKER_VITEST_WORKERS });

/** The PROBE's estimate, from the one hosted sample T20-PRE had (the probe is not a leg of the full run): D14's dry-run floor plus
 *  the hosted rate. No other leg is estimated; every other leg was measured. */
const estimateMinutes = (mutants: number): number => Math.ceil((DRY_RUN_FLOOR_SECONDS + (mutants * RUNNER_SECONDS_PER_MUTANT) / CI_CONCURRENCY) / 60);

// ---- what the full run measured: packages/engine/stryker-measured.json (GitHub run 37371368951, sha 78c7ef3e6) -----------------
/** A leg the first run measured, or one MEASURED AGAIN since: because its count moved past the drift (W2a: core-2,
 *  sports-other-1), or because it outran its timeout at the same count (W2a: modules-7, cancelled at its 10-minute floor in
 *  dispatch 37923872826). A re-measured leg names the run and job that measured it (`run`), so its figures are never typed
 *  without a source. */
interface MeasuredLeg { mutants: number; wallSeconds: number; dryRunSeconds: number; phaseSeconds: number; run?: Source }
interface CancelledLeg { mutants: number; dryRunSeconds: number; rate: number; attempts: Record<string, { tested: number; phaseSeconds: number; lastHourTested: number }> }
/** Where a measurement comes from: the workflow run, the job in it (its log has the dry run, the phase and the wall), the commit it ran. */
interface Source { id: number; job: number; sha: string }
/** A part cut after the first run and RUN since (T20 step 2b): what its own job measured, like a leg that was never cut. */
interface MeasuredPart extends MeasuredLeg { basis: "measured"; run: Source }
/** A part that has not run: timed from the pace of the part it was cut from (`SplitLeg.cancelledPart`), a projection. */
interface RatedPart { mutants: number; basis: "rate"; phaseSeconds: number }
type SplitPart = MeasuredPart | RatedPart;
/** A part that RAN and was cancelled at its timeout because it was over the line, then cut again: its pace, as a cancelled leg's. */
interface CancelledPart extends CancelledLeg { leg: string; cut: string; wallSeconds: number; run: Source; replacedBy: string[] }
interface SplitLeg { mutants: number; lost: number; parts: Record<string, SplitPart>; cancelledPart?: CancelledPart }
interface Measured {
  run: { id: number; sha: string; attempts: number; runner: string; concurrency: number; maxParallel: number };
  measured: Record<string, MeasuredLeg>;
  cancelled: Record<string, CancelledLeg>;
  split: Record<string, SplitLeg>;
}
const MEASURED = JSON.parse(readFileSync(join(ENGINE, "stryker-measured.json"), "utf8")) as Measured;

const clampTimeout = (minutes: number): number => Math.min(TIMEOUT_CAP_MINUTES, Math.max(MIN_TIMEOUT_MINUTES, minutes));
/** A leg that ran to the end took `wallSeconds` (job start to job end, setup and upload included): 1.5 x that, up to a whole minute. */
const rawMeasuredTimeout = (wallSeconds: number): number => Math.ceil((TIMEOUT_FACTOR * wallSeconds) / 60);
/** A part that has not run: 1.5 x its projected mutation phase, plus its dry run and the setup once, up to a whole minute. */
const rawPartTimeout = (phaseSeconds: number, dryRunSeconds: number): number => Math.ceil((TIMEOUT_FACTOR * phaseSeconds + dryRunSeconds + SETUP_SECONDS) / 60);
/** The pace of a leg the run CANCELLED, in runner-seconds a mutant: the dearer of its average over the whole mutation phase and
 *  its pace over the last hour, over both attempts, up to a whole second. The average alone understates it: the mutants a
 *  cancelled leg had not reached are the static ones that survive, and they run last and slowest. */
function cancelledRate(c: CancelledLeg): number {
  let best = 0;
  for (const a of Object.values(c.attempts)) best = Math.max(best, (a.phaseSeconds * HOSTED_CONCURRENCY) / a.tested, (3600 * HOSTED_CONCURRENCY) / a.lastHourTested);
  return Math.ceil(best);
}
/** How a leg is timed: "measured" (its own job ran to the end: a leg of the first run, or a part that has been run since), or
 *  "rate" (a part that has not run: the pace of the part it was cut from, times its mutants). */
interface Plan { kind: "measured" | "rate"; wallMinutes: number; phaseMinutes: number; rawTimeout: number }
function planOf(leg: string, data: Measured = MEASURED): Plan {
  for (const split of Object.values(data.split)) {
    const part = split.parts[leg];
    if (part === undefined) continue;
    if (part.basis === "measured") return { kind: "measured", wallMinutes: part.wallSeconds / 60, phaseMinutes: part.phaseSeconds / 60, rawTimeout: rawMeasuredTimeout(part.wallSeconds) };
    const from = split.cancelledPart;
    if (from === undefined) throw new Error(`${leg}: a rate part whose leg records no cancelled part to take the pace from`);
    const phase = (from.rate * part.mutants) / HOSTED_CONCURRENCY;
    return { kind: "rate", wallMinutes: (SETUP_SECONDS + from.dryRunSeconds + phase) / 60, phaseMinutes: phase / 60, rawTimeout: rawPartTimeout(phase, from.dryRunSeconds) };
  }
  const m = data.measured[leg];
  if (m === undefined) throw new Error(`${leg}: neither measured nor a part of a leg that was`);
  return { kind: "measured", wallMinutes: m.wallSeconds / 60, phaseMinutes: m.phaseSeconds / 60, rawTimeout: rawMeasuredTimeout(m.wallSeconds) };
}
/** The parts that have not run, by name: each is timed from a pace, a projection (the bootstrap of a new cut). The rule is that a branch
 *  merges with none. A pure function of the data so the rule is tested on a fixture that breaks it, not only on the data that keeps it. */
const partsOnAPace = (data: Measured): string[] => Object.values(data.split).flatMap((s) => Object.entries(s.parts).filter(([, p]) => p.basis !== "measured").map(([leg]) => leg));
/** The probe's timeout, by D14's rule from its own hosted sample: ceil(1.5 x its estimate). */
const probeTimeout = (): number => clampTimeout(Math.ceil(estimateMinutes(PROBE_MUTANTS) * TIMEOUT_FACTOR));
/** The timeouts file the rule produces: each leg from its plan, the probe from its own run. */
function regeneratedTimeouts(names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of names) out[g] = g === "probe" ? probeTimeout() : clampTimeout(planOf(g).rawTimeout);
  return out;
}
/** One leg's timeout fault, or null: the file holds exactly the rule's value, a whole number of minutes. */
function timeoutFault(leg: string, t: number, want: number): string | null {
  if (!Number.isInteger(t)) return `${leg}: timeout ${t} is not a whole number of minutes`;
  if (t < want) return `${leg}: timeout ${t} is below the ${want} its measurement gives`;
  if (t > want) return `${leg}: timeout ${t} is above the ${want} its measurement gives`;
  return null;
}
/** What a failing timeouts test tells its author: the file to write, whole. */
const regenerateHint = (names: readonly string[]): string =>
  `regenerate: write this to packages/engine/stryker-timeouts.json (each leg is min(${TIMEOUT_CAP_MINUTES}, max(${MIN_TIMEOUT_MINUTES}, ceil(${TIMEOUT_FACTOR} x what stryker-measured.json says it takes)); the probe by its own sample):\n${JSON.stringify(regeneratedTimeouts(names), null, 2)}`;

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

describe("the probe's hosted sample, and the timeout rule on hand-worked numbers (so the tests below cannot pass on a wrong rule)", () => {
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

  it("CI runs 3 sandboxes at once, and the probe's estimate and timeout are the sample's: 134 mutants, 64 minutes, 96", () => {
    expect(CI_CONCURRENCY).toBe(HOSTED_CONCURRENCY);
    // the probe: 134 mutants is 3,783 s = 63.06 minutes, up to 64; the rule predicts at least what the hosted run it came from took (3,553.7 s)
    expect(estimateMinutes(HOSTED_PROBE_MUTANTS)).toBe(64);
    expect(estimateMinutes(HOSTED_PROBE_MUTANTS) * 60, "the prediction covers the run it was derived from").toBeGreaterThanOrEqual(HOSTED_DRY_RUN_SECONDS + HOSTED_MUTATION_PHASE_SECONDS);
    // its timeout: ceil(64 x 1.5) = 96
    expect(Math.min(TIMEOUT_CAP_MINUTES, Math.ceil(estimateMinutes(HOSTED_PROBE_MUTANTS) * TIMEOUT_FACTOR))).toBe(96);
  });

  it("a leg that ran is timed 1.5 x its wall to the whole minute, held to the 10-minute floor and the 300-minute cap (worked by hand, each number its own case)", () => {
    // 45.5 min = 2,730 s: 1.5 x = 4,095 s = 68.25 min, up to 69
    expect(clampTimeout(rawMeasuredTimeout(2730))).toBe(69);
    // exactly on a minute: 60 min = 3,600 s -> 90, not 91
    expect(clampTimeout(rawMeasuredTimeout(3600))).toBe(90);
    // a one-minute leg (its tests kill every mutant at once): 1.5 x 60 s = 1.5 min, up to 2, held to the floor of 10
    expect(rawMeasuredTimeout(60)).toBe(2);
    expect(clampTimeout(rawMeasuredTimeout(60))).toBe(MIN_TIMEOUT_MINUTES);
    // the floor never lowers one: 7.5 min = 450 s -> 11.25, up to 12
    expect(clampTimeout(rawMeasuredTimeout(450))).toBe(12);
    // a leg at the split line is exactly the cap: 200 min = 12,000 s -> 300
    expect(rawMeasuredTimeout(SPLIT_LINE_MINUTES * 60)).toBe(TIMEOUT_CAP_MINUTES);
    // and one over it is clipped: 229.4 min (what sports-cricket-9 took) -> 344.1, up to 345, held to 300
    expect(rawMeasuredTimeout(13_764)).toBe(345);
    expect(clampTimeout(rawMeasuredTimeout(13_764))).toBe(TIMEOUT_CAP_MINUTES);
  });

  it("a part that has not run is timed 1.5 x its projected phase plus its dry run and the setup once (worked by hand)", () => {
    // 6,307 s of phase, a 170 s dry run: 9,460.5 + 170 + 60 = 9,690.5 s = 161.5 min, up to 162
    expect(rawPartTimeout(6307, 170)).toBe(162);
    // the dry run and the setup are NOT multiplied: 3,600 s of phase, 120 s dry: 5,400 + 120 + 60 = 5,580 s = 93 min exactly
    expect(rawPartTimeout(3600, 120)).toBe(93);
    // one second over a minute rounds up: 5,581 s -> 94
    expect(rawPartTimeout(3600, 121)).toBe(94);
  });

  it("the bootstrap of a NEW cut, on a leg that is not in the data: a part that has not run is planned from the pace of the part it replaced, a part that has is planned from its own wall, and neither is guessed (worked by hand)", () => {
    // no real part is on a pace any more (all 81 legs ran), so this path is reached only by a fixture, and it must stay right: a cut needs
    // a timeout before it can be dispatched, and the dispatch is what measures it
    const run: Source = { id: 1, job: 2, sha: "abcdef012" };
    const data: Measured = {
      run: MEASURED.run,
      measured: { "demo-whole": { mutants: 50, wallSeconds: 1800, dryRunSeconds: 100, phaseSeconds: 1700 } },
      cancelled: {},
      split: {
        "demo-1": {
          mutants: 300,
          lost: 0,
          parts: {
            "demo-1": { mutants: 100, basis: "measured", wallSeconds: 3600, dryRunSeconds: 120, phaseSeconds: 3400, run },
            "demo-2": { mutants: 150, basis: "rate", phaseSeconds: 12_000 },
          },
          cancelledPart: { leg: "demo-2", cut: "src/x.ts:1-2", mutants: 150, wallSeconds: 18_000, dryRunSeconds: 180, attempts: { attempt1: { tested: 100, phaseSeconds: 12_000, lastHourTested: 45 } }, rate: 240, run, replacedBy: ["demo-2"] },
        },
      },
    };
    // a part that ran: 3,600 s -> 60 min, 1.5 x = 5,400 s = 90 min
    expect(planOf("demo-1", data)).toEqual({ kind: "measured", wallMinutes: 60, phaseMinutes: 3400 / 60, rawTimeout: 90 });
    // a leg that was never cut: 1,800 s -> 30 min, 1.5 x = 45
    expect(planOf("demo-whole", data)).toEqual({ kind: "measured", wallMinutes: 30, phaseMinutes: 1700 / 60, rawTimeout: 45 });
    // a part that has not run: pace 240 x 150 mutants / 3 sandboxes = 12,000 s of phase; wall = 60 s setup + 180 s dry + 12,000 s = 204 min;
    // timeout = ceil((1.5 x 12,000 + 180 + 60) / 60) = ceil(18,240 / 60) = 304
    expect(planOf("demo-2", data)).toEqual({ kind: "rate", wallMinutes: 204, phaseMinutes: 200, rawTimeout: 304 });
    // the merge rule sees it: demo-2 is the one part that has not run, and a leg whose every part ran has none
    expect(partsOnAPace(data)).toEqual(["demo-2"]);
    expect(partsOnAPace({ ...data, split: { "demo-1": { ...(data.split["demo-1"] as SplitLeg), parts: { "demo-1": (data.split["demo-1"] as SplitLeg).parts["demo-1"] as SplitPart } } } })).toEqual([]);
    expect(partsOnAPace({ ...data, split: {} }), "no cut leg, no part on a pace").toEqual([]);
    // and the two ways to be wrong are refusals, not defaults
    expect(() => planOf("demo-9", data)).toThrow(/neither measured nor a part of a leg that was/);
    const noPace = { ...data, split: { "demo-1": { ...(data.split["demo-1"] as SplitLeg), cancelledPart: undefined } } };
    expect(() => planOf("demo-2", noPace)).toThrow(/records no cancelled part to take the pace from/);
  });

  it("a cancelled leg's pace is the dearer of its average and its last hour, over both attempts, up to a whole second (worked by hand)", () => {
    const c: CancelledLeg = {
      mutants: 100, dryRunSeconds: 100, rate: 0,
      attempts: {
        // average 3 x 12,000 / 300 = 120; last hour 3 x 3,600 / 90 = 120
        attempt2: { tested: 300, phaseSeconds: 12_000, lastHourTested: 90 },
        // average 3 x 12,000 / 310 = 116.13; last hour 3 x 3,600 / 50 = 216: the last hour is dearer
        attempt3: { tested: 310, phaseSeconds: 12_000, lastHourTested: 50 },
      },
    };
    expect(cancelledRate(c)).toBe(216);
    // only the average is dearer: 3 x 12,000 / 250 = 144, last hour 3 x 3,600 / 100 = 108
    expect(cancelledRate({ ...c, attempts: { attempt2: { tested: 250, phaseSeconds: 12_000, lastHourTested: 100 } } })).toBe(144);
    // a fraction rounds UP: 3 x 12,000 / 301 = 119.6
    expect(cancelledRate({ ...c, attempts: { attempt2: { tested: 301, phaseSeconds: 12_000, lastHourTested: 100 } } })).toBe(120);
  });

  it("the FIRST attempt can be the dearer, and the rule takes it in either order of the data: neither the first attempt alone nor the last alone is the rule (T20 review M2)", () => {
    const attempt2 = { tested: 250, phaseSeconds: 12_000, lastHourTested: 50 };    // average 3 x 12,000 / 250 = 144; last hour 3 x 3,600 / 50 = 216
    const attempt3 = { tested: 310, phaseSeconds: 12_000, lastHourTested: 100 };   // average 116.13; last hour 3 x 3,600 / 100 = 108
    const base: CancelledLeg = { mutants: 100, dryRunSeconds: 100, rate: 0, attempts: { attempt2, attempt3 } };
    expect(cancelledRate(base)).toBe(216);
    expect(cancelledRate({ ...base, attempts: { attempt3, attempt2 } }), "the order of the data is not the rule").toBe(216);
    expect(cancelledRate({ ...base, attempts: { attempt2 } }), "the first alone").toBe(216);
    expect(cancelledRate({ ...base, attempts: { attempt3 } }), "the last alone is a different number: a rule that read only it would get this one wrong").toBe(117);
  });
});

describe("every leg is under the 200-minute split line, from what the full run measured (T15-SIZE, T20 step 2)", () => {
  const names = legs.map(([g]) => g).filter((g) => g !== "probe");

  it("the data covers exactly the legs: each leg that ran or was cancelled, and each part of a re-split one, once, and nothing else", () => {
    const ran = Object.keys(MEASURED.measured);
    const cancelled = Object.keys(MEASURED.cancelled);
    expect(new Set([...ran, ...cancelled]).size, "the 69 legs the run dispatched, each in one list").toBe(ran.length + cancelled.length);
    expect(ran.length + cancelled.length, "legs the run measured or cancelled").toBe(69);
    const parts = Object.values(MEASURED.split).flatMap((s) => Object.keys(s.parts));
    expect(new Set(parts).size, "no part is listed under two legs").toBe(parts.length);
    expect(Object.keys(MEASURED.split).length, "legs cut after the run").toBeGreaterThan(0);
    // a cancelled leg has no wall to time from, so every one of them was cut
    expect(cancelled.filter((g) => MEASURED.split[g] === undefined), "a cancelled leg that was not cut has no timing").toEqual([]);
    for (const g of Object.keys(MEASURED.split)) expect(ran.includes(g) || cancelled.includes(g), `${g} is a leg the run dispatched`).toBe(true);
    // the legs now: every original that was not cut, and every part. A part may keep its original's name (the first part does).
    const expected = new Set([...ran.filter((g) => MEASURED.split[g] === undefined), ...cancelled.filter((g) => MEASURED.split[g] === undefined), ...parts]);
    expect([...expected].sort(), "the data names exactly the groups there are (less the probe)").toEqual([...names].sort());
  });

  it("no leg's wall passes the split line (a part that has not run stays under the projection line), and no leg is empty", async () => {
    const byLeg = await counts();
    const rows = names.map((g) => ({ leg: g, mutants: byLeg[g] as number, plan: planOf(g) }));
    expect(rows.length, "legs counted").toBe(names.length);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.filter((r) => r.mutants === 0).map((r) => r.leg), `legs with zero mutants: cut the file again with ${RECUT}, or fix the leg's globs`).toEqual([]);
    const over = rows.filter((r) => r.plan.wallMinutes > (r.plan.kind === "measured" ? SPLIT_LINE_MINUTES : PROJECTED_LINE_MINUTES));
    expect(over.map((r) => `${r.leg} (${r.plan.kind}, ${r.plan.wallMinutes.toFixed(1)} min, ${r.mutants} mutants)`), `legs over the line: cut the file again with ${RECUT}, paste the STRYKER_SPLITS line into stryker.groups.mjs, add or drop the legs' \`file#N\` entries, and record the new parts in stryker-measured.json`).toEqual([]);
    // and the cap never clips: 1.5 x the longest leg is under the workflow's limit, so the cap is the limit, not a rescue
    const clipped = rows.filter((r) => r.plan.rawTimeout > TIMEOUT_CAP_MINUTES).map((r) => `${r.leg}: ${r.plan.rawTimeout}`);
    expect(clipped, "legs whose timeout the 300-minute cap shortens").toEqual([]);
  }, INSTRUMENT_BUDGET_MS);

  it("the line is not vacuous: every leg that was cut was over it or cancelled, and every leg left whole is under it (the split catches what it exists for)", () => {
    let cut = 0;
    let recut = 0;
    for (const [g, s] of Object.entries(MEASURED.split)) {
      const ran = MEASURED.measured[g];
      if (ran !== undefined) expect(ran.wallSeconds / 60, `${g} ran ${(ran.wallSeconds / 60).toFixed(1)} min and was cut`).toBeGreaterThan(SPLIT_LINE_MINUTES);
      else expect(MEASURED.cancelled[g], `${g} was cut, so it was cancelled or over the line`).toBeDefined();
      expect(Object.keys(s.parts).length, `${g} was cut into parts`).toBeGreaterThan(1);
      // a part that ran and was cut AGAIN was over the line too: it was cancelled at its timeout, so its wall is its timeout's
      const again = s.cancelledPart;
      if (again !== undefined) {
        expect(again.wallSeconds / 60, `${g}: the part ${again.leg} was cut again at ${(again.wallSeconds / 60).toFixed(1)} min`).toBeGreaterThan(SPLIT_LINE_MINUTES);
        recut++;
      }
      cut++;
    }
    expect(recut, "parts cut again after the re-run").toBeGreaterThan(0);
    expect(cut, "legs cut").toBe(Object.keys(MEASURED.split).length);
    let whole = 0;
    for (const [g, m] of Object.entries(MEASURED.measured)) {
      if (MEASURED.split[g] !== undefined) continue;
      expect(m.wallSeconds / 60, `${g} was left whole`).toBeLessThanOrEqual(SPLIT_LINE_MINUTES);
      whole++;
    }
    expect(whole, "legs left whole").toBeGreaterThan(50);
  });

  it("each leg's mutant count is within the drift of the one its time was measured with: past it the time is stale and the leg is measured again", async () => {
    const byLeg = await counts();
    const recorded = (g: string): number => {
      for (const s of Object.values(MEASURED.split)) if (s.parts[g] !== undefined) return s.parts[g].mutants;
      return (MEASURED.measured[g] as MeasuredLeg).mutants;
    };
    const stale: string[] = [];
    let checked = 0;
    for (const g of names) {
      const was = recorded(g);
      const now = byLeg[g] as number;
      if (Math.abs(now - was) > was * COUNT_DRIFT) stale.push(`${g}: ${was} mutants when measured, ${now} now`);
      checked++;
    }
    expect(checked, "legs checked").toBe(names.length);
    // a leg cut at an ordinal anchor (`if#7`) whose count moved most likely moved because an `if` was added or removed above the cut:
    // that is a RE-CUT, not a re-run (stryker-cuts.test.ts reds on the anchor itself, with the statement it was cut at)
    const atOrdinal = (g: string): boolean => ((STRYKER_GROUPS as Record<string, readonly string[]>)[g] ?? []).some((e: string) => { const m = /^(.*)#(\d+)$/.exec(e); return m !== null && (STRYKER_SPLITS[m[1] as string] ?? []).some((a) => a.includes("#")); });
    const why = stale.some((x) => atOrdinal(x.split(":")[0] as string))
      ? "; a leg cut at an ordinal anchor (`if#N`) moved because an `if` was added or removed above its cut: RE-CUT it (stryker-cuts.test.ts names the anchor), do not just re-run it"
      : "";
    expect(stale, `legs whose count moved more than 10%: re-run the leg, then record its measurement in stryker-measured.json${why}`).toEqual([]);
  }, INSTRUMENT_BUDGET_MS);

  it("a re-split leg holds every mutant of the leg it came from: its parts' mutants plus the lost containers are the count the run measured, and the containers it lost are the ones ITS OWN cuts leave in no part (T20 review M3)", async () => {
    const byLeg = await counts();
    let lost = 0;
    let parts = 0;
    let boundaries = 0;
    const lostByCuts: Unscored[] = [];
    for (const [g, s] of Object.entries(MEASURED.split)) {
      const recordedSum = Object.values(s.parts).reduce((n, p) => n + p.mutants, 0);
      expect(recordedSum + s.lost, `${g}: the parts recorded plus the lost containers are the leg's count`).toBe(s.mutants);
      // and today's count, from the instrumenter, agrees to the drift (the exact equality held when the cut was made)
      const nowSum = Object.keys(s.parts).reduce((n, leg) => n + (byLeg[leg] as number), 0);
      expect(Math.abs(nowSum - recordedSum), `${g}: the parts hold ${nowSum} mutants now, ${recordedSum} when cut`).toBeLessThanOrEqual(recordedSum * COUNT_DRIFT);
      // What THIS leg's cuts lose, from the instrumenter (never from the recorded `lost`): the mutants the leg held whole before it was cut
      // (inside the lines its parts cover together) whose node spans the line where one of its parts ends and the next of ITS parts
      // begins. A boundary against another leg's part is that leg's older cut, and a container that ran outside the leg was in no leg.
      const ranges = new Map<string, [number, number][]>();
      for (const leg of Object.keys(s.parts)) for (const [f, sel] of selected(ENGINE, resolveGroup(leg))) if (sel !== "all") ranges.set(f, [...(ranges.get(f) ?? []), ...sel.map((r): [number, number] => [r[0], r[1]])]);
      let own = 0;
      for (const [f, rs] of ranges) {
        rs.sort((x, y) => x[0] - y[0]);
        const cuts = rs.slice(0, -1).filter((r, i) => r[1] + 1 === (rs[i + 1] as [number, number])[0]).map((r) => r[1]);
        boundaries += cuts.length;
        const found = lostAt(f, readFileSync(join(ENGINE, f), "utf8"), await mutantsOf(ENGINE, f, "all"), cuts, [(rs[0] as [number, number])[0], Math.max(...rs.map((r) => r[1]))]);
        own += found.length;
        lostByCuts.push(...found);
      }
      expect(own, `${g}: the containers its own cuts leave in no part, by the instrumenter, are the ${s.lost} the file records`).toBe(s.lost);
      lost += s.lost;
      parts += Object.keys(s.parts).length;
    }
    expect(parts, "parts checked").toBeGreaterThan(Object.keys(MEASURED.split).length);
    expect(boundaries, "every part meets the next one of its leg: one boundary fewer than parts, none unaccounted").toBe(parts - Object.keys(MEASURED.split).length);
    expect(lost, "and the cuts do cost something: a member cut loses its container").toBeGreaterThan(0);
    expect(lostByCuts.length, "what the legs' own cuts lose, as many as the file records").toBe(lost);
    // the list: every container a re-split leg's cuts lose is in it, and what the list holds besides is the OLDER member cuts' (derived: no number typed)
    const listed = new Set(UNSCORED.map(unscoredKey));
    for (const u of lostByCuts) expect(listed.has(unscoredKey(u)), `${unscoredKey(u)} is lost by a re-split leg's cuts and is not in stryker-unscored.json`).toBe(true);
    const mine = new Set(lostByCuts.map(unscoredKey));
    expect(mine.size, "no mutant is lost by two legs' cuts").toBe(lostByCuts.length);
    const older = UNSCORED.filter((u) => !mine.has(unscoredKey(u)));
    expect(older.length, "the older member cuts' entries (the T20-PRE cuts: no re-split leg's parts meet at them)").toBeGreaterThan(0);
    expect(older.length + lost, "the list is the older entries and the re-split legs' own, nothing else").toBe(UNSCORED.length);
  }, INSTRUMENT_BUDGET_MS);

  it("every part is timed from its own run, and the part cut again records which parts took its place (T20 step 2b and the last three parts)", () => {
    let measured = 0;
    let rated = 0;
    let recut = 0;
    for (const [g, s] of Object.entries(MEASURED.split)) {
      for (const [leg, p] of Object.entries(s.parts)) {
        if (p.basis === "measured") {
          // a part that ran has its own job: the run, the job and the sha say where the figures can be read again
          expect(Number.isInteger(p.run.id) && p.run.id > 0, `${leg}: a run id`).toBe(true);
          expect(Number.isInteger(p.run.job) && p.run.job > 0, `${leg}: a job id`).toBe(true);
          expect(p.run.sha, `${leg}: the commit it ran`).toMatch(/^[0-9a-f]{9}$/);
          expect(p.mutants, `${leg} has mutants`).toBeGreaterThan(0);
          expect(p.dryRunSeconds, `${leg} has a dry run`).toBeGreaterThan(0);
          // the job outlasts its dry run and its phase, and by setup and upload only (the first run's legs: 24 to 43 s)
          const around = p.wallSeconds - p.dryRunSeconds - p.phaseSeconds;
          expect(around, `${leg}: setup and upload around the dry run and the phase`).toBeGreaterThan(0);
          expect(around, `${leg}: setup and upload around the dry run and the phase`).toBeLessThan(SETUP_SECONDS);
          measured++;
        } else {
          // a part that has not run (the bootstrap of a new cut): its phase is the pace of the part it was cut from times its mutants (to the second)
          const from = s.cancelledPart;
          expect(from, `${leg} is timed from a pace, so ${g} records the part it was cut from`).toBeDefined();
          const c = from as CancelledPart;
          expect(Math.abs(p.phaseSeconds - (c.rate * p.mutants) / HOSTED_CONCURRENCY), `${leg}: phase against pace x mutants`).toBeLessThanOrEqual(1);
          rated++;
        }
      }
      if (s.cancelledPart !== undefined) {
        const c = s.cancelledPart;
        // the part cut again was over the line, ran, and was cancelled: it is no part of the leg now, and the parts named here took its place
        expect(c.replacedBy.length, `${g}: the part cut again became at least two`).toBeGreaterThan(1);
        expect(new Set(c.replacedBy).size, `${g}: no part named twice`).toBe(c.replacedBy.length);
        expect(c.replacedBy, `${g}: the first part keeps the cancelled part's name`).toContain(c.leg);
        for (const leg of c.replacedBy) expect(s.parts[leg], `${g}: ${leg} is a part of the leg`).toBeDefined();
        expect(c.replacedBy.reduce((n, leg) => n + (s.parts[leg] as SplitPart).mutants, 0), `${g}: the parts that took the place of ${c.leg} hold its ${c.mutants} mutants, none lost and none twice`).toBe(c.mutants);
        // its pace is from the last attempt's own figures: the dearer of the average and the last hour, and it has a dry run, a wall and a commit
        expect(c.rate, `${g}: the recorded pace is the one its attempts give`).toBe(cancelledRate(c));
        expect(c.dryRunSeconds, `${g}: the cancelled part's dry run`).toBeGreaterThan(0);
        expect(c.wallSeconds - c.dryRunSeconds - Math.max(...Object.values(c.attempts).map((a) => a.phaseSeconds)), `${g}: setup around the cancelled part's dry run and phase`).toBeGreaterThan(0);
        expect(c.run.sha).toMatch(/^[0-9a-f]{9}$/);
        for (const [name, a] of Object.entries(c.attempts)) expect(a.tested, `${g} ${name}: tested at the timeout, not all of ${c.mutants}`).toBeLessThanOrEqual(c.mutants);
        recut++;
      }
    }
    expect(measured + rated, "every part was classified, as run or as a pace").toBe(Object.values(MEASURED.split).reduce((n, s) => n + Object.keys(s.parts).length, 0));
    expect(measured, "parts that ran").toBeGreaterThan(10);
    expect(recut, "parts cut again").toBe(Object.values(MEASURED.split).filter((s) => s.cancelledPart !== undefined).length);
    expect(recut).toBeGreaterThan(0);
    // THE RULE: when a branch merges, no part is a projection. A part on a pace was never run: dispatch it (mutation.yml, group=<leg>) and record its run
    // in stryker-measured.json as `basis: measured`. A projection missed by up to 1.5x, in the dangerous direction, the one time it was tested.
    expect(partsOnAPace(MEASURED), `${rated} part(s) timed from a projection: run each and record its wall, dry run and phase`).toEqual([]);
  });

  it("a part that has been measured is timed from its own wall, never from a projection: the plan of every one is `measured`, 1.5 x its job's wall, and no `rate` part carries a measurement (T20 step 2b)", () => {
    let seen = 0;
    for (const s of Object.values(MEASURED.split)) {
      for (const [leg, p] of Object.entries(s.parts)) {
        const plan = planOf(leg);
        if (p.basis === "measured") {
          expect(plan.kind, `${leg} ran, so it is timed as a leg that ran`).toBe("measured");
          expect(plan.rawTimeout, `${leg}: ceil(1.5 x ${p.wallSeconds} s)`).toBe(Math.ceil((TIMEOUT_FACTOR * p.wallSeconds) / 60));
          expect(plan.wallMinutes, `${leg}: its wall is the job's, not an estimate`).toBe(p.wallSeconds / 60);
          seen++;
        } else {
          expect(plan.kind, `${leg} has not run`).toBe("rate");
          expect(Object.keys(p), `${leg}: a part that has not run carries no measurement`).toEqual(["mutants", "basis", "phaseSeconds"]);
        }
      }
    }
    expect(seen, "parts timed from their own wall").toBeGreaterThan(10);
  });

  it("splitting a file by range loses a mutant only where a cut falls inside a declaration, and the loss is exactly the mutants whose node spans a cut (T20-PRE: member cuts)", async () => {
    const files = new Map<string, Selected[]>();
    // the probe is not a home (roundrobin.ts is in a draws leg too): a PR runs it alone
    for (const [g, globs] of legs) if (g !== "probe") for (const [f, sel] of selected(ENGINE, globs)) files.set(f, [...(files.get(f) ?? []), sel]);
    let split = 0;
    let ranges = 0;
    let lost = 0;
    const lossByFile: Record<string, number> = {};
    const unscored: Unscored[] = [];
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
      // the expected loss, from the INSTRUMENTER's own locations of the whole file (never from the cuts), see lostBy
      const spanning = lostBy(f, readFileSync(join(ENGINE, f), "utf8"), whole, parts);
      expect(whole.length - sum, `${f}: the mutants lost are the ones whose node spans a cut`).toBe(spanning.length);
      if (spanning.length > 0) lossByFile[f] = spanning.length;
      lost += spanning.length;
      unscored.push(...spanning);
    }
    expect(split, "files split by range").toBeGreaterThanOrEqual(5);
    expect(ranges, "ranges summed").toBeGreaterThan(split);
    // The accepted blind spot, enumerated: a cut BETWEEN statements loses nothing (every other split file is exact), and a
    // cut between the members of one big declaration loses the container's own mutants, the object literal or the function body
    // that holds the cut (a whole range cannot hold them: Stryker keeps a mutant only if its whole node is inside). Measured
    // 2026-10-05 on the cuts committed with this task; a file that starts losing, or loses more, must be argued here.
    // and by NAME, first (its failure carries the list to paste): the committed list is exactly the instrumenter's mutants that no
    // range holds, by file, mutator, replacement and the text of the line they start on
    expect(unscored.map(unscoredKey).sort(), `stryker-unscored.json names exactly the mutants no leg holds\n${unscoredHint(unscored)}`).toEqual(UNSCORED.map(unscoredKey).sort());
    expect(lossByFile, unscoredHint(unscored)).toEqual(MEMBER_CUT_LOSS);
    // the hint is usable: what it prints, pasted, is a list this very pin accepts (a hint that dropped an entry, or a field the key
    // reads, would send the author round the loop twice)
    const pasted = JSON.parse(unscoredHint(unscored).split("from this run):\n")[1] as string) as Unscored[];
    expect(pasted.length, "the hint prints every mutant no leg holds").toBe(unscored.length);
    expect(pasted.map(unscoredKey).sort(), "and a list that satisfies the pin it is for").toEqual(UNSCORED.map(unscoredKey).sort());
    expect(UNSCORED.length, "the list is not empty: member cuts exist, and each one costs its container's mutants").toBeGreaterThan(0);
    expect(new Set(UNSCORED.map(unscoredKey)).size, "no key is listed twice").toBe(UNSCORED.length);
    expect(lost, "mutants no leg holds: as many as the list names").toBe(UNSCORED.length);
  }, INSTRUMENT_BUDGET_MS);

  it("the key's own guards are reached: a mutant outside every statement is refused, a host that declares nothing is named by its place, and mutants alike in every other way are told apart by `nth`", () => {
    const at = (line: number, column: number): Found => ({ mutator: "BlockStatement", replacement: "{}", start: { line, column }, end: { line, column: column + 1 } });
    const text = ["call();", "export function f() {", "  return {", "  };", "}", "export function g() {", "  return {", "  };", "}"].join("\n");
    // outside every statement: line 40 (0-based 39) of a 9-line file
    expect(() => keyedMutants("x.ts", text, [at(39, 0)])).toThrow(/x\.ts:40: a mutant outside every top-level statement/);
    // a statement that declares nothing is `statement N` (N its place among the file's top-level statements)
    expect(keyedMutants("x.ts", text, [at(0, 0)])[0]?.entry.host).toBe("statement 1");
    // two `return {` in two functions differ by host; two in ONE function differ by nth, counted in source order whatever the order given
    const twice = ["export function h() {", "  return {", "  };", "  return {", "  };", "}"].join("\n");
    const keyed = keyedMutants("x.ts", twice, [at(3, 2), at(1, 2)]);
    expect(keyed.map((k) => [k.entry.line, k.entry.nth])).toEqual([[2, 1], [4, 2]]);
    const apart = keyedMutants("x.ts", text, [at(2, 2), at(6, 2)]);
    expect(apart.map((k) => [k.entry.host, k.entry.nth])).toEqual([["f", 1], ["g", 1]]);
    expect(new Set([...keyed, ...apart].map((k) => unscoredKey(k.entry))).size, "all four keys differ").toBe(4);
  });

  it("every listed key names ONE mutant of its file, and the old key (the line's text) named several for some, so the host and the nth do the work (T20 review M4)", async () => {
    const byFile = new Map<string, Unscored[]>();
    for (const u of UNSCORED) byFile.set(u.file, [...(byFile.get(u.file) ?? []), u]);
    let checked = 0;
    let ambiguousBefore = 0;
    for (const [file, listed] of byFile) {
      const keyed = keyedMutants(file, readFileSync(join(ENGINE, file), "utf8"), await mutantsOf(ENGINE, file, "all"));
      expect(keyed.length, `${file}: mutants keyed`).toBeGreaterThan(0);
      expect(new Set(keyed.map((k) => unscoredKey(k.entry))).size, `${file}: no two of its ${keyed.length} mutants share a key`).toBe(keyed.length);
      for (const u of listed) {
        expect(typeof u.host === "string" && u.host !== "" && Number.isInteger(u.nth) && u.nth >= 1, `${unscoredKey(u)}: a host and an nth (an entry keyed on the text alone is ambiguous and refused)`).toBe(true);
        expect(keyed.filter((k) => unscoredKey(k.entry) === unscoredKey(u)), `${unscoredKey(u)} names exactly one mutant of ${file}`).toHaveLength(1);
        if (keyed.filter((k) => bareKey(k.entry) === bareKey(u)).length > 1) ambiguousBefore++;
        checked++;
      }
    }
    expect(checked, "entries checked").toBe(UNSCORED.length);
    expect(ambiguousBefore, "entries the old key could not tell from another mutant of the file (nested/kernel.ts's `return {`)").toBeGreaterThan(0);
  }, INSTRUMENT_BUDGET_MS);

  it("an edit that moves the lines (a comment line at the top, one above the first listed mutant) leaves the list matching: it is keyed on what the source says, not where it is (T20-FIX2, I1')", async () => {
    const byFile = new Map<string, Unscored[]>();
    for (const u of UNSCORED) byFile.set(u.file, [...(byFile.get(u.file) ?? []), u]);
    expect(byFile.size, "the listed files").toBeGreaterThan(1);
    const COMMENT = "// a comment line added by the test";
    let edits = 0;
    for (const [file, listed] of byFile) {
      const anchors = STRYKER_SPLITS[file];
      expect(anchors, `${file} is a split file`).toBeDefined();
      const text = readFileSync(join(ENGINE, file), "utf8");
      const lines = text.split("\n");
      const first = Math.min(...listed.map((u) => u.line));   // 1-based, as of the listing; the comment goes in just above it
      const above = [...lines.slice(0, first - 1), COMMENT, ...lines.slice(first - 1)].join("\n");
      for (const [name, edited] of [["at the top", `${COMMENT}\n${text}`], ["above the first listed mutant", above]] as const) {
        const ranges = resolveSplit(edited, anchors as string[], file);   // the same anchors, resolved on the edited copy
        const lost = lostBy(file, edited, await mutantsOfText(file, edited, "all"), ranges);
        expect(lost.map(unscoredKey).sort(), `${file}, ${name}: the same mutants are lost\n${unscoredHint(lost)}`).toEqual(listed.map(unscoredKey).sort());
        // the premise: the lines DID move, so a list keyed on them would have gone red here (the test can see what it exists for)
        expect(lost.map((u) => u.line).sort((x, y) => x - y), `${file}, ${name}: the edit moved the listed lines`).not.toEqual(listed.map((u) => u.line).sort((x, y) => x - y));
        edits++;
      }
    }
    expect(edits, "edits checked: two for each listed file").toBe(byFile.size * 2);
  }, INSTRUMENT_BUDGET_MS * 3);

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

describe("stryker-timeouts.json is the rule applied to what the full run measured (T15-SIZE, D14, T20 step 2)", () => {
  const timeouts = JSON.parse(readFileSync(join(ENGINE, "stryker-timeouts.json"), "utf8")) as Record<string, number>;
  const all = legs.map(([g]) => g);

  it("one timeout per leg, in the groups' order, each the rule's value for its leg: 1.5 x its wall (or, for a part that has not run, its projected phase), whole minutes, 10 to 300", () => {
    expect(Object.keys(timeouts)).toEqual(all);
    const want = regeneratedTimeouts(all);
    const faults: string[] = [];
    let checked = 0;
    for (const g of all) {
      const f = timeoutFault(g, timeouts[g] as number, want[g] as number);
      if (f !== null) faults.push(f);
      checked++;
    }
    expect(checked, "timeouts checked").toBe(all.length);
    expect(checked).toBeGreaterThan(70);
    expect(faults, `${faults.join("\n")}\n${regenerateHint(all)}`).toEqual([]);
    expect(timeouts, regenerateHint(all)).toEqual(want);
    for (const g of all) {
      expect(timeouts[g] as number, `${g}: at least the floor`).toBeGreaterThanOrEqual(MIN_TIMEOUT_MINUTES);
      expect(timeouts[g] as number, `${g}: at most the cap`).toBeLessThanOrEqual(TIMEOUT_CAP_MINUTES);
    }
  });

  it("a timeout is never below what its leg takes and half again its mutation phase: 1.5 x the wall of a leg that ran, the wall plus half the phase for a part that has not", () => {
    let checked = 0;
    for (const g of all) {
      if (g === "probe") continue;
      const plan = planOf(g);
      const least = plan.kind === "measured" ? plan.wallMinutes * TIMEOUT_FACTOR : plan.wallMinutes + (TIMEOUT_FACTOR - 1) * plan.phaseMinutes;
      expect(timeouts[g] as number, `${g} (${plan.kind}): wall ${plan.wallMinutes.toFixed(1)} min, phase ${plan.phaseMinutes.toFixed(1)} min`).toBeGreaterThanOrEqual(Math.ceil(least));
      expect(timeouts[g] as number, `${g}: and it is never below the wall itself`).toBeGreaterThan(plan.wallMinutes);
      checked++;
    }
    expect(checked, "legs checked").toBe(all.length - 1);
  });

  it("the probe keeps D14's rule from its own hosted sample: 134 mutants, 64 minutes, 96 (it is not a leg of the full run)", () => {
    // typed from the rulebook above (ceil(64 x 1.5) = 96), never from the file under test
    expect(estimateMinutes(PROBE_MUTANTS)).toBe(64);
    expect(probeTimeout()).toBe(96);
    expect(timeouts.probe).toBe(96);
    expect(MEASURED.measured.probe, "the probe was not in the run").toBeUndefined();
    // 96 minutes is above what the hosted run it was measured on took (59.25 min, whole run) with the install and upload around it
    expect(timeouts.probe as number).toBeGreaterThan((HOSTED_DRY_RUN_SECONDS + HOSTED_MUTATION_PHASE_SECONDS) / 60);
  });

  it("the run's own figures are the ones the file records: the run, the sha, the runner and the matrix cap", () => {
    expect(MEASURED.run.id).toBe(37371368951);
    expect(MEASURED.run.sha).toBe("78c7ef3e6");
    expect(MEASURED.run.concurrency, "Stryker's concurrency on the hosted runner").toBe(CI_CONCURRENCY);
    expect(MEASURED.run.maxParallel, "the workflow's max-parallel").toBe(12);
    // each measured leg's own figures are consistent: the wall is at least its dry run and its phase, and a leg has a count
    let checked = 0;
    for (const [g, m] of Object.entries(MEASURED.measured)) {
      expect(m.mutants, `${g} has mutants`).toBeGreaterThan(0);
      expect(m.wallSeconds, `${g}: the job outlasts its dry run and its phase`).toBeGreaterThanOrEqual(m.dryRunSeconds + m.phaseSeconds);
      // and not by much: setup and upload are a minute at most (a leg that took 1.9 min spent 28 s on setup)
      expect(m.wallSeconds - m.dryRunSeconds - m.phaseSeconds, `${g}: setup and upload`).toBeLessThan(120);
      checked++;
    }
    expect(checked, "measured legs checked").toBe(66);
    // a leg measured AGAIN after the first run (its count moved past COUNT_DRIFT, or it outran its timeout) names the run and job that measured it: another
    // run of the workflow, never the first one, so the figures it carries have a log behind them
    let remeasured = 0;
    for (const [g, m] of Object.entries(MEASURED.measured)) {
      if (m.run === undefined) continue;
      expect(Number.isInteger(m.run.id) && m.run.id > 0, `${g}: a run id`).toBe(true);
      expect(Number.isInteger(m.run.job) && m.run.job > 0, `${g}: a job id`).toBe(true);
      expect(m.run.sha, `${g}: the commit it ran`).toMatch(/^[0-9a-f]{9}$/);
      expect(m.run.id, `${g}: a re-measure comes from a later run than the first`).not.toBe(MEASURED.run.id);
      remeasured++;
    }
    expect(remeasured, "legs re-measured after the first run").toBeGreaterThan(0);
    // the re-run of the parts (T20 step 2b): their runs are other runs of the same workflow on later commits, on the same runner
    const sources = new Set<number>();
    for (const s of Object.values(MEASURED.split)) {
      for (const p of Object.values(s.parts)) if (p.basis === "measured") sources.add(p.run.id);
      if (s.cancelledPart !== undefined) sources.add(s.cancelledPart.run.id);
    }
    expect(sources.size, "the runs the parts were measured in, one each").toBeGreaterThan(10);
    expect(sources.has(MEASURED.run.id), "none of them is the first run").toBe(false);
  });
});

describe("a failing timeouts file tells its author what to write (FINAL-FIX M3)", () => {
  it("a map with a timeout too high, one too low and one right names exactly the two, and the hint it prints is a file that passes", () => {
    const names = ["competition-1", "modules-3", "sports-cricket-10", "sports-period-1", "sports-period-13", "probe"];
    const ok = regeneratedTimeouts(names);
    // by hand from the measurements: competition-1 took 45.5 min -> 69; modules-3 took 1 minute -> the floor, 10; the first half of
    // sports-cricket-10 RAN, 6,430 s -> 9,645 s = 160.75 min -> 161; sports-period-1's first part RAN, 6,660 s -> 9,990 s = 166.5 min -> 167;
    // sports-period-13 RAN (job 112668660780: 06:49:06 to 08:39:40, 6,634 s) -> 9,951 s = 165.85 min -> 166; the probe 96
    // (a part that has not run is worked by hand in "the bootstrap of a NEW cut" above)
    expect(ok).toEqual({ "competition-1": 69, "modules-3": 10, "sports-cricket-10": 161, "sports-period-1": 167, "sports-period-13": 166, probe: 96 });
    const doctored = { ...ok, "competition-1": (ok["competition-1"] as number) + 120, "sports-cricket-10": (ok["sports-cricket-10"] as number) - 1 };
    const faults = Object.entries(doctored).flatMap(([g, t]) => timeoutFault(g, t, ok[g] as number) ?? []);
    expect(faults.map((f) => f.split(":")[0])).toEqual(["competition-1", "sports-cricket-10"]);
    // a fraction is a fault of its own
    expect(timeoutFault("x", 10.5, 11)).toMatch(/not a whole number/);
    // the hint carries the regenerated file whole, so the author pastes rather than derives
    const hint = regenerateHint(names);
    expect(hint).toContain("stryker-timeouts.json");
    expect(JSON.parse(hint.slice(hint.indexOf("{")))).toEqual(ok);
    expect(Object.entries(ok).flatMap(([g, t]) => timeoutFault(g, t, ok[g] as number) ?? [])).toEqual([]);
    expect(Object.keys(ok).length, "legs regenerated").toBe(6);
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
  // negation and then a range of the negated file (the order Stryker reads them in), two sports' tails, a leg that holds
  // the ranges of two different files, and (T20 step 2) the legs cut by an `if#N` ordinal anchor and by a member cut, which no
  // other leg is: a real Stryker must read the range the parser resolved from them as the instrumenter does.
  // `sports-period-13` is cut at an ordinal anchor at BOTH ends (`arbitraryEvent.if#2` .. `if#7`: T20 step 2b), so a real Stryker reads two of them.
  const probed = ["sports-cricket-2", "competition-2", "sports-football-5", "sports-setbased-1", "sports-nested-1", "sports-period-3", "sports-football-8", "sports-nested-6", "sports-period-13"];

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
// ceiling it gave, and stayed that way after T20-PRE pinned 77 and 454. T20 step 2 retired those in turn (the run measured each leg),
// and a comment cannot fail a test, so the figures the notes quote are held to the measured ones here, and the retired ones are
// refused by name.
describe("the comments that quote the sizing quote the measured figures (T20-FIX1, M2; T20 step 2)", () => {
  const read = (f: string): string => readFileSync(join(ENGINE, f), "utf8");
  /** Every file whose comments speak of the rate, the ceiling, the timeouts' calibration or what a cut loses. */
  const NOTES = ["stryker.groups.mjs", "stryker.config.mjs", "scripts/stryker-matrix.mjs", "scripts/stryker-cuts.mjs", "../../.github/workflows/mutation.yml", "test/stryker-cuts.test.ts", "../../tools/matrix/__tests__/matrix-workflow.test.ts"];
  /** What the notes said before the measurements: each phrase is a claim the measured figures falsify. */
  const RETIRED: [RegExp, string][] = [
    [/\(69, about 3 hours each/, "69 legs of about 3 hours each (79 legs of about 1.6 hours since the run was cut again)"],
    [/about 17 hours \(about 25 at 8\)/, "a dispatch of about 17 hours (about 25 at 8): the measured walls give the figures the test below derives"],
    [/about 11 hours/, "an uncapped dispatch of about 11 hours (derived below from the measured walls)"],
    [/\(69 of them/, "69 legs in a dispatch (81 now)"],
    [/441 minutes alone/, "cricket's module object as 441 minutes at the retired rate of 77 runner-seconds a mutant"],
    [/\b26 runner-second/, "the local rate of 26 runner-seconds per mutant"],
    [/1,344/, "the 1,344-mutant ceiling that rate gave"],
    [/not yet calibrated/i, "timeouts 'not yet calibrated on a hosted runner' (run 37371368951 measured every leg)"],
    [/further x2/, "the probe's x2 allowance (retired: its timeout is by the same rule as every leg's)"],
    [/Task 20 re-measures/, "'Task 20 re-measures' (the hosted measurement is in)"],
    [/\(26\)/, "the local rate quoted as the rate the timeouts rest on"],
    [/or lose a mutant to it/, "'a part cannot lose a mutant' stated of every part (member cuts lose 14: stryker-unscored.json)"],
    [/77 runner-seconds/, "the probe's rate as every leg's rate (each leg's own wall was measured: 0.3 to 114 runner-seconds a mutant)"],
    [/454 mutants/, "the 454-mutant ceiling (a leg is held to the 200-minute line by what it measured)"],
    [/predicted minutes/, "timeouts from 'predicted minutes' (they are 1.5 x what each leg measured)"],
    [/There are 9 of them/, "9 member-cut losses (14 now: stryker-unscored.json)"],
    [/ONE sample/, "'ONE sample' (the full run replaced it)"],
    [/fitted cost/, "a part timed from 'the fitted cost' of its mutants (the 17 parts were RUN; only a part that has not run is projected, from a pace)"],
    [/share of the leg's measured phase/, "a part timed from its 'share of the leg's measured phase' (every part that has run is timed from its own wall)"],
    [/costModel/, "the cost model (deleted with the report-basis projections it timed)"],
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

  it("the fan-out figures the workflow and its test quote (legs, hours each, a dispatch's wall at the org's slots, at 12, at 8) are the ones the measured walls give (T20 review M1)", () => {
    /** The org's concurrent hosted jobs, account-wide (GitHub Free; ruling T20-FIX1): what an uncapped dispatch can hold. */
    const ORG_SLOTS = 20;
    const order = Object.keys(STRYKER_GROUPS).filter((g) => g !== "probe");
    const walls = order.map((g) => planOf(g).wallMinutes);
    /** The wall of a queue served first come first served by `slots` runners, in hours (a job takes the slot that frees first). */
    const fifoHours = (minutes: readonly number[], slots: number): number => {
      const free = new Array<number>(slots).fill(0);
      for (const m of minutes) {
        const at = free.indexOf(Math.min(...free));
        free[at] = (free[at] as number) + m;
      }
      return Math.max(...free) / 60;
    };
    const hours = (h: number): string => String(Math.round(h * 10) / 10);
    const jobHours = walls.reduce((n, m) => n + m, 0) / 60;
    const figure = { legs: order.length, each: hours(jobHours / order.length), jobHours: String(Math.round(jobHours)), all: hours(fifoHours(walls, ORG_SLOTS)), at12: hours(fifoHours(walls, MEASURED.run.maxParallel)), at8: hours(fifoHours(walls, 8)) };
    expect(figure.legs, "legs in a dispatch of `all`").toBe(81);
    // the figures differ from one another, so a note that quoted one for another would be wrong
    expect(new Set([figure.all, figure.at12, figure.at8]).size, "three different walls").toBe(3);
    const workflow = read("../../.github/workflows/mutation.yml");
    for (const phrase of [`(${figure.legs}, about ${figure.each} hours each, ${figure.jobHours} job-hours`, `for about ${figure.all} hours`, `takes about ${figure.at12} hours (about ${figure.at8} at 8)`]) {
      expect(workflow, `mutation.yml quotes "${phrase}"`).toContain(phrase);
    }
    const pin = read("../../tools/matrix/__tests__/matrix-workflow.test.ts");
    for (const phrase of [`${figure.legs} legs, about ${figure.each} hours each`, `for about ${figure.all} hours`, `takes about ${figure.at12} hours instead of about ${figure.at8} at 8`]) {
      expect(pin, `matrix-workflow.test.ts quotes "${phrase}"`).toContain(phrase);
    }
  });

  it("the notes quote the run the timeouts come from, and the cuts note says what a member cut never scores", () => {
    const groups = read("stryker.groups.mjs");
    expect(groups, "the run the sizing rests on").toContain(String(MEASURED.run.id));
    expect(groups, "and its sha").toContain(MEASURED.run.sha);
    expect(groups, "the file that records it").toContain("stryker-measured.json");
    expect(groups, "the split line").toContain("200 minutes");
    expect(groups, "member cuts are named where cuts are described").toMatch(/member/i);
    expect(groups, "and the list of what they never score").toContain("stryker-unscored.json");
    expect(groups, `the loss the list holds (${UNSCORED.length})`).toContain(`There are ${UNSCORED.length} of them`);
    const workflow = read("../../.github/workflows/mutation.yml");
    expect(workflow, "the workflow header names the run").toContain(String(MEASURED.run.id));
    expect(workflow, "and the file the timeouts are derived from").toContain("stryker-measured.json");
    const matrix = read("scripts/stryker-matrix.mjs");
    expect(matrix, "the matrix note names the run").toContain(String(MEASURED.run.id));
    const cuts = read("scripts/stryker-cuts.mjs");
    expect(cuts, "the cuts note says never scored").toMatch(/never scored/);
    expect(cuts, "and where the list is").toContain("stryker-unscored.json");
    expect(cuts, "the cuts note documents the `if#3` anchor").toContain("if#3");
  });
});
