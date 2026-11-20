// W5 app PR A, Task 13 (X-PO-3 <- RB5-P5, X-PO-4 <- RB5-P7; ST-G14 app half; rulings 285, 288): the manual rank override, decided in
// ONE pure place - which stage kinds take one, and how a body is checked and merged into the stage's stored pins.
//
// A rank override pins an entrant's place in the table of her POOL. The engine already applies locks per pool (a lock whose entrant
// is not in the pool is ignored, and a rank above the pool's size is thrown at the next recompute: `applyRankLocks`), so the app owes
// the write-time check the engine cannot make before the write: each rank once per pool, none above the pool's size. A league (and a
// stage drawn without pools) is one pool, whose key is null.
//
// Client-safe and strip-types-safe: no imports.

/** The stage kinds whose standings are a TABLE a rank can be pinned in: the fold's own declaration of table kinds
 *  (`engine-db/competition.ts` TABLE_KINDS - americano rides the league fold). Every other kind (a bracket, a ladder) has no table. */
export const RANK_OVERRIDE_TABLE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss", "americano"]);

/** RB5-P7: does a stage of this kind report an organiser's rank pins (the public `has_rank_overrides`)? Only a table does. A placement
 *  game on a bracket also writes `config.rank_overrides`, which nothing there reads. */
export function reportsRankOverrides(kind: string, stored: boolean | null | undefined): boolean {
  return stored === true && RANK_OVERRIDE_TABLE_KINDS.has(kind);
}

/** A stored pin. `pool_id` is absent on a pin written before W5 T13 or by a placement game, and null on a stage with no pools. */
export interface RankPin {
  entrant_id: string;
  rank: number;
  pool_id?: string | null;
}

/** Where the stage's entrants sit, read off its stored lines. `seated` is false for a stage drawn with no lines yet: there is no pool to
 *  check against, and the body is taken as one table. Nothing re-checks such a pin at the draw; the engine reads a lock by its ENTRANT, and
 *  `locksThatFit` (the read side) holds it back until its pool has the rows to place it. */
export interface StageSeating {
  seated: boolean;
  /** entrant id -> its pool id (null: the stage has no pools). */
  poolOf: ReadonlyMap<string, string | null>;
  /** pool id (null: the stage has no pools) -> how many entrants hold a seat in it. */
  sizeOf: ReadonlyMap<string | null, number>;
  /** B4 fix wave (m4): the stage is drawn in POOLS (a group stage), so an unseated one has no pool a pin could name. */
  pooled?: boolean;
}

export type RankOverridePlan =
  | { ok: true; pins: RankPin[] }
  | { ok: false; reason: "duplicate"; pool_id: string | null; rank: number }
  | { ok: false; reason: "above_size"; pool_id: string | null; rank: number; size: number }
  | { ok: false; reason: "unseated"; entrant_id: string }
  | { ok: false; reason: "undrawn_pools" };

/** The pool a stored pin belongs to: what it says, else (an old pin) the pool its entrant sits in now, else unknown. */
export function pinPool(pin: RankPin, seating: StageSeating): string | null | undefined {
  if ("pool_id" in pin && pin.pool_id !== undefined) return pin.pool_id;
  return seating.poolOf.get(pin.entrant_id);
}

/**
 * Check `rows` against the stage's seating and merge them into `existing`. Each pool named by the body has its pins REPLACED by the body's
 * (a second override of pool B leaves pool A's pins alone); a pin whose pool the body does not name is kept as it is. Refusals, in order:
 * an entrant with no seat in a stage that has lines (her pool is unknown, so she cannot be pinned), the same rank twice in one pool,
 * a rank above the pool's size.
 */
export function planRankOverride(
  existing: readonly RankPin[],
  rows: readonly { entrant_id: string; rank: number }[],
  seating: StageSeating,
): RankOverridePlan {
  // B4 fix wave (m4): a POOLED stage not drawn yet has no pool ids, and a pin stored with none would be held back by the read side
  // (`locksThatFit`) for good, with no signal. A pin must name its pool, so it waits for the draw.
  if (!seating.seated && seating.pooled === true) return { ok: false, reason: "undrawn_pools" };
  const poolOfRow = (entrantId: string): string | null | undefined => (seating.seated ? seating.poolOf.get(entrantId) : null);
  const incoming: RankPin[] = [];
  for (const row of rows) {
    const pool = poolOfRow(row.entrant_id);
    if (pool === undefined) return { ok: false, reason: "unseated", entrant_id: row.entrant_id };
    incoming.push({ entrant_id: row.entrant_id, rank: row.rank, pool_id: pool });
  }
  const taken = new Set<string>();
  for (const pin of incoming) {
    const key = `${pin.pool_id ?? ""}|${pin.rank}`;
    if (taken.has(key)) return { ok: false, reason: "duplicate", pool_id: pin.pool_id ?? null, rank: pin.rank };
    taken.add(key);
    if (seating.seated) {
      const size = seating.sizeOf.get(pin.pool_id ?? null) ?? 0;
      if (pin.rank > size) return { ok: false, reason: "above_size", pool_id: pin.pool_id ?? null, rank: pin.rank, size };
    }
  }
  const named = new Set(incoming.map((p) => p.pool_id ?? null));
  const kept = existing.filter((pin) => {
    const pool = seating.seated ? pinPool(pin, seating) : (pin.pool_id ?? null);
    return pool === undefined || !named.has(pool);
  });
  return { ok: true, pins: [...kept, ...incoming] };
}

