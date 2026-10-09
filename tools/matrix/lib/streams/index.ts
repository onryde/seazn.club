// One registry, one entry point. Forfeit and abandon are UNIVERSAL core events
// (core/forfeit-reason.test.ts pins forfeit for all 11 modules), so they are
// composed here; a sport generator builds a win or a draw (decided) and, where
// its engine can end level, a tie (tied).
import { forbidsLevelResult, isLevelOutcome, type MatchOutcome } from "@seazn/engine/core";
import { foldStream } from "../fold.ts";
import { drawsAllowed, sportModule } from "../sport-cfg.ts";
import { boardgameGenerator } from "./boardgame.ts";
import { carromGenerator } from "./carrom.ts";
import { cricketGenerator } from "./cricket.ts";
import { footballGenerator } from "./football.ts";
import { genericGenerator } from "./generic.ts";
import { periodGenerator } from "./period.ts";
import { setbasedGenerator } from "./setbased.ts";
import { tennisGenerator } from "./tennis.ts";
import {
  GeneratorUnsupported,
  OutcomeUnreachable,
  START,
  idOf,
  outcomeLabel,
  type DecidedRequest,
  type SportStreamGenerator,
  type StreamEvent,
  type StreamRequest,
} from "./types.ts";

/** Builds the registry. A sport key claimed twice throws: a silent overwrite
 *  would shadow a generator that Task 3's key-set check cannot see. The object
 *  has a null prototype, so `toString` and `constructor` are not generators. */
export function register(...gens: SportStreamGenerator[]): Readonly<Record<string, SportStreamGenerator>> {
  const out = Object.create(null) as Record<string, SportStreamGenerator>;
  for (const g of gens) {
    for (const k of g.sportKeys) {
      if (Object.hasOwn(out, k)) throw new Error(`streams: duplicate generator for sport '${k}'`);
      out[k] = g;
    }
  }
  return Object.freeze(out);
}

export const STREAM_GENERATORS = register(
  genericGenerator, setbasedGenerator, tennisGenerator, periodGenerator,
  footballGenerator, cricketGenerator, boardgameGenerator, carromGenerator,
);

const ABANDON: StreamEvent = Object.freeze({ type: "core.abandon", payload: { reason: "matrix: abandoned" } });

/** W2a: where the sport's own win stream DECIDES — the index of the first event after which the real engine
 *  reports an outcome. Found by folding prefixes (never assumed to be the last event), so an abandon cut here
 *  leaves the match undecided with whatever was on the board. */
function decidingIndex(req: StreamRequest, win: readonly StreamEvent[]): number {
  const module = sportModule(req.sportKey);
  for (let i = 1; i <= win.length; i++) {
    if (foldStream(module, req.cfg, req.home, req.away, win.slice(0, i)).outcome !== null) return i - 1;
  }
  throw new OutcomeUnreachable(req.sportKey, outcomeLabel(req.outcome), "the sport's own win stream never decides under this cfg, so there is no prefix to abandon");
}

/** The sport's win stream up to (not including) the event that decides it, then core.abandon: an abandon at a
 *  real score. A sport whose win is one event (generic.result, boardgame.result) has nothing to play first, so
 *  its prefix is [START] alone — the real score of such a match IS nothing. */
function abandonedAtScore(req: StreamRequest, gen: SportStreamGenerator): StreamEvent[] {
  const win = gen.decided({ ...req, outcome: { kind: "win", winner: "home" } });
  return [...win.slice(0, decidingIndex(req, win)), ABANDON];
}

/** X-ST-1 / ruling C12: a settle closes a LEVEL outcome, or an abandon that left no outcome. An abandon whose
 *  module outcome is a WIN (a cfg that awards the leader) is decided — settle does not apply. */
export function settleableOutcome(outcome: MatchOutcome | null): boolean {
  return outcome === null || isLevelOutcome(outcome);
}

/** W2a `level`: the sport's own level stream in a BRACKET stage, verified by folding it — a draw where the
 *  sport ends level as one, else a tie. A stream that does not fold to a level outcome under this cfg (a chess
 *  game that opens a tie-break, a football match that plays on to extra time) is not a level result there. */
function levelStream(req: StreamRequest, gen: SportStreamGenerator): StreamEvent[] {
  const label = outcomeLabel(req.outcome);
  if (!forbidsLevelResult(req.stageKind)) {
    throw new OutcomeUnreachable(req.sportKey, label, `'${req.stageKind}' is not a bracket kind: a level result there is a draw or a tie — request that`);
  }
  const refusal = gen.levelRefusal?.(req.cfg) ?? null;
  if (refusal !== null) throw new OutcomeUnreachable(req.sportKey, label, refusal);
  let events: StreamEvent[];
  if (drawsAllowed(req.sportKey, req.cfg, "league")) events = gen.decided({ ...req, outcome: { kind: "draw" } });
  else if (gen.tied !== undefined) events = gen.tied(req);
  else throw new OutcomeUnreachable(req.sportKey, label, "the sport's generator declares no level result");
  const folded = foldStream(sportModule(req.sportKey), req.cfg, req.home, req.away, events).outcome;
  if (folded === null || !isLevelOutcome(folded)) {
    throw new OutcomeUnreachable(req.sportKey, label, `the sport's level stream folds to ${folded === null ? "no outcome yet (a decider is pending)" : `'${folded.kind}'`} under this cfg`);
  }
  return events;
}

