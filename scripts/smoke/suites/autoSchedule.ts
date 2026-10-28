// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

/**
 * T14 — the auto-schedule solver, in a production-shaped run.
 *
 * WHAT ONLY THIS CAN PROVE. `buildSchedule` boots a WASM module. Every unit test
 * in the repo loads it from `node_modules` in a vitest process; production loads
 * it out of a traced `output: standalone` bundle, and the two have already come
 * apart once — a WASM dependency needs BOTH a tracing include and a
 * `serverExternalPackages` entry, and without them the solver shipped as a
 * silent no-op that fell back to the greedy pass while every gate stayed green.
 * That failure is invisible to any assertion about the BOARD, because the greedy
 * board is also a valid board. Refusing the fallback rather than tolerating it
 * as a graceful degradation is the reason this suite exists.
 *
 * THE FIELD THAT CARRIES IT IS `solver.status`, NOT `solver.engine`. This
 * docblock used to say the opposite — "asserting engine is the solver's and
 * not greedy" — and the check below deliberately does NOT do that, for the
 * reason spelled out over it: `engine` is board PROVENANCE, so a run that
 * solved and found nothing better than the greedy seed reports `greedy`
 * correctly, which is the honest answer every time on this six-fixture board.
 * A reader trusting the old sentence would "restore" the engine assertion the
 * inline comment records as already broken once. A solver the service could
 * not give us returns `solver_unavailable`; that is the assertion.
 *
 * All three modes run, because they are three different solvers behind one
 * endpoint (`AutoScheduleRequest`'s preprocess derives `mode` from
 * `only_unlocked`) and each reports something the other two cannot:
 *
 *   BUILD  — the tier solver over an empty board. The placement proof.
 *   REFLOW — C4 (2026-08-15, z3 retirement stage A): routed through the SAME
 *            placement `buildSchedule` call BUILD/POLISH already make, not
 *            z3's repair solver any more — every already-placed card
 *            (locked or not) is frozen for the run. So `tiers_completed` is
 *            no longer reliably 0 the way the old repair solver's ladder-
 *            less model made it; it is whatever real ladder this call
 *            proves, same as BUILD's, and asserted the same shape-check way
 *            (mode + a solved status, not a specific tier count — see
 *            `schedule-solver-telemetry.test.ts`'s "THREE assertions have
 *            now been tried here and each was a RACE" for why a specific
 *            count on a tiny board is the wrong thing to pin). What it must
 *            still show is `seeded`/`moved`, the two fields the strip's copy
 *            depends on, and the pin's exact slot surviving untouched.
 *   POLISH — the tier solver again, this time under a freeze. Asserted on the
 *            frozen card keeping its exact slot AND the makespan improving,
 *            since "nothing moved" satisfies a freeze check on its own.
 *
 * BOUNDED BY THE INSTANCE, NOT BY A WALL — and that is a deviation worth naming.
 * The brief asked for an explicit short wall, but `AUTO_SOLVER_WALL_MS` is a
 * module constant in `usecases/schedule.ts` and the auto endpoint's body accepts
 * only `only_unlocked` and `mode`, so no wall can be passed over HTTP. The
 * instance is kept tiny instead: 4 entrants, 6 fixtures, 2 courts, well inside
 * the R18 size gate, so each solve returns far short of the 8 s ceiling. Every
 * assertion is on returned telemetry; none is on elapsed time.
 */
