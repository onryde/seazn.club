// volleyball / badminton / tabletennis — the set-based kernel. Event type is
// `${key}.${coarseEventType}` (setbased/kernel.ts:1083, :1654; the sweep also
// checks it against the module's eventSchemas). Summaries are positional
// {home, away} and must be REACHABLE under the cfg: terminal, and one point
// earlier still live (reachableSetScore, setbased/kernel.ts:470-489, enforced
// under a strict fold at :728).
//
// W2e Task 22 (G6, G7) adds two deciding paths, both STATE ONLY - a set sport's win is method 'regulation', decided
// 'regulation' whichever way the sets went, so the outcome cannot name them and the witness reads the sets the fold holds
// (the PRODUCT's state when the fold carries it, Task 21):
//  - `decidingSet`: the sets level at majority-1 each, the last played to the deciding target (`finalSetTo`, kernel.ts
//    setTarget: the one set index bestOf-1) and won by the winner;
//  - `cap`: straight sets, every set the winner takes ended by the cap - cap : cap-1, a lead of one that no win-by rule
//    ends (kernel.ts setWinner: `hi >= cap` wins whatever the lead). Badminton's 30-29 under 3x21 and 21-20 under 3x15.
// What each cfg declares - `cap`, `setTo`, `winBy`, `finalSetTo` - is read from the cfg, never typed here.
import { decidedInFor } from "@seazn/engine/competition";
import { EngineError } from "@seazn/engine/core";
import { sportModule } from "../sport-cfg.ts";
import {
  GeneratorUnsupported, OutcomeUnreachable, START, evidenceState, outcomeLabel,
  type DecidedRequest, type DecidingPath, type PathFold, type Side, type SportStreamGenerator, type StreamEvent,
} from "./types.ts";

// setbased/badminton.ts:58, tabletennis.ts:59, volleyball.ts:99.
const COARSE: Readonly<Record<string, string>> = { badminton: "game.summary", tabletennis: "game.summary", volleyball: "set.summary" };

interface SetCfg { bestOf: number; setTo: number; finalSetTo: number; winBy: number; cap: number | null }

/** The deciding paths this kernel's sports have, in the order a request is checked: the vocabulary of every set sport, though
 *  a cfg switches each on (a cap is declared by badminton's variants and a volleyball match may set one; table tennis's rule
 *  keys bar it). */
const OWN_PATHS: readonly DecidingPath[] = Object.freeze(["decidingSet", "cap"]);

/** The cfg fields a witness holds the product's state to (the product's state carries the cfg it folded under). */
const CFG_FIELDS = ["bestOf", "setTo", "finalSetTo", "winBy", "cap"] as const;

/** A set (or tie-break race) the winner takes at exactly `target`, the loser
 *  far enough behind that no deuce/cap rule applies. The 0 floor binds when
 *  target < winBy + 3 and still leaves a lead of target ≥ winBy (21-0 at
 *  winBy 20). winBy > target is outside this helper's domain, as it is for the
 *  engine's own generateSetScore (setbased/kernel.ts:1478-1480): the score is
 *  not terminal and the strict fold refuses it loudly (INVALID_EVENT), never a
 *  silent wrong outcome. */
export function winningSetScore(target: number, winBy: number): { w: number; l: number } {
  return { w: target, l: Math.max(0, target - winBy - 3) };
}

/** A win down `path`, as the sport's set summaries, or OutcomeUnreachable (by name) for a path the sport or the cfg lacks. */
function pathStream(req: DecidedRequest, cfg: SetCfg, winner: Side, path: DecidingPath): StreamEvent[] {
  const label = outcomeLabel(req.outcome);
  const unreachable = (why: string): never => { throw new OutcomeUnreachable(req.sportKey, label, why); };
  if (!OWN_PATHS.includes(path)) unreachable(`${req.sportKey} has no '${path}' deciding path (its deciders: ${OWN_PATHS.join(", ")})`);
  const type = `${req.sportKey}.${COARSE[req.sportKey]}`;
  const loser: Side = winner === "home" ? "away" : "home";
  /** One set summary, `setWinner` taking it `w` to `l`. */
  const set = (setWinner: Side, w: number, l: number): StreamEvent =>
    ({ type, payload: setWinner === "home" ? { home: w, away: l } : { home: l, away: w } });
  const events: StreamEvent[] = [START];
  if (path === "decidingSet") {
    if (cfg.bestOf < 3) unreachable(`bestOf ${cfg.bestOf} has no deciding set: its only set is the match`);
    // bestOf-1 sets split evenly - the loser takes the first, the winner the second, and so on - then the winner takes the
    // deciding set, played to finalSetTo (setbased/kernel.ts setTarget: the last possible set index only).
    for (let i = 0; i < cfg.bestOf - 1; i++) {
      const { w, l } = winningSetScore(cfg.setTo, cfg.winBy);
      events.push(set(i % 2 === 0 ? loser : winner, w, l));
    }
    const { w, l } = winningSetScore(cfg.finalSetTo, cfg.winBy);
    events.push(set(winner, w, l));
    return events;
  }
  // cap
  if (cfg.cap === null) unreachable("the cfg declares no cap (cap is null), so no set ends at one");
  if (cfg.winBy < 2) unreachable(`winBy ${cfg.winBy}: a lead of one already wins a set, so the cap (${String(cfg.cap)}) never decides one`);
  for (let i = 0; i < Math.ceil(cfg.bestOf / 2); i++) events.push(set(winner, cfg.cap as number, (cfg.cap as number) - 1));
  return events;
}

