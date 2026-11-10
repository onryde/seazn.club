import "server-only";
// Carry-over from a completed stage into the next: bracket loser reads, the
// placement tables a progression resolves against, and `seedNextStage`.

import { withTenant } from "@/lib/db";
import { EngineError } from "@seazn/engine/core";
import { carryDeltas, placementTable, type BracketFixture, type PoolTable, type ProgressionSpec, type SourceShape, type SourceTables, type StandingsRow } from "@seazn/engine/competition";
import { parseExtKey, bracketWinnerLoser, loadCrossGroupRules } from "@/server/engine-db/competition";
import { assertAdvancingSeat, assertNoLevelSeat, fedSeatOccupant } from "@/server/engine-db/level-seat";
import { engineFixtureStatus as toBracketFixtureStatus } from "@/lib/fixture-engine-status";
import { resolveStoredProgression } from "../stored-progression";
import { attachFeedRefs, engineRoundOf, laneDepthOf } from "@/server/engine-db/bracket-rounds";
import { personalPointsLeaderboard } from "../americano";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { cutEligiblePools, departedLoseBestNth, resolveProgressionSource, sourceShapeOf, persistCrossGroupDraws } from "../stage-seeding";
import { STAGE_COLS, REAL_TABLE_KINDS, BRACKET_KINDS, type Tx, type StageRow } from "./types";
import { departedEntrantIds } from "./helpers";

// F6 (#625) — carry-over has TWO application paths now: seedNextStage (below,
// `timing:"on_complete"`) and the propose/confirm pair (computeSeedProposal /
// confirmSeedProposal, `timing:"setup"`). The three helpers here are what both
// read, so the pair cannot drift on WHICH sources may be carried from, WHAT
// the refusal says, or WHICH rows fold into the deltas.
//
// They deliberately stop short of throwing, because the two paths surface from
// DIFFERENT endpoints whose error vocabularies differ, and sharing the throw
// would have to pick one and break the other:
//
//   - seedNextStage's refusal leaves POST /stages/{id}/complete. It keeps its
//     EngineError CONFIG_INVALID — completeStage's catch swallows only
//     STAGE_NOT_READY, so this one propagates and reaches the client through
//     ENGINE_HTTP (api-v1/http.ts) as a 422. That is a shipped contract
//     qualification-from-any-stage.test.ts pins on all three non-real kinds.
//   - computeSeedProposal's refusal answers POST /stages/{id}/seed-proposal,
//     whose whole error vocabulary is SEEDING_* HttpErrors that
//     seeding-error.ts renders into localised organiser copy. An EngineError
//     raised there would reach the panel as raw English, the way
//     STAGE_NOT_READY's own unwired fallback still does.
//
// Sharing the SENTENCE gets the drift protection without either compromise.

/** The first carry source whose kind offers no points table to carry from, or
 *  `undefined` when every source is a REAL_TABLE_KINDS stage. */
export function nonRealCarrySource(
  resolved: readonly { id: string; kind: string }[],
): { id: string; kind: string } | undefined {
  return resolved.find((s) => !REAL_TABLE_KINDS.has(s.kind));
}

/** The one sentence both refusal sites raise. Named `kind` is the offending
 *  source's stage kind, not the target's.
 *
 *  Says "offers a finishing order" rather than the "completion has no real
 *  points" this carried from Jul3/05 until the F6 round-1 review: that older
 *  wording is false for an americano source, whose own completion snapshot
 *  DOES fold real points (over pair entrants) — see REAL_TABLE_KINDS above.
 *  What is true of every refused kind is the finishing order a progression
 *  reads from it. */
export function carrySourceRefusal(kind: string): string {
  return `carry-over needs a table-stage source (league/group/swiss) — a "${kind}" source offers a finishing order, not a points table`;
}

/** Opening deltas for a target stage: every source-table row belonging to an
 *  entrant that actually qualified, folded by the engine's own `carryDeltas`
 *  (competition/points.ts) — never re-implemented here. The filter is the
 *  load-bearing half: without it a knocked-out entrant's points would arrive
 *  in the next stage's opening table. */
export function buildCarryDeltas(
  tables: readonly SourceTables[],
  entrantIds: readonly string[],
  mode: "points" | "full",
): unknown[] {
  const qualified = new Set(entrantIds);
  const rows = tables.flatMap((t) => t.pools.flatMap((p) => p.rows)).filter((r) => qualified.has(r.entrantId));
  return carryDeltas(rows, mode);
}

/** One auditable `standings_carried` row — shared by seedNextStage and
 *  confirmSeedProposal so the two paths cannot drift on payload shape. */
