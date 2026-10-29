// The in-process fold every generated stream goes through before it is posted
// (R15: the real engine module is the consumer). Mirrors the three parity facts
// of validate-pack.ts:451-525 — seq from 1, strict from seq 1, empty-slot
// lineups (loadLineupPair returns slots:[] for a fixture with no lineup rows).
import {
  DRAW_KINDS,
  foldMatchWithStoppage,
  outcomeOf,
  playRecorded,
  type EventEnvelope,
  type LineupPair,
  type MatchOutcome,
  type StageCtx,
} from "@seazn/engine/core";
import { decidedInFor, payout, resolveTableRules, setsToWinOf, type FixtureResult } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind } from "@seazn/engine/sport";
import type { StreamEvent, StreamLineups } from "./streams/types.ts";

export const FOLD_OPTIONS = { strictFromSeq: 1 } as const;
export const OFFLINE_RECORDED_AT = "2030-01-01T00:00:00.000Z";

/** The target a harness core.void names: its payload's `event_id`, a string (the seq of the event it voids, as
 *  this module numbers them — the product's own void names a uuid), or undefined. */
const voidTarget = (ev: StreamEvent): string | undefined => {
  const id = (ev.payload as { event_id?: unknown } | null)?.event_id;
  return typeof id === "string" ? id : undefined;
};

/** A harness stream as envelopes, seq and id from 1. A `core.void` (W1d Task 14) is lifted the way the product
 *  lifts one (usecases/scoring.ts: `payload.event_id` → the envelope's `voids`), and carries no payload — the
 *  kernel validates ACTIVE events only, so a void's is never read (model/ledger-fold.ts says the same). One that
 *  names nothing gets no `voids`, which the engine's resolveVoids refuses by name. */
export function envelopes(fixtureId: string, events: readonly StreamEvent[]): EventEnvelope[] {
  return events.map((ev, i) => {
    const voids = ev.type === "core.void" ? voidTarget(ev) : undefined;
    return {
      id: String(i + 1),
      fixtureId,
      seq: i + 1,
      type: ev.type,
      payload: ev.type === "core.void" ? {} : ev.payload,
      recordedAt: OFFLINE_RECORDED_AT,
      recordedBy: null,
      ...(voids === undefined ? {} : { voids }),
    };
  });
}

/** The lineups a fold is handed: the starting persons of `lineups` (Task 21: what the harness PUT), in order; with none, empty slots
 *  (loadLineupPair returns slots:[] for a fixture with no lineup rows). */
export function lineupsFor(home: string, away: string, lineups?: StreamLineups): LineupPair {
  const side = (entrantId: string, persons: readonly string[] | undefined) => ({
    entrantId,
    slots: (persons ?? []).map((personId, i) => ({ personId, slot: "starting" as const, orderNo: i + 1 })),
  });
  return { home: side(home, lineups?.home), away: side(away, lineups?.away) };
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
  lineups?: StreamLineups,
): FoldedStream {
  // W2a finding 1: a settle lives beside module state (outcomeOf).
  const folded = foldMatchWithStoppage(module, cfg as never, lineupsFor(home, away, lineups), envelopes("matrix", events), FOLD_OPTIONS);
  return { outcome: outcomeOf(module, folded), state: folded.state as unknown };
}

export interface DeclaredPoints {
  readonly home: number;
  readonly away: number;
  readonly forOutcome: MatchOutcome;
}

export interface TableContribution {
  readonly pair: FixtureResult;
  readonly outcome: MatchOutcome;
}

/** What one posted stream contributes to a TABLE row pair, as the product pays it. Null while undecided.
 *
 *  W2d T9 (X-TB-1, X-PT-2): the table no longer reads `standingsDelta`'s points — every table stage pays its table
 *  RULE, through `payout` (engine-db/competition.ts). So the contribution is the sport's own ledger pair, paid under
 *  the sport's rule for a stage of this kind under `cfg` (`resolveTableRules` with no stage, division or pin layer: the
 *  harness posts no stage `points` — I3 abstains on one — and the pin a stage takes at activation is that same rule),
 *  with the stream's own "was anything played" fact (`playRecorded`, as the product reads it off the stored ledger).
 *  Where the rule pays what `standingsDelta` paid nothing moves; table tennis's D6 (a played loss 1, an unplayed loss
 *  0) is the signed change that does. A bracket kind reads as a league, as the product's `tableStageKindOf` does. The
 *  one harness implementation: I3's declaration and the W2b credit checks' local delta both read it. */
export function tableContribution(
  module: AnySportModule,
  cfg: unknown,
  ctx: StageCtx,
  home: string,
  away: string,
  events: readonly StreamEvent[],
  lineups?: StreamLineups,
): TableContribution | null {
  const folded = foldStream(module, cfg, home, away, events, lineups);
  if (folded.outcome === null) return null;
  const ledger = module.standingsDelta(folded.outcome, cfg, ctx, folded.state);
  const stageKind: TableStageKind = DRAW_KINDS.has(ctx.kind) ? (ctx.kind as TableStageKind) : "league";
  const rule = resolveTableRules({
    module,
    stageKind,
    mergedCfg: cfg,
    stageOwn: { points: null, tiebreakers: null, crossGroup: null },
    divisionTiebreakers: null,
    pinned: null,
  }).points;
  const pair = payout(
    folded.outcome,
    decidedInFor(module, folded.outcome),
    ledger,
    playRecorded(envelopes("matrix", events), module),
    rule,
    module.awardScoreKeys,
    setsToWinOf(module, cfg),
  );
  return { pair, outcome: folded.outcome };
}

/** What the sport DECLARES this stream is worth in the table: `tableContribution`'s points. Null while undecided.
 *  Invariant I3 compares the product's table with Σ of these (R9: derived, never typed). */
export function declaredPoints(
  module: AnySportModule,
  cfg: unknown,
  ctx: StageCtx,
  home: string,
  away: string,
  events: readonly StreamEvent[],
  lineups?: StreamLineups,
): DeclaredPoints | null {
  const c = tableContribution(module, cfg, ctx, home, away, events, lineups);
  if (c === null) return null;
  const [h, a] = c.pair;
  return { home: h.points, away: a.points, forOutcome: c.outcome };
}
