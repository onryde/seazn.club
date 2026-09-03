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
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveFixtureCfg, resolveModule } from "@/server/engine-db";
import { loadLineupPairsForDivision } from "@/server/engine-db/lineups";
import { entrantFoldCtx, loadEntrantMembersForDivision } from "@/server/engine-db/entrant-members";
import { log } from "@/server/logger";
import { groupCareerStatsBySport, type CareerSnapshotRow, type CareerSportStats } from "@/server/player-stats";
import { DEFAULT_LOCALE } from "@/lib/i18n-constants";
import { resolveLocale } from "@/lib/resolve-locale";
import { msgFor } from "@/lib/messages-i18n";

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

/** Refold every fixture's ledger into the division snapshot (Jul3/07 §2 —
 *  rebuildable at any time; the CI-style consistency check refolds and
 *  compares). Returns the fresh rows. */
export async function recomputePlayerStats(
  tx: Tx,
  divisionId: string,
): Promise<{ rows: PlayerStatRow[]; throughSeq: number; hasModel: boolean }> {
  const [division] = await tx<{ sport_key: string; module_version: string; config: unknown }[]>`
    select sport_key, module_version, config from divisions where id = ${divisionId}`;
  if (!division) throw new HttpError(404, "division not found");
  const sportModule = resolveModule(division.sport_key, division.module_version);
  const model = sportModule.playerStats;
  if (model === undefined) return { rows: [], throughSeq: 0, hasModel: false };

  const events = await tx<EventRow[]>`
    select se.fixture_id, se.id, se.seq, se.type, se.payload, se.recorded_at, se.voids_event_id
    from score_events se
    join fixtures f on f.id = se.fixture_id
    where f.division_id = ${divisionId}
    order by se.fixture_id, se.seq`;

  const byFixture = new Map<string, EventEnvelope[]>();
  let throughSeq = 0;
  for (const e of events) {
    throughSeq += 1;
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

  return { rows, throughSeq, hasModel: true };
}


/** The competition a `stats.player` gate must be resolved against.
 *
 *  lib/entitlements.ts only consults `competition_passes` when a competition is
 *  in scope, and V391 turns `stats.player` TRUE on `event_pass`/`event_pass_l`
 *  and FALSE on `community` — so gating org-wide sold a Free org player stats
 *  with the pass and then refused them on the competition it paid for.
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
 * Which of those divisions this org may actually read player stats for.
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
 * case (an entitled org gets an empty card, an unentitled one gets 402).
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

export interface LeaderboardRow {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  entrant: string | null;
  stats: Record<string, number>;
  /** PROMPT-65: the person has a public profile (public_name consent) — rows
   *  link there; non-consented rows stay plain text. */
  public_profile: boolean;
}

/** GET /divisions/{id}/stats/players?metric=&sort= (Jul3/07 §6). Pro
 *  `stats.player`. Sortable by any declared metric (27 Nov). */
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
    const { rows, hasModel } = await recomputePlayerStats(tx, divisionId);
    const [division] = await tx<{ sport_key: string; module_version: string }[]>`
      select sport_key, module_version from divisions where id = ${divisionId}`;
    const sportModule = resolveModule(division!.sport_key, division!.module_version);
    const model = sportModule.playerStats;
    const metrics = [
      ...(model?.metrics ?? []).map((m) => ({ key: m.key, label: m.label })),
      ...(model?.derived ?? []).map((d) => ({ key: d.key, label: d.label })),
      ...(model?.awards ?? []).map((a) => ({ key: `${a.key}_awards`, label: a.label })),
    ];

    const personIds = rows.map((r) => r.personId);
    const people = personIds.length
      ? await tx<
          { id: string; full_name: string; squad_number: number | null; entrant: string | null; public_name: boolean }[]
        >`
          select p.id, p.full_name, em.squad_number, e.display_name as entrant,
                 coalesce((p.consent->>'public_name')::boolean, false) as public_name
          from persons p
          left join entrant_members em on em.person_id = p.id
            and em.entrant_id in (select id from entrants where division_id = ${divisionId})
          left join entrants e on e.id = em.entrant_id
          where p.id in ${tx(personIds)}`
      : [];
    const infoById = new Map(people.map((p) => [p.id, p]));

    const metric = query.metric ?? metrics[0]?.key ?? "points";
    const dir = query.sort === "asc" ? 1 : -1;
    const out = rows
      .map((r) => ({
        person_id: r.personId,
        full_name: infoById.get(r.personId)?.full_name ?? r.personId,
        squad_number: infoById.get(r.personId)?.squad_number ?? null,
        entrant: infoById.get(r.personId)?.entrant ?? null,
        stats: r.stats,
        public_profile: infoById.get(r.personId)?.public_name ?? false,
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
    for (const d of divisionIds) await recomputePlayerStats(tx, d);
    const rows = await tx<{ division_id: string; division_name: string; stats: Record<string, number> }[]>`
      select ps.division_id, d.name as division_name, ps.stats
      from player_stat_snapshots ps join divisions d on d.id = ps.division_id
      where ps.person_id = ${personId}
        and ps.division_id = any(${readable})
      order by d.name`;
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
const COMPLETED_FIXTURE_STATUSES: readonly string[] = ["decided", "finalized", "forfeited"];

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
  // Per competition, not org-wide — see `statsReadableDivisions`. A career
  // rollup spans competitions, so an Event Pass covers the part of the career
  // played inside the competition it was bought for, and no more.
  const readable = await statsReadableDivisions(
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
 *  public_person_name (minors gated, doc 06 §4.7). */
export async function publicDivisionStats(
  orgSlug: string,
  competitionSlug: string,
  divisionSlug: string,
): Promise<{ rows: { name: string; stats: Record<string, number> }[] }> {
  const { sql } = await import("@/lib/db");
  const [division] = await sql<{ id: string; org_id: string }[]>`
    select d.id, d.org_id
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${competitionSlug} and d.slug = ${divisionSlug}
      and c.visibility in ('public','unlisted')`;
  if (!division) throw new HttpError(404, "division not found");
  const refresh = await withTenant(division.org_id, async (tx) => recomputePlayerStats(tx, division.id));
  void refresh;
  const rows = await sql<{ name: string; stats: Record<string, number> }[]>`
    select public_person_name(p.full_name, p.consent) as name, ps.stats
    from player_stat_snapshots ps
    join persons p on p.id = ps.person_id
    where ps.division_id = ${division.id}
    order by (ps.stats->>'points')::numeric desc nulls last, name`;
  return { rows };
}
