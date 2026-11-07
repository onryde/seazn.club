// The order a stage's pools read in — ONE authority for every surface that
// draws one standings table per pool: the public division page, the embed, the
// competition hub (its Table tab and the Overview's previews both read the
// hub's `tables`), and the organiser console.
//
// Pools have no position column. Their `key` IS the position: the generator
// creates the i-th pool as `POOL_KEYS[i]` ("A", "B", …) and names it
// "Pool " + key (`server/usecases/stages.ts`). So pools order by key, then by
// name, both with a NATURAL collation ("Pool 2" before "Pool 10"), and by id
// last — only so that two pools a reader cannot tell apart still land in one
// stable order.
//
// Never by id first. Ids are random UUIDs, and the division page and the hub
// used to sort on them, so "Pool B" read above "Pool A" whenever B's id
// happened to sort lower.

export interface PoolOrderRef {
  id: string;
  key?: string | null;
  name?: string | null;
}

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Two pools in display order: key, then name (natural), then id. */
export function comparePools(a: PoolOrderRef, b: PoolOrderRef): number {
  return (
    natural.compare(a.key ?? "", b.key ?? "") ||
    natural.compare(a.name ?? "", b.name ?? "") ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** A comparator for one stage's standings snapshots, by their pool's display
 *  order. The stage-wide table (no pool) reads first, as it always has; a
 *  snapshot whose pool `pools` does not list reads after every listed one. */
export function byPoolOrder(
  pools: readonly PoolOrderRef[],
): (a: { pool_id?: string | null }, b: { pool_id?: string | null }) => number {
  const byId = new Map(pools.map((p) => [p.id, p]));
  return (a, b) => {
    const ida = a.pool_id ?? null;
    const idb = b.pool_id ?? null;
    if (ida === idb) return 0;
    if (ida === null) return -1;
    if (idb === null) return 1;
    const pa = byId.get(ida);
    const pb = byId.get(idb);
    if (pa && pb) return comparePools(pa, pb);
    if (pa) return -1;
    if (pb) return 1;
    return ida < idb ? -1 : 1;
  };
}

/**
 * ST-G26 (W4 app A Task 23): a division's standings in the product's order — its stages by seq (the order the organiser
 * built them), and inside a stage its pools in display order (`byPoolOrder`: the stage-wide table, then key, natural).
 * `public_standings_v` has no order of its own, and an unordered read hands its rows on in whatever order the plan
 * produced — heap order is WRITE order, and a knockout writes its placement snapshot last of all. Every reader that
 * takes the list's order as the division's goes through here: the public division read (the share card's first table,
 * /present's one slide per snapshot) and the public JSON API (`publicStandings`, B6b review finding 6).
 *
 * Sorted in code, not SQL, so the pool order keeps one authority (this file's natural collation). A snapshot whose
 * stage the caller did not list reads after every stage it did. Returns a sorted COPY.
 */
export function inStageThenPoolOrder<T extends { stage_id: string; pool_id: string | null }>(
  standings: readonly T[],
  stages: readonly { id: string; seq: number }[],
  pools: readonly PoolOrderRef[],
): T[] {
  const seq = new Map(stages.map((st) => [st.id, st.seq]));
  const stageSeq = (s: T) => seq.get(s.stage_id) ?? Number.MAX_SAFE_INTEGER;
  const poolOrder = byPoolOrder(pools);
  return [...standings].sort((a, b) => stageSeq(a) - stageSeq(b) || poolOrder(a, b));
}
