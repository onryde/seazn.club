// One registry, one entry point. Forfeit and abandon are UNIVERSAL core events
// (core/forfeit-reason.test.ts pins forfeit for all 11 modules), so they are
// composed here; a sport generator builds a win or a draw (decided) and, where
// its engine can end level, a tie (tied).
import type { MatchOutcome } from "@seazn/engine/core";
import { drawsAllowed } from "../sport-cfg.ts";
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

export function generateStream(req: StreamRequest): StreamEvent[] {
  const label = outcomeLabel(req.outcome);
  const gen = STREAM_GENERATORS[req.sportKey];
  if (gen === undefined) throw new GeneratorUnsupported(req.sportKey, label, "no generator registered");
  const o = req.outcome;
  if (o.kind === "forfeit") {
    return [START, { type: "core.forfeit", payload: { by: idOf(req, o.by), reason: o.reason } }];
  }
  if (o.kind === "abandon") return [START, { type: "core.abandon", payload: { reason: "matrix: abandoned" } }];
  if (o.kind === "draw" && !drawsAllowed(req.sportKey, req.cfg, req.stageKind)) {
    throw new OutcomeUnreachable(req.sportKey, label, `supportsDraws(cfg, '${req.stageKind}') is false`);
  }
  if (o.kind === "tie") {
    if (gen.tied === undefined) throw new OutcomeUnreachable(req.sportKey, label, "the sport's generator declares no level result");
    return gen.tied(req);
  }
  return gen.decided(req as DecidedRequest);
}

export type RequestMatch = "match" | "mismatch" | "unasserted";

/** Did the folded outcome equal the requested one? Abandon is RECORDED, not
 *  asserted (its per-sport meaning is W2's rulebook, design §8). */
export function matchesRequest(req: StreamRequest, outcome: MatchOutcome | null): RequestMatch {
  const o = req.outcome;
  if (o.kind === "abandon") return "unasserted";
  if (outcome === null) return "mismatch";
  if (o.kind === "draw") return outcome.kind === "draw" ? "match" : "mismatch";
  if (o.kind === "tie") return outcome.kind === "tie" ? "match" : "mismatch";
  if (o.kind === "win") return outcome.kind === "win" && outcome.winner === idOf(req, o.winner) ? "match" : "mismatch";
  const beneficiary = idOf(req, o.by === "home" ? "away" : "home");
  return (outcome.kind === "award" || outcome.kind === "win") && outcome.winner === beneficiary ? "match" : "mismatch";
}
