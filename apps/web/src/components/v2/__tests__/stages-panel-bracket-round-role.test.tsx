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
  config: {}, progression: null, status: "active",
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
//
// Competition Desk W2 (Task 4): `scheduled_at` is now REQUIRED and non-null.
// `buildRunSheet` (run-sheet-groups.ts) only routes a null-`scheduled_at`
// fixture to the division-wide "Not yet scheduled" group when its status is
// OPEN (`scheduled`/`in_play`) — a SETTLED bracket fixture with no time stays
// in its own round section instead (fix round 1: dropping it altogether was
// a worse defect than finding 3, which this file's fixtures never exercised
// either way, since every one below is `status: "scheduled"`, i.e. OPEN). For
// these OPEN fixtures specifically, a null time WOULD still put them in the
// unscheduled group rather than the bracket block this test is actually
// about, so the time stays real. These objects previously omitted the field
// entirely, which typechecked only because the whole array is cast `as
// never` below — at runtime that silently fell through as `undefined` (not
// `null`), which happened to still land in the bracket branch under the
// OLDER (unconditional) routing, but also crashed `fixtureRowAction`'s
// `Date.parse(undefined)` once this test started exercising the row-action
// ladder too (Task 4 mounts `<RunSheet>` inside `StagesPanel`, which is what
// turned the omission from harmless to fatal).
const fixtures = [
  { id: "w1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1, home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: "2026-09-05T09:00:00.000Z", status: "scheduled", outcome: null, lane: "WB" as const, is_final: false, third_place: false, conditional: false },
  { id: "w2", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 2, fixture_no: 2, home_entrant_id: "e3", away_entrant_id: "e4", scheduled_at: "2026-09-05T09:00:00.000Z", status: "scheduled", outcome: null, lane: "WB" as const, is_final: false, third_place: false, conditional: false },
  { id: "wf", stage_id: "s1", pool_id: null, round_no: 2, seq_in_round: 1, fixture_no: 3, home_entrant_id: null, away_entrant_id: null, scheduled_at: "2026-09-05T09:00:00.000Z", status: "scheduled", outcome: null, lane: "WB" as const, is_final: false, third_place: false, conditional: false },
  { id: "l1", stage_id: "s1", pool_id: null, round_no: 5, seq_in_round: 1, fixture_no: 4, home_entrant_id: null, away_entrant_id: null, scheduled_at: "2026-09-05T09:00:00.000Z", status: "scheduled", outcome: null, lane: "LB" as const, is_final: false, third_place: false, conditional: false },
  { id: "lf", stage_id: "s1", pool_id: null, round_no: 6, seq_in_round: 1, fixture_no: 5, home_entrant_id: null, away_entrant_id: null, scheduled_at: "2026-09-05T09:00:00.000Z", status: "scheduled", outcome: null, lane: "LB" as const, is_final: false, third_place: false, conditional: false },
  { id: "gf", stage_id: "s1", pool_id: null, round_no: 9, seq_in_round: 1, fixture_no: 6, home_entrant_id: null, away_entrant_id: null, scheduled_at: "2026-09-05T09:00:00.000Z", status: "scheduled", outcome: null, lane: "GF" as const, is_final: true, third_place: false, conditional: false },
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
