// Spectator surface W2, Task 3 — the competition hub's leader boards.
//
// PURE by design: no `sql`, no `server-only`, no network. The DB shell lives
// next door in `public-leaders.ts` and delegates every decision here, which is
// the same split `server/player-stats.ts` already makes for the career rollup
// ("a thin DB-shaped input so this file stays free of any postgres/sql import
// — pure, unit-testable with fabricated rows"). It is what lets the consent
// fold and the ranking be proven without a database.
//
// ---------------------------------------------------------------------------
// Two rulings shape this file, and neither is derivable from the code:
//
// 1. COUNT boards only. A ratio board (batting strike rate, bowling economy)
//    is meaningless without a minimum-participation floor — one ball faced for
//    six runs is not the tournament's best strike rate. `PlayerStatsModel`
//    declares `metrics`, `derived`, `awards` and `folded`, and NO floor and no
//    leaderboard declaration anywhere, so there is nothing to read that floor
//    from. Ratio boards therefore wait for an engine declaration; W2 ships
//    counts, and `leaders.test.ts` pins every key in the table below against
//    the module's own `metrics[]` so a derived ratio cannot be added here
//    without that engine work landing first.
//
// 2. The snapshot is READ, never recomputed. `recomputePlayerStats` re-folds
//    every `score_event` in a division on every call (its `throughSeq` is a
//    running count, not a resume point), so calling it per division on a
//    public page render is O(all events) on a spectator's page load.
//
//    What that table is NOT is a projection the scoring write reliably
//    maintains. `recomputePlayerStats` is its only writer, and it runs from
//    the console and public stats endpoints (`divisionPlayerStats`,
//    `publicDivisionStats`), a person merge, the auto-posts enrichment
//    (`usecases/org-posts.ts:888,952`), and the weekly digest sweep
//    (`:1331`). Only the auto-posts path is reached from scoring —
//    `refreshNews` on a decided fixture — and it is doubly conditional: the
//    division must have `auto_posts` set AND the org must hold `news.auto`.
//    The digest cron POSTs `https://stg.seazn.club` and nothing else
//    (`news-digest-stg.yml:36`), so it never refreshes production at all.
//    A division outside every one of those paths holds ZERO rows and yields
//    NO boards here; where rows exist they are as fresh as the last such
//    call, not as fresh as the live fixture. Not recomputing on a spectator render
//    is still right — `data.ts`'s public player card reads the same table the
//    same way — but who refreshes it is an open question for the wave, not
//    something this module settles.
// ---------------------------------------------------------------------------
import type { PlayerStatsModel } from "@seazn/engine/stats";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { isPersonNameMasked, resolvePersonDisplayName } from "@/lib/name-display";
import type { LeaderBoardT } from "./competition-hub-schema";
import type { DivisionConsentCtx } from "./public-lineups";

/** One board to build for a sport. `engineLabel` is the module's OWN declared
 *  English for the key, carried so the caller can hand it to `playerStatLabel`
 *  as the fallback for a stat this app has no dictionary key for yet — the
 *  exact contract `labelPlayerStats` already uses. */
export interface LeaderSpec {
  key: string;
  engineLabel: string | undefined;
}

/**
 * Which counters get a board, per sport, in the order they are shown.
 *
 * Wave order, NOT alphabetical: the first entry is the board a spectator
 * looks for first (cricket's run scorers, football's scorers). Re-sorting
 * this literal changes what the hub renders first, so treat the order as
 * part of the contract.
 *
 * Keys are the ENGINE's, verified against each module's declared
 * `playerStats.metrics[]` by `leaders.test.ts` — a typo here is a red test,
 * not a silently empty board. A sport absent from this table falls back to
 * its module's first two declared metrics (see `specsFor`), so a new sport
 * gets sensible boards with no entry at all.
 *
 * Labels are deliberately NOT here. Every key already has a translated
 * `stat.<sportKey>.<statKey>` entry in all four dictionaries, resolved by the
 * shared `playerStatLabel`; a parallel `leaders.*` family would be a second
 * set of words for the same counters.
 */
export const LEADER_SPECS: Readonly<Record<string, readonly string[]>> = {
  cricket: ["runs", "wickets", "sixes"],
  football: ["goals", "assists"],
  hockey: ["goals"],
  icehockey: ["goals"],
};

/** How many people a single board lists. */
export const LEADER_LIMIT = 5;

/** A division as the board builder needs it. `moduleVersion` is the version
 *  the division PINNED at creation — the caller resolves its model with
 *  `resolveModule(sportKey, moduleVersion)`, never `resolveLatestModule`, so a
 *  running division always labels under the build it started with (the same
 *  choice `data.ts`'s per-division player stats already make). */
export interface LeaderDivision {
  id: string;
  slug: string;
  name: string;
  sportKey: string;
  moduleVersion: string;
}

/** One person's consent-resolved totals in one division — the builder's input,
 *  already through the name resolver so nothing downstream can unmask. */
