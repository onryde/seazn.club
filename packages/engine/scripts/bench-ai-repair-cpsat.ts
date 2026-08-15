// C5 (z3 retirement, stage B) — the AI-repair bench the design doc's gate
// requires: "repair bench not worse [...] gate on conflict counts from the
// verifier, not on the bench alone."
//
// NOT `bench-repair.ts` reused, and NOT `bench-reflow.ts` either. `bench-
// repair.ts` benches raw `repairSchedule` against a synthetic board — the
// bare z3 primitive, not `repairDecomposed`/`solveBoard`'s actual call
// shape, and (its own doc, `repair-synthetic-board.ts:28`) it omits hard
// instruction rules on purpose, so identical `k` on both arms would NOT
// prove a hard-rule regression didn't happen — hence "gate on the verifier's
// conflict counts, never on the bench number alone" in the design doc.
// `bench-reflow.ts` benches REFLOW's shape (some cards already placed
// legally, some with no slot yet, zero injected clashes) — the wrong shape
// for THIS question, which is "a board with genuine conflicts to fix".
//
// THIS script's board is `syntheticBoard({n, clashEvery})` WITH clashes
// injected (unlike bench-reflow.ts's `clashEvery: n + 1`) — the repair
// round's actual shape: some fixtures blocking, most not. Violators are
// computed the SAME way schedule-ai.ts's repair round computes them
// (`validateAssignments(...).filter(isBlockingConflict)`, both ends of a
// pairwise conflict via `fixtureId` + `details.otherFixtureId`); everything
// else is frozen. Both arms are HAND-REPLICATED, engine-side, because the
// real `solveBoard` (`apps/web/src/server/usecases/schedule-ai-solver.ts`)
// is apps/web-coupled (server-only, next.js) the same reason `reflowExisting`
// is DB-coupled — see `bench-reflow.ts`'s identical note. Kept in lockstep by
// citing the exact logic this mirrors; if `solveBoard` changes, re-check
// `runNew` against it rather than trusting this comment.
//
// Usage — same vitest-shim requirement as `bench-reflow.ts` (this script
// transitively imports the proto stubs via `placement-client.ts`, which use
// a real TS `enum`; `--experimental-strip-types` cannot erase that):
//
//   // packages/engine/src/scheduling/_run.test.ts
//   import { it } from "vitest";
//   it("bench", async () => { await import("../../scripts/bench-ai-repair-cpsat.ts"); }, 600_000);
//
//   BENCH_N=30 BENCH_CLASH_EVERY=6 BENCH_RUNS=6 BENCH_WALL=10000 \
//     PLACEMENT_SERVICE_HOST=localhost:50051 PLACEMENT_SERVICE_SECRET=<secret> \
//     npx vitest run src/scheduling/_run.test.ts   # (cwd packages/engine)
//   rm packages/engine/src/scheduling/_run.test.ts # delete when done
//
// Needs a reachable placement service for the NEW path — without one every
// NEW run reports `solver_unavailable` (an honest measurement, not the
// comparison this exists to make).
import { buildSchedule } from "../src/scheduling/build.ts";
import { repairDecomposed } from "../src/scheduling/repair-decompose.ts";
import { isBlockingConflict, validateAssignments } from "../src/scheduling/calendar.ts";
import { syntheticBoard } from "../src/scheduling/repair-synthetic-board.ts";
import { resetZ3 } from "../src/scheduling/z3-load.ts";
import type { Assignment, SchedulableFixture, SlotConfig, VerifyConfig } from "../src/scheduling/calendar.ts";

