// W2d Task 17 — the public table: its columns, half-points, OTW/OTL, the lots note, the head-to-head notes and the level
// empty table (SPEC §5.7, §6 W6/W8, §9 "public table"; D10(b); anti-goals 2 and 3). Rule rows IH-PT-1 (columns),
// BG-PT-1, ST-G29, X-TB-4 (display), X-TB-6, HK-TB-2 (the field-goals column).
//
// Both public tables are driven: the hub's view (`buildTableView`) and the division page / embed / console table
// (`StandingsTable`, rendered to markup — `environment: "node"`, so markup is what is seen; the paint was looked at on a
// prod build at 1280/768/320, task-17 report). Rows come from the engine's own producers — the sport's `tablePointsRule`,
// `payout`, `completeTableStage` and `rankStandings` — and every stage's rules from the one loader's pure mapping
// (`unpinnedRulesDoc` → `stageTableRulesDocOf`). Expected values are the rulebooks' (RBG §3.4 for IIHF, FIDE 1 / ½ / 0,
// BWF 16.2, FIH GTR App. 3, ATP C.3-1) and every word is the dictionary's — never the code under test's.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchOutcome, type StandingsDelta } from "@seazn/engine/core";
import {
  DERIVED_METRICS,
  PLAIN_LAYOUT,
  completeTableStage,
  payout,
  reachableOutcomes,
  tableLayoutOf,
  type FixtureResult,
  type PointsRule,
  type StandingsRow,
  type TableFixture,
} from "@seazn/engine/competition";
import type { AnySportModule, DecidedIn, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport, tableRulesOf } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { formatPublicInstant } from "@/lib/public-date-locale";
import { StandingsTable } from "@/components/public-site/standings-table";
import { StandingsTableView } from "@/components/public-site/standings-table-view";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import type { QualificationView } from "../qualification-view";
import {
  ORDER_SOURCE_KEYS,
  TIE_NOTE_KEYS,
  buildTableView,
  fixedResultColumns,
  stageOrderNote,
  tableColumns,
  tieNoteText,
  type TableViewInput,
} from "../standings-view";

const EN = en as unknown as Dict;
const enMsg = (k: string, v?: Record<string, string | number>) => t(EN, k, v);
const NAMES: Record<string, string> = { A: "Ash", B: "Birch", C: "Cedar", D: "Dogwood", E: "Elm" };
const DRAWN_AT = "2026-10-20T09:30:00.000Z";
const enDate = (iso: string) => formatPublicInstant("en", "UTC", iso, { dateStyle: "medium" });

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`premise: ${key} is a built-in sport`);
  return m;
};
const cfgOf = (m: AnySportModule, variant?: string): unknown => (variant === undefined ? {} : m.variants[variant]);

const delta = (entrantId: string, won: number, drawn: number, lost: number, metrics: Record<string, number>): StandingsDelta => ({
  entrantId,
  played: 1,
  won,
  drawn,
  lost,
  points: 0,
  metrics,
});

/** A goal sport's fixture paid by `rule` (`payout`): `home` beat `away` when `decidedIn` is set, a draw when null. */
function goals(id: string, home: string, away: string, score: readonly [number, number], decidedIn: DecidedIn | null, rule: PointsRule): TableFixture {
  const [hg, ag] = score;
  const ledger = (f: number, a: number) => ({ gf: f, ga: a, gd: f - a });
  const draw = decidedIn === null;
  const winner = hg >= ag ? home : away;
  const pair: FixtureResult = [
    delta(home, !draw && winner === home ? 1 : 0, draw ? 1 : 0, !draw && winner === away ? 1 : 0, ledger(hg, ag)),
    delta(away, !draw && winner === away ? 1 : 0, draw ? 1 : 0, !draw && winner === home ? 1 : 0, ledger(ag, hg)),
  ];
  const outcome = draw ? MatchOutcome.parse({ kind: "draw" }) : MatchOutcome.parse({ kind: "win", winner, loser: winner === home ? away : home });
  return { id, status: "decided", result: payout(outcome, decidedIn, pair, true, rule, undefined, undefined) };
}

