// W3 app-B Task 5 (X-SW-19): the model's Swiss twin (`ModelFakeDriver.#swissGenerate`) pays the pairing score the way the
// product's table would - the sport's DECLARED Swiss rule (`tablePointsRule(cfg, "swiss")`), not 1 and a half. A win is the
// rule's win (a set sport's clean sweep), a draw is `swissDrawPoints`, a bye is a win. The twin has no table, so this is the
// whole of its scoring; the product's side is apps/web's swiss-score-groups.test.ts.
//
// Expected values come from the engine's own declarations (`tablePointsRule`, `swissDrawFactsOf`, `swissDrawPoints`), applied
// to the results the test posts; never from the twin. What the twin hands the engine is read through a spy on `pairRound`.
import { swissDrawFactsOf, swissDrawPoints } from "@seazn/engine/competition";
import { playRecorded } from "@seazn/engine/core";
import { pairKey, type SwissHistory, type SwissStanding } from "@seazn/engine/scheduling";
import { describe, expect, it, vi } from "vitest";
import { envelopes } from "../lib/fold.ts";
import { newModelState } from "../lib/model/commands.ts";
import { resolveSportCfg, sportModule, stageCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import type { RequestedOutcome } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

// The root vitest config leaves the engine external, whose module namespace `vi.spyOn` cannot patch (apps/web's inlines it),
// so the engine's `pairRound` is wrapped at the module boundary instead: the real one runs, and what it was handed is kept.
const handed = vi.hoisted(() => ({
  calls: [] as (readonly SwissStanding[])[],
  /** The pairing history each call was handed (T6 review m4): which pairs have met, and who may no longer take the bye. */
  histories: [] as SwissHistory[],
}));
vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const real = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...real,
    pairRound: (...a: Parameters<typeof real.pairRound>) => {
      handed.calls.push(a[0]);
      handed.histories.push(a[1]);
      return real.pairRound(...a);
    },
  };
});

// Sports: badminton (a set sport: the points are a `bySetScore` map, so the win is its clean sweep) and boardgame (chess:
// half-points, a draw the rule declares). A third, football, would add a plain 3/1/0 and nothing the first two do not show.
const SPORTS = ["badminton", "boardgame"] as const;