export async function insertStandingsCarriedEvent(
  tx: Tx,
  divisionId: string,
  seq: number,
  payload: { stageId: string; from: string; mode: "points" | "full"; entrants: string[] },
): Promise<void> {
  await tx`
    insert into division_events (division_id, seq, type, payload)
    values (${divisionId}, ${seq}, 'standings_carried', ${tx.json(payload as never)})`;
}

// `toBracketFixtureStatus` (imported above from lib/fixture-engine-status as
// the ONE DB -> engine status mapping) exists here only to satisfy
// BracketFixture's required `status` field when rebuilding a completed
// bracket's own fixtures for `losersOfRound` below — resolveProgression's
// round_loser branch never actually reads status (round + loser only), but the
// type does.

// Rebuild the completed bracket's own BracketFixture[] for `roundLosers`
// (@seazn/engine/competition's progression.ts) — never re-derived from `standings_snapshots`, which
// only ever carries FINAL ranks, not which round a fixture belongs to.
// Before F1 (2026-08-17), `ext_key` was the only place a bracket fixture's
// lane/thirdPlace survived persistence, so this parsed it via engine-db/
// competition.ts's own parseExtKey (pass 2) rather than reading a column.
// `fixtures.lane`/`fixtures.third_place` now carry the same information
// directly (db/migration/deltas/V368__fixture_round_role.sql) — this
// function still derives from ext_key below because it hasn't been migrated
// to the new columns, not because ext_key is still the only source. Either
// way, never re-derive bracket position from round/seq_in_round: a
// bracket's rounds number sparsely (1,2,3 winners' side, 7-10 losers' side,
// 14 grand final).
// resolveProgression's round_loser branch trusts ITS CALLER for bracket-position
// order (there is nothing left for it to sort by) — `order by round_no,
// seq_in_round` below is what makes THIS the ordering authority.
// F3 review item 5 (RESOLVED) — exported so stage-seeding.ts's
// sourcesToTables (the `timing:"setup"` propose/confirm path's own table
// builder) can populate SourceTables.bracket too, not just this file's own
// seedNextStage/tablesForCompletedStage (the `timing:"on_complete"` path).
// Before this, sourcesToTables NEVER fetched bracket data at all — a
// roundLosers take rule under `timing:"setup"` (ko_plate's real catalogue
// shape once F3 flipped every picker template to day-one fixtures) could
// never resolve: progression.ts's loserAt throws STAGE_NOT_READY without
// `bracket`, silently swallowed by completeStage's best-effort catch, so an
// organiser's plate stage stayed on TBD forever with no visible error.
export async function loadBracketFixtures(tx: Tx, stageId: string): Promise<BracketFixture[]> {
  const rows = await tx<
    {
      id: string;
      round_no: number;
      status: string;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      outcome: unknown;
      ext_key: string | null;
      stage_kind: string;
      winner_to_fixture: string | null;
      winner_to_slot: number | null;
      loser_to_fixture: string | null;
      loser_to_slot: number | null;
    }[]
  >`
    select f.id, f.round_no, f.status, f.home_entrant_id, f.away_entrant_id, f.outcome, f.ext_key,
           s.kind as stage_kind, f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot
    from fixtures f join stages s on s.id = f.stage_id
    where f.stage_id = ${stageId}
    order by f.round_no, f.seq_in_round`;
  const seats = new Map(rows.map((r) => [r.id, [r.home_entrant_id, r.away_entrant_id] as const]));
  const laneDepth = laneDepthOf(rows.map((r) => ({ lane: parseExtKey(r.ext_key).bracket, roundNo: r.round_no })));
  const built = rows.map((f) => {
    // X-BR-1: the completed-bracket rebuild seats from these rows too (level-seat.ts).
    assertNoLevelSeat({ fixtureId: f.id, stageKind: f.stage_kind, status: f.status, outcome: f.outcome });
    // W2b D20: …and a double walkover in them seated nobody.
    assertAdvancingSeat({
      fixtureId: f.id,
      stageKind: f.stage_kind,
      status: f.status,
      outcome: f.outcome,
      seatedEntrant: fedSeatOccupant(f, (id) => seats.get(id) ?? null),
    });
    const { bracket, thirdPlace } = parseExtKey(f.ext_key);
    const { winner, loser, walkedOver } = bracketWinnerLoser(f.outcome, f.home_entrant_id, f.away_entrant_id);
    return {
      id: f.id,
      // C5/C9: the ENGINE's round - 0-based per lane. A stored `roundLosers.round` is translated at the
      // `resolveProgression` boundary (`resolveStoredProgression`), so the stored take rule keeps its meaning.
      round: engineRoundOf(f.round_no, bracket, laneDepth),
      status: toBracketFixtureStatus(f.status),
      ...(bracket !== undefined ? { bracket } : {}),
      ...(thirdPlace ? { thirdPlace: true } : {}),
      ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
      ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
      ...(winner !== undefined ? { winner } : {}),
      ...(loser !== undefined ? { loser } : {}),
      ...(walkedOver !== undefined ? { walkedOver } : {}),
    } satisfies BracketFixture as BracketFixture;
  });
  // C6/C14: the feed of every seat (`homeFrom`/`awayFrom`), inverted from the stored forward edges, so `firstLossField` and
  // the ranks can attribute a seat a withdrawal emptied.
  attachFeedRefs(new Map(built.map((b) => [b.id, b])), rows);
  return built;
}