/** A set sport's fixture: `winner` took it 2-0, 21-15 21-15 (so a cycle of three leaves everyone level on every ledger). */
function sets(id: string, winner: string, loser: string, rule: PointsRule): TableFixture {
  const pair: FixtureResult = [
    delta(winner, 1, 0, 0, { sets_won: 2, sets_lost: 0, points_won: 42, points_lost: 30 }),
    delta(loser, 0, 0, 1, { sets_won: 0, sets_lost: 2, points_won: 30, points_lost: 42 }),
  ];
  const outcome = MatchOutcome.parse({ kind: "win", winner, loser });
  return { id, status: "decided", result: payout(outcome, "regulation", pair, true, rule, undefined, 2) };
}

type Doc = ReturnType<typeof unpinnedRulesDoc>;
const docOf = (m: AnySportModule, variant?: string, kind = "league", divisionTiebreakers: readonly string[] | null = null): Doc =>
  unpinnedRulesDoc({ module: m, kind, divisionConfig: cfgOf(m, variant), divisionTiebreakers });

/** The stage's table, as the ranking pass leaves it, under its own rules. */
const tableOf = (
  doc: Doc,
  entrants: readonly string[],
  fixtures: readonly TableFixture[],
  extra: { lots?: Map<string, { order: string[]; drawnAt: string }>; scheduledPairs?: readonly (readonly [string, string])[] } = {},
): StandingsRow[] => [
  ...completeTableStage(
    {
      id: "s",
      kind: "league",
      entrants,
      rules: tableRulesOf(doc.tiebreakers, doc.points),
      ...(extra.lots === undefined ? {} : { lotsDraws: new Map([["", extra.lots]]) }),
      // The stage's round-robin schedule, as production passes it (engine-db `scheduledPairsOf`).
      ...(extra.scheduledPairs === undefined ? {} : { scheduledPairs: extra.scheduledPairs }),
    } as Parameters<typeof completeTableStage>[0],
    fixtures,
  ).tables.overall!,
];

function input(doc: Doc | null, m: AnySportModule, rows: StandingsRow[], over: Partial<TableViewInput> = {}): TableViewInput {
  return {
    id: "t",
    division: { id: "d1", slug: "div", name: "Div" },
    caption: "League",
    fullHref: "/x",
    rows,
    metricSpecs: m.metrics,
    cascade: doc?.tiebreakers ?? [],
    entrantNames: NAMES,
    entrantLogos: {},
    entrantColours: {},
    championId: null,
    updatedAt: "2026-10-27T10:00:00Z",
    msg: enMsg,
    rules: doc,
    dateOf: enDate,
    ...over,
  };
}

