// P2 (pad wave) - cricket's pad rules, read through the real fold.
//
// single-sport: every fact here is a cricket Law (dismissal modes, extras, the free hit, the toss); no other sport has them.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import {
  BOWLER_CREDITED_KINDS,
  CricketBall,
  CricketClose,
  CricketExtras,
  CricketRetire,
  CricketReview,
  CricketToss,
  CricketWicket,
  ExtraKind,
  FIELDER_CREDIT_COLUMN,
  FIELDER_OPTIONAL_KINDS,
  FREE_HIT_DISMISSAL_KINDS,
  NO_BALL_DEFAULT_RUNS,
  PENALTY_RUNS,
  SUPER_OVER_EVENT_TYPES,
  VARIABLE_OUT_KINDS,
  WicketKind,
  WIDE_DEFAULT_RUNS,
  cricket,
  padSpec,
  type CricketCfg,
  type CricketState,
} from "../sports/cricket/cricket.ts";
import { aggregatePlayerStats } from "../stats/stats.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { cricketPadRules, padNumberBound } from "./index.ts";

/** Every write below is pad-shaped: the whole stream is new (`strictFromSeq: 0`), the write path. */
const STRICT_ALL = { strictFromSeq: 0 } as const;
const parse = (raw: unknown): CricketCfg => cricket.configSchema.parse(raw);
const lineupsFor = (cfg: CricketCfg): LineupPair => defaultLineupPair(resolvePositions(cricket, cfg));
type Spec = [type: string, payload?: unknown];
const ledger = (specs: readonly Spec[]): EventEnvelope[] => specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));

const T20 = parse(cricket.variants.t20);
const STRIKER = "H-p1";
const NON_STRIKER = "H-p2";
const BOWLER = "A-p11";
const FIELDER = "A-p7";
/** MCC Laws 32, 33, 35, 36, 39: the bowler is credited with bowled, caught, hit wicket, lbw and stumped, and nothing else. */
const LAWS_BOWLER_CREDITED = ["bowled", "caught", "hitwicket", "lbw", "stumped"];

type Mode = (typeof CricketWicket.shape.kind.options)[number];
const MODES: readonly Mode[] = CricketWicket.shape.kind.options;
const wicketOf = (kind: Mode, out: string, extra: Record<string, unknown> = {}) => ({
  kind,
  out,
  bowlerCredited: LAWS_BOWLER_CREDITED.includes(kind),
  ...extra,
});
/** The first delivery of the match, no bat runs. */
const delivery = (opts: { wicket?: ReturnType<typeof wicketOf>; extras?: { kind: string; runs: number }; bat?: number } = {}): Spec => [
  "cricket.ball",
  {
    over: 0,
    ballInOver: 1,
    striker: STRIKER,
    nonStriker: NON_STRIKER,
    bowler: BOWLER,
    runs: { bat: opts.bat ?? 0, ...(opts.extras === undefined ? {} : { extras: opts.extras }) },
    ...(opts.wicket === undefined ? {} : { wicket: opts.wicket }),
  },
];
const fold = (cfg: CricketCfg, specs: readonly Spec[]): CricketState => foldMatch(cricket, cfg, lineupsFor(cfg), ledger(specs), STRICT_ALL);
function openInnings(state: CricketState) {
  const innings = state.innings.at(-1);
  if (innings?.fine == null) throw new Error("premise: a ball-by-ball innings is open");
  return { ...innings, fine: innings.fine };
}
function refusalOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof EngineError) return `${err.code}: ${err.message}`;
    throw err;
  }
}

