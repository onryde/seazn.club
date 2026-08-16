// The z3 retirement's stage-C ledger, as a gate rather than a PR comment.
//
// Stage A (REFLOW onto CP-SAT, `edd358af`) and stage B (the AI repair round,
// `8b85ab39`) moved every production caller off z3. Stage C's job was the
// prose left behind: comments that still told a reader z3 was the live solver.
// Two things have to hold after it, and neither is visible to a type checker.
//
//  1. THE CLAIMS DO NOT COME BACK. Each entry in `RETIRED_CLAIMS` was a live
//     sentence in this repo that asserted something false about today's code.
//     They are guarded as literal text, because that is what a prose
//     regression IS — the same sentence reappearing, usually copied from a
//     sibling file (six of the fifteen below were already copy-paste
//     duplicates of one another when stage C found them).
//
//  2. THE REMAINING HITS STAY ENUMERATED. `LIVE_TREE_Z3_FILES` is the list
//     stage D (C7, the persisted/public enum values) and stage E (C8, the
//     solver itself) inherit. C8's acceptance asks for exactly this list; it
//     is cheaper to keep it true continuously than to reconstruct it later.
//
// WHY THIS IS NOT THE REPO'S "union assertion closes nothing" ANTI-PATTERN:
// the list below is a LITERAL, not a set computed from the observation. A file
// that starts mentioning z3 is not silently absorbed into an exempt bucket —
// it fails. A listed file that stops mentioning z3 fails too, so C7/C8 cannot
// shrink the code and leave the ledger claiming coverage it no longer has.
//
// History is deliberately out of scope. `docs/**`, `.claude/**` and the
// `design/**` screenshot tree record what was decided and when; a retirement
// does not get to rewrite them. (`design/**` is also where `git grep -a` finds
// "z3" inside PNG bytes — 60 files of pure noise, excluded by path, not by a
// binary heuristic that would also skip real source.)
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/**
 * The trees a developer reads to learn how scheduling works TODAY.
 *
 * This file excludes itself, and the reason is worth keeping: it quotes every
 * retired claim verbatim, so it is the single densest z3 hit in the repo. It
 * did not need excluding while it was UNTRACKED — `git grep` searches tracked
 * content only, so the ledger passed until the first commit and failed
 * immediately after. Same trap took out an earlier draft of the positive
 * control below. An empty `git grep` result is not evidence a file is clean;
 * it can equally mean git has never heard of it.
 */
const LIVE_TREES = [
  "packages/engine/src",
  "apps/web/src",
  "apps/web/e2e",
  "scripts",
  "proto",
  "services/placement/src",
  ":!scripts/__tests__/z3-retirement-drift.test.ts",
];

/**
 * A sentence that was true before the CP-SAT cutover and is false now, with
 * what replaced it — so a future reader gets the correction, not just a red.
 *
 * EACH CLAIM IS ANCHORED TO THE FILE IT LIVED IN, and that is not decoration.
 * The first draft of this gate matched the bare phrases repo-wide and flagged
 * four legitimate uses: `build.ts:2112` and `smoke.ts:8391` contrast the z3
 * path in the PAST tense (accurate, and worth keeping), `repair-cpsat-harness`
 * really does bridge the z3 repair solver, and a placement test cites the same
 * INFEASIBLE sentence as the rationale for its own case. A prose gate that
 * cannot tell "z3 did this" from "z3 does this" is a nuisance, not a guard.
 *
 * Patterns are POSIX ERE and match within one line — `git grep` is line-based,
 * and several of these claims wrap, so each anchor is the half that survives
 * on a line of its own.
 */
