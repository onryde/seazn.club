// B05 T4/T4b/T5b — a fake of the routes these tasks wire into
// `runTinySuite`: `GET /stages/{id}/standings` (T4, division0's own FINAL
// stage; T4b, EVERY stage with an `expected.tables` row) and
// `GET /divisions/{id}/stats/players` (T4b, `expected.leaderboards`).
// `_advance-routes.ts`'s own world tracks the exact same stage ids. Shared
// for the same reason `_advance-routes.ts` is: every `sql`-passing fake now
// reaches these routes unconditionally once `_tiny.json`'s streams are
// folded and `s-playoff` completes, and four independent hand-rolled
// versions would risk disagreeing about what these tables/boards look like.
//
// NOT a `.test.ts`, so vitest never collects it — the same convention
// `_advance-routes.ts`/`_division-phase.ts` beside it already use.
//
// A completed bracket/ladder stage's standings snapshot is a PLACEMENT
// TABLE, not a real table: every counting field is zero and only `rank` is
// meaningful (`B05-repins-2026-09-07.md`'s "Verified pins — where B05
// attaches" table, `progression/ts:716-730`). This fake mirrors that shape
// exactly, reusing the SAME `getQualifiers`-shaped callback
// `_advance-routes.ts` already requires from every caller — the target
// stage's own final order IS that qualifier order once it has completed
// (`_tiny.json`'s `s-playoff` never reorders its own two entrants).
//
// T4b's two LEAGUE tables (`d-tiny`/`s-league`, `d-badminton`/
// `s-badminton-league`) are NOT placement tables — every counting field is
// the pack's own real, committed `_tiny.json` value, hardcoded here (same
// "these four files are not ABOUT proving the comparator is correct"
// reasoning `_advance-routes.ts`'s header already gives for hardcoding
// qualifier order — `oracle.test.ts` proves `compareStandings`/
// `compareLeaderboard` themselves, directly, against deliberately
// mismatched fixtures). `tinyLeagueTableRows`/`tinyDivisionPlayerStats`
// below are the ONE place those constants live, reused by every caller
// rather than re-typed four times.
//
// These four test files are not ABOUT proving the oracle comparators are
// correct (`oracle.test.ts` does that, directly, against deliberately
// mismatched fixtures); they exist so the DLS-gate/officials/registration/
// stats assertions each ALREADY covers stay green rather than reddening on
// an unmodeled route.
import type { RawResult } from "../http.ts";

interface FullStandingsRowLike {
  readonly entrantId: string;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  readonly points: number;
  /** B05 T5a — `d-tiebreak`'s own tied rows need `diff`/`for` to give the
   *  tie-order cascade oracle a real subject; d-tiny/d-badminton's rows
   *  never tie and so never needed one. Optional so those two branches stay
   *  untouched. */
  readonly metrics?: Record<string, number>;
}

export interface DivisionPlayerStatsLike {
  readonly metrics: readonly { readonly key: string; readonly label: string }[];
  readonly rows: readonly { readonly person_id: string; readonly full_name: string; readonly stats: Record<string, number> }[];
  readonly requires_detailed_scoring: boolean;
}

/**
 * `_tiny.json`'s own `expected.tables` values, by stage NAME (the
 * `POST /divisions/{id}/stages` payload's own `name` field, `seed.ts:636`)
 * rather than by ref — these fakes never see pack refs, only what a real
 * caller actually POSTs over the wire. `entrantIdsRankOrder` is the SAME
 * `schedule.entrantsOfDivision(divisionId)` order every existing caller of
 * this file already trusts for `_tiny.json`'s qualifier/final-rank checks.
 * Returns `undefined` for a stage name this pack declares no real table for
 * (`"Playoff"`, `"Registration proof..."`) — the caller falls back to the
 * placement-table shape below for those.
 */
