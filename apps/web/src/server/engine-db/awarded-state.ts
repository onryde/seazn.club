import "server-only";
import type postgres from "postgres";
import { isDeepStrictEqual } from "node:util";
import {
  foldMatchWithStoppage,
  outcomeOf,
  summaryOf,
  type EventEnvelope,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { unseatedForfeitLoser } from "@/lib/forfeit-tag";
import { resolveModule } from "./registry";
import { loadLineupPair } from "./lineups";
import { resolveFixtureCfg } from "./fixture-cfg";

type Tx = postgres.TransactionSql;

/**
 * R116-2 (W2b Task 16; owner ruling 116, T13's one credited score, X-WO-1) — the state and score of a match decided by
 * an award that NO EVENT recorded: ruling 116's walkover over a withdrawn winner's dead seat (`awardSeededByes`).
 *
 * "Like any other walkover" includes its score, so it is the engine's own walkover, not a second calculation: the fold
 * of the award's event — `core.forfeit{by: loser, reason}`, exactly what an ordinary withdrawal walkover records — over
 * this fixture's cfg and sides, held in memory only (the ledger stays empty: nobody played, X-PS-1). The module's
 * summary reads the credit from its own `forfeitCredit` (football's `displayedGoals`, the set kernel's
 * `displayedSets`, …), and the state is the walkover's in every detail (its phase, its method). The fold's decision
 * must BE the stored award, or the score would describe a different result: that is refused, not written.
 */
export function awardedMatchState(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  outcome: MatchOutcome,
  at: { fixtureId: string; recordedAt: string },
): { state: unknown; summary: ScoreSummary } {
  if (outcome.kind !== "award") {
    throw new Error(`awardedMatchState: a "${outcome.kind}" is no award, and only an award is decided without play`);
  }
  if (outcome.loser === null) {
    throw new Error("awardedMatchState: a bye has no loser, and a bye credits no score");
  }
  const forfeit: EventEnvelope = {
    id: `awarded:${at.fixtureId}`,
    fixtureId: at.fixtureId,
    seq: 1,
    type: "core.forfeit",
    payload: { by: outcome.loser, reason: outcome.reason },
    recordedAt: at.recordedAt,
    recordedBy: null,
  };
  const folded = foldMatchWithStoppage(module, cfg as never, lineups, [forfeit]);
  const decided = outcomeOf(module, folded);
  if (!isDeepStrictEqual(decided, outcome)) {
    throw new Error(
      `awardedMatchState: the walkover folds to ${JSON.stringify(decided)}, not the stored ${JSON.stringify(outcome)}`,
    );
  }
  return { state: folded.state, summary: summaryOf(module, folded) };
}

/**
 * Writes `awardedMatchState` for one fixture into `match_states` — the cache every public read joins for `summary`
 * (`public_fixtures_v`) — at `last_seq` 0: no event was recorded, and none is (X-PS-1: the stats reader reads the
 * ledger, so the tie stays no match played; the forfeit is folded, never appended). Under the fixture's own resolved cfg (`resolveFixtureCfg`, the fold's) and
 * with her in her dead seat for the fold's sides — she is the award's loser, never seated (X-WD-3); `unseatedForfeitLoser`
 * is the one reader of whose seat it is.
 *
 * Called from the write that awards the tie. A reset of that award (`fed-seats.ts` `writePlan`) drops the row with it
 * (`clearAwardedMatchState`), so a row already here is a broken assumption, refused by name rather than overwriting a
 * cache some other write made. (A revived walkover — a voided double walkover's dead seat — never needs the clear: its
 * dead seat's feeder has no winner, so its award is a bye and wrote no row.)
 */
export async function writeAwardedMatchState(tx: Tx, fixtureId: string): Promise<void> {
  const [fixture] = await tx<
    {
      division_id: string;
      stage_id: string;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      config_snapshot: unknown;
      outcome: MatchOutcome | null;
    }[]
  >`
    select division_id, stage_id, home_entrant_id, away_entrant_id, config_snapshot, outcome
    from fixtures where id = ${fixtureId}`;
  if (!fixture) throw new Error(`writeAwardedMatchState: no fixture ${fixtureId}`);
  const home = fixture.home_entrant_id ?? unseatedForfeitLoser(fixture, "home");
  const away = fixture.away_entrant_id ?? unseatedForfeitLoser(fixture, "away");
  if (home === null || away === null || fixture.outcome === null) {
    throw new Error(`writeAwardedMatchState: ${fixtureId} is no award over a side that holds no seat`);
  }
  const [division] = await tx<{ config: unknown; sport_key: string; module_version: string }[]>`
    select config, sport_key, module_version from divisions where id = ${fixture.division_id}`;
  const [stage] = await tx<{ kind: string; config: Record<string, unknown> | null }[]>`
    select kind, config from stages where id = ${fixture.stage_id}`;
  if (!division) throw new Error(`writeAwardedMatchState: no division for ${fixtureId}`);
  const sportModule = resolveModule(division.sport_key, division.module_version);
  const cfg = resolveFixtureCfg(fixture.config_snapshot, division.config, stage, sportModule);
  const lineups = await loadLineupPair(tx, fixtureId, home, away);
  const { state, summary } = awardedMatchState(sportModule, cfg, lineups, fixture.outcome, {
    fixtureId,
    recordedAt: new Date().toISOString(),
  });
  const written = await tx`
    insert into match_states (fixture_id, last_seq, state, summary)
    values (${fixtureId}, 0, ${tx.json(state as never)}, ${tx.json(summary as never)})
    on conflict (fixture_id) do nothing
    returning fixture_id`;
  if (written.length === 0) {
    throw new Error(`writeAwardedMatchState: ${fixtureId} already holds a match state, and an award recorded without an event never overwrites one`);
  }
}

/**
 * R116-2 — the other half of `writeAwardedMatchState`: a write that puts an awarded tie back to `scheduled` (her feeder
 * voided, a dead seat revived) takes its score with it, or the re-opened tie would show the old walkover's credit as if
 * still decided — and the re-award would collide with it. Only a row with NO ledger behind it goes: that is the one the
 * award wrote, since every other `match_states` row is a fold of recorded events (append, rebuild) and stays theirs.
 */
export async function clearAwardedMatchState(tx: Tx, fixtureId: string): Promise<void> {
  await tx`
    delete from match_states m
    where m.fixture_id = ${fixtureId}
      and not exists (select 1 from score_events e where e.fixture_id = m.fixture_id)`;
}
