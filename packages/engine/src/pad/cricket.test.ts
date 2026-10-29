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
  FREE_HIT_DISMISSAL_KINDS,
  PENALTY_RUNS,
  VARIABLE_OUT_KINDS,
  WicketKind,
  WIDE_DEFAULT_RUNS,
  cricket,
  padSpec,
  type CricketCfg,
  type CricketState,
} from "../sports/cricket/cricket.ts";
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

  it("the fold's only `out` check is crease membership: it accepts the non-striker for EVERY mode, and refuses a batter not at the crease", () => {
    // This is what makes `variableOutKinds` a declaration (c) and not a mirror of a fold guard: cricket.ts's applyDelivery checks
    // `wicket.out` against the two batters at the crease and nothing else, so bowled-the-non-striker folds. Pinned here so a
    // drift test can never claim the fold enforces "who can be out" per mode.
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

  it("an obstructing-the-field wicket that names a fielder credits that fielder a run out (DOMAIN.md, Dismissals: 'credits the fielder a run out')", () => {
    const innings = openInnings(fold(T20, [["core.start"], delivery({ wicket: wicketOf("obstructed", NON_STRIKER, { fielder: FIELDER }) })]));
    expect(innings.fine.fielding?.[FIELDER]).toEqual({ catches: 0, runOuts: 1, stumpings: 0 });
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
/** MCC Law 38.1 "Either batter is out Run out"; Law 37.1.1 "Either batter is out Obstructing the field". Every other mode is the
 *  striker's (Laws 32-36, 39) or the incoming batter's (Law 40). */
const LAWS_EITHER_BATTER: readonly Mode[] = ["runout", "obstructed"];
/** DOMAIN.md, "Free hit armed and consumed": "only run-out/obstruction may dismiss on it" - CK-FH-1 as the engine holds it (ICC
 *  21.19.2 adds hit the ball twice; leaving it out is the row's recorded deviation, W2e ruling I-2). */
const RULEBOOK_FREE_HIT: readonly Mode[] = ["runout", "obstructed"];
/** MCC Law 41.2.1: "the award of 5 Penalty runs to the opposing team" - one award is five. */
const LAW_41_ONE_AWARD = 5;
/** MCC Law 37.5.1: "any one-run Penalty for No ball or Wide" - a bare wide records its one-run penalty and nothing else. */
const LAW_WIDE_PENALTY = 1;

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
    expect(cricketPadRules.penaltyRuns).toBe(PENALTY_RUNS);
    expect(cricketPadRules.wideDefaultRuns).toBe(WIDE_DEFAULT_RUNS);
    expect(Object.isFrozen(cricketPadRules)).toBe(true);
  });

  it("eventBands is the padSpec fidelity map, the same object for every declared cfg", () => {
    const cfgs = declaredCfgs(cricket);
    for (const { name, cfg } of cfgs) expect(padSpec(cfg).fidelity, name).toBe(cricketPadRules.eventBands);
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
  it("fielderCreditedKinds: naming a fielder credits them exactly for these modes, in the rulebook's column; obstructed is one (Q1)", () => {
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

  it("freeHitDismissalKinds: on a free hit the fold accepts exactly these modes and refuses the rest", () => {
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

  it("bowlerCreditedKinds: the fold requires bowlerCredited exactly for these modes, and they are the Laws' five", () => {
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

  it("variableOutKinds (Q1b): the Laws' either-batter modes, each of which the fold accepts with either batter out", () => {
    expect(sorted(cricketPadRules.variableOutKinds)).toEqual(sorted(LAWS_EITHER_BATTER));
    expect(cricketPadRules.variableOutKinds).toContain("obstructed");
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

  it("penaltyRuns: Law 41's one award; a penalty extra of it lands on the batting side, charged to no bowler, run by nobody", () => {
    expect(cricketPadRules.penaltyRuns).toBe(LAW_41_ONE_AWARD);
    const innings = openInnings(fold(T20, [["core.start"], delivery({ extras: { kind: "penalty", runs: cricketPadRules.penaltyRuns } })]));
    expect(innings.battingSide).toBe("home");
    expect(innings.runs).toBe(LAW_41_ONE_AWARD);
    expect(innings.fine.extras).toBe(LAW_41_ONE_AWARD);
    expect(innings.fine.bowlerRuns[BOWLER] ?? 0).toBe(0);
    expect(innings.fine.striker).toBe(STRIKER); // odd, and still nobody crossed
  });

  it("wideDefaultRuns: a bare wide scores its one-run penalty, no ball faced, no crossing; one run more and the batters have crossed", () => {
    expect(cricketPadRules.wideDefaultRuns).toBe(LAW_WIDE_PENALTY);
    const bare = openInnings(fold(T20, [["core.start"], delivery({ extras: { kind: "wide", runs: cricketPadRules.wideDefaultRuns } })]));
    expect(bare.runs).toBe(LAW_WIDE_PENALTY);
    expect(bare.legalBalls).toBe(0);
    expect(bare.fine.bowlerRuns[BOWLER]).toBe(LAW_WIDE_PENALTY);
    expect(bare.fine.striker, "the penalty run is never run").toBe(STRIKER);
    // The same net-off the fold applies to a wide and a no ball alike (Law 37.5.1's "one-run Penalty for No ball or Wide").
    for (const kind of ["wide", "noball"]) {
      const ranOne = openInnings(fold(T20, [["core.start"], delivery({ extras: { kind, runs: LAW_WIDE_PENALTY + 1 } })]));
      expect(ranOne.runs, kind).toBe(LAW_WIDE_PENALTY + 1);
      expect(ranOne.fine.striker, `${kind} + 1 run: the batters crossed once`).toBe(NON_STRIKER);
    }
  });

  it("boundaryValues: the two the ball schema takes (Law 19: 4 and 6); the fold refuses any other", () => {
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

describe("cricketPadRules.ballsPerOver(cfg)", () => {
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