export function tinyLeagueTableRows(
  stageName: string,
  entrantIdsRankOrder: readonly string[],
): readonly FullStandingsRowLike[] | undefined {
  const [rank1, rank2] = entrantIdsRankOrder;
  if (rank1 === undefined || rank2 === undefined) return undefined;
  if (stageName === "League") {
    return [
      { entrantId: rank1, played: 3, won: 2, drawn: 1, lost: 0, points: 7 },
      { entrantId: rank2, played: 3, won: 0, drawn: 1, lost: 2, points: 1 },
    ];
  }
  if (stageName === "Badminton League") {
    return [
      { entrantId: rank1, played: 1, won: 1, drawn: 0, lost: 0, points: 2 },
      { entrantId: rank2, played: 1, won: 0, drawn: 0, lost: 1, points: 0 },
    ];
  }
  // B05 T5a — `d-tiebreak`'s own THREE entrants (echo/foxtrot/golf), the
  // tie-order-cascade oracle's genuine subject: echo and golf tie on
  // points (4 each); echo's `diff` (+3) beats golf's (+1), but golf's
  // `for` (10) beats echo's (4) — see build-packs/_tiny.ts's own header
  // comment on `d-tiebreak` for the full arithmetic. `entrantIdsRankOrder`
  // here is CREATION order (echo, foxtrot, golf — `schedule.
  // entrantsOfDivision`'s own convention, same as the two branches above),
  // never rank order, so this branch reindexes into the REAL rank order
  // (echo, golf, foxtrot) itself rather than asking every caller to.
  if (stageName === "Tiebreak League") {
    const [echo, foxtrot, golf] = entrantIdsRankOrder;
    if (echo === undefined || foxtrot === undefined || golf === undefined) return undefined;
    return [
      { entrantId: echo, played: 2, won: 1, drawn: 1, lost: 0, points: 4, metrics: { for: 4, against: 1, diff: 3 } },
      { entrantId: golf, played: 2, won: 1, drawn: 1, lost: 0, points: 4, metrics: { for: 10, against: 9, diff: 1 } },
      { entrantId: foxtrot, played: 2, won: 0, drawn: 0, lost: 2, points: 0, metrics: { for: 8, against: 12, diff: -4 } },
    ];
  }
  return undefined;
}

/**
 * `_tiny.json`'s own `expected.leaderboards` values, by division NAME (the
 * `POST /competitions/{id}/divisions` payload's own `name` field,
 * `seed.ts:613`) — the same discriminator `tinyLeagueTableRows` above already
 * uses for stages, and the only one these fakes ever see (they never see pack
 * refs). `personIdOf` is the SAME `person-${slug(full_name)}` id every one of
 * these four fakes' `POST /api/v1/persons` handler already mints (copied
 * verbatim across all four, per this file's own header note), so this stays
 * correct without each fake tracking its own person-ref map.
 *
 * B05 T5b — `d-tiebreak` ("Tiebreak") joined `d-tiny` ("Tiny") in
 * `expected.leaderboards` when T5b-1 gave `expected.careers` a SECOND
 * division to roll up. Until this branch existed the wired leaderboard oracle
 * fetched a division no fake modelled and every `sql`-passing file died on
 * `fake server: unhandled raw GET /api/v1/divisions/{id}/stats/players`.
 * Returns `undefined` for any other division name (`Badminton`,
 * `Registration UI Proof`), which the pack names no leaderboard for.
 */
export function tinyDivisionPlayerStats(
  divisionName: string,
  personIdOf: (fullName: string) => string,
): DivisionPlayerStatsLike | undefined {
  const metrics = [
    { key: "scores", label: "Scores" },
    { key: "points", label: "Points" },
  ];
  if (divisionName === "Tiny") {
    return {
      metrics,
      rows: [
        { person_id: personIdOf("Ana Alvarez"), full_name: "Ana Alvarez", stats: { scores: 2, points: 2 } },
        { person_id: personIdOf("Bo Baptiste"), full_name: "Bo Baptiste", stats: { scores: 1, points: 2 } },
      ],
      requires_detailed_scoring: false,
    };
  }
  if (divisionName === "Tiebreak") {
    return {
      metrics,
      rows: [
        { person_id: personIdOf("Ana Alvarez"), full_name: "Ana Alvarez", stats: { scores: 1, points: 1 } },
        { person_id: personIdOf("Elena Reyes"), full_name: "Elena Reyes", stats: { scores: 1, points: 1 } },
      ],
      requires_detailed_scoring: false,
    };
  }
  return undefined;
}

/** `usecases/player-stats.ts#personStats`'s response shape. */
interface PersonStatsLike {
  readonly divisions: readonly {
    readonly division_id: string;
    readonly division_name: string;
    readonly stats: Record<string, number>;
  }[];
}

