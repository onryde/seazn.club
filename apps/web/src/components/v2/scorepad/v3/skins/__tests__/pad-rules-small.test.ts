// P4.1 (pad wave) - the carrom, chess (boardgame) and generic skins' DRIFT GUARD. It drives the skins' BUILDERS (the sheets, the scorebug) in
// REAL folded states and compares what they OFFER with `carromPadRules` / `boardgamePadRules` / `genericPadRules` and with the REAL strict
// fold. It never compares a skin's re-exported constant with the record: after P4.1 these three skins declare none (the literal guard,
// no-rule-literals.test.ts, holds that), and a constant compared with its own source is always green.
//
// Where an expected value could come from the engine's declaration it does; where the declaration is what a mutation would change, the
// value is ALSO typed here from the rule rows (packages/engine/rules/{carrom,boardgame,generic}.md - CA-AD-2, CA-CN-1, CA-FM-1, BG-PA-1,
// BG-KO-2, BG-KO-4, GN-SC-1, GN-SC-2), so that editing the engine's constant reds here even though the record, padSpec and the skin would
// all follow it. Every comparison counts; the last test requires the total.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { boardgamePadRules, carromPadRules, genericPadRules } from "@seazn/engine/pad";
import type { ModuleEvent } from "@seazn/engine/sport";
import { TIEBREAK_RUNGS, boardgame } from "@seazn/engine/sports/boardgame";
import { carrom } from "@seazn/engine/sports/carrom";
import { generic } from "@seazn/engine/sports/generic";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import type { GuidedSheetSpec, GuidedSheetStep, PadHostView } from "../../types";
import { liveView } from "../../__tests__/_views";
import { buildScorebug as carromScorebug, buildSheets as carromSheets, buildTiles as carromTiles, type TFn } from "../carrom";
import { TIEBREAK_TILE_ID, buildSheets as boardgameSheets, PAIRING_TILE_ID } from "../boardgame";
import { DOCK_AMOUNTS, SCORE_ENTRY_TILE_ID, CORRECTION_TILE_ID, buildSheets as genericSheets } from "../generic";

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);
const echo = (key: string): string => key;

let compared = 0;
const count = (n = 1): void => {
  compared += n;
};

const START = { type: "core.start", payload: {} };

type NumberStep = Extract<GuidedSheetStep, { kind: "number" }>;
type ChoiceStep = Extract<GuidedSheetStep, { kind: "choice" }>;
/** A number step with its bounds resolved: a bound the step does not declare is a failure here, never an `undefined` that compares equal to itself. */
function numberStep(sheet: GuidedSheetSpec, id: string): NumberStep & { min: number; max: number } {
  const step = sheet.steps.find((s) => s.id === id);
  if (!step || step.kind !== "number") throw new Error(`sheet ${sheet.event} has no number step "${id}"`);
  if (step.min === undefined || step.max === undefined) throw new Error(`sheet ${sheet.event} step "${id}" declares no min/max`);
  return { ...step, min: step.min, max: step.max };
}
function choiceStep(sheet: GuidedSheetSpec, id: string): ChoiceStep {
  const step = sheet.steps.find((s) => s.id === id);
  if (!step || step.kind !== "choice") throw new Error(`sheet ${sheet.event} has no choice step "${id}"`);
  return step;
}

