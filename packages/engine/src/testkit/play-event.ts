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

/** The module's two readings of "the score", each as one comparable string (R112 review M-2):
 *  - `lines`, the per-side score line of its summary (spec 03 §3: "252/8 (50)", "3–1", "2½");
 *  - `tally`, the played tally, which is what a bye credits (C-5: "a bye's credit IS the played tally"). */
function scoreOf(module: AnySportModule, cfg: unknown, state: unknown): { lines: string; tally: string } {
  const lines = JSON.stringify(module.summary(state as never).perSide.map((s) => s.line));
  const tally = JSON.stringify(module.forfeitCredit(cfg, state, "bye", "home").perSide);
  return { lines, tally };
}

/**
 * The event, drawn from the module's `arbitraryEvent` after `prefix` (seeds 1..PLAY_EVENT_SEEDS), that is PLAY: it
 *  - is MODULE-OWNED. Its type is no `core.*` type the kernel registers; the generator also draws forfeits and
 *    abandons, which are not play.
 *  - is accepted by the fold STRICTLY as the next event (`strictFromSeq`: the write path).
 *  - leaves the match undecided. A forfeit after a deciding event answers ALREADY_DECIDED, not the phase guard.
 *  - MOVES THE SCORE (R112 review M-2). A rain marker, a period change, a card or a substitution is a sport event too,
 *    but not play. The first draw that moves the per-side score line wins. Failing that, the first that moves the
 *    played tally wins: a Best of 1 set cannot close undecided, so there only a rally's points move.
 *    Card counts are on football's tally. That is why the line is preferred, and why the tally is never a first choice.
 * The event is enveloped at the next seq. The answer is null when no seed draws one: chess under a plain cfg, where its
 * one sport event decides the game (under the bracket deciders a draw is pending its tie-break instead).
 */
export function onePlayEvent(module: AnySportModule, cfg: unknown, lineups: LineupPair, prefix: readonly EventEnvelope[]): EventEnvelope | null {
  if (module.arbitraryEvent === undefined) return null;
  const seq = prefix.length + 1;
  const state: unknown = foldMatchWithStoppage(module as never, cfg as never, lineups, prefix).state;
  const before = scoreOf(module, cfg, state);
  let tallyOnly: EventEnvelope | null = null;
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
    if (outcomeOf(module as never, folded as never) !== null) continue;
    const after = scoreOf(module, cfg, folded.state);
    if (after.lines !== before.lines) return e;
    if (tallyOnly === null && after.tally !== before.tally) tallyOnly = e;
  }
  return tallyOnly;
}
