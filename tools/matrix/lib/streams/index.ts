// One registry, one entry point. Forfeit and abandon are UNIVERSAL core events
// (core/forfeit-reason.test.ts pins forfeit for all 11 modules), so they are
// composed here; a sport generator builds a win or a draw (decided) and, where
// its engine can end level, a tie (tied).
// W2b (finding 10, D3): a walkover goes in BEFORE core.start — the phase guard refuses one after it — and a
// retirement or disqualification AFTER core.start and some play (the sport's `partial`). forfeitPosting is the one
// composition the stream builder and every driver share, so the two cannot drift.
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
  type ForfeitReason,
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

/** W2b (X-DW-1): neither side turned up. The ONE double-walkover event, every sport (chess's double forfeit included,
 *  BG-DW-1): recorded before START. */
export const DOUBLE_WALKOVER: StreamEvent = Object.freeze({ type: "core.forfeit", payload: Object.freeze({ by: "both", reason: "walkover" }) });

/** W2b (X-RT-1): `[START, ...partial]` for this request — some play, nothing decided — checked by folding it. A
 *  partial stream that DECIDES the match is the generator's defect, refused by name rather than posted. */
export function partialPlay(req: StreamRequest): StreamEvent[] {
  const gen = STREAM_GENERATORS[req.sportKey];
  if (gen === undefined) throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "no generator registered");
  const play = [START, ...gen.partial(req)];
  const folded = foldStream(sportModule(req.sportKey), req.cfg, req.home, req.away, play).outcome;
  if (folded !== null) throw new OutcomeUnreachable(req.sportKey, outcomeLabel(req.outcome), `the sport's partial play folds to '${folded.kind}' — it must leave the match undecided`);
  return play;
}

/** A forfeit the harness would post in a shape the rule refuses on a scheduled fixture — refused by name BEFORE it is
 *  posted, so the product's refusal is never mistaken for its verdict on a well-formed forfeit (review M-2). */
export class ForfeitPostingRefused extends Error {
  override readonly name = "ForfeitPostingRefused";
  constructor(detail: string) {
    super(`streams: forfeit posting refused — ${detail}`);
  }
}

/** The reasons recorded only AFTER play began (D3 R4: the phase guard refuses one before START), and the ones recorded
 *  only BEFORE it (D3 R2: a walkover, and a double walkover, after START is refused outside a chess game under way).
 *  `withdrew` is neither: it is the withdrawal cascade's own reason, written in any phase, never posted by the harness. */
const IN_PLAY_REASONS: readonly ForfeitReason[] = ["retired", "disqualified"];
const PRE_PLAY_REASONS: readonly ForfeitReason[] = ["walkover"];

/** W2b ruling 113 (amends X-RS-1, X-RT-1): nobody retires from a match never played. "Played" is the engine's own
 *  reading (core/events.ts playRecorded, ruling 112): a sport — non-`core.` — event after START; and (ruling 118) START
 *  itself where the sport's module declares its Start play (`startIsPlay`: chess, which records no moves). A
 *  disqualification needs only START; a retirement needs this. Exported for its own test: on the real registry the one
 *  sport with no partial play is chess, which declares the flag, so generateStream's refusal is reached only here. */
export function holdsPlay(play: readonly StreamEvent[], module: { readonly startIsPlay?: boolean }): boolean {
  return play.some((e) => !e.type.startsWith("core.")) || (module.startIsPlay === true && play.some((e) => e.type === START.type));
}

/** The events a forfeit is posted as, given the fixture's status now — the ONE composition generateStream, the drivers
 *  and decideFixture share (W2b D3, finding 10). On a fixture already under way the forfeit goes in bare. On a
 *  SCHEDULED one, `play` goes in before it: START and the sport's partial play for a retirement or a disqualification
 *  (partialPlay — the phase guard refuses one before play, D3 R4), and nothing for a walkover or a double walkover,
 *  which are recorded before START (the guard refuses a walkover after it, R2). `by` is an entrant id, or "both".
 *  On a scheduled fixture, a walkover (or double walkover) WITH play and a retirement or disqualification with NONE
 *  are refused by name (ForfeitPostingRefused), as is play that does not open with START. Whether the play given is
 *  enough for a RETIREMENT is the sport's (ruling 113, and ruling 118 for chess's Start): this composition is shared by
 *  drivers that know no sport, so generateStream judges it (`holdsPlay` with the module) and the product's own guard
 *  refuses a hand-composed one by name (FORFEIT_REASON_WRONG_PHASE). */