export function generateStream(req: StreamRequest): StreamEvent[] {
  const label = outcomeLabel(req.outcome);
  const gen = STREAM_GENERATORS[req.sportKey];
  if (gen === undefined) throw new GeneratorUnsupported(req.sportKey, label, "no generator registered");
  const o = req.outcome;
  if (o.kind === "forfeit") {
    return [START, { type: "core.forfeit", payload: { by: idOf(req, o.by), reason: o.reason } }];
  }
  if (o.kind === "abandon") return o.atScore === true ? abandonedAtScore(req, gen) : [START, ABANDON];
  if (o.kind === "level") return levelStream(req, gen);
  if (o.kind === "settle") {
    const base = o.after === "level" ? levelStream({ ...req, outcome: { kind: "level" } }, gen) : abandonedAtScore({ ...req, outcome: { kind: "abandon", atScore: true } }, gen);
    const after = foldStream(sportModule(req.sportKey), req.cfg, req.home, req.away, base).outcome;
    if (!settleableOutcome(after)) {
      throw new OutcomeUnreachable(req.sportKey, label, `the stream folds to '${after?.kind}', not a level outcome: core.settle does not apply (X-ST-1)`);
    }
    return [...base, { type: "core.settle", payload: { winner: idOf(req, o.then), method: o.method } }];
  }
  if (o.kind === "tiebreak") {
    if (gen.tiebreak === undefined) throw new OutcomeUnreachable(req.sportKey, label, "the sport has no tie-break phase");
    return gen.tiebreak({ ...req, outcome: o });
  }
  if (o.kind === "draw" && !drawsAllowed(req.sportKey, req.cfg, req.stageKind)) {
    throw new OutcomeUnreachable(req.sportKey, label, `supportsDraws(cfg, '${req.stageKind}') is false`);
  }
  if (o.kind === "tie") {
    if (gen.tied === undefined) throw new OutcomeUnreachable(req.sportKey, label, "the sport's generator declares no level result");
    return gen.tied(req);
  }
  return gen.decided(req as DecidedRequest);
}

/** W2a: can this sport end a match LEVEL in this stage kind, under this cfg — the question bracketPolicy asks
 *  before it requests `level`. Answered by the generator itself (one authority): a request it would refuse by
 *  name (OutcomeUnreachable, or GeneratorUnsupported for a shape it does not build) is not reachable. */
export function levelReachable(sportKey: string, cfg: unknown, stageKind: StreamRequest["stageKind"]): boolean {
  // An unregistered sport is a defect, not "no level result": generateStream's own refusal, not caught below.
  if (STREAM_GENERATORS[sportKey] === undefined) throw new GeneratorUnsupported(sportKey, "level", "no generator registered");
  try {
    generateStream({ sportKey, cfg, stageKind, home: "level-home", away: "level-away", outcome: { kind: "level" } });
    return true;
  } catch (e) {
    if (e instanceof OutcomeUnreachable || e instanceof GeneratorUnsupported) return false;
    throw e;
  }
}

export type RequestMatch = "match" | "mismatch" | "unasserted";

/** Did the folded outcome equal the requested one? Abandon is RECORDED, not
 *  asserted (its per-sport meaning is W2's rulebook, design §8). */
export function matchesRequest(req: StreamRequest, outcome: MatchOutcome | null): RequestMatch {
  const o = req.outcome;
  if (o.kind === "abandon") return "unasserted";
  if (outcome === null) return "mismatch";
  // W2a: a level request must fold level; a settle must fold to ITS winner by ITS method (X-ST-1: the method is
  // recorded as settled_<method>); a tie-break must fold to ITS winner on ITS rung (BG-KO-1).
  if (o.kind === "level") return isLevelOutcome(outcome) ? "match" : "mismatch";
  if (o.kind === "settle") return outcome.kind === "win" && outcome.winner === idOf(req, o.then) && outcome.method === `settled_${o.method}` ? "match" : "mismatch";
  if (o.kind === "tiebreak") return outcome.kind === "win" && outcome.winner === idOf(req, o.winner) && outcome.method === `tiebreak_${o.rung}` ? "match" : "mismatch";
  if (o.kind === "draw") return outcome.kind === "draw" ? "match" : "mismatch";
  if (o.kind === "tie") return outcome.kind === "tie" ? "match" : "mismatch";
  if (o.kind === "win") return outcome.kind === "win" && outcome.winner === idOf(req, o.winner) ? "match" : "mismatch";
  const beneficiary = idOf(req, o.by === "home" ? "away" : "home");
  return (outcome.kind === "award" || outcome.kind === "win") && outcome.winner === beneficiary ? "match" : "mismatch";
}
