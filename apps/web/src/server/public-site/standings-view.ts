import "server-only";
// Spectator surface W2, Task 2 — the standings VIEW builder.
//
// One job: turn a standings snapshot into the `TableViewT` the competition hub
// document carries, with every cell already a formatted string and every name
// already resolved. The client half (`components/public-site/standings-table-view.tsx`)
// then only renders — it holds no sport vocabulary, no number formatting and
// no locale.
//
// R5, one authority per fact: the numbers come from the snapshot and are never
// recomputed here. Column selection is `standingsColumns`, cell formatting is
// `formatMetric`, derived-metric text is the engine's `derivedMetricText`, and
// the tie-break phrase is the engine's `tieBreakLabel` — the same four helpers
// `components/public-site/standings-table.tsx` (the organiser console's and
// the embed's table, deliberately untouched) already uses. This file adds no
// second formatter; the whole cell expression below is that component's, kept
// byte-for-byte so the two tables cannot disagree about what a cell says.
//
// What this file DOES own, and the console table does not: which columns
// survive a 320px viewport, and the localisation of the structural headers.
import {
  DERIVED_METRICS,
  derivedMetricText,
  tieBreakLabel,
  type StandingsRow,
} from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { standingsColumns, formatMetric, type MetricSpecLike } from "@/lib/public-site";
import type { TKey } from "@/lib/i18n-runtime";
import type { TableViewT } from "./competition-hub-schema";

/** The columns a phone shows without asking: played, won, lost, points.
 *  Everything else — draws, the sport's own metrics, the cascade's derived
 *  columns — is the long tail, folded behind the table's "more" disclosure at
 *  phone widths and always visible from `md` up. Exported because it is the
 *  definition of "compact", and a test that restated it would be a second
 *  declaration to drift. */
export const COMPACT_KEYS: ReadonlySet<string> = new Set(["played", "won", "lost", "points"]);

/** The ledger columns `standingsColumns` emits with `kind: "structural"`.
 *  These are COPY (Played, Won, Drawn, Lost, Points) and get a dictionary key;
 *  every other column header is the sport's own NOTATION (GF, NRR, Buchholz
 *  Cut-1) and keeps the engine's label in every locale — the same
 *  "notation, not copy" rule W1's `stat-table.tsx` states for R/B/4s/SR.
 *  Exported (final-review fix F2) so the dictionary-coverage test derives its
 *  `table.col.*` key list from here rather than typing a second copy. */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "played",
  "won",
  "drawn",
  "lost",
  "points",
]);

/** Tie-break trace keys the engine has an English phrase for
 *  (`packages/engine/src/competition/display.ts` — `TIE_BREAK_LABELS`). Each
 *  earns a dictionary key `table.tieBreak.<key>` so the RULE NAME travels
 *  translated too.
 *
 *  Review fix round 1, finding 4: `tieBreakLabel` is hardcoded English, so
 *  wrapping it in the localised `table.tieBreak` frame gave an es/fr/nl
 *  spectator "À égalité avec Alpha — départagés sur goal/run difference". A
 *  bare NOTATION inside a translated sentence is fine (GD, NRR, Buchholz
 *  Cut-1 are the sport's own symbols); a whole English clause is a leak.
 *
 *  DECLARED, not derived: two of the engine's entries label themselves
 *  (`points → "points"`, `wins → "wins"`), so `tieBreakLabel(k) !== k` cannot
 *  separate a key the engine knows from one it does not. A key absent from
 *  this map falls back to `tieBreakLabel`, which is today's behaviour — so an
 *  engine key added later degrades to English rather than to a dotted key on
 *  screen, and the raw key still comes through for anything neither knows.
 *
 *  Review round 2, NEW-3: the dictionary key is SPELLED OUT rather than built
 *  as `` `table.tieBreak.${key}` ``. A concatenated key is invisible to a
 *  grep, to `scripts/i18n/gen-keys.ts` and to any future source-scanning gate
 *  — a whole family could go missing and nothing would say so. `check-parity`
 *  compares locales against `en` and never reads source, so a literal is not
 *  enough on its own either: `standings-view.test.ts` enumerates this map, the
 *  same shape `packages/engine/src/competition/display.test.ts` uses to pin
 *  `DERIVED_METRICS`. Exported for that test.
 *
 *  Typed `TKey`, not `DictionaryKey`, because none of these exist in the
 *  dictionaries yet (Task 6 owns them) and `DictionaryKey` is generated FROM
 *  them — tightening it today would red tsc. Worth tightening once Task 6
 *  lands: that is the only thing that would make a typo here a build error. */
