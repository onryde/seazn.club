// cricket — one coarse summary per innings (cricket.ts:231-238, applySummary
// :1644); HOME bats first without a toss (battingFirst "home", :3626). A
// non-partial summary closes its innings; the chase closes on the target
// passed. Wickets never exceed the engine's all-out, which follows
// playersPerSide (allOutWickets, :625-629, refused under a strict fold at
// :1682), and legal balls never exceed the innings quota, which follows
// ballsPerInnings (refused under a strict fold at :1686); a winning chase
// keeps a wicket in hand. Two innings a side (the `test` preset and every
// committed case on it) is built too since ruling 44: a follow-on where the
// cfg allows it, a draw on time (cricket.match.close), and a level tie.
//
// W2e Task 21 (G4, G5): a win down a DECIDING PATH.
//  - `superOver` (knockout, cfg.superOver): the main match ends level (a tie), and the engine opens a super over
//    (decideTie): a pair of one-over innings, the side that batted second in the match batting first, the sides alternating
//    pair to pair (the engine's own `soBattingSideAt`). What a LEVEL pair does is the cfg's `superOverStillTied`: `repeat`
//    plays another pair, `boundary_count` decides on the boundaries (ball-by-ball ones only: the generated summaries name
//    none), `shared` stands level. So the stream for a win is policy-shaped: repeat = a level pair then a decisive one,
//    boundary_count = one level pair with the winner's boundaries ahead, shared = one decisive pair. A `tie` request is
//    reachable where the engine can end the super over level (canEndLevel: shared, and boundary_count on level boundaries).
//    Every super-over ball NAMES PERSONS (striker, non-striker, bowler) and the fold refuses a person outside the lineup,
//    so the stream is built, and folded, against the lineups the harness PUT (`req.lineups`, `namesPersons`); without them
//    the request is refused by name. The balls are the skin's own run values (0 1 2 3 4 6), no extras, no wicket.
//  - `dls`: an interruption, then the umpires' revise (`cricket.revise`) shortening the chase to fewer overs between the
//    innings, with the target named (DLS off: the umpires' manual target, which the engine takes over its own) or left to the
//    engine (DLS on: the Standard Edition computation). The revised target is READ from the fold of that prefix, and the chase
//    kept inside CK-CH-1's bound (target - 1 + 7). It needs a single limited-overs innings (the engine's revise refusal).
// Both are read back from the PRODUCT's state by `pathWitness`; neither is a stage decider the outcome alone names.
import { decidedInFor } from "@seazn/engine/competition";
import type { PadSpec } from "@seazn/engine/sport";
import { dlsTarget, resourcesFromBalls, soBattingSideAt } from "@seazn/engine/sports/cricket";
import { foldStream } from "../fold.ts";
import { sportModule } from "../sport-cfg.ts";
import {
  GeneratorUnsupported, OutcomeUnreachable, START, evidenceState, outcomeLabel,
  type DecidedRequest, type DecidingPath, type Side, type SportStreamGenerator, type StreamEvent, type StreamLineups, type StreamRequest,
} from "./types.ts";

interface CricketCfg {
  inningsPerSide: number;
  ballsPerInnings: number | null;
  ballsPerOver: number;
  superOver?: boolean;
  superOverStillTied?: string;
  dls?: { enabled?: boolean };
  followOn?: { enabled?: boolean; lead?: number };
}

const SUMMARY = "cricket.innings.summary";
/** A fixed legal-ball count per innings where the cfg sets no over limit (the
 *  `test` preset's ballsPerInnings is null): 90 overs × 6. Any value the
 *  summary schema accepts serves; with no quota the fold never reads it as a
 *  limit. A cfg with a quota uses the quota instead (strict fold, :1686). */
export const TEST_BALLS = 540;
/** CricketMatchClose (cricket.ts:254): `z.strictObject({})` — time expiry ⇒ draw (:3736-3743). */
const MATCH_CLOSE_DRAW = Object.freeze({});
/** CricketFollowOn (cricket.ts:267): `z.strictObject({})` — enforced between the 2nd and 3rd innings on a lead ≥ followOn.lead (:3755-3770). */
const FOLLOW_ON_PAYLOAD = Object.freeze({});
/** The first-innings lead the follow-on shape builds (500 − 200). */
const FOLLOW_ON_LEAD = 300;

/** The engine's own declaration refused: its padSpec carries no usable wicket
 *  ceiling for an innings total, so there is no all-out to clamp to. */
