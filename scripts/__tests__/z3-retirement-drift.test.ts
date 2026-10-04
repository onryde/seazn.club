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
import { existsSync, readdirSync } from "node:fs";
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
  // `packages/engine/scripts` and ALL of `services/placement` are in scope, not
  // just their `src`. Review caught both as holes: the benches and harnesses
  // are where z3 is discussed most, and `services/placement/fly.toml` is a file
  // this very stage edited while the sweep beside it looked only at
  // `services/placement/src`. A ledger with a hole in it reads exactly like a
  // ledger without one.
  "packages/engine/scripts",
  "apps/web/src",
  "apps/web/e2e",
  "scripts",
  // Every dev-only harness that left scripts/ (ruling 56): the matrix (#913),
  // the bench (2026-10-04), and whichever moves in next. Both drive the
  // scheduler. The per-workspace check below reds if one contributes nothing.
  "tools",
  "proto",
  "services/placement",
  ":!scripts/__tests__/z3-retirement-drift.test.ts",
  // Binary ASSETS are excluded, and the `-a` on every scan below is exactly why
  // they have to be. `-a` forces git to read binaries as text so a file git
  // merely MISDETECTS as binary is still scanned — that is deliberate and it
  // stays. The cost is that a case-insensitive two-byte needle like `z3` then
  // matches random bytes: the spectator W1 branch committed 50 screenshots under
  // `apps/web/e2e/__screens__/` and 40 of them "matched", which is noise at
  // about the rate two arbitrary bytes predict. Left in, the ledger below would
  // have to name PNGs as files that "mention z3", and every future programme
  // that captures screenshots reds this gate for the same non-reason.
  //
  // Excluded by EXTENSION rather than by that one directory, because the trap is
  // the file type and not the location. `.wasm` is deliberately NOT excluded:
  // z3 shipped as WASM before the CP-SAT cutover, so a wasm blob carrying `z3`
  // is a real finding rather than noise.
  ":!*.png",
  ":!*.jpg",
  ":!*.jpeg",
  ":!*.gif",
  ":!*.webp",
  ":!*.avif",
  ":!*.ico",
  ":!*.pdf",
  ":!*.woff",
  ":!*.woff2",
  ":!*.ttf",
  ":!*.otf",
  ":!*.mp4",
  ":!*.webm",
  ":!*.zip",
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
 *  renders one.
 *
 *  EMPTY since C7 (2026-08-17) shipped stage D. Seven of its ten files lost
 *  their last z3 mention outright; the three that kept one — `schemas.ts`,
 *  `result-strip.tsx` and `result-strip.test.tsx` — now say only why the
 *  contract has the members it has, which is accurate past tense, so they
 *  moved to ACCURATE_TODAY below rather than out of the ledger.
 *
 *  Stage D turned out to owe no migration: the values were response-only
 *  telemetry, verified across the DDL, every jsonb column of a live schema,
 *  and every read path. The brief's "rewrite rows" step had no target. */
const OWNED_BY_C7: string[] = [];

/** Owned by stage E: the solver, its WASM plumbing, its benches, and the tests
 *  that boot it.
 *
 *  EMPTY since C8 (2026-08-17) shipped stage E. Every file that was listed here
 *  is deleted — the encoder, the LNS fallback, the WASM loader, the repair
 *  solver, their tests and their benches — along with the dependency and both
 *  halves of the `next.config` plumbing.
 *
 *  The list was an UNDERCOUNT of the work: the ledger named the files that
 *  mentioned z3, not the files that would stop compiling once they were gone.
 *  Deleting it took four more engine test files, a `next.config` helper, the
 *  pnpm hoist pattern, the Dockerfile note, and eleven `apps/web` tests that
 *  spied on z3 to prove it was NOT called — assertions that become structural
 *  when the function stops existing. */
