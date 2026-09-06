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
// `lg:grid-cols-[1fr_280px]` track — a grid track reserves its column
// whether or not the child renders into it, unlike the old flex header a
// null child claimed zero space in. Left unconditional, every non-editing
// viewer got a permanent blank 280px strip (plus the 24px gap) to the right
// of each stage card at `lg` and above — a regression against the
// pre-Task-5 layout, not a pre-existing quirk. This is the THIRD instance of
// the same root cause in this wave (the court-tags editor,
// stages-panel-court-tags-viewer.test.tsx, Task 3; the unscheduled-count
// badge, stages-panel-unscheduled-heading.test.tsx, Task 4; now the column
// itself): anything keyed to the rail has to account for the rail rendering
// nothing for a non-editing viewer.
//
// Fix: the two-column track class is CONDITIONAL on `canEdit` — a
// non-editing viewer gets a plain single-column body that claims the full
// card width; an editing viewer is unchanged. Node-environment vitest has no
// DOM/layout, so this asserts the class string itself (same idiom as
// stages-panel-court-tags-viewer.test.tsx) rather than a measured width —
// the `lg` two-column geometry itself stays proven by the Task 5 e2e in
// run-sheet.spec.ts, which runs as an editing viewer only.
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
  divisionSeq: 5,
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
};

const twoColumnTrack = /lg:grid-cols-\[1fr_280px\]/;

describe("StagesPanel — the stage body's two-column track (fix round 1, Ruling T5-A)", () => {
  it("does NOT reserve the rail's 280px column for a viewer who cannot edit", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit={false} />);
    expect(html).not.toMatch(twoColumnTrack);
  });

  it("still reserves the two-column track for an editor, where the rail actually renders", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit />);
    expect(html).toMatch(twoColumnTrack);
  });
});
