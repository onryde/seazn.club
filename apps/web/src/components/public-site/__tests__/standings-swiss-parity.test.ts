// W3 app-B T3 (owner Q2, 2026-11-03) - the two standings components, one Swiss table.
//
// `StandingsTable` renders the console division page, the public division page and the embed; `StandingsTableView` renders the
// competition hub's Overview and Table tabs. They are deliberately NOT merged (a follow-up outside W3), so this is the test that
// stops them drifting: the SAME Swiss table - a bye, a late entrant and half-points - goes down both render paths, and the cells
// of every tie-break column, the column set and the bye / late-join markers must read the same.
//
// The scene is built the way production builds it: one list of fixture rows (the DB's shape) feeds the marker facts
// (`swissRowFactsFor`, the page's producer) AND the engine's absent rounds (`swissAbsentRounds`, Task 8's producer), and the
// engine ranks the table (`completeTableStage`, FIDE C.07 art. 16) - so no fixture stands on both ends of any seam.
// `environment: "node"`: markup is what is compared (`renderToStaticMarkup`); the paint is the task's screenshot pass.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchOutcome, type StandingsDelta } from "@seazn/engine/core";
import {
  completeTableStage,
  payout,
  pointsText,
  type FixtureResult,
  type PointsRule,
  type StandingsRow,
  type TableFixture,
  type TableStage,
} from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { swissDrawFactsOf } from "@seazn/engine/competition";
import { tableRulesOf } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { StandingsTable } from "@/components/public-site/standings-table";
import { StandingsTableView } from "@/components/public-site/standings-table-view";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import { swissAbsentRounds } from "@/server/engine-db/swiss-absent-rounds";
import { buildTableView, tableColumns, tableLayoutFor, type TableViewInput } from "@/server/public-site/standings-view";
import { swissRowFactsFor, type RowFactsFixture } from "@/server/public-site/swiss-row-facts";

const EN = en as unknown as Dict;
const msg: TableViewInput["msg"] = (key, vars) => t(EN, key, vars);
// single-sport: chess is the half-point Swiss sport (FIDE 1 / ½ / 0), the table the owner's display fixes are about
const bg = builtinModules.find((m) => m.key === "boardgame")!;
const cfg = bg.variants.classical;
const doc = unpinnedRulesDoc({ module: bg, kind: "swiss", divisionConfig: cfg });
const NAMES: Record<string, string> = { A: "Ash", B: "Birch", C: "Cedar", D: "Dogwood", E: "Elm" };
const STAGE = { id: "swiss-1", kind: "swiss" };

// ── The scene: four players start; Elm joins at round 3, where Dogwood sits out ────────────────────────────────────────
type Result = "home" | "away" | "draw";
const scene: { id: string; round: number; k: number; home: string; away: string; result: Result }[] = [
  { id: "g1", round: 1, k: 1, home: "A", away: "B", result: "home" },
  { id: "g2", round: 1, k: 2, home: "C", away: "D", result: "draw" },
  { id: "g3", round: 2, k: 1, home: "A", away: "C", result: "draw" },
  { id: "g4", round: 2, k: 2, home: "B", away: "D", result: "home" },
  { id: "g5", round: 3, k: 1, home: "A", away: "E", result: "home" },
  { id: "g6", round: 3, k: 2, home: "B", away: "C", result: "away" },
];
/** The DB's rows for the scene: boards, and round 3's bye shell, which Pair seated with Dogwood. */
const dbFixtures: RowFactsFixture[] = [
  ...scene.map((g) => ({
    stage_id: STAGE.id,
    round_no: g.round,
    ext_key: `sw-r${g.round}-b${g.k}`,
    home_entrant_id: g.home,
    away_entrant_id: g.away,
    outcome: g.result === "draw" ? { kind: "draw" } : { kind: "win", winner: g.result === "home" ? g.home : g.away, loser: g.result === "home" ? g.away : g.home },
    status: "decided",
  })),
  { stage_id: STAGE.id, round_no: 3, ext_key: "sw-r3-bye", home_entrant_id: "D", away_entrant_id: null, outcome: { kind: "award", winner: "D", loser: null, reason: "bye" }, status: "decided" },
];

