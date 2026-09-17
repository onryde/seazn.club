import "server-only";
// Player statistics (Jul3/07 §2–§7): the derived fold over score_events —
// recompute-on-read into player_stat_snapshots (disposable cache), division-
// scoped leaderboards, per-person cards, consent-filtered public tables.
import type postgres from "postgres";
import {
  aggregatePlayerStatsWithDiagnostics,
  sumPlayerStats,
  type PlayerStatRow,
} from "@seazn/engine/stats";
import type { EventEnvelope } from "@seazn/engine/core";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import { resolvePersonDisplayName } from "@/lib/name-display";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveFixtureCfg, resolveModule } from "@/server/engine-db";
import { loadLineupPairsForDivision } from "@/server/engine-db/lineups";
import { entrantFoldCtx, loadEntrantMembersForDivision } from "@/server/engine-db/entrant-members";
import { log } from "@/server/logger";
import { groupCareerStatsBySport, type CareerSnapshotRow, type CareerSportStats } from "@/server/player-stats";
import { DEFAULT_LOCALE } from "@/lib/i18n-constants";
import { resolveLocale } from "@/lib/resolve-locale";
import { msgFor } from "@/lib/messages-i18n";
import { playerLinkId } from "@/lib/name-display";

type Tx = postgres.TransactionSql;

interface EventRow {
  fixture_id: string;
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: Date;
  voids_event_id: string | null;
}

/** Follow `persons.merged_into` to a person who is not themselves a tombstone
 *  (#404). A merge flattens every inbound tombstone onto the new survivor, so
 *  one hop is the invariant — the walk is the belt to that braces, and its cap
 *  means a chain that somehow cycled degrades to a wrong-but-terminating
 *  attribution rather than hanging every stats read in the division. */
function liveSurvivor(personId: string, survivorOf: ReadonlyMap<string, string>): string {
  let id = personId;
  for (let hops = 0; hops < 16; hops += 1) {
    const next = survivorOf.get(id);
    if (next === undefined || next === id) break;
    id = next;
  }
  return id;
}

/** The advisory-lock key that serialises every write of ONE division's
 *  `player_stat_snapshots`. Its own `player-stats:` namespace, never
 *  `division:` — schedule and history hold that one, and a stats fold must not
 *  queue behind a schedule apply. Lower-cased: `z.uuid()` accepts either case,
 *  Postgres hands back lower case, and two spellings of one id would otherwise
 *  hash to two locks. */
function playerStatsLockKey(divisionId: string): string {
  return `player-stats:${divisionId.toLowerCase()}`;
}

/** Take the division's stats lock, waiting for it, until the transaction ends.
 *  Re-entrant within one transaction. A caller that locks SEVERAL divisions
 *  takes them in ascending id order (`lockPlayerStatsDivisions`). */
