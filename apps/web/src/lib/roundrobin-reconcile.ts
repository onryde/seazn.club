// W5 app PR A, Task 2 (X-CU-6; RB5-G7, RB5-L17): the pure half of a round robin's Generate over lines that already exist.
//
// Main inserted a league's or a group's lines by their POSITIONAL `ext_key` alone (`rr-r{round}-c{court}`), so a roster change
// before Start added lines that duplicated pairs already played and missed the pairs the newcomers owed (FX-G1, #879: 4 → 6
// added 9 rows that repeated ad, ac, bd, ab, cd and missed af, be, ae, ce, bf). A round robin's identity is a PAIR in a LEG
// inside a POOL, never a position, so the reconcile keys on that: `rrKey`.
//
// W4's `planReconcile` (lib/bracket-reconcile.ts) cannot be reused: it answers `regenerate` whenever the key sets differ, and a
// roster change always changes a round robin's key set. This planner answers `patch` instead — insert the pairs that are
// missing, drop the pairs that are gone — and keeps `regenerate` for the changes a patch cannot express.
//
// The key text matches the engine's `roundRobinLineKey` shape (`rr:${lo}:${hi}:L${leg}`, lo/hi in code-unit order, a self-pair, a
// leg outside 1..8, an empty id or an id holding ":" refused) with the pool in front of it. The engine function arrives in the
// next engine major (app PR B), which pins this one to it; do not diverge. Client-safe and strip-types-safe: no import.

/** A line of a round robin as the planner reads it, whether stored (`id`) or fresh from the engine (no `id`). */
export interface RrLine {
  /** `rrKey(home, away, leg, pool)`. */
  key: string;
  /** The stored fixture's id; absent on a fresh line. A line named in `remove` must carry one. */
  id?: string;
  home: string;
  away: string;
  roundNo: number;
  /** Read from the engine's `RoundRobinFixture.leg` for a fresh line and from the stored `ext_key` for a stored one
   *  (`rrLegOfExtKey`), never derived from `roundNo` or from rounds-per-leg (RB5-L3 puts a leg-2 bye-slot line ahead of
   *  leg-1 appends, so a round number does not name its leg). */
  leg: number;
  /** The pool's id, or null for a league / a one-pool group. */
  pool: string | null;
}

/** What a Generate over existing lines must do. `patch.insert` lines carry the round the planner placed them in (never a
 *  round that already seats one of their entrants); `patch.remove` is stored fixture ids. */
export type RrPlan = { kind: "noop" } | { kind: "patch"; insert: RrLine[]; remove: string[] } | { kind: "regenerate" };

/** The structural facts a key diff cannot see (`roundRobinShape` derives them). */
export interface RrShape {
  /** A pool's round structure changed: it went from an even field (no byes) to an odd one or back, or it is odd (its byes are
   *  recorded per round, FX-G21) and its pairs changed at all. */
  parityFlipped: boolean;
  /** A pool appeared or vanished, or an entrant stands in a different pool than before (a group stage re-snaked, RB5-L17). */
  poolMembershipChanged: boolean;
}

/** A line's key is not one the engine's `roundRobinLineKey` would write: refused by name, never normalised. */
export class RrKeyError extends Error {
  constructor(reason: string) {
    super(`rrKey: ${reason}`);
    this.name = "RrKeyError";
  }
}

/** Legs run 1..8 (the generator's own clamp, `generators.ts`). */
export const RR_MAX_LEG = 8;

/**
 * The (unordered pair, leg, pool) key of a round-robin line (RB5-G7): the same pair in the same leg and pool is the same line
 * whichever side is home; a different leg or a different pool is a different line.
 */
export function rrKey(a: string, b: string, leg: number, pool: string | null): string {
  if (a === "" || b === "") throw new RrKeyError("an entrant id is empty");
  if (a.includes(":") || b.includes(":")) throw new RrKeyError(`an entrant id holds ":" (${a === "" || a.includes(":") ? a : b})`);
  if (a === b) throw new RrKeyError(`a pair needs two entrants, got ${a} twice`);
  if (!Number.isInteger(leg) || leg < 1 || leg > RR_MAX_LEG) throw new RrKeyError(`leg ${String(leg)} is outside 1..${RR_MAX_LEG}`);
  if (pool !== null && (pool === "" || pool.includes("|"))) throw new RrKeyError(`pool ${JSON.stringify(pool)} is empty or holds "|"`);
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return `${pool ?? ""}|rr:${lo}:${hi}:L${leg}`;
}

