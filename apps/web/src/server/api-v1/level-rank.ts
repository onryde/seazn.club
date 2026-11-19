// W2e D11 b (spec §6.3): a table with no counted fixture is LEVEL (`level: true` on every row, anti-goal 3) and has no
// leader, so the two standings routes serve its rows with `rank: null` instead of the ranker's positional 1..n.
//
// At the API SERIALISATION only (E24). The stored snapshot (`standings_snapshots`, `public_standings_v`), `getStandings`
// and `publicStandings` keep the places: the division page, the slideshow, the OG card, the digest and the PDF export read
// them and print the dash from `rankText(row, level)`, so nulling storage would break every one of them. Each route
// handler calls this on the rows it is about to send.
import { isLevelTable } from "@seazn/engine/competition";

/** The two row fields the serialiser reads: a standings row as the routes hold it. */
export interface LevelRankRow {
  rank?: number;
  level?: boolean;
}

/** `rank: null` on EVERY row (the key present, also on a row that stored none) while the table is level
 *  (`isLevelTable`: at least one row, all level); any other table, an empty one included, comes back unchanged. Pure: the
 *  input is not touched. */
export function serialiseLevelRanks<R extends LevelRankRow>(
  rows: readonly R[],
): (Omit<R, "rank"> & { rank: number | null | undefined })[] {
  if (!isLevelTable(rows)) return rows as unknown as (Omit<R, "rank"> & { rank: number | null | undefined })[];
  return rows.map((row) => ({ ...row, rank: null }));
}

/** W5 T22: `serialiseLevelRanks` over a table-per-pool answer that comes as ONE row list (`GET /stages/{id}/standings` with no
 *  `pool_id` on a several-pool stage): each pool's rows — grouped by their `pool` key — are judged level on their own, so a pool
 *  nobody has played in serves `rank: null` while its sibling, already decided, keeps its places. Row order is kept. A list of one
 *  pool (every `pool` the same, null included) is `serialiseLevelRanks`' answer exactly. */
export function serialiseLevelRanksPerPool<R extends LevelRankRow & { pool: string | null }>(
  rows: readonly R[],
): (Omit<R, "rank"> & { rank: number | null | undefined })[] {
  const byPool = new Map<string | null, R[]>();
  for (const row of rows) byPool.set(row.pool, [...(byPool.get(row.pool) ?? []), row]);
  const level = new Set<string | null>([...byPool].filter(([, group]) => isLevelTable(group)).map(([pool]) => pool));
  return rows.map((row) => (level.has(row.pool) ? { ...row, rank: null } : row)) as (Omit<R, "rank"> & { rank: number | null | undefined })[];
}
