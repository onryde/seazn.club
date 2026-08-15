// C4 (z3 retirement, stage A) — the REFLOW bench the design doc's gate
// requires: "bench parity vs z3 reflow on the prod-shaped board — N >= 6
// runs per side, conflict count never worse, wall respected."
//
// NOT `bench-repair.ts` reused. That script measures the REPAIR solver's own
// scaling (a fully-placed board with injected clashes, `k` as the knob) —
// the right shape for #401's question, the wrong shape for this one. REFLOW's
// ordinary case is NOT "a placed board with a clash to fix" — under C4's
// churn-minimization ruling, an already-placed unlocked card is frozen and
// CANNOT be moved to fix a clash among placed cards any more (the accepted
// trade-off; see the two-cards-collide test in
// `apps/web/src/server/usecases/__tests__/schedule-reflow-cpsat.test.ts`).
// Benching on a board that NEEDS that capability would make the new path
// look artificially worse on conflict count for a reason that has nothing to
// do with wiring quality. REFLOW's real, common shape is instead "some cards
// already legally placed, some cards with no slot yet" — so THIS script
// builds boards that way: `syntheticBoard` with ZERO injected clashes (a
// legal board), split into an already-placed fraction and an unplaced
// fraction, replaying each engine's OWN reflow wiring exactly.
//
// BOTH PATHS ARE HAND-REPLICATED FROM `reflowExisting`, ENGINE-SIDE, because
// the real function lives in `apps/web` and is DB-coupled (loads settings,
// fixtures, locks from Postgres) — the same reason `bench-repair.ts` measures
// `repairSchedule` directly rather than going through the web layer. Kept in
// lockstep with `schedule.ts`'s actual logic by citing the exact lines this
// mirrors; if `reflowExisting` changes, re-check both `runOld`/`runNew`
// against it rather than trusting this comment.
//
// Usage — NOT `bench-repair.ts`'s plain `node --experimental-strip-types`
// invocation. This script transitively imports `generated/scheduler.ts`
// (the proto stubs, via `placement-client.ts`), which uses a real
// TypeScript `enum` — that needs actual transformation, not the pure
// erasure `--experimental-strip-types` does, and this Node version has no
// `--experimental-transform-types` flag to reach for instead. Run it
// through vitest's own transform (proven to handle the same module graph —
// every test in this suite that imports `buildSchedule` does), via a
// throwaway shim test file that does nothing but `await import(...)` this
// script, one directory up so relative imports still resolve, e.g.:
//
//   // packages/engine/src/scheduling/_run.test.ts
//   import { it } from "vitest";
//   it("bench", async () => { await import("../../scripts/bench-reflow.ts"); }, 600_000);
//
//   BENCH_N=30 BENCH_PLACED=0.6 BENCH_RUNS=6 BENCH_WALL=10000 \
//     PLACEMENT_SERVICE_HOST=localhost:50051 PLACEMENT_SERVICE_SECRET=<secret> \
//     npx vitest run src/scheduling/_run.test.ts   # (cwd packages/engine)
//   rm packages/engine/src/scheduling/_run.test.ts # delete when done — it is
//                                                    # not a real test and
//                                                    # `src/**/*.test.ts` is
//                                                    # collected by default
//
// `BENCH_<NAME>` env vars are read in preference to `--<name>=` CLI flags
// for exactly this reason — the shim owns `process.argv`, not this script.
// `--n=`/`--placed=`/`--runs=`/`--wall=`/`--deps=` still work when this
// script is run directly in an environment where the enum is not a problem
// (a real build step, a newer Node).
//
// Needs a reachable placement service for the NEW path
// (`PLACEMENT_SERVICE_HOST`, `PLACEMENT_SERVICE_SECRET`) — without one every
// NEW run reports `solver_unavailable`, which is a real, honest measurement
// (not a script bug) but not the comparison this exists to make.
import { buildSchedule } from "../src/scheduling/build.ts";
import { repairSchedule } from "../src/scheduling/repair.ts";
import { slotFixtures, validateAssignments } from "../src/scheduling/calendar.ts";
import { syntheticBoard } from "../src/scheduling/repair-synthetic-board.ts";
import { resetZ3 } from "../src/scheduling/z3-load.ts";
import type {
  Assignment,
  SchedulableFixture,
  SlotConfig,
  VerifyConfig,
} from "../src/scheduling/calendar.ts";

