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
// `components/public-site/standings-table.tsx` (the division page's, the
// embed's and the organiser console's table) already uses. This file adds no
// second formatter; the whole cell expression below is that component's, kept
// byte-for-byte so the two tables cannot disagree about what a cell says.
//
// What this file DOES own: which columns survive a 320px viewport, and the
// words over the columns and in the tie note (`columnHeader`, `tieBreakRule`),
// which that component now reads from here too.
import {
  DERIVED_METRICS,
  RATIO_LEDGERS,
  derivedMetricText,
  tieBreakLabel,
  type RatioKey,
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
 *  so does every sport metric and derived column in `METRIC_HEADER_KEYS`
 *  below. Only the columns `NOTATION_HEADERS` names (NRR, Buchholz Cut-1) keep
 *  the engine's label in every locale — the same "notation, not copy" rule
 *  W1's `stat-table.tsx` states for R/B/4s/SR.
 *  Exported (final-review fix F2) so the dictionary-coverage test derives its
 *  `table.col.*` key list from here rather than typing a second copy. */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "played",
  "won",
  "drawn",
  "lost",
  "points",
]);

/** The VISIBLE abbreviation over each structural column, keyed per column.
 *  `standingsColumns` labels them "P", "W", "D", "L", "Pts" — English letters
 *  that a Spanish reader takes for PJ/G/E/P/Pts, where "P" is Perdidos, the
 *  LOST column — so they are copy exactly as their `table.col.*` titles are
 *  (Task 16's zero-English sweep found the header printing English in es, fr
 *  and nl). Spelled out rather than concatenated, per NEW-3 below; exact
 *  membership against `STRUCTURAL_KEYS` is pinned in `standings-view.test.ts`. */
export const STRUCTURAL_ABBR_KEYS: Readonly<Record<string, TKey>> = {
  played: "table.abbr.played",
  won: "table.abbr.won",
  drawn: "table.abbr.drawn",
  lost: "table.abbr.lost",
  points: "table.abbr.points",
};

/** A header's two dictionary keys: the letters over the column, and the word
 *  they stand for (the `title` a pointer hovers and the word a screen reader
 *  says). A column whose header was already a whole word uses one key for both. */
export interface HeaderKeys {
  abbr: TKey;
  title: TKey;
}
const word = (key: TKey): HeaderKeys => ({ abbr: key, title: key });

/** Every sport metric and derived column a shipped module can put in a table,
 *  as COPY in the reader's language (Task 16 review M2, then fix round 2: the
 *  goal columns first, then "Sets won", "For", "Ratio" and the rest, which
 *  printed English in every locale).
 *
 *  Keyed by metric KEY, then by the engine's own LABEL for it, because a key
 *  does not name one thing across sports: `sets_won` is "Sets won" in tennis
 *  and volleyball and "Games won" in badminton, table tennis and carrom — the
 *  same column, a different word. The pair is exactly what the module declares
 *  on the spec the table is built from, so the lookup reads that declaration
 *  and invents nothing; the dictionary keys are named for the WORD, so two
 *  sports that say the same thing share one translation.
 *
 *  Spelled out per NEW-3 below. `standings-view.test.ts` enumerates every
 *  shipped module's visible metrics and `DERIVED_METRICS`, and reds on any pair
 *  that is neither here nor in `NOTATION_HEADERS` — so a new metric, or a
 *  relabelled one, cannot fall back to its English label unnoticed. */
export const METRIC_HEADER_KEYS: Readonly<Record<string, Readonly<Record<string, HeaderKeys>>>> = {
  // football, hockey, ice hockey — GF/GA/GD are initials of English words: a
  // Spanish table writes GF/GC/DG, a French one BP/BC/Diff, a Dutch one DV/DT/DS.
  gf: { GF: { abbr: "table.abbr.gf", title: "table.col.gf" } },
  ga: { GA: { abbr: "table.abbr.ga", title: "table.col.ga" } },
  gd: { GD: { abbr: "table.abbr.gd", title: "table.col.gd" } },
  // cricket
  ties: { T: { abbr: "table.abbr.ties", title: "table.col.ties" } },
  no_results: { NR: { abbr: "table.abbr.noResults", title: "table.col.noResults" } },
  // board games
  wins: { Wins: word("table.col.wins") },
  // the set-based sports and carrom
  sets_won: { "Sets won": word("table.col.setsWon"), "Games won": word("table.col.gamesWon") },
  sets_lost: { "Sets lost": word("table.col.setsLost"), "Games lost": word("table.col.gamesLost") },
  games_won: { "Games won": word("table.col.gamesWon") },
  games_lost: { "Games lost": word("table.col.gamesLost") },
  // generic
  for: { For: word("table.col.for") },
  against: { Against: word("table.col.against") },
  diff: { Difference: word("table.col.difference") },
  // derived cascade columns (`DERIVED_METRICS`)
  set_ratio: { Ratio: word("table.col.ratio") },
  board_ratio: { "Board ratio": word("table.col.boardRatio") },
  point_ratio: { "Pts ratio": word("table.col.pointRatio") },
};