export class AllOutUndeclared extends Error {
  constructor(why: string) {
    super(`streams: cricket padSpec declares no all-out for '${SUMMARY}' — ${why}`);
    this.name = "AllOutUndeclared";
  }
}

/** All-out as the engine declares it: the `wickets` ceiling of the innings
 *  summary action (cricket.ts padSpec, max = playersPerSide − 1, :3097) — the
 *  same threshold allOutWickets enforces for the harness's empty lineups. A
 *  winning chase needs a wicket in hand, so a ceiling below 1 is refused. */
export function declaredAllOut(spec: PadSpec | undefined): number {
  const action = spec?.panels.flatMap((p) => p.actions).find((a) => a.type === SUMMARY);
  if (action === undefined) throw new AllOutUndeclared("no such action");
  const field = action.fields.find((f) => f.path === "wickets");
  if (field?.kind !== "number") throw new AllOutUndeclared("no numeric 'wickets' field");
  if (!Number.isInteger(field.max) || field.max < 1) throw new AllOutUndeclared(`wickets max is ${field.max}`);
  return field.max;
}

const allOutOf = (req: StreamRequest): number => declaredAllOut(sportModule(req.sportKey).padSpec?.(req.cfg));

/** Two innings a side. HOME bats 1st and 3rd, AWAY 2nd and 4th (no toss);
 *  after a follow-on AWAY bats 2nd and 3rd. A non-partial summary closes its
 *  innings whatever its wickets (:1704); the draw's last innings is partial,
 *  so it keeps a wicket and a ball in hand or autoClose ends it (:1023-1038)
 *  and the match is decided before time runs out. */
function twoInnings(req: DecidedRequest, cfg: CricketCfg, allOut: number): StreamEvent[] {
  const balls = cfg.ballsPerInnings ?? TEST_BALLS;
  const open = (n: number): number => Math.min(n, allOut - 1);
  const s = (runs: number, wickets: number, extra: Record<string, unknown> = {}): StreamEvent => ({ type: SUMMARY, payload: { runs, wickets, legalBalls: balls, ...extra } });
  const out = (runs: number): StreamEvent => s(runs, Math.min(10, allOut));
  if (req.outcome.kind === "draw") {
    // Home 300 + 200d, away 250 + 100/3 chasing 251 when time runs out.
    return [START, out(300), out(250), s(200, open(5), { declared: true }), s(100, open(3), { partial: true, legalBalls: Math.min(120, balls - 1) }), { type: "cricket.match.close", payload: MATCH_CLOSE_DRAW }];
  }
  if (req.outcome.winner === "home") {
    const lead = cfg.followOn?.lead ?? Number.POSITIVE_INFINITY;
    return cfg.followOn?.enabled === true && FOLLOW_ON_LEAD >= lead
      ? [START, out(500), out(200), { type: "cricket.followon", payload: FOLLOW_ON_PAYLOAD }, out(150)] // away 350 v 500: an innings and 150
      : [START, out(300), out(250), out(200), out(200)]; // home 500 v away 450: by 50 runs
  }
  return [START, out(250), out(300), out(200), s(151, open(3))]; // target 151: away by wickets
}


/** The fields of cricket's state `pathWitness` reads (CricketState, cricket.ts; the product serves it as jsonb). */
interface WitnessState {
  phase?: string;
  margin?: { kind?: string } | null;
  superOver?: { innings?: { closed?: boolean }[] } | null;
  targetSource?: string | null;
  revisedTarget?: number | null;
}

const SUPER_OVER_BALL = "cricket.superover.ball";
const INTERRUPTION = "cricket.interruption";
const REVISE = "cricket.revise";

/** The level main match: one innings a side, level on runs after the full quota (the engine's decideTie fires on it). */
function levelMain(req: StreamRequest): StreamEvent[] {
  const cfg = req.cfg as CricketCfg;
  const allOut = allOutOf(req);
  if (cfg.inningsPerSide === 2) {
    const balls = cfg.ballsPerInnings ?? TEST_BALLS;
    const out = (runs: number): StreamEvent => ({ type: SUMMARY, payload: { runs, wickets: Math.min(10, allOut), legalBalls: balls } });
    return [START, out(250), out(200), out(200), out(250)]; // 450 v 450 after four innings
  }
  if (cfg.inningsPerSide !== 1) throw new GeneratorUnsupported(req.sportKey, "tie", `inningsPerSide ${String(cfg.inningsPerSide)}`);
  const B = cfg.ballsPerInnings as number;
  const w = Math.min(5, allOut);
  return [START, { type: SUMMARY, payload: { runs: 150, wickets: w, legalBalls: B } }, { type: SUMMARY, payload: { runs: 150, wickets: w, legalBalls: B } }];
}