/** `usecases/player-stats.ts#personCareerStats`'s response shape. */
interface PersonCareerStatsLike {
  readonly sports: readonly {
    readonly sport_key: string;
    readonly sport_label: string;
    readonly metrics: readonly { readonly key: string; readonly label: string; readonly value: number }[];
    readonly divisions: number;
    readonly variants: number;
    readonly matches: number;
  }[];
}

/**
 * B05 T5b — one division as these fakes already know it: the id and name they
 * minted at `POST /competitions/{id}/divisions`, the `sport_key` that SAME
 * POST body carried (`seed.ts:614`), and whatever this world already answers
 * for `GET /divisions/{id}/stats/players`.
 */
export interface DivisionCardSource {
  readonly divisionId: string;
  readonly divisionName: string;
  readonly sportKey: string;
  readonly playerStats: DivisionPlayerStatsLike;
}

/**
 * B05 T5b — `GET /persons/{id}/stats`, DERIVED by inverting the per-division
 * leaderboards this world already answers rather than typing a second copy of
 * the same counts. That is the point: the product's own two reads of one
 * historical fact (a division leaderboard and a person's own card) agree by
 * construction here, so `comparePersonDivisionStat`'s wired regression has to
 * come from a knob that genuinely breaks ONE of them — never from two
 * independently-typed fixtures drifting apart, which would red the oracle for
 * a reason that has nothing to do with the product.
 */
export function personStatsFromDivisions(
  personId: string,
  sources: readonly DivisionCardSource[],
): PersonStatsLike {
  return {
    divisions: sources.flatMap((source) => {
      const row = source.playerStats.rows.find((r) => r.person_id === personId);
      return row === undefined
        ? []
        : [{ division_id: source.divisionId, division_name: source.divisionName, stats: row.stats }];
    }),
  };
}

/**
 * B05 T5b — `GET /persons/{id}/stats?group=sport`, derived from the SAME
 * per-division sources by summing each metric across the divisions of one
 * sport. `personCareerStats` files a person's divisions under their sport, so
 * `_tiny.json`'s `d-tiny` and `d-tiebreak` (both `generic`) roll up into ONE
 * `sports[]` entry and `d-badminton` would be its own — which is exactly what
 * `compareCareerStats`'s ambiguity guard (`foundInSports > 1`) exists to
 * catch, so this fake must not flatten every division into one entry.
 *
 * `divisions` is the real per-sport division count; `variants` and `matches`
 * are NOT modelled here (no fake tracks either) and are reported as the
 * division count and 0 — `compareCareerStats` reads only `metrics[].value`
 * and `sports[].length`, never these three.
 */
export function personCareerStatsFromDivisions(
  personId: string,
  sources: readonly DivisionCardSource[],
): PersonCareerStatsLike {
  const bySport = new Map<string, { totals: Map<string, number>; labels: Map<string, string>; divisions: number }>();
  for (const source of sources) {
    const row = source.playerStats.rows.find((r) => r.person_id === personId);
    if (row === undefined) continue;
    let bucket = bySport.get(source.sportKey);
    if (bucket === undefined) {
      bucket = { totals: new Map(), labels: new Map(), divisions: 0 };
      bySport.set(source.sportKey, bucket);
    }
    bucket.divisions += 1;
    for (const metric of source.playerStats.metrics) {
      bucket.labels.set(metric.key, metric.label);
      bucket.totals.set(metric.key, (bucket.totals.get(metric.key) ?? 0) + (row.stats[metric.key] ?? 0));
    }
  }
  return {
    sports: [...bySport.entries()].map(([sportKey, bucket]) => ({
      sport_key: sportKey,
      sport_label: sportKey,
      metrics: [...bucket.totals.entries()].map(([key, value]) => ({
        key,
        label: bucket.labels.get(key) ?? key,
        value,
      })),
      divisions: bucket.divisions,
      variants: bucket.divisions,
      matches: 0,
    })),
  };
}

export interface OracleRoutesWorld {
  /** `raw()`'s own handler for the three oracle routes — `undefined` for
   *  any other method/path, so a caller chains it before its own branches. */
  handle(method: string, path: string): RawResult | undefined;
}

