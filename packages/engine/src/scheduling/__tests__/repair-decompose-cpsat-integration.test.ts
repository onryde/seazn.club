// Decomposed repair on CP-SAT (C9) — REAL placement service.
//
// `repair-decompose-cpsat.test.ts` mocks `buildSchedule` to prove the
// driver's own logic (which components it solves, when it commits, when it
// discards). This file proves the two claims that a mock cannot: that the
// real placement service actually resolves a genuine clash once decomposed,
// and — the whole reason C9 exists — that a dependency edge with exactly one
// end swept into a component as a caller-frozen non-violator is CORRECTLY
// enforced by the real wire once both ends are movable `fixtures` entries.
// SKIPPED by default: see `services/placement/README.md`'s "Local dev"
// section to start a real service and run this for real.
import { describe, expect, it } from "vitest";
import { repairDecomposedCpsat } from "../repair-decompose-cpsat.ts";
import { isBlockingConflict, validateAssignments } from "../calendar.ts";
import type { Assignment, OrderDependency, SchedulableFixture, VerifyConfig } from "../calendar.ts";

// Same gate `placement-integration.test.ts` uses.
const RUN_INTEGRATION = process.env.PLACEMENT_SERVICE_HOST !== undefined;

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 8, 9, 0);

const at = (id: string, court: string, offsetMin: number, entrants: string[], durationMin = 30): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + offsetMin * MIN,
  endAt: T0 + (offsetMin + durationMin) * MIN,
  entrants,
  people: entrants.map((e) => `p-${e}`),
});

const fx = (id: string, home: string, away: string): SchedulableFixture => ({ id, home, away });

type TestConfig = VerifyConfig & { courts: string[]; startAt: number; matchMinutes: number };
const cfg = (over: Partial<VerifyConfig> = {}): TestConfig => ({
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
  courts: ["A", "B"],
  startAt: T0 - 60 * MIN,
  window: { from: T0 - 60 * MIN, to: T0 + 8 * 60 * MIN },
  ...over,
});

(RUN_INTEGRATION ? describe : describe.skip)(
  "repairDecomposedCpsat integration (requires a running placement service)",
  () => {
    it(
      "repairs a genuine court clash via the real placement service",
      async () => {
        const proposal = [at("f1", "A", 0, ["e1", "e2"]), at("f2", "A", 0, ["e3", "e4"])];
        const r = await repairDecomposedCpsat({
          fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
          proposal,
          callerFrozen: new Set(),
          config: cfg(),
          budgetMs: 20_000,
        });
        expect(r.status).toBe("repaired");
        expect(r.moved.length).toBeGreaterThan(0);
        expect(validateAssignments(r.assignments, cfg())).toEqual([]);
      },
      30_000,
    );

    it(
      // THE CENTRAL CLAIM THIS TASK RESTS ON: a free violator depending on a
      // frozen (caller-pinned/non-violator) feeder, decomposed into one
      // component, correctly resolves the order breach — the exact shape
      // `schedule-ai-solver.ts`'s C5 guard (`a59a9916`) used to decline
      // outright. The real wire still drops the dependency edge (the feeder
      // is `existing`, never `fixtures` — see the module doc comment for why
      // that is deliberate), so this exercises `nudgeForward` closing the
      // residual order breach directly against the real placement service's
      // OWN (dependency-blind) answer, not a mock standing in for one. Real,
      // named entrants throughout (this is the GENERAL frozen-feeder gap,
      // C4's own original finding shape) — see the module doc comment and
      // the PR body for the SEPARATE, narrower TBD-sibling shape this does
      // NOT close.
      "resolves a violator's order breach against a real, frozen feeder via the nudge, against the real placement service",
      async () => {
        // feeder frozen at T0..T0+30 (a real, decided fixture); dependent
        // free, currently AT the same instant as the feeder (illegal: must
        // start >= feeder's end).
        const proposal = [
          at("feeder", "A", 0, ["e1", "e2"]),
          at("dependent", "B", 0, ["e3", "e4"]),
        ];
        const dependencies: OrderDependency[] = [
          { fixtureId: "dependent", dependsOn: "feeder", direct: true },
        ];
        const before = validateAssignments(proposal, cfg(), [], dependencies);
        expect(before.some((c) => c.reason === "order")).toBe(true);

        const r = await repairDecomposedCpsat({
          fixtures: [fx("feeder", "e1", "e2"), fx("dependent", "e3", "e4")],
          proposal,
          callerFrozen: new Set(["feeder"]),
          dependencies,
          config: cfg(),
          budgetMs: 20_000,
        });

        expect(r.status).toBe("repaired");
        // The feeder never appears moved — structurally guaranteed, since it
        // was never a `buildSchedule` decision variable in the first place.
        const feederAfter = r.assignments.find((a) => a.fixtureId === "feeder")!;
        expect(feederAfter.court).toBe("A");
        expect(feederAfter.startAt).toBe(proposal[0]!.startAt);
        // The dependent now starts at or after the feeder's end.
        const dependentAfter = r.assignments.find((a) => a.fixtureId === "dependent")!;
        expect(dependentAfter.startAt).toBeGreaterThanOrEqual(feederAfter.startAt + 30 * MIN);
        const after = validateAssignments(r.assignments, cfg(), [], dependencies);
        expect(after.filter(isBlockingConflict)).toEqual([]);
      },
      30_000,
    );

    it(
      "regresses without the decomposition — the same board reds against a single monolithic buildSchedule call",
      async () => {
        // Same board as the previous test, driven through the OLD C5 shape
        // directly (one buildSchedule call, feeder passed via frozen/current
        // — never as a movable fixtures entry) to prove this is a genuine
        // fix, not a coincidence of the board shape.
        const { buildSchedule } = await import("../build.ts");
        const proposal = [
          at("feeder", "A", 0, ["e1", "e2"]),
          at("dependent", "B", 0, ["e3", "e4"]),
        ];
        const dependencies: OrderDependency[] = [
          { fixtureId: "dependent", dependsOn: "feeder", direct: true },
        ];
        const out = await buildSchedule({
          fixtures: [fx("dependent", "e3", "e4")],
          config: cfg(),
          existing: [],
          dependencies,
          current: proposal,
          frozen: ["feeder"],
          wallMs: 20_000,
        });
        // The monolithic C5 shape drops the dependency edge on the wire
        // (`feeder` never reaches `freeFixtureIds`) — the encoder places
        // `dependent` with no floor at all. Reconciled onto `feeder`'s real
        // slot (as `solveBoard` itself would), the board still breaches
        // order: this is the regression C9 exists to close.
        const reconciled = [
          ...out.assignments.filter((a) => a.fixtureId !== "feeder"),
          proposal[0]!,
        ];
        const conflicts = validateAssignments(reconciled, cfg(), [], dependencies);
        expect(conflicts.some((c) => c.reason === "order")).toBe(true);
      },
      30_000,
    );
  },
);