export async function lockPlayerStats(tx: Tx, divisionId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${playerStatsLockKey(divisionId)}))`;
}

/** Every division's stats lock, in ascending id order — the ONE ordering
 *  authority for every transaction that WAITS on more than one division (person
 *  merge and unmerge), so no two of them can each hold a division the other is
 *  waiting on. Call it before the first fold and before any row lock: a fold's
 *  own lock is taken in whatever order the caller iterates. The read paths
 *  (`personStats`, the digest) take try-locks instead and never wait
 *  (`playerStatsWithoutWaiting`). `player-stats-lock-order.test.ts` pins that. */
export async function lockPlayerStatsDivisions(tx: Tx, divisionIds: readonly string[]): Promise<void> {
  const sorted = [...new Set(divisionIds.map((id) => id.toLowerCase()))].sort();
  for (const id of sorted) await lockPlayerStats(tx, id);
}

/** Take the division's stats lock only if it is free. `false` means another
 *  transaction is folding this division right now. */
export async function tryLockPlayerStats(tx: Tx, divisionId: string): Promise<boolean> {
  const [row] = await tx<{ locked: boolean }[]>`
    select pg_try_advisory_xact_lock(hashtext(${playerStatsLockKey(divisionId)})) as locked`;
  return row?.locked === true;
}

/** md5 over every input of a division's player-stats fold OTHER than the
 *  score events: the division's sport, module and config; each SETTLED fixture
 *  (no longer in play: decided, finalized, forfeited, abandoned or cancelled)
 *  with events: its stage, entrants, frozen config, stage config and lineups;
 *  the roster; the org's merge tombstones. `player_stat_folds`
 *  stores it beside the ledger the fold read (V409), and
 *  `playerStatsCoverage` compares both against the database as it stands.
 *  Settled fixtures only: a match in play reaches the snapshot at its next
 *  refresh by design (its events are in the ledger check), and hashing it
 *  would make its first event, or a lineup edit during play, read as a
 *  snapshot owed a refresh on every stats read (`reconcilePlayerStatsOnRead`).
 *  Every nullable value is coalesced: `concat_ws` skips NULLs, so an absent
 *  home entrant and an absent away entrant would otherwise hash the same.
 *  The tombstones are the WHOLE org's (final review m3, accepted): a merge or
 *  unmerge changes every division's md5 once, so each division reads as owed
 *  once and refolds at its next refresh or stats read. Narrowing them to the
 *  persons a division's events and rosters name would need the event payloads
 *  read here, which costs every check more than one refold wave per merge. */
export async function playerStatsInputsMd5(tx: Tx, divisionId: string): Promise<string> {
  const [row] = await tx<{ md5: string }[]>`
    select md5(concat_ws('|',
      (select concat_ws(':', d.sport_key, d.module_version, md5(coalesce(d.config::text, '-')))
         from divisions d where d.id = ${divisionId}),
      (select string_agg(concat_ws(':', f.id, f.stage_id, coalesce(f.home_entrant_id::text, '-'),
                                   coalesce(f.away_entrant_id::text, '-'),
                                   md5(coalesce(f.config_snapshot::text, '-')), md5(coalesce(s.config::text, '-'))),
                         ',' order by f.id)
         from fixtures f join stages s on s.id = f.stage_id
        where f.division_id = ${divisionId}
          and not (f.status = any(${IN_PLAY_FIXTURE_STATUSES as string[]}))
          and exists (select 1 from score_events se where se.fixture_id = f.id)),
      (select string_agg(concat_ws(':', e.id, e.kind, coalesce(em.person_id::text, '-')), ','
                         order by e.id, em.person_id)
         from entrants e left join entrant_members em on em.entrant_id = e.id
        where e.division_id = ${divisionId}),
      (select string_agg(concat_ws(':', l.fixture_id, l.entrant_id, l.person_id, coalesce(l.slot, '-'),
                                   coalesce(l.position_key, '-'), coalesce(l.order_no::text, '-'),
                                   coalesce(l.roles::text, '-'), coalesce(l.role, '-'),
                                   coalesce(em.squad_number::text, '-')),
                         ',' order by l.fixture_id, l.entrant_id, l.person_id)
         from lineups l
         join fixtures f on f.id = l.fixture_id
         left join entrant_members em on em.entrant_id = l.entrant_id and em.person_id = l.person_id
        where f.division_id = ${divisionId}
          and not (f.status = any(${IN_PLAY_FIXTURE_STATUSES as string[]}))
          and exists (select 1 from score_events se where se.fixture_id = f.id)),
      (select string_agg(p.id::text || '>' || p.merged_into::text, ',' order by p.id)
         from persons p where p.merged_into is not null and p.org_id = current_org_id())
    )) as md5`;
  return row!.md5;
}

/** One fixture whose (event count, max seq) differs from the last fold's ledger
 *  map, or that is in only one of the two. */
export interface PlayerStatsDrift {
  fixtureId: string;
  /** The snapshot is owed this fixture's events: the fixture is gone, or is
   *  settled now (a result, or abandoned or cancelled, final review m2). False
   *  for a match still in play, whose events reach the snapshot at its next
   *  refresh by design (goals in play do not schedule one). A result undone
   *  since the fold is owed through the inputs md5 instead, which hashes the
   *  set of settled fixtures. */
  owed: boolean;
}

/** Does the division's snapshot reflect the database as it stands?
 *  - `covered`: the last fold's ledger map matches every fixture's (event
 *    count, max seq) now, fixture for fixture, AND its inputs md5 matches. A
 *    deleted scored fixture, an appended event and a re-snapshotted config
 *    each break it; so does a division that was never folded (no
 *    `player_stat_folds` row).
 *  - `owed`: the snapshot is behind by something a refresh should already have
 *    folded: an owed drift, or a changed inputs md5, or (never folded) a
 *    settled fixture with events. Drift from matches in play alone is not owed,
 *    so a read that finds only that queues nothing (`reconcilePlayerStatsOnRead`).
 *  `token` names the last fold (its time and inputs), so a caller can tell
 *  whether it has already cleared the public caches for it. Read it under the
 *  division's stats lock where a fold committing mid-read matters. */
export interface PlayerStatsCoverage {
  covered: boolean;
  owed: boolean;
  drift: readonly PlayerStatsDrift[];
  /** Whether the inputs md5 still matches. Null when it was not computed: no
   *  fold record, or an owed drift, which already answers every question. */
  inputsSame: boolean | null;
  /** Rows the last fold wrote; null when there is no fold record. */
  rowCount: number | null;
  /** The last fold's ledger map, {fixture_id: [event_count, max_seq]}. */
  ledger: Readonly<Record<string, readonly [number, number]>> | null;
  token: string | null;
}

export async function playerStatsCoverage(tx: Tx, divisionId: string): Promise<PlayerStatsCoverage> {
  const [rec] = await tx<
    { ledger: Record<string, [number, number]>; inputs_md5: string; row_count: number; token: string }[]
  >`
    select ledger, inputs_md5, row_count, folded_at::text || '/' || inputs_md5 as token
    from player_stat_folds where division_id = ${divisionId}`;
  // The record's ledger is passed back in, so both statements compare the SAME
  // fold even if another one commits between them.
  const drift = await tx<{ fixture_id: string; owed: boolean }[]>`
    with cur as (
      select se.fixture_id::text as fixture_id, count(*)::int as n, max(se.seq)::int as m,
             bool_or(not (f.status = any(${IN_PLAY_FIXTURE_STATUSES as string[]}))) as settled
      from score_events se join fixtures f on f.id = se.fixture_id
      where f.division_id = ${divisionId}
      group by se.fixture_id
    ), rec as (
      select l.key as fixture_id, (l.value->>0)::int as n, (l.value->>1)::int as m
      from jsonb_each(${tx.json((rec?.ledger ?? {}) as never)}::jsonb) l
    )
    select coalesce(cur.fixture_id, rec.fixture_id) as fixture_id,
           (cur.fixture_id is null or coalesce(cur.settled, false)) as owed
    from cur full join rec on rec.fixture_id = cur.fixture_id
    where cur.fixture_id is null or rec.fixture_id is null or rec.n <> cur.n or rec.m <> cur.m`;
  const owedDrift = drift.some((d) => d.owed);
  const inputsSame =
    rec !== undefined && !owedDrift ? (await playerStatsInputsMd5(tx, divisionId)) === rec.inputs_md5 : null;
  return {
    covered: rec !== undefined && drift.length === 0 && inputsSame === true,
    owed: owedDrift || inputsSame === false,
    drift: drift.map((d) => ({ fixtureId: d.fixture_id, owed: d.owed })),
    inputsSame,
    rowCount: rec?.row_count ?? null,
    ledger: rec?.ledger ?? null,
    token: rec?.token ?? null,
  };
}

/** Is a refresh owed that a read should queue (owner ruling 2026-09-17, m8)?
 *  False for a sport that declares no player stats: it never gets a fold
 *  record, and would otherwise read as owed for ever. */
export async function playerStatsOwed(tx: Tx, divisionId: string): Promise<boolean> {
  const division = await loadStatsDivision(tx, divisionId);
  if (resolveModule(division.sport_key, division.module_version).playerStats === undefined) return false;
  return (await playerStatsCoverage(tx, divisionId)).owed;
}

/** Fixture statuses still in play, for the coverage check and the inputs md5.
 *  Every other status is settled: decided, finalized and forfeited, and also
 *  abandoned and cancelled, whose events the fold reads too (final review m2:
 *  a match abandoned after a goal schedules no refresh, so only a read that
 *  counts it as owed ever folds that goal; `recomputePlayerStats` puts no
 *  status filter on its events read). `fixtures.status`'s check constraint
 *  lists them all (`db/migration/v2-engine/tables/V214__fixtures.sql`). */
const IN_PLAY_FIXTURE_STATUSES: readonly string[] = ["scheduled", "in_play"];

interface StatsDivision {
  sport_key: string;
  module_version: string;
  config: unknown;
}

/** Refold every fixture's ledger into the division snapshot (Jul3/07 §2 —
 *  rebuildable at any time; the CI-style consistency check refolds and
 *  compares). Returns the fresh rows.
 *
 *  `throughSeq` is the number of score events the fold read. The fold also
 *  records what it read in `player_stat_folds` (V409): the ledger map from its
 *  OWN events read, and the md5 of its other inputs taken BEFORE that read —
 *  so a write landing mid-fold is folded but not stamped, and costs a later
 *  refold rather than a skipped one (`playerStatsCoverage`).
 *
 *  The division's stats lock is the FIRST statement. Without it, two folds of
 *  one division interleave: the second reads the ledger before the first
 *  one's score commits, then deletes and rewrites the first one's rows with
 *  that older picture, and the last writer wins with stale numbers. Under READ
 *  COMMITTED the select that follows the lock takes a fresh snapshot, so a
 *  fold that waited sees everything committed before it got the lock. */
export async function recomputePlayerStats(
  tx: Tx,
  divisionId: string,
): Promise<{ rows: PlayerStatRow[]; throughSeq: number; hasModel: boolean }> {
  await lockPlayerStats(tx, divisionId);
  const division = await loadStatsDivision(tx, divisionId);
  const model = resolveModule(division.sport_key, division.module_version).playerStats;
  if (model === undefined) return { rows: [], throughSeq: 0, hasModel: false };
  const inputsMd5 = await playerStatsInputsMd5(tx, divisionId);
  const { rows, throughSeq, ledger } = await foldDivision(tx, divisionId, division, model);

  await tx`delete from player_stat_snapshots where division_id = ${divisionId}`;
  for (const row of rows) {
    await tx`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${divisionId}, ${row.personId}, ${division.sport_key},
              ${tx.json(row.stats as never)}, ${throughSeq})
      on conflict (division_id, person_id) do update
        set stats = excluded.stats, computed_through_seq = excluded.computed_through_seq,
            updated_at = now()`;
  }
  await tx`
    insert into player_stat_folds (division_id, ledger, inputs_md5, row_count)
    values (${divisionId}, ${tx.json(ledger as never)}, ${inputsMd5}, ${rows.length})
    on conflict (division_id) do update
      set ledger = excluded.ledger, inputs_md5 = excluded.inputs_md5,
          row_count = excluded.row_count, folded_at = now()`;
  return { rows, throughSeq, hasModel: true };
}

/** The same fold as `recomputePlayerStats`, in memory only: no lock, no write.
 *  For a caller that must not wait on another transaction's fold and cannot
 *  use a snapshot that is behind (an auto-post draft, `org-posts.ts`). */
export async function computePlayerStats(
  tx: Tx,
  divisionId: string,
): Promise<{ rows: PlayerStatRow[]; hasModel: boolean }> {
  const division = await loadStatsDivision(tx, divisionId);
  const model = resolveModule(division.sport_key, division.module_version).playerStats;
  if (model === undefined) return { rows: [], hasModel: false };
  const { rows } = await foldDivision(tx, divisionId, division, model);
  return { rows, hasModel: true };
}

/** The snapshot rows as they stand, for a caller that serves them rather than
 *  refolding. */
export async function readPlayerStatSnapshot(tx: Tx, divisionId: string): Promise<PlayerStatRow[]> {
  const rows = await tx<{ person_id: string; stats: Record<string, number> }[]>`
    select person_id, stats from player_stat_snapshots where division_id = ${divisionId}`;
  return rows.map((r) => ({ personId: r.person_id, stats: r.stats }));
}

/** Where a read's rows came from: the snapshot as it stands, a fold this call
 *  wrote, or a fold in memory that wrote nothing. */
export type PlayerStatsServed = "snapshot" | "folded" | "memory";

/** Current rows for a request that must not wait on another transaction's fold
 *  and cannot use rows behind the ledger (review I3, n3): the console
 *  leaderboard, the player card, the digest, and the auto-post drafts (written
 *  once, so no later refresh corrects them). Never waits on the stats lock:
 *  - the snapshot already covers the ledger: serve it, fold nothing;
 *  - behind, lock free: refold and write;
 *  - behind, lock held: fold in memory and write nothing. The holder is
 *    folding it.
 *  When the snapshot is behind a result (`owed`), it also queues the division's
 *  refresh, so the public copies built from the old rows are cleared once the
 *  new rows land (a refresh lost to a restart heals here too, m8).
 *  With the lock held elsewhere, the coverage read can see a fold commit
 *  between its statements. Each statement sees a state no older than the one
 *  before, so that only makes what is served newer than the check, never older.
 *  Concurrent in-memory folds of one division are not combined (final review
 *  m4, accepted): each such read folds on its own. They happen only while
 *  another fold holds the lock, so they are bounded by the requests in flight
 *  in that window, and each costs what every read cost before the snapshot
 *  existed. Sharing one would need a per-process promise map keyed by the
 *  ledger state, which a fold in another process could not join anyway. */
export async function playerStatsWithoutWaiting(
  tx: Tx,
  divisionId: string,
): Promise<{ rows: PlayerStatRow[]; hasModel: boolean; served: PlayerStatsServed }> {
  const free = await tryLockPlayerStats(tx, divisionId);
  const coverage = await playerStatsCoverage(tx, divisionId);
  if (coverage.covered) {
    return { rows: await readPlayerStatSnapshot(tx, divisionId), hasModel: true, served: "snapshot" };
  }
  const { rows, hasModel } = free ? await recomputePlayerStats(tx, divisionId) : await computePlayerStats(tx, divisionId);
  if (hasModel && coverage.owed) await queueRefreshFromRead(tx, divisionId);
  return { rows, hasModel, served: free ? "folded" : "memory" };
}

/** Queue the division's refresh from inside a read. Imported lazily: the
 *  refresh module imports this one. */
async function queueRefreshFromRead(tx: Tx, divisionId: string): Promise<void> {
  const [division] = await tx<{ org_id: string }[]>`select org_id from divisions where id = ${divisionId}`;
  if (!division) return;
  const { schedulePlayerStatsRefresh } = await import("./player-stats-refresh");
  schedulePlayerStatsRefresh(division.org_id, { divisionId });
}

async function loadStatsDivision(tx: Tx, divisionId: string): Promise<StatsDivision> {
  const [division] = await tx<StatsDivision[]>`
    select sport_key, module_version, config from divisions where id = ${divisionId}`;
  if (!division) throw new HttpError(404, "division not found");
  return division;
}

async function foldDivision(
  tx: Tx,
  divisionId: string,
  division: StatsDivision,
  model: NonNullable<ReturnType<typeof resolveModule>["playerStats"]>,
): Promise<{ rows: PlayerStatRow[]; throughSeq: number; ledger: Record<string, [number, number]> }> {
  const events = await tx<EventRow[]>`
    select se.fixture_id, se.id, se.seq, se.type, se.payload, se.recorded_at, se.voids_event_id
    from score_events se
    join fixtures f on f.id = se.fixture_id
    where f.division_id = ${divisionId}
    order by se.fixture_id, se.seq`;

  const byFixture = new Map<string, EventEnvelope[]>();
  let throughSeq = 0;
  // {fixture_id: [event_count, max_seq]} of exactly this read (V409).
  const ledgerMap: Record<string, [number, number]> = {};
  for (const e of events) {
    throughSeq += 1;
    const seen = ledgerMap[e.fixture_id];
    ledgerMap[e.fixture_id] = [(seen?.[0] ?? 0) + 1, Math.max(seen?.[1] ?? 0, Number(e.seq))];
    const envelope = {
      id: e.id,
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      recordedAt: e.recorded_at.toISOString(),
      ...(e.voids_event_id !== null ? { voids: e.voids_event_id } : {}),
    } as EventEnvelope;
    (byFixture.get(e.fixture_id) ?? byFixture.set(e.fixture_id, []).get(e.fixture_id)!).push(envelope);
  }
  // S4 (#428) review round 1, finding 1 — the person-role discriminator:
  // a card/goal credited to a non-player (coach/staff, S3 ruling 3) must not
  // earn a leaderboard row. ONE query for the whole division (matching the
  // events query's own batching above), keyed per fixture — each fixture's
  // OWN lineup, not the division's, since two fixtures for the same entrant
  // can field different coaches/rosters.
  const lineupsByFixture = await loadLineupPairsForDivision(tx, divisionId);
  // S8/#417 — the entrant→person fallback needs two more division-batched
  // inputs, matching the lineup load's own batching shape: every entrant's
  // roster (kind + members, for ctx.entrants/personsOf) and, per fixture,
  // the cfg the WRITE path actually folded it under (V347's frozen
  // config_snapshot, falling back to the live stage-scoped division config —
  // same resolver `fold.ts`'s read path uses). `ctx.cfg` is load-bearing: the
  // setbased/nested/boardgame/carrom/generic `folded` fold replays the
  // module's own scoring cascade off it to derive sets_won/matches, and
  // silently degrades to matches-only without it (stats.ts's
  // PlayerStatsFoldCtx.cfg docstring is stale — it is read).
  const entrantMembers = await loadEntrantMembersForDivision(tx, divisionId);
  const fixtureInfoRows = await tx<
    {
      id: string;
      stage_id: string;
      config_snapshot: unknown;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
    }[]
  >`
    select id, stage_id, config_snapshot, home_entrant_id, away_entrant_id
    from fixtures where division_id = ${divisionId}`;
  const stageIds = [...new Set(fixtureInfoRows.map((r) => r.stage_id))];
  const stageConfigById = new Map(
    stageIds.length === 0
      ? []
      : (
          await tx<{ id: string; config: Record<string, unknown> | null }[]>`
            select id, config from stages where id in ${tx(stageIds)}`
        ).map((r) => [r.id, r.config] as const),
  );
  const fixtureInfoById = new Map(fixtureInfoRows.map((r) => [r.id, r]));

  const perFixtureResults = [...byFixture.entries()].map(([fixtureId, ledger]) => {
    const info = fixtureInfoById.get(fixtureId);
    const cfg = resolveFixtureCfg(
      info?.config_snapshot,
      division.config,
      info ? stageConfigById.get(info.stage_id) : undefined,
    );
    const ctx = entrantFoldCtx(
      info?.home_entrant_id ?? null,
      info?.away_entrant_id ?? null,
      entrantMembers,
      cfg,
    );
    return aggregatePlayerStatsWithDiagnostics(ledger, model, lineupsByFixture.get(fixtureId), ctx);
  });
  const perFixture = perFixtureResults.map((r) => r.rows);
  // #404: a merged person's id still appears in every historical score event,
  // and this fold reads the person id out of the payload — so without a
  // relabel a refold rebuilds a snapshot row for the tombstone and the
  // survivor never inherits those stats. One org-scoped lookup per recompute,
  // not one per fixture; `withTenant` has already set current_org_id().
  // The relabel happens BEFORE sumPlayerStats so the engine's own summation
  // combines the two histories and re-derives ratio metrics; relabelling after
  // the sum would mean re-implementing that arithmetic here.
  const tombstones = await tx<{ id: string; merged_into: string }[]>`
    select id, merged_into from persons
    where merged_into is not null and org_id = current_org_id()`;
  const survivorOf = new Map(tombstones.map((r) => [r.id, r.merged_into]));
  const relabelled = perFixture.map((fixture) =>
    fixture.map((row) => {
      const survivor = liveSurvivor(row.personId, survivorOf);
      return survivor === row.personId ? row : { ...row, personId: survivor };
    }),
  );
  const rows = sumPlayerStats(relabelled, model);

  // S8/#417 — structured logging (owner standing rule: all new code logs).
  // A recompute pass, and what its entrant-fallback attribution actually
  // did, would otherwise be invisible in production — merge every fixture's
  // diagnostics into one division-level picture and log it.
  const diagnostics = perFixtureResults.reduce(
    (acc, r) => {
      acc.fromPersonField += r.diagnostics.fromPersonField;
      acc.fromEntrantFallback += r.diagnostics.fromEntrantFallback;
      acc.unattributed += r.diagnostics.unattributed;
      for (const id of r.diagnostics.unknownEntrants) acc.unknownEntrants.add(id);
      for (const id of r.diagnostics.teamEntrantsSkipped) acc.teamEntrantsSkipped.add(id);
      // The `folded` path carries production stats for 8 of the 11 modules —
      // W/D/L, sets/games won, keeper clean sheets — so a recompute that
      // logged only the metric loop would be blind to most of what it just
      // computed. Counted per FIXTURE (a boolean per fixture, summed) rather
      // than per credit: "3 of 9 fixtures folded nothing" is the shape that
      // tells you something is wrong, where a bare total does not.
      acc.foldedFixtures += r.diagnostics.foldedRan ? 1 : 0;
      acc.foldedRows += r.diagnostics.foldedRows;
      acc.foldedCredits += r.diagnostics.foldedCredits;
      acc.foldedEmptyFixtures += r.diagnostics.foldedEmpty ? 1 : 0;
      acc.foldedOutOfScopeFixtures += r.diagnostics.foldedEntrantsOutOfScope ? 1 : 0;
      return acc;
    },
    {
      fromPersonField: 0,
      fromEntrantFallback: 0,
      unattributed: 0,
      unknownEntrants: new Set<string>(),
      teamEntrantsSkipped: new Set<string>(),
      foldedFixtures: 0,
      foldedRows: 0,
      foldedCredits: 0,
      foldedEmptyFixtures: 0,
      foldedOutOfScopeFixtures: 0,
    },
  );
  log.info(
    {
      divisionId,
      sportKey: division.sport_key,
      fixtures: byFixture.size,
      rows: rows.length,
      throughSeq,
      fromPersonField: diagnostics.fromPersonField,
      fromEntrantFallback: diagnostics.fromEntrantFallback,
      unattributed: diagnostics.unattributed,
      unknownEntrants: [...diagnostics.unknownEntrants],
      teamEntrantsSkipped: [...diagnostics.teamEntrantsSkipped],
      foldedFixtures: diagnostics.foldedFixtures,
      foldedRows: diagnostics.foldedRows,
      foldedCredits: diagnostics.foldedCredits,
      foldedEmptyFixtures: diagnostics.foldedEmptyFixtures,
    },
    "player-stats: recomputePlayerStats",
  );
  if (diagnostics.foldedOutOfScopeFixtures > 0) {
    // The replay-based folded models rebuild a synthetic TWO-entrant state,
    // so they bail to [] when handed anything wider than one fixture's own
    // pair — silently, producing an empty stat table indistinguishable from
    // a fixture nobody scored. Nothing in the type system says "two", and
    // the ctx is built a layer away from the fold that constrains it, so
    // this is the one shape here that cannot be caught by inspection.
    log.warn(
      { divisionId, fixtures: diagnostics.foldedOutOfScopeFixtures },
      "player-stats: ctx.entrants was not scoped to a single fixture — folded stat models produced nothing",
    );
  }
  if (diagnostics.unknownEntrants.size > 0) {
    // The caller's own entrant-membership data disagrees with the score
    // ledger it is folding — otherwise undiagnosable in production.
    //
    // teamEntrantsSkipped is deliberately NOT part of this condition (S8/#417
    // W6 review round 2, fix 1): it is the engine's DESIGNED skip for a KNOWN
    // team-kind entrant (stats.ts's mandatory kind guard), not a ctx/ledger
    // disagreement — DOMAIN.volleyball.md:34 calls this "the designed state
    // for a team entrant". Before this fix, every healthy volleyball (or
    // football/hockey/cricket) recompute warned on its own routine, correct
    // state; a warning that fires on the happy path trains an operator to
    // ignore the channel, burying the genuine unknownEntrants signal beneath
    // it. teamEntrantsSkipped is already reported as an ordinary count in the
    // info line above — logging it again here would just duplicate it.
    log.warn(
      { divisionId, unknownEntrants: [...diagnostics.unknownEntrants] },
      "player-stats: entrant-fallback attribution disagreement between ctx.entrants and the score ledger",
    );
  }
  if (entrantMembers.size === 0 && byFixture.size > 0) {
    // Degradation case: fixtures were scored, but this division's entrant
    // roster resolved to nothing at all — entrant-fallback attribution had
    // no data to run against for the whole recompute, not just one fixture.
    log.warn(
      { divisionId, fixtures: byFixture.size },
      "player-stats: no entrant roster data for this division — entrant-fallback attribution could not run",
    );
  }

  return { rows, throughSeq, ledger: ledgerMap };
}


/** The competition a `stats.player` / `stats.player.career` gate must be
 *  resolved against.
 *
 *  lib/entitlements.ts only consults `competition_passes` when a competition is
 *  in scope. Historically (pre-W3-A) that mattered because V393 turned
 *  `stats.player` TRUE on `event_pass`/`event_pass_l` and FALSE on
 *  `community` — gating org-wide sold a Free org player stats with the pass
 *  and then refused them on the competition it paid for. W3-A (2026-09-06)
 *  froze `stats.player` true on every plan and moved the pass-lifted half to
 *  `stats.player.career`, so the same reasoning now applies to THAT key.
 *
 *  Pooled `sql`, and deliberately OUTSIDE the `withTenant` callbacks below:
 *  `resolve` queries the pooled proxy, and issuing that from inside a pinned
 *  tenant transaction asks the pool for a second connection while the first is
 *  still held — the self-deadlock lib/db.ts guards against. Same shape as
 *  usecases/officials.ts's `competitionForDivision` (T6). */
async function competitionForDivision(divisionId: string): Promise<string | undefined> {
  const [row] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  return row?.competition_id;
}

/**
 * Every (division, competition) pair a PERSON reader could draw on, within one
 * org.
 *
 * The union of the divisions the person is rostered into and the divisions they
 * already hold a snapshot row for, because the two readers below select from
 * both: `personStats` recomputes from `entrant_members` and then reads
 * `player_stat_snapshots`, and a snapshot can outlive the roster row that
 * produced it. Taking only one side would silently drop rows an entitled org
 * can see today.
 *
 * Pooled `sql` with an EXPLICIT `org_id` filter — this runs outside `withTenant`
 * (see `competitionForDivision`), so there is no tenant rail to scope it.
 */
async function personDivisionScope(
  orgId: string,
  personId: string,
  divisionId?: string,
): Promise<{ division_id: string; competition_id: string }[]> {
  if (divisionId) {
    return sql<{ division_id: string; competition_id: string }[]>`
      select id as division_id, competition_id from divisions
      where id = ${divisionId} and org_id = ${orgId}`;
  }
  return sql<{ division_id: string; competition_id: string }[]>`
    select d.id as division_id, d.competition_id
    from divisions d
    where d.org_id = ${orgId}
      and (exists (
            select 1 from entrant_members em
            join entrants e on e.id = em.entrant_id
            where em.person_id = ${personId} and e.division_id = d.id)
        or exists (
            select 1 from player_stat_snapshots ps
            where ps.person_id = ${personId} and ps.division_id = d.id))`;
}

/**
 * Which of those divisions this org may actually read the per-division player
 * stats RECORD for (`personStats`'s own caller below) — gated on
 * `stats.player`, free on every plan since W3-A (V399). The per-competition
 * resolution predates that freeze and is kept regardless: it is what lets an
 * `org_entitlement_overrides` deny still be scoped to one competition, and it
 * is what `personCareerStats`'s sibling `careerReadableDivisions` (below)
 * needs for real, since `stats.player.career` genuinely still varies by plan.
 *
 * An Event Pass lifts ONE competition, and both person readers span
 * competitions — so neither a single org-wide answer nor `hasFeatureOnAnyPass`
 * is honest here. Org-wide refuses a pass holder on the competition they paid
 * for; an any-pass yes hands them every OTHER competition's stats for free,
 * which is the same $29 hole in the other direction (and is exactly what
 * lib/__tests__/pass-scoping-guard.test.ts's counter-rule flags in an
 * enforcement layer). So the gate is resolved PER COMPETITION and the reader is
 * restricted to the ones that pass.
 *
 * Refusal, when nothing in scope is covered, is the ordinary
 * `PaymentRequiredError` naming `stats.player`, so every existing 402 caller and
 * paywall is unchanged. `scope[0]` is the competition the answer is about; when
 * the person plays nowhere at all the scope is empty and the resolve falls back
 * to the org-wide answer, which is byte-for-byte the pre-fix behaviour for that
 * case (an entitled org gets an empty card, an unentitled one — today, an org
 * with an explicit override deny — gets 402).
 *
 * A per-competition answer is never WORSE than the org-wide one — the pass
 * overlay coalesces into the plan row rather than replacing it — so an org that
 * holds `stats.player` on its plan reaches every division here, exactly as
 * before.
 */
async function statsReadableDivisions(
  orgId: string,
  scope: { division_id: string; competition_id: string }[],
): Promise<string[]> {
  const allowed = new Set<string>();
  for (const competitionId of new Set(scope.map((s) => s.competition_id))) {
    if (await hasFeature(orgId, "stats.player", competitionId)) allowed.add(competitionId);
  }
  if (allowed.size === 0) {
    await requireFeature(orgId, "stats.player", scope[0]?.competition_id);
    return [];
  }
  return scope.filter((s) => allowed.has(s.competition_id)).map((s) => s.division_id);
}

/**
 * The CAREER ROLLUP's sibling of `statsReadableDivisions` above — identical
 * shape, gated on `stats.player.career` instead of `stats.player` (W3-A split,
 * V399): the per-division record is free, the cross-division rollup stays
 * Pro + pass, on its own key so the pricing matrix can describe the two
 * honestly rather than one row lying about the free half.
 *
 * NOT folded into `statsReadableDivisions` as a single function taking the
 * feature key as a parameter. `lib/__tests__/pass-scoping-guard.test.ts`
 * statically parses this file's AST and only recognises a STRING LITERAL as
 * the second argument to `hasFeature`/`requireFeature` — a shared function
 * threading the key through a variable would make BOTH call sites invisible
 * to that guard, which is exactly the class of regression it exists to catch
 * (a resolver call that silently drops its competition scoping). Two small
 * literal-keyed functions, on purpose, not one parameterised one.
 */
async function careerReadableDivisions(
  orgId: string,
  scope: { division_id: string; competition_id: string }[],
): Promise<string[]> {
  const allowed = new Set<string>();
  for (const competitionId of new Set(scope.map((s) => s.competition_id))) {
    if (await hasFeature(orgId, "stats.player.career", competitionId)) allowed.add(competitionId);
  }
  if (allowed.size === 0) {
    await requireFeature(orgId, "stats.player.career", scope[0]?.competition_id);
    return [];
  }
  return scope.filter((s) => allowed.has(s.competition_id)).map((s) => s.division_id);
}

export interface LeaderboardRow {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  entrant: string | null;
  stats: Record<string, number>;
  /** PROMPT-65: the row may link to the person's PUBLIC card — on the rule
   *  every public link to the card uses (`playerLinkId`): `public_entrants_v`
   *  published their id (public-name consent AND the org's player-page
   *  entitlement for this competition) and the division shows full names.
   *  Otherwise plain text: consent alone linked organisers on a plan without
   *  player pages straight into the card's refusal. */
  public_profile: boolean;
}

/** GET /divisions/{id}/stats/players?metric=&sort= (Jul3/07 §6). `stats.player`
 *  — free on every plan since W3-A (V399); the gate call stays so an
 *  `org_entitlement_overrides` deny can still switch it off per organisation.
 *  Sortable by any declared metric (27 Nov). */
export async function divisionPlayerStats(
  auth: AuthCtx,
  divisionId: string,
  query: { metric?: string; sort?: "asc" | "desc" },
): Promise<{
  metrics: { key: string; label: string }[];
  rows: LeaderboardRow[];
  requires_detailed_scoring: boolean;
}> {
  await requireFeature(auth.orgId, "stats.player", await competitionForDivision(divisionId));
  return withTenant(auth.orgId, async (tx) => {
    // Never waits on the division's stats lock, and folds only when the
    // snapshot is behind (review n3); behind a result, it also queues the
    // refresh that clears the public copies of the old rows (m8).
    const { rows, hasModel } = await playerStatsWithoutWaiting(tx, divisionId);
    const [division] = await tx<
      { sport_key: string; module_version: string; youth: boolean; player_name_display: string | null }[]
    >`
      select sport_key, module_version, youth, player_name_display from divisions where id = ${divisionId}`;
    const sportModule = resolveModule(division!.sport_key, division!.module_version);
    const model = sportModule.playerStats;
    const metrics = [
      ...(model?.metrics ?? []).map((m) => ({ key: m.key, label: m.label })),
      ...(model?.derived ?? []).map((d) => ({ key: d.key, label: d.label })),
      ...(model?.awards ?? []).map((a) => ({ key: `${a.key}_awards`, label: a.label })),
    ];

    const personIds = rows.map((r) => r.personId);
    const people = personIds.length
      ? await tx<{ id: string; full_name: string; squad_number: number | null; entrant: string | null }[]>`
          select p.id, p.full_name, em.squad_number, e.display_name as entrant
          from persons p
          left join entrant_members em on em.person_id = p.id
            and em.entrant_id in (select id from entrants where division_id = ${divisionId})
          left join entrants e on e.id = em.entrant_id
          where p.id in ${tx(personIds)}`
      : [];
    const infoById = new Map(people.map((p) => [p.id, p]));
    // The ids the public view publishes for this division's rosters — the
    // public card's own consent + entitlement terms (see `public_profile`).
    const published = personIds.length
      ? new Set(
          (
            await tx<{ person_id: string }[]>`
              select distinct m->>'person_id' as person_id
              from public_entrants_v en
              cross join lateral jsonb_array_elements(en.members) m
              where en.division_id = ${divisionId} and m->>'person_id' is not null`
          ).map((r) => r.person_id),
        )
      : new Set<string>();

    const metric = query.metric ?? metrics[0]?.key ?? "points";
    const dir = query.sort === "asc" ? 1 : -1;
    const out = rows
      .map((r) => ({
        person_id: r.personId,
        full_name: infoById.get(r.personId)?.full_name ?? r.personId,
        squad_number: infoById.get(r.personId)?.squad_number ?? null,
        entrant: infoById.get(r.personId)?.entrant ?? null,
        stats: r.stats,
        public_profile: playerLinkId(published.has(r.personId) ? r.personId : null, division!) !== null,
      }))
      .sort((a, b) => dir * ((a.stats[metric] ?? 0) - (b.stats[metric] ?? 0)) || a.full_name.localeCompare(b.full_name));

    // A division scored at a coarse recording level yields no per-player rows —
    // say so instead of showing wrong zeros (Jul3/07 §8). NOT a plan question
    // since W1 (entitlements v18): every recording level is free, so this is
    // about the level the scorer PICKED, not one the org could not afford.
    const [{ decided }] = await tx<{ decided: number }[]>`
      select count(*) filter (where status = 'decided')::int as decided
      from fixtures where division_id = ${divisionId}`;
    return {
      metrics,
      rows: out,
      requires_detailed_scoring: hasModel && out.length === 0 && decided > 0,
    };
  });
}

/** GET /persons/{id}/stats?division_id= — a player's card, per division
 *  (tables never bleed across divisions, Jul3/07 §8). */
export async function personStats(
  auth: AuthCtx,
  personId: string,
  divisionId?: string,
): Promise<{ divisions: { division_id: string; division_name: string; stats: Record<string, number> }[] }> {
  // Resolved before the transaction (pooled proxy, see `competitionForDivision`).
  // `readable` already IS `[divisionId]` when one was named and the org may read
  // it, so it replaces the old `and ps.division_id = ...` conditional outright.
  const readable = await statsReadableDivisions(
    auth.orgId,
    await personDivisionScope(auth.orgId, personId, divisionId),
  );
  const readableSet = new Set(readable);
  return withTenant(auth.orgId, async (tx) => {
    const [person] = await tx`
      select 1 from persons where id = ${personId} and merged_into is null`;
    if (!person) throw new HttpError(404, "person not found");
    // refresh the divisions this person appears in (or the requested one) —
    // minus any whose competition this org may not read, which would be paying
    // for a fold whose output is then filtered away.
    const divisionIds = (
      divisionId
        ? [divisionId]
        : (
            await tx<{ division_id: string }[]>`
              select distinct e.division_id
              from entrant_members em join entrants e on e.id = em.entrant_id
              where em.person_id = ${personId}`
          ).map((r) => r.division_id)
    ).filter((d) => readableSet.has(d));
    // One division at a time, never waiting on a stats lock and folding only a
    // division whose snapshot is behind (review n3). A division another
    // transaction is folding right now is folded in memory instead; its row
    // replaces the snapshot's below. Try-locks never wait, so the order the
    // query above returns the divisions in cannot deadlock.
    const inMemory = new Map<string, Record<string, number> | null>();
    for (const d of divisionIds) {
      const { rows: foldRows, served } = await playerStatsWithoutWaiting(tx, d);
      if (served === "memory") inMemory.set(d, foldRows.find((r) => r.personId === personId)?.stats ?? null);
    }
    const snapshot = await tx<{ division_id: string; division_name: string; stats: Record<string, number> }[]>`
      select ps.division_id, d.name as division_name, ps.stats
      from player_stat_snapshots ps join divisions d on d.id = ps.division_id
      where ps.person_id = ${personId}
        and ps.division_id = any(${readable})
      order by d.name`;
    if (inMemory.size === 0) return { divisions: snapshot };
    const names = new Map(
      (
        await tx<{ id: string; name: string }[]>`select id, name from divisions where id in ${tx([...inMemory.keys()])}`
      ).map((r) => [r.id, r.name] as const),
    );
    const rows = snapshot.filter((r) => !inMemory.has(r.division_id));
    for (const [d, stats] of inMemory) {
      if (stats !== null) rows.push({ division_id: d, division_name: names.get(d) ?? "", stats });
    }
    rows.sort((a, b) => (a.division_name < b.division_name ? -1 : a.division_name > b.division_name ? 1 : 0));
    return { divisions: rows };
  });
}

/** Every fixture status this repo treats as "played, has a result" —
 *  decided/finalized/forfeited. `fixtures.status`'s check constraint also
 *  allows scheduled/in_play/abandoned/cancelled, none of which count
 *  (`db/migration/v2-engine/tables/V214__fixtures.sql:21-22`). Same three
 *  statuses as divisions.ts's own audit count, org-posts.ts's DECIDED set,
 *  stages.ts's DECIDED set, withdrawal.ts's SETTLED set — each currently its
 *  own local copy (unifying those is out of scope here; this constant only
 *  closes the "matches" duplication below).
 *
 *  Review round 2, finding 1: this used to be a bare `status = 'finalized'`
 *  literal, independently duplicated in THIS function, me.ts's
 *  countMyMatchesByDivision, and public-site/data.ts's
 *  countPublicMatchesByDivision. recomputePlayerStats above puts NO status
 *  filter on its own score_events read, so a fixture left `decided` and
 *  never explicitly finalized contributed its stats to the snapshot while
 *  contributing ZERO to `matches` — on all three call sites at once. A
 *  player's card could read "5 goals · 0 matches". */
export const COMPLETED_FIXTURE_STATUSES: readonly string[] = ["decided", "finalized", "forfeited"];

/** Pooled `sql` or an open transaction — `postgres.TransactionSql` and `Sql`
 *  share `ISql` (same fact as admin-fixture-config.ts's own `Queryable`).
 *  `countMatchesByDivision` below is called both ways: inside `withTenant`
 *  here (personCareerStats) and against the pooled `sql` proxy from
 *  me.ts/public-site/data.ts, neither of which has a tenant tx open. */
type Queryable = postgres.ISql;

/** The one thing the three "matches" callers (org-scoped persons-stats,
 *  cross-org /me, the public player card) genuinely differ on — who "mine"
 *  resolves to. Everything else about the query (status set, grouping, the
 *  `sql([])` guard) must be identical, which is the whole point of sharing
 *  this function (review round 2, finding 2 — the same completed-status
 *  defect was duplicated three times because the query itself was). */
export type MatchesOwner = { by: "person"; personId: string } | { by: "claimedPersons"; userId: string };

/** Completed fixtures a person — or, for a signed-in player, ANY of their
 *  claimed persons (`MatchesOwner`'s "claimedPersons" branch: there is no
 *  single personId to scope by there, a user can hold one claimed `persons`
 *  row per org) — played, per division, restricted to `divisionIds`. The
 *  single implementation behind personCareerStats below, me.ts's
 *  listMyCareerStats, and public-site/data.ts's getPublicPlayer career
 *  rollup. Deliberately NOT the declared playerStats "matches" metric: only
 *  3 of the 11 shipped modules (carrom, and the setbased/nested kernels)
 *  declare one at all, so a metric-based count would read zero for
 *  football/cricket/hockey/…
 *
 *  Guards the empty-array case itself (S8/#417 pattern, postgres.js's
 *  `sql([])` renders `(null)` and an empty `in ()` matches nothing, not
 *  everything) rather than trusting every caller to remember it. */
export async function countMatchesByDivision(
  db: Queryable,
  owner: MatchesOwner,
  divisionIds: readonly string[],
): Promise<Map<string, number>> {
  if (divisionIds.length === 0) return new Map();
  const rows =
    owner.by === "person"
      ? await db<{ division_id: string; matches: number }[]>`
          select f.division_id, count(distinct f.id)::int as matches
          from fixtures f
          join entrant_members em on em.person_id = ${owner.personId}
            and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
          where f.division_id in ${db(divisionIds as string[])}
            and f.status in ${db(COMPLETED_FIXTURE_STATUSES as string[])}
          group by f.division_id`
      : await db<{ division_id: string; matches: number }[]>`
          select f.division_id, count(distinct f.id)::int as matches
          from fixtures f
          join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
          join persons p on p.id = em.person_id and p.user_id = ${owner.userId} and p.merged_into is null
          where f.division_id in ${db(divisionIds as string[])}
            and f.status in ${db(COMPLETED_FIXTURE_STATUSES as string[])}
          group by f.division_id`;
  return new Map(rows.map((r) => [r.division_id, r.matches]));
}

/** GET /persons/{id}/stats?group=sport — the S9/#418 career rollup: every
 *  sport this person has snapshot rows in, within THIS org (org-scoped via
 *  withTenant, unlike /me's cross-org listMyCareerStats — this route serves
 *  the organiser's console, not the player's own cross-club view), summed
 *  across every contributing division and labelled via the sport's LATEST
 *  registered module (see groupCareerStatsBySport's own comment for what
 *  that means when two divisions disagree on a key's meaning).
 *
 *  SNAPSHOT-ONLY, deliberately — this is the N-recompute trap personStats
 *  above already carries (`for (const d of divisionIds) await
 *  recomputePlayerStats`) at ONE division; a career rollup spans every
 *  division a person has EVER played, in every sport, so paying that same
 *  cost here would multiply an already-expensive read across a whole
 *  history on every card view. Whatever the most recent read of a given
 *  division already computed into player_stat_snapshots is what the career
 *  total is built from — a stale division catches up the next time IT is
 *  read (its own leaderboard, its own per-division card, or the public
 *  card), exactly like every other disposable-cache read in this file. */
export async function personCareerStats(
  auth: AuthCtx,
  personId: string,
): Promise<{ sports: CareerSportStats[] }> {
  // Per competition, not org-wide — see `careerReadableDivisions`. A career
  // rollup spans competitions, so an Event Pass covers the part of the career
  // played inside the competition it was bought for, and no more.
  //
  // Gated on `stats.player.career` (W3-A split, V399), NOT `stats.player`:
  // the record `personStats` reads is free on every plan now, but this
  // cross-division rollup is the leverage half and stays Pro + pass — the
  // whole reason the two share a route (`/persons/{id}/stats`) but not a
  // gate.
  const readable = await careerReadableDivisions(
    auth.orgId,
    await personDivisionScope(auth.orgId, personId),
  );
  return withTenant(auth.orgId, async (tx) => {
    const [person] = await tx`
      select 1 from persons where id = ${personId} and merged_into is null`;
    if (!person) throw new HttpError(404, "person not found");

    // Review round 2, archived-divisions decision: `and d.archived_at is
    // null` added here to align with listMyCareerStats/listMyPlayerStats
    // (me.ts, both already filter) and the dominant convention across this
    // repo's own division reads (divisions.ts's own listing default,
    // card-stats.ts, division-slots.ts, competitions.ts all hide archived
    // divisions from an aggregate/listing read by default) — a career total
    // silently shrinking the moment an unrelated org archives an old
    // competition is exactly the silent-data-flicker shape that convention
    // exists to prevent. personStats above (the per-division, non-summed
    // sibling reader in this same file) still has no archived_at filter —
    // a separate, pre-existing function deliberately left untouched this
    // round, not an oversight.
    const rows = await tx<CareerSnapshotRow[]>`
      select ps.division_id, ps.sport_key, d.variant_key, ps.stats
      from player_stat_snapshots ps
      join divisions d on d.id = ps.division_id and d.archived_at is null
      where ps.person_id = ${personId}
        and ps.division_id = any(${readable})
      order by d.slug`;
    if (rows.length === 0) return { sports: [] };

    const matchesByDivision = await countMatchesByDivision(
      tx,
      { by: "person", personId },
      [...new Set(rows.map((r) => r.division_id))],
    );
    // The persons-stats route is already dynamic (auth'd, per-request), so
    // resolving the request locale here costs no rendering mode — mirrors
    // listMyPlayerStats's own discipline (me.ts). The catch is for callers
    // outside a request scope (tests, jobs) where cookies() throws; English
    // is the right answer there, not a crash.
    const locale = await resolveLocale().catch(() => DEFAULT_LOCALE);
    const m = (k: Parameters<typeof msgFor>[1]) => msgFor(locale, k);
    return { sports: groupCareerStatsBySport(rows, matchesByDivision, m) };
  });
}

