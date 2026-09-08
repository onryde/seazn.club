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
import type { StandingsRow } from "@seazn/engine/competition";
import { TableView } from "../competition-hub-schema";
import { buildTableView, COMPACT_KEYS, type TableViewInput } from "../standings-view";

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
    { key: "cards", label: "Cards", display: false },
  ],
  cascade: ["points", "gd"],
  entrantNames: { a: "Alpha", b: "Beta" },
  entrantLogos: { a: "https://x/a.png", b: null },
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
      row("a", { played: 2, won: 2, points: 6, metrics: { gf: 5, ga: 1, gd: 4 }, rank: 1 }),
      row("b", { played: 2, lost: 2, metrics: { gf: 1, ga: 5, gd: -4 }, rank: 2 }),
    ];
    const v = buildTableView({ ...base, rows });
    expect(v.columns.map((c) => [c.key, c.compact])).toEqual([
      ["played", true],
      ["won", true],
      ["lost", true],
      ["gf", false],
      ["ga", false],
      ["gd", false],
      ["points", true],
    ]);
    expect(v.columns.every((c) => c.compact === COMPACT_KEYS.has(c.key))).toBe(true);
    // Structural headers are COPY and get a dictionary key. Metric headers are
    // the sport's own NOTATION and keep the engine's label as their title too,
    // exactly as `stat-table.tsx` does for R/B/4s/SR.
    expect(v.columns[0]!.title).toBe("table.col.played");
    expect(v.columns[6]!.title).toBe("table.col.points");
    expect(v.columns[3]).toEqual({ key: "gf", abbr: "GF", title: "GF", compact: false });
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
    // translated sentence is a leak, unlike a bare notation (GD, NRR).
    expect(v.rows[1]!.tieBreakText).toBe(
      'table.tieBreak:{"with":"Alpha","rule":"table.tieBreak.diff"}',
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