export interface SeededStage {
  stage_id: string;
  entrants: string[];
}

// Resolve the next pending stage's progression against its source(s)' real
// placements. L3/#414 pass 3 — every stage kind now completes with a
// placement snapshot (pass 2's completeStageIfReady): table kinds (league/
// group/swiss) write REAL per-pool standings; bracket/ladder write a single
// placementTable-wrapped row (pool_id null). Both read the SAME way below —
// a null pool_id resolves to the unnamed pool "" / `overall`, so rankRange/
// topNPerGroup/bestNth/picks/roundLosers all just work. Americano is the one
// exception: its OWN standings_snapshot folds over ephemeral per-round PAIR
// entrants (Jul3/08 §3), not the persistent individual entrants the next
// stage draws from, so it re-ranks fresh from the personal-points
// leaderboard instead (usecases/americano.ts). Pool names in specs are the
// pools.key letters ('A'…); a single-table stage is the unnamed pool '' /
// `overall`.

/** An americano stage's ranked table, as the DOWNSTREAM stage must read it.
 *
 *  Rank by personal points, then map each ranked person to the division's
 *  persistent INDIVIDUAL entrant — never the ephemeral `pair` entrant a
 *  fixture actually ran on (pairEntrantsFor above); the next stage's
 *  generator only ever draws from real, registered division entrants
 *  (generateStageFixtures's `active` query).
 *
 *  Exported (F3 ultrareview finding 11) because this is NOT an optimisation
 *  — it is the only correct way to read an americano source, and it was
 *  forked. `tablesForCompletedStage` (the `on_complete` path, below) had it;
 *  `sourcesToTables` (stage-seeding.ts, the `timing:"setup"` propose/confirm
 *  path this session introduced) went straight to `sourceStandingsTables`,
 *  which reads `standings_snapshots` verbatim. An americano stage's own
 *  snapshot folds over the EPHEMERAL per-round pair entrants (Jul3/08 §3),
 *  so the setup path resolved qualifiers to pair-entrant ids that the next
 *  stage's roster does not contain — a silent wrong draw, the same class of
 *  defect as ruling 10's groups_ko pools-C/D miss, reachable the moment an
 *  organiser puts a `timing:"setup"` stage behind an americano. Two readers
 *  of one rule is the recurring bug in this area; now there is one. */
export async function americanoPlacementTables(
  tx: Tx,
  stageId: string,
  divisionId: string,
): Promise<PoolTable[]> {
  const leaderboard = await personalPointsLeaderboard(tx, stageId);
  const memberRows = await tx<{ entrant_id: string; person_id: string }[]>`
    select e.id as entrant_id, em.person_id
    from entrants e
    join entrant_members em on em.entrant_id = e.id
    where e.division_id = ${divisionId} and e.kind = 'individual'`;
  const entrantOf = new Map(memberRows.map((r) => [r.person_id, r.entrant_id]));
  const ordered = leaderboard
    .map((row) => entrantOf.get(row.person_id))
    .filter((id): id is string => id !== undefined);
  return [placementTable(ordered)];
}

/** Build the SourceTables (pools + bracket) a COMPLETED stage offers a
 *  downstream progression — factored out of seedNextStage's own inline
 *  construction (unchanged logic: the americano/table/bracket branches
 *  below are byte-identical to what this function replaces) so it can run
 *  once per DISTINCT source a multi-source progression names (Decision 4),
 *  not just the one stage that just completed. */
