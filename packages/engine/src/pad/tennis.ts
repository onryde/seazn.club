// @seazn/engine/pad - the tennis record (pad wave P3.2). Each field is the very object the fold and padSpec read (the point-kind,
// interruption-kind and sanction-level enums, the fidelity map, POINT_CALLS, PLAUSIBLE_INTERRUPTION_SECONDS) or a pure function
// of the nested kernel's own (gamesFieldBound, tbFieldBound, rulesFor and tiebreakSetScore, breakerInForce,
// tiebreakServeRotatesAfter, endsChanged). No value is typed here.
//
// Every cfg is read through tennis's own configSchema: an absent key is the schema's default, an invalid cfg throws (the schema's
// own refusal). A state is `PadHostView.state`, `unknown` by contract: the folded NestedState, or `{}` on a pad mounted before
// any fold, which answers as no state at all. Phone-safe: no node:*, no React, no display strings.
import {
  NestedInterruptionKind,
  NestedPointKind,
  NestedSanctionLevel,
  PLAUSIBLE_INTERRUPTION_SECONDS,
  POINT_CALLS,
  breakerInForce,
  endsChanged,
  gamesFieldBound,
  rulesFor,
  tbFieldBound,
  tiebreakServeRotatesAfter,
  tiebreakSetScore,
  type GamePoints,
  type NestedCfg,
  type NestedState,
} from "../sports/nested/kernel.ts";
import { tennis } from "../sports/tennis/tennis.ts";
import type { TennisPadRules } from "./types.ts";

const resolve = (cfg: unknown): NestedCfg => tennis.configSchema.parse(cfg);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScore = (value: unknown): value is { home: number; away: number } =>
  isRecord(value) && typeof value.home === "number" && typeof value.away === "number";

/** The game points of a folded state, or null when `state` is not one. */
function pointsOf(state: unknown): GamePoints | null {
  if (!isRecord(state)) return null;
  const points = state.points;
  return isScore(points) && typeof (points as { kind?: unknown }).kind === "string" ? (points as GamePoints) : null;
}

/** The fields `endsChanged` reads, or null when `state` is not a folded NestedState. */
function playOf(state: unknown): Pick<NestedState, "phase" | "sets" | "games" | "points"> | null {
  const points = pointsOf(state);
  if (points === null || !isRecord(state)) return null;
  const { phase, sets, games } = state;
  if (typeof phase !== "string" || !Array.isArray(sets) || !sets.every(isScore) || !isScore(games)) return null;
  return { phase: phase as NestedState["phase"], sets, games, points };
}

/** The sets won so far. Before any fold none has been won (the kernel's `init` opens at 0-0). */
function setsWonOf(state: unknown): NestedState["setsWon"] {
  const setsWon = isRecord(state) ? state.setsWon : undefined;
  return isScore(setsWon) ? { home: setsWon.home, away: setsWon.away } : { home: 0, away: 0 };
}

function fidelityOf(): TennisPadRules["eventBands"] {
  if (tennis.padSpec === undefined) throw new Error("@seazn/engine/pad: tennis declares no padSpec");
  // `nestedFidelity`: one object for every cfg, so reading it at the schema default reads it for all of them
  return tennis.padSpec(resolve({})).fidelity;
}

export const tennisPadRules: TennisPadRules = Object.freeze({
  eventBands: fidelityOf(),
  pointKinds: NestedPointKind.options,
  interruptionKinds: NestedInterruptionKind.options,
  sanctionLevels: NestedSanctionLevel.options,
  interruptionMaxSeconds: PLAUSIBLE_INTERRUPTION_SECONDS,
  pointCalls: POINT_CALLS,
  endsChanged: (state: unknown) => {
    const play = playOf(state);
    return play !== null && endsChanged(play);
  },
  gamesFieldBound: (cfg: unknown) => gamesFieldBound(resolve(cfg)),
  tiebreakFieldBound: (cfg: unknown) => tbFieldBound(resolve(cfg)),
  bestOf: (cfg: unknown) => resolve(cfg).bestOf,
  setScoreTakesTiebreak: (state: unknown, cfg: unknown, home: number, away: number) =>
    tiebreakSetScore(home, away, rulesFor({ cfg: resolve(cfg), setsWon: setsWonOf(state) })),
  breakerInForce: (state: unknown) => {
    const points = pointsOf(state);
    return points !== null && breakerInForce(points);
  },
  tiebreakServeRotatesAfter,
});
