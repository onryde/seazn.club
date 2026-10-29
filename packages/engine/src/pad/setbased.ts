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
    deuceNote: (state, cfg) => {
      const resolved = resolve(cfg);
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
