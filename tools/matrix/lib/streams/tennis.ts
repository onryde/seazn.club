// tennis — nested kernel; `tennis.set_summary {home, away}` (nested/kernel.ts:240).
// A plain games score must be terminal and one game earlier still live
// (nested/kernel.ts:1350-1366, strict only), so 6-5 is refused.
//
// W2e Task 23 (G8) adds two deciding paths, both STATE ONLY - a tennis win is method 'regulation', decided 'regulation'
// however its sets ended, so the outcome cannot name them and the witness reads the closed sets the fold holds (the PRODUCT's
// state when the fold carries it, Task 21). Both are "the match was decided by a set a TIE-BREAK closed", told apart by the
// margin the tie-break was played under - the engine's own distinction (nested/kernel.ts `rulesFor`, W2e RB2A-12):
//  - `tiebreakSet`: the last set was closed by a set tie-break at the MATCH margin (`tiebreak.winBy`): `tiebreakAt+1 :
//    tiebreakAt` with its `tb` block, or - where the cfg's deciding set is one - the match tie-break (App VI, `finalSet.
//    matchTiebreakTo`, points in home/away) or the slam's final-set tie-break (`finalSet.tiebreakTo`, still the match margin:
//    a short set's own margin is NOT carried into the deciding set, Task 13);
//  - `shortSetTb`: the last set was closed by the SHORT-SET tie-break (App VI section 2: first to 5 with a deciding point at
//    4-all), i.e. a tie-break whose margin is the SET's own `set.tiebreakWinBy` - the field the engine declares for exactly that
//    rule and for no other.
// Tie-breaks are played to their CLOSEST finish (target : target - margin: 7-5, 5-4, 10-8), so the margin the set was played
// under is what a stream is wrong about when it is wrong. Everything - the trigger, the target, the margin, the deciding set -
// is read from the cfg's declarations, never typed here.
import { decidedInFor } from "@seazn/engine/competition";
import { EngineError } from "@seazn/engine/core";
import { sportModule } from "../sport-cfg.ts";
import { winningSetScore } from "./setbased.ts";
import {
  GeneratorUnsupported, OutcomeUnreachable, START, evidenceState, outcomeLabel,
  type DecidedRequest, type DecidingPath, type PathFold, type Side, type SportStreamGenerator, type StreamEvent,
} from "./types.ts";

type FinalSet = "same" | { matchTiebreakTo: number } | { tiebreakTo: number };
interface TennisCfg {
  bestOf: number;
  set: { gamesTo: number; winBy: number; tiebreakAt: number | null; tiebreakTo: number; tiebreakWinBy?: number };
  finalSet: FinalSet;
  tiebreak: { winBy: number };
}

const SET_SUMMARY = "tennis.set_summary";

/** The deciding paths tennis has, in the order a request is checked. */
const OWN_PATHS: readonly DecidingPath[] = Object.freeze(["tiebreakSet", "shortSetTb"]);

const matchTbOf = (f: FinalSet): number | null => (typeof f === "object" && "matchTiebreakTo" in f ? f.matchTiebreakTo : null);
const finalTbOf = (f: FinalSet): number | null => (typeof f === "object" && "tiebreakTo" in f ? f.tiebreakTo : null);

/** What closes a set played at a position (`deciding`: the sets are level at majority-1 each, or it is the only set):
 *  `games` (no tie-break: an advantage set), the set `tiebreak` (match margin), the `shortTiebreak` (the set's own margin), or
 *  the `matchTiebreak` standing in for the deciding set. The kernel's `rulesFor` (nested/kernel.ts), as a classification. */
type SetEnd = "games" | "tiebreak" | "shortTiebreak" | "matchTiebreak";
function setEnd(cfg: TennisCfg, deciding: boolean): SetEnd {
  if (deciding && matchTbOf(cfg.finalSet) !== null) return "matchTiebreak";
  if (cfg.set.tiebreakAt === null) return "games";
  if (deciding && finalTbOf(cfg.finalSet) !== null) return "tiebreak"; // a final-set tie-break keeps the MATCH margin
  return cfg.set.tiebreakWinBy !== undefined ? "shortTiebreak" : "tiebreak";
}

