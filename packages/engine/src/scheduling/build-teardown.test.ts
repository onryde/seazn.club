// R17 — `buildSchedule` hands the WASM heap back itself.
//
// This is not hygiene and it is not a nicety. z3's heap only ever GROWS: one
// context is shared by every solve in the process and nothing frees a finished
// `Solver`, so a server that has run a handful of auto-schedules aborts with
// `Cannot enlarge memory arrays to size 2210201600 bytes (OOM)` and takes node
// down with it. Measured at six consecutive solves during the web lane's work,
// where the fix first landed as a `finally` at the CALL seam — which is one
// forgotten wrapper away from a dead production server the next time somebody
// adds an entry point. The ownership belongs to the solve.
//
// TWO PATHS, and the throw path is the one that gets dropped: a solve that threw
// allocated exactly as much as one that returned. So it is tested explicitly,
// with an injected encoder fault, rather than being assumed to follow from the
// success case.
//
// WHY `z3LoadCount()` IS THE INSTRUMENT. It counts loads SINCE THE LAST RESET,
// so zero after a solve means the singleton really was dropped. On its own that
// reads vacuously — zero is also what "z3 never booted" looks like, and
// `buildSchedule` has four early exits that never touch the WASM. Every case
// below therefore carries a POSITIVE witness that the solver really ran before
// asserting it was torn down: `rlimitSpent > 0` (z3's own counter moved, so a
// `check()` happened) on the success path, and the count observed from INSIDE
// the fault on the throw path.
//
// NOTHING IS IMPORTED STATICALLY from `./build.ts` or `./z3-load.ts`, for the
// reason `repair-verify.test.ts` spells out: `vitest.config.ts` sets
// `isolate: false`, so `vi.resetModules()` clears the registry for the whole
// worker and a binding taken before a reset reads a DIFFERENT `z3-load.ts`
// instance — with its own `loaded` singleton and its own counter. A
// `z3LoadCount()` assertion across that seam reads the wrong number and passes
// whatever the code does.
import { describe, expect, it, vi } from "vitest";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";
import type { SchedulingConstraints } from "./constraints.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

const cons = (over: Partial<SchedulingConstraints>): SchedulingConstraints => ({
  noBackToBack: false,
  startWindows: [],
  fieldFairness: "off",
  parallelism: "mixed",
  crossPersonClash: "warn",
  ...over,
});

/** `build.test.ts`'s measured corner: one court, two slots, and a start window
 *  that makes greedy take the early one for the wrong card. Greedy places
 *  `[a@C1+0]` and reports `start_window` for `b`; the solver places both. Chosen
 *  because it guarantees the T0 walk runs real `check()`s — a board greedy
 *  already got right enters no iteration at all, and `rlimitSpent` would then be
 *  a much weaker witness. */
const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  tz: "Europe/London",
  window: { from: T0, to: T0 + 180 * MIN },
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: cons({ startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }] }),
};
const fixtures: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2" },
  { id: "b", roundNo: 1, home: "E3", away: "E4" },
];

/** Everything on the far side of one `resetModules`, so the counter the test
 *  reads and the counter `buildSchedule` moves are the same binding. Shuts its
 *  own instance down afterwards whatever happened, so an orphaned WASM cannot
 *  hang vitest at exit. */
async function isolated<T>(
  body: (mods: {
    build: typeof import("./build.ts");
    z3: typeof import("./z3-load.ts");
    repair: typeof import("./repair.ts");
    payload: typeof import("./payload-fixtures.ts");
  }) => Promise<T>,
  mock?: (z3: typeof import("./z3-load.ts")) => void,
): Promise<T> {
  vi.resetModules();
  const z3 = await import("./z3-load.ts");
  mock?.(z3);
  try {
    return await body({
      build: await import("./build.ts"),
      z3,
      repair: await import("./repair.ts"),
      payload: await import("./payload-fixtures.ts"),
    });
  } finally {
    vi.doUnmock("./build-encode.ts");
    // Defensive even for the tests above that never mock this — unmocking a
    // module that was never mocked is a no-op, and the alternative is a
    // `vi.doMock("./cpsat-client.ts", ...)` (the "still serialises" case
    // below) leaking into whatever runs next in this worker
    // (`isolate: false`, vitest.config.ts).
    vi.doUnmock("./cpsat-client.ts");
    await z3.resetZ3();
    vi.resetModules();
  }
}

/** A board as `(fixture, court, offset-in-minutes)` triples, sorted — so two
 *  boards compare by CONTENT and not by the row order a solver happened to emit. */
const shape = (rows: readonly { fixtureId: string; court: string; startAt: number }[]): string[] =>
  rows.map((a) => `${a.fixtureId}@${a.court}+${(a.startAt - T0) / MIN}`).sort();