/** One pair of super-over innings, ball by ball: the bat runs of each legal ball, in order (the rest of the over is dot
 *  balls). The second innings is a chase of the first's total + 1: it ends at the ball that passes the target. Every value
 *  is one the skin has a run tile for (0 1 2 3 4 6); a 4 and a 6 are boundaries. */
export interface SuperOverPair { readonly first: readonly number[]; readonly second: readonly number[] }

const ones = (b: number): number[] => Array.from({ length: b }, () => 1);
const twos = (b: number): number[] => Array.from({ length: b }, () => 2);
/** The named pairs a super-over stream is built from, each a function of the cfg's balls per over (the Hundred's set is five). */
export const SO_PAIRS = Object.freeze({
  /** The first side to bat scores a run a ball, the second none: the first side wins by runs. */
  firstWins: (b: number): SuperOverPair => ({ first: ones(b), second: [] }),
  /** The second side chases the first's total + 1 with twos and passes it: the second side wins. */
  secondWins: (b: number): SuperOverPair => ({ first: ones(b), second: twos(b) }),
  /** Level on runs (a run a ball each), no boundary on either side. */
  level: (b: number): SuperOverPair => ({ first: ones(b), second: ones(b) }),
  /** Level on runs (8 each), two boundaries for the FIRST side to bat and none for the second. */
  levelFirstMore: (): SuperOverPair => ({ first: [4, 4], second: [2, 2, 2, 2] }),
  /** Level on runs (8 each), none for the first side and two boundaries for the SECOND. */
  levelSecondMore: (): SuperOverPair => ({ first: [2, 2, 2, 2], second: [4, 4] }),
  /** Level on runs (8 each) and on boundaries (two each). */
  levelEqualBoundaries: (): SuperOverPair => ({ first: [4, 4], second: [4, 4] }),
});

/** A name for the lineups a super over cannot be built without. */
function requireLineups(req: StreamRequest, label: string): StreamLineups {
  const l = req.lineups;
  if (l === undefined) throw new OutcomeUnreachable(req.sportKey, label, "a super over is played ball by ball, naming the striker, the non-striker and the bowler, and the fold refuses a person outside the lineup: the request carries no lineups");
  if (l.home.length < 2 || l.away.length < 2) throw new OutcomeUnreachable(req.sportKey, label, `a super over needs two batters and a bowler a side: the lineups hold ${l.home.length} and ${l.away.length}`);
  return l;
}

/** One super-over innings' balls. `runs` is padded with dot balls to the cfg's over; a chase stops at the ball that passes
 *  `target`. The batters are the batting side's first two named, the bowler a member of the fielding side's order. */
function soInnings(k: number, runs: readonly number[], bpo: number, lineups: StreamLineups, target: number | null): StreamEvent[] {
  const bat: Side = soBattingSideAt({ battingFirst: "home" }, k);
  const field: Side = bat === "home" ? "away" : "home";
  const order = lineups[bat];
  const bowling = lineups[field];
  const out: StreamEvent[] = [];
  let total = 0;
  for (let i = 0; i < bpo; i++) {
    const r = runs[i] ?? 0;
    total += r;
    out.push({
      type: SUPER_OVER_BALL,
      payload: {
        over: 0, ballInOver: i + 1,
        striker: order[0], nonStriker: order[1], bowler: bowling[(k >> 1) % bowling.length],
        runs: { bat: r },
        ...(r === 4 || r === 6 ? { boundary: r } : {}),
      },
    });
    if (target !== null && total >= target) break;
  }
  return out;
}

/** The tied main match, then `pairs` of super-over innings. Exported: the G4 sweep builds each still-tied case directly. */
export function superOverStream(req: StreamRequest, pairs: readonly SuperOverPair[]): StreamEvent[] {
  const cfg = req.cfg as CricketCfg;
  const label = outcomeLabel(req.outcome);
  if (cfg.superOver !== true) throw new OutcomeUnreachable(req.sportKey, label, "the cfg does not switch the super over on (superOver)");
  const lineups = requireLineups(req, label);
  const bpo = cfg.ballsPerOver;
  const balls = pairs.flatMap((pair, p) => {
    const first = pair.first.reduce((a, b) => a + b, 0);
    return [...soInnings(2 * p, pair.first, bpo, lineups, null), ...soInnings(2 * p + 1, pair.second, bpo, lineups, first + 1)];
  });
  return [...levelMain(req), ...balls];
}