/** The leg a round-robin line's `ext_key` carries (`rrExtKey`'s `-L{leg}` tail), or null for a line generated before the leg
 *  was stored (`rr-r{round}-c{court}`). */
export function rrLegOfExtKey(extKey: string | null): number | null {
  const m = extKey === null ? null : /-L(\d+)$/.exec(extKey);
  return m === null ? null : Number(m[1]);
}

/** A new line's `ext_key`: the engine's positional id plus the leg it is in, so the leg is STORED with the line. `prefix` is
 *  the pool's (`pA-`) or empty. */
export function rrExtKey(prefix: string, roundNo: number, court: number, leg: number): string {
  return `${prefix}rr-r${roundNo}-c${court}-L${leg}`;
}

/** The `ext_key` of the same line before the leg was appended (`rrExtKey` minus its `-L{leg}` tail): the key a stage drawn
 *  before this change carries. Used where a positional insert must still recognise a line it already wrote. */
export function rrLegacyExtKey(extKey: string): string {
  return extKey.replace(/-L\d+$/, "");
}

/** A stored fixture row as `rrLinesOfRows` reads it. */
export interface RrStoredRow {
  id: string;
  ext_key: string | null;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/**
 * The planner's lines for a stage's stored rows, one entry per row in the order given: `null` for a row that has no
 * (pair, leg) key to speak of — a seat that is empty (an entrant deleted by the FK), or an id the key refuses.
 *
 * The leg is the one the row STORES (`-L{leg}` on its `ext_key`). A row written before the leg was stored has none: its leg is
 * the order its pair appears in within its pool, by round then position (the engine plays a pair once per leg, and an earlier
 * leg always takes the earlier rounds), never an arithmetic on `round_no`.
 */
export function rrLinesOfRows(rows: readonly RrStoredRow[]): (RrLine | null)[] {
  const pairId = (r: RrStoredRow) => {
    const a = r.home_entrant_id!;
    const b = r.away_entrant_id!;
    return `${r.pool_id ?? ""}|${a < b ? a : b}|${a < b ? b : a}`;
  };
  const seated = (r: RrStoredRow) => r.home_entrant_id !== null && r.away_entrant_id !== null;
  const legacyLeg = new Map<string, number>();
  const counts = new Map<string, number>();
  const ordered = rows
    .filter((r) => seated(r) && rrLegOfExtKey(r.ext_key) === null)
    .sort((x, y) => x.round_no - y.round_no || x.seq_in_round - y.seq_in_round);
  for (const r of ordered) {
    const n = (counts.get(pairId(r)) ?? 0) + 1;
    counts.set(pairId(r), n);
    legacyLeg.set(r.id, n);
  }
  return rows.map((r) => {
    if (!seated(r)) return null;
    const leg = rrLegOfExtKey(r.ext_key) ?? legacyLeg.get(r.id)!;
    try {
      return { key: rrKey(r.home_entrant_id!, r.away_entrant_id!, leg, r.pool_id), id: r.id, home: r.home_entrant_id!, away: r.away_entrant_id!, roundNo: r.round_no, leg, pool: r.pool_id };
    } catch (err) {
      if (err instanceof RrKeyError) return null;
      throw err;
    }
  });
}

/** A key present twice in one side: the stored lines or the fresh ones are not a round robin any more. */
function hasRepeat(lines: readonly RrLine[]): boolean {
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.key)) return true;
    seen.add(l.key);
  }
  return false;
}

/**
 * What a Generate does over a round robin that already has lines (RB5-G7, RB5-L17; before Start only — after Start Generate
 * never reshapes, and the caller refuses or answers a no-op without asking this).
 *  - no line either side, or the same keys both sides: `noop`;
 *  - a repeated key either side, or a structural change (`shape`): `regenerate` — the caller deletes the stage's lines and
 *    draws them again with times and courts carried by pair;
 *  - otherwise `patch`: insert every key only the fresh schedule has, remove every stored line whose key it does not.
 *
 * Each inserted line sits in the fresh schedule's round, moved later (never earlier) while that round already seats one of its
 * two entrants in the same pool: a patched table must never seat a player twice in a round.
 */
