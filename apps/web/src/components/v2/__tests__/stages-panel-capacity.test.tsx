import { describe, expect, it } from "vitest";
import { capacityForStage } from "@/components/v2/stages-panel";

// D2 capacity pre-check, per-stage (the "Auto-schedule remaining" button's
// disabled condition). Pure — `scheduleSettings` arrives via a useEffect
// fetch in the real component, which renderToStaticMarkup never fires (see
// component-ui-i18n memory), so this is tested directly with hand-built
// inputs rather than through a render.
const ORG_TZ = "UTC";
const DIV = "div-1";

interface FxRow {
  id: string;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  pool_id: string | null;
  status: string;
}

// Auto-incrementing rather than a parameter: `id` is a new field on every
// existing call site here (capacityForStage now reads it, stages-panel.tsx —
// forcedDemand wiring), and none of these tests care WHICH id a fixture
// gets, only that each is distinct.
let fxCounter = 0;
const fx = (stageId: string, status: string, home: string | null, away: string | null): FxRow => ({
  id: `fx-${++fxCounter}`,
  stage_id: stageId,
  status,
  home_entrant_id: home,
  away_entrant_id: away,
  pool_id: null,
});

describe("capacityForStage", () => {
  it("returns null when schedule settings haven't loaded yet (never a false impossible)", () => {
    expect(capacityForStage("s1", [], undefined, ORG_TZ, DIV)).toBeNull();
  });

  it("returns null when there is no bounded window (no endAt) — nothing to assess", () => {
    const report = capacityForStage(
      "s1",
      [fx("s1", "scheduled", "A", "B")],
      { startAt: "2026-08-01T09:00:00.000Z", matchMinutes: 30, gapMinutes: 0 },
      ORG_TZ,
      DIV,
    );
    expect(report).toBeNull();
  });

  it("is impossible for a stage with 6 round-robin fixtures and a 1-hour window on one court", () => {
    const fixtures: FxRow[] = [
      fx("s1", "scheduled", "A", "B"),
      fx("s1", "scheduled", "A", "C"),
      fx("s1", "scheduled", "A", "D"),
      fx("s1", "scheduled", "B", "C"),
      fx("s1", "scheduled", "B", "D"),
      fx("s1", "scheduled", "C", "D"),
    ];
    const report = capacityForStage(
      "s1",
      fixtures,
      {
        startAt: "2026-08-01T09:00:00.000Z",
        endAt: "2026-08-01T23:59:00.000Z",
        matchMinutes: 60,
        gapMinutes: 0,
        courts: ["Court 1"],
        sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
      },
      ORG_TZ,
      DIV,
    );
    expect(report?.verdict).toBe("impossible");
  });

  it("scopes to ONE stage — a sibling stage's fixtures never count toward this stage's demand", () => {
    const fixtures: FxRow[] = [
      fx("s1", "scheduled", "A", "B"), // this stage: 1 fixture, fits easily
      fx("s2", "scheduled", "A", "C"),
      fx("s2", "scheduled", "A", "D"),
      fx("s2", "scheduled", "B", "C"),
      fx("s2", "scheduled", "B", "D"),
      fx("s2", "scheduled", "C", "D"), // sibling stage: 5 fixtures — would blow the same tiny window
    ];
    const config = {
      startAt: "2026-08-01T09:00:00.000Z",
      endAt: "2026-08-01T23:59:00.000Z",
      matchMinutes: 60,
      gapMinutes: 0,
      courts: ["Court 1"],
      sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }], // 1 slot
    };
    // s1 has 1 fixture against 1 available slot: ratio 1.0 is "tight", not
    // "impossible" — the point of this test is scoping, so assert that,
    // not a specific non-impossible verdict.
    expect(capacityForStage("s1", fixtures, config, ORG_TZ, DIV)?.verdict).not.toBe("impossible");
    expect(capacityForStage("s2", fixtures, config, ORG_TZ, DIV)?.verdict).toBe("impossible");
  });

  it("excludes a non-movable (already-decided) fixture from demand", () => {
    const fixtures: FxRow[] = [fx("s1", "decided", "A", "B")];
    const config = {
      startAt: "2026-08-01T09:00:00.000Z",
      endAt: "2026-08-01T09:05:00.000Z", // absurdly tight — would be impossible if counted
      matchMinutes: 60,
      gapMinutes: 0,
      courts: ["Court 1"],
    };
    const report = capacityForStage("s1", fixtures, config, ORG_TZ, DIV);
    expect(report?.slotDemand).toBe(0);
    expect(report?.verdict).toBe("ok");
  });
});
