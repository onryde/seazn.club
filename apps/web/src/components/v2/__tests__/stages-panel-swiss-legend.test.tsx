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

/** `status` is the STAGE's own vocabulary — `pending | active | complete`
 *  (V210__stages.sql), NOT the division's `active | completed`. It is a
 *  parameter here because the legend's SHAPE depends on it: a complete stage
 *  withholds the per-round match clause, whose number tracks the live field
 *  and therefore decays after the stage has stopped caring about it. */
const swissStage = (
  config: Record<string, unknown> = { rounds: 3 },
  status: string = "active",
) => ({
  id: "s1",
  seq: 1,
  kind: "swiss",
  name: "Swiss",
  config,
  progression: null,
  status,
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

  it("stages-panel-swiss-legend-complete-wiring: a COMPLETE stage prints rounds and fixtures, no per-round clause", () => {
    // The PANEL is what proves this, not the builder: the builder cannot tell
    // whether anyone ever hands it `stage.status`. Delete `status: stage.status`
    // from the `swissStageLegend({...})` call in stages-panel.tsx and this is
    // the test that reds — the builder suite stays entirely green, because a
    // missing status simply is not in the completed set.
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage({ rounds: 3 }, "complete")]}
        fixtures={shells(18)}
        activeEntrantIds={ids(9)}
      />,
    );
    const text = legendOf(html);
    // The live field of 9 would say "4 matches + 1 bye per round" — a number
    // that accuses a stage which played 11 entrants entirely correctly. The
    // finished stage says only what is still true.
    expect(text).toBe("3 rounds · 18 fixtures");
    expect(text).not.toContain("match");
    expect(text).not.toContain("per round");
    expect(text).not.toContain("bye");
  });

  it("the SAME stage on 'pending' and on 'active' still carries the match clause", () => {
    // The positive pair for the negative above — the clause is dropped by the
    // completed status, not by something incidental to this fixture.
    for (const status of ["pending", "active"]) {
      const html = renderToStaticMarkup(
        <StagesPanel
          {...baseProps}
          canEdit
          stages={[swissStage({ rounds: 3 }, status)]}
          fixtures={shells(18)}
          activeEntrantIds={ids(9)}
        />,
      );
      expect(legendOf(html), status).toBe("3 rounds · 4 matches + 1 bye per round · 18 fixtures");
    }
  });

  it("stages-panel-swiss-legend-empty-field: a stage created before any entrant exists renders NOTHING", () => {
    // A stage is created BEFORE entrants, so "0 matches per round" was the
    // first thing an organiser saw on a new stage.
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} canEdit stages={[swissStage()]} fixtures={[]} activeEntrantIds={[]} />,
    );
    expect(html).not.toContain('data-testid="stage-swiss-legend"');
  });

  it("stages-panel-swiss-legend-single-entrant: one entrant renders NOTHING either", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} canEdit stages={[swissStage()]} fixtures={[]} activeEntrantIds={ids(1)} />,
    );
    expect(html).not.toContain('data-testid="stage-swiss-legend"');
  });

  it("TWO entrants — the smallest field swiss can pair — DOES render", () => {
    // The positive pair: the suppression is the threshold, not "this panel
    // never renders a legend on a small stage".
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        canEdit
        stages={[swissStage({ rounds: 1 })]}
        fixtures={shells(1)}
        activeEntrantIds={ids(2)}
      />,
    );
    expect(legendOf(html)).toBe("1 round · 1 match per round · 1 fixture");
  });

  it("an EMPTY roster and an ABSENT roster render the same nothing, at every status", () => {
    for (const status of ["pending", "active", "complete"]) {
      const empty = renderToStaticMarkup(
        <StagesPanel
          {...baseProps}
          canEdit
          stages={[swissStage({ rounds: 3 }, status)]}
          fixtures={shells(18)}
          activeEntrantIds={[]}
        />,
      );
      const absent = renderToStaticMarkup(
        <StagesPanel
          {...baseProps}
          canEdit
          stages={[swissStage({ rounds: 3 }, status)]}
          fixtures={shells(18)}
        />,
      );
      expect(empty, `${status} / empty`).not.toContain('data-testid="stage-swiss-legend"');
      expect(absent, `${status} / absent`).not.toContain('data-testid="stage-swiss-legend"');
    }
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
