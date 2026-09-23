// Spectator surface W2, Task 2 — `buildTableView` tests.
//
// The builder is PURE: a standings snapshot in, a `TableViewT` out, every
// number already a formatted string and every name already resolved. It owns
// no data access, so these tests are the whole gate for it.
//
// Conventions carried from W1 (Task 10's): the EMPTY case is stated first (a
// ladder of "does the set contain X" questions is answered vacuously by the
// empty set), every negative assertion ships with its positive pair, and
// every ordering assertion carries an ORDER-DIFFERENTIAL case — one whose
// expected output differs from what the wrong order would have produced.
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 2) — builder
// ---------------------------------------------------------------------------
//  (a) `COMPACT_KEYS` loses "points" → the compact/long-tail split.
//  (b) `STRUCTURAL_KEYS` emptied → structural titles stop being localised.
//  (c) the rank sort removed → row order follows input order.
//  (d) the unranked sentinel becomes `99` (the value `standings-table.tsx`
//      still uses) → a rank-100 row sorts BEHIND an unranked one.
//  (e) `entrantNames[id] ?? id` loses its fallback → an unknown entrant
//      renders as `undefined`.
//  (f) `entrantLogos[id] ?? null` loses its fallback → `badgeUrl` is
//      `undefined`, which the schema refuses.
//  (g) the derived cell's `?? "—"` dropped → a row with no ledger renders
//      `null`.
//  (h) the derived/structural cell branches swapped → derived columns render
//      through `formatMetric` and structural ones through the engine.
//  (i) `champion` hard-coded false → the champion flag.
//  (j) `tieBreak` guard inverted / always computed → a row with no trace.
//  (k) `rank: r.rank ?? null` loses its fallback.
//  (l) `columns.map` reversed when building `cells` → cell/column alignment.
//  (w) `TIE_BREAK_MSG_KEYS.has(key)` → `false` (round 1 fix 5: the rule name
//      leaks back to English inside a translated sentence).
//  (x) the same guard → `true` (an unknown key becomes a dotted key on screen).
//
// Every mutant compiles and collects, so none is the collection-break shape
// that reads as a survivor; `numTotalTests` was pinned on each run.
import { describe, expect, it } from "vitest";
import { DERIVED_METRICS, type StandingsRow } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { TableView } from "../competition-hub-schema";
import {
  buildTableView,
  columnHeader,
  COMPACT_KEYS,
  METRIC_HEADER_KEYS,
  NOTATION_HEADERS,
  STRUCTURAL_ABBR_KEYS,
  STRUCTURAL_KEYS,
  TIE_BREAK_MSG_KEYS,
  type TableViewInput,
} from "../standings-view";

// The caller binds `t(dict, …)` into `msg`. Here it echoes the key (and its
// params) so an assertion can pin WHICH key was asked for — the dictionary
// entries themselves are Task 6's, and this builder must never hold copy.
const msg: TableViewInput["msg"] = (key, vars) =>
  vars ? `${key}:${JSON.stringify(vars)}` : `${key}`;

const row = (entrantId: string, over: Partial<StandingsRow> = {}): StandingsRow => ({
  entrantId,
  played: 0,
  won: 0,
  drawn: 0,
  lost: 0,
  points: 0,
  metrics: {},
  ...over,
});

const base: Omit<TableViewInput, "rows"> = {
  id: "div-s1-overall",
  division: { id: "d1", slug: "div", name: "Div" },
  caption: "League",
  fullHref: "/shared/o/c/div?tab=standings",
  metricSpecs: [
    { key: "gf", label: "GF" },
    { key: "ga", label: "GA" },
    { key: "gd", label: "GD" },
    { key: "pf", label: "PF" },
    { key: "cards", label: "Cards", display: false },
  ],
  cascade: ["points", "gd"],
  entrantNames: { a: "Alpha", b: "Beta" },
  entrantLogos: { a: "https://x/a.png", b: null },
  entrantColours: {},
  championId: null,
  updatedAt: "2026-09-05T10:00:00Z",
  msg,
};

