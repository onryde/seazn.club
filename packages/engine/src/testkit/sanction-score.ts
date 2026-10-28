// W2e X-SE-2 (spec 2026-10-28 §5.3, D3 (2); anti-goal 4) — "a sanction alone moves no score", as ONE sweep body that the
// cross-sport test runs for every module and level and the per-sport rule rows (TT-SE-1, TN-SE-2; preflight D-2) run for
// their own sport. A penalty point or a penalty game is entered as the rally or the game award it is; the sanction event
// is a record. Pure: no node:fs and no vitest, so it belongs in the published testkit barrel; a failure throws an Error
// carrying `actual` / `expected`, which vitest's reporter prints as a diff.
import { EngineError } from "../core/errors.ts";
import { isCoreEventType, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { declaredCfgs } from "./declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";

/** The seeds of the module's own generator each declared cfg is walked from. */
export const SANCTION_SWEEP_SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6];
/** How many events one walk takes at most: enough to carry a set sport and tennis to their decision. */
export const SANCTION_SWEEP_EVENTS = 400;

/**
 * A walk of the module's own generator that is PLAY to the end: a draw of a kernel event other than the start (a forfeit,
 * an abandon) is drawn again rather than taken, because it ends the walk at a state no sanction can follow, and most
 * seeds draw one within the first few events (a badminton walk then never reaches a rally). So is a sanction at a level
 * the module declares as match-ending (W2e X-SE-1): the generator's next draw is its ending, a forfeit, so taking it would
 * end the walk there too. Every event taken is the generator's own legal draw for the state it was drawn in. `states[i]`
 * is the state after `events[i]`. Exported for its guard (`sanction-ending.test.ts`, Task 3 review M1): a walk of a module
 * that declares an end level goes past the first such card instead of stalling on the forfeit that answers it.
 */
export function playWalk(module: AnySportModule, cfg: unknown, lineups: LineupPair, seed: number): { events: EventEnvelope[]; states: unknown[] } {
  if (module.arbitraryEvent === undefined) throw new Error(`${module.key} has no arbitraryEvent to walk`);
  const rng = mulberry32(seed);
  let state: unknown = module.init(cfg, lineups);
  const events: EventEnvelope[] = [];
  const states: unknown[] = [];
  for (let draws = 0; events.length < SANCTION_SWEEP_EVENTS && draws < 4 * SANCTION_SWEEP_EVENTS; draws++) {
    const next = module.arbitraryEvent(state, rng);
    if (next === null) break;
    if (next.type !== "core.start" && isCoreEventType(next.type)) continue;
    if (endsTheMatch(module, next)) continue;
    const envelope = makeEnvelope(events.length, next);
    state = module.apply(state, envelope);
    events.push(envelope);
    states.push(state);
    if (module.outcome(state) !== null) break;
  }
  return { events, states };
}

/** Whether `event` is a sanction at a level the module declares as match-ending (`sanctionEnding.endLevels`). */
function endsTheMatch(module: AnySportModule, event: { type: string; payload: unknown }): boolean {
  const decl = module.sanctionEnding;
  if (decl === undefined || event.type !== decl.eventType) return false;
  return decl.endLevels.includes((event.payload as { level?: unknown }).level as string);
}

/** The module's sanction event type, `<key>.sanction`, when its payload registry declares one; else null. */
export function sanctionEventTypeOf(module: AnySportModule): string | null {
  const type = `${module.key}.sanction`;
  return module.eventSchemas?.[type] === undefined ? null : type;
}

/** Every level the module's sanction payload schema accepts (the write path's universe, which the pad's offer is a subset
 *  of), in the schema's own order. Empty for a module that records no sanction. */
export function sanctionLevelsOf(module: AnySportModule): string[] {
  const type = sanctionEventTypeOf(module);
  if (type === null) return [];
  const options = (module.eventSchemas?.[type] as { shape?: { level?: { options?: unknown } } }).shape?.level?.options;
  if (!Array.isArray(options) || options.length === 0 || !options.every((o): o is string => typeof o === "string")) {
    throw new Error(`${type}: its payload schema declares no \`level\` enum, so there is no ladder to sweep`);
  }
  return options;
}

const omitSanctions = (detail: unknown): unknown => {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return detail;
  const { sanctions: _record, ...rest } = detail as Record<string, unknown>;
  return rest;
};

/** Everything a score is read from, less the sanction's own record (`detail.sanctions`, where every sport that records
 *  a sanction lists it): the summary's headline, per-side lines and detail; the played tally a bye credits; the outcome;
 *  and the position in the match, where the module declares one. */
function scoreView(module: AnySportModule, cfg: unknown, state: unknown): unknown {
  const summary = module.summary(state);
  return {
    headline: summary.headline,
    perSide: summary.perSide,
    detail: omitSanctions(summary.detail),
    tally: module.forfeitCredit(cfg, state, "bye", "home").perSide,
    outcome: module.outcome(state),
    position: module.position?.(state) ?? null,
  };
}

function assertSameScore(expected: unknown, actual: unknown, where: string): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  throw Object.assign(new Error(`a sanction moved the score: ${where}`), { expected, actual, showDiff: true });
}

/**
 * Asserts that a `level` sanction moves no score in `module`: at every live state of a walk of the module's own generator
 * (every declared cfg, `SANCTION_SWEEP_SEEDS`), a sanction against either side leaves the score exactly as it was, and the
 * walk's own next event then lands on the same score it did without the sanction (no award is deferred to the next
 * rally). Returns how many sanctioned states it checked; zero is a failure, thrown here (anti-vacuity).
 */
export function expectSanctionMovesNoScore(module: AnySportModule, level: string): number {
  const type = sanctionEventTypeOf(module);
  if (type === null) throw new Error(`${module.key} records no sanction (no "${module.key}.sanction" in its eventSchemas)`);
  const levels = sanctionLevelsOf(module);
  if (!levels.includes(level)) throw new Error(`${type} records no level "${level}" (its levels: ${levels.join(", ")})`);
  let checked = 0;
  for (const { name, cfg } of declaredCfgs(module)) {
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    for (const seed of SANCTION_SWEEP_SEEDS) {
      const { events, states } = playWalk(module, cfg, lineups, seed);
      for (const [i, before] of states.entries()) {
        if (module.outcome(before) !== null) break;
        for (const by of [lineups.home.entrantId, lineups.away.entrantId]) {
          const where = `${module.key} cfg ${name} seed ${seed} after event ${i} (${events[i]!.type}), ${level} against ${by}`;
          const sanction = makeEnvelope(events.length, { type, payload: { by, level } });
          let after: unknown;
          try {
            after = module.apply(before, sanction);
          } catch (e) {
            // Not live here (a sanction is recorded in play only): nothing to compare.
            if (EngineError.is(e, "WRONG_PHASE")) continue;
            throw e;
          }
          assertSameScore(scoreView(module, cfg, before), scoreView(module, cfg, after), where);
          const next = events[i + 1];
          if (next !== undefined) {
            const continued: unknown = module.apply(after, next);
            assertSameScore(scoreView(module, cfg, states[i + 1]), scoreView(module, cfg, continued), `${where}, then ${next.type}`);
          }
          checked++;
        }
      }
    }
  }
  if (checked === 0) throw new Error(`${module.key}: no live state took a ${level} sanction — the sweep checked nothing`);
  return checked;
}
