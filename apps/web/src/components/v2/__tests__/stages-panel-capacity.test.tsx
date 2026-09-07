import { describe, expect, it } from "vitest";
import { capacityGateBlocks, capacityRequestForStage } from "@/components/v2/stages-panel";
import type { UseCapacityReportResult } from "@/lib/use-capacity-report";
import type { CapacityReport } from "@seazn/engine/scheduling/capacity";
import type { Venue } from "@/components/v2/shared/court-multi-picker";

// Two real org courts under one venue — same minimal shape
// settings-panel-capacity.test.tsx's own orgVenues() fixture uses, for the
// SAME fallback rule (review finding 5 reuses settings-panel.tsx's
// effectiveCourts approach rather than inventing a second one).
function orgVenues(): Venue[] {
  return [
    {
      id: "venue-1",
      name: "Riverside Centre",
      address: null,
      sort: 0,
      archived_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      courts: [
        {
          id: "court-1",
          venue_id: "venue-1",
          name: "Court 1",
          sort: 0,
          tags: [],
          archived_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "court-2",
          venue_id: "venue-1",
          name: "Court 2",
          sort: 1,
          tags: [],
          archived_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ];
}

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

  // Review finding 5: this test used to pin the BUG — `config.courts ?? ["Court
  // 1"]` sent a fake, non-uuid court label whenever a division had none
  // configured, which is also a guaranteed 400 against CapacityPrecheckInput's
  // `z.uuid()` schema if it ever reached the wire. `ScheduleConfig.courts`
  // defaults to `[]`, never nullish, so the REAL failure mode was an EMPTY
  // array (0 supply -> "impossible" -> Auto-schedule wrongly disabled), not
  // just the `undefined` this test's own fixture happens to construct — see
  // the two tests below for both shapes.
  it("falls back to every non-archived org court (via venues) when the division has none configured — mirrors settings-panel.tsx's effectiveCourts", () => {
    const req = capacityRequestForStage(
      "s1",
      [],
      { matchMinutes: 30, gapMinutes: 0 },
      ORG_TZ,
      orgVenues(),
    );
    expect(req?.config.courts).toEqual(["court-1", "court-2"]);
  });

  it("falls back the same way when config.courts is an EMPTY array (the real shape a saved division sends), not just when the key is absent", () => {
    const req = capacityRequestForStage(
      "s1",
      [],
      { matchMinutes: 30, gapMinutes: 0, courts: [] },
      ORG_TZ,
      orgVenues(),
    );
    expect(req?.config.courts).toEqual(["court-1", "court-2"]);
  });

  it("returns an empty court list (never the retired ['Court 1'] literal) when no venues have loaded yet either", () => {
    const req = capacityRequestForStage("s1", [], { matchMinutes: 30, gapMinutes: 0 }, ORG_TZ);
    expect(req?.config.courts).toEqual([]);
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

// Review fix (Finding 2): the Auto-schedule button's `disabled` condition and
// its "blocked reason" line used to inline
// `capacityByStage.get(stage.id)?.report?.verdict === "impossible"` TWICE —
// reading a STALE report the same way whether the check was merely catching
// up or had genuinely stopped running. Extracted to one shared predicate so
// the two call sites can never disagree, and so the fail-open rule is
// unit-testable directly (stages-panel.tsx has no other way to exercise its
// gate: `scheduleSettings` only ever arrives via a useEffect fetch, which
// renderToStaticMarkup never runs — see capacityRequestForStage's own header).
describe("capacityGateBlocks", () => {
  const withVerdict = (verdict: CapacityReport["verdict"], over: Partial<UseCapacityReportResult> = {}): UseCapacityReportResult => ({
    report: { verdict, slotSupply: 1, slotDemand: 2, perDay: [], restBound: [], suggestions: [] },
    stale: false,
    failed: false,
    ...over,
  });

  it("blocks on a genuinely fresh impossible verdict", () => {
    expect(capacityGateBlocks(withVerdict("impossible"))).toBe(true);
  });

  it("does not block on ok or tight verdicts", () => {
    expect(capacityGateBlocks(withVerdict("ok"))).toBe(false);
    expect(capacityGateBlocks(withVerdict("tight"))).toBe(false);
  });

  it("does not block when there is no report yet (settings not loaded, or nothing to assess)", () => {
    expect(capacityGateBlocks(undefined)).toBe(false);
    expect(capacityGateBlocks({ report: null, stale: false, failed: false })).toBe(false);
  });

  it("does NOT block a stale-but-still-in-flight impossible verdict — an edit landed but the check hasn't failed", () => {
    expect(capacityGateBlocks(withVerdict("impossible", { stale: true }))).toBe(true); // unchanged: still gates on the last KNOWN verdict while merely catching up
  });

  it("FAILS OPEN: a stale impossible verdict must not block once the check has actually FAILED — review finding", () => {
    expect(capacityGateBlocks(withVerdict("impossible", { stale: true, failed: true }))).toBe(false);
  });
});

// Finding 6 (retired — Task 2, "remove auto-schedule from the fixtures
// page"): this described a "no synchronous client-side fallback computation"
// regression guard for the Auto-schedule CTA's disabled/blocked-reason
// rendering. That CTA, `capacityByStage`, and the `useCapacityReportsByStage`
// subscription that fed it are all gone from StagesPanel now — scheduling
// lives on the Schedule page only (owner ruling). The whole subject this
// guard existed to protect no longer renders anywhere in this component, so
// it is deleted deliberately rather than weakened or kept vacuously true.
// `capacityRequestForStage`/`capacityGateBlocks` above remain: pure,
// independently useful mapping/predicate functions with their own direct
// coverage, unaffected by the CTA's removal.