export async function autoScheduleSuite(): Promise<void> {
  const s = newSession();
  // The board apply path and the constraints family are Pro.
  const orgId = (await signIn(s, `delivered+smoke-autosched-${tag}@resend.dev`)).org_id;
  await setPlan(orgId, "pro", s);

  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Z3 Solver ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Solver",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(
    s,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: `Z3 ${n}${tag}`,
      seed: i + 1,
    })),
  );
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const generated = v1data<{ fixtures: { id: string }[] }>(
    await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures;
  // 4 entrants -> 6 matches over 3 rounds of 2. On a 2-court grid that has an
  // exact 3-slot optimum, which is what makes the polish improvement below
  // forced rather than merely likely.
  check("auto-schedule: a 4-entrant round robin generated 6 fixtures", generated.length === 6);

  const START = "2026-09-21T09:00:00.000Z";
  const SLOT_MIN = 30;
  const slotAt = (n: number) =>
    new Date(Date.parse(START) + n * SLOT_MIN * 60_000).toISOString();

  // ScheduleConfig.courts is real court ids now (V374 cutover), not display
  // labels — one venue, two courts, same shape venuesSuite() already uses.
  const venue = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `Z3 Venue ${tag}` }),
  );
  const courtA = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${venue.id}/courts`, "POST", { name: "Court A" }),
  );
  const courtB = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${orgId}/venues/${venue.id}/courts`, "POST", { name: "Court B" }),
  );

  // `perEntrantMinRest: 0` on purpose: a rest shortfall is warn-only, and a
  // board carrying warnings would make "the solver produced a legal board" and
  // "the solver produced something it had to apologise for" look alike.
  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: START,
      matchMinutes: SLOT_MIN,
      gapMinutes: 0,
      courts: [courtA.id, courtB.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });

  interface SolverInfo {
    engine: string;
    mode?: string;
    status: string;
    tiers_completed: number;
    tiers_total: number;
    budget_expired: boolean;
    elapsed_ms: number;
    moved: number;
    seeded?: number;
    lost?: number;
  }
  interface AutoRun {
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
    metrics?: {
      makespan_minutes: number;
      worst_idle_gap_minutes: number;
      court_imbalance_minutes: number;
      placed: number;
      total: number;
    };
    solver?: SolverInfo;
  }
  const auto = async (body: Record<string, unknown>): Promise<AutoRun | undefined> =>
    v1data<AutoRun>(await v1(s, `/api/v1/stages/${stage.id}/schedule/auto`, "POST", body));
  const fixtureSlot = async (id: string): Promise<string> => {
    const f = v1data<{ scheduled_at: string | null; court_id: string | null }>(
      await v1(s, `/api/v1/fixtures/${id}`),
    );
    return `${f?.scheduled_at ?? "-"}@${f?.court_id ?? "-"}`;
  };

  // ======================================================================
  // 1. BUILD — the placement proof
  // ======================================================================
  const build = await auto({ only_unlocked: false });
  check(
    // THE assertion this suite exists for: the WASM loaded and the ladder ran
    // inside a standalone bundle, which no unit test is in a position to see.
    //
    // NOT `engine === "z3"`, which is what this checked first and is WRONG.
    // `engine` is board PROVENANCE, not proof of execution — `build.ts:1462`
    // reads `usedLns ? "z3+lns" : incumbent === seedAssignments ? "greedy"
    // : "z3"`, so a run where z3 loaded, solved, and found nothing better than
    // the greedy seed reports `"greedy"` CORRECTLY. On this six-fixture,
    // two-court board greedy is already optimal, so `"greedy"` is the honest
    // answer every time and the old assertion failed against a healthy solver.
    //
    // `status` is the field that carries the real failure: a solver the
    // service could not give us returns `solver_unavailable`. That is the
    // whole of the claim.
    //
    // `tiers_completed > 0` is kept as a shape check and NOT as corroboration,
    // which is what its old name ("the tier ladder ran") asserted and could not
    // support. T0 sets `tiersCompleted = 1` when `checks > 0` OR when greedy
    // already placed every card — "the maximum is achieved and proving it costs
    // zero checks" (build.ts). This six-fixture, two-court board is exactly that
    // case, so a `1` here is routinely reached with ZERO solver checks and
    // says nothing about whether a solver was behind it.
    "build: the solver was reachable in prod (not the solver_unavailable fallback)",
    build?.solver?.status !== "solver_unavailable" &&
      (build?.solver?.tiers_completed ?? 0) > 0,
  );
  check(
    // Provenance is still worth pinning — as a legal value, not as a liveness
    // proof. A serialisation that drops the field renders no engine sentence.
    // Down to the two legal values in C7, which retired "z3"/"z3+lns": a
    // wider allow-list would now accept a value the API cannot emit, which is
    // an assertion that has stopped testing anything. Still NOT an assertion
    // that the optimiser is ever REACHED — `placementOptimizedSuite` below
    // owes that, on a board sized to force a real win. Without
    // `PLACEMENT_SERVICE_HOST` reachable, every board on THIS six-fixture
    // instance falls back to "greedy" anyway.
    "build: the run names where the board came from",
    build?.solver?.engine === "greedy" || build?.solver?.engine === "optimized",
  );
  check(
    "build: the request derived mode=build and the solver reported a solved status",
    build?.solver?.mode === "build" &&
      (build.solver.status === "ok" || build.solver.status === "already_optimal"),
  );
  check(
    "build: every fixture was placed, across both courts",
    (build?.assignments ?? []).length === 6 &&
      build?.metrics?.placed === 6 &&
      build.metrics.total === 6 &&
      new Set((build.assignments ?? []).map((a) => a.court_id)).size === 2,
  );
  check(
    // Telemetry POPULATED, not merely present: a strip full of structural zeros
    // is what a serialisation that lost the payload renders, and it is
    // indistinguishable from a real run by any presence check.
    "build: the telemetry came back populated (elapsed, tier ladder, real makespan)",
    (build?.solver?.elapsed_ms ?? 0) > 0 &&
      (build?.solver?.tiers_total ?? 0) > 0 &&
      // `>= 0` here was VACUOUS — `tiers_completed` is a non-negative int, so
      // the clause was true for every possible payload including one the
      // serialisation had emptied. It is the ladder's numerator; a real run
      // moves it.
      (build?.solver?.tiers_completed ?? 0) > 0 &&
      (build?.metrics?.makespan_minutes ?? 0) > 0,
  );

  await v1(s, `/api/v1/stages/${stage.id}/schedule/apply`, "POST", {
    assignments: (build?.assignments ?? []).map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_id: a.court_id,
    })),
    source: "auto",
  });

  // ======================================================================
  // 2. REFLOW — the repair solver, with a pin it may not touch
  // ======================================================================
  const pinnedId = generated[0].id;
  await v1(s, `/api/v1/fixtures/${pinnedId}`, "PATCH", { schedule_locked: true });
  const pinnedBefore = await fixtureSlot(pinnedId);
  // Empty every UNLOCKED slot. Over an already-legal board the repair solver is
  // entitled to return `clean` and move nothing, so "the pin held" would pass on
  // a mode that never ran at all; five cards with no time cannot.
  const clearOpen = await v1(s, "/api/v1/schedule/clear", "POST", {
    division_id: div.id,
    scope: { excludeLocked: true },
    confirm: true,
  });
  check(
    // The control half of the freeze pair below. This call was previously
    // unchecked, which left the frozen refusal unable to distinguish "the
    // freeze stopped it" from "clear refuses this division either way".
    `clear: an UNFROZEN division clears its unlocked slots (status=${clearOpen.status})`,
    clearOpen.status === 200 &&
      ((clearOpen.json.data as { cleared?: number } | undefined)?.cleared ?? 0) > 0,
  );

  // Restore is the OTHER destructive control in this console, and the wider of
  // the two: clear empties unlocked slots, a restore rewrites every fixture's
  // time and court back to the save point. It sits a few hundred pixels above
  // the clear, so a freeze that bound only one of them refused the smaller edit
  // and allowed the larger.
  //
  // The control half is a save point taken at the CURRENT watermark, which
  // makes restoring it a legitimate no-op (`steps: 0`): it writes nothing and
  // leaves the board REFLOW is about to measure exactly as it stands. That is
  // all this half has to do — hold "the endpoint accepts this division" fixed,
  // so the 422 below can only be the freeze.
  const savePoint = await v1(s, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `freeze control ${tag}`,
  });
  const savePointId = (savePoint.json.data as { id?: string } | undefined)?.id;
  const restoreOpen = await v1(s, `/api/v1/divisions/${div.id}/restore`, "POST", {
    checkpoint_id: savePointId,
    confirm: true,
  });
  check(
    `restore: an UNFROZEN division accepts the rewind ` +
      `(save point=${savePoint.status}, restore=${restoreOpen.status})`,
    savePoint.status === 201 &&
      !!savePointId &&
      restoreOpen.status === 200 &&
      (restoreOpen.json.data as { steps?: number } | undefined)?.steps === 0,
  );

  // Undo and Redo are the primitives the restore above is BUILT OUT OF —
  // `restoreCheckpoint` is a loop of `undoDivision` — and they sit on two
  // buttons a few hundred pixels above the Restore the freeze disables. The
  // control half is an undo immediately followed by its redo, which leaves the
  // board exactly where REFLOW below expects it (the five cleared cards stay
  // cleared) while proving the endpoints accept this division. It also leaves a
  // redo PENDING for nothing: the frozen redo below is refused on a division
  // whose redo stack the control just re-spent, so a second undo is taken first.
  const undoOpen = await v1(s, `/api/v1/divisions/${div.id}/undo`, "POST", {});
  const redoOpen = await v1(s, `/api/v1/divisions/${div.id}/redo`, "POST", {});
  check(
    `undo/redo: an UNFROZEN division steps back and forward ` +
      `(undo=${undoOpen.status}, redo=${redoOpen.status})`,
    undoOpen.status === 200 && redoOpen.status === 200,
  );
  // One more undo, so the frozen REDO below has something real to refuse. On an
  // empty redo stack the engine refuses it whatever the freeze does, and the
  // check would witness nothing.
  const undoAgain = await v1(s, `/api/v1/divisions/${div.id}/undo`, "POST", {});
  check(
    `undo: the second step back landed, so the frozen redo below has a redo to refuse ` +
      `(status=${undoAgain.status})`,
    undoAgain.status === 200,
  );

  // The whole-division freeze bites on the DESTRUCTIVE control too. `applySchedule`
  // and the single-fixture move both refuse a frozen division on exactly these
  // terms (same 422, same sentence); clear was the one write path that did not,
  // so a frozen board could be wiped by the one button whose entire point is
  // that it wipes. Status AND message are a contract the board's own copy reads,
  // so both are pinned here rather than the status alone.
  const freeze = await v1(s, `/api/v1/divisions/${div.id}/locks`, "PATCH", {
    schedule_locked: true,
  });
  const clearFrozen = await v1(s, "/api/v1/schedule/clear", "POST", {
    division_id: div.id,
    scope: { excludeLocked: true },
    confirm: true,
  });
  const restoreFrozen = await v1(s, `/api/v1/divisions/${div.id}/restore`, "POST", {
    checkpoint_id: savePointId,
    confirm: true,
  });
  const undoFrozen = await v1(s, `/api/v1/divisions/${div.id}/undo`, "POST", {});
  const redoFrozen = await v1(s, `/api/v1/divisions/${div.id}/redo`, "POST", {});
  const thaw = await v1(s, `/api/v1/divisions/${div.id}/locks`, "PATCH", {
    schedule_locked: false,
  });
  // BOTH sides of the freeze are asserted, and neither is inferable from the
  // 422 below. `check` only counts — it never throws or returns — so putting
  // the thaw before it proves the call was MADE, not that it SUCCEEDED. A
  // thaw that answers non-200 leaves the division frozen, and the redo and the
  // `auto({ only_unlocked: true })` after it then hit their own frozen guards:
  // a state leak from this block reported as a REFLOW defect, which sends the
  // reader to the wrong subsystem. A silently-failed FREEZE is the mirror image
  // — the clear, the restore, the undo and the redo would all answer 200 and
  // the four 422 checks below would indict the guards instead of the freeze
  // that never happened. All four refusals sit inside this one freeze/thaw
  // window, so this assertion covers every one of them.
  check(
    `locks: the freeze and the thaw around both refusals took ` +
      `(freeze=${freeze.status}, thaw=${thaw.status})`,
    freeze.status === 200 && thaw.status === 200,
  );
  check(
    `clear: a FROZEN division refuses the scoped clear 422 with the unlock copy ` +
      `(status=${clearFrozen.status}, message=${clearFrozen.json.error?.message ?? "-"})`,
    clearFrozen.status === 422 &&
      clearFrozen.json.error?.message === "the division schedule is locked — unlock it to edit",
  );
  check(
    // Same status and same sentence as the clear above, deliberately: four
    // write paths now share this one hand-duplicated refusal, and the panel's
    // own frozen note is written against it.
    `restore: a FROZEN division refuses the save-point rewind 422 with the unlock copy ` +
      `(status=${restoreFrozen.status}, message=${restoreFrozen.json.error?.message ?? "-"})`,
    restoreFrozen.status === 422 &&
      restoreFrozen.json.error?.message === "the division schedule is locked — unlock it to edit",
  );
  check(
    // The restore above is a LOOP of this undo, so a freeze that stopped the
    // composite and left the primitive live refused the wider edit and allowed
    // the narrower one — from a button on the same panel. Same status, same
    // hand-duplicated sentence: six write paths share it now.
    `undo: a FROZEN division refuses the step back 422 with the unlock copy ` +
      `(status=${undoFrozen.status}, message=${undoFrozen.json.error?.message ?? "-"})`,
    undoFrozen.status === 422 &&
      undoFrozen.json.error?.message === "the division schedule is locked — unlock it to edit",
  );
  check(
    // Redo is the same guard reached from the other direction — one predicate
    // in `step`, but a mutation that reached only one of the two callers would
    // pass with the undo check alone.
    `redo: a FROZEN division refuses the step forward 422 with the unlock copy ` +
      `(status=${redoFrozen.status}, message=${redoFrozen.json.error?.message ?? "-"})`,
    redoFrozen.status === 422 &&
      redoFrozen.json.error?.message === "the division schedule is locked — unlock it to edit",
  );

  // Spend the redo the freeze refused, now that the division is thawed: it is
  // the non-vacuity half of the two checks above (a redo the engine had nothing
  // to do would 4xx frozen or not), and it puts the board back on the cleared
  // state REFLOW measures next.
  const redoThawed = await v1(s, `/api/v1/divisions/${div.id}/redo`, "POST", {});
  check(
    `redo: the same step the freeze refused succeeds once thawed — it was the FREEZE, ` +
      `not an empty redo stack (status=${redoThawed.status})`,
    redoThawed.status === 200,
  );

  const reflow = await auto({ only_unlocked: true });
  check(
    // C4: no longer the repair solver's empty ladder (see the docblock above)
    // — reflow now shares BUILD's own status vocabulary via `buildSchedule`,
    // so this mirrors BUILD's identical assertion above rather than pinning
    // a tier count a tiny board cannot reliably produce either way.
    "reflow: the request derived mode=reflow and reported a solved status",
    reflow?.solver?.mode === "reflow" &&
      (reflow?.solver?.status === "ok" || reflow?.solver?.status === "already_optimal"),
  );
  check(
    // `seeded` is the field the strip's copy branches on — "N matches scheduled"
    // versus "N matches moved" — and only the reflow path populates it.
    "reflow: it re-placed the five cleared cards and said so via seeded/moved",
    (reflow?.assignments ?? []).length === 6 &&
      (reflow?.solver?.seeded ?? 0) >= 5 &&
      (reflow?.solver?.moved ?? 0) >= 5 &&
      reflow?.metrics?.placed === 6,
  );
  const pinnedProposed = (reflow?.assignments ?? []).find((a) => a.fixture_id === pinnedId);
  check(
    "reflow: the pinned card is handed back on exactly the slot it already held",
    !!pinnedProposed &&
      `${pinnedProposed.scheduled_at}@${pinnedProposed.court_id}` === pinnedBefore,
  );

  // ======================================================================
  // 3. POLISH — the tier solver under a freeze
  // ======================================================================
  // A deliberately poor but entirely legal incumbent: all six matches strung
  // down Court A in consecutive slots, Court B unused. Makespan 180 minutes
  // against a two-court optimum of 90, so tier 1 has somewhere to go and a
  // polish that returns the board unchanged is a real failure, not a tie.
  const POOR_MAKESPAN_MIN = 180;
  await v1(s, `/api/v1/fixtures/${pinnedId}`, "PATCH", { schedule_locked: false });
  await v1(s, `/api/v1/stages/${stage.id}/schedule/apply`, "POST", {
    assignments: generated.map((f, i) => ({
      fixture_id: f.id,
      scheduled_at: slotAt(i),
      court_id: courtA.id,
    })),
    source: "manual",
  });
  // Lock the FIRST slot: at the board's own start it constrains neither the
  // makespan floor nor the court balance, so a solver honouring it can still
  // reach the optimum. An unmoved locked card is then a freeze being respected
  // rather than a solver with nowhere to put it.
  const lockedId = generated[0].id;
  await v1(s, `/api/v1/fixtures/${lockedId}`, "PATCH", { schedule_locked: true });
  const lockedBefore = await fixtureSlot(lockedId);

  const polish = await auto({ only_unlocked: true, mode: "polish" });
  check(
    // Same correction as the BUILD check above: `engine` is provenance, so a
    // polish run that loaded z3 and could not beat the board it was handed
    // reports `"greedy"` and is entirely healthy. What distinguishes the TIER
    // solver from the REPAIR solver is the ladder — `reflowExisting` pins
    // `tiersCompleted: 0` deliberately, because the repair solver has no tier
    // ladder and reporting a number from a ladder it never walked would make
    // an optimality claim nothing proved. So a non-zero ladder IS the proof
    // this run went to the tier solver.
    "polish: the explicit mode reached the tier solver, not the repair solver",
    polish?.solver?.mode === "polish" &&
      polish.solver.status !== "solver_unavailable" &&
      (polish.solver.tiers_completed ?? 0) > 0,
  );
  const lockedProposed = (polish?.assignments ?? []).find((a) => a.fixture_id === lockedId);
  check(
    "polish: the locked card keeps its exact time AND court",
    !!lockedProposed &&
      `${lockedProposed.scheduled_at}@${lockedProposed.court_id}` === lockedBefore,
  );
  check(
    // The other half. A polish that froze the whole board would satisfy the
    // check above and improve nothing.
    "polish: ...and the rest of the board was compacted off the single court",
    (polish?.assignments ?? []).length === 6 &&
      polish?.metrics?.placed === 6 &&
      (polish.metrics.makespan_minutes ?? POOR_MAKESPAN_MIN) < POOR_MAKESPAN_MIN &&
      new Set((polish.assignments ?? []).map((a) => a.court_id)).size === 2,
  );
}
