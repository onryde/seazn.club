import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// Competition Desk W3 Task 3, fix round 1 — controller finding: routing
// StageCourtTagsEditor through StageRail's courtTagsSlot made it inherit the
// rail's `!canEdit -> return null`. A non-editing viewer used to see a
// stage's court-tag requirements read-only (the old standalone mount carried
// no canEdit gate of its own); after the naive slot move they saw nothing.
// Fix (controller ruling): the panel builds the editor element ONCE per
// stage and places it in exactly one of two positions — the rail's slot
// when canEdit, inline where it used to live when !canEdit.
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
};

const courtTags = /data-testid="stage-court-tags"/;

describe("StagesPanel — court-tags editor visibility (fix round 1)", () => {
  it("shows the court-tags editor, read-only, to a viewer who cannot edit", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit={false} />);
    expect(html).toMatch(courtTags);
  });

  it("still shows the court-tags editor to an editor, mounted via the rail", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} canEdit />);
    expect(html).toMatch(courtTags);
  });
});
