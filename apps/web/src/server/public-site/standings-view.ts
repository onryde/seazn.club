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
  AGAINST_KEYS,
  DERIVED_METRICS,
  DIFF_KEYS,
  FOR_KEYS,
  PLAIN_LAYOUT,
  RATIO_LEDGERS,
  derivedMetricText,
  isLevelTable,
  metricKeyOf,
  resultColumnText,
  tableLayoutOf,
  tieBreakLabel,
  type OutcomeKey,
  type PointsRule,
  type RatioKey,
  type ResultColumnKey,
  type StandingsRow,
  type TableLayout,
  type TableRulesSource,
  type TieBreakNote,
} from "@seazn/engine/competition";
import type { PartialScheduleKey, TiebreakerKey } from "@seazn/engine/sport";
import { resultColumns, standingsColumns, tableHasDraw, formatMetric, type MetricSpecLike, type StandingsColumn } from "@/lib/public-site";
import type { TKey } from "@/lib/i18n-runtime";
import type { DictionaryKey } from "@/lib/i18n-keys";
import type { TableViewT } from "./competition-hub-schema";
import type { QualificationView } from "./qualification-view";

/** The columns a phone shows without asking: played, won, lost, points.
 *  Everything else — draws, the sport's own metrics, the cascade's derived
 *  columns — is the long tail, folded behind the table's "more" disclosure at
 *  phone widths and always visible from `md` up. Exported because it is the
 *  definition of "compact", and a test that restated it would be a second
 *  declaration to drift. */
export const COMPACT_KEYS: ReadonlySet<string> = new Set(["played", "won", "lost", "points"]);

/** W2d T17 fix 1 (m2): a table that splits its results apart (IIHF's W · OTW · OTL · L, RBG:343-344) shows only played
 *  and points on a phone and folds the whole split behind the same disclosure. Four result columns beside a name do not
 *  fit at 320 (measured: the hub's table ran 110px wide and put Points off-screen), and W and L alone would read as a
 *  ledger that does not add up to P. The narrow set is the hub preview's (`PREVIEW_KEYS`, standings-table-view.tsx). */
export const SPLIT_COMPACT_KEYS: ReadonlySet<string> = new Set(["played", "points"]);

