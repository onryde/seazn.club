import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// Regression (fix-ui audit 03-console-division.md, "Division fixtures list —
// mobile 390px — fixture rows overlap their own status badges/buttons"):
// team names and the badges/buttons cluster used to share one
// `flex flex-wrap` row, which can visually collide on narrow viewports.
// The row must stack (team names, then badges/buttons on their own line)
// below the md breakpoint, and stay side-by-side at md+ via `md:contents`.
//
// Breakpoint corrected from `sm:` to `md:` (controller finding, competition
// desk W3): Task 8 (`cbd672872`, "one phone breakpoint for the whole desk")
// rewrote `run-sheet-row.tsx`'s own `sm:flex-row`/`sm:contents` to
// `md:flex-row`/`md:contents` as part of unifying every desk breakpoint on
// `md:` (ruling 15), but this test kept asserting the retired `sm:` string —
// a real regression that sat green-looking-red on the branch, unselected by
// every scoped run since (Task 8's own 87/87, its reviewer's re-run, Task
// 9's spec-file run). The CLAIM this test makes was never wrong — the
// cluster still stacks below the breakpoint and restores via `contents`
// above it — only the breakpoint LITERAL had gone stale. Repointed here,
// not weakened.
const STAGE = {
  id: "s1", seq: 0, kind: "league", name: "League",
  config: {}, progression: null, status: "active",
};
const baseProps = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [STAGE],
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  // Governing venue clock (#448) — display `tz` may diverge from it.
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
};
const fixture = {
  id: "f1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
  fixture_no: 1, home_entrant_id: "e1", away_entrant_id: "e2",
  scheduled_at: "2026-08-16T13:30:00.000Z", venue: null, court_label: null, court_id: null, court_name: null,
  status: "scheduled", outcome: null,
};

describe("StagesPanel — mobile fixture-row layout", () => {
  it("stacks the badges/buttons cluster onto its own row on mobile, restoring the desktop row via md:contents", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} fixtures={[fixture]} />);
    // Outer row must switch to a column on mobile.
    expect(html).toMatch(/flex-col[^"]*md:flex-row/);
    // The badges/buttons wrapper must vanish from the flex tree at md+.
    expect(html).toMatch(/class="[^"]*md:contents[^"]*"/);
  });
});
