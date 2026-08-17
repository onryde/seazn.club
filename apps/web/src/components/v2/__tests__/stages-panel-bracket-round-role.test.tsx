import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// F1 Task 4, consumer 3/5: the console StagesPanel's per-round bracket cards
// used to name rounds off a STAGE-WIDE `maxRound` — for a double-elim, the
// losers bracket's round_no range (5-6 here) sits ABOVE the winners
// bracket's (1-2), so a global max reads the WB final as "not the last
// round" and misnames it. roundRoleFor ranks each round within its own lane.
const STAGE = {
  id: "s1", seq: 0, kind: "double_elim", name: "DE",
  config: {}, qualification: null, status: "active",
};
const baseProps = {
  divisionId: "d1", divisionSeq: 5, competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [STAGE],
  entrantNames: { e1: "Alpha", e2: "Bravo", e3: "Charlie", e4: "Delta" },
  canEdit: true,
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
};

// Persisted round numbering for a 4-entrant DE (k=2): WB 1-2, LB 5-6, GF 9 —
// mirrors the shape already proven in public-site/__tests__/bracket.test.tsx's
// "renders the two-lane double-elim geometry" case.
const fixtures = [
  { id: "w1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "scheduled", outcome: null, lane: "WB" as const, is_final: false, third_place: false, conditional: false },
  { id: "w2", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 2, fixture_no: 2, home_entrant_id: "e3", away_entrant_id: "e4", status: "scheduled", outcome: null, lane: "WB" as const, is_final: false, third_place: false, conditional: false },
  { id: "wf", stage_id: "s1", pool_id: null, round_no: 2, seq_in_round: 1, fixture_no: 3, home_entrant_id: null, away_entrant_id: null, status: "scheduled", outcome: null, lane: "WB" as const, is_final: false, third_place: false, conditional: false },
  { id: "l1", stage_id: "s1", pool_id: null, round_no: 5, seq_in_round: 1, fixture_no: 4, home_entrant_id: null, away_entrant_id: null, status: "scheduled", outcome: null, lane: "LB" as const, is_final: false, third_place: false, conditional: false },
  { id: "lf", stage_id: "s1", pool_id: null, round_no: 6, seq_in_round: 1, fixture_no: 5, home_entrant_id: null, away_entrant_id: null, status: "scheduled", outcome: null, lane: "LB" as const, is_final: false, third_place: false, conditional: false },
  { id: "gf", stage_id: "s1", pool_id: null, round_no: 9, seq_in_round: 1, fixture_no: 6, home_entrant_id: null, away_entrant_id: null, status: "scheduled", outcome: null, lane: "GF" as const, is_final: true, third_place: false, conditional: false },
];

describe("StagesPanel — bracket round role (F1 Task 4)", () => {
  it("names the WB final Winners' final and the LB final Losers' final, not by a stage-wide max", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} fixtures={fixtures as never} />);
    // renderToStaticMarkup HTML-escapes apostrophes as &#x27;.
    expect(html).toContain("Winners&#x27; final");
    expect(html).toContain("Losers&#x27; final");
    expect(html).toContain("Grand final");
    expect(html).toContain("Semi-finals"); // WB round 1 (2 games, 1 round out from the WB final)
  });
});