export function makeOracleRoutesWorld(input: {
  /** The SAME callback `_advance-routes.ts`'s own `getQualifiers` takes —
   *  rank-1-first entrant ids for a given stage id, or `undefined` for a
   *  stage this world knows nothing about. */
  getRankedEntrantIds(stageId: string): readonly string[] | undefined;
  /** T4b — real (non-placement) standings rows for a LEAGUE stage,
   *  `undefined` for any stage this world has no real table for (the
   *  bracket/ladder stage `getRankedEntrantIds` already covers). Optional:
   *  a caller that never wires `expected.tables` checks (none, as of this
   *  task) can omit it and keep the old placement-only behavior. */
  getFullStandingsRows?(stageId: string): readonly FullStandingsRowLike[] | undefined;
  /** T4b — `GET /divisions/{id}/stats/players`'s response for a division id,
   *  `undefined` for a division this world has no leaderboard for. Optional
   *  for the same reason `getFullStandingsRows` is. */
  getDivisionPlayerStats?(divisionId: string): DivisionPlayerStatsLike | undefined;
  /** T5b — `GET /persons/{id}/stats`'s response for a person id, `undefined`
   *  for a person this world knows nothing about. Optional for the same
   *  reason the two above are: a caller that never reaches the person-stats
   *  oracles can omit it. */
  getPersonStats?(personId: string): PersonStatsLike | undefined;
  /** T5b — `GET /persons/{id}/stats?group=sport`'s response. A SEPARATE
   *  callback from `getPersonStats`, never the same one filtered: the whole
   *  point of the career oracle is that the rollup is a different read of the
   *  same history, so a fake that served one from the other could not witness
   *  a rollup that disagrees with its own divisions. */
  getPersonCareerStats?(personId: string): PersonCareerStatsLike | undefined;
}): OracleRoutesWorld {
  return {
    handle(method, path) {
      if (method !== "GET") return undefined;

      const standingsMatch = /^\/api\/v1\/stages\/([^/]+)\/standings/.exec(path);
      if (standingsMatch !== null) {
        const stageId = standingsMatch[1];
        const full = input.getFullStandingsRows?.(stageId);
        if (full !== undefined) {
          return {
            status: 200,
            json: {
              ok: true,
              data: { stage_id: stageId, pool_id: null, rows: full, computed_through_seq: 0, updated_at: null },
            },
          };
        }
        const ranked = input.getRankedEntrantIds(stageId) ?? [];
        return {
          status: 200,
          json: {
            ok: true,
            data: {
              stage_id: stageId,
              pool_id: null,
              rows: ranked.map((entrantId, i) => ({
                entrantId,
                played: 0,
                won: 0,
                drawn: 0,
                lost: 0,
                points: 0,
                metrics: {},
                rank: i + 1,
              })),
              computed_through_seq: 0,
              updated_at: null,
            },
          },
        };
      }

      // B05 T5b — the two person-stats reads, told apart by the ONE query
      // string that distinguishes them on the wire (`oracle.ts`'s
      // `fetchPersonCareerStats` appends `?group=sport`; `fetchPersonStats`
      // sends none). B03 T6b's own baseline read of this path goes through
      // `request()` with `?division_id=`, never `raw()`, so it never lands
      // here — and a `?division_id=` that somehow did would fall through to
      // the unfiltered branch rather than being silently answered as a
      // career rollup.
      const [personRoutePath, personQuery] = path.split("?");
      const personStatsMatch = /^\/api\/v1\/persons\/([^/]+)\/stats$/.exec(personRoutePath ?? "");
      if (personStatsMatch !== null) {
        const personId = personStatsMatch[1];
        if (personQuery === "group=sport") {
          const career = input.getPersonCareerStats?.(personId);
          if (career === undefined) return undefined;
          return { status: 200, json: { ok: true, data: career } };
        }
        const personStats = input.getPersonStats?.(personId);
        if (personStats === undefined) return undefined;
        return { status: 200, json: { ok: true, data: personStats } };
      }

      const playerStatsMatch = /^\/api\/v1\/divisions\/([^/]+)\/stats\/players$/.exec(path);
      if (playerStatsMatch !== null) {
        const divisionId = playerStatsMatch[1];
        const stats = input.getDivisionPlayerStats?.(divisionId);
        if (stats === undefined) return undefined;
        return { status: 200, json: { ok: true, data: stats } };
      }

      return undefined;
    },
  };
}