async function tablesForCompletedStage(
  tx: Tx,
  stage: { id: string; kind: string },
  divisionId: string,
): Promise<SourceTables> {
  let pools: PoolTable[];
  if (stage.kind === "americano") {
    pools = await americanoPlacementTables(tx, stage.id, divisionId);
  } else {
    // Ranked tables from the completion snapshot(s); translate pool uuids
    // back to their spec-facing keys.
    const poolRows = await tx<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${stage.id}`;
    const keyOf = new Map(poolRows.map((p) => [p.id, p.key]));
    const snapshots = await tx<{ pool_id: string | null; rows: StandingsRow[] }[]>`
      select pool_id, rows from standings_snapshots where stage_id = ${stage.id}`;
    if (snapshots.length === 0) {
      throw new EngineError("STAGE_NOT_READY", "completed stage has no standings snapshots", {
        stageId: stage.id,
      });
    }
    pools = snapshots.map((s) => ({
      pool: s.pool_id ? (keyOf.get(s.pool_id) ?? s.pool_id) : "",
      rows: s.rows,
    }));
  }
  // W3 T15 Carry A (controller ruling 2026-11-02): a Swiss source's departed entrants leave its cut and the next eligible
  // entrant backfills — the same tables the `setup` path's proposal reads (stage-seeding.ts `sourcesToTables`); since W4
  // T13 (RB4-V6) a league's or a group's too (`CUT_SKIPS_DEPARTED_KINDS`). Every other kind is returned as it was:
  // `config.qualified` keeps a departed qualifier and generation's `walkoverDepartedQualifiers` walks her opponent over —
  // a KNOCKOUT source's lucky loser (RB4-V2) is the `setup` path's (every shipped template's timing), not this one's.
  pools = cutEligiblePools(stage.kind, pools, await departedEntrantIds(tx, divisionId));
  // roundLosers (a bracket-kind source's take rule) reads the completed
  // bracket's OWN fixtures, never the standings_snapshot (final ranks only,
  // not per-round results) — only a bracket-kind source has any, so this is
  // a cheap no-op query result for every other kind.
  const bracket = BRACKET_KINDS.has(stage.kind) ? await loadBracketFixtures(tx, stage.id) : undefined;
  // W2d T12 (spec §5.9, X-TB-7): best-Nth compares groups by THIS stage's pinned cross-group order and its stored
  // cross-group draws — only a real table has them (an americano or bracket source has no cross-group comparison).
  const crossGroup = REAL_TABLE_KINDS.has(stage.kind) ? await loadCrossGroupRules(tx, stage.id) : undefined;
  return { pools, ...(bracket ? { bracket } : {}), ...(crossGroup ? { crossGroup } : {}) };
}

export async function seedNextStage(auth: AuthCtx, completedStageId: string): Promise<SeededStage | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [current] = await tx<{ division_id: string; seq: number; kind: string }[]>`
      select division_id, seq, kind from stages where id = ${completedStageId}`;
    if (!current) return null;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + current.division_id}))`;

    const [next] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages
      where division_id = ${current.division_id} and seq > ${current.seq}
      order by seq limit 1`;
    if (!next || !next.progression) return null;
    const progression = next.progression as unknown as ProgressionSpec & {
      timing: "setup" | "on_complete";
      carry?: "none" | "points" | "full";
    };
    if (progression.timing !== "on_complete") return null;
    if (Array.isArray(next.config.qualified)) {
      // Already seeded (idempotent re-complete).
      return { stage_id: next.id, entrants: next.config.qualified as string[] };
    }

    // The just-completed stage's OWN tables — built once, reused below if
    // it's named as (one of) the progression's sources, never re-queried.
    const currentTables = await tablesForCompletedStage(
      tx,
      { id: completedStageId, kind: current.kind },
      current.division_id,
    );

    const shapes: SourceShape[] = [];
    const sourceTables: SourceTables[] = [];
    const resolvedSources: { id: string; kind: string }[] = [];
    for (const s of progression.sources) {
      const source = await resolveProgressionSource(tx, next, s.stage);
      resolvedSources.push(source);
      shapes.push(await sourceShapeOf(tx, source));
      // ANY OTHER named source must be complete NOW too, or this throws
      // STAGE_NOT_READY — caught by completeStage's existing best-effort
      // try/catch (Decision 4), same as today's single-source contract.
      if (source.id === completedStageId) {
        sourceTables.push(currentTables);
      } else {
        const [srcRow] = await tx<{ status: string }[]>`select status from stages where id = ${source.id}`;
        if (srcRow?.status !== "complete") {
          throw new EngineError("STAGE_NOT_READY", "a progression source stage is not complete yet", {
            stageId: source.id,
          });
        }
        sourceTables.push(await tablesForCompletedStage(tx, source, current.division_id));
      }
    }
    // A2 (round-4 review) — `next` here IS the progression's own target
    // (seedNextStage seeds INTO it), so `next.kind` is the real targetKind
    // ruling 13's snake/bracket-target guard needs on this resolution path
    // too, not just at createStages' save-time validateStageProgression call.
    const { qualifiers, newLotsDraws } = resolveStoredProgression(
      progression,
      shapes,
      departedLoseBestNth(sourceTables, resolvedSources, await departedEntrantIds(tx, current.division_id)),
      next.kind,
      resolvedSources.map((r) => r.kind),
    );
    // W2d T12 (spec §5.9): a cross-group draw best-Nth made is stored with its source, under the division lock held above.
    await persistCrossGroupDraws(tx, resolvedSources, newLotsDraws);
    const entrants = qualifiers.map((q) => q.entrantId);
    log.info(
      { event: "qualification_resolved", stageId: completedStageId, nextStageId: next.id, kind: current.kind, count: entrants.length },
      "qualification_resolved",
    );

    // Carry-over (Jul3/05 §3): seed the next stage with opening deltas from
    // its source(s)' tables — prior points/metrics arrive as data, prior H2H
    // is never replayed. Only a REAL table source has real points to carry
    // (REAL_TABLE_KINDS); a bracket/ladder/americano source is refused
    // outright rather than silently carrying fabricated zeros. Generalised
    // from "the one implicit source" to "every named source" (Decision 4).
    //
    // NOT deleted despite this plan's Decision (Task 5 Step 3 / Task 6 Step
    // 6): grounding said "no shipped writer sets `.carry`", true for
    // format-templates.ts/the catalogue but not for the whole codebase —
    // custom-points.test.ts exercises it end to end against a hand-built
    // stage graph, and it backs a MARKETED entitlement
    // (standings.carry_over — feature-copy.ts's paywall copy,
    // pricing.matrix.standings.carry_over in all 4 marketing dictionaries;
    // free on every plan since V471). Deleting it would silently break an
    // advertised feature. `carry`
    // is, like `timing`, an apps/web/DB-orchestration concept the engine's
    // pure ProgressionSpec has no notion of — see ProgressionSchema.
    //
    // The kind check and the delta fold moved to nonRealCarrySource /
    // carrySourceRefusal / buildCarryDeltas (above, beside REAL_TABLE_KINDS) in
    // F6, unchanged in behaviour — the `timing:"setup"` propose path reads the
    // same helpers, so the two cannot drift on which sources are refusable, the
    // sentence, or which rows fold in. The EngineError stays HERE: see those
    // helpers' comment for why each path keeps its own error type.
    const carryMode = progression.carry ?? "none";
    let carriedDeltas: unknown[] | undefined;
    // Narrowed separately from `carryMode` — the event write sits outside the
    // `!== "none"` block (after `stage_seeded`), and TS does not retain the
    // narrowing across that gap (`carriedDeltas !== undefined` alone is not
    // enough to prove mode is points|full).
    let carriedMode: "points" | "full" | undefined;
    if (carryMode !== "none") {
      const nonReal = nonRealCarrySource(resolvedSources);
      if (nonReal) {
        throw new EngineError("CONFIG_INVALID", carrySourceRefusal(nonReal.kind), {
          stageId: nonReal.id,
          kind: nonReal.kind,
          carry: carryMode,
        });
      }
      carriedMode = carryMode;
      carriedDeltas = buildCarryDeltas(sourceTables, entrants, carryMode);
    }
    // Server-side merge, not a spread of `next.config` read earlier in this
    // transaction (design §T2): any other key written between that read and
    // this write — a per-stage `rules` override, most immediately — would
    // otherwise be silently reverted. Not `stages/` folder's write-once `rounds`
    // pattern: that one is guarded `and config->>'rounds' is null`, which is
    // right for a key set once and wrong for one that must stay replaceable.
    await tx`
      update stages set config = config || ${tx.json({
        qualified: entrants,
        ...(carriedDeltas !== undefined ? { carry_deltas: carriedDeltas } : {}),
      } as never)}
      where id = ${next.id}`;

    // Structural ledger + division watermark (same pattern as stage_completed).
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${current.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload)
      values (${current.division_id}, ${last + 1}, 'stage_seeded',
              ${tx.json({ stageId: next.id, from: completedStageId, entrants } as never)})`;
    let seq = last + 1;
    if (carriedDeltas !== undefined && carriedMode !== undefined) {
      // auditable carry (Jul3/05 §3)
      seq += 1;
      await insertStandingsCarriedEvent(tx, current.division_id, seq, {
        stageId: next.id,
        from: completedStageId,
        mode: carriedMode,
        entrants,
      });
    }
    await tx`update divisions set seq = ${seq} where id = ${current.division_id}`;

    return { stage_id: next.id, entrants };
  });
}