/** The fields of the set kernel's state `pathWitness` reads (SetBasedState, kernel.ts; the product serves it as jsonb). */
interface WitnessState {
  cfg?: Partial<Record<(typeof CFG_FIELDS)[number], number | null>>;
  entrants?: { home?: string; away?: string };
  phase?: string;
  sets?: { home?: number; away?: number; closed?: boolean }[];
  outcome?: { kind?: string; winner?: string } | null;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const setbasedGenerator: SportStreamGenerator = {
  sportKeys: ["badminton", "tabletennis", "volleyball"],
  decided(req) {
    if (req.outcome.kind === "draw") {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "odd best-of: no draw exists");
    }
    const cfg = req.cfg as SetCfg;
    const homeWins = req.outcome.winner === "home";
    if (req.outcome.path !== undefined) return pathStream(req, cfg, req.outcome.winner, req.outcome.path);
    const events: StreamEvent[] = [START];
    // Straight sets: the winner takes the first ⌈bestOf/2⌉. The final-set
    // target applies only when that run reaches set index bestOf-1 (bestOf 1).
    for (let i = 0; i < Math.ceil(cfg.bestOf / 2); i++) {
      const target = i === cfg.bestOf - 1 ? cfg.finalSetTo : cfg.setTo;
      const { w, l } = winningSetScore(target, cfg.winBy);
      events.push({ type: `${req.sportKey}.${COARSE[req.sportKey]}`, payload: { home: homeWins ? w : l, away: homeWins ? l : w } });
    }
    return events;
  },
  // W2e Task 22 (F8): the path is the sets the fold holds, which the OUTCOME cannot say (a set sport's win is 'regulation'
  // however its sets went). The evidence is the PRODUCT's own state and summary when the fold carries them - the scenario
  // check refuses a drive that recorded none, so a green truth run is never witnessed on the local fold alone - and the local
  // strict fold's only for the generator's own request match (`product: null`), which asks whether the stream it built
  // reaches the path. A state the product folded under another cfg than the one asked, whose summary disagrees with its
  // state, or whose own outcome names another winner, is no evidence.
  pathWitness(path, fold: PathFold) {
    if (!OWN_PATHS.includes(path)) return false;
    const product = fold.evidence.source === "product" ? fold.evidence.product : null;
    if (product !== null && !isRecord(product.summary)) return false;
    const raw = evidenceState(fold.evidence);
    if (!isRecord(raw)) return false;
    const st = raw as WitnessState;
    const cfg = fold.cfg as SetCfg;
    // A set sport's outcome is a regulation win whichever path (decidedIn from the engine's own win-method table); one that
    // claims otherwise is not the sport's. A method the module does not declare is no regulation win either - never a throw.
    try {
      if (decidedInFor(sportModule(fold.sportKey), fold.outcome) !== "regulation") return false;
    } catch (e) {
      if (EngineError.is(e)) return false;
      throw e;
    }
    const winner = (fold.outcome as { winner?: unknown }).winner;
    if (st.phase !== "done" || st.outcome?.kind !== "win" || st.outcome.winner !== winner) return false;
    if (!isRecord(st.cfg) || CFG_FIELDS.some((k) => st.cfg![k] !== cfg[k])) return false;
    const sets = st.sets;
    if (!Array.isArray(sets) || sets.length === 0 || !sets.every((s) => s.closed === true && Number.isInteger(s.home) && Number.isInteger(s.away))) return false;
    // The product's summary carries the same set strip as its state (kernel summary(): detail.sets).
    if (product !== null) {
      const strip = (product.summary as { detail?: { sets?: unknown } }).detail?.sets;
      if (!Array.isArray(strip) || strip.length !== sets.length || strip.some((s, i) => !isRecord(s) || s.home !== sets[i].home || s.away !== sets[i].away || s.closed !== sets[i].closed)) return false;
    }
    const side: Side | null = st.entrants?.home === winner ? "home" : st.entrants?.away === winner ? "away" : null;
    if (side === null) return false;
    const other: Side = side === "home" ? "away" : "home";
    const last = sets[sets.length - 1];
    if ((last[side] as number) <= (last[other] as number)) return false; // the match-winning set is the winner's
    const won = (s: Side, t: Side) => sets.filter((x) => (x[s] as number) > (x[t] as number)).length;
    if (path === "decidingSet") {
      // Every set of the best of N was played (a level split at majority-1 each, then the last), the winner took the majority.
      const m = Math.ceil(cfg.bestOf / 2);
      return cfg.bestOf >= 3 && sets.length === cfg.bestOf && won(side, other) === m && won(other, side) === m - 1;
    }
    // cap: the set that ended the match ended at the cap - the winner's score IS the cap and the lead is shorter than a win-by
    // rule would end it on (only the cap ends a set that way).
    return cfg.cap !== null && (last[side] as number) === cfg.cap && (last[side] as number) - (last[other] as number) < cfg.winBy;
  },
  // W2b (VB-RT-1, TT-RT-1, BD-RT-1): a rally to each side — `${key}.rally {wonBy}`, the kernel's own point event.
  partial(req) {
    return [
      { type: `${req.sportKey}.rally`, payload: { wonBy: req.home } },
      { type: `${req.sportKey}.rally`, payload: { wonBy: req.away } },
    ];
  },
};
