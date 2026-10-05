// LIFECYCLE: set up, play every round, probe the config lock, complete, read
// the public table. No canary — its assertions are the shared ones.
import { fieldSizeFor } from "../field-size.ts";
import type { ConfigEditObs } from "../observed.ts";
import { advanceSeededAsDeclared } from "./advance.ts";
import { builtAsPosted, drawPathExercised, entrantsEditAccepted, foldParity, formatEditRefusedNamed, lineupsPut, loopBounded, publicStandingsMatch, resultsAsPosted, stageCompleted } from "./assertions.ts";
import { Recorder, configProbe, dateFirstRound, drawsDeclaredOnReached, playDivision, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

/** The scenario's default field. The call site asks fieldSizeFor, which
 *  answers the FORMAT's field (a page playoff seeds 4; W1-driving Task 2). */
const ENTRANTS = 8;

export const lifecycle: Scenario = {
  key: "LIFECYCLE",
  entrantCount: ENTRANTS,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, "LIFECYCLE", ctx.spec.template));
    // W1d Task 14 (item 15c, D17): a match-day case is dated today before anything is played, so the division is
    // on its match day when the browser's first rail visit loads the run sheet.
    if (ctx.spec.matchDay === true) await dateFirstRound(ctx, rec, setup);
    // W1-driving T6: the lock probe keeps its place — after stage 1's play,
    // before its /complete (playDivision asks every reached stage to complete,
    // so the hook always runs; a missing probe is a harness bug, named).
    let probed: ConfigEditObs | null = null;
    const plays = await playDivision(ctx, rec, setup, { beforeComplete: async () => { probed = await configProbe(ctx, rec, setup); } });
    const configEdit = probed as ConfigEditObs | null;
    if (configEdit === null) throw new Error("scenario: LIFECYCLE's config probe never ran — playDivision skipped stage 1's beforeComplete");
    const observed = await snapshot(ctx, rec, setup, plays, { configEdit, withdrawal: null });
    const pub = await ctx.driver.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
    // T6-R3 (m-12): draws were posted on every reached stage that declares them, not the root's alone.
    const drawOk = drawsDeclaredOnReached(ctx, plays);
    return {
      observed,
      events: rec.events,
      notes: rec.notes,
      assertions: [
        builtAsPosted(setup.built, observed),
        foldParity(rec),
        resultsAsPosted(rec, observed),
        publicStandingsMatch(observed, pub),
        drawPathExercised(rec, observed, drawOk),
        formatEditRefusedNamed(configEdit),
        entrantsEditAccepted(configEdit),
        stageCompleted(observed),
        loopBounded(rec, observed),
        advanceSeededAsDeclared(plays, observed, rec.withdrawn),
        lineupsPut(rec, setup),
      ],
    };
  },
};
