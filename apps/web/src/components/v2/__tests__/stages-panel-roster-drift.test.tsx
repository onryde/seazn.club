import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel, rebuildBlockedMessage } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// F3 Task 5 (5a/5b) — the roster-drift banner StagesPanel renders per stage,
// fed getStageRosterDrift's result as a server prop (division page). No DOM
// interaction here (renderToStaticMarkup never fires effects/handlers — see
// stages-panel-delete.test.tsx's identical harness) — these are pure
// prop-in/HTML-out assertions, plus the classifier's own unit tests below.
const STAGE = {
  id: "s1", seq: 0, kind: "league", name: "League",
  config: {}, progression: null, status: "active",
};
const baseProps = {
  divisionId: "d1", divisionSeq: 5, competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [STAGE],
  fixtures: [],
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
};
const GHOST_DRIFT = {
  s1: { ghosts: [{ id: "e1", display_name: "Withdrawn Wendy" }], unplaced: [] },
};
const UNPLACED_DRIFT = {
  s1: { ghosts: [], unplaced: [{ id: "e3", display_name: "New Nadia" }] },
};
const NO_DRIFT = {
  s1: { ghosts: [], unplaced: [] },
};

const banner = /data-testid="roster-drift-banner"/;

describe("StagesPanel — roster-drift banner (F3 Task 5)", () => {
  it("shows the banner and the ghost's name when a withdrawn entrant is still on the board", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} rosterDrift={GHOST_DRIFT} />);
    expect(html).toMatch(banner);
    expect(html).toContain("Withdrawn Wendy");
    expect(html).toMatch(/data-roster-drift-state="ghosts"/);
  });

  it("shows the banner and the entrant's name for the unplaced-only direction", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} rosterDrift={UNPLACED_DRIFT} />);
    expect(html).toMatch(banner);
    expect(html).toContain("New Nadia");
    expect(html).toMatch(/data-roster-drift-state="unplaced"/);
  });

  it("hides the banner once both arrays are empty (board matches the roster)", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} rosterDrift={NO_DRIFT} />);
    expect(html).not.toMatch(banner);
  });

  it("hides the banner when rosterDrift is omitted entirely (optional prop, default {})", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} />);
    expect(html).not.toMatch(banner);
  });

  it("hides the banner from viewers (canEdit=false), even with real drift", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} canEdit={false} rosterDrift={GHOST_DRIFT} />,
    );
    expect(html).not.toMatch(banner);
  });

  it("hides the banner once the stage is complete — a rebuild there would always refuse", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} stages={[{ ...STAGE, status: "complete" }]} rosterDrift={GHOST_DRIFT} />,
    );
    expect(html).not.toMatch(banner);
  });
});

describe("rebuildBlockedMessage — StagesPanel rebuild-click classifier", () => {
  it("returns the translated blocked notice for 409 STAGE_HAS_RESULTS", () => {
    const err = new ApiV1Error("this stage has fixtures with a recorded result", 409, "STAGE_HAS_RESULTS", {});
    expect(rebuildBlockedMessage(err, msg)).toBe(msg("progression.rosterDrift.blockedNotice"));
  });

  it("returns null for an unrelated ApiV1Error (falls through to the generic error banner)", () => {
    const err = new ApiV1Error("boom", 500, "INTERNAL", {});
    expect(rebuildBlockedMessage(err, msg)).toBeNull();
  });

  it("returns null for the defence-in-depth 422 STAGE_NOT_ROOT — this panel never offers the button there, so it's the generic banner if it's ever reached directly", () => {
    const err = new ApiV1Error("not eligible", 422, "STAGE_NOT_ROOT", {});
    expect(rebuildBlockedMessage(err, msg)).toBeNull();
  });

  it("returns null for a plain Error (not an ApiV1Error)", () => {
    expect(rebuildBlockedMessage(new Error("network down"), msg)).toBeNull();
  });

  it("returns null for PAYMENT_REQUIRED so the paywall gate still wins", () => {
    const err = new ApiV1Error("upgrade", 402, "PAYMENT_REQUIRED", { feature_key: "formats.advanced" });
    expect(rebuildBlockedMessage(err, msg)).toBeNull();
  });
});
