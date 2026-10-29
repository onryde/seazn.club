// Pad wave P2 — THE CRICKET DRIFT GUARD.
//
// The cricket skin used to carry its own copies of cricket's rule sets (the dismissal modes, the extras, which modes credit a
// fielder or the bowler, which batter can be out, what stands on a free hit, the toss / retire / review / close options, the
// penalty and wide runs, balls per over). They are now the engine's (`cricketPadRules`, @seazn/engine/pad). This file drives the
// skin's REAL builders (sheets, tiles, dock) over states the real fold produced, compares what they OFFER with the engine record,
// and folds what they EMIT back through the engine — never the record against a constant the skin re-exports (Review Focus 1:
// that comparison is always green). Every comparison is counted; the last test fails if fewer than the plan's 16 were made.
//
// single-sport: cricket's dismissal modes, extras and free hit exist in no other sport.
import { describe, expect, it } from "vitest";
import { foldMatch, initSquads, type EventEnvelope } from "@seazn/engine/core";
import { cricketPadRules } from "@seazn/engine/pad";
import { cricket, type CricketCfg, type CricketState } from "@seazn/engine/sports/cricket";
import { cricketEnvelopes, cricketLineups, type CricketEventSpec } from "../../__tests__/_cricket-fold";
import { answerStep, currentStep, initialSheetState } from "../../guided-sheet";
import type { GuidedSheetSpec, GuidedSheetStep, PadHostView, TileSpec } from "../../types";
import { buildDock, buildSheets, buildTiles, type TFn } from "../cricket";

const t: TFn = (key) => key;
const T20 = cricket.configSchema.parse(cricket.variants.t20);
const HUNDRED = cricket.configSchema.parse(cricket.variants.hundred);
const STRIKER = "H-1";
const NON_STRIKER = "H-2";
const OPENING_BOWLER = "A-11";
const FIELDER = "A-7";

/** MCC Law 37.1.1 "Either batter is out Obstructing the field" (owner ruling Q1b: the skin asks who), and the house rulebook's
 *  fielder credit for it (DOMAIN.md, Dismissals; owner ruling Q1: the skin asks for the fielder). The one mode this batch moved. */
const OBSTRUCTED = "obstructed";
/** DOMAIN.md, "Free hit armed and consumed": "only run-out/obstruction may dismiss on it". A rulebook anchor, so a free-hit set
 *  that drifts in the ENGINE (the skin follows it) still goes red here. */
const RULEBOOK_FREE_HIT = ["obstructed", "runout"];

let compared = 0;
/** One compared fact: an equality between what the skin's builder produced and what the engine declares or folds. */
function same<T>(actual: T, expected: T, what: string): void {
  expect(actual, what).toEqual(expected);
  compared++;
}

function viewOf(cfg: CricketCfg, specs: readonly CricketEventSpec[]): PadHostView {
  const events: EventEnvelope[] = cricketEnvelopes(specs);
  return {
    cfg,
    state: foldMatch(cricket, cfg, cricketLineups(), events),
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: initSquads(cricketLineups()),
    events,
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
  };
}

/** The ledger plus one emitted event, the emitted one folded on the write path (strict), exactly as the server will. */
function foldEmitted(cfg: CricketCfg, specs: readonly CricketEventSpec[], event: { type: string; payload: unknown }): CricketState {
  const all: CricketEventSpec[] = [...specs, [event.type, event.payload]];
  return foldMatch(cricket, cfg, cricketLineups(), cricketEnvelopes(all), { strictFromSeq: specs.length });
}

function openInnings(state: CricketState) {
  const innings = state.innings.at(-1);
  if (innings?.fine == null) throw new Error("premise: a ball-by-ball innings is open");
  return { ...innings, fine: innings.fine };
}

function choiceIds(spec: GuidedSheetSpec, stepId: string): string[] {
  const step = spec.steps.find((s) => s.id === stepId);
  if (step?.kind !== "choice") throw new Error(`expected a choice step "${stepId}"`);
  return step.options.map((o) => o.id);
}

/** Drives the REAL guided-sheet step machine to the end, answering each step `answer` picks. */
function walk(spec: GuidedSheetSpec, answer: (step: GuidedSheetStep) => string) {
  let state = initialSheetState();
  const asked: string[] = [];
  for (let i = 0; i < 12; i++) {
    const step = currentStep(spec, state);
    if (step === null) throw new Error(`sheet stalled after ${asked.join(" > ")}`);
    asked.push(step.id);
    const advance = answerStep(spec, state, answer(step));
    if (advance.done) return { asked, event: advance.event };
    state = advance.state;
  }
  throw new Error(`sheet never finished: ${asked.join(" > ")}`);
}