/** A payload folded through the REAL engine on the scorer's path (strict). Returns the refusal code, or null when the fold took it. */
function refusalOf(
  module: Parameters<typeof foldMatch>[0] & { positions: Parameters<typeof defaultLineupPair>[0] },
  cfg: unknown,
  events: readonly { type: string; payload: unknown }[],
): string | null {
  const envelopes: EventEnvelope[] = events.map((e, i) => makeEnvelope(i + 1, { type: e.type, payload: e.payload } as ModuleEvent));
  try {
    foldMatch(module, cfg as never, defaultLineupPair(module.positions), envelopes, { strictFromSeq: 0 });
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string") throw error;
    return code;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// carrom
// ---------------------------------------------------------------------------------------------------------------------------

const ICF = carrom.configSchema.parse({});
const CLUB29 = carrom.configSchema.parse(carrom.variants["club-29"]);
const BEST_OF_5 = carrom.configSchema.parse({ bestOf: 5 });
const carromView = (cfg: unknown, events: readonly { type: string; payload: unknown }[] = [START], band?: 0 | 1 | 2 | 3): PadHostView =>
  liveView("carrom", { cfg: cfg as Record<string, unknown>, events, ...(band === undefined ? {} : { band }) });

describe("carrom skin reads carromPadRules", () => {
  it("CA-AD-2: both adjustment sheets offer exactly the three reasons the rule row names, at both cfgs", () => {
    const rows = ["due_coins", "foul", "other"]; // CA-AD-2, typed from the row
    expect([...carromPadRules.adjustReasons]).toEqual(rows);
    for (const cfg of [ICF, CLUB29]) {
      // the deduction sheet needs a side with points, so the open game holds a board
      const sheets = carromSheets(carromView(cfg, [START, { type: "carrom.board.summary", payload: { winner: "H", opponentCoinsLeft: 4 } }]));
      for (const sheet of [sheets["adjustCredit"]!, sheets["adjustDeduct"]!]) {
        expect(choiceStep(sheet, "reason").options.map((o) => o.id)).toEqual(rows);
        count();
      }
    }
  });

  it("CA-AD-1: the credit step runs 1..gameTo (25, club-29's 29), and the largest credit it offers is the largest the strict fold takes", () => {
    for (const [cfg, gameTo] of [[ICF, 25], [CLUB29, 29]] as const) {
      const sheet = carromSheets(carromView(cfg))["adjustCredit"]!;
      const delta = numberStep(sheet, "delta");
      expect([delta.min, delta.max]).toEqual([1, gameTo]);
      count();
      // the payload at the step's max folds; one past it is the engine's out-of-range refusal (the bound is the fold's own)
      const at = (n: number) => sheet.buildPayload({ side: "home", delta: String(n), reason: "foul" });
      expect(refusalOf(carrom, cfg, [START, { type: "carrom.game.adjust", payload: at(delta.max) }]), `${gameTo}`).toBeNull();
      expect(refusalOf(carrom, cfg, [START, { type: "carrom.game.adjust", payload: at(delta.max + 1) }]), `${gameTo}+1`).toBe("ADJUST_OUT_OF_RANGE");
      count(2);
    }
  });

  it("CA-AD-1: a deduction is offered down to what the side holds and no further (sequence: it shrinks as points are taken away)", () => {
    const board = { type: "carrom.board.summary", payload: { winner: "H", opponentCoinsLeft: 4 } };
    for (const cfg of [ICF, CLUB29]) {
      const v = carromView(cfg, [START, board]);
      const held = (v.state as { games: { score: { home: number } }[] }).games.at(-1)!.score.home;
      expect(held, "premise: four coins left is four points (Law 53a)").toBe(4);
      const step = numberStep(carromSheets(v)["adjustDeduct"]!, "delta:home");
      expect([step.min, step.max]).toEqual([-held, -1]);
      count();
      // after a 1-point deduction the side holds 3, and the offer shrinks with it
      const after = carromView(cfg, [START, board, { type: "carrom.game.adjust", payload: { entrantId: "H", delta: -1, reason: "foul" } }]);
      expect(numberStep(carromSheets(after)["adjustDeduct"]!, "delta:home").min).toBe(-(held - 1));
      count();
    }
  });

  it("CA-CN-1: both board sheets bound the opponent's coins left at nine, and nine folds while ten is refused", () => {
    expect(carromPadRules.opponentCoinsMax).toBe(9); // CA-CN-1, typed from the row (ICF Laws 52(b)(ii), 53(a))
    const sheets = carromSheets(carromView(ICF));
    for (const id of ["board", "boardQueen"]) {
      const sheet = sheets[id]!;
      const coins = numberStep(sheet, "coins");
      expect([coins.min, coins.max], id).toEqual([0, 9]);
      const answers = { winner: "home", queenTo: "home", coins: String(coins.max) };
      expect(refusalOf(carrom, ICF, [START, { type: "carrom.board.summary", payload: sheet.buildPayload(answers) }]), id).toBeNull();
      expect(refusalOf(carrom, ICF, [START, { type: "carrom.board.summary", payload: sheet.buildPayload({ ...answers, coins: String(coins.max + 1) }) }]), `${id}+1`).toBe("INVALID_EVENT");
      count(3);
    }
  });

  it("CA-FM-1: the scorebug states the cfg's own games and target - 3 and 25 by default, 29 for club-29, 5 games for a best-of-5 - and the strip counts against the same games", () => {
    const cases = [
      [ICF, 3, 25],
      [CLUB29, 3, 29],
      [BEST_OF_5, 5, 25],
    ] as const;
    for (const [cfg, bestOf, gameTo] of cases) {
      const spec = carromScorebug(carromView(cfg), t);
      expect(spec.context).toBe(`pad.carrom.context.format(${JSON.stringify({ bestOf, gameTo })})`);
      const game = spec.strip.find((item) => item.id === "game");
      expect(game?.value, `${bestOf}/${gameTo}`).toBe(`1/${bestOf}`);
      count(2);
    }
    // the empty case: before core.start there is no game, so no strip item, but the context still states the format
    const fresh = carromScorebug(carromView(ICF, []), t);
    expect(fresh.strip).toEqual([]);
    expect(fresh.context).toBe(`pad.carrom.context.format(${JSON.stringify({ bestOf: 3, gameTo: 25 })})`);
    count(2);
  });

  it("CA-FM-1: a cfg the carrom schema refuses is refused here too (the skin has no fallback of its own)", () => {
    expect(() => carromScorebug(carromView(ICF), t)).not.toThrow();
    const broken = { ...carromView(ICF), cfg: { bestOf: 4 } };
    expect(() => carromScorebug(broken, t)).toThrow(/odd/);
    count(2);
  });

  it("the band gate is the module's: the toss and the adjustments are band 1, the boards band 0 (typed from the band ruling)", () => {
    const at = (band: 0 | 1, events: readonly { type: string; payload: unknown }[]) => carromTiles(carromView(ICF, events, band)).map((tile) => tile.id);
    expect(at(0, [])).toEqual([]);
    expect(at(1, [])).toEqual(["toss"]);
    expect(at(0, [START])).toEqual(["board", "boardQueen"]);
    expect(at(1, [START])).toEqual(["board", "boardQueen", "adjustCredit", "adjustDeduct"]);
    count(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// boardgame
// ---------------------------------------------------------------------------------------------------------------------------

const DRAWN = { type: "boardgame.result", payload: { winner: null, method: "agreement" } };
const stageView = (rungs?: readonly string[]): PadHostView =>
  liveView("boardgame", {
    stageKind: "knockout",
    cfg: { tiebreak: true, ...(rungs === undefined ? {} : { tiebreakRungs: rungs }) },
    events: [START, DRAWN],
  });
const tiebreakSheet = (rungs?: readonly string[]): GuidedSheetSpec => boardgameSheets(stageView(rungs), echo)[TIEBREAK_TILE_ID]!;
const shownIds = (sheet: GuidedSheetSpec, answers: Record<string, string>): string[] => sheet.steps.filter((s) => s.when?.(answers) ?? true).map((s) => s.id);
const tiebreakEvent = (payload: unknown) => ({ type: "boardgame.tiebreak", payload });

describe("chess skin reads boardgamePadRules", () => {
  it("BG-PA-1: the pairing card's board step runs 1..200 (typed from the row) at both colour cfgs, and the folds take 1 and 200", () => {
    expect(boardgamePadRules.boardMax).toBe(200);
    for (const cfg of [{}, { colors: false }]) {
      const v = liveView("boardgame", { cfg, events: [] });
      const step = numberStep(boardgameSheets(v, echo)[PAIRING_TILE_ID]!, "board");
      expect([step.min, step.max]).toEqual([1, 200]);
      for (const board of [step.min, step.max]) {
        expect(refusalOf(boardgame, boardgame.configSchema.parse(cfg), [{ type: "boardgame.pairing", payload: { board } }]), `${board}`).toBeNull();
        count();
      }
      count();
    }
  });

  it("BG-KO-4: the tie-break score step offers exactly the scores the record names (none, the narrow 1½–½, the clean 2–0), and every one folds", () => {
    // typed from the row: no score, 1½–½ or 2–0
    const typed = new Set<string | null>([null, "1½–½", "2–0"]);
    expect(new Set(boardgamePadRules.tiebreakScores)).toEqual(typed);
    for (const rungs of [["rapid"], ["blitz"], ["rapid", "blitz", "armageddon"]]) {
      const sheet = tiebreakSheet(rungs);
      const offered = choiceStep(sheet, "score").options.map((o) => (o.id === "none" ? null : o.id));
      expect(new Set(offered), rungs.join()).toEqual(typed);
      expect(offered, "no score is offered twice").toHaveLength(typed.size);
      count(2);
      const rung = rungs[0]!;
      for (const option of choiceStep(sheet, "score").options) {
        const payload = sheet.buildPayload({ rung, winner: "home", score: option.id });
        expect(refusalOf(boardgame, boardgame.configSchema.parse({ tiebreak: true, tiebreakRungs: rungs }), [START, DRAWN, tiebreakEvent(payload)]), `${rung} ${option.id}`).toBeNull();
        expect("score" in (payload as object), option.id).toBe(option.id !== "none");
        count(2);
      }
    }
  });

  it("BG-KO-2: the winner and score steps are shown on every rung but the Armageddon, whose Black and result steps are shown on it alone - and each rung's payload folds", () => {
    const sheet = tiebreakSheet([...TIEBREAK_RUNGS]);
    const armageddon = boardgamePadRules.armageddonRung;
    const cfg = boardgame.configSchema.parse({ tiebreak: true });
    let rungs = 0;
    for (const rung of TIEBREAK_RUNGS) {
      const shown = shownIds(sheet, { rung });
      const timed = rung !== armageddon;
      expect(shown.includes("winner"), `${rung} winner`).toBe(timed);
      expect(shown.includes("score"), `${rung} score`).toBe(timed);
      expect(shown.includes("black"), `${rung} black`).toBe(!timed);
      expect(shown.includes("result"), `${rung} result`).toBe(!timed);
      expect(shown.includes("confirm"), `${rung} confirm`).toBe(!timed);
      const payload = timed
        ? sheet.buildPayload({ rung, winner: "away" })
        : sheet.buildPayload({ rung, black: "black-home", result: "result-white" });
      expect(refusalOf(boardgame, cfg, [START, DRAWN, tiebreakEvent(payload)]), rung).toBeNull();
      rungs++;
      count(6);
    }
    expect(rungs, "every rung the engine declares was driven").toBe(TIEBREAK_RUNGS.length);
    expect(rungs).toBeGreaterThanOrEqual(3);
    // a one-rung stage builds that rung's branch alone (no pick): the Armageddon-only sheet has Black and result, the rapid-only has a winner
    expect(shownIds(tiebreakSheet([armageddon]), {})).toEqual(["black", "result", "confirm"]);
    expect(shownIds(tiebreakSheet(["rapid"]), {})).toEqual(["winner", "score"]);
    count(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// generic
// ---------------------------------------------------------------------------------------------------------------------------

const SCORE_CFG = { resultMode: "score", allowDraws: true };
const WIN_LOSS_CFG = { resultMode: "win_loss", allowDraws: false };
const press = (points: number) => ({ type: "generic.score", payload: { by: "H", points } });
const genericView = (cfg: Record<string, unknown>, events: readonly { type: string; payload: unknown }[] = []): PadHostView => liveView("generic", { cfg, events });

describe("generic skin reads genericPadRules", () => {
  it("GN-SC-1: the score-entry card bounds each side's final score at 500 (typed from the row), the fold takes 500, and win_loss has no such card (sequence: both modes)", () => {
    expect(genericPadRules.maxPlausibleScore).toBe(500);
    const sheet = genericSheets(genericView(SCORE_CFG), echo)[SCORE_ENTRY_TILE_ID]!;
    for (const id of ["home", "away"]) {
      const step = numberStep(sheet, id);
      expect([step.min, step.max], id).toEqual([0, 500]);
      count();
    }
    const payload = sheet.buildPayload({ home: "500", away: "3" });
    expect(refusalOf(generic, generic.configSchema.parse(SCORE_CFG), [{ type: "generic.result", payload }])).toBeNull();
    count();
    expect(genericSheets(genericView(WIN_LOSS_CFG), echo)[SCORE_ENTRY_TILE_ID], "win_loss declares no score-entry card").toBeUndefined();
    count();
  });

  it("GN-SC-2: the correction card is capped at 50 whatever the tally holds (a tally of 60 offers 50), and below that at what the tally holds - the empty tally offers none", () => {
    expect(genericPadRules.maxTallyStep).toBe(50); // GN-SC-2, typed from the row
    const ceilingAt = (events: readonly { type: string; payload: unknown }[]): number | undefined => {
      const sheet = genericSheets(genericView(SCORE_CFG, events), echo)[CORRECTION_TILE_ID];
      return sheet === undefined ? undefined : numberStep(sheet, "points").max;
    };
    expect(ceilingAt([])).toBeUndefined();
    expect(ceilingAt([press(30)])).toBe(30);
    expect(ceilingAt([press(50)])).toBe(50);
    expect(ceilingAt([press(50), press(10)])).toBe(50);
    count(4);
    // the sequence: the cap is a cap of the offer - correcting 50 off a tally of 60 leaves 10, and the offer shrinks with it
    expect(ceilingAt([press(50), press(10), press(-50)])).toBe(10);
    count();
    // the payload at the cap folds through the real engine
    const v = genericView(SCORE_CFG, [press(50), press(10)]);
    const sheet = genericSheets(v, echo)[CORRECTION_TILE_ID]!;
    const correction = sheet.buildPayload({ side: "home", points: "50" });
    expect(refusalOf(generic, generic.configSchema.parse(SCORE_CFG), [press(50), press(10), { type: "generic.score", payload: correction }])).toBeNull();
    count();
  });

  it("GN-SC-2: every one-tap amount the dock offers is a legal press, within the single-press bound", () => {
    expect(DOCK_AMOUNTS.length).toBeGreaterThan(0);
    for (const amount of DOCK_AMOUNTS) {
      expect(amount).toBeGreaterThanOrEqual(1);
      expect(amount).toBeLessThanOrEqual(genericPadRules.maxTallyStep);
      expect(refusalOf(generic, generic.configSchema.parse(SCORE_CFG), [press(amount)]), `${amount}`).toBeNull();
      count();
    }
  });
});

// The behaviour tests above cannot tell an inline `max: 200` from `max: boardgamePadRules.boardMax` (equal values), and the literal guard
// bans names, not numbers. This reads the three skins' source and holds the wiring: no step in them types a numeric `max`, and each bound is
// read from its record member the expected number of times.
const sourceOf = (file: string): string =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the skins take their bounds from the records, not a typed number (source text)", () => {
  it("no step in carrom.tsx, boardgame.tsx or generic.tsx types a numeric max, and each bound is read from its record member", () => {
    const wiring: readonly [file: string, member: RegExp, times: number][] = [
      ["carrom.tsx", /\bmax: carromPadRules\.opponentCoinsMax\b/g, 2],
      ["carrom.tsx", /const gameTo = carromPadRules\.gameTo\(cfg\);/g, 1],
      ["carrom.tsx", /carromPadRules\.adjustReasons\.map\(/g, 1],
      ["boardgame.tsx", /\bmax: boardgamePadRules\.boardMax\b/g, 1],
      ["generic.tsx", /\bmax: genericPadRules\.maxPlausibleScore\b/g, 2],
      ["generic.tsx", /Math\.min\(genericPadRules\.maxTallyStep,/g, 1],
    ];
    for (const file of ["carrom.tsx", "boardgame.tsx", "generic.tsx"]) {
      expect(sourceOf(file).match(/\bmax:\s*\d/g) ?? [], `${file}: a numeric max typed in a step`).toEqual([]);
      count();
    }
    for (const [file, member, times] of wiring) {
      expect((sourceOf(file).match(member) ?? []).length, `${file}: ${member.source}`).toBe(times);
      count();
    }
  });
});

describe("the sweep", () => {
  it("compared at least the facts the three records declare (anti-vacuity)", () => {
    // adjustReasons, adjust bound, deduct bound, coins, bestOf/gameTo, board, scores, armageddon gate, score entry, tally cap, dock amounts
    console.info(`[pad-rules-small] skin comparisons made: ${compared}`);
    expect(compared, `comparisons made: ${compared}`).toBeGreaterThanOrEqual(60);
  });
});
