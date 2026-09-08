// B05 T4/T4b — a fake of the THREE routes these tasks wire into
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
// mismatched fixtures). `tinyLeagueTableRows`/`tinyLeaderboardStats` below
// are the ONE place those constants live, reused by every caller rather
// than re-typed four times.
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
}

interface DivisionPlayerStatsLike {
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
  return undefined;
}

/**
 * `_tiny.json`'s own `expected.leaderboards` values for `d-tiny` — the
 * ONLY division this pack's leaderboard block names. `personIdOf` is the
 * SAME `person-${slug(full_name)}` id every one of these four fakes'
 * `POST /api/v1/persons` handler already mints (copied verbatim across all
 * four, per this file's own header note), so this stays correct without
 * each fake tracking its own person-ref map.
 */
export function tinyDivisionPlayerStats(personIdOf: (fullName: string) => string): DivisionPlayerStatsLike {
  const ana = personIdOf("Ana Alvarez");
  const bo = personIdOf("Bo Baptiste");
  return {
    metrics: [
      { key: "scores", label: "Scores" },
      { key: "points", label: "Points" },
    ],
    rows: [
      { person_id: ana, full_name: "Ana Alvarez", stats: { scores: 2, points: 2 } },
      { person_id: bo, full_name: "Bo Baptiste", stats: { scores: 1, points: 2 } },
    ],
    requires_detailed_scoring: false,
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
}): OracleRoutesWorld {
  return {
    handle(method, path) {
      if (method !== "GET") return undefined;

      const standingsMatch = /^\/api\/v1\/stages\/([^/]+)\/standings/.exec(path);
      if (standingsMatch !== null) {
        const stageId = standingsMatch[1]!;
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

      const playerStatsMatch = /^\/api\/v1\/divisions\/([^/]+)\/stats\/players$/.exec(path);
      if (playerStatsMatch !== null) {
        const divisionId = playerStatsMatch[1]!;
        const stats = input.getDivisionPlayerStats?.(divisionId);
        if (stats === undefined) return undefined;
        return { status: 200, json: { ok: true, data: stats } };
      }

      return undefined;
    },
  };
}