const RETIRED_CLAIMS: readonly { path: string; pattern: string; nowTrue: string }[] = [
  {
    path: "apps/web/src/server/usecases/__tests__/schedule-ai-provider.test.ts",
    pattern: "the z3 solver now",
    nowTrue: "the repair round ahead of the LLM loop is `repairDecomposedCpsat` (C9)",
  },
  {
    path: "apps/web/src/server/usecases/__tests__/schedule-ai-run.test.ts",
    pattern: "the z3 solver now",
    nowTrue: "same claim, copied — the round is CP-SAT",
  },
  {
    path: "apps/web/src/server/usecases/__tests__/competition-schedule-run.test.ts",
    pattern: "The z3 solver now runs",
    nowTrue: "same claim, copied — the round is CP-SAT",
  },
  {
    path: "apps/web/src/server/usecases/__tests__/schedule-ai-route.test.ts",
    pattern: "The z3[[:space:]]*$",
    nowTrue: "same claim, copied — `The z3 / solver now repairs such boards` is CP-SAT's",
  },
  {
    path: "apps/web/src/server/usecases/__tests__/schedule-ai-participants-wiring.test.ts",
    pattern: "The z3[[:space:]]*$",
    nowTrue: "same claim, copied",
  },
  {
    path: "apps/web/src/server/usecases/__tests__/competition-schedule-ai-route.test.ts",
    pattern: "The z3[[:space:]]*$",
    nowTrue: "same claim, copied",
  },
  {
    path: "scripts/smoke.ts",
    pattern: "(z3 repair solver now|The z3 solver now runs)",
    nowTrue: "the default auto mode runs CP-SAT; the AI round repairs before the model retries",
  },
  {
    path: "apps/web/src/server/usecases/__tests__/schedule.test.ts",
    pattern: "(The z3 path|onto z3|z3/WASM warm-up|the z3 warm-up)",
    nowTrue: "the solver path; the lattice is `applyWindow`/`buildGrid`, not any solver's",
  },
  {
    path: "apps/web/src/server/usecases/__tests__/schedule-capacity-guard.test.ts",
    pattern: "solve phase is the LOCAL z3",
    nowTrue: "REFLOW solves through `buildSchedule` since C4 — the z3 counter cannot move here",
  },
  {
    path: "packages/engine/src/scheduling/index.ts",
    pattern: "Same story: it imports",
    nowTrue: "`build.ts` imports `withZ3LockAndReset`, never `loadZ3`",
  },
  {
    path: "packages/engine/src/scheduling/build.ts",
    pattern: "row still reports .*z3",
    nowTrue: "a solved row reads `engine: \"optimized\"`; the sweep script itself is deleted",
  },
  {
    path: "proto/scheduler.proto",
    pattern: "board z3 proves INFEASIBLE",
    nowTrue: "a board the TS verifier (`validateAssignments`) rejects",
  },
  {
    path: "packages/engine/src/scheduling/generated/scheduler.ts",
    pattern: "board z3 proves INFEASIBLE",
    nowTrue: "generated from the proto above — regenerate, never hand-edit",
  },
  {
    path: "services/placement/fly.toml",
    pattern: "MAX_SOLVER_QUEUE.*z3-WASM",
    nowTrue: "the in-process admission gate, `MAX_SOLVER_QUEUE` in `build.ts`",
  },
  {
    path: "apps/web/e2e/auto-schedule.spec.ts",
    pattern: "(the three z3 solver actions|the z3 WASM not being reachable)",
    nowTrue: "the three solver actions; the prod-shape risk is an unreachable placement service",
  },
];

/** Owned by stage D: a persisted or public enum VALUE, or something that
 *  renders one. Never a rename — these cross the wire and sit in the DB. */
const OWNED_BY_C7 = [
  "apps/web/src/components/v2/board/__tests__/result-strip-wiring.test.tsx",
  "apps/web/src/components/v2/board/__tests__/result-strip.test.tsx",
  "apps/web/src/components/v2/board/result-strip.tsx",
  "apps/web/src/demo/ai-templates/northside-open.json",
  "apps/web/src/dictionaries/en/ui.json",
  "apps/web/src/dictionaries/es/ui.json",
  "apps/web/src/dictionaries/fr/ui.json",
  "apps/web/src/dictionaries/nl/ui.json",
  "apps/web/src/lib/i18n-keys.ts",
  "apps/web/src/server/api-v1/schemas.ts",
];