/** A win down the super over, shaped by the cfg's still-tied policy (see the header). The winner is the side the request names. */
function superOverWin(req: DecidedRequest & { outcome: { kind: "win" } }, cfg: CricketCfg): StreamEvent[] {
  const b = cfg.ballsPerOver;
  const winner = req.outcome.winner;
  const firstOf = (pair: number): Side => soBattingSideAt({ battingFirst: "home" }, 2 * pair);
  const decisive = (pair: number): SuperOverPair => (winner === firstOf(pair) ? SO_PAIRS.firstWins(b) : SO_PAIRS.secondWins(b));
  switch (cfg.superOverStillTied) {
    case "boundary_count": return superOverStream(req, [winner === firstOf(0) ? SO_PAIRS.levelFirstMore() : SO_PAIRS.levelSecondMore()]);
    case "shared": return superOverStream(req, [decisive(0)]);
    // repeat (the default): a level pair opens another, and the second decides.
    default: return superOverStream(req, [SO_PAIRS.level(b), decisive(1)]);
  }
}

/** A win by DLS: the first innings in full, an interruption, the revise to fewer overs (with or without the target named),
 *  and a chase that falls short of, or reaches, the REVISED target read from the engine's fold of that prefix. */
function dlsWin(req: DecidedRequest & { outcome: { kind: "win" } }, cfg: CricketCfg): StreamEvent[] {
  const label = outcomeLabel(req.outcome);
  if (cfg.inningsPerSide !== 1 || cfg.ballsPerInnings === null) {
    throw new OutcomeUnreachable(req.sportKey, label, "revise applies to single-innings limited-overs matches only (the engine, applyRevise): this cfg has no single limited innings to revise");
  }
  const B = cfg.ballsPerInnings;
  const bpo = cfg.ballsPerOver;
  const overs = Math.floor(B / bpo);
  const lost = Math.max(1, Math.floor(overs / 4));
  const oversPerSide = overs - lost;
  if (oversPerSide < 1 || oversPerSide * bpo >= B) throw new OutcomeUnreachable(req.sportKey, label, `an innings of ${B} balls (${overs} overs of ${bpo}) cannot be shortened`);
  const allOut = allOutOf(req);
  const S1 = 180;
  const first: StreamEvent = { type: SUMMARY, payload: { runs: S1, wickets: Math.min(5, allOut), legalBalls: B } };
  const interruption: StreamEvent = { type: INTERRUPTION, payload: { kind: "rain", oversLostEstimate: lost } };
  // DLS off: the umpires confirm a target, and the engine takes it over its own; DLS on: the revise names the overs and the
  // engine computes (Standard Edition). The number the umpires confirm is the engine's own figure for the same shortening.
  const dlsOn = cfg.dls?.enabled === true;
  const manual = dlsTarget(S1, resourcesFromBalls(B, 0, allOut), resourcesFromBalls(oversPerSide * bpo, 0, allOut));
  const revise: StreamEvent = { type: REVISE, payload: dlsOn ? { oversPerSide } : { oversPerSide, target: manual } };
  const prefix = [START, first, interruption, revise];
  const target = (foldStream(sportModule(req.sportKey), cfg, req.home, req.away, prefix, req.lineups).state as { revisedTarget: number | null }).revisedTarget;
  if (target === null || target >= S1 + 1 || target < 3) throw new OutcomeUnreachable(req.sportKey, label, `the revise left the chase a target of ${String(target)} against the first innings' ${S1 + 1}: no revised target to win or lose by`);
  const quota = oversPerSide * bpo;
  const chase: StreamEvent = req.outcome.winner === "home"
    // The chase falls short: the full revised overs, a wicket count that leaves the innings closed by the summary.
    ? { type: SUMMARY, payload: { runs: Math.floor((target - 1) / 2), wickets: Math.min(7, allOut), legalBalls: quota } }
    // The chase reaches the revised target (CK-CH-1: no higher than target - 1 + 7) with wickets in hand, inside the quota.
    : { type: SUMMARY, payload: { runs: target, wickets: Math.min(3, allOut - 1), legalBalls: Math.min(quota, 60) } };
  return [...prefix, chase];
}

/** A win down a deciding path (the request names `path`). */
function decidedDownPath(req: DecidedRequest & { outcome: { kind: "win"; path: DecidingPath } }, cfg: CricketCfg): StreamEvent[] {
  const label = outcomeLabel(req.outcome);
  const path = req.outcome.path;
  if (path === "superOver") {
    if (cfg.superOver !== true) throw new OutcomeUnreachable(req.sportKey, label, "the cfg does not switch the super over on (superOver)");
    return superOverWin(req, cfg);
  }
  if (path === "dls") return dlsWin(req, cfg);
  throw new OutcomeUnreachable(req.sportKey, label, `cricket has no '${path}' deciding path (its deciders: superOver, dls)`);
}