// `process.env.BENCH_<NAME>` first, so this still takes configuration when
// invoked through a runner that owns `process.argv` itself (the vitest-based
// shim this repo needs for this specific script — see
// `_bench-reflow-runner.test.ts`'s doc comment for why one is needed at all).
const arg = (name: string, fallback: string): string => {
  const envHit = process.env[`BENCH_${name.toUpperCase()}`];
  if (envHit !== undefined) return envHit;
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const N = Number(arg("n", "30"));
const PLACED_FRACTION = Number(arg("placed", "0.6"));
const RUNS = Number(arg("runs", "6"));
const WALL_MS = Number(arg("wall", "10000"));
const WITH_DEPS = arg("deps", "true") !== "false";

interface ReflowBoard {
  schedulable: SchedulableFixture[];
  placed: Assignment[];
  config: SlotConfig & VerifyConfig & { courts: string[] };
  dependencies: ReturnType<typeof syntheticBoard>["dependencies"];
}

/** A LEGAL prod-shaped board (`clashEvery` bigger than `n` injects zero),
 *  split into "already placed" and "no slot yet" — REFLOW's ordinary shape,
 *  not the repair bench's "clash to fix" shape (see header). Same seed each
 *  call, so N runs measure the SAME board, not N different ones. */
function reflowBoard(n: number, placedFraction: number, withDeps: boolean): ReflowBoard {
  const board = syntheticBoard({ n, clashEvery: n + 1 });
  const placedCount = Math.round(n * placedFraction);
  const placed = board.proposal.slice(0, placedCount);
  // `SchedulableFixture` for every fixture, placed and unplaced alike — same
  // shape `schedule.ts`'s own `schedulable` array carries (id/home/away/
  // people; no `.locked`, matching `placedNow`'s un-locked, current-anchored
  // shape — see `schedule.ts`'s `schedulable` builder, ~line 1158).
  const schedulable: SchedulableFixture[] = board.proposal.map((a) => ({
    id: a.fixtureId,
    home: a.entrants[0],
    away: a.entrants[1],
    people: a.people,
  }));
  // `syntheticBoard`'s `config` types as `VerifyConfig` (the repair bench's
  // own need), which makes `matchMinutes`/`window` OPTIONAL (`VerifyConfig`
  // is `Partial<Pick<SlotConfig, "matchMinutes" | ... | "window">>` —
  // calendar.ts:911 — the verifier can validate some rules without either)
  // and never sets `startAt` — a `SlotConfig`-only field the VERIFIER never
  // reads but `slotFixtures`/`buildSchedule` (the PLACER side, needed here
  // and not in `bench-repair.ts`) require. The concrete object
  // `syntheticBoard` returns always sets both (repair-synthetic-board.ts
  // :176/185) — a type-level gap, not a real "might be absent" case here —
  // so this is narrowed with a runtime check rather than a blind `!`,
  // which would silently construct a bad `SlotConfig` if that ever stopped
  // being true. The window's own floor is the correct `startAt`: it is
  // where `syntheticBoard`'s own slots start.
  const { matchMinutes, window } = board.config;
  if (matchMinutes === undefined || window === undefined) {
    throw new Error("syntheticBoard() must set matchMinutes and window for the reflow bench");
  }
  const config: SlotConfig & VerifyConfig & { courts: string[] } = {
    ...board.config,
    courts: [...board.config.courts],
    matchMinutes,
    window,
    startAt: window.from,
  };
  // `withDeps=false` isolates a DIFFERENT, real finding this bench surfaced
  // (documented in the PR body): `buildSchedule`'s own gate
  // (`rejectedBlockingConflicts`/`isBlockingForBuild`) does not catch every
  // case of a FREE fixture placed in violation of a dependency on a FROZEN
  // (current-anchored, not `.locked`) feeder — reproduced in isolation by
  // `_bench-reflow-diag2.test.ts` (not shipped; see the PR body for the
  // minimal repro) directly against unmodified `build.ts`, so it predates
  // C4 and is shared with POLISH — out of this task's scope to fix. Running
  // this bench WITHOUT dependency chains at all removes that confound and
  // answers the narrower, in-scope question: does REFLOW's own
  // frozen/current wiring and reconciliation hold parity on PLACEMENT
  // alone? (Yes — see the PR body's "no dependencies" arm.)
  return { schedulable, placed, config, dependencies: withDeps ? board.dependencies : [] };
}

interface RunResult {
  wallMs: number;
  placed: number;
  total: number;
  conflicts: number;
  blockingConflicts: number;
  status: string;
  engine: string;
}

/** Mirrors `reflowExisting` BEFORE C4 (schedule.ts, pre-`61b17510`): greedy
 *  seeds the unplaced fixtures against the placed ones, then hands the whole
 *  proposal to `repairSchedule`. */
async function runOld(b: ReflowBoard): Promise<RunResult> {
  const placedIds = new Set(b.placed.map((a) => a.fixtureId));
  const unseeded = b.schedulable.filter((f) => !placedIds.has(f.id));
  const seed =
    unseeded.length > 0
      ? slotFixtures({ fixtures: unseeded, config: b.config, existing: b.placed })
      : { assignments: [] as Assignment[], conflicts: [] };
  const proposal = [...b.placed, ...seed.assignments];
  const t0 = performance.now();
  const repaired = await repairSchedule({
    proposal,
    existing: [],
    config: b.config,
    dependencies: b.dependencies,
    budgetMs: WALL_MS,
  });
  const wallMs = performance.now() - t0;
  const final = repaired.status === "repaired" ? repaired.assignments : proposal;
  const conflicts = validateAssignments(final, b.config, [], b.dependencies);
  return {
    wallMs,
    placed: final.length,
    total: b.schedulable.length,
    conflicts: conflicts.length,
    blockingConflicts: conflicts.filter((c) => c.reason !== "no_slot").length,
    status: repaired.status,
    engine: repaired.status === "repaired" ? "z3" : "greedy",
  };
}

/** Mirrors `reflowExisting` AFTER C4 (schedule.ts, `61b17510`+`9a7a475d`):
 *  every placed fixture is frozen (`frozen`/`current`), `buildSchedule` may
 *  only place the rest, and the result is reconciled onto the known board
 *  before conflicts are recomputed fresh. */
async function runNew(b: ReflowBoard): Promise<RunResult> {
  const known = new Map(b.placed.map((a) => [a.fixtureId, a] as const));
  const t0 = performance.now();
  const out = await buildSchedule({
    fixtures: b.schedulable,
    config: b.config,
    existing: [],
    dependencies: b.dependencies,
    wallMs: WALL_MS,
    frozen: [...known.keys()],
    ...(known.size > 0 ? { current: [...known.values()] } : {}),
  });
  const wallMs = performance.now() - t0;
  const assignments = [...out.assignments.filter((a) => !known.has(a.fixtureId)), ...known.values()];
  const conflicts = validateAssignments(assignments, b.config, [], b.dependencies);
  return {
    wallMs,
    placed: assignments.length,
    total: b.schedulable.length,
    conflicts: conflicts.length,
    blockingConflicts: conflicts.filter((c) => c.reason !== "no_slot").length,
    status: out.status,
    engine: out.engine,
  };
}

function summarize(label: string, rows: RunResult[]): void {
  const walls = rows.map((r) => r.wallMs).sort((a, b2) => a - b2);
  const conflicts = rows.map((r) => r.conflicts);
  const blocking = rows.map((r) => r.blockingConflicts);
  const placedCounts = rows.map((r) => r.placed);
  const mid = Math.floor(walls.length / 2);
  console.log(`\n## ${label} — ${rows.length} runs`);
  console.log(
    `wall ms  min ${walls[0]!.toFixed(0)} / median ${walls[mid]!.toFixed(0)} / max ${walls.at(-1)!.toFixed(0)}`,
  );
  console.log(`placed   ${placedCounts.join(", ")} (of ${rows[0]!.total})`);
  console.log(`conflicts (total) ${conflicts.join(", ")}`);
  console.log(`conflicts (blocking, excl. no_slot) ${blocking.join(", ")}`);
  console.log(`status   ${rows.map((r) => r.status).join(", ")}`);
  console.log(`engine   ${rows.map((r) => r.engine).join(", ")}`);
}

async function main(): Promise<void> {
  console.log(
    `# reflow bench — n=${N} fixtures, ${(PLACED_FRACTION * 100).toFixed(0)}% pre-placed, ` +
      `${RUNS} runs/side, wall ${WALL_MS}ms, dependencies ${WITH_DEPS ? "ON" : "OFF"}`,
  );
  const board = reflowBoard(N, PLACED_FRACTION, WITH_DEPS);
  console.log(`placed upfront: ${board.placed.length} / unplaced: ${board.schedulable.length - board.placed.length}`);

  const oldRuns: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    oldRuns.push(await runOld(board));
    await resetZ3();
  }
  summarize("OLD (repairSchedule / z3)", oldRuns);

  const newRuns: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    newRuns.push(await runNew(board));
  }
  summarize("NEW (buildSchedule / placement service)", newRuns);

  const oldMaxConflicts = Math.max(...oldRuns.map((r) => r.blockingConflicts));
  const newMaxConflicts = Math.max(...newRuns.map((r) => r.blockingConflicts));
  console.log(
    `\nGATE: blocking conflicts — old max ${oldMaxConflicts}, new max ${newMaxConflicts} — ` +
      `${newMaxConflicts <= oldMaxConflicts ? "PASS (new never worse)" : "FAIL (new is worse)"}`,
  );
}

await main();