const delta = (entrantId: string, won: number, drawn: number, lost: number): StandingsDelta => ({
  entrantId,
  played: 1,
  won,
  drawn,
  lost,
  points: 0,
  metrics: { wins: won },
});
const rule: PointsRule = doc.points;
function engineFixture(g: (typeof scene)[number]): TableFixture {
  const draw = g.result === "draw";
  const winner = g.result === "home" ? g.home : g.away;
  const pair: FixtureResult = [
    delta(g.home, !draw && winner === g.home ? 1 : 0, draw ? 1 : 0, !draw && winner === g.away ? 1 : 0),
    delta(g.away, !draw && winner === g.away ? 1 : 0, draw ? 1 : 0, !draw && winner === g.home ? 1 : 0),
  ];
  const outcome = draw ? MatchOutcome.parse({ kind: "draw" }) : MatchOutcome.parse({ kind: "win", winner, loser: winner === g.home ? g.away : g.home });
  return { id: g.id, roundNo: g.round, status: "decided", unplayed: null, result: payout(outcome, draw ? null : "regulation", pair, true, rule, undefined, undefined) };
}
/** Dogwood's round-3 bye pays the win (X-SW-5), as `awardByeDelta` does in production. */
function byeFixture(): TableFixture {
  const bye = MatchOutcome.parse({ kind: "award", winner: "D", loser: null, reason: "bye" });
  const pair: FixtureResult = [delta("D", 1, 0, 0), delta("__bye__", 0, 0, 1)];
  const paid = payout(bye, null, pair, false, rule, undefined, undefined);
  return { id: "bye3", roundNo: 3, status: "decided", awardDelta: paid[0].entrantId === "D" ? paid[0] : paid[1] };
}

const entrants = Object.keys(NAMES);
const absent = swissAbsentRounds(dbFixtures, entrants);
const stage: TableStage = {
  id: STAGE.id,
  kind: "swiss",
  entrants,
  rules: tableRulesOf(doc.tiebreakers, doc.points),
  swiss: true,
  swissDraw: swissDrawFactsOf(bg, cfg),
  swissAbsentRounds: absent,
  rounds: 5,
} as TableStage;
const rows: StandingsRow[] = [...completeTableStage(stage, [...scene.map(engineFixture), byeFixture()]).tables.overall!];
const swissFacts = swissRowFactsFor(STAGE, dbFixtures, rows)!;

// ── The two render paths ───────────────────────────────────────────────────────────────────────────────────────────────
const input: TableViewInput = {
  id: "t",
  division: { id: "d1", slug: "div", name: "Div" },
  caption: "Swiss",
  fullHref: "/x",
  rows,
  metricSpecs: bg.metrics,
  cascade: doc.tiebreakers,
  entrantNames: NAMES,
  entrantLogos: {},
  entrantColours: {},
  championId: null,
  updatedAt: "2026-11-03T10:00:00Z",
  msg,
  rules: doc,
  dateOf: () => null,
  swissFacts,
};
const divisionPage = renderToStaticMarkup(
  createElement(StandingsTable, { rows, metricSpecs: bg.metrics as never, cascade: doc.tiebreakers, entrantNames: NAMES, entrantLogos: {}, dict: EN, rules: doc, swissFacts, locale: "en", tz: "UTC" }),
);
const view = buildTableView(input);
const hub = renderToStaticMarkup(createElement(StandingsTableView, { view, dict: EN, testid: "t" }));

// ── What a visitor reads off either table ──────────────────────────────────────────────────────────────────────────────
interface Read {
  columns: string[];
  rows: { name: string; cells: string[]; markers: string[] }[];
}
const text = (html: string) => html.replace(/<span class="sr-only">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "");
function read(html: string): Read {
  const head = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
  const body = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
  return {
    // a column is named by its `title` (the word the abbreviation stands for); `#` and Team have none
    columns: [...head.matchAll(/<th scope="col"[^>]*?\stitle="([^"]*)"/g)].map((m) => m[1]!),
    rows: [...body.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((tr) => ({
      name: tr[0].match(/<th scope="row"[\s\S]*?<span[^>]*\stitle="([^"]*)"/)![1]!,
      // the cells after the rank cell, as text (the markers sit in the name cell, not here)
      cells: [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(1).map((td) => text(td[1]!)),
      // kind, short text, sentence: anchored on `="` so an attribute that is absent cannot read as present
      markers: [...tr[0].matchAll(/<span data-marker="(bye|late)"[^>]*\stitle="([^"]*)"[^>]*><span aria-hidden="true">([^<]*)<\/span><span class="sr-only">([^<]*)<\/span>/g)].map(
        (m) => `${m[1]}|${m[3]}|${m[2]}|${m[4]}`,
      ),
    })),
  };
}
const a = read(divisionPage);
const b = read(hub);