export const cricketGenerator: SportStreamGenerator = {
  sportKeys: ["cricket"],
  decided(req) {
    const cfg = req.cfg as CricketCfg;
    if (req.outcome.kind === "win" && req.outcome.path !== undefined) return decidedDownPath(req as DecidedRequest & { outcome: { kind: "win"; path: DecidingPath } }, cfg);
    const allOut = allOutOf(req);
    if (cfg.inningsPerSide === 2) return twoInnings(req, cfg, allOut);
    // The schema allows 1 or 2 (cricket.ts:47); anything else is refused by name, never guessed.
    if (cfg.inningsPerSide !== 1) throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), `inningsPerSide ${String(cfg.inningsPerSide)}`);
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, "draw", "limited-overs cricket has no draw");
    const B = cfg.ballsPerInnings as number;
    const w = (n: number): number => Math.min(n, allOut);
    const summary = (runs: number, wickets: number, legalBalls: number) => ({ type: SUMMARY, payload: { runs, wickets, legalBalls } });
    return req.outcome.winner === "home"
      ? [START, summary(180, w(4), B), summary(150, w(5), B)]
      : [START, summary(150, w(5), B), summary(151, Math.min(3, allOut - 1), Math.min(B, 60))];
  },
  tied(req) {
    const cfg = req.cfg as CricketCfg;
    // decideTie (cricket.ts:935-946): with a super over on, level scores open one instead of standing. The match then ends
    // level only where the engine lets a super over end level (canEndLevel) - and a super over is played ball by ball,
    // naming persons, so the request needs the lineups too.
    if (cfg.superOver === true) {
      if (cfg.superOverStillTied === undefined || cfg.superOverStillTied === "repeat") {
        throw new OutcomeUnreachable(req.sportKey, "tie", "superOver is on: a level score opens a super over, and a level super over repeats until decided, so the match cannot end level");
      }
      return superOverStream(req, [cfg.superOverStillTied === "boundary_count" ? SO_PAIRS.levelEqualBoundaries() : SO_PAIRS.level(cfg.ballsPerOver)]);
    }
    return levelMain(req);
  },
  // W2e (Task 21): a super over names persons, so its streams are built and folded against the lineups (types.ts namesPersons).
  namesPersons: (cfg) => (cfg as CricketCfg).superOver === true,
  // W2e (Task 21, F8): what decided the fold, read from the PRODUCT's state when the fold carries it (`fold.product`), else
  // from the local strict fold's. A super over is state only (the outcome's method says `super_over` or `boundary_count`,
  // but only the state holds the innings played); a DLS win is decided in regulation, so only its method and the revised
  // target the state holds name it.
  pathWitness(path, fold) {
    const state = evidenceState(fold.evidence) as WitnessState | null;
    if (state === null || typeof state !== "object") return false;
    const method = (fold.outcome as { method?: unknown }).method;
    if (path === "superOver") {
      if (decidedInFor(sportModule(fold.sportKey), fold.outcome) !== "so") return false;
      const innings = state.superOver?.innings;
      // Done, whole pairs, every innings closed, and the margin the engine records is the one the outcome's method names.
      return state.phase === "done" && Array.isArray(innings) && innings.length >= 2 && innings.length % 2 === 0
        && innings.every((i) => i.closed === true) && state.margin?.kind === method;
    }
    if (path === "dls") return method === "dls" && (state.targetSource === "dls" || state.targetSource === "manual") && typeof state.revisedTarget === "number";
    return false;
  },
  // W2b (CK-WO-1, X-RT-1): HOME's innings closed, AWAY's chase under way — partial, a wicket and a ball in hand, short
  // of the target — so both sides have scored and nothing is decided.
  partial(req) {
    const cfg = req.cfg as CricketCfg;
    const allOut = allOutOf(req);
    const balls = cfg.ballsPerInnings ?? TEST_BALLS;
    return [
      { type: SUMMARY, payload: { runs: 120, wickets: Math.min(4, allOut), legalBalls: balls } },
      { type: SUMMARY, payload: { runs: 40, wickets: Math.min(1, allOut - 1), legalBalls: Math.min(30, balls - 1), partial: true } },
    ];
  },
};
