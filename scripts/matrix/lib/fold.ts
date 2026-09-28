// The in-process fold every generated stream goes through before it is posted
// (R15: the real engine module is the consumer). Mirrors the three parity facts
// of validate-pack.ts:451-525 — seq from 1, strict from seq 1, empty-slot
// lineups (loadLineupPair returns slots:[] for a fixture with no lineup rows).
import {
  foldMatchWithStoppage,
  type EventEnvelope,
  type LineupPair,
  type MatchOutcome,
  type StageCtx,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import type { StreamEvent } from "./streams/types.ts";

export const FOLD_OPTIONS = { strictFromSeq: 1 } as const;
export const OFFLINE_RECORDED_AT = "2030-01-01T00:00:00.000Z";

export function envelopes(fixtureId: string, events: readonly StreamEvent[]): EventEnvelope[] {
  return events.map((ev, i) => ({
    id: String(i + 1),
    fixtureId,
    seq: i + 1,
    type: ev.type,
    payload: ev.payload,
    recordedAt: OFFLINE_RECORDED_AT,
    recordedBy: null,
  }));
}

export function lineupsFor(home: string, away: string): LineupPair {
  return { home: { entrantId: home, slots: [] }, away: { entrantId: away, slots: [] } };
}

export interface FoldedStream {
  readonly outcome: MatchOutcome | null;
  readonly state: unknown;
}

export function foldStream(
  module: AnySportModule,
  cfg: unknown,
  home: string,
  away: string,
  events: readonly StreamEvent[],
): FoldedStream {
  const state: unknown = foldMatchWithStoppage(module, cfg as never, lineupsFor(home, away), envelopes("matrix", events), FOLD_OPTIONS).state;
  return { outcome: module.outcome(state), state };
}

export interface DeclaredPoints {
  readonly home: number;
  readonly away: number;
  readonly forOutcome: MatchOutcome;
}

/** What the sport DECLARES this stream is worth in the table: standingsDelta
 *  over the folded state. Null while undecided. Invariant I3 compares the
 *  product's table with Σ of these (R9: derived, never typed). */
export function declaredPoints(
  module: AnySportModule,
  cfg: unknown,
  ctx: StageCtx,
  home: string,
  away: string,
  events: readonly StreamEvent[],
): DeclaredPoints | null {
  const folded = foldStream(module, cfg, home, away, events);
  if (folded.outcome === null) return null;
  const [h, a] = module.standingsDelta(folded.outcome, cfg, ctx, folded.state);
  return { home: h.points, away: a.points, forOutcome: folded.outcome };
}
