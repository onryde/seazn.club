// Match Day PB1 x W3 (the merge of #1105 into the Swiss branch): a COMPLETED stage's card is one line until someone opens it
// (stages-panel-collapse.test.tsx owns that rule for every kind). W3 put three things of its own in the Swiss card's HEADER - the
// shape legend (PB1 already folds it), the pending-latecomer lines (T10) and the chess colours switch (T12) - and a header row
// that stays drawn on a folded card makes it two or three lines, not one. The merge gates the last two on `!folded`; this pins
// that, with the open card's positive pair beside every absence.
//
// Node env, no DOM (AGENTS.md class 2): the fold's DEFAULT is read off the real StagesPanel in static markup. The attention seam
// (a Swiss with a cut-drift warning starts open) is in swiss-cut-drift-warning.test.tsx, next to the warning it opens for.
//
// Another sport: the chess switch is a boardgame control (`isChessSport`), so the card is a chess one; the legend and the
// latecomer lines are sport-blind, which the fold gate does not look at.
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { SwissRoundControl } from "@/lib/swiss-rounds-edit";
import { CHESS_SPORT_KEY } from "@/lib/chess-individual-only-rule";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const S = "s1";
const ENTRANTS = ["e1", "e2", "e3", "e4"];
const swissStage = (status: string) => ({ id: S, seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null, status });
/** Two rounds of two boards, all decided: a Swiss that can be (and, with status "complete", is) finished. */
const playedRounds = () =>
  [1, 2].flatMap((round) =>
    [1, 2].map((board) => ({
      id: `f-${round}-${board}`,
      stage_id: S,
      pool_id: null,
      round_no: round,
      seq_in_round: board,
      fixture_no: (round - 1) * 2 + board,
      home_entrant_id: board === 1 ? "e1" : "e3",
      away_entrant_id: board === 1 ? "e2" : "e4",
      scheduled_at: null,
      venue: null,
      court_label: null,
      court_id: null,
      court_name: null,
      status: "decided",
      outcome: { kind: "win", winner: board === 1 ? "e1" : "e3" },
    })),
  );
const control = (): SwissRoundControl => ({
  started: true,
  rounds: 2,
  chess: true,
  field: 4,
  addRound: { canAddRound: false, refusal: "over", field: 4, hardMax: 5 },
  finish: { canFinish: false, refusal: "over", finishedAfter: 2, inProgress: false, completeInstead: false },
});

type PanelProps = ComponentProps<typeof StagesPanel>;
const panelProps = (over: Record<string, unknown> = {}) => ({
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "o",
  compSlug: "c",
  divSlug: "d",
  stages: [swissStage("complete")],
  fixtures: playedRounds(),
  entrantNames: { e1: "Alpha", e2: "Bravo", e3: "Charlie", e4: "Delta", e9: "Late" },
  // A player who arrived after round 2, the last, had started: the "joined after the last round" latecomer line.
  activeEntrantIds: [...ENTRANTS, "e9"],
  entrantSwissFirstRounds: { e9: { swiss_first_round: 3, swiss_first_round_stage_id: S } },
  swissRoundControls: { [S]: control() },
  canEdit: true,
  sportKey: CHESS_SPORT_KEY,
  divisionConfig: {},
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: { plan: "pro", isStaff: false } as never,
  ...over,
});
const panel = (over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <StagesPanel {...(panelProps(over) as unknown as PanelProps)} />
    </DictProvider>,
  );
const count = (html: string, testId: string): number => html.split(`data-testid="${testId}"`).length - 1;
const expandedOf = (html: string): string | null => /data-testid="stage-collapse-toggle"[^>]*aria-expanded="(true|false)"|aria-expanded="(true|false)"[^>]*data-testid="stage-collapse-toggle"/.exec(html)?.slice(1).find((g) => g !== undefined) ?? null;

/** The header rows W3 owns on a Swiss card, by the testid each carries. */
const W3_HEADER_ROWS = ["stage-swiss-legend", "stage-swiss-latecomer", "stage-chess"] as const;

describe("PB1 x W3: a completed Swiss card folds to one line - W3's header rows fold with it", () => {
  it("folded: none of the legend, the latecomer line and the chess switch is drawn; the open card (attention) draws every one", () => {
    const open = panel({ attentionStageIds: [S] });
    expect(expandedOf(open), "premise: the attention card is open").toBe("true");
    for (const row of W3_HEADER_ROWS) expect(count(open, row), `open: ${row} is drawn`).toBeGreaterThan(0);

    const folded = panel();
    expect(expandedOf(folded), "premise: the card is folded").toBe("false");
    expect(count(folded, "stage-collapsed-summary"), "premise: its one line is there").toBe(1);
    let checked = 0;
    for (const row of W3_HEADER_ROWS) {
      expect(count(folded, row), `folded: ${row} is gone with the header's other rows`).toBe(0);
      checked++;
    }
    expect(checked, "anti-vacuity: every W3 header row checked").toBe(W3_HEADER_ROWS.length);
  });

  it("a stage still running is never folded: its chess switch and latecomer line are drawn (the gate asks `folded`, not the stage's kind)", () => {
    const running = panel({
      stages: [swissStage("active")],
      fixtures: playedRounds().map((f, i) => (i === 3 ? { ...f, status: "in_play", outcome: null } : f)),
    });
    expect(count(running, "stage-collapse-toggle"), "premise: a running stage has no toggle").toBe(0);
    expect(count(running, "stage-chess"), "chess switch").toBe(1);
    expect(count(running, "stage-swiss-latecomer"), "latecomer line").toBe(1);
  });

  it("a viewer's folded Swiss card is the same one line (the legend and the rows W3 gates on canEdit were never there)", () => {
    const viewer = panel({ canEdit: false });
    expect(count(viewer, "stage-collapse-toggle"), "premise: a viewer can open the card").toBe(1);
    expect(count(viewer, "stage-collapsed-summary")).toBe(1);
    for (const row of W3_HEADER_ROWS) expect(count(viewer, row), row).toBe(0);
  });
});