const OWNED_BY_C8: string[] = [];

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
  // Inherited from OWNED_BY_C7 when stage D shipped. Each explains why a
  // retired member is absent — the kind of past tense this list exists for.
  "apps/web/src/components/v2/board/__tests__/result-strip.test.tsx",
  "apps/web/src/components/v2/board/result-strip.tsx",
  "apps/web/src/server/usecases/__tests__/competition-schedule-ai-http.test.ts",
  "apps/web/src/server/usecases/__tests__/competition-schedule-ai-repair.test.ts",
  "apps/web/src/server/api-v1/__tests__/z3-contract-retired.test.ts",
  "apps/web/src/server/api-v1/schemas.ts",
  "apps/web/src/server/usecases/__tests__/schedule-ai-repair-cpsat-wiring.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-ai-repair.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-ai-solver.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-auto-cooldown.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-auto-feed-order.test.ts",
  "apps/web/src/server/usecases/__tests__/schedule-auto-tx-boundary.test.ts",
  // RESTORED after C8 deleted it (the C8 follow-up, 2026-08-17). Its z3
  // mentions are the history of how the contention used to be staged — the
  // process-wide lock — beside what stages it now: holding the placement
  // client open. Past tense throughout, and load-bearing: without it the file
  // reads as if a lock it never takes were still involved.
  "apps/web/src/server/usecases/__tests__/schedule-auto-solver-busy-latency.test.ts",
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
  "packages/engine/src/scheduling/build.test.ts",
  "packages/engine/src/scheduling/build.ts",
  "packages/engine/src/scheduling/capacity.test.ts",
  // `"z3"` is a fixture id and `"Z3"` a court name here — not the solver.
  "packages/engine/src/scheduling/health.test.ts",
  "packages/engine/src/scheduling/index.ts",
  // The C8 follow-up (2026-08-17) added a header note saying why this module
  // is exported as its own subpath: it is the seam the web lane's tests use to
  // prove a solve did or did not happen, which is what z3's deleted
  // process-wide lock used to stage. Names the lock only to say it is gone.
  "packages/engine/src/scheduling/placement-client.ts",
  "packages/engine/src/scheduling/repair-decompose-cpsat.ts",
  "packages/engine/src/scheduling/repair-decompose.test.ts",
  "packages/engine/src/scheduling/repair-decompose.ts",
  "packages/engine/src/scheduling/repair-domain.test.ts",
  "packages/engine/src/scheduling/z3-dependency-retired.test.ts",
  "packages/engine/src/scheduling/repair-domain.ts",
  // A test-name regex matching golden fixture names from the z3 era
  // ("without booting the z3 WASM") — quoting history, not using the solver.
  "scripts/ci-local.sh",
  "scripts/repro-ai-bracket-frozen-feeder.ts",
  "scripts/smoke.ts",
  "services/placement/src/placement/model.py",
  "services/placement/src/placement/objective.py",
  // The Python side's own comparative commentary — CP-SAT's encoding reasoned
  // about against z3's, which stays useful after the solver is gone — plus the
  // deploy config, whose z3 mention is now explicitly past tense.
  "services/placement/bench/README.md",
  "services/placement/bench/placement_bench.py",
  "services/placement/bench/placement_repair_bench.py",
  "services/placement/fly.toml",
  "services/placement/tests/test_model.py",
  "services/placement/tests/test_objective.py",
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

  // The tools/* workspaces (a directory with a package.json): the dev-only
  // harnesses ruling 56 moved out of scripts/ — the matrix (#913) and the
  // bench (2026-10-04). The hit count above still clears 20 without them, so
  // either could fall out of LIVE_TREES unseen. Read from the tree, never typed.
  const harnesses = readdirSync(`${REPO_ROOT}tools`).filter((d) => existsSync(`${REPO_ROOT}tools/${d}/package.json`)).sort();
  /** Every tracked file the scans read — LIVE_TREES exactly, its exclusions included. */
  const scanned = (): string[] =>
    execFileSync("git", ["ls-files", "--", ...LIVE_TREES], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

  it("every tools/* workspace has files in the scan — a harness moved out of scripts/ cannot drop out unseen", () => {
    const files = scanned();
    const counts = Object.fromEntries(harnesses.map((h) => [h, files.filter((f) => f.startsWith(`tools/${h}/`)).length]));
    console.info(`z3-retirement-drift: ${files.length} files in the scanned trees; per tools/* workspace ${JSON.stringify(counts)}`);
    expect(harnesses.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(counts).filter((h) => counts[h] === 0)).toEqual([]);
  });

  it("the bench and the matrix are each in the scan — both drive the scheduler and report its engine", () => {
    const files = scanned();
    expect(harnesses).toEqual(expect.arrayContaining(["bench", "matrix"]));
    expect(files.filter((f) => f.startsWith("tools/bench/")).length).toBeGreaterThan(100);
    expect(files.filter((f) => f.startsWith("tools/matrix/")).length).toBeGreaterThan(150);
    expect(files).toContain("tools/bench/lib/schedule.ts");
    expect(files).toContain("tools/matrix/run.ts");
  });

  it("no binary asset reaches the scan — and there are binary assets to exclude", () => {
    // The POSITIVE half first, or the negative one below passes for the wrong
    // reason: with no images in the scanned trees, "the scan returns no images"
    // is true of a scan that excludes nothing. `apps/web/e2e/__screens__` held
    // 50 PNGs when this was written; the assertion is on the file type, not on
    // that directory, so it survives them moving.
    // The TREES only — dropping LIVE_TREES' own `:!` exclusions, which include
    // the very extensions this half exists to prove are present. Listing through
    // them returns zero images and the control passes by asserting the exclusion
    // against itself.
    const trees = LIVE_TREES.filter((p) => !p.startsWith(":!"));
    const tracked = execFileSync("git", ["ls-files", "--", ...trees], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const isBinaryAsset = (f: string): boolean => /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|mp4|webm|zip)$/i.test(f);
    expect(tracked.filter(isBinaryAsset).length, "no binary assets are tracked, so this gate proves nothing").toBeGreaterThan(0);

    // The negative half. `-a` reads binaries as text, so a two-byte needle hits
    // random bytes — 40 of those 50 PNGs "matched z3". Every scan in this file
    // shares LIVE_TREES, so excluding them there covers all of them.
    expect(gitGrep(["-a", "-il", "z3", "--", ...LIVE_TREES]).filter(isBinaryAsset)).toEqual([]);
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