export interface LeaderInputRow {
  divisionId: string;
  personId: string;
  /** Already display-resolved. Never the raw `full_name` for a masked person. */
  name: string;
  masked: boolean;
  /** True only when the person is in `public_players_v` — i.e. a player page
   *  exists for them. Absence of a profile is never absence of a row. */
  publicProfile: boolean;
  entrantName: string | null;
  badgeUrl: string | null;
  stats: Record<string, number>;
}

/**
 * Every stat key a model can put in a snapshot, each with the module's own
 * English label, in declaration order, FIRST declaration wins.
 *
 * Deliberately mirrors `labelFromModel` (server/player-stats.ts) — metrics →
 * derived → awards (suffixed `_awards`, which is what `aggregatePlayerStats`
 * actually writes) → folded, appended last so a key an earlier list already
 * declared keeps that entry's own label. The two are separate functions
 * because the labeller also translates and drops zero rows, so it cannot be
 * reused verbatim here; `leaders.test.ts` cross-checks the two key lists
 * against each other so a module gaining a fifth declaration list cannot
 * reach one and not the other.
 *
 * `metrics` is an AGGREGATION spec, not a display list — a module may declare
 * one key several times to credit it from several payload fields — hence the
 * first-wins dedupe rather than one entry per declaration.
 */
export function declaredStats(
  model: PlayerStatsModel | undefined,
): readonly { key: string; label: string }[] {
  const declared = [
    ...(model?.metrics ?? []).map((m) => ({ key: m.key, label: m.label })),
    ...(model?.derived ?? []).map((d) => ({ key: d.key, label: d.label })),
    ...(model?.awards ?? []).map((a) => ({ key: `${a.key}_awards`, label: a.label })),
    ...(model?.folded?.keys ?? []).map((f) => ({ key: f.key, label: f.label })),
  ];
  const seen = new Set<string>();
  return declared.filter((d) => !seen.has(d.key) && (seen.add(d.key), true));
}

/** The key set of `declaredStats` — "could this module ever produce this
 *  counter", used to keep `LEADER_SPECS` honest. */
export function declaredStatKeys(model: PlayerStatsModel | undefined): Set<string> {
  return new Set(declaredStats(model).map((d) => d.key));
}

/**
 * The boards to build for a sport: its declared table, or — for a sport with
 * no entry — the module's first two declared METRICS, in declaration order.
 *
 * The fallback deliberately reads `metrics` only, not `declaredStats`: a
 * derived ratio or an award is not a defensible default board (see ruling 1
 * at the top of this file), so an unlisted sport gets counts or nothing.
 */
export function specsFor(sportKey: string, model: PlayerStatsModel | undefined): LeaderSpec[] {
  const labels = new Map(declaredStats(model).map((d) => [d.key, d.label]));
  const listed = LEADER_SPECS[sportKey];
  if (listed) return listed.map((key) => ({ key, engineLabel: labels.get(key) }));

  const seen = new Set<string>();
  return (model?.metrics ?? [])
    .filter((m) => !seen.has(m.key) && (seen.add(m.key), true))
    .slice(0, 2)
    .map((m) => ({ key: m.key, engineLabel: labels.get(m.key) }));
}

/**
 * Rank each division's people on each of its boards.
 *
 * Order is value DESC, then DISPLAYED name ASC — the displayed name, so a
 * masked entry sorts where a spectator actually reads it. A person who has
 * not scored the counter at all does not appear: a missing key and a stored
 * zero are treated alike, and a board nobody has scored is dropped entirely
 * rather than rendering an empty heading.
 *
 * A masked person is RANKED and rendered under their masked label — dropping
 * the row would silently change the standings a spectator sees. What masking
 * removes is the LINK: `personHref` is offered only for a person who both has
 * a public profile (`public_players_v`) and is not masked here, because the
 * player page renders the unmasked name and linking to it from a youth
 * division would undo that division's own safeguarding policy.
 *
 * Masking removes the real `personId` too (privacy hotfix, 2026-09-16). A
 * person's id is stable across the org, so a masked row's id could be looked
 * up on an adult division's entrants API, where the same person may appear
 * under their full name. A masked row carries a stand-in instead, the same
 * scheme `makePersonOf` (match-centre.ts) uses: `m1`, `m2`, … in first-seen
 * order, memoised so a person on two of a division's boards keeps one
 * stand-in. The memo is per DIVISION, the unit the policy masks by: a child
 * playing up in U12 and U14 gets unrelated stand-ins, so nothing ties the two
 * rows together. The id is only the row's React key and testid
 * (`stats-tab.tsx`), which needs uniqueness inside one board only. Unmasked
 * people keep their real id: the player-page link is built from it.
 */
