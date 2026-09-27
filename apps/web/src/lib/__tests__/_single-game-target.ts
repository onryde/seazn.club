// The number a best-of-1 match's only game is ACTUALLY played to, asked of the
// engine by playing it — never read off a config key.
//
// That is the whole point of the Bo1 points editor fix (owner ruling
// 2026-09-25, Option A): the set-based kernel's `setTarget` plays the LAST
// possible set to `finalSetTo`, and on best of 1 the only set IS the last, so
// `setTo` is never read. A test that asserted "the editor wrote `finalSetTo`"
// would be restating that reading of `kernel.ts`; this helper instead folds a
// whitewash through the real module and counts the rallies it takes to decide
// the match, so the day the engine changes which key it plays, every test
// built on this moves with it (AGENTS.md rule 19).
//
// A whitewash decides at `max(target, winBy)` rallies (a cap never binds
// first: the schema holds `cap >= max(setTo, finalSetTo)`), so callers probe
// targets at or above `winBy`.
//
// Not a `.test.ts` file, so vitest does not collect it on its own.
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { resolvePositions } from "@seazn/engine/sport";
import {
  badminton,
  tabletennis,
  volleyball,
  type SetBasedModule,
  type SetBasedState,
} from "@seazn/engine/sports/setbased";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";

/** The three set-based presets, keyed as `SPORT_RULES` keys them. */
export const SET_BASED_MODULES: Record<string, SetBasedModule> = {
  badminton,
  tabletennis,
  volleyball,
};

/** Rallies the home side must win in a row to decide a best-of-1 match played
 *  under `config` (parsed through the module's own schema, so defaults fill
 *  whatever the caller leaves out and an invalid config throws). */
export function pointsTheOnlyGameIsPlayedTo(
  sportKey: string,
  config: Record<string, unknown>,
): number {
  const mod = SET_BASED_MODULES[sportKey];
  if (mod === undefined) throw new Error(`no set-based module for ${sportKey}`);
  const cfg = mod.configSchema.parse(config);
  if (cfg.bestOf !== 1) throw new Error(`${sportKey}: expected best of 1, got ${cfg.bestOf}`);
  const lineups = defaultLineupPair(resolvePositions(mod, cfg));
  const events: EventEnvelope[] = [makeEnvelope(0, { type: "core.start", payload: {} })];
  for (let n = 1; n <= 250; n++) {
    events.push(
      makeEnvelope(n, { type: `${mod.key}.rally`, payload: { wonBy: lineups.home.entrantId } }),
    );
    const state = foldMatch(mod, cfg, lineups, events, { strictFromSeq: 0 }) as SetBasedState;
    if (state.phase !== "live") return n;
  }
  throw new Error(`${sportKey}: 250 straight rallies did not decide a best-of-1 match`);
}