export function planRoundRobinReconcile(before: readonly RrLine[], fresh: readonly RrLine[], shape: RrShape): RrPlan {
  if (hasRepeat(before) || hasRepeat(fresh)) return { kind: "regenerate" };
  if (shape.parityFlipped || shape.poolMembershipChanged) return { kind: "regenerate" };
  const freshKeys = new Set(fresh.map((l) => l.key));
  const beforeKeys = new Set(before.map((l) => l.key));
  const gone = before.filter((l) => !freshKeys.has(l.key));
  const missing = fresh.filter((l) => !beforeKeys.has(l.key));
  if (gone.length === 0 && missing.length === 0) return { kind: "noop" };

  const remove = gone.map((l) => {
    if (l.id === undefined) throw new Error(`planRoundRobinReconcile: a stored line (${l.key}) has no id to remove`);
    return l.id;
  });
  // Who already stands in each (pool, round) once the removals are made; each placed line joins it.
  const seated = new Map<string, Set<string>>();
  const roundOf = (pool: string | null, roundNo: number) => `${pool ?? ""}|${roundNo}`;
  const seat = (l: { pool: string | null; roundNo: number; home: string; away: string }) => {
    const at = roundOf(l.pool, l.roundNo);
    const set = seated.get(at) ?? new Set<string>();
    set.add(l.home).add(l.away);
    seated.set(at, set);
  };
  for (const l of before) if (freshKeys.has(l.key)) seat(l);
  const insert: RrLine[] = [];
  for (const line of [...missing].sort((x, y) => x.roundNo - y.roundNo)) {
    let roundNo = line.roundNo;
    for (;;) {
      const here = seated.get(roundOf(line.pool, roundNo));
      if (here === undefined || (!here.has(line.home) && !here.has(line.away))) break;
      roundNo++;
    }
    const placed = { ...line, roundNo };
    seat(placed);
    insert.push(placed);
  }
  return { kind: "patch", insert, remove };
}

/** The pools a set of lines stands in, each with its entrants and its keys. */
function poolsOf(lines: readonly RrLine[]): Map<string | null, { keys: Set<string>; entrants: Set<string> }> {
  const pools = new Map<string | null, { keys: Set<string>; entrants: Set<string> }>();
  for (const l of lines) {
    const p = pools.get(l.pool) ?? { keys: new Set<string>(), entrants: new Set<string>() };
    p.keys.add(l.key);
    p.entrants.add(l.home).add(l.away);
    pools.set(l.pool, p);
  }
  return pools;
}

/**
 * The structural facts `planRoundRobinReconcile` needs, from the two line sets and which pools hold a bye (the stored
 * `config.round_byes` for the stored side, the engine's `rounds[].bye` for the fresh one). A pool's parity is read from its
 * byes, never from a member count: after a pre-Start delete the stored lines hold one entrant fewer than the shape they were
 * drawn in, so counting members would call a 6-player table drawn for 6 a table of 5 and miss the flip.
 *
 * An ODD pool that changes at all is `parityFlipped`: its byes are recorded per round (FX-G21) and a patch cannot keep them
 * true, so it is drawn again.
 */
export function roundRobinShape(
  before: readonly RrLine[],
  fresh: readonly RrLine[],
  byePools: { stored: ReadonlySet<string | null>; fresh: ReadonlySet<string | null> },
): RrShape {
  const was = poolsOf(before);
  const now = poolsOf(fresh);
  let parityFlipped = false;
  let poolMembershipChanged = false;
  for (const pool of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(pool);
    const b = now.get(pool);
    if (a === undefined || b === undefined) {
      poolMembershipChanged = true;
      continue;
    }
    const oddThen = byePools.stored.has(pool);
    const oddNow = byePools.fresh.has(pool);
    const sameKeys = a.keys.size === b.keys.size && [...a.keys].every((k) => b.keys.has(k));
    if (oddThen !== oddNow || (oddNow && !sameKeys)) parityFlipped = true;
  }
  const poolOfThen = new Map<string, string | null>();
  for (const [pool, p] of was) for (const e of p.entrants) poolOfThen.set(e, pool);
  for (const [pool, p] of now) {
    for (const e of p.entrants) {
      if (poolOfThen.has(e) && poolOfThen.get(e) !== pool) poolMembershipChanged = true;
    }
  }
  return { parityFlipped, poolMembershipChanged };
}
