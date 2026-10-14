// D29 (engine split): `solve` and `log` are REQUIRED on `BuildInput` and on `DecomposedCpsatRepairInput`, and "required" must
// hold at RUN time too, not only for the compiler. The type is erased in compiled JS (phase 1b publishes it), and an `any` or a
// hand-built input reaches the same code. Without a runtime guard a caller that forgot `solve` fell into `buildSchedule`'s
// catch-all around `input.solve(...)`, which logged "placement service unavailable" and returned a greedy board stamped
// `solver_unavailable`: the inert seam D29 exists to prevent, looking like an outage. A forgotten port must be a programmer
// error that surfaces as one, ahead of any fallback.
//
// Not a placement path: the guard sits at the very top of both functions, so none of these need a board that can be solved.
import { describe, expect, it, vi } from "vitest";
import { buildSchedule, type BuildInput } from "./build.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";
import { repairDecomposedCpsat, type DecomposedCpsatRepairInput } from "./repair-decompose-cpsat.ts";
import { silentLogger, unavailableSolver } from "./__tests__/solver-fakes.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 180 * MIN },
};
const fixtures: SchedulableFixture[] = [{ id: "a", home: "E1", away: "E2", roundNo: 1 }];
const problem: Omit<BuildInput, "solve" | "log"> = { fixtures, config };
const repairProblem: Omit<DecomposedCpsatRepairInput, "solve" | "log"> = {
  fixtures,
  config,
  proposal: [],
  callerFrozen: new Set(),
};

/** The input with the named port knocked out, the way compiled JS (or an `any`) would hand it in. */
const WITHOUT = {
  "solve omitted": { log: silentLogger },
  "solve not a function": { solve: "placement", log: silentLogger },
  "log omitted": { solve: unavailableSolver },
  "log is null": { solve: unavailableSolver, log: null },
  "log lacks info": { solve: unavailableSolver, log: { debug() {}, warn() {}, error() {} } },
  "log lacks debug": { solve: unavailableSolver, log: { info() {}, warn() {}, error() {} } },
  "log lacks warn": { solve: unavailableSolver, log: { debug() {}, info() {}, error() {} } },
  "log lacks error": { solve: unavailableSolver, log: { debug() {}, info() {}, warn() {} } },
} as const;
const CASES = Object.entries(WITHOUT);

describe("buildSchedule refuses an input without its ports, as a TypeError and not as a greedy board", () => {
  it("sweeps every way a port can be missing (anti-vacuity)", () => {
    expect(CASES.length, "cases swept").toBeGreaterThanOrEqual(8);
  });

  it.each(CASES)("%s: rejects with a TypeError naming the port, and never resolves to solver_unavailable", async (_label, ports) => {
    const input = { ...problem, ...ports } as unknown as BuildInput;
    // `async` wrapper so that a synchronous throw and a rejected promise read the same.
    const outcome = await (async () => buildSchedule(input))().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    expect(outcome, `resolved instead of refusing: ${JSON.stringify(outcome)}`).toHaveProperty("error");
    const { error } = outcome as { error: unknown };
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(/buildSchedule: .*\b(solve|log)\b/);
  });

  it("a valid input is untouched by the guard: the same call with both ports still returns a board", async () => {
    const solve = vi.fn(unavailableSolver);
    const result = await buildSchedule({ ...problem, solve, log: silentLogger });
    expect(solve, "the solver was asked").toHaveBeenCalledTimes(1);
    expect(result.status).toBe("solver_unavailable"); // the fake rejects; the point is that the guard did not fire
    expect(result.assignments).toHaveLength(1);
  });

  it("does not count a refused call against the solver queue", async () => {
    // A guard placed AFTER the `queued++` would leak a slot per bad call. Three bad calls, then a good one must still ask.
    for (let i = 0; i < 3; i++) {
      await expect((async () => buildSchedule({ ...problem, log: silentLogger } as unknown as BuildInput))()).rejects.toThrow(TypeError);
    }
    const solve = vi.fn(unavailableSolver);
    const result = await buildSchedule({ ...problem, solve, log: silentLogger });
    expect(result.status, "a leaked slot would answer solver_busy without asking").not.toBe("solver_busy");
    expect(solve).toHaveBeenCalledTimes(1);
  });

  it("the type says so too: omitting `solve` does not compile", async () => {
    // @ts-expect-error `solve` is required on BuildInput (D29); if this line ever compiles, the seam can be left inert.
    const missing = buildSchedule({ ...problem, log: silentLogger });
    await expect(missing).rejects.toThrow(TypeError);
  });

  it("the type says so too: omitting `log` does not compile", async () => {
    // @ts-expect-error `log` is required on BuildInput (D25).
    const missing = buildSchedule({ ...problem, solve: unavailableSolver });
    await expect(missing).rejects.toThrow(TypeError);
  });
});

describe("repairDecomposedCpsat refuses an input without its ports, even when the board would never reach a solver", () => {
  it.each(CASES)("%s: rejects with a TypeError naming the port", async (_label, ports) => {
    // `proposal: []` verifies clean, so without the guard this would return `clean` and never touch either port: exactly the
    // call that hides a forgotten port until the day a real violation arrives.
    const input = { ...repairProblem, ...ports } as unknown as DecomposedCpsatRepairInput;
    const error = await repairDecomposedCpsat(input).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, "resolved instead of refusing").toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(/repairDecomposedCpsat: .*\b(solve|log)\b/);
  });

  it("a valid input still returns clean for a board that already verifies", async () => {
    const result = await repairDecomposedCpsat({ ...repairProblem, solve: unavailableSolver, log: silentLogger });
    expect(result.status).toBe("clean");
  });

  it("the type says so too: omitting `solve` does not compile", async () => {
    // @ts-expect-error `solve` is required on DecomposedCpsatRepairInput (D29).
    const missing = repairDecomposedCpsat({ ...repairProblem, log: silentLogger });
    await expect(missing).rejects.toThrow(TypeError);
  });
});
