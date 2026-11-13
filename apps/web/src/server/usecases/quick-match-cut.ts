// Quick match plan 5, Task 2 (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D4, D5, P7, P8;
// spec docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §11): who a tie at the cut affects.
//
// A League + Knockout quick match sends the top `q` (2 or 4) of its league to the knockout. The engine ranks a class of
// sides it cannot separate by the lot and flags every member `tieUnbroken` (P7), whether the class sits wholly among the
// qualifiers or across the cut line, so the app tells the two apart here, from the stored table alone:
//   - case 1, the class STRADDLES the cut (some members ranked ≤ q, some below): the guests are asked (§5.1);
//   - case 2, every member goes through: the stored lot orders them, marked "decided by lot", nobody is asked (§5.2);
//   - every member below the cut: nothing to say.
//
// Pure: no DB, no `server-only`, so the home's view (T7) can import the types. The interface is five functions over
// plain rows; the advance (T4), the home read model (T5) and the view (T7) each ask the same question here, never a
// second time in their own words.
import type { StandingsRow } from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";

/** One stored standings row, as the cut reads it (`cutRowOf`). */
export interface CutRow {
  entrantId: string;
  /** 1-based, distinct per row (the engine ranks a residual class by the lot, so no two rows share a rank). */
  rank: number;
  /** Level on every step before the lot (the engine's `tieUnbroken`). */
  tieUnbroken: boolean;
  /** The other members of the row's tie class (the engine's `tieBreak.with`); read only on a `tieUnbroken` row. */
  tieWith: readonly string[];
  /** The step that ordered the row within its class (`tieBreak.key`: "lots" for a residual class), null with no trace. */
  tieKey: string | null;
}

/** A class of sides level on every step before the lot, that reaches the cut. */
export interface CutTie {
  /** The class, sorted: the class's identity (the engine's members key), what a stored decision is keyed on. */
  entrantIds: string[];
  /** The class in the live table's order (the stored lot's order). */
  ranked: string[];
  /** The class's best rank: "Tie for {place}". */
  place: number;
  /** How many of the class go through: "pick {seats} of {entrantIds.length}". */
  seats: number;
  /** Some members go through and some do not (case 1, ask). False: every member goes through (case 2, the lot). */
  straddles: boolean;
  /** Every member was ordered by the lot (`tieKey === "lots"`), so `ranked` is a drawn order a toss may reveal and a
   *  view may label "decided by lot". False for a residual class the engine ordered by SEED: a table with no counted
   *  match draws no lot (the engine's anti-goal 3) and falls back to seed then id, the typing order. That order is no
   *  coin: offer no Toss on it and never call it "by lot". */
  byLot: boolean;
}

const TWO_STRADDLE = "quick match cut: two ties straddle one cut";

/** A stored standings row as the cut reads it. A row with no rank is refused: the cut is read off ranks, and a rank the
 *  table never gave would place a side above or below the line by accident. */
export function cutRowOf(row: StandingsRow): CutRow {
  if (row.rank === undefined) throw new Error(`quick match cut: standings row ${row.entrantId} has no rank`);
  return {
    entrantId: row.entrantId,
    rank: row.rank,
    tieUnbroken: row.tieUnbroken === true,
    tieWith: row.tieBreak?.with ?? [],
    tieKey: row.tieBreak?.key ?? null,
  };
}

/**
 * Every tie class that reaches the cut, best place first: D4. A class is a `tieUnbroken` row plus its `tieWith`; its
 * seats are the members ranked ≤ `qualifiers`. `0 < seats < size` straddles (case 1), `seats === size` is all through
 * (case 2), `seats === 0` is left out. The input's order does not matter and it is never written.
 *
 * Refused, as faults (the engine never stores such a table): a member named with no row; members that disagree on
 * their class (each member must be `tieUnbroken` and name exactly the others); a level row level with nobody; a class
 * whose ranks are not consecutive; and two straddling classes (one cut line crosses at most one class of consecutive
 * ranks, so only rows that share a rank can reach this last one).
 */
export function cutTies(rows: readonly CutRow[], qualifiers: 2 | 4): CutTie[] {
  const byId = new Map(rows.map((r) => [r.entrantId, r] as const));
  const classOf = (r: CutRow): string[] => [r.entrantId, ...r.tieWith].sort();
  const seen = new Set<string>();
  const ties: CutTie[] = [];
  for (const row of rows) {
    if (!row.tieUnbroken || seen.has(row.entrantId)) continue;
    if (row.tieWith.length === 0) throw new Error(`quick match cut: ${row.entrantId} is marked level, but level with nobody`);
    const ids = classOf(row);
    const key = ids.join(",");
    const members = ids.map((id) => {
      const member = byId.get(id);
      if (member === undefined) throw new Error(`quick match cut: ${row.entrantId} is level with ${id}, which has no row`);
      return member;
    });
    for (const member of members) {
      if (!member.tieUnbroken || classOf(member).join(",") !== key) {
        throw new Error(`quick match cut: ${row.entrantId} and ${member.entrantId} disagree on their tie`);
      }
    }
    for (const id of ids) seen.add(id);
    const ranked = [...members].sort((a, b) => a.rank - b.rank);
    if (ranked.at(-1)!.rank - ranked[0]!.rank !== ranked.length - 1) {
      throw new Error(`quick match cut: the tie ${key} does not hold consecutive ranks`);
    }
    const seats = members.filter((m) => m.rank <= qualifiers).length;
    if (seats === 0) continue;
    ties.push({
      entrantIds: ids,
      ranked: ranked.map((m) => m.entrantId),
      place: ranked[0]!.rank,
      seats,
      straddles: seats < ids.length,
      byLot: members.every((m) => m.tieKey === "lots"),
    });
  }
  ties.sort((a, b) => a.place - b.place);
  openTie(ties); // the one-straddle invariant, asserted where the list is made
  return ties;
}

/** The tie the guests are asked about (case 1), or null. More than one is a fault, never a choice. */
export function openTie(ties: readonly CutTie[]): CutTie | null {
  const open = ties.filter((t) => t.straddles);
  if (open.length > 1) throw new Error(TWO_STRADDLE);
  return open[0] ?? null;
}

/** "Toss a coin" (D5, §11): the stored lot IS the coin, so the toss sends through the class's first `seats` in the live
 *  table's order. No second draw: a reload or another phone shows the same result. A coin only when `tie.byLot`: on a
 *  class the engine left in seed order this is the typing order, and the caller must not offer it as a toss. */
export function tossThrough(tie: CutTie): string[] {
  return tie.ranked.slice(0, tie.seats);
}

/**
 * The tiebreak order a League + Knockout quick match's LEAGUE stage is stored with: the sport's default for a league
 * (`module.defaultTiebreakers("league", cfg)`) with every `seed` step removed, every other step kept in its order.
 * Controller ruling 2026-11-13 (plan Q1's PO rec): a quick match seeds its sides in the order they were typed, so a seed
 * step (tennis and ice hockey list one before `lots`, P8) would separate two sides level at the cut by typing order,
 * silently: the spec's anti-goal. Without it they reach the lot, and the cut asks. Plain League quick matches and
 * organiser competitions keep the default unchanged.
 *
 * Refused unless the result ends in `lots`: the toss reveals the stored lot (D5), so the lot must be the last step.
 */
export function cutTiebreakers(sportDefault: readonly TiebreakerKey[]): TiebreakerKey[] {
  const order = sportDefault.filter((k) => k !== "seed");
  if (order.at(-1) !== "lots") {
    throw new Error(`quick match cut: a tiebreak order must end in lots, not [${sportDefault.join(", ")}]`);
  }
  return order;
}