/** The columns whose header is the sport's own NOTATION, printed as the engine
 *  labels it in every locale: net run rate, and the chess tie-break systems,
 *  which are named for people (Buchholz, Sonneborn–Berger). Keyed like
 *  `METRIC_HEADER_KEYS`, so the test's enumeration accounts for each by name. */
export const NOTATION_HEADERS: Readonly<Record<string, readonly string[]>> = {
  nrr: ["NRR"],
  buchholz: ["Buchholz"],
  buchholz_cut1: ["Buchholz Cut-1"],
  sberger: ["SB"],
};

/** A column header in the page's language: what the header shows, and the
 *  word it stands for. ONE authority for both standings tables — the hub's
 *  view below and `components/public-site/standings-table.tsx` (the division
 *  page, the embed, the organiser console) — so the two cannot print
 *  different letters over the same column. */
export function columnHeader(
  column: { key: string; label: string },
  msg: (key: TKey) => string,
): { abbr: string; title: string } {
  if (STRUCTURAL_KEYS.has(column.key)) {
    return { abbr: msg(STRUCTURAL_ABBR_KEYS[column.key]!), title: msg(`table.col.${column.key}`) };
  }
  const keys = Object.hasOwn(METRIC_HEADER_KEYS, column.key) ? METRIC_HEADER_KEYS[column.key]! : undefined;
  const header = keys && Object.hasOwn(keys, column.label) ? keys[column.label]! : undefined;
  if (header !== undefined) return { abbr: msg(header.abbr), title: msg(header.title) };
  // Notation, or a column no shipped module declares (a retired build's label).
  return { abbr: column.label, title: column.label };
}

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

/** The rule a tie was split on, in the page's language — the dictionary's
 *  phrase where `TIE_BREAK_MSG_KEYS` has one, the engine's otherwise. Shared by
 *  both standings tables, like `columnHeader`. */
export function tieBreakRule(key: string, msg: (key: TKey) => string): string {
  const dictKey = TIE_BREAK_MSG_KEYS[key];
  return dictKey === undefined ? tieBreakLabel(key) : msg(dictKey);
}

/** The ratio columns that explain themselves on tap, and the sentence each one
 *  says: the two integer totals the engine divides (`RATIO_LEDGERS`), then the
 *  cell's own ratio text. Totals only, never per match (owner-approved).
 *
 *  `set_ratio` is left out ON PURPOSE. Its unit is the sport's word — "sets"
 *  in volleyball and tennis, "games" in badminton, table tennis and carrom,
 *  which all ride the same `sets_won` key (`METRIC_HEADER_KEYS` above keys the
 *  header by label for exactly that reason) — so one sentence would tell a
 *  badminton spectator about sets they never played. Points and boards mean
 *  the same thing in every sport that ranks on them. Spelled out rather than
 *  built from the key, like `TIE_BREAK_MSG_KEYS`, so the family stays
 *  grep-able. */
export const RATIO_NOTE_KEYS: Readonly<Partial<Record<RatioKey, TKey>>> = {
  board_ratio: "table.ratioNote.board_ratio",
  point_ratio: "table.ratioNote.point_ratio",
};

/** The breakdown popover's text for one ratio cell, or null when there is
 *  nothing to explain: a column without a note, or a row with no ledger yet
 *  (the engine's "—"). Null means NO trigger — the cell stays plain text
 *  rather than becoming a button that opens onto "won 0 · lost 0".
 *
 *  The ratio is the engine's own `derivedMetricText`, not a local division,
 *  so the popover can never show a number the cell beside it does not.
 *  Shared by both standings tables, like `columnHeader` and `tieBreakRule`. */
export function ratioNote(
  row: StandingsRow,
  key: string,
  msg: (key: TKey, vars?: Record<string, string | number>) => string,
): string | null {
  const noteKey = Object.hasOwn(RATIO_NOTE_KEYS, key) ? RATIO_NOTE_KEYS[key as RatioKey] : undefined;
  if (noteKey === undefined) return null;
  const ratio = derivedMetricText(row, key as RatioKey);
  if (ratio === null || ratio === "—") return null;
  const [won, lost] = RATIO_LEDGERS[key as RatioKey];
  return msg(noteKey, {
    won: formatMetric(row.metrics[won] ?? 0),
    lost: formatMetric(row.metrics[lost] ?? 0),
    ratio,
  });
}

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
      ...columnHeader(c, input.msg),
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
      // Paired with `cells` by index, like the cells with the columns. Only a
      // derived column can carry one; `ratioNote` decides which of those do.
      cellNotes: columns.map((c) => (c.kind === "derived" ? ratioNote(r, c.key, input.msg) : null)),
      tieBreakText: r.tieBreak
        ? input.msg("table.tieBreak", {
            with: r.tieBreak.with.map(name).join(", "),
            rule: tieBreakRule(r.tieBreak.key, input.msg),
          })
        : null,
      // Task 6 wires `buildQualificationView` in; until then no table carries
      // a status, which the schema states as null (never an absent key).
      qual: null,
      champion: input.championId === r.entrantId,
    })),
    qualification: null,
  };
}