/** Owned by stage E: the solver, its WASM plumbing, its benches, and the tests
 *  that boot it. These files carry accurate z3 prose — they still run z3 — and
 *  the prose goes when the file does. */
const OWNED_BY_C8 = [
  "apps/web/src/__tests__/toolchain.test.ts",
  "apps/web/src/lib/__tests__/z3-tracing-config.test.ts",
  "apps/web/src/lib/capacity-input.ts",
  "apps/web/src/lib/health-input.ts",
  "apps/web/src/server/logger.ts",
  "packages/engine/src/scheduling/build-encode-parity.test.ts",
  "packages/engine/src/scheduling/build-encode-rules.test.ts",
  "packages/engine/src/scheduling/build-encode.ts",
  "packages/engine/src/scheduling/build-lns-wiring.test.ts",
  "packages/engine/src/scheduling/build-lns.test.ts",
  "packages/engine/src/scheduling/build-lns.ts",
  "packages/engine/src/scheduling/logger.ts",
  "packages/engine/src/scheduling/repair-decompose.test.ts",
  "packages/engine/src/scheduling/repair-decompose.ts",
  "packages/engine/src/scheduling/repair-scale.test.ts",
  "packages/engine/src/scheduling/repair-subminute.test.ts",
  "packages/engine/src/scheduling/repair-verify.test.ts",
  "packages/engine/src/scheduling/repair.test.ts",
  "packages/engine/src/scheduling/repair.ts",
  "packages/engine/src/scheduling/solver-test-bounds.ts",
  "packages/engine/src/scheduling/z3-handle-release.test.ts",
  "packages/engine/src/scheduling/z3-load.test.ts",
  "packages/engine/src/scheduling/z3-load.ts",
  "packages/engine/src/scheduling/z3-serialisation.test.ts",
];

/** Neither stage's: prose that is TRUE today. Two shapes, both legitimate —
 *  a guard proving z3 is NOT called (`z3LoadCount`, `resetZ3` hygiene), and
 *  design commentary contrasting CP-SAT's encoding with z3's, which is how the
 *  port was reasoned about and stays useful after the solver is gone. */
const ACCURATE_TODAY = [
  "apps/web/e2e/ai-architect.spec.ts",
  "apps/web/e2e/ai-fixture-server.ts",
  "apps/web/e2e/auto-schedule.spec.ts",
  "apps/web/e2e/mobile.spec.ts",
  "apps/web/e2e/placement-cutover.spec.ts",
  "apps/web/e2e/schedule-datetime-ux.spec.ts",
  "apps/web/src/components/v2/__tests__/schedule-board-polish.test.tsx",
  "apps/web/src/components/v2/board/__tests__/ai-diff-repair-strip.test.tsx",
  "apps/web/src/server/usecases/__tests__/competition-schedule-ai-http.test.ts",
  "apps/web/src/server/usecases/__tests__/competition-schedule-ai-repair.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-ai-repair-cpsat-wiring.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-ai-repair.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-ai-solver.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-auto-cooldown.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-auto-day-spread.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-auto-feed-order.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-auto-solver-busy-latency.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-auto-tx-boundary.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-capacity-guard.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-default-day-spread.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-reflow-cpsat-engine-tag.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-reflow-cpsat-wiring.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-reflow-cpsat.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-reflow-verifier-widening.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-solver-telemetry.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule.test.ts",
  "apps/web/src/server/usecases/competition-schedule-ai.ts",
  "apps/web/src/server/usecases/schedule-ai-solver.ts",
  "apps/web/src/server/usecases/schedule-ai.ts",
  "apps/web/src/server/usecases/schedule.ts",
  "packages/engine/src/scheduling/build-budget.test.ts",
  "packages/engine/src/scheduling/build-conflict-sources.test.ts",
  "packages/engine/src/scheduling/build-determinism.test.ts",
  "packages/engine/src/scheduling/build-objectives.ts",
  "packages/engine/src/scheduling/build-pins.test.ts",
  "packages/engine/src/scheduling/build-polish.test.ts",
  "packages/engine/src/scheduling/build-rest-lattice.test.ts",
  "packages/engine/src/scheduling/build-teardown.test.ts",
  "packages/engine/src/scheduling/build-wall.test.ts",
  "packages/engine/src/scheduling/build.test.ts",
  "packages/engine/src/scheduling/build.ts",
  "packages/engine/src/scheduling/capacity.test.ts",
  // `"z3"` is a fixture id and `"Z3"` a court name here — not the solver.
  "packages/engine/src/scheduling/health.test.ts",
  "packages/engine/src/scheduling/index.ts",
  "packages/engine/src/scheduling/repair-decompose-cpsat.ts",
  "packages/engine/src/scheduling/repair-domain.test.ts",
  "packages/engine/src/scheduling/repair-domain.ts",
  "scripts/repro-ai-bracket-frozen-feeder.ts",
  "scripts/smoke.ts",
  "services/placement/src/placement/model.py",
  "services/placement/src/placement/objective.py",
];