describe("buildTableView", () => {
  it("EMPTY rows → structural columns still exist, rows are [], and the document parses", () => {
    const v = buildTableView({ ...base, rows: [] });
    expect(v.rows).toEqual([]);
    // No row carries a draw, so no D; no row carries gf/ga/gd, so the metric
    // specs earn no column; the cascade names nothing DERIVED_METRICS knows.
    expect(v.columns.map((c) => c.key)).toEqual(["played", "won", "lost", "points"]);
    // The empty table is still a well-formed TableView — Task 1's schema is
    // the arbiter of that, not a hand-written shape assertion here.
    expect(TableView.parse(v)).toEqual(v);
    expect(v).toMatchObject({
      id: "div-s1-overall",
      divisionId: "d1",
      divisionSlug: "div",
      divisionName: "Div",
      caption: "League",
      fullHref: "/shared/o/c/div?tab=standings",
      updatedAt: "2026-09-05T10:00:00Z",
    });
  });

  it("D appears only when some row has a draw — and it is long-tail, not compact (positive pair for the empty case)", () => {
    const v = buildTableView({ ...base, rows: [row("a", { played: 1, drawn: 1, points: 1 })] });
    expect(v.columns.map((c) => c.key)).toEqual(["played", "won", "drawn", "lost", "points"]);
    expect(v.columns.find((c) => c.key === "drawn")?.compact).toBe(false);
    expect(v.rows[0]!.cells).toEqual(["1", "0", "1", "0", "1"]);
  });

  it("compact columns are exactly P W L Pts; metrics are the long tail, and structural titles are localised", () => {
    const rows = [
      row("a", { played: 2, won: 2, points: 6, metrics: { gf: 5, ga: 1, gd: 4, pf: 7 }, rank: 1 }),
      row("b", { played: 2, lost: 2, metrics: { gf: 1, ga: 5, gd: -4, pf: 3 }, rank: 2 }),
    ];
    const v = buildTableView({ ...base, rows });
    expect(v.columns.map((c) => [c.key, c.compact])).toEqual([
      ["played", true],
      ["won", true],
      ["lost", true],
      ["gf", false],
      ["ga", false],
      ["gd", false],
      ["pf", false],
      ["points", true],
    ]);
    expect(v.columns.every((c) => c.compact === COMPACT_KEYS.has(c.key))).toBe(true);
    // Structural headers are COPY and get a dictionary key…
    expect(v.columns[0]!.title).toBe("table.col.played");
    expect(v.columns[7]!.title).toBe("table.col.points");
    // …and so is the abbreviation printed over the column (Task 16): "P" is
    // English, and in Spanish it is the LOST column's letter. GF/GA/GD are
    // copy too (review M2: a Spanish table writes GF/GC/DG); every OTHER metric
    // is the sport's own notation and keeps the engine's label as both.
    expect(v.columns.map((c) => [c.abbr, c.title])).toEqual([
      ["table.abbr.played", "table.col.played"],
      ["table.abbr.won", "table.col.won"],
      ["table.abbr.lost", "table.col.lost"],
      ["table.abbr.gf", "table.col.gf"],
      ["table.abbr.ga", "table.col.ga"],
      ["table.abbr.gd", "table.col.gd"],
      ["PF", "PF"],
      ["table.abbr.points", "table.col.points"],
    ]);
    // The `display: false` spec earns no column at all (positive pair: gf did).
    expect(v.columns.map((c) => c.key)).not.toContain("cards");
  });

  it("derived cascade columns sit AFTER points, carry the engine's own text, and fall back to an em dash", () => {
    const rows = [
      row("a", {
        played: 1,
        won: 1,
        points: 3,
        rank: 1,
        metrics: {
          runs_for: 120,
          balls_faced_eff: 120,
          runs_against: 100,
          balls_bowled_eff: 120,
        },
      }),
      row("b", { played: 1, lost: 1, rank: 2, metrics: { buchholz: 3.5 } }),
    ];
    const v = buildTableView({ ...base, cascade: ["points", "nrr", "buchholz"], rows });
    // Order-differential: `standingsColumns` appends derived columns after the
    // points column, so this list is NOT what "derived before points" produces.
    expect(v.columns.map((c) => c.key)).toEqual([
      "played",
      "won",
      "lost",
      "points",
      "nrr",
      "buchholz",
    ]);
    expect(v.columns.map((c) => c.compact)).toEqual([true, true, true, true, false, false]);
    expect(v.columns[4]!.abbr).toBe("NRR");
    // Row a has a cricket ledger and no Buchholz; row b is its mirror image.
    expect(v.rows[0]!.cells).toEqual(["1", "1", "0", "3", "+1.000", "—"]);
    expect(v.rows[1]!.cells).toEqual(["1", "0", "1", "0", "—", "3½"]);
  });

  it("rows come in rank order with formatted cells, badge urls, the champion flag and a tie-break sentence", () => {
    const rows = [
      row("b", {
        played: 1,
        points: 3,
        metrics: { gf: 1, ga: 0, gd: 1 },
        rank: 2,
        tieBreak: { key: "diff", with: ["a"] },
      }),
      row("a", { played: 1, points: 3, metrics: { gf: 2, ga: 0, gd: 2 }, rank: 1 }),
    ];
    const v = buildTableView({ ...base, rows, championId: "a" });
    // Order-differential: input order is [b, a] and output order is [a, b].
    expect(v.rows.map((r) => r.entrantId)).toEqual(["a", "b"]);
    expect(v.rows[0]).toMatchObject({
      rank: 1,
      name: "Alpha",
      badgeUrl: "https://x/a.png",
      champion: true,
      tieBreakText: null,
    });
    expect(v.rows[0]!.cells).toEqual(["1", "0", "0", "2", "0", "2", "3"]);
    // `entrantLogos.b` is an explicit null — the initials fallback, not a badge.
    expect(v.rows[1]).toMatchObject({ rank: 2, name: "Beta", badgeUrl: null, champion: false });
    // The rule name is LOCALISED too — a whole English clause inside a
    // translated sentence is a leak, unlike a bare notation (GD, NRR). And it
    // is the ledger's word: these rows fold gf/ga/gd, so "goal difference".
    expect(v.rows[1]!.tieBreakText).toBe(
      'table.tieBreak:{"with":"Alpha","rule":"table.tieBreak.diffGoals"}',
    );
    expect(TableView.parse(v)).toEqual(v);
  });

  it("a trace key neither the dictionary nor the engine knows falls through to the raw key, and every tied entrant is named", () => {
    const rows = [
      row("a", { rank: 1 }),
      row("b", { rank: 2, tieBreak: { key: "gd", with: ["a", "zz"] } }),
    ];
    const v = buildTableView({ ...base, rows });
    // `TIE_BREAK_LABELS` has no "gd" entry (its goal-difference key is "diff"),
    // and neither does the localised set, so the raw key comes through — never
    // a dotted `table.tieBreak.gd` on screen. An unknown entrant id in the
    // `with` list renders as the id, never as "undefined".
    expect(v.rows[1]!.tieBreakText).toBe('table.tieBreak:{"with":"Alpha, zz","rule":"gd"}');
  });

  it("the tie-break registry covers every key a shipped module ranks on by default, every value spelled out", () => {
    // Read off the engine, never typed here (fix round 1): every key in every
    // built-in module's `defaultTiebreakers` must be in the registry, or its
    // tie note and qualification what-if print the engine's English label —
    // or, for a key the engine has no label for either (`game_ratio`, which
    // tennis ranks on), the raw key. A module that starts ranking on a new key
    // reds here until the key is added with its four translations.
    const defaults = new Set(builtinModules.flatMap((m) => [...m.defaultTiebreakers]));
    expect(defaults.size, "premise: the engine declares default cascades to check").toBeGreaterThan(5);
    expect(defaults.has("game_ratio"), "premise: tennis ranks on game_ratio by default").toBe(true);
    const unregistered = [...defaults].filter((key) => !Object.hasOwn(TIE_BREAK_MSG_KEYS, key));
    expect(unregistered, "a default tie-break key that would print English (or the raw key)").toEqual([]);
    // Round 2, NEW-3: a `` `table.tieBreak.${key}` `` concatenation is
    // invisible to a grep, to `scripts/i18n/gen-keys.ts` and to any future
    // source-scanning gate — so every value is the literal key for its own
    // rule, and a typo in one reds here rather than in a spectator's browser.
    for (const [trace, dictKey] of Object.entries(TIE_BREAK_MSG_KEYS)) {
      expect(dictKey).toBe(`table.tieBreak.${trace}`);
    }
  });

  // Every (key, label) pair a table can print beyond the structural five: each
  // shipped module's VISIBLE metrics (`standingsColumns` drops `display: false`)
  // and every derived cascade column. Read off the engine, never typed here, so
  // a metric added or relabelled there reds below until it is keyed or ruled
  // notation.
  const printable = (): [string, string, string][] => [
    ...builtinModules.flatMap((m) =>
      m.metrics.filter((spec) => spec.display !== false).map((spec): [string, string, string] => [m.key, spec.key, spec.label]),
    ),
    ...DERIVED_METRICS.map((d): [string, string, string] => ["(derived)", d.key, d.label]),
  ];
  const keyed = (key: string, label: string) => Object.hasOwn(METRIC_HEADER_KEYS, key) && Object.hasOwn(METRIC_HEADER_KEYS[key]!, label);
  const notation = (key: string, label: string) => Object.hasOwn(NOTATION_HEADERS, key) && NOTATION_HEADERS[key]!.includes(label);

  it("every metric and derived column a shipped module can print is copy with keys, or ruled notation — never neither", () => {
    const columns = printable();
    expect(columns.length, "premise: the engine declares columns to check").toBeGreaterThan(15);
    const unaccounted = columns.filter(([, key, label]) => !keyed(key, label) && !notation(key, label));
    expect(unaccounted, "a column that would print its English label in every locale").toEqual([]);
    expect(columns.filter(([, key, label]) => keyed(key, label) && notation(key, label)), "keyed AND notation").toEqual([]);
  });

  it("no entry names a column nothing declares (a stale pair would hide a relabel)", () => {
    const declared = new Set(printable().map(([, key, label]) => `${key}\u0000${label}`));
    const entries = [
      ...Object.entries(METRIC_HEADER_KEYS).flatMap(([key, byLabel]) => Object.keys(byLabel).map((label) => `${key}\u0000${label}`)),
      ...Object.entries(NOTATION_HEADERS).flatMap(([key, labels]) => labels.map((label) => `${key}\u0000${label}`)),
    ];
    expect(entries.filter((e) => !declared.has(e)).map((e) => e.replace("\u0000", " / "))).toEqual([]);
  });

  // The header words that are the SAME word in a locale as in English, by
  // design — each (key, locale) pair declared, so any other pair equal to
  // English is a value pasted, not translated (re-review m1). Exact: a pair
  // listed here that stops being identical reds too.
  const HEADER_IDENTICAL_BY_DESIGN: Readonly<Record<string, readonly string[]>> = {
    "table.abbr.gf": ["es"], // goles a favor — GF
    "table.col.ratio": ["es", "fr"],
    "table.abbr.ratio": ["es", "fr"],
  };

  it("every header key is authored in all four locales, the English value IS the engine's label, and every locale translates every word", () => {
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    const keys = new Set<string>();
    for (const [key, byLabel] of Object.entries(METRIC_HEADER_KEYS)) {
      for (const [label, { abbr, title }] of Object.entries(byLabel)) {
        for (const [locale, dict] of Object.entries(dicts)) {
          expect(Object.hasOwn(dict, abbr), `${locale} ${abbr}`).toBe(true);
          expect(Object.hasOwn(dict, title), `${locale} ${title}`).toBe(true);
        }
        // English keeps exactly what the engine printed before, over the column.
        expect(dicts.en![abbr], `${key}/${label}`).toBe(label);
        keys.add(abbr).add(title);
      }
    }
    for (const k of keys) {
      for (const locale of ["es", "fr", "nl"]) {
        const identical = HEADER_IDENTICAL_BY_DESIGN[k]?.includes(locale) ?? false;
        expect(dicts[locale]![k] === dicts.en![k], `${locale} ${k} = ${JSON.stringify(dicts[locale]![k])}`).toBe(identical);
      }
    }
    expect(Object.keys(HEADER_IDENTICAL_BY_DESIGN).filter((k) => !keys.has(k)), "a stale homograph entry").toEqual([]);
  });

  it("columnHeader is the one authority both tables read: structural, sport metric by its declared label, and notation", () => {
    expect(columnHeader({ key: "won", label: "W" }, msg)).toEqual({ abbr: "table.abbr.won", title: "table.col.won" });
    expect(columnHeader({ key: "ga", label: "GA" }, msg)).toEqual({ abbr: "table.abbr.ga", title: "table.col.ga" });
    // One key, two words: tennis's sets and badminton's games.
    expect(columnHeader({ key: "sets_won", label: "Sets won" }, msg)).toEqual({ abbr: "table.col.setsWon", title: "table.col.setsWon" });
    expect(columnHeader({ key: "sets_won", label: "Games won" }, msg)).toEqual({ abbr: "table.col.gamesWon", title: "table.col.gamesWon" });
    expect(columnHeader({ key: "set_ratio", label: "Ratio" }, msg)).toEqual({ abbr: "table.abbr.ratio", title: "table.col.ratio" });
    expect(columnHeader({ key: "nrr", label: "NRR" }, msg)).toEqual({ abbr: "NRR", title: "NRR" });
    // A label no module declares for that key is not guessed at.
    expect(columnHeader({ key: "sets_won", label: "Frames won" }, msg)).toEqual({ abbr: "Frames won", title: "Frames won" });
    expect(columnHeader({ key: "constructor", label: "X" }, msg)).toEqual({ abbr: "X", title: "X" });
  });

  it("the structural abbreviation keys are spelled out, one per structural column (NEW-3's shape)", () => {
    // Task 16: the visible header letters are copy (en "P", es "PJ", fr "J",
    // nl "GS"), keyed per column. Exact membership against STRUCTURAL_KEYS, so
    // a structural column added without its abbreviation reds here, and every
    // value is the literal key for its own column.
    expect(Object.keys(STRUCTURAL_ABBR_KEYS).sort()).toEqual([...STRUCTURAL_KEYS].sort());
    for (const [col, dictKey] of Object.entries(STRUCTURAL_ABBR_KEYS)) {
      expect(dictKey).toBe(`table.abbr.${col}`);
    }
  });

  it("every registered rule actually routes through msg when a row is separated on it", () => {
    for (const [trace, dictKey] of Object.entries(TIE_BREAK_MSG_KEYS)) {
      const v = buildTableView({
        ...base,
        rows: [row("a", { rank: 1 }), row("b", { rank: 2, tieBreak: { key: trace, with: ["a"] } })],
      });
      expect(v.rows[1]!.tieBreakText).toBe(
        `table.tieBreak:{"with":"Alpha","rule":"${dictKey}"}`,
      );
    }
  });

  it("a self-labelling engine key is still localised (the trap that forbids deriving the set from tieBreakLabel)", () => {
    // `tieBreakLabel("points")` returns "points" — identical to the key — so a
    // `label !== key` derivation would classify it as unknown and leak the
    // English word. Same for "wins". Both must localise.
    const has = (key: string) =>
      buildTableView({
        ...base,
        rows: [row("a", { rank: 1 }), row("b", { rank: 2, tieBreak: { key, with: ["a"] } })],
      }).rows[1]!.tieBreakText;
    expect(has("points")).toBe('table.tieBreak:{"with":"Alpha","rule":"table.tieBreak.points"}');
    expect(has("wins")).toBe('table.tieBreak:{"with":"Alpha","rule":"table.tieBreak.wins"}');
    // …and a key the engine phrases but the set were to miss would fall back to
    // the engine's English rather than to a dotted key. Positive pair for the
    // fall-through above, on a key that IS in both.
    expect(has("h2h_points")).toBe(
      'table.tieBreak:{"with":"Alpha","rule":"table.tieBreak.h2h_points"}',
    );
  });

  it("unranked rows sort LAST, behind a three-digit rank", () => {
    const rows = [row("c"), row("a", { rank: 100 }), row("b", { rank: 1 })];
    const v = buildTableView({ ...base, rows });
    // Order-differential against the `?? 99` sentinel `standings-table.tsx`
    // uses: with 99 the unranked row would sort AHEAD of rank 100.
    expect(v.rows.map((r) => r.entrantId)).toEqual(["b", "a", "c"]);
    expect(v.rows.map((r) => r.rank)).toEqual([1, 100, null]);
  });

  it("an entrant absent from the name and logo maps renders its id and no badge (negative pair for Alpha's badge)", () => {
    const v = buildTableView({ ...base, rows: [row("zz", { rank: 1 })], championId: "a" });
    expect(v.rows[0]!.name).toBe("zz");
    expect(v.rows[0]!.badgeUrl).toBeNull();
    // championId names an entrant that is not in this table at all.
    expect(v.rows[0]!.champion).toBe(false);
  });

  it("championId null → no row is the champion (negative pair for the flag above)", () => {
    const v = buildTableView({
      ...base,
      rows: [row("a", { rank: 1 }), row("b", { rank: 2 })],
      championId: null,
    });
    expect(v.rows.map((r) => r.champion)).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------
// Standings qualification status (spec 2026-09-22, plan Task 6). The view
// CARRIES what `buildQualificationView` resolved — the table's cut line and
// each row's status, keyed by entrant id — and derives nothing itself. A table
// with no cut carries null in both fields and is otherwise the table it was.
//
// Mutants killed (Task 6): (a) `qualification: null` unconditionally → the
// carry-through case; (b) `qual` keyed by rank / by position instead of the
// entrant id → the carry-through case (its statuses sit on the row that
// arrives SECOND and sorts FIRST, so every wrong key lands on the wrong row).
// ---------------------------------------------------------------------------
describe("qualification (spec 2026-09-22)", () => {
  // Input order [b, a], output order [a, b] — the order-differential scene of
  // "rows come in rank order…" above.
  const rows = [
    row("b", { played: 1, points: 3, metrics: { gf: 1, ga: 0, gd: 1 }, rank: 2, tieBreak: { key: "diff", with: ["a"] } }),
    row("a", { played: 1, points: 3, metrics: { gf: 2, ga: 0, gd: 2 }, rank: 1 }),
  ];
  const input: TableViewInput = { ...base, rows, championId: "a" };

  it("empty case: no qualification input → view.qualification null and every row.qual null", () => {
    const v = buildTableView(input);
    expect(v.qualification).toBeNull();
    expect(v.rows).toHaveLength(2);
    expect(v.rows.every((r) => r.qual === null)).toBe(true);
    expect(TableView.parse(v)).toEqual(v);
  });

  it("carries the table line and each row's status through unchanged, on the row of the entrant it names", () => {
    const qualification = {
      table: {
        cutIndex: 1,
        label: "Top 1 go through to KO · 1 round left",
        legend: { through: "Through", open: "Still open", out: "Out", hint: "Tap a rank for details." },
      },
      rows: {
        a: {
          status: "win_k",
          label: "Win and in",
          ariaLabel: "Rank 1, Win and in, show details",
          headline: "Win your next match and you're through to KO.",
          ifYouLose: "If you lose your next match: Needs help.",
          whatIf: null,
          whatIfAssumption: null,
        },
        b: {
          status: "needs_help",
          label: "Needs help",
          ariaLabel: "Rank 2, Needs help, show details",
          headline: "Still open: you need other results to go your way.",
          ifYouLose: "If you lose your next match: Out.",
          whatIf: "If you finish level on points with Alpha, goal/run difference decides. Now: you +1, Alpha +2.",
          whatIfAssumption: null,
        },
      },
    } as const;
    const v = buildTableView({ ...input, qualification });
    expect(v.qualification).toEqual(qualification.table);
    expect(v.rows.map((r) => r.entrantId)).toEqual(["a", "b"]);
    expect(v.rows[0]!.qual).toEqual(qualification.rows.a);
    expect(v.rows[1]!.qual).toEqual(qualification.rows.b);
    expect(TableView.parse(v)).toEqual(v);

    // A row the builder gave no status (a departed entrant) carries null,
    // beside a row that does.
    const onlyB = buildTableView({ ...input, qualification: { ...qualification, rows: { b: qualification.rows.b } } });
    expect(onlyB.rows.map((r) => r.qual)).toEqual([null, qualification.rows.b]);
  });

  it("regression: a no-cut table (qualification null) is the table it was — two new nulls, every other field as pinned", () => {
    // Every field spelled out, never read back off the builder: this is what
    // the view said before Task 6, plus `qual: null` and `qualification: null`.
    const expected = {
      id: "div-s1-overall",
      divisionId: "d1",
      divisionSlug: "div",
      divisionName: "Div",
      caption: "League",
      fullHref: "/shared/o/c/div?tab=standings",
      updatedAt: "2026-09-05T10:00:00Z",
      columns: [
        { key: "played", abbr: "table.abbr.played", title: "table.col.played", compact: true },
        { key: "won", abbr: "table.abbr.won", title: "table.col.won", compact: true },
        { key: "lost", abbr: "table.abbr.lost", title: "table.col.lost", compact: true },
        { key: "gf", abbr: "table.abbr.gf", title: "table.col.gf", compact: false },
        { key: "ga", abbr: "table.abbr.ga", title: "table.col.ga", compact: false },
        { key: "gd", abbr: "table.abbr.gd", title: "table.col.gd", compact: false },
        { key: "points", abbr: "table.abbr.points", title: "table.col.points", compact: true },
      ],
      rows: [
        {
          rank: 1,
          entrantId: "a",
          name: "Alpha",
          badgeUrl: "https://x/a.png",
          colour: null,
          cells: ["1", "0", "0", "2", "0", "2", "3"],
          cellNotes: [null, null, null, null, null, null, null],
          tieBreakText: null,
          qual: null,
          champion: true,
        },
        {
          rank: 2,
          entrantId: "b",
          name: "Beta",
          badgeUrl: null,
          colour: null,
          cells: ["1", "0", "0", "1", "0", "1", "3"],
          cellNotes: [null, null, null, null, null, null, null],
          // The one field the owner's copy fix moved (2026-09-23): a gd row
          // names goal difference, not the old catch-all.
          tieBreakText: 'table.tieBreak:{"with":"Alpha","rule":"table.tieBreak.diffGoals"}',
          qual: null,
          champion: false,
        },
      ],
      qualification: null,
    };
    expect(buildTableView({ ...input, qualification: null })).toEqual(expected);
    // …and an absent input is the same table as an explicit null.
    expect(buildTableView(input)).toEqual(expected);
  });
});
