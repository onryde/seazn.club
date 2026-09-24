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