describe("P2.1 premise (Q1b): which batter the fold accepts as `out`", () => {
  it("an obstructing-the-field wicket folds with EITHER batter out (MCC Law 37.1.1: either batter is out obstructing)", () => {
    const outs: string[] = [];
    for (const out of [STRIKER, NON_STRIKER]) {
      const innings = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf("obstructed", out) })]));
      expect(innings.wickets, `obstructed, ${out} out`).toBe(1);
      expect(innings.fine.dismissed, `obstructed, ${out} out`).toEqual([out]);
      outs.push(out);
    }
    expect(outs).toEqual([STRIKER, NON_STRIKER]);
  });

  it("the fold's only `out` check is crease membership: it accepts the non-striker for EVERY mode, and refuses a batter not at the crease (lenient beyond the Laws; owed as rules row CK-WK-4, open: tightening the fold reds this on purpose)", () => {
    // This is what makes `variableOutKinds` a declaration (c) and not a mirror of a fold guard: cricket.ts's applyDelivery checks
    // `wicket.out` against the two batters at the crease and nothing else, so bowled-the-non-striker folds. Pinned here so a
    // drift test can never claim the fold enforces "who can be out" per mode. The Laws allow it for none of bowled, caught, lbw,
    // stumped, hit wicket or hit the ball twice (Laws 32-36, 39); ruling 242 parks the fix (a fold change with a cricket
    // FOLD_EPOCH bump) in docs/superpowers/specs/engine-split/2026-10-26-owed-work.md. When it lands, this test changes with it.
    const modes = CricketWicket.shape.kind.options;
    let acceptedNonStriker = 0;
    for (const kind of modes) {
      const innings = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf(kind, NON_STRIKER) })]));
      expect(innings.fine.dismissed, `${kind}, non-striker out`).toEqual([NON_STRIKER]);
      acceptedNonStriker++;
      expect(refusalOf(() => fold(T20, [["core.start"], delivery({ wicket: wicketOf(kind, "H-p3") })])), `${kind}, a batter not in`).toBe(
        'INVALID_EVENT: "H-p3" is not at the crease',
      );
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/cricket] modes folded with the non-striker out: ${acceptedNonStriker} of ${modes.length}`);
    expect(acceptedNonStriker).toBe(modes.length);
    expect(acceptedNonStriker).toBeGreaterThan(0);
  });

  it("CK-WK-2 an obstructing-the-field wicket that names a fielder credits that fielder a run out (DOMAIN.md, Dismissals), and one that names none folds with no credit (Law 37 names no fielder; ruling 242)", () => {
    const named = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf("obstructed", NON_STRIKER, { fielder: FIELDER }) })]));
    expect(named.fine.fielding?.[FIELDER]).toEqual({ catches: 0, runOuts: 1, stumpings: 0 });
    const unnamed = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf("obstructed", NON_STRIKER) })]));
    expect(unnamed.wickets).toBe(1);
    expect(unnamed.fine.dismissed).toEqual([NON_STRIKER]);
    expect(unnamed.fine.fielding, "no fielder named, nobody credited").toBeUndefined();
  });

  it("CK-WK-2 the player stats do not yet count an obstruction's named fielder, while they count a run out's (owed work O-11: this pin reds on purpose when the stats model counts it)", () => {
    const model = cricket.playerStats;
    if (model === undefined) throw new Error("premise: cricket declares a player-stats model");
    const runOutsOf = (kind: Mode): number => {
      const events = ledger([["core.start"], delivery({ wicket: wicketOf(kind, STRIKER, { fielder: FIELDER }) })]);
      return aggregatePlayerStats(events, model, lineupsFor(T20)).find((row) => row.personId === FIELDER)?.stats.run_outs ?? 0;
    };
    expect(runOutsOf("runout"), "control: a run out's named fielder is counted").toBe(1);
    expect(runOutsOf("obstructed"), "O-11: an obstruction's named fielder is not counted yet").toBe(0);
  });

  it("CK-WK-3 a retired wicket and a retirement both fold with EITHER batter (MCC Law 25.4.1: a batter may retire at any time the ball is dead)", () => {
    let folded = 0;
    for (const out of [STRIKER, NON_STRIKER]) {
      const onBall = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf("retired", out) })]));
      expect(onBall.fine.dismissed, `retired on a ball, ${out}`).toEqual([out]);
      const retire = openInnings(fold(T20, [["core.start"], delivery(), ["cricket.retire", { person: out, reason: "out" }]]));
      expect(retire.fine.dismissed, `cricket.retire out, ${out}`).toEqual([out]);
      folded += 2;
    }
    expect(folded).toBe(4);
  });

  it("CK-RH-2 a retired-out batter written on the wicket sheet's path (cricket.ball, wicket mode retired) counts a legal dot ball, while the Retire sheet's out (cricket.retire) records no delivery (ruling 246, a known deviation: Law 25.4.1 retires on a dead ball, so the rulebook's count is 0; owed work O-13 reds the first half of this pin on purpose)", () => {
    // The control: one plain dot ball is one legal ball. Both retired-out paths are measured against it, for either batter.
    const dotBall = openInnings(fold(T20, [["core.start"], delivery()]));
    expect(dotBall.legalBalls, "control: a plain dot ball is one legal ball").toBe(1);
    let measured = 0;
    for (const out of [STRIKER, NON_STRIKER]) {
      // The wicket sheet's Retired: the retirement rides a cricket.ball, so the delivery it rides on is counted (today's behaviour).
      const onBall = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf("retired", out) })]));
      expect(onBall.wickets, `retired on a ball, ${out}: a wicket`).toBe(1);
      expect(onBall.legalBalls, `retired on a ball, ${out}: counts the dot ball it rides on`).toBe(dotBall.legalBalls);
      // The Retire sheet's out: cricket.retire is no delivery, so it adds no ball to the one already bowled.
      const retire = openInnings(fold(T20, [["core.start"], delivery(), ["cricket.retire", { person: out, reason: "out" }]]));
      expect(retire.wickets, `cricket.retire out, ${out}: a wicket`).toBe(1);
      expect(retire.legalBalls, `cricket.retire out, ${out}: adds no ball`).toBe(dotBall.legalBalls);
      measured += 2;
    }
    expect(measured).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The record. Each field is the fold's own declaration (toBe), or a plain copy of one of its sets; each set is ALSO driven
// through the real fold, so a declaration that drifts from what the fold does goes red here.
// ---------------------------------------------------------------------------

/** DOMAIN.md, Dismissals: caught -> `.fielding[p].catches`, stumped -> `.stumpings`, run out -> `.runOuts`, obstructing the field
 *  "credits the fielder a run out" (P2.1 Q1: the house rulebook, kept by owner ruling; MCC Law 37 credits nobody). */
const RULEBOOK_FIELDER_COLUMN: Readonly<Record<string, "catches" | "stumpings" | "runOuts">> = {
  caught: "catches",
  stumped: "stumpings",
  runout: "runOuts",
  obstructed: "runOuts",
};
/** MCC Law 38.1 "Either batter is out Run out"; Law 37.1.1 "Either batter is out Obstructing the field"; Law 25.4.1 "A batter
 *  may retire at any time during their innings when the ball is dead". Every other mode is the striker's (Laws 32-36, 39) or the
 *  incoming batter's (Law 40). Ruling 242 (CK-WK-3). */
const LAWS_EITHER_BATTER: readonly Mode[] = ["runout", "obstructed", "retired"];
/** The fielder-credited modes the Laws record against no fielder: obstructing the field (Law 37, "by word or action"). The
 *  house rulebook credits one when named, so naming one is optional (ruling 242, CK-WK-2). */
const LAWS_NO_FIELDER_NAMED: readonly Mode[] = ["obstructed"];
/** DOMAIN.md, "Free hit armed and consumed": "only run-out/obstruction may dismiss on it" - CK-FH-1 as the engine holds it (ICC
 *  21.19.2 adds hit the ball twice; leaving it out is the row's recorded deviation, W2e ruling I-2). */
const RULEBOOK_FREE_HIT: readonly Mode[] = ["runout", "obstructed"];
/** MCC Law 41.2.1: "the award of 5 Penalty runs to the opposing team" - one award is five. */
const LAW_41_ONE_AWARD = 5;
/** MCC Law 22.6: "A penalty of one run shall be awarded instantly on the call of Wide ball" - a bare wide records it and nothing
 *  else. */
const LAW_WIDE_PENALTY = 1;
/** ICC playing conditions 21.15, "Penalty for a No ball" (Law 21.14 in the current MCC Laws): "A penalty of one run shall be
 *  awarded instantly on the call of No ball". */
const LAW_NO_BALL_PENALTY = 1;

const sorted = (xs: readonly (string | number)[]) => [...xs].sort();

describe("cricketPadRules: the static sets are the fold's own declarations", () => {
  it("wicketKinds / extraKinds are the schema enums the fold parses with (the same objects)", () => {
    expect(WicketKind).toBe(CricketWicket.shape.kind);
    expect(ExtraKind).toBe(CricketExtras.shape.kind);
    expect(cricketPadRules.wicketKinds).toBe(WicketKind.options);
    expect(cricketPadRules.extraKinds).toBe(ExtraKind.options);
    // The two enums the fold parses a ball with, read off the ball schema itself.
    expect(cricketPadRules.wicketKinds).toEqual(CricketBall.shape.wicket.unwrap().shape.kind.options);
    expect(cricketPadRules.extraKinds).toEqual(CricketBall.shape.runs.shape.extras.unwrap().shape.kind.options);
    expect(cricketPadRules.wicketKinds).toHaveLength(10);
    expect(cricketPadRules.extraKinds).toHaveLength(5);
  });

  it("toss, close, retire and review options are the schema enums (the same objects)", () => {
    expect(cricketPadRules.tossElections).toBe(CricketToss.shape.elected.options);
    expect(cricketPadRules.inningsCloseReasons).toBe(CricketClose.shape.reason.unwrap().options);
    expect(cricketPadRules.retireReasons).toBe(CricketRetire.shape.reason.options);
    expect(cricketPadRules.reviewKinds).toBe(CricketReview.shape.kind.options);
    expect(cricketPadRules.reviewOutcomes).toBe(CricketReview.shape.outcome.options);
    for (const list of [
      cricketPadRules.tossElections,
      cricketPadRules.inningsCloseReasons,
      cricketPadRules.retireReasons,
      cricketPadRules.reviewKinds,
      cricketPadRules.reviewOutcomes,
    ]) {
      expect(list.length).toBeGreaterThan(1);
    }
  });

  it("the copied sets are the fold's sets, member for member", () => {
    expect(sorted(cricketPadRules.fielderCreditedKinds)).toEqual(sorted(Object.keys(FIELDER_CREDIT_COLUMN)));
    expect(sorted(cricketPadRules.freeHitDismissalKinds)).toEqual(sorted([...FREE_HIT_DISMISSAL_KINDS]));
    expect(sorted(cricketPadRules.bowlerCreditedKinds)).toEqual(sorted([...BOWLER_CREDITED_KINDS]));
    expect(sorted(cricketPadRules.variableOutKinds)).toEqual(sorted([...VARIABLE_OUT_KINDS]));
    expect(sorted(cricketPadRules.fielderOptionalKinds)).toEqual(sorted([...FIELDER_OPTIONAL_KINDS]));
    expect(sorted(cricketPadRules.superOverEventTypes)).toEqual(sorted([...SUPER_OVER_EVENT_TYPES]));
    expect(cricketPadRules.penaltyRuns).toBe(PENALTY_RUNS);
    expect(cricketPadRules.wideDefaultRuns).toBe(WIDE_DEFAULT_RUNS);
    expect(cricketPadRules.noBallDefaultRuns).toBe(NO_BALL_DEFAULT_RUNS);
    expect(Object.isFrozen(cricketPadRules)).toBe(true);
  });

  it("eventBands is the padSpec fidelity map, the same object for every declared cfg", () => {
    const cfgs = declaredCfgs(cricket);
    for (const { name, cfg } of cfgs) expect(padSpec(cfg).fidelity, name).toBe(cricketPadRules.eventBands);
    // One object shared by every padSpec(cfg) call in the process: frozen, so no consumer can leak an edit into another fixture.
    expect(Object.isFrozen(cricketPadRules.eventBands)).toBe(true);
    // Every event type the module parses carries a band.
    const moduleTypes = Object.keys(cricket.eventSchemas ?? {}).filter((t) => t.startsWith("cricket."));
    expect(moduleTypes.length).toBeGreaterThan(0);
    expect(sorted(Object.keys(cricketPadRules.eventBands))).toEqual(sorted(moduleTypes));
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/cricket] eventBands compared over ${cfgs.length} declared cfgs`);
    expect(cfgs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("cricketPadRules against the real fold (T20)", () => {
  it("CK-WK-1 fielderCreditedKinds: naming a fielder credits them exactly for these modes, in the rulebook's column; obstructed is one (Q1)", () => {
    expect(sorted(cricketPadRules.fielderCreditedKinds)).toEqual(sorted(Object.keys(RULEBOOK_FIELDER_COLUMN)));
    expect(cricketPadRules.fielderCreditedKinds).toContain("obstructed");
    let credited = 0;
    for (const kind of MODES) {
      const innings = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf(kind, STRIKER, { fielder: FIELDER }) })]));
      const column = RULEBOOK_FIELDER_COLUMN[kind];
      if (column === undefined) {
        expect(innings.fine.fielding?.[FIELDER], `${kind}: no fielder credit`).toBeUndefined();
      } else {
        expect(innings.fine.fielding?.[FIELDER]?.[column], `${kind}: ${column}`).toBe(1);
        credited++;
      }
      expect(cricketPadRules.fielderCreditedKinds.includes(kind), kind).toBe(column !== undefined);
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/cricket] fielder credit: ${MODES.length} modes folded, ${credited} credited`);
    expect(credited).toBe(4);
  });

  it("CK-FH-1 freeHitDismissalKinds: on a free hit the fold accepts exactly these modes and refuses the rest", () => {
    expect(sorted(cricketPadRules.freeHitDismissalKinds)).toEqual(sorted(RULEBOOK_FREE_HIT));
    const NO_BALL = { kind: "noball", runs: 1 };
    let accepted = 0;
    let refused = 0;
    for (const kind of MODES) {
      const specs: Spec[] = [["core.start"], delivery({ extras: NO_BALL }), delivery({ wicket: wicketOf(kind, STRIKER) })];
      const refusal = refusalOf(() => fold(T20, specs));
      if (cricketPadRules.freeHitDismissalKinds.includes(kind)) {
        expect(refusal, `${kind} on a free hit`).toBeNull();
        accepted++;
      } else {
        expect(refusal, `${kind} on a free hit`).toBe(`INVALID_EVENT: "${kind}" cannot dismiss on a free hit`);
        refused++;
      }
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/cricket] free hit: ${MODES.length} modes folded, ${accepted} accepted, ${refused} refused`);
    expect(accepted + refused).toBe(10);
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("CK-WK-1 bowlerCreditedKinds: the fold requires bowlerCredited exactly for these modes, and they are the Laws' five", () => {
    expect(sorted(cricketPadRules.bowlerCreditedKinds)).toEqual(sorted(LAWS_BOWLER_CREDITED));
    let checked = 0;
    for (const kind of MODES) {
      const listed = cricketPadRules.bowlerCreditedKinds.includes(kind);
      const right = { ...wicketOf(kind, STRIKER), bowlerCredited: listed };
      const wrong = { ...wicketOf(kind, STRIKER), bowlerCredited: !listed };
      expect(refusalOf(() => fold(T20, [["core.start"], delivery({ wicket: right })])), kind).toBeNull();
      expect(refusalOf(() => fold(T20, [["core.start"], delivery({ wicket: wrong })])), kind).toBe(
        `INVALID_EVENT: bowlerCredited must be ${listed} for "${kind}"`,
      );
      checked++;
    }
    expect(checked).toBe(MODES.length);
  });

  it("CK-WK-3 variableOutKinds (Q1b, ruling 242): the Laws' either-batter modes, each of which the fold accepts with either batter out", () => {
    expect(sorted(cricketPadRules.variableOutKinds)).toEqual(sorted(LAWS_EITHER_BATTER));
    expect(cricketPadRules.variableOutKinds).toContain("obstructed");
    expect(cricketPadRules.variableOutKinds).toContain("retired");
    let folded = 0;
    for (const kind of cricketPadRules.variableOutKinds) {
      for (const out of [STRIKER, NON_STRIKER]) {
        const innings = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf(kind as Mode, out) })]));
        expect(innings.fine.dismissed, `${kind}, ${out} out`).toEqual([out]);
        folded++;
      }
    }
    expect(folded).toBe(2 * LAWS_EITHER_BATTER.length);
  });

  it("CK-WK-2 fielderOptionalKinds (ruling 242): the fielder-credited modes the Laws name no fielder for, and each folds with no fielder named", () => {
    expect(sorted(cricketPadRules.fielderOptionalKinds)).toEqual(sorted(LAWS_NO_FIELDER_NAMED));
    let folded = 0;
    for (const kind of cricketPadRules.fielderOptionalKinds) {
      expect(cricketPadRules.fielderCreditedKinds, `${kind} is credited when named`).toContain(kind);
      const innings = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf(kind as Mode, STRIKER) })]));
      expect(innings.wickets, kind).toBe(1);
      expect(innings.fine.fielding, kind).toBeUndefined();
      folded++;
    }
    expect(folded).toBe(LAWS_NO_FIELDER_NAMED.length);
  });

  it("CK-PR-1 penaltyRuns: Law 41's one award; a penalty extra of it lands on the batting side, charged to no bowler, run by nobody", () => {
    expect(cricketPadRules.penaltyRuns).toBe(LAW_41_ONE_AWARD);
    const innings = openInnings(fold(T20, [["core.start"], delivery({ extras: { kind: "penalty", runs: cricketPadRules.penaltyRuns } })]));
    expect(innings.battingSide).toBe("home");
    expect(innings.runs).toBe(LAW_41_ONE_AWARD);
    expect(innings.fine.extras).toBe(LAW_41_ONE_AWARD);
    expect(innings.fine.bowlerRuns[BOWLER] ?? 0).toBe(0);
    expect(innings.fine.striker).toBe(STRIKER); // odd, and still nobody crossed
  });

  it("CK-EX-2 wideDefaultRuns: a bare wide scores its one-run penalty, no ball faced, no crossing; one run more and the batters have crossed", () => {
    expect(cricketPadRules.wideDefaultRuns).toBe(LAW_WIDE_PENALTY);
    const bare = openInnings(fold(T20, [["core.start"], delivery({ extras: { kind: "wide", runs: cricketPadRules.wideDefaultRuns } })]));
    expect(bare.runs).toBe(LAW_WIDE_PENALTY);
    expect(bare.legalBalls).toBe(0);
    expect(bare.fine.bowlerRuns[BOWLER]).toBe(LAW_WIDE_PENALTY);
    expect(bare.fine.striker, "the penalty run is never run").toBe(STRIKER);
    // The same net-off the fold applies to a wide and a no ball alike (22.6 and ICC 21.15: one penalty run each).
    for (const kind of ["wide", "noball"]) {
      const ranOne = openInnings(fold(T20, [["core.start"], delivery({ extras: { kind, runs: LAW_WIDE_PENALTY + 1 } })]));
      expect(ranOne.runs, kind).toBe(LAW_WIDE_PENALTY + 1);
      expect(ranOne.fine.striker, `${kind} + 1 run: the batters crossed once`).toBe(NON_STRIKER);
    }
  });

  it("CK-EX-2 noBallDefaultRuns: a bare no ball scores its one-run penalty (ICC 21.15, MCC Law 21.14), no ball faced, no crossing, and arms the free hit", () => {
    expect(cricketPadRules.noBallDefaultRuns).toBe(LAW_NO_BALL_PENALTY);
    const bare = openInnings(fold(T20, [["core.start"], delivery({ extras: { kind: "noball", runs: cricketPadRules.noBallDefaultRuns } })]));
    expect(bare.runs).toBe(LAW_NO_BALL_PENALTY);
    expect(bare.legalBalls).toBe(0);
    expect(bare.fine.striker, "the penalty run is never run").toBe(STRIKER);
    expect(bare.fine.freeHitPending).toBe(true);
  });

  it("CK-BD-1 boundaryValues: the two the ball schema takes (Law 19: 4 and 6); the fold refuses any other", () => {
    expect(cricketPadRules.boundaryValues).toEqual(CricketBall.shape.boundary.unwrap().options.map((o) => o.value));
    expect(sorted(cricketPadRules.boundaryValues)).toEqual([4, 6]);
    let checked = 0;
    for (const value of [3, 4, 5, 6, 7]) {
      const spec: Spec = ["cricket.ball", { ...(delivery({ bat: value })[1] as object), boundary: value }];
      const refusal = refusalOf(() => fold(T20, [["core.start"], spec]));
      expect(refusal === null, `boundary ${value}`).toBe(cricketPadRules.boundaryValues.includes(value));
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("CK-BO-2 cricketPadRules.ballsPerOver(cfg)", () => {
  it("is the cfg's own ballsPerOver, read through the schema, over every declared cfg and its raw variant; it equals the padSpec ballInOver max", () => {
    const seen = new Set<number>();
    let checked = 0;
    for (const { name, cfg } of declaredCfgs(cricket)) {
      expect(cricketPadRules.ballsPerOver(cfg), name).toBe(cfg.ballsPerOver);
      expect(padNumberBound(padSpec(cfg), "cricket.ball", "ballInOver").max, name).toBe(cricketPadRules.ballsPerOver(cfg));
      seen.add(cfg.ballsPerOver);
      checked++;
    }
    for (const [name, raw] of Object.entries(cricket.variants)) {
      expect(cricketPadRules.ballsPerOver(raw), `${name} (raw)`).toBe(parse(raw).ballsPerOver);
      checked++;
    }
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/cricket] ballsPerOver: ${checked} cfgs, values ${[...seen].join("/")}`);
    expect(seen.size, "the sweep must cross a cfg whose over differs (the hundred's 5)").toBeGreaterThanOrEqual(2);
  });

  it("an absent key, an empty cfg and no cfg read the schema default; an invalid one is refused, never a fallback", () => {
    const schemaDefault = parse({}).ballsPerOver;
    expect(cricketPadRules.ballsPerOver({})).toBe(schemaDefault);
    expect(cricketPadRules.ballsPerOver(null)).toBe(schemaDefault);
    expect(cricketPadRules.ballsPerOver(undefined)).toBe(schemaDefault);
    expect(cricketPadRules.ballsPerOver({ inningsPerSide: 2 })).toBe(schemaDefault);
    for (const bad of [0, -1, 2.5, "6"]) expect(() => cricketPadRules.ballsPerOver({ ballsPerOver: bad }), String(bad)).toThrow();
  });
});

describe("CK-SO-3 CK-DV-2 cricketPadRules.superOverEventTypes against a real super over", () => {
  /** A tied one-over-a-side match with the super over on: the shortest legal route to phase "super_over", folded. */
  const SO_CFG = parse({ superOver: true, ballsPerInnings: 6, ballsPerOver: 6, minOversForResult: 1 });
  const side = (striker: string, nonStriker: string, bowler: string): Spec[] =>
    [1, 2, 3, 4, 5, 6].map((n) => ["cricket.ball", { over: 0, ballInOver: n, striker, nonStriker, bowler, runs: { bat: 0 } }]);
  const TIED: readonly Spec[] = [["core.start"], ...side("H-p1", "H-p2", "A-p11"), ...side("A-p1", "A-p2", "H-p11")];

  it("the fold accepts exactly these cricket.* types in phase super_over (each folded outright), and refuses every other on its phase (WRONG_PHASE)", () => {
    expect(fold(SO_CFG, TIED).phase, "premise: the tie sends the fold to the super over").toBe("super_over");
    const lineups = lineupsFor(SO_CFG);
    const ball = { over: 0, ballInOver: 1, striker: "A-p1", nonStriker: "A-p2", bowler: "H-p10", runs: { bat: 0 } };
    /** One payload per type, each valid against its own schema (checked below), so a refusal is the phase's, not the parse's. */
    const VALID: Readonly<Record<string, unknown>> = {
      "cricket.ball": ball,
      "cricket.superover.ball": ball,
      "cricket.innings.summary": { runs: 0, wickets: 0, legalBalls: 0 },
      "cricket.toss": { wonBy: lineups.home.entrantId, elected: "bat" },
      "cricket.innings.declare": {},
      "cricket.innings.close": { reason: "other" },
      "cricket.match.close": {},
      "cricket.interruption": { kind: "rain" },
      "cricket.revise": { target: 10 },
      "cricket.followon": {},
      "cricket.newball": {},
      "cricket.powerplay": { kind: "batting", phase: "start" },
      "cricket.review": { by: lineups.away.entrantId, kind: "player", outcome: "upheld" },
      "cricket.retire": { person: "A-p1", reason: "hurt" },
      // H-p1 faced all six of the first innings' balls: a line the innings totals agree with, so the fold takes it.
      "cricket.player.line": { innings: 1, person: "H-p1", batting: { runs: 0, balls: 6 } },
    };
    const types = Object.keys(cricket.eventSchemas ?? {}).filter((t) => t.startsWith("cricket."));
    expect(sorted(Object.keys(VALID))).toEqual(sorted(types));
    let accepted = 0;
    let refused = 0;
    for (const type of types) {
      expect(cricket.eventSchemas?.[type]?.safeParse(VALID[type]).success, `${type}: the payload is schema-valid`).toBe(true);
      const refusal = refusalOf(() => fold(SO_CFG, [...TIED, [type, VALID[type]]]));
      if (cricketPadRules.superOverEventTypes.includes(type)) {
        expect(refusal, `${type} in a super over: accepted outright`).toBeNull();
        accepted++;
      } else {
        expect(refusal ?? "accepted", `${type} in a super over`).toMatch(/^WRONG_PHASE/);
        refused++;
      }
    }
    // The super-over ball is accepted outright, not merely past the phase check.
    expect(refusalOf(() => fold(SO_CFG, [...TIED, ["cricket.superover.ball", ball]]))).toBeNull();
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`[pad/cricket] super over: ${types.length} types folded, ${accepted} accepted, ${refused} refused`);
    expect(accepted + refused).toBe(15);
    expect(accepted).toBe(2);
  });
});
