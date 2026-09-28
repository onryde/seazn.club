// One registry, one entry point. Forfeit and abandon are UNIVERSAL core events
// (core/forfeit-reason.test.ts pins forfeit for all 11 modules), so they are
// composed here; a sport generator only builds a win or a draw.
import type { MatchOutcome } from "@seazn/engine/core";
import { drawsAllowed } from "../sport-cfg.ts";
import { genericGenerator } from "./generic.ts";
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

function register(...gens: SportStreamGenerator[]): Readonly<Record<string, SportStreamGenerator>> {
  const out: Record<string, SportStreamGenerator> = {};
  for (const g of gens) for (const k of g.sportKeys) out[k] = g;
  return Object.freeze(out);
}

export const STREAM_GENERATORS = register(genericGenerator);

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
  if (o.kind === "win") return outcome.kind === "win" && outcome.winner === idOf(req, o.winner) ? "match" : "mismatch";
  const beneficiary = idOf(req, o.by === "home" ? "away" : "home");
  return (outcome.kind === "award" || outcome.kind === "win") && outcome.winner === beneficiary ? "match" : "mismatch";
}
