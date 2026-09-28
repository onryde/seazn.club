// LIFECYCLE: set up, play every round, probe the config lock, complete, read
// the public table. No canary — its assertions are the shared ones.
import type { StageKind } from "@seazn/engine/core";
import { drawsAllowed } from "../sport-cfg.ts";
import { builtAsPosted, drawPathExercised, entrantsEditAccepted, foldParity, formatEditRefusedNamed, loopBounded, publicStandingsMatch, resultsAsPosted, stageCompleted } from "./assertions.ts";
import { Recorder, configProbe, finishStage, playStage, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

const ENTRANTS = 8;

export const lifecycle: Scenario = {
  key: "LIFECYCLE",
  entrantCount: ENTRANTS,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, ENTRANTS);
    await playStage(ctx, rec, setup);
    const configEdit = await configProbe(ctx, rec, setup);
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit, withdrawal: null });
    const pub = await ctx.driver.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
    const drawOk = drawsAllowed(ctx.spec.sport, ctx.cfg, setup.stage.kind as StageKind);
    return {
      observed,
      events: rec.events,
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
      ],
    };
  },
};