/** The target and the win-by margin the tie-break (or match tie-break) of a set at this position is played to. */
function tbRules(cfg: TennisCfg, deciding: boolean): { to: number; winBy: number } {
  const mtb = matchTbOf(cfg.finalSet);
  if (deciding && mtb !== null) return { to: mtb, winBy: cfg.tiebreak.winBy };
  const fin = finalTbOf(cfg.finalSet);
  if (deciding && fin !== null) return { to: fin, winBy: cfg.tiebreak.winBy };
  return { to: cfg.set.tiebreakTo, winBy: cfg.set.tiebreakWinBy ?? cfg.tiebreak.winBy };
}

/** What each path needs the last set to have been closed by. */
const ENDS_OF: Readonly<Record<string, readonly SetEnd[]>> = Object.freeze({
  tiebreakSet: Object.freeze(["tiebreak", "matchTiebreak"] as const),
  shortSetTb: Object.freeze(["shortTiebreak"] as const),
});

const majorityOf = (bestOf: number): number => Math.ceil(bestOf / 2);

/** A win down `path`, as tennis set summaries, or OutcomeUnreachable (by name) for a path tennis or the cfg lacks. */
function pathStream(req: DecidedRequest, cfg: TennisCfg, winner: Side, path: DecidingPath): StreamEvent[] {
  const label = outcomeLabel(req.outcome);
  const unreachable = (why: string): never => { throw new OutcomeUnreachable(req.sportKey, label, why); };
  if (!OWN_PATHS.includes(path)) unreachable(`${req.sportKey} has no '${path}' deciding path (its deciders: ${OWN_PATHS.join(", ")})`);
  // TN-CF-1 (RB2A-13): ITF App VI's match tie-break REPLACES the deciding set, and a best of one is its own deciding set, so the
  // write door refuses the pair; no stream is built from a cfg the product would not store.
  if (cfg.bestOf === 1 && matchTbOf(cfg.finalSet) !== null) {
    unreachable("TN-CF-1: a best of 1 with a match tie-break is refused when a config is written (RB2A-13), so no stream is built from one");
  }
  const loser: Side = winner === "home" ? "away" : "home";
  const side = (s: Side, w: number, l: number): { home: number; away: number } => (s === "home" ? { home: w, away: l } : { home: l, away: w });
  const set = (payload: object): StreamEvent => ({ type: SET_SUMMARY, payload });
  /** A set the loser takes: plain games (never a tie-break), as the plain win's. */
  const plain = (s: Side): StreamEvent => {
    const w = cfg.set.gamesTo;
    return set(side(s, w, Math.max(0, w - cfg.set.winBy - 1)));
  };
  /** A set the winner takes at a position, closed the way the cfg closes it there: in a tie-break at its closest finish. */
  const closedSet = (deciding: boolean): StreamEvent => {
    const end = setEnd(cfg, deciding);
    if (end === "games") return plain(winner);
    const { to, winBy } = tbRules(cfg, deciding);
    const tbLost = Math.max(0, to - winBy);
    if (end === "matchTiebreak") return set(side(winner, to, tbLost)); // the match tie-break's POINTS ride in home/away
    const at = cfg.set.tiebreakAt as number;
    return set({ ...side(winner, at + 1, at), tb: side(winner, to, tbLost) });
  };
  const wanted = ENDS_OF[path];
  // The deciding set is PLAYED (the sets level, the winner takes the last) where its rules differ from an ordinary set's - the
  // cfg's `finalSet` - so the final-set tie-break and the match tie-break are what the stream exercises; elsewhere straight sets.
  const plans: readonly ("distance" | "straight")[] = cfg.finalSet !== "same" && cfg.bestOf >= 3 ? ["distance", "straight"] : ["straight"];
  for (const plan of plans) {
    // A best of one is its own deciding set; straight sets in a longer match end before the loser has a set.
    const lastDeciding = plan === "distance" || cfg.bestOf === 1;
    if (!wanted.includes(setEnd(cfg, lastDeciding))) continue;
    const events: StreamEvent[] = [START];
    if (plan === "straight") {
      for (let i = 0; i < majorityOf(cfg.bestOf); i++) events.push(closedSet(i === cfg.bestOf - 1));
    } else {
      // bestOf-1 sets split evenly - the loser takes the first, the winner the second, ... - then the winner takes the deciding set.
      for (let i = 0; i < cfg.bestOf - 1; i++) events.push(i % 2 === 0 ? plain(loser) : closedSet(false));
      events.push(closedSet(true));
    }
    return events;
  }
  return unreachable(path === "tiebreakSet"
    ? "the cfg ends no set in a tie-break at the match margin (no tiebreakAt, or the set's own margin is the short-set tie-break) and plays no match tie-break or final-set tie-break as its deciding set"
    : "the cfg declares no short-set tie-break (set.tiebreakWinBy is absent, or the only set is a deciding set with its own tie-break)");
}

