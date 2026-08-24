import { describe, expect, it } from "vitest";
import { capacityRequestForStage } from "@/components/v2/stages-panel";

// D2 capacity pre-check, per-stage (the "Auto-schedule remaining" button's
// disabled condition). Pure — `scheduleSettings` arrives via a useEffect
// fetch in the real component, which renderToStaticMarkup never fires (see
// component-ui-i18n memory), so this is tested directly with hand-built
// inputs rather than through a render.
//
// P10 §4/Task 6 rewrite: capacityForStage used to call
// capacityInputForFixtures + assessCapacity itself and return a
// CapacityReport (verdict/slotDemand/etc). It is now capacityRequestForStage
// — a pure MAPPING to the wire body useCapacityReport sends — because the
// verdict itself only ever comes from the server now (see
// useCapacityReport's own header). Coverage intent is unchanged (which
// fixtures are in scope, the window-bounds edge cases, the never-throw
// unbounded-start case); what changed is the shape asserted against: the
// built REQUEST, not a computed report. Verdict arithmetic itself is
// covered server-side (capacity-endpoint.test.ts) and by the hook
// (use-capacity-report.test.ts).
const ORG_TZ = "UTC";

interface FxRow {
  id: string;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  pool_id: string | null;
  status: string;
}

// Auto-incrementing rather than a parameter: `id` is a new field on every
// existing call site here (capacityRequestForStage now reads it,
// stages-panel.tsx — forcedDemand wiring), and none of these tests care
// WHICH id a fixture gets, only that each is distinct.
let fxCounter = 0;
const fx = (stageId: string, status: string, home: string | null, away: string | null): FxRow => ({
  id: `fx-${++fxCounter}`,
  stage_id: stageId,
  status,
  home_entrant_id: home,
  away_entrant_id: away,
  pool_id: null,
});

describe("capacityRequestForStage", () => {
  it("returns null when schedule settings haven't loaded yet (never a false impossible)", () => {
    expect(capacityRequestForStage("s1", [], undefined, ORG_TZ)).toBeNull();
  });

  it("returns null when matchMinutes/gapMinutes are missing (settings loaded but incomplete)", () => {
    expect(capacityRequestForStage("s1", [fx("s1", "scheduled", "A", "B")], { courts: ["Court 1"] }, ORG_TZ)).toBeNull();
    expect(
      capacityRequestForStage("s1", [fx("s1", "scheduled", "A", "B")], { matchMinutes: 30 }, ORG_TZ),
    ).toBeNull();
  });

  it("builds an undefined window when neither startAt nor endAt is set", () => {
    const req = capacityRequestForStage("s1", [fx("s1", "scheduled", "A", "B")], { matchMinutes: 30, gapMinutes: 0 }, ORG_TZ);
    expect(req?.config.window).toBeUndefined();
  });

  // The shipped crash: a division with an END date and no START date. The
  // window built here is `{ from: -Infinity, to: <finite> }` — construction
  // itself must never throw (useCapacityReport's own guard is what now
  // skips sending it, see hasAssessableWindow).
  it("builds an unbounded-start window (-Infinity) when endAt is set but startAt is not — must not throw", () => {
    const call = () =>
      capacityRequestForStage(
        "s1",
        [fx("s1", "scheduled", "A", "B")],
        { endAt: "2026-08-13T22:59:00.000Z", matchMinutes: 30, gapMinutes: 0 },
        ORG_TZ,
      );
    expect(call).not.toThrow();
    expect(call()?.config.window).toEqual({ from: -Infinity, to: expect.any(Number) });
  });

  it("scopes to ONE stage — a sibling stage's fixtures never appear in this stage's request", () => {
    const fixtures: FxRow[] = [
      fx("s1", "scheduled", "A", "B"),
      fx("s2", "scheduled", "A", "C"),
      fx("s2", "scheduled", "A", "D"),
    ];
    const config = { matchMinutes: 60, gapMinutes: 0, courts: ["Court 1"] };
    const req1 = capacityRequestForStage("s1", fixtures, config, ORG_TZ);
    const req2 = capacityRequestForStage("s2", fixtures, config, ORG_TZ);
    expect(req1?.fixtures).toEqual([{ home: "A", away: "B", poolId: undefined, id: fixtures[0]!.id }]);
    expect(req2?.fixtures).toHaveLength(2);
  });

  it("excludes a non-movable (already-decided) fixture from the request", () => {
    const req = capacityRequestForStage(
      "s1",
      [fx("s1", "decided", "A", "B")],
      { matchMinutes: 60, gapMinutes: 0, courts: ["Court 1"] },
      ORG_TZ,
    );
    expect(req?.fixtures).toEqual([]);
  });

  it("converts sessionWindows/blackouts from ISO strings to epoch-ms pairs", () => {
    const req = capacityRequestForStage(
      "s1",
      [],
      {
        matchMinutes: 30,
        gapMinutes: 0,
        sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
        blackouts: [{ from: "2026-08-01T12:00:00.000Z", to: "2026-08-01T13:00:00.000Z" }],
      },
      ORG_TZ,
    );
    expect(req?.config.sessionWindows).toEqual([
      { from: Date.parse("2026-08-01T09:00:00.000Z"), to: Date.parse("2026-08-01T10:00:00.000Z") },
    ]);
    expect(req?.config.blackouts).toEqual([
      { from: Date.parse("2026-08-01T12:00:00.000Z"), to: Date.parse("2026-08-01T13:00:00.000Z") },
    ]);
  });

  it("defaults courts to a single synthetic court when the division has none configured", () => {
    const req = capacityRequestForStage("s1", [], { matchMinutes: 30, gapMinutes: 0 }, ORG_TZ);
    expect(req?.config.courts).toEqual(["Court 1"]);
  });

  it("defaults perEntrantMinRest to 0 when absent", () => {
    const req = capacityRequestForStage("s1", [], { matchMinutes: 30, gapMinutes: 0 }, ORG_TZ);
    expect(req?.config.perEntrantMinRest).toBe(0);
  });

  it("carries matchMinutes/gapMinutes straight through", () => {
    const req = capacityRequestForStage("s1", [], { matchMinutes: 45, gapMinutes: 10 }, ORG_TZ);
    expect(req?.config.matchMinutes).toBe(45);
    expect(req?.config.gapMinutes).toBe(10);
  });
});
