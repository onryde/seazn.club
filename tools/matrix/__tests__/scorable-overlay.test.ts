// W2a: variants.ts's scorable() judges a bracket row under the cfg the product folds it under - the stage's own overlay
// (boardgame's tie-break, carrom's extra board). Its own file, not variants.test.ts: that file builds every sport's
// variants at import, so a scorable() that forgot the overlay would crash COLLECTION there, and a suite that fails to
// collect proves nothing (the mutation runner counts COLLECT_FAILED as no kill).
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
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

  it("a win in a knockout row folds under the stage overlay and is still a win; every sport the engine says the overlay touches was judged", () => {
    // Whole-branch review M5: the list was typed (["boardgame", "carrom"]) under a title that promised "every sport the
    // overlay touches". It is the modules whose bracketDeciders(cfg) is non-empty under their default cfg - the engine's own
    // declaration - so a sport that gains an overlay joins the sweep, and an empty list is a failure, never a pass.
    const touched = SPORT_KEYS.filter((sport) => Object.keys(sportModule(sport).bracketDeciders(resolveSportCfg(sport, offlineBuilderDefault(sport))) as Record<string, unknown>).length > 0);
    expect(touched.length, "sports whose module declares a bracket overlay").toBeGreaterThan(0);
    expect(touched.length, "an overlay is the exception, not every sport").toBeLessThan(SPORT_KEYS.length);
    let judged = 0;
    for (const sport of touched) {
      expect(scorable(vc(sport, "knockout", {})), sport).toBeNull();
      judged++;
    }
    expect(judged).toBe(touched.length);
  });
});