/** The fields of the nested kernel's state `pathWitness` reads (NestedState, kernel.ts; the product serves it as jsonb). */
interface WitnessState {
  cfg?: unknown;
  entrants?: { home?: string; away?: string };
  phase?: string;
  sets?: { home?: number; away?: number; tb?: { home?: number; away?: number }; mtb?: boolean }[];
  outcome?: { kind?: string; winner?: string } | null;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A value as canonical JSON: object keys sorted (the product's jsonb reorders them), undefined dropped. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isRecord(v)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** The cfg fields a witness holds the product's state to (the state carries the cfg it folded under). */
const cfgKey = (c: unknown): string => {
  const x = (isRecord(c) ? c : {}) as Partial<TennisCfg>;
  return canon({ bestOf: x.bestOf, set: x.set, finalSet: x.finalSet, tiebreakWinBy: x.tiebreak?.winBy });
};

export const tennisGenerator: SportStreamGenerator = {
  sportKeys: ["tennis"],
  decided(req) {
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "tennis has no draw");
    const cfg = req.cfg as TennisCfg;
    if (req.outcome.path !== undefined) return pathStream(req, cfg, req.outcome.winner, req.outcome.path);
    // 6-3, fast4 4-1: never a tie-break set. The 0 floor binds when
    // gamesTo ≤ winBy; at gamesTo = winBy the nil set (2-0) is terminal, and
    // gamesTo < winBy is outside the domain (not terminal: the strict fold
    // refuses it loudly, never a silent wrong outcome).
    const games = { w: cfg.set.gamesTo, l: Math.max(0, cfg.set.gamesTo - cfg.set.winBy - 1) };
    const homeWins = req.outcome.winner === "home";
    const events: StreamEvent[] = [START];
    for (let i = 0; i < Math.ceil(cfg.bestOf / 2); i++) {
      // Straight sets reach the deciding set only at bestOf 1 (rulesFor,
      // nested/kernel.ts:855-861). Under `matchTiebreakTo` that set IS a match
      // tie-break, and its summary carries tie-break POINTS (:1291-1303).
      const mtbTo = i === cfg.bestOf - 1 ? matchTbOf(cfg.finalSet) : null;
      const { w, l } = mtbTo === null ? games : winningSetScore(mtbTo, cfg.tiebreak.winBy);
      events.push({ type: SET_SUMMARY, payload: { home: homeWins ? w : l, away: homeWins ? l : w } });
    }
    return events;
  },
  // W2e Task 23 (F8): the path is the sets the fold holds and what closed the last one, which the OUTCOME cannot say (a tennis
  // win is 'regulation' however its sets ended). The evidence is the PRODUCT's own state and summary when the fold carries them
  // - the scenario check refuses a drive that recorded none, so a green truth run is never witnessed on the local fold alone -
  // and the local strict fold's only for the generator's own request match (`product: null`), which asks whether the stream it
  // built reaches the path. A state the product folded under another cfg than the one asked, whose summary disagrees with its
  // state, or whose own outcome names another winner, is no evidence.
  pathWitness(path, fold: PathFold) {
    if (!OWN_PATHS.includes(path)) return false;
    const product = fold.evidence.source === "product" ? fold.evidence.product : null;
    if (product !== null && !isRecord(product.summary)) return false;
    const raw = evidenceState(fold.evidence);
    if (!isRecord(raw)) return false;
    const st = raw as WitnessState;
    const cfg = fold.cfg as TennisCfg;
    // A tennis win is a regulation win whichever way its sets went (decidedIn from the engine's own win-method table); one that
    // claims otherwise is not the sport's. A method the module does not declare is no regulation win either - never a throw.
    try {
      if (decidedInFor(sportModule(fold.sportKey), fold.outcome) !== "regulation") return false;
    } catch (e) {
      if (EngineError.is(e)) return false;
      throw e;
    }
    const winner = (fold.outcome as { winner?: unknown }).winner;
    if ((st.phase !== "done" && st.phase !== "final") || st.outcome?.kind !== "win" || st.outcome.winner !== winner) return false;
    if (cfgKey(st.cfg) !== cfgKey(cfg)) return false;
    const sets = st.sets;
    if (!Array.isArray(sets) || sets.length === 0 || !sets.every((s) => Number.isInteger(s.home) && Number.isInteger(s.away))) return false;
    // The product's summary carries the same set strip as its state (kernel summary(): detail.sets, each closed set + `closed`).
    if (product !== null) {
      const strip = (product.summary as { detail?: { sets?: unknown } }).detail?.sets;
      if (!Array.isArray(strip) || strip.length !== sets.length || strip.some((s, i) => canon(s) !== canon({ ...sets[i], closed: true }))) return false;
    }
    const side: Side | null = st.entrants?.home === winner ? "home" : st.entrants?.away === winner ? "away" : null;
    if (side === null) return false;
    const other: Side = side === "home" ? "away" : "home";
    const last = sets[sets.length - 1];
    if ((last[side] as number) <= (last[other] as number)) return false; // the match-deciding set is the winner's
    const before = sets.slice(0, -1);
    const wins = (s: Side, t: Side) => before.filter((x) => (x[s] as number) > (x[t] as number)).length;
    const need = majorityOf(cfg.bestOf) - 1;
    const deciding = wins("home", "away") === need && wins("away", "home") === need;
    const end = setEnd(cfg, deciding);
    const { to, winBy } = tbRules(cfg, deciding);
    if (last.mtb === true) {
      // A match tie-break: only the deciding set of a cfg that plays one, its points in home/away, no tie-break block.
      if (end !== "matchTiebreak" || last.tb !== undefined) return false;
      return ENDS_OF[path].includes("matchTiebreak") && (last[side] as number) >= to && (last[side] as number) - (last[other] as number) >= winBy;
    }
    // A set a tie-break closed: the cfg's trigger (tiebreakAt+1 : tiebreakAt), the tie-break block the winner took at the set's
    // own target and margin. The class is the margin the cfg plays that position under.
    const tb = last.tb;
    const at = cfg.set.tiebreakAt;
    if (end === "games" || end === "matchTiebreak" || tb === undefined || at === null) return false;
    if ((last[side] as number) !== at + 1 || (last[other] as number) !== at) return false;
    if (!Number.isInteger(tb.home) || !Number.isInteger(tb.away)) return false;
    if ((tb[side] as number) <= (tb[other] as number) || (tb[side] as number) < to || (tb[side] as number) - (tb[other] as number) < winBy) return false;
    return ENDS_OF[path].includes(end);
  },
  // W2b (TN-RT-1): a point to each side — tennis.point {by}.
  partial(req) {
    return [
      { type: "tennis.point", payload: { by: req.home } },
      { type: "tennis.point", payload: { by: req.away } },
    ];
  },
};
