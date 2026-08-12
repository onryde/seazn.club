// Shared player-stat labelling (PROMPT-65 → /me reuse): a snapshot's raw
// counters become display rows via the sport module's DECLARED playerStats
// model — metrics, derived, then awards (suffixed _awards in snapshots) —
// never hardcoded labels. Zero-valued rows are dropped; a retired module
// build yields [] so callers skip the block instead of breaking the page.
//
// The module's DECLARED label is English, and that is the whole reason this
// helper takes a translator: the public player page and /me have never LOOKED
// unlocalized, because "Goals" and "Balls faced" always rendered. `m` is
// REQUIRED — an optional one would let a new caller silently ship English —
// and it resolves per-sport copy (`stat.<sportKey>.<metricKey>`), falling back
// to the module's own label for a metric this app has no key for yet.
//
// S9/#418 — career rollup grouping/summing joins this same module: a career
// card sums a person's player_stat_snapshots ACROSS every division/sport they
// have ever played, so `groupCareerStatsBySport` below reuses the exact same
// declared-order-first-wins, zero-drops labelling (`labelFromModel`) that
// `labelPlayerStats` already used — only the model resolution differs
// (`resolveLatestModule` instead of an exact pinned version; see that
// function's own doc comment for why). Three callers share this one
// aggregator: the org-scoped persons-stats route's `?group=sport`
// (usecases/player-stats.ts), the cross-org /me Career section
// (usecases/me.ts), and the competition-scoped public player card
// (public-site/data.ts).
import { resolveModule, resolveLatestModule } from "@/server/engine-db";
import { playerStatLabel, sportLabel, type MsgFn } from "@/lib/scoring-vocab";
import { sumPlayerStats, type PlayerStatsModel } from "@seazn/engine/stats";

export interface LabelledPlayerStat {
  key: string;
  label: string;
  value: number;
}

/** Declared-order-first-wins, zero-drops reduction of a stats blob into
 *  display rows, against an ALREADY-RESOLVED model (or none, for a retired/
 *  unknown build) — the part `labelPlayerStats` and `groupCareerStatsBySport`
 *  share; only how each resolves its model differs. */
function labelFromModel(
  sportKey: string,
  model: PlayerStatsModel | undefined,
  stats: Record<string, number>,
  m: MsgFn,
): LabelledPlayerStat[] {
  const declared = [
    ...(model?.metrics ?? []).map((x) => ({ key: x.key, label: x.label })),
    ...(model?.derived ?? []).map((d) => ({ key: d.key, label: d.label })),
    ...(model?.awards ?? []).map((a) => ({ key: `${a.key}_awards`, label: a.label })),
    // S8/#417 W6 review (Defect B) — `folded` is the escape hatch for
    // attribution a metric+field walk cannot express at all (football's
    // goalkeeper stats, setbased/nested's match/set outcomes, …), and its
    // rows were aggregated, merged and snapshotted exactly like every
    // other stat, but never reached this display list — so a folded-only
    // key had NO row here regardless of a real, nonzero value sitting in
    // `stats`. Appended LAST: a key `metrics`/`derived`/`awards` already
    // declares (cricket's six-way fine/coarse overlap, `sharesMetricKeys`
    // in stats.ts) keeps that entry's own label via the first-wins filter
    // below, never a second, later-declared name for the same column.
    ...(model?.folded?.keys ?? []).map((x) => ({ key: x.key, label: x.label })),
  ];
  // `metrics` is an AGGREGATION spec, not a display list: a module may declare
  // one key several times to credit it from several payload fields, and
  // `aggregatePlayerStats` folds them all into that single counter (boardgame
  // credits `games` from both `homePerson` and `awayPerson`). Emitting a row
  // per DECLARATION therefore renders the same counter twice under the same
  // key — and the player pages use `key` as their React key, so row identity
  // goes ambiguous the moment a list reorders or animates. One row per key,
  // first declaration wins so declared order is what renders.
  const seen = new Set<string>();
  return declared
    .filter((x) => !seen.has(x.key) && (seen.add(x.key), true))
    .map((x) => ({
      key: x.key,
      label: playerStatLabel(sportKey, x.key, m, x.label),
      value: stats[x.key] ?? 0,
    }))
    .filter((x) => x.value !== 0);
}

