import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// The Swiss shape legend (owner-approved 2026-09-22, option B) — one line
// under the stage title:
//
//   3 rounds · 5 matches + 1 bye per round · 11 fixtures
//
// It exists because a Swiss stage's later rounds kept shells minted for an OLD
// field size after the roster moved, so those rounds offered 4 matches when the
// field needed 5 — invisible until someone opened the fixture list and found a
// `TBD vs <name>` row. The middle figure is therefore derived from the CURRENT
// ACTIVE FIELD, never from the fixture rows; the fixture total is the third
// figure and may legitimately disagree. That disagreement is the signal.
//
// `apps/web` vitest is `environment: "node"` — these assertions see MARKUP, not
// layout. Wrapping, gutters and the 320/768/1280 bar are settled in a browser.

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

const swissStage = (config: Record<string, unknown> = { rounds: 3 }) => ({
  id: "s1",
  seq: 1,
  kind: "swiss",
  name: "Swiss",
  config,
  progression: null,
  status: "active",
});

/** N unseated swiss shells on stage s1, the shape a freshly-generated stage
 *  holds. Round/seq are only ever read for ordering here. */
const shells = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i + 1}`,
    stage_id: "s1",
    pool_id: null,
    round_no: Math.floor(i / 4) + 1,
    seq_in_round: (i % 4) + 1,
    fixture_no: i + 1,
    home_entrant_id: null,
    away_entrant_id: null,
    scheduled_at: null,
    venue: null,
    court_label: null,
    court_id: null,
    court_name: null,
    status: "scheduled",
    outcome: null,
    ext_key: `sw-r${Math.floor(i / 4) + 1}-b${(i % 4) + 1}`,
  }));

const baseProps = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
  entrantNames: {},
};

const LEGEND = /data-testid="stage-swiss-legend"[^>]*>([^<]*)</;

function legendOf(html: string): string | null {
  const m = LEGEND.exec(html);
  return m ? m[1] : null;
}

describe("StagesPanel — Swiss shape legend", () => {
  it("prints rounds, field-derived matches + bye, and the fixture total for an ODD field", () => {
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage()]}
        fixtures={shells(11)}
        activeEntrantIds={ids(11)}
      />,
    );
    expect(legendOf(html)).toBe("3 rounds · 5 matches + 1 bye per round · 11 fixtures");
  });

  it("DROPS the bye clause on an even field", () => {
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage()]}
        fixtures={shells(15)}
        activeEntrantIds={ids(10)}
      />,
    );
    const text = legendOf(html);
    expect(text).toBe("3 rounds · 5 matches per round · 15 fixtures");
    expect(text).not.toContain("bye");
  });

  it("the STALE case: match count comes from the field, not from the rows that exist", () => {
    // 12 rows were minted for a field of 8 (4 a round). The field is now 11.
    // A "count the rows" implementation would print 4 matches and hide the
    // very defect this legend exists to expose.
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage()]}
        fixtures={shells(12)}
        activeEntrantIds={ids(11)}
      />,
    );
    expect(legendOf(html)).toBe("3 rounds · 5 matches + 1 bye per round · 12 fixtures");
  });

  it("a NON-editing viewer sees it too — it is information, not an action", () => {
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit={false}
        stages={[swissStage()]}
        fixtures={shells(11)}
        activeEntrantIds={ids(11)}
      />,
    );
    expect(legendOf(html)).toBe("3 rounds · 5 matches + 1 bye per round · 11 fixtures");
  });

  it("renders NOTHING for a non-swiss stage — other kinds are exactly as they were", () => {
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[{ ...swissStage(), kind: "league" }]}
        fixtures={shells(11)}
        activeEntrantIds={ids(11)}
      />,
    );
    expect(html).not.toContain('data-testid="stage-swiss-legend"');
  });

  it("renders NOTHING when the roster was not supplied — no number it cannot stand behind", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} canEdit stages={[swissStage()]} fixtures={shells(11)} />,
    );
    expect(html).not.toContain('data-testid="stage-swiss-legend"');
  });

  it("renders NOTHING when the stage declares no round count", () => {
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage({})]}
        fixtures={shells(11)}
        activeEntrantIds={ids(11)}
      />,
    );
    expect(html).not.toContain('data-testid="stage-swiss-legend"');
  });

  it("counts only the qualifiers still in the field when the stage carries config.qualified", () => {
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage({ rounds: 2, qualified: ["e1", "e2", "e3", "gone", "alsoGone"] })]}
        fixtures={shells(4)}
        activeEntrantIds={ids(9)}
      />,
    );
    // 3 qualifiers survive → 1 match + 1 bye per round.
    expect(legendOf(html)).toBe("2 rounds · 1 match + 1 bye per round · 4 fixtures");
  });

  it("never says 'board' on screen — chess heritage stays in the code", () => {
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage()]}
        fixtures={shells(11)}
        activeEntrantIds={ids(11)}
      />,
    );
    expect(legendOf(html)!.toLowerCase()).not.toContain("board");
  });

  it("the legend wraps rather than forcing a fixed row (phone bar) and keeps min-w-0", () => {
    // `environment: "node"` cannot measure. What it CAN pin is that the
    // element carries no width-conditional hiding and does not opt out of
    // wrapping — the browser pass at 320/768/1280 settles the rest.
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage()]}
        fixtures={shells(11)}
        activeEntrantIds={ids(11)}
      />,
    );
    const tag = /<[^>]*data-testid="stage-swiss-legend"[^>]*>/.exec(html)![0];
    // Anchored on `\s...hidden"` — `/\bmd:hidden\b/` also matches inside
    // `max-md:hidden`, so a bare probe would pass on its own inversion.
    expect(tag).not.toMatch(/\s(?:max-)?md:hidden["\s]/);
    expect(tag).not.toContain("whitespace-nowrap");
    expect(tag).toContain("min-w-0");
  });
});
