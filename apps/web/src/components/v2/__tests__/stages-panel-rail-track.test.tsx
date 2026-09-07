import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// Competition Desk W3 Task 5, fix round 1 (Ruling T5-A, controller finding):
// `<StageRail>` returns `null` outright when `!canEdit` (stage-rail.tsx's
// own guard), but Task 5's grid wrapper put it in a FIXED
// `grid-cols-[1fr_280px]` track — a grid track reserves its column whether
// or not the child renders into it, unlike the old flex header a null
// child claimed zero space in. Left unconditional, every non-editing
// viewer got a permanent blank 280px strip (plus the gap) to the right of
// each stage card at `md` and above.
//
// SUPERSEDED — "Option B" (controller measurement, owner sign-off session,
// rejecting the two-column layout entirely): the grid track this test used
// to check for CONDITIONAL-on-`canEdit` presence is now gone outright, for
// BOTH viewers. It was never the void's real cause on its own — the
// column's fixed 280px track forced the whole CARD to whatever height the
// rail needed (equal-height grid-row stretch), measured
// `body=262px rail=262px content=99px VOID=163px` at 1280, 62% empty, and
// no amount of body content could ever have closed that gap. The fix is
// architectural: `stages-panel.tsx` no longer wraps `stage-sheet`/
// `stage-rail` in ANY grid — both are ordinary stacked, full-width blocks,
// so this file's own regression coverage is now "neither viewer gets a
// column", not "only an editor does".
const twoColumnTrack = /grid-cols-\[1fr_280px\]/;

const STAGE = {
  id: "s1",
  seq: 0,
  kind: "league",
  name: "League",
  config: {},
  progression: null,
  status: "active",
};
const baseProps = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  stages: [STAGE],
  fixtures: [],
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
};

describe("StagesPanel — the stage body has no two-column track for either viewer (Option B retires Ruling T5-A's grid)", () => {
  it("does NOT reserve a 280px rail column for a viewer who cannot edit", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit={false} />);
    expect(html).not.toMatch(twoColumnTrack);
  });

  it("does NOT reserve a 280px rail column for an editor either — Option B removed it for everyone", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit />);
    expect(html).not.toMatch(twoColumnTrack);
  });

  it("both viewers render the same stage-sheet/stage-rail testids regardless — the grid wrapper is gone, not the divs", () => {
    const editorHtml = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit />);
    const viewerHtml = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit={false} />);
    for (const html of [editorHtml, viewerHtml]) {
      expect(html).toContain('data-testid="stage-sheet"');
      expect(html).toContain('data-testid="stage-rail"');
    }
  });
});