export function labelPlayerStats(
  sportKey: string,
  moduleVersion: string,
  stats: Record<string, number>,
  m: MsgFn,
): LabelledPlayerStat[] {
  try {
    return labelFromModel(sportKey, resolveModule(sportKey, moduleVersion).playerStats, stats, m);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// S9/#418 — career rollup: group a person's (or a /me user's) snapshot rows
// by sport and sum them into one card per sport.
// ---------------------------------------------------------------------------

/** The columns every caller's snapshot query needs to select — a thin
 *  DB-shaped input so this file stays free of any `postgres`/`sql` import
 *  (pure, unit-testable with fabricated rows, same discipline as the rest of
 *  this module). `division_id` is what "the number of divisions
 *  contributing" counts; `variant_key` is the REAL, non-null column
 *  `divisions.variant_key` carries (verified — not every caller of this repo
 *  necessarily HAS one, so a future reuse should re-check before assuming),
 *  so a genuine "how many variants of this sport have you played" can differ
 *  from the division count (two divisions can share one variant_key — a
 *  repeated season of the same format is 2 divisions but 1 variant). */
export interface CareerSnapshotRow {
  division_id: string;
  sport_key: string;
  variant_key: string;
  stats: Record<string, number>;
}

export interface CareerSportStats {
  sport_key: string;
  sport_label: string;
  metrics: LabelledPlayerStat[];
  /** Distinct division_id count contributing to this sport's total. */
  divisions: number;
  /** Distinct variant_key count among those divisions — see CareerSnapshotRow. */
  variants: number;
  /** Finalized fixtures the person played across those divisions (fixtures +
   *  entrant_members read, NOT a declared playerStats metric — only 3 of the
   *  11 shipped modules declare a "matches" key at all, so a metric-based
   *  count would silently be zero for football/cricket/hockey/…). */
  matches: number;
}

// sumPlayerStats buckets rows by personId — every row handed to it here
// belongs to the SAME person (or, for /me's cross-org view, the same USER's
// several claimed person identities, deliberately merged into one career
// total), so any constant id works as the bucket key; it never reaches a
// caller.
const CAREER_BUCKET_ID = "career";

/**
 * Group→sum→label a person's snapshot rows into one card per sport. Pure:
 * no DB, no engine fold — `stats` on each row is whatever
 * `player_stat_snapshots` already holds, and `matchesByDivision` is a
 * pre-computed lookup the caller supplies (each caller's own query differs:
 * org-scoped tx, cross-org /me, or the public unauthenticated read — see the
 * three call sites named in this file's header comment).
 *
 * Sorted by localized sport_label so the card order doesn't jump between
 * locales-with-different-alphabetical-sort and doesn't depend on SQL row
 * order.
 */
export function groupCareerStatsBySport(
  rows: readonly CareerSnapshotRow[],
  matchesByDivision: ReadonlyMap<string, number>,
  m: MsgFn,
): CareerSportStats[] {
  const bySport = new Map<string, CareerSnapshotRow[]>();
  for (const row of rows) {
    const group = bySport.get(row.sport_key);
    if (group) group.push(row);
    else bySport.set(row.sport_key, [row]);
  }

  return [...bySport.entries()]
    .map(([sportKey, group]) => {
      // S9/#418 — resolveLatestModule, deliberately, NOT each division's own
      // pinned module_version: divisions inside one sport can be pinned to
      // different versions (a division never changes version once created),
      // so there is no single "the" version for a whole-career card to
      // resolve. The newest module's metric/derived declarations win the
      // LABEL (and the derive FORMULA) for every key it knows, even for a
      // row computed under an older division's older version. When two
      // versions genuinely disagree on what a key MEANS — a rare rename or
      // repurpose across a version bump — an older division's numbers get
      // labelled (and re-derived) under the NEWER meaning; module versions
      // are pinned exactly so this stays rare, and #418 accepts it rather
      // than carrying N label/derive sets on one sport card.
      let model: PlayerStatsModel | undefined;
      try {
        model = resolveLatestModule(sportKey).playerStats;
      } catch {
        model = undefined;
      }
      // Reuses the engine's OWN summation (not hand-rolled addition):
      // sumPlayerStats skips a `derived` key while summing raw components
      // across "fixtures" (here, divisions) and re-derives it AFTER the sum
      // — the mathematically correct order for a formula that isn't a plain
      // sum, and the same discipline the #404 merge-survivor fold depends on.
      const perDivision = group.map((r) => [{ personId: CAREER_BUCKET_ID, stats: r.stats }]);
      const summed = model ? sumPlayerStats(perDivision, model) : [];
      const stats = summed[0]?.stats ?? {};

      const divisionIds = [...new Set(group.map((r) => r.division_id))];
      const matches = divisionIds.reduce((n, id) => n + (matchesByDivision.get(id) ?? 0), 0);

      // A career card states its match count ONCE, in the meta line above the
      // tiles — and that is the count derived from `fixtures`, which exists
      // for all eleven sports. Three modules (carrom, and the setbased and
      // nested kernels) ALSO declare a folded `matches` metric, counted a
      // different way: the engine counts a fixture with any recorded play,
      // the meta line counts a completed one. Both are defensible and they
      // routinely disagree, which on screen read as "1 division · 1 variant ·
      // 0 matches" directly above a tile saying "MATCHES 1" — the same word,
      // two numbers, on one card. Dropping the tile rather than the meta
      // keeps the count that every sport has. The per-division "My stats"
      // block is untouched: it has no meta line, so its `matches` tile is
      // that block's only match count and still means what it always did.
      const metrics = labelFromModel(sportKey, model, stats, m).filter((x) => x.key !== "matches");

      return {
        sport_key: sportKey,
        sport_label: sportLabel(sportKey, m),
        metrics,
        divisions: divisionIds.length,
        variants: new Set(group.map((r) => r.variant_key)).size,
        matches,
      };
    })
    // A sport whose metrics all resolve away — every total zero, or a
    // `sport_key` no longer in the registry while its snapshot rows survive —
    // deliberately KEEPS its card, showing divisions/variants/matches with no
    // tiles. Final review proposed dropping it to match `labelPlayerStats`'s
    // callers (`me.ts`, `if (metrics.length === 0) return []`). Not done: the
    // unit test "an unknown/retired sport_key degrades to empty metrics,
    // never throws — counts stay correct" states the opposite contract on
    // purpose, and the two views are answering different questions. A
    // per-division row with no numbers is noise; a career card is also a
    // record that you PLAYED the sport, which the division and match counts
    // carry on their own. Changing it is a product call, not a consistency
    // cleanup, so it stays as specified.
    .sort((a, b) => a.sport_label.localeCompare(b.sport_label));
}