export function buildLeaderBoards(a: {
  divisions: readonly LeaderDivision[];
  rows: readonly LeaderInputRow[];
  modelFor: (division: LeaderDivision) => PlayerStatsModel | undefined;
  label: (
    spec: LeaderSpec,
    division: LeaderDivision,
    model: PlayerStatsModel | undefined,
  ) => string;
  personHref: (personId: string) => string;
  limit?: number;
}): LeaderBoardT[] {
  const limit = a.limit ?? LEADER_LIMIT;
  const out: LeaderBoardT[] = [];

  for (const division of a.divisions) {
    const standIns = new Map<string, string>();
    const publicId = (row: LeaderInputRow): string => {
      if (!row.masked) return row.personId;
      const seen = standIns.get(row.personId);
      if (seen !== undefined) return seen;
      const minted = `m${standIns.size + 1}`;
      standIns.set(row.personId, minted);
      return minted;
    };
    const model = a.modelFor(division);
    const inDivision = a.rows.filter((r) => r.divisionId === division.id);

    for (const spec of specsFor(division.sportKey, model)) {
      const scored = inDivision
        .map((row) => ({ row, value: row.stats[spec.key] ?? 0 }))
        .filter((r) => r.value > 0)
        .sort((x, y) => y.value - x.value || x.row.name.localeCompare(y.row.name))
        .slice(0, limit);

      if (scored.length === 0) continue;

      out.push({
        divisionId: division.id,
        divisionSlug: division.slug,
        divisionName: division.name,
        sportKey: division.sportKey,
        key: spec.key,
        label: a.label(spec, division, model),
        rows: scored.map(({ row, value }) => ({
          person: { personId: publicId(row), name: row.name, masked: row.masked },
          personHref: row.publicProfile && !row.masked ? a.personHref(row.personId) : null,
          entrantName: row.entrantName,
          badgeUrl: row.badgeUrl,
          // Formatted from the SAME number the ranking used, so a change to
          // one can never leave the other showing a different figure.
          value: String(value),
        })),
      });
    }
  }
  return out;
}

/** A division's id plus the two consent inputs `resolvePersonDisplayName`
 *  needs — the shape `maskPublicEntrantNames` and `readPublicLineups` already
 *  take, with the id the multi-division fold needs to tell them apart. */
export type LeaderDivisionConsent = DivisionConsentCtx & { id: string };

/** One `player_stat_snapshots` row joined to its person and entrant — the
 *  DB-shaped input to the pure fold below, so this module needs no `sql`. */
export interface LeaderSnapshotRow {
  division_id: string;
  person_id: string;
  full_name: string;
  consent: { public_name?: boolean } | null;
  stats: Record<string, number>;
  entrant_id: string | null;
  entrant_name: string | null;
  badge_url: string | null;
  team_logo_path: string | null;
  public_profile: boolean;
}

/**
 * Fold raw snapshot rows into consent-resolved builder input.
 *
 * Names go through the ONE shared `resolvePersonDisplayName` — the same
 * resolver `readPublicLineups` and `maskPublicEntrantNames` use, never a
 * second one — against the row's OWN division's policy, so a call spanning a
 * youth and an open division resolves each correctly.
 *
 * `entrantNames` is keyed by entrant id and holds names that have ALREADY been
 * through `maskPublicEntrantNames`. An entrant missing from it yields a null
 * name rather than falling back to the raw `entrant_name` column: that column
 * is a non-team entrant's unmasked display name, and publishing it because a
 * lookup missed would leak exactly what the masking pass exists to prevent.
 */
export function toLeaderInputRows(
  rows: readonly LeaderSnapshotRow[],
  divisions: readonly LeaderDivisionConsent[],
  entrantNames: ReadonlyMap<string, string>,
): LeaderInputRow[] {
  const policyFor = new Map(divisions.map((d) => [d.id, d]));
  const out: LeaderInputRow[] = [];

  for (const row of rows) {
    const division = policyFor.get(row.division_id);
    // A row for a division the caller did not ask about has no policy to
    // resolve against, and guessing one would be guessing at consent.
    if (division === undefined) continue;

    const setting = division.player_name_display ?? null;
    const youth = division.youth ?? false;
    const name = resolvePersonDisplayName(row.full_name, row.consent, setting, youth);

    // `masked` follows the POLICY, not whether the string changed.
    //
    // The obvious `name !== row.full_name` (which `readPublicLineups` used
    // until the 2026-09-16 privacy hotfix) is wrong here: `maskOne` returns a SINGLE-TOKEN name unchanged, so a
    // one-word name resolves to itself and reads as unmasked. In W1 that flag
    // drives nothing, but here it gates `personHref` — so a minor in a youth
    // division with a one-token name would be handed a link to a player page
    // carrying their photo and cross-division stats, which is the exact
    // outcome the division's masking policy exists to prevent. The name
    // string leaks nothing extra in that case; the LINK does.
    //
    // The decision `resolvePersonDisplayName` itself makes, from the one
    // shared rule — never a copy of the predicate.
    const masked = isPersonNameMasked(row.consent, setting, youth);

    out.push({
      divisionId: row.division_id,
      personId: row.person_id,
      name,
      masked,
      publicProfile: row.public_profile,
      entrantName: row.entrant_id === null ? null : (entrantNames.get(row.entrant_id) ?? null),
      badgeUrl: resolveEntrantBadge({
        badge_url: row.badge_url,
        team_logo_path: row.team_logo_path,
      }),
      stats: row.stats,
    });
  }
  return out;
}