export const TIE_BREAK_MSG_KEYS: Readonly<Record<string, TKey>> = {
  points: "table.tieBreak.points",
  wins: "table.tieBreak.wins",
  diff: "table.tieBreak.diff",
  for: "table.tieBreak.for",
  fair_play: "table.tieBreak.fair_play",
  nrr: "table.tieBreak.nrr",
  set_ratio: "table.tieBreak.set_ratio",
  board_ratio: "table.tieBreak.board_ratio",
  point_ratio: "table.tieBreak.point_ratio",
  h2h_points: "table.tieBreak.h2h_points",
  h2h_diff: "table.tieBreak.h2h_diff",
  h2h_for: "table.tieBreak.h2h_for",
  direct: "table.tieBreak.direct",
  buchholz: "table.tieBreak.buchholz",
  buchholz_cut1: "table.tieBreak.buchholz_cut1",
  sberger: "table.tieBreak.sberger",
  seed: "table.tieBreak.seed",
  lots: "table.tieBreak.lots",
};

/** Sort key for a row the ranking pass has not ranked (a division with no
 *  played fixtures yet, or a row excluded from the cascade). Unranked rows go
 *  last. Deliberately NOT the `99` that `standings-table.tsx` uses: a division
 *  with a hundred or more entrants would sort its rank-100 row BEHIND every
 *  unranked one. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

export interface TableViewInput {
  /** Stable id for this table within the document — a division may publish an
   *  overall table and one per pool, so this is not the division id. */
  id: string;
  division: { id: string; slug: string; name: string };
  /** Already-resolved heading ("League", "Pool A"). */
  caption: string;
  /** Where the phone-composed table's "full division" link points. */
  fullHref: string;
  rows: readonly StandingsRow[];
  metricSpecs: readonly MetricSpecLike[];
  cascade: readonly string[];
  entrantNames: Record<string, string>;
  /** entrant_id → badge URL. A missing key and an explicit null are the same
   *  thing to the renderer: initials, via `EntityLogo`. */
  entrantLogos: Record<string, string | null>;
  /** entrant_id → the entrant's own colour. Same contract as `entrantLogos`
   *  above: a missing key and an explicit null are one thing to the renderer,
   *  which falls through `EntityLogo`'s chain to a neutral tile. */
  entrantColours: Record<string, string | null>;
  championId: string | null;
  updatedAt: string;
  /** `t(dict, …)` bound by the caller, in the ORG's locale. The builder resolves
   *  every string it emits; nothing downstream re-derives one. */
  msg: (key: TKey, vars?: Record<string, string | number>) => string;
}

export function buildTableView(input: TableViewInput): TableViewT {
  const columns = standingsColumns(input.metricSpecs, input.cascade, input.rows, DERIVED_METRICS);
  const ranked = [...input.rows].sort((a, b) => (a.rank ?? UNRANKED) - (b.rank ?? UNRANKED));
  const name = (id: string) => input.entrantNames[id] ?? id;
  const rule = (key: string) => {
    const dictKey = TIE_BREAK_MSG_KEYS[key];
    return dictKey === undefined ? tieBreakLabel(key) : input.msg(dictKey);
  };

  return {
    id: input.id,
    divisionId: input.division.id,
    divisionSlug: input.division.slug,
    divisionName: input.division.name,
    caption: input.caption,
    fullHref: input.fullHref,
    updatedAt: input.updatedAt,
    columns: columns.map((c) => ({
      key: c.key,
      abbr: c.label,
      title: STRUCTURAL_KEYS.has(c.key) ? input.msg(`table.col.${c.key}`) : c.label,
      compact: COMPACT_KEYS.has(c.key),
    })),
    rows: ranked.map((r) => ({
      rank: r.rank ?? null,
      entrantId: r.entrantId,
      name: name(r.entrantId),
      badgeUrl: input.entrantLogos[r.entrantId] ?? null,
      colour: input.entrantColours[r.entrantId] ?? null,
      // Byte-for-byte `standings-table.tsx`'s cell expression, in the same
      // column order — the view's `cells[i]` IS `columns[i]`, and the renderer
      // relies on that pairing rather than looking anything up by key.
      cells: columns.map((c) =>
        c.kind === "derived"
          ? (derivedMetricText(r, c.key as TiebreakerKey) ?? "—")
          : c.kind === "structural"
            ? formatMetric(r[c.key as "played" | "won" | "drawn" | "lost" | "points"])
            : formatMetric(r.metrics[c.key], c.decimals),
      ),
      tieBreakText: r.tieBreak
        ? input.msg("table.tieBreak", {
            with: r.tieBreak.with.map(name).join(", "),
            rule: rule(r.tieBreak.key),
          })
        : null,
      champion: input.championId === r.entrantId,
    })),
  };
}
