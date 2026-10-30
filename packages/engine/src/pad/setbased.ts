// @seazn/engine/pad - the set-based records (pad wave P3.1): badminton, table tennis, volleyball. Each field is the very object
// the fold and padSpec read (sanction ladders, the fidelity map, EXPEDITE_RETURNS, LIBERO_BAND, the volleyball serve) or a
// pure function of the kernel's own (setTarget, summaryScoreBound, setDeuceNote, setIntervalMark, serviceCourtOf,
// expediteReturnsCreditable). No value is typed here.
//
// Every cfg is read through the module's own configSchema: an absent key is the schema's default, an invalid cfg throws
// (the schema's own refusal). Phone-safe: no node:*, no React, no display strings.
import type { FidelityBand } from "../sport/module.ts";
import { BADMINTON_SANCTION_LEVELS, badminton } from "../sports/setbased/badminton.ts";
import {
  EXPEDITE_RETURNS,
  EXPEDITE_SCORE_FLOOR,
  LIBERO_BAND,
  expediteReturnsCreditable,
  openSet,
  serviceCourtOf,
  setDeuceNote,
  setIntervalMark,
  setTarget,
  summaryScoreBound,
  type SetBasedCfg,
  type SetBasedModule,
  type SetBasedState,
} from "../sports/setbased/kernel.ts";
import { TABLETENNIS_SANCTION_LEVELS, tabletennis } from "../sports/setbased/tabletennis.ts";
import { VOLLEYBALL_SANCTION_LEVELS, VOLLEYBALL_SERVE, volleyball } from "../sports/setbased/volleyball.ts";
import type { BadmintonPadRules, SetBasedPadRules, TableTennisPadRules, VolleyballPadRules } from "./types.ts";

/** The open set of a folded state, or null: no state yet (a pad mounted before any fold is `{}`), no set, or between sets. */
function openSetOf(state: unknown): ReturnType<typeof openSet> {
  if (typeof state !== "object" || state === null) return null;
  const sets = (state as { sets?: unknown }).sets;
  if (!Array.isArray(sets)) return null;
  return openSet(state as Pick<SetBasedState, "sets">);
}

/** The folded state's phase (`pre|live|done|final|abandoned`), or null for a pre-fold `{}` or a non-object. */
function phaseOf(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const phase = (state as { phase?: unknown }).phase;
  return typeof phase === "string" ? phase : null;
}

/** The module's fidelity map: `padSpec(cfg).fidelity` is ONE object for every cfg (`setBasedFidelity`), read at the default. */
function fidelityOf(module: SetBasedModule): Readonly<Record<string, FidelityBand>> {
  if (module.padSpec === undefined) throw new Error(`@seazn/engine/pad: ${module.key} declares no padSpec`);
  return module.padSpec(module.configSchema.parse({})).fidelity;
}

function setBasedRules(module: SetBasedModule, sanctionLevels: readonly string[]): SetBasedPadRules {
  const resolve = (cfg: unknown): SetBasedCfg => module.configSchema.parse(cfg);
  return {
    eventBands: fidelityOf(module),
    sanctionLevels,
    bestOf: (cfg) => resolve(cfg).bestOf,
    setTo: (cfg) => resolve(cfg).setTo,
    setTarget: (cfg, setIndex) => setTarget(resolve(cfg), setIndex),
    scoreBound: (cfg) => summaryScoreBound(resolve(cfg)),
    // WHEN the note shows is the rulebook's two-point endgame, read off the fold's own `setWinner` (setDeuceNote): a
    // level score from target-1 all keeps needing a two-point lead at EVERY later tie, not only the first. BWF Law 7.3
    // (20-all: two clear) and 7.4 (29-all: the 30th point wins, the golden point), DOMAIN.badminton.md "Setting" /
    // "Golden point" rows; ITTF 2.11.1 (10-all: two clear), DOMAIN.tabletennis.md "Uncapped deuce endgame (12-10,
    // 15-13, ...)"; FIVB 6.1.2 (24-all: play on to a two-point lead) and 6.3.2 (the deciding set, 14-all),
    // DOMAIN.volleyball.md "Two-point margin with an uncapped endgame (32-30 is legal)". A win-by-one cfg reads golden
    // point at target-1 all, because the next point wins. Pad wave P3.1 moved badminton and volleyball from "only at
    // target-1 all" to this (table tennis already did it, the PR #678 fix); the owner rules on that visible change.
    //
    // Live only: a forfeit (retired, disqualified) or an abandon ends the match with the open set still unclosed, and a
    // decided board has no next point to describe.
    deuceNote: (state, cfg) => {
      const resolved = resolve(cfg);
      if (phaseOf(state) !== "live") return null;
      const open = openSetOf(state);
      return open === null ? null : setDeuceNote(resolved, open.index, open.set.home, open.set.away);
    },
  };
}

export const badmintonPadRules: BadmintonPadRules = Object.freeze({
  ...setBasedRules(badminton, BADMINTON_SANCTION_LEVELS),
  intervalMark: (cfg: unknown, setIndex: number) => setIntervalMark(badminton.configSchema.parse(cfg), setIndex),
  serviceCourt: serviceCourtOf,
});

export const tabletennisPadRules: TableTennisPadRules = Object.freeze({
  ...setBasedRules(tabletennis, TABLETENNIS_SANCTION_LEVELS),
  expediteReturns: EXPEDITE_RETURNS,
  expediteScoreFloor: EXPEDITE_SCORE_FLOOR,
  expediteReturnsCreditable,
});

export const volleyballPadRules: VolleyballPadRules = Object.freeze({
  ...setBasedRules(volleyball, VOLLEYBALL_SANCTION_LEVELS),
  liberoBand: LIBERO_BAND,
  // FIVB 7.6.2's six positions: the preset's own declaration, the same for every cfg. The cfg is still read through the
  // schema so an invalid one is refused here as everywhere else in the record.
  rotationCycle: (cfg: unknown) => {
    volleyball.configSchema.parse(cfg);
    return VOLLEYBALL_SERVE.rotationCycle;
  },
});
