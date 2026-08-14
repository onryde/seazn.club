// Task A2 (P6/D4b) -> P7/F1: the intra-bracket FORMAT PREVIEW
// (previewDivisionFixtures, used by the marketing gallery + /help/formats —
// no real DB fixtures, no locale in scope; always English) used to hand-build
// its "Winner of R2 #1" / "Loser of R2 #1" text with a template literal (A2
// baseline). A2 then converted the internal `slot()` helper to build a
// { key: "slot.winner_match", params: { ext } } pair — but `ext` was STILL a
// pre-rendered "R2 #1" fragment built by hand, a gap closed in P7/F1: `slot()`
// now passes the numeric { round, seq } straight through, and
// resolveSlotLabel() composes the ref text itself via the slot.match_ref
// dictionary key — the SAME composition generateStageFixtures's live path
// uses (see stage-match-slot-labels.test.ts). That key's English value is
// "R{round}·{seq}" (middle dot, no space — matching the board card's own
// short-code chip, schedule-board.tsx:271), so the preview's rendered text
// changes from the old "#" form to "·" here. This test pins the NEW exact
// output text as a fresh characterization baseline; the two describe blocks'
// actual PURPOSE — keys resolve to real text before render, never a raw key
// or an unfilled {placeholder} — is unchanged by that format move.
import { describe, expect, it } from "vitest";
import { previewDivisionFixtures } from "../stages";

describe("previewDivisionFixtures — intra-bracket TBD labels (P7/F1 slot.match_ref conversion)", () => {
  it("a knockout's later round reads 'Winner of R<round>·<seq>' for an unresolved feed", () => {
    const phases = previewDivisionFixtures(
      [{ kind: "knockout", name: "Knockout", config: {}, qualification: null }],
      8,
    );
    const phase = phases[0]!;
    const allMatches = phase.sections.flatMap((s) => s.matches);
    const winnerFeeds = allMatches.flatMap((m) => [m.home, m.away]).filter((s) => s.startsWith("Winner of R"));
    // 8 entrants: quarter-finals (R1) decided by seed, semis (R2) both sides
    // are "Winner of R1·n", final both sides are "Winner of R2·n".
    expect(winnerFeeds.length).toBeGreaterThan(0);
    expect(winnerFeeds).toContain("Winner of R1·1");
    for (const feed of winnerFeeds) {
      expect(feed).toMatch(/^Winner of R\d+·\d+$/);
    }
  });

  it("never leaves the raw pattern key or an unfilled {placeholder} in the rendered text", () => {
    const phases = previewDivisionFixtures(
      [{ kind: "knockout", name: "Knockout", config: {}, qualification: null }],
      8,
    );
    const allText = phases[0]!.sections.flatMap((s) => s.matches.flatMap((m) => [m.home, m.away])).join(" | ");
    expect(allText).not.toContain("slot.winner_match");
    expect(allText).not.toContain("slot.loser_match");
    expect(allText).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
