// Football's substitution caps and a substitution's stamp, as the pad reads them. Pure, no React: the football skin
// (`football.tsx`) calls these from `subPolicy` and `buildSwap`.
//
// THE CAPS COME FROM THE ENGINE (engine 7.0.0, F-R3). Law 3 lets a competition that plays extra time allow one more
// substitution and one more substitution opportunity in it (`extraTimeSubs`), so a cap is a question about the cfg AND
// the phase. The engine answers it in one place, `effectiveSubCaps(cfg, phase)`, which its package does not export; it
// reaches the web through the two readers that do go through it: `footballPadRules.subWindowsCap(cfg, phase)` for the
// windows and football's own `lineupPolicy(cfg, state)` (the kernel's `maxSubs`) for the players. Neither cap is read off
// the cfg here, so extra time raises it on the pad exactly as it does in the fold.
//
// A SUBSTITUTION'S STAMP is the controller's ruling 154 (the phone's, adopted for the web on the owner's approval of
// 2026-11-11; it supersedes the web's R3-2, which stamped a sub with the fold's `asOf`). Mirrors the phone's
// `src/domain/scoring/footballClock.ts` (`SUB_STOPPAGE_SECONDS`, `subStoppageOf`, `joinsStoppage`, `subStampFor`), in
// seazn.club.capture's `feat/s2-5-football`.
import type { EventEnvelope } from "@seazn/engine/core";
import { footballPadRules } from "@seazn/engine/pad";
import { football, type FootballCfg, type FootballState } from "@seazn/engine/sports/football";
import { gameTimeOf, type GameTimeStamp } from "../clock";

/** The two caps in force in a phase: PLAYERS (`maxSubs`) and STOPPAGES (`subWindows`). `undefined` is no cap. */
export interface SubCaps {
  readonly maxSubs: number | undefined;
  readonly subWindows: number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The caps in force in `phase` (Law 3; F-R3): the cfg's `maxSubs` and `subWindows`, each raised by `extraTimeSubs` once the
 * match has reached extra time (ET_H1, ET_H2, or the kicks after extra time). `maxSubs` is `undefined` under rolling subs,
 * as the kernel applies none there.
 *
 * `lineupPolicy` is typed for a parsed cfg and a whole State, and reads only the cap leaves of the one and the `phase` of
 * the other; the pad holds an `unknown` cfg and knows the phase, so both are handed over as what they are read for.
 */
export function subCapsOf(cfg: unknown, phase: string): SubCaps {
  const state = { phase } as unknown as FootballState;
  const policy = football.lineupPolicy?.(asRecord(cfg) as unknown as FootballCfg, state);
  return { maxSubs: policy?.maxSubs, subWindows: footballPadRules.subWindowsCap(cfg, phase) };
}

/**
 * How long after a substitution's stamp another substitution still joins its stoppage, in seconds of match time
 * (ruling 154). Measured from the stoppage's own stamp, never from the sub before, so a chain of subs cannot creep.
 */
export const SUB_STOPPAGE_SECONDS = 120;

/** The events that are a substitution, whoever sent them: the pad's own, and the kernel's lineup changes. */
const SUB_TYPES: ReadonlySet<string> = new Set(["football.sub", "core.lineup.substitution", "core.lineup.replacement"]);

/** What a substitution stoppage is read from: the ledger rows (the standing ones and their voids, in stream order). */
export type SubLedgerRow = Pick<EventEnvelope, "id" | "type" | "payload" | "voids">;

/**
 * The stoppage a substitution made now may join (ruling 154): the newest STANDING stamped event of `events`, when it is
 * itself a substitution, either team's, stamped in `phase`. `null` otherwise: a goal, a card or a clock event since the
 * last sub ends the stoppage, and so does a whistle (the newest stamp then names another period).
 */
export function subStoppageOf(events: readonly SubLedgerRow[], phase: string): GameTimeStamp | null {
  const voided = new Set<string>();
  for (const event of events) if (typeof event.voids === "string") voided.add(event.voids);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (voided.has(event.id)) continue;
    const stamp = gameTimeOf(asRecord(event.payload).at);
    if (stamp === null) continue;
    return SUB_TYPES.has(event.type) && stamp.period === phase ? stamp : null;
  }
  return null;
}

/**
 * A substitution's stamp (ruling 154), or `undefined` for none.
 *
 * - It JOINS the stoppage (`subStoppageOf`) when its own reading is no more than `SUB_STOPPAGE_SECONDS` past that stoppage's
 *   stamp, and then takes that exact stamp, so the engine counts the subs made at it as one window.
 * - Otherwise it takes its own reading: the live clock (`live`, the host's `clockAt`), floored at the fold's `asOf` in the
 *   same period, as the host stamps a goal or a card (`stampOf`, ../clock.ts; the floor is S2-5 ruling 107's).
 * - None with no reading, or a reading of another period than the fold's: a sub there opens no window (Law 3), and absent
 *   beats wrong.
 */
export function subStampOf(
  events: readonly SubLedgerRow[],
  phase: string,
  live: GameTimeStamp | undefined,
  asOf: GameTimeStamp | undefined,
): GameTimeStamp | undefined {
  if (live === undefined || live.period !== phase) return undefined;
  const floor = asOf !== undefined && asOf.period === phase ? asOf.elapsed : 0;
  const own = { period: phase, elapsed: Math.max(live.elapsed, floor) };
  const stoppage = subStoppageOf(events, phase);
  return stoppage !== null && own.elapsed - stoppage.elapsed <= SUB_STOPPAGE_SECONDS ? stoppage : own;
}