/** The columns a phone shows without asking, for this table's layout. */
export const compactKeysOf = (layout: TableLayout): ReadonlySet<string> =>
  layout.apart.length > 0 ? SPLIT_COMPACT_KEYS : COMPACT_KEYS;

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
  "otw",
  "otl",
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
  // W2d T17 (RBG §3.4): IIHF's overtime-or-shoot-out wins and losses.
  otw: "table.abbr.otw",
  otl: "table.abbr.otl",
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
  // derived cascade columns (`DERIVED_METRICS`). Their own short headers
  // because Dutch spells a ratio "verhouding": carrom's three whole-word
  // ratio columns needed an 828px table at md+, past the 734px hub card.
  set_ratio: { Ratio: { abbr: "table.abbr.ratio", title: "table.col.ratio" } },
  board_ratio: { "Board ratio": { abbr: "table.abbr.boardRatio", title: "table.col.boardRatio" } },
  point_ratio: { "Pts ratio": { abbr: "table.abbr.pointRatio", title: "table.col.pointRatio" } },
  // W2d T17 (ST-G29): badminton's set and point difference, hockey's field goals, tennis's game ratio. The set
  // difference keeps the ratio's neutral word ("Diff"), for the same reason its ratio is "Ratio": `sets_won` is games
  // in badminton and table tennis, sets in volleyball and tennis.
  set_diff: { Diff: { abbr: "table.abbr.setDiff", title: "table.col.setDiff" } },
  point_diff: { "Pts diff": { abbr: "table.abbr.pointDiff", title: "table.col.pointDiff" } },
  field_goals: { FG: { abbr: "table.abbr.fieldGoals", title: "table.col.fieldGoals" } },
  game_ratio: { "Game ratio": { abbr: "table.abbr.gameRatio", title: "table.col.gameRatio" } },
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
 *  Read as `Record<string, TKey>` (callers index it by a trace's raw key), but
 *  the literal `satisfies Record<TiebreakerKey, DictionaryKey>` (W2d merge-fix
 *  review m9): every engine key must be here, nothing else may be, and every
 *  value must be a generated dictionary key — a missing key, a stray key or a
 *  typo is a tsc error, not only a red sweep. The sweeps read
 *  `defaultOrderOf(m)` alone, so a key reachable only through a preset, a stage
 *  kind or a cfg was covered by luck before this. */
export const TIE_BREAK_MSG_KEYS: Readonly<Record<string, TKey>> = {
  points: "table.tieBreak.points",
  wins: "table.tieBreak.wins",
  diff: "table.tieBreak.diff",
  for: "table.tieBreak.for",
  fair_play: "table.tieBreak.fair_play",
  nrr: "table.tieBreak.nrr",
  set_ratio: "table.tieBreak.set_ratio",
  game_ratio: "table.tieBreak.game_ratio",
  board_ratio: "table.tieBreak.board_ratio",
  point_ratio: "table.tieBreak.point_ratio",
  set_diff: "table.tieBreak.set_diff",
  point_diff: "table.tieBreak.point_diff",
  matches_played: "table.tieBreak.matches_played",
  field_goals: "table.tieBreak.field_goals",
  h2h_points: "table.tieBreak.h2h_points",
  h2h_diff: "table.tieBreak.h2h_diff",
  h2h_for: "table.tieBreak.h2h_for",
  h2h_two: "table.tieBreak.h2h_two",
  h2h_wins: "table.tieBreak.h2h_wins",
  h2h_set_ratio: "table.tieBreak.h2h_set_ratio",
  h2h_point_ratio: "table.tieBreak.h2h_point_ratio",
  h2h_reapply: "table.tieBreak.h2h_reapply",
  h2h_exclusion: "table.tieBreak.h2h_exclusion",
  direct: "table.tieBreak.direct",
  buchholz: "table.tieBreak.buchholz",
  buchholz_cut1: "table.tieBreak.buchholz_cut1",
  sberger: "table.tieBreak.sberger",
  seed: "table.tieBreak.seed",
  lots: "table.tieBreak.lots",
  // W2d T12 (IH-TB-2): a trace can also name a step of a sport's partial-schedule order — IIHF's internal
  // `fewest_played`, which no stage order holds — so the map covers every PartialScheduleKey (TiebreakerKey + it).
  fewest_played: "table.tieBreak.fewest_played",
} satisfies Record<PartialScheduleKey, DictionaryKey>;

/** Sort key for a row the ranking pass has not ranked (a division with no
 *  played fixtures yet, or a row excluded from the cascade). Unranked rows go
 *  last. Deliberately NOT the `99` that `standings-table.tsx` uses: a division
 *  with a hundred or more entrants would sort its rank-100 row BEHIND every
 *  unranked one. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

/** Which ledger a row's abstract `diff`/`for` resolves to, by the alias the
 *  engine actually reads (`DIFF_KEYS`/`FOR_KEYS`/`AGAINST_KEYS`, first one the
 *  row records — `metricKeyOf`). Keyed by ledger KEY, not by sport: football,
 *  hockey and ice hockey fold `gf`/`ga`/`gd`, cricket `runs_for`/
 *  `runs_against`, the generic module (and any stage PointsRule forfeit, which
 *  writes `for`/`against`/`diff` into any sport's row) the plain keys.
 *  `tie-break-ledger-words.test.tsx` pins it against the engine's three alias
 *  lists exactly, so a new alias cannot arrive without a word. */
export type LedgerFamily = "goals" | "runs" | "plain";
export const LEDGER_ALIAS_FAMILY: Readonly<Record<string, LedgerFamily>> = {
  gd: "goals",
  gf: "goals",
  ga: "goals",
  run_diff: "runs",
  runs_for: "runs",
  runs_against: "runs",
  diff: "plain",
  for: "plain",
  against: "plain",
};

/** The `diff` and `for` rules in the SPORT's word (owner copy fix,
 *  2026-09-23): "goal difference" / "run difference" / plain "difference",
 *  never the one catch-all "goal/run difference" every sport used to print.
 *  The plain phrases keep the keys `TIE_BREAK_MSG_KEYS` already names, so the
 *  registry there still routes both rules. Spelled out, like that map. */
export const LEDGER_RULE_MSG_KEYS: Readonly<Record<"diff" | "for", Readonly<Record<LedgerFamily, TKey>>>> = {
  diff: { goals: "table.tieBreak.diffGoals", runs: "table.tieBreak.diffRuns", plain: "table.tieBreak.diff" },
  for: { goals: "table.tieBreak.forGoals", runs: "table.tieBreak.forRuns", plain: "table.tieBreak.for" },
};

/** The alias `rule` resolves to on one row: the one the engine compares for
 *  that rule, else the row's other ledger aliases (a cricket snapshot folded
 *  before cricket's ledger recorded `run_diff` has `runs_for` but no run
 *  difference); undefined when it records none. */
function ledgerAlias(row: StandingsRow, rule: "diff" | "for"): string | undefined {
  const [own, other] = rule === "diff" ? [DIFF_KEYS, FOR_KEYS] : [FOR_KEYS, DIFF_KEYS];
  return metricKeyOf(row, own) ?? metricKeyOf(row, other) ?? metricKeyOf(row, AGAINST_KEYS);
}

/** The family of the ledger `rule` was compared on for `row`. The row's own
 *  alias first; a row that records NONE (an entrant yet to play: `zeroRow`
 *  folds from `{}`) was compared against its tie partners' values, so their
 *  alias is the one in play (review m1: a ledgerless hockey row split from two
 *  losers read "difference" beside their "goal difference"); failing those,
 *  any row of the table; else plain. */
function ledgerFamily(
  row: StandingsRow,
  rule: "diff" | "for",
  table: readonly StandingsRow[],
  partners: readonly string[],
): LedgerFamily {
  const partnerRows = table.filter((r) => partners.includes(r.entrantId));
  for (const candidate of [row, ...partnerRows, ...table]) {
    const alias = ledgerAlias(candidate, rule);
    if (alias !== undefined) return LEDGER_ALIAS_FAMILY[alias] ?? "plain";
  }
  return "plain";
}

/** The family a SPORT's declared ledger speaks (`module.metrics`), for a
 *  surface with no row to read: the organiser console's cascade caption names
 *  the rules before any tie exists. The same alias order as `ledgerAlias` —
 *  the rule's own aliases, then the other ledger's, then against — so a sport
 *  that declares a `for` alias but no difference of its own still reads its
 *  own family, never plain. (Cricket declares both `runs_for` and `run_diff`
 *  today; old snapshots have no `run_diff`, which `ledgerAlias` covers.) */
export function sportLedgerFamily(metrics: readonly { key: string }[], rule: "diff" | "for"): LedgerFamily {
  const declared = new Set(metrics.map((m) => m.key));
  const [own, other] = rule === "diff" ? [DIFF_KEYS, FOR_KEYS] : [FOR_KEYS, DIFF_KEYS];
  const alias = [...own, ...other, ...AGAINST_KEYS].find((k) => declared.has(k));
  return alias === undefined ? "plain" : (LEDGER_ALIAS_FAMILY[alias] ?? "plain");
}

/** The rule a tie was split on, in the page's language — the dictionary's
 *  phrase where `TIE_BREAK_MSG_KEYS` has one, the engine's otherwise; `diff`
 *  and `for` in the word of the ledger they were compared on (`ledgerFamily`).
 *  Shared by both standings tables and the what-if, like `columnHeader`.
 *  `row` is the tied row, `table` every row it was ranked with, `partners`
 *  the entrants it was split from (its own `tieBreak.with` unless the caller
 *  names them — the what-if names its rival). All required but `partners`, so
 *  no caller can print the catch-all by leaving the ledger out. */
export function tieBreakRule(
  key: string,
  msg: (key: TKey) => string,
  row: StandingsRow,
  table: readonly StandingsRow[],
  partners: readonly string[] = row.tieBreak?.with ?? [],
): string {
  if (key === "diff" || key === "for") return msg(LEDGER_RULE_MSG_KEYS[key][ledgerFamily(row, key, table, partners)]);
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

/** What a table reads off its stage's rules (`StageTableRulesDoc`): the points rule and the outcomes it pays. */
export interface TableRulesLike {
  readonly points: PointsRule;
  readonly reachable: readonly OutcomeKey[];
}

/** W2d T17 (spec §5.7) — the stage's result-column layout (IIHF's OTW/OTL, chess's half-points), from its rules; a
 *  stage the loader refused (no rules) prints W and L as folded, in whole points. */
export function tableLayoutFor(rules: TableRulesLike | null | undefined): TableLayout {
  return rules === null || rules === undefined ? PLAIN_LAYOUT : tableLayoutOf(rules.points, rules.reachable);
}

/** One cell's text — THE cell expression of both standings tables (the hub's view below and `standings-table.tsx`), so
 *  the two cannot print different numbers in the same cell. */
export function cellText(row: StandingsRow, column: StandingsColumn, layout: TableLayout): string {
  if (column.kind === "derived") return derivedMetricText(row, column.key as TiebreakerKey) ?? "—";
  if (column.kind === "structural") return resultColumnText(row, column.key as ResultColumnKey, layout);
  return formatMetric(row.metrics[column.key], column.decimals);
}

/** The columns a stage's table shows, under its layout (`standingsColumns` plus the engine's DERIVED_METRICS). */
export function tableColumns(
  metricSpecs: readonly MetricSpecLike[],
  cascade: readonly string[],
  rows: readonly StandingsRow[],
  layout: TableLayout,
): StandingsColumn[] {
  return standingsColumns(metricSpecs, cascade, rows, DERIVED_METRICS, layout.apart.length > 0);
}

/** W2d follow-up (final review m3, m8; export review I2, 2026-10-28) — the result columns of a FIXED-shape table, the
 *  organiser export and the kiosk: the public table's own declaration under the stage's layout (IIHF's
 *  P · W · OTW · OTL · L, RBG:343-344). D prints where the stage can reach a draw — the engine's own declaration, its
 *  reachable outcomes (`reachableResultKinds`: a draw the sport stands, or a shoot-out booked as one, B2) — from the
 *  first round, where the public table waits for the first draw: a printed sheet and a TV board keep one shape all
 *  season. A stage that can never draw (IIHF, every set sport) prints no D, as the public table never does. And D prints
 *  on any table that holds a draw (`tableHasDraw`, the public table's own test), so a sheet never hides a booked one; a
 *  stage the loader refused (no reachable outcomes to read) keeps D, as before. `rows`: every row the shape covers (the
 *  export's: the whole stage, so each pool prints one shape). Cells are `cellText`'s, the public table's. */
export function fixedResultColumns(
  layout: TableLayout,
  reachable: readonly OutcomeKey[] | null | undefined,
  rows: readonly Pick<StandingsRow, "drawn">[],
): StandingsColumn[] {
  const draws = reachable === null || reachable === undefined || reachable.includes("draw") || tableHasDraw(rows);
  return resultColumns(layout.apart.length > 0, draws);
}

/** W2d T17 (anti-goal 2, X-TB-8): why a conditional step left a tie unsplit, as the tie popover says it. Spelled out
 *  and exhaustive over the engine's `TieBreakNote`, like `TIE_BREAK_MSG_KEYS`. */
export const TIE_NOTE_KEYS = {
  h2h_two_not_applicable: "table.tieNote.h2hTwoNotApplicable",
  h2h_incomplete: "table.tieNote.h2hIncomplete",
} as const satisfies Record<TieBreakNote, DictionaryKey>;

/**
 * The tie popover's text for one tied row, or null for a row with no trace: the sentence naming who it was tied with
 * and what split them, then — each on its own line — why a step did not apply (`tieBreak.note`) and the date a stored
 * drawing of lots was made (`tieBreak.drawnAt`, X-TB-4). `dateOf` formats an instant in the page's locale and zone.
 * Lines are joined by "\n"; `TieNoteText` renders each on its own line. Shared by both tables and the qualification
 * popover, like `tieBreakRule`.
 */
export function tieNoteText(
  row: StandingsRow,
  table: readonly StandingsRow[],
  msg: (key: TKey, vars?: Record<string, string | number>) => string,
  nameOf: (id: string) => string,
  dateOf: (iso: string) => string | null,
): string | null {
  const tb = row.tieBreak;
  if (!tb) return null;
  const lines = [msg("table.tieBreak", { with: tb.with.map(nameOf).join(", "), rule: tieBreakRule(tb.key, msg, row, table) })];
  if (tb.note !== undefined) lines.push(msg(TIE_NOTE_KEYS[tb.note]));
  const drawn = tb.drawnAt === undefined ? null : dateOf(tb.drawnAt);
  if (drawn !== null) lines.push(msg("table.tieNote.drawnAt", { date: drawn }));
  return lines.join("\n");
}

/** W2d T17 — where a stage's order came from, as the organiser's caption says it (`StageTableRulesDoc.sources`). */
export const ORDER_SOURCE_KEYS = {
  sport: "div.detail.tiebreak.source.sport",
  division: "div.detail.tiebreak.source.division",
  stage: "div.detail.tiebreak.source.stage",
  migrated: "div.detail.tiebreak.source.migrated",
} as const satisfies Record<TableRulesSource, DictionaryKey>;

/** The organiser caption's second line for one stage: where its order came from, and whether it is pinned (X-TB-2: a
 *  started stage ranks by the rules it started with, D9) — with the date, in the viewer's locale and zone. Null for a
 *  stage the loader refused: no caption, never a guessed order (R3). */
export function stageOrderNote(
  rules: { readonly sources: { readonly tiebreakers: TableRulesSource }; readonly pinnedAt: string | null } | null | undefined,
  msg: (key: TKey, vars?: Record<string, string | number>) => string,
  dateOf: (iso: string) => string | null,
): { source: string; pinned: string } | null {
  if (rules === null || rules === undefined) return null;
  const date = rules.pinnedAt === null ? null : dateOf(rules.pinnedAt);
  return {
    source: msg(ORDER_SOURCE_KEYS[rules.sources.tiebreakers]),
    pinned: date === null ? msg("div.detail.tiebreak.live") : msg("div.detail.tiebreak.pinned", { date }),
  };
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
  /** Standings qualification (spec 2026-09-22), already resolved by
   *  `buildQualificationView`; null/absent = no cut to show. Carried, never
   *  derived: the table line as is, and each row's status by entrant id. */
  qualification?: QualificationView | null;
  /** W2d T17: the stage's rules (`StageTableRulesDoc`), for its column layout — OTW/OTL, half-points. Null: a stage the
   *  loader refused, printed plain. */
  rules: TableRulesLike | null;
  /** An instant as the page prints a date (the org's locale and zone): the lots note's "Drawn by lots on {date}". */
  dateOf: (iso: string) => string | null;
}

export function buildTableView(input: TableViewInput): TableViewT {
  const layout = tableLayoutFor(input.rules);
  const compact = compactKeysOf(layout);
  const columns = tableColumns(input.metricSpecs, input.cascade, input.rows, layout);
  const ranked = [...input.rows].sort((a, b) => (a.rank ?? UNRANKED) - (b.rank ?? UNRANKED));
  const name = (id: string) => input.entrantNames[id] ?? id;
  // X-TB-6 (anti-goal 3): a table with no counted fixture is level — no place on any row (the client prints the level
  // dash for a null rank), no leader, no champion, no qualification chip and no tie note (its rows still carry the
  // ranking pass's trace, "split on seeding", which would explain a place the table does not print).
  const level = isLevelTable(input.rows);
  const qual = level ? null : (input.qualification ?? null);

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
      compact: compact.has(c.key),
    })),
    rows: ranked.map((r) => ({
      rank: level ? null : (r.rank ?? null),
      entrantId: r.entrantId,
      name: name(r.entrantId),
      badgeUrl: input.entrantLogos[r.entrantId] ?? null,
      colour: input.entrantColours[r.entrantId] ?? null,
      // Byte-for-byte `standings-table.tsx`'s cell expression, in the same
      // column order — the view's `cells[i]` IS `columns[i]`, and the renderer
      // relies on that pairing rather than looking anything up by key.
      cells: columns.map((c) => cellText(r, c, layout)),
      // Paired with `cells` by index, like the cells with the columns. Only a
      // derived column can carry one; `ratioNote` decides which of those do.
      cellNotes: columns.map((c) => (c.kind === "derived" ? ratioNote(r, c.key, input.msg) : null)),
      tieBreakText: level ? null : tieNoteText(r, input.rows, input.msg, name, input.dateOf),
      // Keyed by entrant id, never by rank or position: a shared rank is two
      // rows, and the view's row order is its own. No status = null, which the
      // schema states as a required key (never an absent one).
      qual: qual !== null && Object.hasOwn(qual.rows, r.entrantId) ? qual.rows[r.entrantId]! : null,
      champion: !level && input.championId === r.entrantId,
    })),
    qualification: qual?.table ?? null,
  };
}