const LIVE_TREE_Z3_FILES = [...OWNED_BY_C7, ...OWNED_BY_C8, ...ACCURATE_TODAY];

/** `git grep` exits 1 for "no matches", which is a success here, and >1 for a
 *  real failure — so an exit code cannot be swallowed. */
function gitGrep(args: string[]): string[] {
  try {
    const out = execFileSync("git", ["grep", ...args], { cwd: REPO_ROOT, encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
}

describe("z3 retirement — stage C ledger", () => {
  it("scans a tree that actually holds the code — the gate is aimed at something", () => {
    // Generated stubs alone put z3 in `packages/engine/src`; if this ever
    // reads zero, the pathspec drifted and every assertion below is vacuous.
    expect(gitGrep(["-a", "-il", "z3", "--", ...LIVE_TREES]).length).toBeGreaterThan(20);
  });

  it.each(RETIRED_CLAIMS)("$path no longer claims /$pattern/", ({ path, pattern, nowTrue }) => {
    // The file has to still be there, or the assertion below passes for the
    // wrong reason — an empty result reads identically to a deleted file.
    expect(gitGrep(["-a", "-l", "-E", ".", "--", path]), `${path} is gone`).toEqual([path]);
    const hits = gitGrep(["-a", "-n", "-E", pattern, "--", path]);
    expect(hits, `stage C retired this claim. What is true now: ${nowTrue}`).toEqual([]);
  });

  it("the remaining z3 files are exactly the ones C7 and C8 inherit", () => {
    const observed = gitGrep(["-a", "-il", "z3", "--", ...LIVE_TREES]).sort();
    const ledger = [...LIVE_TREE_Z3_FILES].sort();
    // Both directions on purpose: an unlisted file is new drift, and a listed
    // file with no z3 left is a ledger claiming work it no longer owns.
    expect(observed.filter((f) => !ledger.includes(f))).toEqual([]);
    expect(ledger.filter((f) => !observed.includes(f))).toEqual([]);
  });

  it("no file is claimed by two stages at once", () => {
    expect(new Set(LIVE_TREE_Z3_FILES).size).toBe(LIVE_TREE_Z3_FILES.length);
  });

  it("detects a claim when there is one — the matcher is not answering constantly", () => {
    // Aimed at a phrase that IS there, in a tracked file (`git grep` ignores
    // untracked ones — the first draft of this control searched this very file
    // before it was committed and "passed" by finding nothing). If this ever
    // goes empty, every retired-claim assertion above is answering vacuously.
    expect(gitGrep(["-a", "-l", "-F", "CP-SAT interval variable", "--", "proto"])).toEqual([
      "proto/scheduler.proto",
    ]);
  });
});