export function forfeitPosting(status: string, forfeit: { readonly by: string; readonly reason: ForfeitReason }, play: readonly StreamEvent[]): StreamEvent[] {
  const ev: StreamEvent = { type: "core.forfeit", payload: { by: forfeit.by, reason: forfeit.reason } };
  if (status !== "scheduled") return [ev];
  const what = forfeit.by === "both" ? "a double walkover" : `a ${forfeit.reason} forfeit`;
  if ((forfeit.by === "both" || PRE_PLAY_REASONS.includes(forfeit.reason)) && play.length > 0) {
    throw new ForfeitPostingRefused(`${what} on a scheduled fixture is recorded before ${START.type}, but ${play.length} event(s) of play were given (D3 R2)`);
  }
  if (forfeit.by !== "both" && IN_PLAY_REASONS.includes(forfeit.reason) && play.length === 0) {
    throw new ForfeitPostingRefused(`${what} on a scheduled fixture is recorded after ${START.type} and some play, but none was given (D3 R4)`);
  }
  const first = play.at(0);
  if (first !== undefined && first.type !== START.type) throw new ForfeitPostingRefused(`the play before a forfeit starts with ${START.type}, not ${first.type}`);
  return [...play, ev];
}

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
  // W2e G12 is Task 24's: the shape is typed (Task 19) so the vocabulary has one author, and nothing builds it yet.
  if (o.kind === "sanctionEnd") throw new GeneratorUnsupported(req.sportKey, label, "a sanction ending (W2e G12) is Task 24's, and no generator builds it yet");
  // W2e (F8): a path is built only by a generator that can witness it; any other would build a plain win under its name.
  if (o.kind === "win" && o.path !== undefined && gen.pathWitness === undefined) {
    throw new GeneratorUnsupported(req.sportKey, label, `its generator builds no deciding path (W2e Tasks 19–23 add each sport's), so '${o.path}' is not built as a plain win`);
  }
  if (o.kind === "forfeit") {
    const play = o.at === "before_start" ? [] : partialPlay(req);
    // Ruling 113: a sport whose partial play holds nothing played cannot retire — named here, so a sweep reads it as the
    // sport's, not the request's. Ruling 118: chess's partial play is START alone, and its Start is play, so it retires.
    if (o.reason === "retired" && play.length > 0 && !holdsPlay(play, sportModule(req.sportKey))) {
      throw new OutcomeUnreachable(req.sportKey, label, "ruling 113: nobody retires from a match never played, and the sport's partial play here is START alone (nothing is played short of its result)");
    }
    return forfeitPosting("scheduled", { by: idOf(req, o.by), reason: o.reason }, play);
  }
  if (o.kind === "double_walkover") return [DOUBLE_WALKOVER];
  if (o.kind === "abandon") return o.afterPartial === true ? [...partialPlay(req), ABANDON] : o.atScore === true ? abandonedAtScore(req, gen) : [START, ABANDON];
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

/** W2e G12 asked of matchesRequest before Task 24 gives it a meaning: an answer would be a guess, so it is refused. */
export class SanctionEndUnmatched extends Error {
  constructor(sportKey: string, label: string) {
    super(`streams: matchesRequest cannot judge ${sportKey} '${label}' — a sanction ending (W2e G12) is Task 24's to build and to match`);
    this.name = "SanctionEndUnmatched";
  }
}

/** Did the folded outcome equal the requested one? Abandon is RECORDED, not
 *  asserted (its per-sport meaning is W2's rulebook, design §8). W2e: a win that
 *  names a deciding `path` is judged on the fold's STATE too (`state`, the
 *  foldStream state of the same stream), by the sport generator's own
 *  `pathWitness`; a path request handed no state is refused by name. */
export function matchesRequest(req: StreamRequest, outcome: MatchOutcome | null, state?: unknown): RequestMatch {
  const o = req.outcome;
  if (o.kind === "sanctionEnd") throw new SanctionEndUnmatched(req.sportKey, outcomeLabel(o));
  if (o.kind === "abandon") return "unasserted";
  if (outcome === null) return "mismatch";
  switch (o.kind) {
    // W2a: a level request must fold level; a settle must fold to ITS winner by ITS method (X-ST-1: the method is
    // recorded as settled_<method>); a tie-break must fold to ITS winner on ITS rung (BG-KO-1).
    case "level": return isLevelOutcome(outcome) ? "match" : "mismatch";
    case "settle": return outcome.kind === "win" && outcome.winner === idOf(req, o.then) && outcome.method === `settled_${o.method}` ? "match" : "mismatch";
    case "tiebreak": return outcome.kind === "win" && outcome.winner === idOf(req, o.winner) && outcome.method === `tiebreak_${o.rung}` ? "match" : "mismatch";
    case "draw": return outcome.kind === "draw" ? "match" : "mismatch";
    case "tie": return outcome.kind === "tie" ? "match" : "mismatch";
    case "win": {
      if (outcome.kind !== "win" || outcome.winner !== idOf(req, o.winner)) return "mismatch";
      if (o.path === undefined) return "match";
      // W2e (F8): the path is the ENGINE's fact about the fold, read by the generator that built it.
      if (state === undefined) throw new Error(`streams: ${req.sportKey} path '${o.path}' is witnessed on the folded state, and matchesRequest was handed none (pass foldStream(...).state)`);
      const gen = STREAM_GENERATORS[req.sportKey];
      if (gen?.pathWitness === undefined) throw new GeneratorUnsupported(req.sportKey, outcomeLabel(o), "its generator builds no deciding path, so none can be witnessed");
      return gen.pathWitness(o.path, { sportKey: req.sportKey, outcome, state, cfg: req.cfg }) ? "match" : "mismatch";
    }
    case "double_walkover": return outcome.kind === "double_walkover" ? "match" : "mismatch";
    case "forfeit": {
      // W2b (D2): a forfeit folds to an AWARD to the other side, carrying the reason asked (X-RS-1).
      const beneficiary = idOf(req, o.by === "home" ? "away" : "home");
      return outcome.kind === "award" && outcome.winner === beneficiary && (outcome as { reason?: unknown }).reason === o.reason ? "match" : "mismatch";
    }
    default: {
      const unhandled: never = o;
      throw new Error(`streams: matchesRequest has no arm for ${JSON.stringify(unhandled)}`);
    }
  }
}