/** The pools whose membership differs between two seatings (a pool in only one of them counts as changed). Keys are pool ids, null for none. */
export function changedPools(before: ReadonlyMap<string | null, ReadonlySet<string>>, after: ReadonlyMap<string | null, ReadonlySet<string>>): Set<string | null> {
  const changed = new Set<string | null>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    if (a === undefined || b === undefined || a.size !== b.size || [...a].some((id) => !b.has(id))) changed.add(key);
  }
  return changed;
}

/** The pins that survive a redraw: those whose pool did not change. A pin with no stored pool is judged by the pool its entrant sat in
 *  BEFORE the redraw; one whose pool cannot be told is kept (nothing says it moved). */
export function pinsSurvivingRedraw(
  pins: readonly RankPin[],
  changed: ReadonlySet<string | null>,
  beforePoolOf: ReadonlyMap<string, string | null>,
): RankPin[] {
  return pins.filter((pin) => {
    const pool = "pool_id" in pin && pin.pool_id !== undefined ? pin.pool_id : beforePoolOf.get(pin.entrant_id);
    return pool === undefined || !changed.has(pool);
  });
}

/** The engine's view of a fixture for pool membership: the pool it sits in and whose results it carries (`TableFixture`, structurally). */
export interface PoolFixtureLike {
  poolId?: string;
  result?: readonly [{ entrantId: string }, { entrantId: string }];
  awardDelta?: { entrantId: string };
}

/**
 * ST-G14 read side: the locks the fold may hand the engine. The engine ranks a POOLED stage's pool over the entrants holding a result or
 * an award in that pool (`entrantsOfPool`), and `applyRankLocks` throws when a lock's rank is above that count - so a pin the write
 * check accepted (it counts SEATS) would break every later score while a pool has played too little. A lock whose rank exceeds the
 * results-bearing count of its entrant's pool is held back until the pool has the rows. A stage with one pool (a league) ranks all its
 * entrants, which the write check already counts, so every lock passes. A lock whose entrant holds a result in no pool is ignored by the
 * engine and passes.
 */
export function locksThatFit<L extends { entrantId: string; rank: number }>(
  locks: readonly L[],
  fixtures: readonly PoolFixtureLike[],
  seating?: ReadonlyMap<string, string>,
): L[] {
  // W5 app PR B Task 1 (C12, X-PO-1): with a SEATING (`TableStage.pools`) a pool's table is its seated members from the first fold,
  // and the engine checks every lock against it (`validateRankLocks(locks, entrants, pools)`: an entrant no pool seats, or a rank
  // above the pool's seated size, refuses the fold). So a pin waits on its pool's SEATED size, never its results, and a pin on an
  // entrant no pool seats (a stored config no write re-checks) is held back rather than handed to a refusal.
  if (seating !== undefined && seating.size > 0) {
    const sizes = new Map<string, number>();
    for (const pool of seating.values()) sizes.set(pool, (sizes.get(pool) ?? 0) + 1);
    return locks.filter((lock) => {
      const pool = seating.get(lock.entrantId);
      return pool !== undefined && lock.rank <= sizes.get(pool)!;
    });
  }
  const pools = new Set(fixtures.map((f) => f.poolId ?? ""));
  if (pools.size <= 1) return [...locks];
  const members = new Map<string, Set<string>>();
  for (const f of fixtures) {
    const pool = f.poolId ?? "";
    const set = members.get(pool) ?? new Set<string>();
    if (f.result !== undefined) {
      set.add(f.result[0].entrantId);
      set.add(f.result[1].entrantId);
    }
    if (f.awardDelta !== undefined) set.add(f.awardDelta.entrantId);
    members.set(pool, set);
  }
  return locks.filter((lock) => [...members.values()].every((set) => !set.has(lock.entrantId) || lock.rank <= set.size));
}
