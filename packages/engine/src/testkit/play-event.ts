// W2b ruling 112 — ONE real sport event for a module, drawn from the module's OWN generator (`arbitraryEvent`), so a
// sweep that needs "something was played" never types a sport's event name: the sport says what its play is. Pure: no
// node:fs, so it belongs in the published testkit barrel.
import { foldMatchWithStoppage, isCoreEventType, outcomeOf, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { LineupPair } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { makeEnvelope } from "./helpers.ts";

/** How many generator seeds `onePlayEvent` draws before it answers that the module has no such event here. */
export const PLAY_EVENT_SEEDS = 64;

/**
 * The first event the module's `arbitraryEvent` draws after `prefix` (seeds 1..PLAY_EVENT_SEEDS) that
 *  - is MODULE-OWNED (its type is no `core.*` type the kernel registers — the generator also draws forfeits and
 *    abandons, which are not play),
 *  - the fold accepts STRICTLY as the next event (`strictFromSeq`: the write path), and
 *  - leaves the match undecided (a forfeit after a deciding event answers ALREADY_DECIDED, not the phase guard),
 * enveloped at the next seq — or null when no seed draws one (chess under a plain cfg: its one sport event decides the
 * game; under the bracket deciders a draw is pending its tie-break instead).
 */
export function onePlayEvent(module: AnySportModule, cfg: unknown, lineups: LineupPair, prefix: readonly EventEnvelope[]): EventEnvelope | null {
  if (module.arbitraryEvent === undefined) return null;
  const seq = prefix.length + 1;
  const state: unknown = foldMatchWithStoppage(module as never, cfg as never, lineups, prefix).state;
  for (let seed = 1; seed <= PLAY_EVENT_SEEDS; seed++) {
    const drawn = module.arbitraryEvent(state, mulberry32(seed));
    if (drawn === null || isCoreEventType(drawn.type)) continue;
    const e = makeEnvelope(seq, drawn);
    let folded;
    try {
      folded = foldMatchWithStoppage(module as never, cfg as never, lineups, [...prefix, e], { strictFromSeq: seq });
    } catch {
      continue;
    }
    if (outcomeOf(module as never, folded as never) === null) return e;
  }
  return null;
}