const ball = (over: number, ballInOver: number, extra: Record<string, unknown> = {}): CricketEventSpec => [
  "cricket.ball",
  { over, ballInOver, striker: STRIKER, nonStriker: NON_STRIKER, bowler: OPENING_BOWLER, runs: { bat: 0 }, ...extra },
];
const START: readonly CricketEventSpec[] = [["core.start"]];
const FREE_HIT_PENDING: readonly CricketEventSpec[] = [...START, ball(0, 1, { runs: { bat: 0, extras: { kind: "noball", runs: 1 } } })];

const tilePayload = (tile: TileSpec | undefined): Record<string, unknown> => {
  const action = tile?.action;
  if (action === undefined || !("event" in action)) throw new Error(`tile ${tile?.id} emits no event`);
  return action.event.payload as Record<string, unknown>;
};

describe("the wicket sheet offers the engine's modes", () => {
  it("every mode, in the engine's order; with a free hit pending, the engine's free-hit set (folded, not hand-built)", () => {
    same(choiceIds(buildSheets(viewOf(T20, START), t).wicket, "kind"), [...cricketPadRules.wicketKinds], "kind options");
    const freeHit = viewOf(T20, FREE_HIT_PENDING);
    expect(openInnings(freeHit.state as CricketState).fine.freeHitPending, "premise: the fold has a free hit pending").toBe(true);
    const offered = choiceIds(buildSheets(freeHit, t).wicket, "kind");
    same([...offered].sort(), [...cricketPadRules.freeHitDismissalKinds].sort(), "free-hit kind options");
    same([...offered].sort(), RULEBOOK_FREE_HIT, "free-hit kind options are the rulebook's");
    // Order kept: the narrowed list is the engine's mode list filtered, never re-ordered (Review Focus 3).
    same(offered, cricketPadRules.wicketKinds.filter((k) => offered.includes(k)), "free-hit options keep the engine's order");
  });

  it("asks who is out exactly for variableOutKinds and the fielder exactly for fielderCreditedKinds, and every payload folds", () => {
    const asked = new Map<string, string[]>();
    for (const kind of cricketPadRules.wicketKinds) {
      const spec = buildSheets(viewOf(T20, START), t).wicket;
      const { asked: steps, event } = walk(spec, (step) => {
        if (step.id === "kind") return kind;
        if (step.id === "out") return NON_STRIKER; // the other batter: only a mode either batter can be out in asks
        if (step.id === "fielder") return FIELDER;
        if (step.kind === "person" && step.candidates?.[0] !== undefined) return step.candidates[0];
        throw new Error(`${kind}: unexpected step "${step.id}"`);
      });
      asked.set(kind, steps);
      const variable = cricketPadRules.variableOutKinds.includes(kind);
      const credited = cricketPadRules.fielderCreditedKinds.includes(kind);
      same(steps.includes("out"), variable, `${kind}: who's out asked`);
      same(steps.includes("fielder"), credited, `${kind}: fielder asked`);
      const wicket = (event.payload as { wicket: { out: string; fielder?: string; bowlerCredited: boolean } }).wicket;
      same(wicket.out, variable ? NON_STRIKER : STRIKER, `${kind}: out`);
      same(wicket.bowlerCredited, cricketPadRules.bowlerCreditedKinds.includes(kind), `${kind}: bowlerCredited`);
      // The seam's consumer: the engine takes the sheet's own payload on the write path, and credits the fielder it named.
      const innings = openInnings(foldEmitted(T20, START, event));
      same(innings.fine.dismissed, [wicket.out], `${kind}: the fold dismissed the batter the sheet named`);
      same(innings.fine.fielding?.[FIELDER] !== undefined, credited, `${kind}: the fold credited the fielder`);
    }
    // Q1 and Q1b, pinned by name: obstructing the field asks who is out, then the fielder.
    same(asked.get(OBSTRUCTED), ["kind", "out", "fielder", "incoming"], "obstructed's steps");
    console.info(`[pad-rules-cricket] wicket modes walked: ${asked.size}`);
    expect(asked.size).toBe(10);
  });
});

