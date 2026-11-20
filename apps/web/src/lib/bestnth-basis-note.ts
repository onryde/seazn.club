// W5 app PR B Task 4 (ST-G3; RB5-U1, RB5-U3, X-UP-3; ruling 286, R24 pick 16 B, preflight C3/C4): the Standings footnote under a
// group stage whose best-Nth qualifiers were compared across UNEQUAL pools. Since engine 10 every candidate of a larger pool is
// compared without its results against that pool's bottom k = effective size - the smallest supplying pool's, so all are
// compared on the same number of matches; this says so, and names each result left out. Equal pools leave nothing out, and
// then there is no footnote (the empty case: `basis.dropped` empty -> null).
//
// Pure and client-safe. The basis is the engine's own `ComparisonBasis` (the stored proposal's slot, `loadBestNthBases`), the
// rows the stage's own standings; nothing here re-derives the comparison. C4: "compared on {n} matches", never "matches
// played" - `matchesCounted` is the largest number of matches a compared row counts.
import type { ComparisonBasis } from "@seazn/engine/competition";

export interface BasisPool {
  /** The pool's key ('A', 'B', ...): the key `ComparisonBasis.dropped[].pool` names. */
  key: string;
  rows: readonly { entrantId: string; rank?: number | null }[];
}

export interface BasisNoteText {
  line: string;
  leftOutTitle: string;
  /** One line per supplying pool's candidate: each result left out, or that nothing was. */
  leftOut: string[];
}

type T = (key: string, vars?: Record<string, string | number>) => string;

const ORDINAL_KEYS = new Set(["one", "two", "few", "other"]);

/** "5th" in the reader's language: the locale's ordinal plural category picks the pattern (`table.ordinal.*`). */
export function ordinalText(n: number, locale: string, t: T): string {
  const cat = new Intl.PluralRules(locale, { type: "ordinal" }).select(n);
  return t(`table.ordinal.${ORDINAL_KEYS.has(cat) ? cat : "other"}`, { n });
}

/** The footnote for one source stage, or null when nothing was left out. `expunged`: the stage's expunged leavers, who are no
 *  candidate and hold no place (RB5-U5) - a place is counted among the pool's other rows, in rank order. */
export function bestNthBasisNote(
  basis: ComparisonBasis,
  pools: readonly BasisPool[],
  names: Readonly<Record<string, string>>,
  expunged: ReadonlySet<string>,
  t: T,
  locale: string,
): BasisNoteText | null {
  if (basis.dropped.length === 0) return null;
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const nameOf = (id: string) => names[id] ?? id;
  const poolLabel = (key: string) => t("table.poolLabel", { key });
  const placed = new Map(
    pools.map((p) => [
      p.key,
      [...p.rows].filter((r) => !expunged.has(r.entrantId)).sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)).map((r) => r.entrantId),
    ]),
  );
  const placeOf = (pool: string, id: string): number => {
    const at = placed.get(pool)?.indexOf(id) ?? -1;
    if (at < 0) throw new Error(`bestNthBasisNote: ${id} left out of pool ${pool} has no row in it`);
    return at + 1;
  };
  // "5th in Group A and Group B": one phrase per place, its pools in the stage's own pool order (the engine lists `dropped` in
  // its comparison's order, which is not the reader's A, B, C).
  const poolOrder = (key: string) => pools.findIndex((p) => p.key === key);
  const byPlace = new Map<number, string[]>();
  for (const d of basis.dropped) {
    for (const id of d.against) {
      const place = placeOf(d.pool, id);
      byPlace.set(place, [...(byPlace.get(place) ?? []), d.pool]);
    }
  }
  const against = list.format(
    [...byPlace]
      .sort(([a], [b]) => a - b)
      .map(([place, keys]) => t("table.bestNth.against", { place: ordinalText(place, locale, t), pools: list.format([...keys].sort((x, y) => poolOrder(x) - poolOrder(y)).map(poolLabel)) })),
  );
  const who = basis.nth === 1 || basis.nth === 2 ? t(`table.bestNth.who.${basis.nth}`) : t("table.bestNth.who.other", { nth: ordinalText(basis.nth, locale, t) });
  const n = basis.matchesCounted;
  const line = t(`table.bestNth.basis.${new Intl.PluralRules(locale).select(n) === "one" ? "one" : "other"}`, { who, count: n, against });
  const leftOut: string[] = [];
  for (const p of pools) {
    const candidate = placed.get(p.key)![basis.nth - 1];
    // RB5-U7: a pool with no row at the nth supplies no candidate, so nothing of it was compared.
    if (candidate === undefined) continue;
    const dropped = basis.dropped.find((d) => d.pool === p.key);
    if (dropped === undefined || dropped.against.length === 0) {
      leftOut.push(t("table.bestNth.leftOut.none", { name: nameOf(candidate), pool: poolLabel(p.key) }));
      continue;
    }
    for (const id of dropped.against) {
      leftOut.push(t("table.bestNth.leftOut.result", { name: nameOf(candidate), opponent: nameOf(id), place: ordinalText(placeOf(p.key, id), locale, t), pool: poolLabel(p.key) }));
    }
  }
  return { line, leftOutTitle: t("table.bestNth.leftOut.title"), leftOut };
}

/** A source stage's footnotes for the pages: one per nth its best-Nth qualifiers were compared at, none when nothing was left
 *  out. `withdrawals`: the division's ACTIVE table-withdrawal rows (`loadTableWithdrawals`); this stage's expunge-policy ones are
 *  the expunged leavers. A stage with no stored basis (no proposal, equal pools, on_complete) has none. */
export function stageBasisNotes(
  stageId: string,
  bases: readonly ComparisonBasis[] | undefined,
  pools: readonly BasisPool[],
  names: Readonly<Record<string, string>>,
  withdrawals: readonly { stage_id: string; entrant_id: string; policy: string }[],
  t: T,
  locale: string,
): BasisNoteText[] {
  if (bases === undefined || bases.length === 0) return [];
  const expunged = new Set(withdrawals.filter((r) => r.stage_id === stageId && r.policy === "expunge").map((r) => r.entrant_id));
  return bases.flatMap((b) => bestNthBasisNote(b, pools, names, expunged, t, locale) ?? []);
}