const arg = (name: string, fallback: string): string => {
  const envHit = process.env[`BENCH_${name.toUpperCase()}`];
  if (envHit !== undefined) return envHit;
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const N = Number(arg("n", "30"));
const CLASH_EVERY = Number(arg("clash_every", "6"));
const RUNS = Number(arg("runs", "6"));
const WALL_MS = Number(arg("wall", "10000"));

interface RepairBoard {
  fixtures: SchedulableFixture[];
  board: Assignment[];
  frozenIds: string[];
  config: SlotConfig & VerifyConfig & { courts: string[] };
  dependencies: ReturnType<typeof syntheticBoard>["dependencies"];
  injectedClashes: number;
}

/** A board WITH genuine conflicts — the AI repair round's actual shape,
 *  unlike bench-reflow.ts's zero-clash board. Violators computed exactly the
 *  way `schedule-ai.ts`'s repair round computes them. Same seed every call,
 *  so N runs per side measure the SAME board. */
function repairBoard(n: number, clashEvery: number): RepairBoard {
  const sb = syntheticBoard({ n, clashEvery });
  const { matchMinutes, window } = sb.config;
  if (matchMinutes === undefined || window === undefined) {
    throw new Error("syntheticBoard() must set matchMinutes and window for the repair bench");
  }
  const config: SlotConfig & VerifyConfig & { courts: string[] } = {
    ...sb.config,
    courts: [...sb.config.courts],
    matchMinutes,
    window,
    startAt: window.from,
  };
  const fixtures: SchedulableFixture[] = sb.proposal.map((a) => ({
    id: a.fixtureId,
    home: a.entrants[0],
    away: a.entrants[1],
    people: a.people,
  }));
  const conflicts = validateAssignments(sb.proposal, config, [], sb.dependencies);
  const violatorIds = new Set<string>();
  for (const c of conflicts.filter(isBlockingConflict)) {
    violatorIds.add(c.fixtureId);
    if (c.details?.otherFixtureId !== undefined) violatorIds.add(c.details.otherFixtureId);
  }
  const frozenIds = fixtures.map((f) => f.id).filter((id) => !violatorIds.has(id));
  return { fixtures, board: sb.proposal, frozenIds, config, dependencies: sb.dependencies, injectedClashes: sb.clashes };
}

interface RunResult {
  wallMs: number;
  conflicts: number;
  blockingConflicts: number;
  status: string;
  engine: string;
  moved: number;
}

/** Mirrors `solveBoard` BEFORE C5 (`schedule-ai-solver.ts`, pre-cutover):
 *  the WHOLE board handed to `repairDecomposed` as `proposal`, no
 *  `frozen`/violator split — z3 finds its own minimal fix. */
async function runOld(b: RepairBoard): Promise<RunResult> {
  const t0 = performance.now();
  const repaired = await repairDecomposed({
    proposal: b.board,
    existing: [],
    dependencies: b.dependencies,
    config: b.config,
    budgetMs: WALL_MS,
  });
  const wallMs = performance.now() - t0;
  const final = repaired.status === "unrepaired" ? b.board : repaired.assignments;
  const conflicts = validateAssignments(final, b.config, [], b.dependencies);
  return {
    wallMs,
    conflicts: conflicts.length,
    blockingConflicts: conflicts.filter(isBlockingConflict).length,
    status: repaired.status,
    engine: repaired.status === "unrepaired" ? "greedy" : "z3",
    moved: repaired.k,
  };
}

/** Mirrors `solveBoard` AFTER C5: violators free, everything else frozen
 *  (`frozen`/`current`), `buildSchedule` may only place the violators, and
 *  the result is reconciled onto the known board before conflicts are
 *  recomputed fresh — identical shape to `reflowExisting`'s own
 *  reconciliation (C4). */
async function runNew(b: RepairBoard): Promise<RunResult> {
  const known = new Map(b.board.map((a) => [a.fixtureId, a] as const));
  const t0 = performance.now();
  const out = await buildSchedule({
    fixtures: b.fixtures,
    config: b.config,
    existing: [],
    dependencies: b.dependencies,
    wallMs: WALL_MS,
    frozen: b.frozenIds,
    current: b.board,
  });
  const wallMs = performance.now() - t0;
  const frozenSet = new Set(b.frozenIds);
  const assignments = [
    ...out.assignments.filter((a) => !frozenSet.has(a.fixtureId)),
    ...b.frozenIds.map((id) => known.get(id)!),
  ];
  const conflicts = validateAssignments(assignments, b.config, [], b.dependencies);
  const moved = b.fixtures
    .map((f) => f.id)
    .filter((id) => !frozenSet.has(id))
    .filter((id) => {
      const after = assignments.find((a) => a.fixtureId === id);
      const before = known.get(id);
      return after !== undefined && (before === undefined || before.court !== after.court || before.startAt !== after.startAt);
    }).length;
  return {
    wallMs,
    conflicts: conflicts.length,
    blockingConflicts: conflicts.filter(isBlockingConflict).length,
    status: out.status,
    engine: out.engine,
    moved,
  };
}

function summarize(label: string, rows: RunResult[]): void {
  const walls = rows.map((r) => r.wallMs).sort((a, b2) => a - b2);
  const mid = Math.floor(walls.length / 2);
  console.log(`\n## ${label} — ${rows.length} runs`);
  console.log(
    `wall ms  min ${walls[0]!.toFixed(0)} / median ${walls[mid]!.toFixed(0)} / max ${walls.at(-1)!.toFixed(0)}`,
  );
  console.log(`conflicts (total)             ${rows.map((r) => r.conflicts).join(", ")}`);
  console.log(`conflicts (blocking)          ${rows.map((r) => r.blockingConflicts).join(", ")}`);
  console.log(`moved                         ${rows.map((r) => r.moved).join(", ")}`);
  console.log(`status                        ${rows.map((r) => r.status).join(", ")}`);
  console.log(`engine                        ${rows.map((r) => r.engine).join(", ")}`);
}

async function main(): Promise<void> {
  console.log(
    `# AI-repair bench (C5) — n=${N} fixtures, clash every ${CLASH_EVERY}, ${RUNS} runs/side, wall ${WALL_MS}ms`,
  );
  const board = repairBoard(N, CLASH_EVERY);
  console.log(
    `injected clashes: ${board.injectedClashes} / frozen (non-violator): ${board.frozenIds.length} / free: ${board.fixtures.length - board.frozenIds.length}`,
  );

  const oldRuns: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    oldRuns.push(await runOld(board));
    await resetZ3();
  }
  summarize("OLD (repairDecomposed / z3)", oldRuns);

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
  console.log(
    "NOTE: this board omits hard instruction rules (repair-synthetic-board.ts's own scope limit, " +
      "#455) — identical blocking-conflict counts above do NOT by themselves prove hard-rule parity; " +
      "see the PR body for what closes that gap.",
  );
}

await main();