describe("the tiles, dock and option sheets offer the engine's sets", () => {
  it("one extra tile per engine extra kind; the wide records wideDefaultRuns and the penalty penaltyRuns, both as the fold scores them", () => {
    const tiles = buildTiles(viewOf(T20, START), t);
    const extraTiles = tiles.filter((tile) => {
      const action = tile.action;
      return action !== undefined && "event" in action && (action.event.payload as { runs?: { extras?: unknown } }).runs?.extras !== undefined;
    });
    const kinds = extraTiles.map((tile) => (tilePayload(tile).runs as { extras: { kind: string } }).extras.kind);
    same([...kinds].sort(), [...cricketPadRules.extraKinds].sort(), "extra tile kinds");

    const runsOf = (kind: string) => (tilePayload(extraTiles[kinds.indexOf(kind)]).runs as { extras: { runs: number } }).extras.runs;
    same(runsOf("wide"), cricketPadRules.wideDefaultRuns, "wide tile runs");
    same(runsOf("penalty"), cricketPadRules.penaltyRuns, "penalty tile runs");
    const wide = openInnings(foldEmitted(T20, START, { type: "cricket.ball", payload: tilePayload(extraTiles[kinds.indexOf("wide")]) }));
    same([wide.runs, wide.legalBalls, wide.fine.striker], [cricketPadRules.wideDefaultRuns, 0, STRIKER], "a wide tile, folded");
    const penalty = openInnings(foldEmitted(T20, START, { type: "cricket.ball", payload: tilePayload(extraTiles[kinds.indexOf("penalty")]) }));
    same(penalty.runs, cricketPadRules.penaltyRuns, "a penalty tile, folded");
  });

  it("a run tile and a no ball's bat-run chip carry `boundary` exactly for the engine's boundary values", () => {
    const tiles = buildTiles(viewOf(T20, START), t).filter((tile) => /^run\d+$/.test(tile.id));
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      const payload = tilePayload(tile);
      const runs = (payload.runs as { bat: number }).bat;
      same(payload.boundary, cricketPadRules.boundaryValues.includes(runs) ? runs : undefined, `${tile.id} boundary`);
    }
    const noBall = { over: 0, ballInOver: 1, runs: { bat: 0, extras: { kind: "noball", runs: 1 } } };
    const dock = buildDock("cricket.ball", t, noBall);
    expect(dock?.chips.length ?? 0).toBeGreaterThan(0);
    for (const chip of dock?.chips ?? []) {
      const mutated = chip.mutate(noBall) as { runs: { bat: number }; boundary?: number };
      same(mutated.boundary, cricketPadRules.boundaryValues.includes(mutated.runs.bat) ? mutated.runs.bat : undefined, `${chip.id} boundary`);
    }
  });

  it("toss, retire, review and innings-close sheets offer the engine's option sets, in its order", () => {
    const sheets = buildSheets(viewOf(T20, START), t);
    same(choiceIds(sheets.toss, "elected"), [...cricketPadRules.tossElections], "toss elected");
    same(choiceIds(sheets.retire, "reason"), [...cricketPadRules.retireReasons], "retire reason");
    same(choiceIds(sheets.review, "kind"), [...cricketPadRules.reviewKinds], "review kind");
    same(choiceIds(sheets.review, "outcome"), [...cricketPadRules.reviewOutcomes], "review outcome");
    same(choiceIds(sheets.inningsClose, "reason"), [...cricketPadRules.inningsCloseReasons], "innings-close reason");
  });
});

describe("balls per over is the cfg's, at two cfgs", () => {
  it("after five legal balls the next delivery is numbered by the cfg's over (T20 6, the hundred 5), and the fold takes it", () => {
    const numbering = new Map<string, [number, number]>();
    for (const [name, cfg] of [["t20", T20], ["hundred", HUNDRED]] as const) {
      same(cricketPadRules.ballsPerOver(cfg), cfg.ballsPerOver, `${name}: ballsPerOver`);
      const specs: CricketEventSpec[] = [...START, ...[1, 2, 3, 4, 5].map((n) => ball(0, n))];
      const dot = tilePayload(buildTiles(viewOf(cfg, specs), t).find((tile) => tile.id === "run0"));
      numbering.set(name, [dot.over as number, dot.ballInOver as number]);
      // The fold checks over/ballInOver (and a new over's bowler) against ITS cfg on the write path: a skin that assumed six
      // balls would be refused at the hundred.
      same(openInnings(foldEmitted(cfg, specs, { type: "cricket.ball", payload: dot })).legalBalls, 6, `${name}: the sixth legal ball folds`);
    }
    same(numbering.get("t20"), [0, 6], "t20: the sixth ball of over 0");
    same(numbering.get("hundred"), [1, 1], "hundred: the first ball of over 1");
  });
});

describe("the drift guard compared something", () => {
  it("made at least the plan's 16 comparisons", () => {
    console.info(`[pad-rules-cricket] facts compared: ${compared}`);
    expect(compared).toBeGreaterThanOrEqual(16);
  });
});