/** A started 5-player Swiss (an odd field: round 1 holds two boards and a bye), round 1 paired. */
async function paired(sport: string, variantKey?: string) {
  const d = new ModelFakeDriver({});
  const variant = variantKey ?? offlineBuilderDefault(sport);
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

// W3 app-B T5 review m2: the twin paid every played loser 0. The product's table pays a PLAYED loser what the sport's rule says
// (`loss.regulation`, `loss.ot`, a set score's second number), so the twin's Swiss pairing score diverged from the product's
// wherever a sport pays a loser. Each case is a sport whose rule pays a loser something, driven by the result shape that earns it;
// the expected pair is read from the engine's declared rule, applied to the case's shape - never from the twin. The premise of
// each case is that the declared loser value is NOT 0, the value the old twin paid.
describe("T5 review m2 - the twin pays a played loser what the declared Swiss rule pays", () => {
  type Pair = readonly [number, number];
  interface Shape {
    readonly label: string;
    readonly sport: string;
    readonly variant: string;
    readonly outcome: RequestedOutcome;
    /** The declared [winner, loser] points of this result shape: read from the sport's rule, the cell the rulebook names. */
    readonly declared: (rule: ReturnType<ReturnType<typeof sportModule>["tablePointsRule"]>, setsToWin: number | undefined) => Pair;
  }
  const SHAPES: readonly Shape[] = [
    // A played loss is worth 1 in table tennis, in every variant (the D6 pair: an UNPLAYED loss is 0).
    { label: "a played loss in table tennis", sport: "tabletennis", variant: "bo5", outcome: { kind: "win", winner: "home" }, declared: (r) => [r.win.regulation, r.loss.regulation] },
    // An overtime result is its own cell of the rule (IIHF: win 2 / loss 1 against regulation 3 / 0).
    { label: "an overtime loss in ice hockey", sport: "icehockey", variant: "iihf", outcome: { kind: "win", winner: "home", path: "overtime" }, declared: (r) => [r.win.ot!, r.loss.ot!] },
    // A set sport pays by the set score: indoor volleyball's 3-2 is [2, 1], not the clean sweep's [3, 0].
    { label: "a 3-2 loss in indoor volleyball", sport: "volleyball", variant: "indoor", outcome: { kind: "win", winner: "home", path: "decidingSet" }, declared: (r, n) => { if (n === undefined) throw new Error("premise: indoor volleyball declares sets to win"); return r.bySetScore![`${n}-${n - 1}`]!; } },
    // The sequence's other half: a forfeit before play is an UNPLAYED result, which table tennis pays 0 - against the played loss's 1.
    { label: "a walkover loss in table tennis (never played)", sport: "tabletennis", variant: "bo5", outcome: { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" }, declared: (r) => [r.win.regulation, r.loss.unplayed!] },
  ];
  let checked = 0;
  for (const shape of SHAPES) {
    it(`m2: ${shape.label} pays the loser the declared value`, async () => {
      const { d, boards, bye, cfg, post } = await paired(shape.sport, shape.variant);
      const module = sportModule(shape.sport);
      const rule = module.tablePointsRule(cfg as never, "swiss");
      const facts = swissDrawFactsOf(module, cfg);
      const [won, lost] = shape.declared(rule, facts.setsToWin);
      const plainWin = rule.bySetScore === undefined ? rule.win.regulation : (rule.bySetScore[`${facts.setsToWin}-0`] ?? rule.bySetScore["*"])![0];
      // differential: the case's declared loser is not 0 where it is a played loss (the old twin's constant), and the unplayed one is
      // the case where the right answer IS 0 - so the played and unplayed losses of one sport must differ.
      if (shape.outcome.kind !== "forfeit") expect(lost, `premise: ${shape.label}'s declared loser is not the old twin's 0`).not.toBe(0);
      else {
        expect(rule.loss.regulation, "premise: a played loss in this sport pays more than the unplayed one").toBeGreaterThan(lost);
        // The expected pair restates `payout`'s award branch (win.regulation / loss.unplayed); a declared `forfeit` row would outrank it.
        expect(rule.forfeit, "premise: no forfeit row outranks the award cell this case reads").toBeUndefined();
      }

      await post(boards[0]!.id, shape.outcome);
      await post(boards[1]!.id, { kind: "win", winner: "home" });
      handed.calls.length = 0;
      await d.generate(); // Pair round 2
      expect(handed.calls.length, "anti-vacuity: the Pair called the engine once").toBe(1);
      const scores = new Map(handed.calls[0]!.map((x) => [x.entrantId, x.score]));
      expect(scores.size, "anti-vacuity: the whole field was handed over").toBe(5);
      const home = boards[0]!.home_entrant_id!;
      const away = boards[0]!.away_entrant_id!;
      expect([scores.get(home), scores.get(away)], `${shape.label}: [winner, loser] points`).toEqual([won, lost]);
      // the other board is a plain home win (the clean sweep where the sport pays by set score), and the bye is a win: both are
      // the rule's plain win, which is what the twin has always paid them
      expect(scores.get(boards[1]!.home_entrant_id!), "a plain win").toBe(plainWin);
      expect(scores.get(bye.home_entrant_id!), "a bye is a win").toBe(plainWin);
      checked++;
    });
  }
  it("anti-vacuity: every shape ran", () => {
    expect(checked).toBe(SHAPES.length);
  });
  // The guard the twin carries instead of paying such a board nothing: a decided two-sided board whose ledger folds to no outcome.
  it("m2 guard: a two-sided board holding an outcome its ledger does not fold to is refused by name, not paid 0", async () => {
    const { d, boards, post } = await paired("badminton");
    await post(boards[1]!.id, { kind: "win", winner: "home" });
    Object.assign(boards[0]!, { status: "decided", outcome: { kind: "win", winner: boards[0]!.home_entrant_id! } }); // an outcome with NO ledger behind it
    await expect(d.generate()).rejects.toThrow(/holds an outcome \(win\) its ledger does not fold to/);
  });
});

// W3 app-B T6 review m4: the twin's pairing HISTORY is the product's (usecases/stages/swiss-gen.ts buildSwissHistory), for the two things it
// rewrote. A two-seated board that was NOT PLAYED is not a meeting (rulebook P-A2, FIDE C.04.2 3.5): the pair may meet again. Its
// WINNER, though, has scored "a win due to an opponent not appearing", and may not take the pairing-allocated bye (P-A4, FIDE
// C.04.1(d)) - while a win by retirement AFTER play is a played game and bars nothing. Only a one-seat award is a bye. The twin read
// every award as a bye and every seated board as a meeting. Each case is one result shape, round 1 of an odd field of 5 (two boards
// and the bye), read through the history the twin hands the engine for round 2; the rulebook's answer is the case's, and the engine
// only supplies whether the posted stream held any play.
describe("T6 review m4 - the twin's pairing history: an unplayed board is no meeting, and its winner is barred from the bye", () => {
  interface Case {
    readonly label: string;
    readonly outcome: RequestedOutcome;
    /** P-A2: this board's pair has NOT met. */
    readonly unplayed: boolean;
    /** P-A4: the board's winner (the home side, here) may no longer take the bye. */
    readonly winnerBarred: boolean;
    /** Whether the posted stream holds any play, by the engine (`playRecorded`) - the premise that makes the case what it says. */
    readonly holdsPlay: boolean;
  }
  const CASES: readonly Case[] = [
    { label: "a walkover (nobody played)", outcome: { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" }, unplayed: true, winnerBarred: true, holdsPlay: false },
    // The differential: the same award shape and the same winner, but after play - so the right answer is the OPPOSITE of the walkover's.
    { label: "a retirement after play", outcome: { kind: "forfeit", by: "away", reason: "retired", at: "after_start" }, unplayed: false, winnerBarred: false, holdsPlay: true },
    { label: "a double walkover", outcome: { kind: "double_walkover" }, unplayed: true, winnerBarred: false, holdsPlay: false },
    { label: "an ordinary win", outcome: { kind: "win", winner: "home" }, unplayed: false, winnerBarred: false, holdsPlay: true },
  ];
  let checked = 0;
  for (const c of CASES) {
    it(`m4: ${c.label} - the pair ${c.unplayed ? "has NOT met" : "has met"}, and the winner is ${c.winnerBarred ? "barred from" : "still eligible for"} the bye`, async () => {
      const sport = "tabletennis";
      const { d, boards, bye, cfg, post } = await paired(sport, "bo5");
      const stream = (f: (typeof boards)[number]) => generateStream({ sportKey: sport, cfg, stageKind: "swiss", home: f.home_entrant_id!, away: f.away_entrant_id!, outcome: c.outcome });
      const module = sportModule(sport);
      expect(playRecorded(envelopes("matrix", stream(boards[0]!)), module), `premise: ${c.label}'s stream ${c.holdsPlay ? "holds play" : "holds none"}`).toBe(c.holdsPlay);
      await post(boards[0]!.id, c.outcome);
      await post(boards[1]!.id, { kind: "win", winner: "home" });
      handed.histories.length = 0;
      await d.generate(); // Pair round 2
      expect(handed.histories.length, "anti-vacuity: the Pair called the engine once").toBe(1);
      const { played, byes } = handed.histories[0]!;
      if (byes === undefined) throw new Error("premise: the twin hands the engine a bye history");
      const [home, away] = [boards[0]!.home_entrant_id!, boards[0]!.away_entrant_id!];
      expect(played.has(pairKey(home, away)), `${c.label}: the pair ${c.unplayed ? "has not" : "has"} met`).toBe(!c.unplayed);
      expect(byes.has(home), `${c.label}: the winner ${c.winnerBarred ? "is" : "is not"} barred from the bye`).toBe(c.winnerBarred);
      expect(byes.has(away), `${c.label}: the loser is never barred`).toBe(false);
      // The positive pair of every negative above: the round-1 bye IS recorded (only a one-seat award is a bye), and the other board,
      // an ordinary win, is a meeting that bars nobody.
      expect(byes.has(bye.home_entrant_id!), "the round-1 bye is in the history").toBe(true);
      expect(played.has(pairKey(boards[1]!.home_entrant_id!, boards[1]!.away_entrant_id!)), "an ordinary win is a meeting").toBe(true);
      expect(byes.has(boards[1]!.home_entrant_id!), "an ordinary win bars nobody from the bye").toBe(false);
      checked++;
    });
  }
  it("anti-vacuity: every case ran, and the cases differ on both facts", () => {
    expect(checked).toBe(CASES.length);
    expect(new Set(CASES.map((c) => c.unplayed)).size, "cases of both unplayed answers").toBe(2);
    expect(new Set(CASES.map((c) => c.winnerBarred)).size, "cases of both barred answers").toBe(2);
  });
});
