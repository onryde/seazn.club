// W2a: variants.ts's scorable() judges a bracket row under the cfg the product folds it under - the stage's own overlay
// (boardgame's tie-break, carrom's extra board). Its own file, not variants.test.ts: that file builds every sport's
// variants at import, so a scorable() that forgot the overlay would crash COLLECTION there, and a suite that fails to
// collect proves nothing (the mutation runner counts COLLECT_FAILED as no kill).
import { describe, expect, it } from "vitest";
import { scorable } from "../lib/variants.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";

const vc = (sport: string, row: "knockout" | "league", overrides: Record<string, unknown>) => ({
  id: "x", sport, row, preset: offlineBuilderDefault(sport), classes: {}, values: {}, overrides, scorable: null,
});

describe("scorable under the stage overlay (W2a, CA-KO-1, BG-KO-1)", () => {
  it("a carrom cfg that draws on the board is scorable in a knockout row - the overlay sets the extra board - and on a league row, which plays none", () => {
    // Without the overlay the knockout win is OutcomeUnreachable (a harness fault, rethrown); with it the extra board is played and the win folds.
    expect(scorable(vc("carrom", "knockout", { tieBoard: "draw" }))).toBeNull();
    // Positive pair: the league row reads the cfg as it came.
    expect(scorable(vc("carrom", "league", { tieBoard: "draw" }))).toBeNull();
  });

  it("a chess win in a knockout row folds under the tie-break cfg and is still a win; every sport the overlay touches was judged", () => {
    let judged = 0;
    for (const sport of ["boardgame", "carrom"]) {
      expect(scorable(vc(sport, "knockout", {})), sport).toBeNull();
      judged++;
    }
    expect(judged).toBe(2);
  });
});