describe("owner Q2.5 - the two standings components read one Swiss table the same way", () => {
  it("the scene is the one the owner described: a bye, a late entrant and half-points, ranked by the engine", () => {
    expect(rows.map((r) => r.entrantId).sort()).toEqual(entrants);
    expect(absent.get("E"), "premise: the engine's absent rounds for Elm - the rounds before she joined").toEqual([1, 2]);
    expect(Object.keys(swissFacts).sort(), "premise: exactly the bye holder and the latecomer are marked").toEqual(["D", "E"]);
    const ladders = rows.flatMap((r) => ["buchholz", "buchholz_cut1", "sberger"].map((k) => r.metrics[k]).filter((v): v is number => v !== undefined));
    expect(ladders.length, "premise: the table carries ladder values").toBeGreaterThan(10);
    expect(ladders.some((v) => !Number.isInteger(v)), "premise: a ladder is in half-points somewhere").toBe(true);
    expect(tableLayoutFor(doc).unit, "premise: a half-point table").toBe("half");
  });

  it("both render the same column set: the shared table's columns, W once and no Wins beside it", () => {
    const expected = tableColumns(bg.metrics, doc.tiebreakers, rows, tableLayoutFor(doc)).map((c) => c.key);
    expect(view.columns.map((c) => c.key)).toEqual(expected);
    expect(a.columns, "the division page and the hub name the same columns, in the same order").toEqual(b.columns);
    expect(a.columns.length, "columns compared").toBe(expected.length);
    expect(a.columns).toContain("Won");
    expect(a.columns.filter((c) => c === "Wins" || c === "Won"), "one wins column").toEqual(["Won"]);
    for (const ladder of ["buchholz", "buchholz_cut1", "sberger"]) expect(expected, `premise: ${ladder} is a column`).toContain(ladder);
  });

  it("both print the same text in every cell of every row, and each tie-break cell is spelled like the table's Points column (counted)", () => {
    expect(a.rows.map((r) => r.name)).toEqual(b.rows.map((r) => r.name));
    expect(a.rows).toHaveLength(entrants.length);
    const keys = view.columns.map((c) => c.key);
    let compared = 0;
    let halves = 0;
    for (const [i, rowA] of a.rows.entries()) {
      const rowB = b.rows[i]!;
      expect(rowA.cells.length, rowA.name).toBe(keys.length);
      expect(rowA.cells, `${rowA.name}: the division page and the hub print the same cells`).toEqual(rowB.cells);
      const standing = rows.find((r) => NAMES[r.entrantId] === rowA.name)!;
      for (const [j, key] of keys.entries()) {
        compared++;
        if (key === "points") expect(rowA.cells[j], `${rowA.name} Points`).toBe(pointsText(standing.points, "half"));
        // the ladders are stored in whole points: in this half-point table's spelling, a half is "½" and never ".5"
        if (key === "buchholz" || key === "buchholz_cut1" || key === "sberger") {
          const value = standing.metrics[key]!;
          expect(rowA.cells[j], `${rowA.name} ${key}`).toBe(pointsText(value * 2, "half"));
          expect(rowA.cells[j], `${rowA.name} ${key} never spells a half as .5`).not.toMatch(/\.5$/);
          if (rowA.cells[j]!.includes("½")) halves++;
        }
      }
    }
    expect(compared, "cells compared").toBe(entrants.length * keys.length);
    expect(halves, "tie-break cells that print a half").toBeGreaterThan(0);
  });

  it("both mark the bye holder and the late entrant, with the same words, the same sentence and the same accessible name - and nobody else", () => {
    const marks = (r: Read) => Object.fromEntries(r.rows.map((x) => [x.name, x.markers]));
    expect(marks(a)).toEqual(marks(b));
    expect(marks(a)).toEqual({
      Ash: [],
      Birch: [],
      Cedar: [],
      Dogwood: ["bye|Bye R3|Bye in round 3: no opponent that round.|Bye in round 3: no opponent that round."],
      Elm: ["late|From R3|Joined in round 3. Earlier rounds (1–2) count as unplayed.|Joined in round 3. Earlier rounds (1–2) count as unplayed."],
    });
    // the visible short text is hidden from the accessibility tree and the sentence carries the name (anchored on `="`)
    expect(divisionPage.match(/<span data-marker="/g)).toHaveLength(2);
    expect(hub.match(/<span data-marker="/g)).toHaveLength(2);
    expect(divisionPage).toContain('<span aria-hidden="true">Bye R3</span><span class="sr-only">Bye in round 3: no opponent that round.</span>');
    expect(hub).toContain('<span aria-hidden="true">From R3</span>');
  });

  it("an unmarked table renders no marker markup at all, in either component (the empty case)", () => {
    const plain = { ...input, swissFacts: undefined };
    const plainHub = renderToStaticMarkup(createElement(StandingsTableView, { view: buildTableView(plain), dict: EN, testid: "t" }));
    const plainPage = renderToStaticMarkup(
      createElement(StandingsTable, { rows, metricSpecs: bg.metrics as never, cascade: doc.tiebreakers, entrantNames: NAMES, entrantLogos: {}, dict: EN, rules: doc, locale: "en", tz: "UTC" }),
    );
    expect(plainHub).not.toContain('data-marker="');
    expect(plainPage).not.toContain('data-marker="');
    // …and the cells are the same cells: marking a row changes nothing about its numbers
    expect(read(plainPage).rows.map((r) => r.cells)).toEqual(a.rows.map((r) => r.cells));
    expect(read(plainHub).rows.map((r) => r.cells)).toEqual(b.rows.map((r) => r.cells));
  });
});