// Three of the five cases below are SKIPPED (Task 06, cp-sat cutover):
// `solveBuild` no longer boots z3 (`loadZ3`) at all on the path these
// exercise, so `z3LoadCount()` returning to 0 after a "solve" is no longer
// evidence of a teardown — it is evidence that z3 was never touched in the
// first place, which these tests' own header comment names as the exact
// vacuous reading `rlimitSpent > 0` exists to rule out. `buildSchedule`
// still wraps every call in `withZ3LockAndReset` (untouched, still correct
// for REFLOW's z3 usage), but nothing on the BUILD/POLISH path leaves
// anything for it to tear down anymore. Prompt 10 removes this file's
// remaining premise along with `z3-load.ts`.
describe("buildSchedule — z3 teardown (R17)", () => {
  it.skip("hands the WASM heap back after a solve that succeeded", async () => {
    await isolated(async ({ build, z3 }) => {
      const out = await build.buildSchedule({ fixtures, config });
      // The positive witness. z3's own resource counter moved, so the WASM
      // booted and ran at least one `check()` — without this the assertion
      // below is satisfied by every path that never loads the solver at all.
      expect(out.rlimitSpent).toBeGreaterThan(0);
      expect(z3.z3LoadCount()).toBe(0);
    });
  }, 180_000);

  it.skip("hands the WASM heap back when the solve THREW", async () => {
    // The path that gets forgotten, and the reason this is a separate case
    // rather than a corollary of the one above. `encodeBuild` runs AFTER
    // `loadZ3`, so a fault injected here is a fault with the context already
    // booted — which is exactly the state a real encoder-drift throw leaves
    // behind, and exactly the allocation a missing `finally` would strand.
    const during: number[] = [];
    await isolated(
      async ({ build, z3 }) => {
        await expect(build.buildSchedule({ fixtures, config })).rejects.toThrow(
          "injected encoder fault",
        );
        // Observed from inside the fault: the context WAS loaded when the throw
        // happened. Asserted as an exact value rather than `> 0` — a count of 2
        // would mean an orphaned instance, which is the other way this can go
        // wrong and reads as success under an inequality.
        expect(during).toEqual([1]);
        // ...and the throw did not keep it.
        expect(z3.z3LoadCount()).toBe(0);
      },
      (z3) => {
        vi.doMock("./build-encode.ts", async () => {
          const actual =
            await vi.importActual<typeof import("./build-encode.ts")>("./build-encode.ts");
          return {
            ...actual,
            encodeBuild: () => {
              during.push(z3.z3LoadCount());
              throw new Error("injected encoder fault");
            },
          };
        });
      },
    );
  }, 180_000);

  it("gives the same board after a repair as it does cold", async () => {
    // THE ASSERTION THAT ACTUALLY CLOSES THE DETERMINISM HOLE, and the reason
    // `repairSchedule` had to be wrapped too.
    //
    // R17 covered `buildSchedule`, but `repairSchedule` took `withZ3Lock` with
    // no reset — and `repairAndVerify` inherits that. So a BUILD following a
    // repair in the same process started WARM, which is exactly the state that
    // makes a solve's answer depend on what the process did before it. Both
    // orderings happen in one web request: the runners try the repair solver,
    // then an auto-schedule can follow on the same node process.
    //
    // WHICH HALF OF THIS TEST DOES THE WORK, measured rather than assumed: the
    // `z3LoadCount()` assertion below is the discriminating one — it reds with
    // `expected 1 to be +0` the moment the wrap comes off. The board comparison
    // at the end was mutation-tested with that witness neutered and it stayed
    // GREEN: a warm context from a repair does not happen to shift the tie-break
    // on THIS board. It is kept as a cheap canary, not claimed as the proof.
    //
    // The evidence that cross-solve coupling is real is `build.test.ts`'s
    // makespan case, measured directly by probe: cold it answers 10:30, and warm
    // behind that file's earlier solves it answered 10:00 — same input, two
    // boards. (`build-lns-wiring.test.ts` was cited for this in an earlier round
    // and that was an OVERSTATEMENT: it is a full-run flake both before and
    // after R17, measured red/red/green over three runs. It is band-sensitive on
    // `rlimit` and proves nothing either way.)
    //
    // Compared as a SET of (fixture, court, offset) rather than by row order:
    // the claim is that the BOARD is the same, and row order is a separate
    // property `build-lns.test.ts` owns.
    const cold = await isolated(async ({ build }) =>
      shape((await build.buildSchedule({ fixtures, config })).assignments),
    );
    const afterRepair = await isolated(async ({ build, repair, payload, z3 }) => {
      // A board with a real court clash, NOT a clean one. `repair.ts` answers a
      // clean proposal from a verifier precheck before it ever loads the WASM,
      // so a clean board leaves the context stone cold and the comparison below
      // would be vacuous — measured: it passed even unwrapped.
      const golden = payload.goldenBadminton();
      const first = golden[0]!;
      const clashed = golden.map((a) =>
        a.fixtureId === "gf"
          ? { ...a, court: first.court, startAt: first.startAt, endAt: first.endAt }
          : a,
      );
      const r = await repair.repairAndVerify({
        proposal: clashed,
        dependencies: payload.badmintonFeedDeps(),
        config: {
          ...payload.BASE_CONFIG,
          tz: "UTC",
          window: {
            from: payload.at("2026-08-10T08:00:00Z"),
            to: payload.at("2026-08-17T08:00:00Z"),
          },
          courts: ["C1", "C2"],
        },
        budgetMs: 60_000,
      });
      // THE DIRECT ASSERTION, and it goes FIRST on purpose. Unwrapped,
      // `repairSchedule` leaves its context loaded and the next solve starts
      // warm; this is that state, named. Ordering it ahead of the status check
      // means the mutant fails HERE — on the thing this case is about — rather
      // than on an outcome assertion a slow machine could also trip.
      expect(z3.z3LoadCount()).toBe(0);
      // The solver really ran, which is all this needs — a CLEAN board is
      // answered from a verifier precheck before the WASM ever loads, and would
      // make the assertion above vacuous. Deliberately `not "clean"` rather than
      // `=== "repaired"`: pinning the OUTCOME of a solve to a budget is how
      // `repair-scale:102` became a standing flake, and one of those in this
      // repo is enough.
      expect(r.status).not.toBe("clean");
      return shape((await build.buildSchedule({ fixtures, config })).assignments);
    });
    expect(afterRepair).toEqual(cold);
  }, 180_000);

  it("surfaces the SOLVE's error when the teardown throws as well", async () => {
    // A throw from inside a `finally` REPLACES the exception the block was
    // already unwinding. Without the catch, a genuine encoder-drift throw — the
    // loudest signal this subsystem has — reaches the caller dressed as a WASM
    // shutdown failure, and the next person reading the stack trace goes looking
    // in `z3-load.ts` for a bug that is in the encoder.
    //
    // `z3-solver` itself is stubbed rather than `z3-load.ts`, because the thing
    // under test IS `z3-load.ts`. The stub boots cleanly and fails only on
    // `shutdown()`, which is exactly the shape being guarded.
    vi.resetModules();
    vi.doMock("z3-solver", () => ({
      init: () =>
        Promise.resolve({
          Context: () => ({}),
          em: {
            PThread: {
              terminateAllThreads: () => {
                throw new Error("shutdown boom");
              },
            },
          },
          setParam: () => undefined,
        }),
    }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const z3 = await import("./z3-load.ts");
      await z3.loadZ3();
      // The positive witness again: a context really is loaded, so the teardown
      // below really does run and really does throw.
      expect(z3.z3LoadCount()).toBe(1);

      await expect(
        z3.withZ3LockAndReset(() => Promise.reject(new Error("solve boom"))),
      ).rejects.toThrow("solve boom");

      // The catch ran, rather than the failure being invisible.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("shutdown boom");
      // ...and swallowing it was SAFE: `tearDownZ3` clears the singleton in a
      // `finally` of its own, so the next `loadZ3` still starts clean. Without
      // that, this would be trading a wrong error message for a stuck context.
      expect(z3.z3LoadCount()).toBe(0);
    } finally {
      logged.mockRestore();
      vi.doUnmock("z3-solver");
      vi.resetModules();
    }
  }, 60_000);

  // UN-SKIPPED (fix round 1), REWRITTEN rather than mocked-in-place: the
  // original claim (`rlimitSpent > 0`, `z3LoadCount() === 0`) is entirely
  // about z3's WASM heap, which `solveBuild` never touches on this path any
  // more — both would now be checking numbers that are always 0/0
  // regardless of whether anything ran, exactly the vacuous reading this
  // file's own header comment warns against.
  //
  // What still genuinely needs covering: `buildSchedule` still wraps every
  // call in `withZ3LockAndReset` (`build.ts`, untouched — see the report's
  // finding on this), so two concurrent BUILD calls are still serialised
  // through ONE process-wide lock even though cp-sat is an out-of-process
  // RPC that shares no state between them. This case now proves the
  // narrower, still-true half of the original claim — the lock does not
  // wedge or corrupt either call — which is what a caller actually
  // depends on. It deliberately does NOT prove the lock is either NEEDED or
  // free of cost for this path; that is the open question the report flags
  // for a future round, not this test's job.
  it("still serialises, and still tears down, when two runs queue together", async () => {
    await isolated(
      async ({ build }) => {
        const [first, second] = await Promise.all([
          build.buildSchedule({ fixtures, config }),
          build.buildSchedule({ fixtures, config }),
        ]);
        // Both calls actually reached and used the mocked cp-sat client —
        // the positive witness that the lock serialised rather than
        // silently dropping or corrupting one of the two concurrent calls.
        expect(first.engine).toBe("cp-sat");
        expect(second.engine).toBe("cp-sat");
        expect(first.assignments.map((a) => a.fixtureId).sort()).toEqual(["a", "b"]);
        expect(second.assignments.map((a) => a.fixtureId).sort()).toEqual(["a", "b"]);
      },
      () => {
        vi.doMock("./cpsat-client.ts", async () => {
          const actual = await vi.importActual<typeof import("./cpsat-client.ts")>("./cpsat-client.ts");
          return {
            ...actual,
            solveBuild: async () => ({
              assignments: [
                { fixtureId: "b", court: "C1", startAtMs: T0 },
                { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
              ],
              status: "OPTIMAL",
              tiersCompleted: 4,
              objectiveValues: [],
              elapsedMs: 5,
              wallExhausted: false,
            }),
          };
        });
      },
    );
  }, 180_000);
});
