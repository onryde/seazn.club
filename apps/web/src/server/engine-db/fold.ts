import "server-only";
import type postgres from "postgres";
import {
  EngineError,
  foldMatch,
  resolveVoids,
  type EventEnvelope,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { resolveModule } from "./registry";
import { loadLineupPair } from "./lineups";
import { resolveFixtureCfg } from "./fixture-cfg";

type Tx = postgres.TransactionSql;

/**
 * Everything `foldMatch` needs for one fixture, loaded once.
 *
 * Split out of `foldFixture` (2026-09-11) so a SECOND consumer that must replay
 * the same ledger — the overlay's `recent` derivation, which probes "would the
 * next point win the set" — reuses these inputs instead of re-reading them.
 * Two separate loads would also be two separate `resolveFixtureCfg` calls, and
 * this file already states why that must not happen: read and write folds must
 * stay byte-consistent or `verifyStateConsistency` flags phantom drift.
 *
 * NOT part of `FoldedFixture`, deliberately. `foldFixture`'s result travels
 * through `unstable_cache` on the overlay path (`server/overlay/load.ts`),
 * which SERIALISES it — and `module` is an object of functions. It would arrive
 * on the other side of the cache with its methods gone, and the passthrough
 * double every `unstable_cache` test in this repo uses would never show it.
 */
export interface FoldInputs {
  sportKey: string;
  module: AnySportModule;
  cfg: unknown;
  lineups: LineupPair;
  envelopes: EventEnvelope[];
}

export interface FoldedFixture {
  fixtureId: string;
  lastSeq: number;
  state: unknown;
  summary: ScoreSummary;
  outcome: MatchOutcome | null;
  /** The void-resolved stream. `fixtures.status` is derived from WHICH events
   *  survive (`core.start`, `core.forfeit`, `core.abandon`), not from the fold,
   *  so any caller that re-derives the fixture row needs it — see
   *  `fixtureStatusFromFold` in `append-event.ts`. */
  active: readonly EventEnvelope[];
}

interface FixtureRow {
  division_id: string;
  stage_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** V347 — the resolved cfg this fixture was SCORED under; null before its
   *  first event. See `fixture-cfg.ts` for why it exists. */
  config_snapshot: unknown;
}
interface DivisionRow {
  config: unknown;
  sport_key: string;
  module_version: string;
}
interface EventRow {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: Date;
  recorded_by: string | null;
  voids_event_id: string | null;
}

// Load a fixture's full ledger and fold it through the pinned module — the pure
// rebuild of match_state from score_events (spec 02 §6: MatchState is a
// disposable cache = fold(events)). Returns null for a fixture with no events
// (nothing to derive). Shared by rebuildState + verifyStateConsistency.
export async function loadFoldInputs(tx: Tx, fixtureId: string): Promise<FoldInputs | null> {
  const [fixture] = await tx<FixtureRow[]>`
    select division_id, stage_id, home_entrant_id, away_entrant_id, config_snapshot
    from fixtures where id = ${fixtureId}
  `;
  if (!fixture) return null;

  const events = await tx<EventRow[]>`
    select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
    from score_events where fixture_id = ${fixtureId} order by seq
  `;
  if (events.length === 0) return null;

  const [division] = await tx<DivisionRow[]>`
    select config, sport_key, module_version from divisions where id = ${fixture.division_id}
  `;
  if (!division) return null;

  // D4a (P5) — reachable now that entrant slots can be null (TBD/bye, or an
  // entrant deleted after scoring via the FK's `on delete set null`): a bare
  // `Error` here 500s where the sibling guard in append-event.ts (the write
  // path, same precondition) 422s via EngineError. Match it — a read that
  // can't fold a fixture with an unassigned entrant is the same "wrong
  // phase" as a write that can't append to one.
  //
  // `reason: "unassigned_entrant"` is load-bearing, not decoration:
  // admin-fixture-config.ts's resnapshot preflight denylists EngineErrors
  // that reach it "without the fold having judged anything" (today: the
  // registry's MODULE_NOT_FOUND/MODULE_DUPLICATE) so it doesn't mislabel a
  // data defect as "the live config can't read this" — WRONG_PHASE is also
  // thrown BY sport modules' own fold/apply logic for genuine phase-order
  // config problems, so denylisting the whole code would swallow those too.
  // This reason lets that caller (or any other) distinguish "this guard,
  // before the fold ran" from "the fold itself judged the config" without
  // widening the exemption to every WRONG_PHASE.
  if (!fixture.home_entrant_id || !fixture.away_entrant_id) {
    throw new EngineError("WRONG_PHASE", "fixture has an unassigned entrant (bye/TBD)", {
      fixtureId,
      reason: "unassigned_entrant",
    });
  }

  const sportModule = resolveModule(division.sport_key, division.module_version);
  const lineups = await loadLineupPair(
    tx,
    fixtureId,
    fixture.home_entrant_id,
    fixture.away_entrant_id,
  );

  const envelopes: EventEnvelope[] = events.map((r) => ({
    id: r.id,
    fixtureId,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    recordedAt: r.recorded_at.toISOString(),
    recordedBy: r.recorded_by,
    ...(r.voids_event_id ? { voids: r.voids_event_id } : {}),
  }));

  // Exactly the cfg the write path used (V347): the snapshot frozen on the
  // first append, or — for a fixture with no snapshot yet — the same
  // stage-scoped decider overlay (PROMPT-61 §2). Read and write folds must stay
  // byte-consistent or verifyStateConsistency would flag phantom drift, which
  // is why BOTH go through `resolveFixtureCfg` rather than each building cfg
  // for themselves. The stage row is still loaded: it is the fallback input,
  // and every fixture written before V347 shipped takes that path.
  const [stage] = await tx<{ config: Record<string, unknown> | null }[]>`
    select config from stages where id = ${fixture.stage_id}
  `;
  const cfg = resolveFixtureCfg(fixture.config_snapshot, division.config, stage?.config);
  return { sportKey: division.sport_key, module: sportModule, cfg, lineups, envelopes };
}

/** The pure half: the fold itself, over inputs already loaded. */
export function foldFrom(fixtureId: string, inputs: FoldInputs): FoldedFixture {
  const { module: sportModule, cfg, lineups, envelopes } = inputs;
  const state = foldMatch(sportModule, cfg, lineups, envelopes);
  return {
    fixtureId,
    lastSeq: envelopes[envelopes.length - 1]!.seq,
    state,
    summary: sportModule.summary(state),
    outcome: sportModule.outcome(state),
    active: resolveVoids(envelopes),
  };
}

export async function foldFixture(tx: Tx, fixtureId: string): Promise<FoldedFixture | null> {
  const inputs = await loadFoldInputs(tx, fixtureId);
  return inputs === null ? null : foldFrom(fixtureId, inputs);
}