/** Public consent-filtered leaderboard (Jul3/07 §6): names via
 *  public_person_name, then the division's youth/name-display policy (the
 *  SQL function alone has no youth axis — privacy hotfix 2026-09-16).
 *
 *  W3-A (2026-09-06, V399): gated on `stats.player`, same key
 *  `divisionPlayerStats`/`personStats` read. Before this it had NO gate at
 *  all — combined with V396 making competitions public by default, that was
 *  a live inversion: an anonymous visitor saw a Free org's player stats while
 *  the signed-in org got 402 on the exact same data. `stats.player` is free
 *  on every plan by default now, so this changes nothing for the ordinary
 *  case; what it buys is that an org's explicit `org_entitlement_overrides`
 *  deny (the only refusal left on this key) is now honoured here too — the
 *  public can never see MORE than the org's own signed-in read. 404, not 402:
 *  there is no payment prompt to show an anonymous visitor, and treating a
 *  denied leaderboard the same as a missing division tells a scraper nothing
 *  about which case it hit. */
export async function publicDivisionStats(
  orgSlug: string,
  competitionSlug: string,
  divisionSlug: string,
): Promise<{ rows: { name: string; stats: Record<string, number> }[] }> {
  const { sql } = await import("@/lib/db");
  const [division] = await sql<
    { id: string; org_id: string; competition_id: string; youth: boolean; player_name_display: string | null }[]
  >`
    select d.id, d.org_id, c.id as competition_id, d.youth, d.player_name_display
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${competitionSlug} and d.slug = ${divisionSlug}
      and c.visibility in ('public','unlisted')`;
  if (!division) throw new HttpError(404, "division not found");
  if (!(await hasFeature(division.org_id, "stats.player", division.competition_id))) {
    throw new HttpError(404, "division not found");
  }
  // Serves the snapshot as it stands and folds nothing (owner ruling
  // 2026-09-17): an anonymous, uncached route must never pay for a fold. After
  // the response, a check queues the division's refresh if the snapshot is
  // behind a result, a refresh lost to a restart included
  // (`reconcilePlayerStatsOnRead`). A division whose snapshot was never filled
  // serves no rows until that refresh lands, the first visit after this ships
  // included (accepted, owner ruling 2026-09-17; no warm-up job). Imported
  // lazily: the refresh module imports this one.
  const { reconcilePlayerStatsOnRead } = await import("./player-stats-refresh");
  reconcilePlayerStatsOnRead(division.org_id, division.id);
  const rows = await sql<{ name: string; consent: { public_name?: boolean } | null; stats: Record<string, number> }[]>`
    select public_person_name(p.full_name, p.consent) as name, p.consent, ps.stats
    from player_stat_snapshots ps
    join persons p on p.id = ps.person_id
    where ps.division_id = ${division.id}
    order by (ps.stats->>'points')::numeric desc nulls last, name`;
  // Privacy hotfix (2026-09-16): `public_person_name` is consent-only (V229) —
  // a consented youth player's full name was published here. The division's
  // youth/name-display policy is applied ON TOP of the SQL name, never instead
  // of it (the two disagree on an ABSENT consent: SQL initials it, the
  // resolver would not mask it), the same composition as `publicSuspensions`.
  // A row carries a name and stats only — no person id or link to withhold.
  return {
    rows: rows.map((r) => ({
      name: resolvePersonDisplayName(r.name, r.consent, division.player_name_display, division.youth),
      stats: r.stats,
    })),
  };
}
