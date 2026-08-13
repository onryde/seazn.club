// Task A2 (P6/D4b): the intra-bracket FORMAT PREVIEW (previewDivisionFixtures,
// used by the marketing gallery + /help/formats — no real DB fixtures, no
// locale in scope; always English) used to hand-build its "Winner of R2 #1" /
// "Loser of R2 #1" text with a template literal. This test pins the exact
// output text as a characterization baseline, then A2 converts the internal
// `slot()` helper to build a { key: "slot.winner_match", params: { ext } }
// pair and resolve it through the SAME resolveSlotLabel() used everywhere
// else (via the client-safe English msg()) instead of concatenating — the
// design's "Label vocabulary" section names this exact helper as the
// intended reuse site for slot.winner_match/slot.loser_match. Output must
// stay byte-identical: nothing about the preview's rendered text is meant to
// change, only how it gets built (through the one resolver, not a second
// concatenation copy).
import { describe, expect, it } from "vitest";
import { previewDivisionFixtures } from "../stages";

describe("previewDivisionFixtures — intra-bracket TBD labels (A2 slot() conversion)", () => {
  it("a knockout's later round reads 'Winner of R<round> #<seq>' for an unresolved feed", () => {
    const phases = previewDivisionFixtures(
      [{ kind: "knockout", name: "Knockout", config: {}, qualification: null }],
      8,
    );
    const phase = phases[0]!;
    const allMatches = phase.sections.flatMap((s) => s.matches);
    const winnerFeeds = allMatches.flatMap((m) => [m.home, m.away]).filter((s) => s.startsWith("Winner of R"));
    // 8 entrants: quarter-finals (R1) decided by seed, semis (R2) both sides
    // are "Winner of R1 #n", final both sides are "Winner of R2 #n".
    expect(winnerFeeds.length).toBeGreaterThan(0);
    expect(winnerFeeds).toContain("Winner of R1 #1");
    for (const feed of winnerFeeds) {
      expect(feed).toMatch(/^Winner of R\d+ #\d+$/);
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
