// W3 app-B Task 5 (X-SW-19): the model's Swiss twin (`ModelFakeDriver.#swissGenerate`) pays the pairing score the way the
// product's table would - the sport's DECLARED Swiss rule (`tablePointsRule(cfg, "swiss")`), not 1 and a half. A win is the
// rule's win (a set sport's clean sweep), a draw is `swissDrawPoints`, a bye is a win. The twin has no table, so this is the
// whole of its scoring; the product's side is apps/web's swiss-score-groups.test.ts.
//
// Expected values come from the engine's own declarations (`tablePointsRule`, `swissDrawFactsOf`, `swissDrawPoints`), applied
// to the results the test posts; never from the twin. What the twin hands the engine is read through a spy on `pairRound`.
import { swissDrawFactsOf, swissDrawPoints } from "@seazn/engine/competition";
import type { SwissStanding } from "@seazn/engine/scheduling";
import { describe, expect, it, vi } from "vitest";
import { newModelState } from "../lib/model/commands.ts";
import { resolveSportCfg, sportModule, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import type { RequestedOutcome } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

// The root vitest config leaves the engine external, whose module namespace `vi.spyOn` cannot patch (apps/web's inlines it),
// so the engine's `pairRound` is wrapped at the module boundary instead: the real one runs, and what it was handed is kept.
const handed = vi.hoisted(() => ({ calls: [] as (readonly SwissStanding[])[] }));
vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const real = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...real,
    pairRound: (...a: Parameters<typeof real.pairRound>) => {
      handed.calls.push(a[0]);
      return real.pairRound(...a);
    },
  };
});

// Sports: badminton (a set sport: the points are a `bySetScore` map, so the win is its clean sweep) and boardgame (chess:
// half-points, a draw the rule declares). A third, football, would add a plain 3/1/0 and nothing the first two do not show.
const SPORTS = ["badminton", "boardgame"] as const;

/** A started 5-player Swiss (an odd field: round 1 holds two boards and a bye), round 1 paired. */
async function paired(sport: string) {
  const d = new ModelFakeDriver({});
  const variant = offlineBuilderDefault(sport);
  const m = await newModelState({ driver: d, row: "swiss", sport, variant, entrants: 5, tag: `t5-${sport}` });
  await d.start();
  await d.generate(); // Pair round 1
  const boards = d.fixtures.filter((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null);
  const bye = d.fixtures.find((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id === null);
  expect(boards.length, `rig: ${sport} round 1 holds two boards`).toBe(2);
  expect(bye, `rig: ${sport} round 1 holds a bye`).toBeDefined();
  const cfg = stageCfg(sport, resolveSportCfg(sport, variant), "swiss", variant, undefined);
  const post = (id: string, outcome: RequestedOutcome) => {
    const f = d.fixtures.find((x) => x.id === id)!;
    return d.postStream(id, generateStream({ sportKey: sport, cfg, stageKind: "swiss", home: f.home_entrant_id!, away: f.away_entrant_id!, outcome }));
  };
  return { d, m, boards, bye: bye!, cfg, post };
}

describe("X-SW-19 the Swiss twin pays the declared rule: a win, a draw and a bye", () => {
  let checked = 0;
  for (const sport of SPORTS) {
    it(`X-SW-19 the twin's pairing score is the declared Swiss rule's win, draw and bye (${sport})`, async () => {
      const { d, boards, bye, cfg, post } = await paired(sport);
      const module = sportModule(sport);
      const rule = module.tablePointsRule(cfg as never, "swiss");
      const facts = swissDrawFactsOf(module, cfg);
      // Declared, not typed: a set sport's win is its clean sweep ("W-0"), else the rule's win; a draw is the rule's.
      const win = rule.bySetScore === undefined ? rule.win.regulation : (rule.bySetScore[`${facts.setsToWin}-0`] ?? rule.bySetScore["*"])![0];
      const draw = swissDrawPoints(rule, facts);
      // differential: the twin paid 1 per win and 1/2 per draw, which is neither the sport's win nor its draw
      expect(win, `premise: ${sport}'s declared win is not the old +1`).not.toBe(1);
      expect(draw, `premise: ${sport}'s declared draw is not the old +1/2`).not.toBe(0.5);

      // Board 1 a home win; board 2 a draw where the sport draws, else a home win too.
      await post(boards[0]!.id, { kind: "win", winner: "home" });
      const drew = facts.drawReachable;
      await post(boards[1]!.id, drew ? { kind: "draw" } : { kind: "win", winner: "home" });

      handed.calls.length = 0;
      await d.generate(); // Pair round 2
      expect(handed.calls.length, "anti-vacuity: the Pair called the engine once").toBe(1);
      const scores = new Map(handed.calls[0]!.map((s) => [s.entrantId, s.score]));
      expect(scores.size, "anti-vacuity: the whole field was handed over").toBe(5);

      const want = new Map<string, number>([
        [boards[0]!.home_entrant_id!, win],
        [boards[0]!.away_entrant_id!, 0],
        [boards[1]!.home_entrant_id!, drew ? draw : win],
        [boards[1]!.away_entrant_id!, drew ? draw : 0],
        [bye.home_entrant_id!, win],
      ]);
      expect([...scores].sort(), `${sport}: each score is the declared rule's`).toEqual([...want].sort());
      expect(scores.get(bye.home_entrant_id!), `${sport}: a bye is a win`).toBe(win);
      checked++;
    });
  }
  it("anti-vacuity: both sports ran", () => {
    expect(checked).toBe(SPORTS.length);
  });
});