const tableHtml = (doc: Doc | null, m: AnySportModule, rows: StandingsRow[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(StandingsTable, {
      rows,
      metricSpecs: m.metrics as never,
      cascade: doc?.tiebreakers ?? [],
      entrantNames: NAMES,
      dict: EN,
      rules: doc,
      locale: "en",
      tz: "UTC",
      ...extra,
    }),
  );
/** The header letters the division table prints, in order (each column's aria-hidden abbreviation). */
const headerAbbrs = (html: string) => [...html.matchAll(/<th scope="col"[^>]*><span class="sr-only">[^<]*<\/span><span aria-hidden="true">([^<]*)<\/span><\/th>/g)].map((x) => x[1]);
const byId = (rows: readonly StandingsRow[], id: string) => rows.find((r) => r.entrantId === id)!;

describe("W2d T17 — the public table (SPEC §5.7, §9)", () => {
  it("IH-PT-1 IIHF prints OTW/OTL as OT+SO sums; recreational prints GP W D L (RBG:343-344)", () => {
    // single-sport: ice hockey is the shipped sport whose table splits OTW/OTL (RBG:343-344); every sport's layout is swept in display-w2d.test.ts
    const ih = sport("icehockey");
    const doc = docOf(ih, "iihf");
    const rows = tableOf(doc, ["A", "B", "C", "D", "E"], [
      goals("g1", "A", "B", [4, 1], "regulation", doc.points),
      goals("g2", "A", "C", [3, 2], "ot", doc.points),
      goals("g3", "A", "D", [3, 2], "so", doc.points),
      goals("g4", "E", "A", [2, 1], "ot", doc.points),
    ]);
    const view = buildTableView(input(doc, ih, rows));
    // RBG §3.4: GP · W · OTW · OTL · L · GF · GA · GD · Pts.
    expect(view.columns.map((c) => c.key)).toEqual(["played", "won", "otw", "otl", "lost", "gf", "ga", "gd", "points"]);
    expect(view.columns.map((c) => c.abbr).slice(0, 5)).toEqual(["P", "W", en["table.abbr.otw"], en["table.abbr.otl"], "L"]);
    const cells = (id: string) => view.rows.find((r) => r.entrantId === id)!.cells;
    // A: a regulation win, an OT win, a GWS win, an OT loss — 3 + 2 + 2 + 1 = 8 (3 / 2 / 1 / 0).
    expect(cells("A")).toEqual(["4", "1", "2", "1", "0", "11", "7", "4", "8"]);
    expect(cells("E")).toEqual(["1", "0", "1", "0", "0", "2", "1", "1", "2"]);
    expect(cells("D")).toEqual(["1", "0", "0", "1", "0", "2", "3", "-1", "1"]);
    // The division page's table prints the same columns (asserted here: the headers); the cells are pinned on the hub's
    // view above, and the division page shares its one cell expression (`cellText`).
    const html = tableHtml(doc, ih, rows);
    expect(headerAbbrs(html)).toEqual(view.columns.map((c) => c.abbr));
    // Ice hockey's recreational variant: no OT, draws stand, 2/1/0 — GP W D L and no OT columns.
    const rec = docOf(ih, "recreational");
    const recRows = tableOf(rec, ["A", "B", "C"], [goals("g1", "A", "B", [3, 1], "regulation", rec.points), goals("g2", "A", "C", [2, 2], null, rec.points)]);
    const recView = buildTableView(input(rec, ih, recRows));
    expect(recView.columns.map((c) => c.key)).toEqual(["played", "won", "drawn", "lost", "gf", "ga", "gd", "points"]);
    expect(recView.rows.find((r) => r.entrantId === "A")!.cells).toEqual(["2", "1", "1", "0", "5", "3", "2", "3"]);
    // A stage the loader refused (no rules) prints W and L as folded — never a guessed split.
    expect(buildTableView(input(null, ih, rows)).columns.map((c) => c.key)).not.toContain("otw");
    // T17 fix 1 (m2): on a phone, the split table keeps played and points and folds W · OTW · OTL · L together (W and L
    // alone would not add up to GP); a table that does not split keeps its four. The hub prints the fold as `max-md:hidden`.
    const phone = (v: ReturnType<typeof buildTableView>) => v.columns.filter((c) => c.compact).map((c) => c.key);
    expect(phone(view)).toEqual(["played", "points"]);
    expect(phone(recView)).toEqual(["played", "won", "lost", "points"]);
    const hub = renderToStaticMarkup(createElement(StandingsTableView, { view, dict: EN, testid: "h" }));
    const folded = [...hub.matchAll(/<th[^>]*data-col="([a-z_]+)"[^>]*>/g)].filter((m) => /\smax-md:hidden"|\smax-md:hidden\s/.test(m[0])).map((m) => m[1]);
    expect(folded).toEqual(["won", "otw", "otl", "lost", "gf", "ga", "gd"]);
    expect(hub, "a long tail on a phone has its disclosure").toContain('data-testid="h-more"');
  });

  it("BG-PT-1 chess 3 half-points print '1½' (D10(b), RB2B-17) — a round robin with its SB column", () => {
    // single-sport: chess is the half-point sport (FIDE 1 / ½ / 0, D10(b))
    const bg = sport("boardgame");
    const doc = docOf(bg);
    expect(doc.tiebreakers, "premise: a chess round robin ranks on Sonneborn–Berger").toContain("sberger");
    // A beats B, draws C, loses to D: FIDE 1 + ½ + 0 = 1½.
    const rows = tableOf(doc, ["A", "B", "C", "D"], [
      goals("g1", "A", "B", [1, 0], "regulation", doc.points),
      goals("g2", "A", "C", [0, 0], null, doc.points),
      goals("g3", "D", "A", [1, 0], "regulation", doc.points),
    ]);
    expect(byId(rows, "A").points, "premise: the table stores half-points").toBe(3);
    const view = buildTableView(input(doc, bg, rows));
    const pts = view.columns.findIndex((c) => c.key === "points");
    const shown = Object.fromEntries(view.rows.map((r) => [r.entrantId, r.cells[pts]]));
    expect(shown).toEqual({ A: "1½", B: "0", C: "½", D: "1" });
    expect(view.columns.map((c) => c.key)).toContain("sberger");
    // the division table prints the same half-point total
    const html = tableHtml(doc, bg, rows);
    const pointsCells = [...html.matchAll(/text-accent-strong">([^<]*)<\/td>/g)].map((x) => x[1]);
    expect(pointsCells).toEqual(view.rows.map((r) => r.cells[pts]));
    expect(pointsCells).toContain("1½");
  });

  it("a column per new key in the order: set_diff, point_diff, field_goals, SB (round robin), game ratio — only when the key is in the effective order (ST-G29)", () => {
    // Each sport's own default order (its rulebook's): BWF 16.2.3/16.2.4, FIH GTR App. 3, ATP C.3-1, FIDE (SB), FIVB.
    const expected: Record<string, string[]> = {
      badminton: ["set_diff", "point_diff"],
      hockey: ["field_goals"],
      tennis: ["set_ratio", "game_ratio"],
      boardgame: ["sberger"],
      volleyball: ["set_ratio", "point_ratio"],
    };
    const derivedKeys = new Set<string>(DERIVED_METRICS.map((d) => d.key));
    let checked = 0;
    for (const [key, want] of Object.entries(expected)) {
      const m = sport(key);
      const doc = docOf(m);
      const view = buildTableView(input(doc, m, []));
      expect(view.columns.map((c) => c.key).filter((k) => derivedKeys.has(k)), key).toEqual(want);
      checked++;
    }
    expect(checked).toBe(5);
    // The English headers are the engine's labels; every locale has its own word.
    const bd = sport("badminton"); // single-sport: badminton's order carries set and point difference (BWF 16.2)
    const headers = buildTableView(input(docOf(bd), bd, [])).columns;
    expect(headers.filter((c) => derivedKeys.has(c.key)).map((c) => [c.abbr, c.title])).toEqual([
      [en["table.abbr.setDiff"], en["table.col.setDiff"]],
      [en["table.abbr.pointDiff"], en["table.col.pointDiff"]],
    ]);
    // Only when the key is in the stage's effective order: a badminton division ranking on set difference alone.
    const own = docOf(bd, undefined, "league", ["wins", "set_diff", "lots"]);
    expect(own.tiebreakers, "premise: the division's order is the stage's").toEqual(["wins", "set_diff", "lots"]);
    expect(buildTableView(input(own, bd, [])).columns.map((c) => c.key).filter((k) => derivedKeys.has(k))).toEqual(["set_diff"]);
    // HK-TB-2's column prints field goals: goals less penalty-corner and penalty-stroke goals.
    const hk = sport("hockey"); // single-sport: hockey is the field-goals sport (FIH GTR App. 3, HK-TB-2)
    const hkDoc = docOf(hk);
    const hkRow: StandingsRow = { entrantId: "A", rank: 1, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: { gf: 5, ga: 1, gd: 4, goals_pc: 2, goals_stroke: 1 } };
    const hkView = buildTableView(input(hkDoc, hk, [hkRow]));
    expect(hkView.rows[0]!.cells[hkView.columns.findIndex((c) => c.key === "field_goals")]).toBe("2");
  });

  it("X-TB-6 an empty table renders every rank '–', no leader row, no qualification chip", () => {
    // single-sport: a level table is the ranking pass's, not a sport's: football here, chess below as the other sport
    // empty case first: nothing counted yet — every row level (anti-goal 3)
    const fb = sport("football");
    const doc = docOf(fb);
    const empty = tableOf(doc, ["A", "B", "C"], [{ id: "g1", status: "scheduled" }]);
    expect(empty.every((r) => r.level === true), "premise: the engine marks the empty table level").toBe(true);
    const qualification: QualificationView = {
      table: { cutIndex: 1, label: "Through", legend: { through: "Through", open: "Open", out: "Out", hint: "Hint" } },
      rows: Object.fromEntries(
        ["A", "B", "C"].map((id) => [id, { status: "open", label: "Open", headline: "Open", ifYouLose: null, whatIf: null, whatIfAssumption: null, ariaLabel: `Rank, ${id}` }]),
      ) as unknown as QualificationView["rows"],
    };
    const view = buildTableView(input(doc, fb, empty, { qualification, championId: "A" }));
    expect(view.rows.map((r) => r.rank)).toEqual([null, null, null]);
    expect(view.rows.map((r) => r.qual)).toEqual([null, null, null]);
    // no tie note: the rows still carry the ranking pass's trace, which would explain a place the table does not print
    expect(empty.every((r) => r.tieBreak !== undefined), "premise: the level rows carry a tie trace").toBe(true);
    expect(view.rows.map((r) => r.tieBreakText)).toEqual([null, null, null]);
    expect(view.qualification).toBeNull();
    expect(view.rows.some((r) => r.champion)).toBe(false);
    const html = tableHtml(doc, fb, empty, { qualification });
    expect(html.match(/<span aria-hidden="true">–<\/span><span class="sr-only">/g)?.length).toBe(3);
    expect(html).toContain(en["table.level"]);
    expect(html).not.toContain("bg-amber-50");
    expect(html).not.toContain("bg-amber-300");
    expect(html).not.toContain('data-qual="');
    expect(html).not.toContain('data-testid="standings-tie-');
    const hub = renderToStaticMarkup(createElement(StandingsTableView, { view, dict: EN, testid: "h" }));
    expect(hub.match(/<span aria-hidden="true">–<\/span>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(hub).not.toContain("bg-amber-50/60");
    // One result: nobody is level — the leader row, its medal and the qualification marks come back (the positive pair).
    const one = tableOf(doc, ["A", "B", "C"], [goals("g1", "A", "B", [2, 0], "regulation", doc.points)]);
    const oneView = buildTableView(input(doc, fb, one, { qualification }));
    expect(oneView.rows[0]!.rank).toBe(1);
    expect(oneView.qualification).not.toBeNull();
    const oneHtml = tableHtml(doc, fb, one, { qualification });
    expect(oneHtml).toContain("bg-amber-50");
    expect(oneHtml).toContain('data-qual="open"');
    expect(oneHtml).not.toContain(en["table.level"]);
    expect(oneView.rows.some((r) => r.tieBreakText !== null), "the tie notes come back too").toBe(true);
    // A void re-levels it: the voided fixture no longer counts.
    const voided = tableOf(doc, ["A", "B", "C"], [{ ...goals("g1", "A", "B", [2, 0], "regulation", doc.points), status: "void" }]);
    expect(buildTableView(input(doc, fb, voided)).rows.map((r) => r.rank)).toEqual([null, null, null]);
    // Another sport: chess's empty round robin is level too.
    const bg = sport("boardgame");
    expect(buildTableView(input(docOf(bg), bg, tableOf(docOf(bg), ["A", "B"], []))).rows.map((r) => r.rank)).toEqual([null, null]);
  });

  it("X-TB-4 a lots-decided row's popover says 'Drawn by lots on {date}' from tieBreak.drawnAt", () => {
    // single-sport: lots ends every order; football's default reaches it with a pair that never met
    const fb = sport("football");
    const doc = docOf(fb);
    // A and B both beat C 1-0 and drew each other 0-0: level on every step before lots.
    const fixtures = [
      goals("g1", "A", "C", [1, 0], "regulation", doc.points),
      goals("g2", "B", "C", [1, 0], "regulation", doc.points),
      goals("g3", "A", "B", [0, 0], null, doc.points),
    ];
    expect(doc.tiebreakers.at(-1), "premise: football's order ends on lots").toBe("lots");
    const stored = tableOf(doc, ["A", "B", "C"], fixtures, { lots: new Map([["A,B", { order: ["B", "A"], drawnAt: DRAWN_AT }]]) });
    const a = byId(stored, "A");
    expect(a.tieBreak, "premise: the stored draw orders the pair").toMatchObject({ key: "lots", drawnAt: DRAWN_AT });
    const note = enMsg("table.tieNote.drawnAt", { date: enDate(DRAWN_AT)! });
    expect(enDate(DRAWN_AT)).toBe("20 Oct 2026");
    const view = buildTableView(input(doc, fb, stored));
    expect(view.rows.find((r) => r.entrantId === "A")!.tieBreakText!.split("\n")).toEqual([
      enMsg("table.tieBreak", { with: "Birch", rule: en["table.tieBreak.lots"] }),
      note,
    ]);
    const html = tableHtml(doc, fb, stored);
    expect(html).toContain(`<span data-testid="tie-note-line" class="mt-1 block text-ink-muted">${note}</span>`);
    // in the org's language: the Spanish page prints the Spanish sentence with a Spanish date
    const esHtml = tableHtml(doc, fb, stored, { dict: es as unknown as Dict, locale: "es" });
    const esDate = formatPublicInstant("es", "UTC", DRAWN_AT, { dateStyle: "medium" })!;
    expect(esHtml).toContain(t(es as unknown as Dict, "table.tieNote.drawnAt", { date: esDate }));
    // in the division's zone: a drawing made at 23:30 UTC on 20 October is 12:30 on the 21st in Auckland (NZDT, UTC+13
    // from the last Sunday of September) — the date the organiser saw on the wall, not the server's.
    const late = tableOf(doc, ["A", "B", "C"], fixtures, { lots: new Map([["A,B", { order: ["B", "A"], drawnAt: "2026-10-20T23:30:00.000Z" }]]) });
    expect(tableHtml(doc, fb, late)).toContain(enMsg("table.tieNote.drawnAt", { date: "20 Oct 2026" }));
    const auckland = tableHtml(doc, fb, late, { tz: "Pacific/Auckland" });
    expect(auckland).toContain(enMsg("table.tieNote.drawnAt", { date: "21 Oct 2026" }));
    expect(auckland).not.toContain("20 Oct 2026");
    // A lots tie whose draw is not stored yet carries no date: the popover says no "Drawn by lots" (the positive pair).
    const pending = tableOf(doc, ["A", "B", "C"], fixtures);
    expect(byId(pending, "A").tieBreak?.drawnAt).toBeUndefined();
    expect(buildTableView(input(doc, fb, pending)).rows.every((r) => !(r.tieBreakText ?? "").includes(note))).toBe(true);
  });

  it("anti-goal 2 a class of three on a badminton h2h_two step: the popover says head-to-head applies between two only (note h2h_two_not_applicable), and a class of two shows no such note (the positive pair)", () => {
    // single-sport: badminton's order carries h2h_two (BWF 16.2.3); the engine's partial-schedule sweep covers the other sports
    const bd = sport("badminton");
    const doc = docOf(bd);
    expect(doc.tiebreakers.filter((k) => k === "h2h_two").length, "premise: BWF's order re-asks head-to-head for two").toBeGreaterThan(0);
    const NOTE = en["table.tieNote.h2hTwoNotApplicable"];
    // A cycle of three: A > B > C > A, every match 2-0, 21-15 21-15 — level on wins, games and points difference.
    const three = tableOf(doc, ["A", "B", "C"], [sets("g1", "A", "B", doc.points), sets("g2", "B", "C", doc.points), sets("g3", "C", "A", doc.points)]);
    expect(three.map((r) => r.tieBreak?.note), "premise: the engine notes why head-to-head did not split").toEqual([
      "h2h_two_not_applicable",
      "h2h_two_not_applicable",
      "h2h_two_not_applicable",
    ]);
    const view = buildTableView(input(doc, bd, three));
    let checked = 0;
    for (const r of view.rows) {
      expect(r.tieBreakText!.split("\n")[1], r.entrantId).toBe(NOTE);
      checked++;
    }
    expect(checked).toBe(3);
    expect(tableHtml(doc, bd, three)).toContain(NOTE);
    // A class of two who met: A beat B, both beat C — head-to-head between the two splits them, no note.
    const two = tableOf(doc, ["A", "B", "C"], [sets("g1", "A", "B", doc.points), sets("g2", "A", "C", doc.points), sets("g3", "B", "C", doc.points)]);
    const twoView = buildTableView(input(doc, bd, two));
    expect(twoView.rows.some((r) => (r.tieBreakText ?? "").includes(NOTE))).toBe(false);
    expect(tableHtml(doc, bd, two)).not.toContain(NOTE);
  });

  it("head-to-head not complete (h2h_incomplete, X-TB-8): the popover says so, in every locale", () => {
    const row: StandingsRow = {
      entrantId: "A",
      rank: 1,
      played: 1,
      won: 1,
      drawn: 0,
      lost: 0,
      points: 3,
      metrics: {},
      tieBreak: { key: "lots", with: ["B"], note: "h2h_incomplete" },
    };
    const other: StandingsRow = { ...row, entrantId: "B", rank: 2, tieBreak: { key: "lots", with: ["A"], note: "h2h_incomplete" } };
    let checked = 0;
    for (const dict of [en, es, fr, nl] as unknown as Dict[]) {
      const msg = (k: string, v?: Record<string, string | number>) => t(dict, k, v);
      const text = tieNoteText(row, [row, other], msg, (id) => NAMES[id]!, () => null)!;
      expect(text.split("\n")).toEqual([msg("table.tieBreak", { with: "Birch", rule: msg("table.tieBreak.lots") }), dict["table.tieNote.h2hIncomplete"]]);
      checked++;
    }
    expect(checked).toBe(4);
    // every note the engine can write has a sentence, in every locale
    for (const dict of [en, es, fr, nl] as Record<string, string>[]) {
      for (const key of Object.values(TIE_NOTE_KEYS)) expect(typeof dict[key], key).toBe("string");
    }
    // a row with no trace has no note at all
    expect(tieNoteText({ ...row, tieBreak: undefined }, [row], enMsg, (id) => id, () => null)).toBeNull();
  });

  // W2d T17 fix 1 (I1, review m5): the note driven through the ranking pass, not typed. Spec anti-goal 2 (spec:113-115)
  // and §5.6 (spec:480): when a tied pair has not met and a LATER step splits them (here goal difference), the table says
  // head-to-head is not complete. FIFA 2026 (football's default): points, then the head-to-head block, then GD.
  it("head-to-head not complete, through the ranking pass: football's GD split carries the note on both rows, in every locale", () => {
    // single-sport: football's default (FIFA 2026) ranks head-to-head before GD; the note's other sports are partial-schedule.test.ts's
    const fb = sport("football");
    const doc = docOf(fb);
    expect(doc.tiebreakers.slice(0, 2), "premise: football ranks head-to-head before goal difference").toEqual(["points", "h2h_points"]);
    const ids = ["A", "B", "C", "D"];
    const roundRobin = ids.flatMap((x, i) => ids.slice(i + 1).map((y) => [x, y] as const));
    // Ash beat Cedar 3-0 and Birch beat Dogwood 1-0; Ash v Birch is still to play. Level on 3, split on GD (+3 v +1).
    const played = [goals("g1", "A", "C", [3, 0], "regulation", doc.points), goals("g2", "B", "D", [1, 0], "regulation", doc.points)];
    const rows = tableOf(doc, ids, played, { scheduledPairs: roundRobin });
    expect(rows.map((r) => r.entrantId)).toEqual(["A", "B", "D", "C"]);
    let checked = 0;
    for (const dict of [en, es, fr, nl] as unknown as Dict[]) {
      const msg = (k: string, v?: Record<string, string | number>) => t(dict, k, v);
      for (const [id, other] of [["A", "Birch"], ["B", "Ash"]] as const) {
        const row = rows.find((r) => r.entrantId === id)!;
        expect(tieNoteText(row, rows, msg, (x) => NAMES[x]!, () => null)!.split("\n"), `${id}`).toEqual([
          // A goal ledger's difference is "goal difference" (FIFA 2026 art. 13).
          msg("table.tieBreak", { with: other, rule: msg("table.tieBreak.diffGoals") }),
          (dict as unknown as Record<string, string>)["table.tieNote.h2hIncomplete"],
        ]);
        checked++;
      }
    }
    expect(checked).toBe(8);
    // The division page's table: one note per row the engine marked (Ash, Birch, and Cedar / Dogwood, who have not met).
    const notes = (html: string) => html.split(en["table.tieNote.h2hIncomplete"]).length - 1;
    expect(rows.filter((r) => r.tieBreak?.note === "h2h_incomplete")).toHaveLength(4);
    expect(notes(tableHtml(doc, fb, rows))).toBe(4);
    // The pair: Ash v Birch played (a 1-1 draw) — the head-to-head step ran on a complete schedule and answered; no note.
    const met = tableOf(doc, ids, [...played, goals("g3", "A", "B", [1, 1], null, doc.points)], { scheduledPairs: roundRobin });
    expect(met.filter((r) => r.entrantId === "A" || r.entrantId === "B").map((r) => r.tieBreak)).toEqual([
      { key: "diff", with: ["B"] },
      { key: "diff", with: ["A"] },
    ]);
    expect(notes(tableHtml(doc, fb, met)), "only Cedar and Dogwood, still to meet, keep it").toBe(2);
  });

  it("the division caption is per stage and says where its order came from and that it is pinned", () => {
    // single-sport: the caption reads the stage's rules doc (source, pin), not the sport
    const fb = sport("football");
    const live = docOf(fb);
    const uiMsg = (dict: Record<string, string>) => (k: string, v?: Record<string, string | number>) => t(dict as unknown as Dict, k, v);
    expect(live.pinnedAt, "premise: a pending stage reads its live layers").toBeNull();
    expect(stageOrderNote(live, uiMsg(enUi), enDate)).toEqual({
      source: enUi["div.detail.tiebreak.source.sport"],
      pinned: enUi["div.detail.tiebreak.live"],
    });
    // A stage started (pinned) with its own order: the source is the stage's, and the pin carries its date.
    const pinned = { ...live, pinnedAt: DRAWN_AT, sources: { ...live.sources, tiebreakers: "stage" as const } };
    expect(stageOrderNote(pinned, uiMsg(enUi), enDate)).toEqual({
      source: enUi["div.detail.tiebreak.source.stage"],
      pinned: t(enUi as unknown as Dict, "div.detail.tiebreak.pinned", { date: "20 Oct 2026" }),
    });
    // Two stages of one division, each its own caption: the second inherits the division's order.
    const second = docOf(fb, undefined, "group", ["points", "diff", "lots"]);
    expect(stageOrderNote(second, uiMsg(enUi), enDate)!.source).toBe(enUi["div.detail.tiebreak.source.division"]);
    // A stage the loader refused: no caption (R3).
    expect(stageOrderNote(null, uiMsg(enUi), enDate)).toBeNull();
    // Every source the loader can name has its own sentence, distinct, in all four locales.
    let checked = 0;
    for (const dict of [enUi, esUi, frUi, nlUi] as Record<string, string>[]) {
      const sentences = Object.values(ORDER_SOURCE_KEYS).map((k) => dict[k]);
      expect(sentences.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
      expect(new Set(sentences).size).toBe(4);
      expect(dict["div.detail.tiebreak.pinned"]).toContain("{date}");
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// ---- W2d follow-up (final review m3, m8): the fixed-shape tables' result columns -----------------------------------------
// The organiser export and the kiosk print a FIXED shape (D on every table, as both always have). Their result columns are
// the public table's own declaration, not a second list: IIHF's OTW and OTL beside W and L (RBG §3.4, lines 343-344: "OT
// and GWS decisions both land in OTW/OTL"), every other table its historic P · W · D · L.
describe("W2d follow-up — the export's and the kiosk's result columns are the public table's (m3, m8)", () => {
  const TABLE_KINDS: readonly TableStageKind[] = ["league", "group", "swiss", "americano"];
  // The two shapes, typed from the rulebook (RBG §3.4) and from the export and kiosk as they printed before this change.
  const IIHF = ["P", "W", "OTW", "OTL", "D", "L"];
  const HISTORIC = ["P", "W", "D", "L"];
  /** A row with a draw: the public table prints its D column exactly when one exists. */
  const drawn: StandingsRow = { entrantId: "A", played: 1, won: 0, drawn: 1, lost: 0, points: 1, metrics: {} };

  it("the empty case: a stage with no rules to read (the plain layout) prints the historic P · W · D · L", () => {
    expect(fixedResultColumns(PLAIN_LAYOUT).map((c) => c.label)).toEqual(HISTORIC);
  });

  it("every sport, every declared cfg, every table kind: OTW/OTL only for IIHF ice hockey, and always the public table's own columns with a draw on the table", () => {
    let layouts = 0;
    let split = 0;
    const sports = forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs(module)) {
        for (const kind of TABLE_KINDS) {
          const layout = tableLayoutOf(module.tablePointsRule(cfg as never, kind), reachableOutcomes(module, cfg, kind));
          const cols = fixedResultColumns(layout);
          const iihf = module.key === "icehockey" && name !== "recreational";
          expect(cols.map((c) => c.label), `${module.key} ${name} ${kind}`).toEqual(iihf ? IIHF : HISTORIC);
          // One declaration: the public table's structural result columns for a table that has a draw, verbatim.
          const pub = tableColumns([], [], [drawn], layout).filter((c) => c.kind === "structural" && c.key !== "points");
          expect(cols, `${module.key} ${name} ${kind}: the public table's columns`).toEqual(pub);
          layouts++;
          if (iihf) split++;
        }
      }
    });
    expect(sports, "every shipped sport").toBe(builtinModules.length);
    expect(layouts, "anti-vacuity: layouts checked").toBeGreaterThan(sports);
    expect(split, "anti-vacuity: the IIHF layouts").toBeGreaterThan(0);
    expect(layouts - split, "anti-vacuity: the plain layouts").toBeGreaterThan(0);
  });
});

// keep the type import honest (TiebreakerKey is the cascade's element type)
export type _Cascade = readonly TiebreakerKey[];
