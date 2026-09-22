// The ratio breakdown popover's CONTENT — `ratioNote`, the one builder both
// standings tables read (the division page's server table through
// `standings-table.tsx`, the hub's through `buildTableView`'s `cellNotes`).
//
// Owner-approved copy: the popover states the TOTALS behind a ratio cell,
// "Points won {won} · Points lost {lost} · Ratio {ratio}" — never per match.
// A row with no ledger (the engine prints "—") gets no popover at all, so the
// cell stays plain text rather than a button that explains nothing.
//
// Conventions (this directory's): the EMPTY case first, every negative with
// its positive pair, expectations DERIVED from the engine's own declarations
// (`RATIO_LEDGERS`, `derivedMetricText`) rather than typed in, and at least one
// row whose right answer differs from the wrong one's (every ledger pair
// differs below, so reading a neighbour's pair prints a different sentence).
//
// ---------------------------------------------------------------------------
// Mutants killed (see the task report for the killer list per mutant)
// ---------------------------------------------------------------------------
//  (a) the no-ledger guard deleted → the empty row grows a popover saying
//      "won 0 · lost 0 · ratio —".
//  (b) the guard widened to `ratio === "∞"` too → the unbeaten row loses it.
//  (c) `won`/`lost` swapped in the vars.
//  (d) the ratio recomputed locally (`won / lost`) instead of the engine's text
//      → the unbeaten row prints "Infinity".
//  (e) `RATIO_NOTE_KEYS` gains `set_ratio` → a sport that says "games" is told
//      "sets" (see the set_ratio case).
//  (f) `cellNotes` built for every column → a note on the points column.
import { describe, expect, it } from "vitest";
import { derivedMetricText, RATIO_LEDGERS, type StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { TableView } from "../competition-hub-schema";
import { buildTableView, ratioNote, RATIO_NOTE_KEYS, type TableViewInput } from "../standings-view";

const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;

// Echoes the key and its params, so an assertion pins WHICH key was asked for
// and with what — the same stub `standings-view.test.ts` uses.
const msg: TableViewInput["msg"] = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : `${key}`);

const row = (entrantId: string, metrics: Record<string, number> = {}, over: Partial<StandingsRow> = {}): StandingsRow => ({
  entrantId,
  played: 0,
  won: 0,
  drawn: 0,
  lost: 0,
  points: 0,
  metrics,
  ...over,
});

/** Every ledger pair different, so a note that read the wrong pair — or a
 *  ratio that divided the wrong pair — cannot match by coincidence. */
const LEDGER = { sets_won: 4, sets_lost: 2, boards_won: 7, boards_lost: 3, points_won: 150, points_lost: 160 };

/** The note the builder OUGHT to produce, derived from the engine's pair and
 *  the engine's own ratio text — never a number typed here. */
function expected(r: StandingsRow, key: keyof typeof RATIO_NOTE_KEYS): string {
  const [won, lost] = RATIO_LEDGERS[key];
  return msg(RATIO_NOTE_KEYS[key]!, {
    won: `${r.metrics[won] ?? 0}`,
    lost: `${r.metrics[lost] ?? 0}`,
    ratio: derivedMetricText(r, key)!,
  });
}

describe("ratioNote — the totals behind a ratio cell", () => {
  it("EMPTY: a row with no ledger has no note (the engine prints — there, and a popover would explain nothing)", () => {
    const empty = row("a");
    // The premise, from the engine: this row's cell really is the no-ledger dash.
    expect(derivedMetricText(empty, "point_ratio")).toBe("—");
    expect(ratioNote(empty, "point_ratio", msg)).toBeNull();
    expect(ratioNote(empty, "board_ratio", msg)).toBeNull();
    // Explicit zeros are the same no-ledger row, not a ledger of nothing.
    expect(ratioNote(row("z", { points_won: 0, points_lost: 0 }), "point_ratio", msg)).toBeNull();
  });

  it("positive pair: a row with a ledger gets the won/lost totals and the cell's own ratio text", () => {
    const r = row("a", LEDGER);
    expect(ratioNote(r, "point_ratio", msg)).toBe(expected(r, "point_ratio"));
    // Pinned once in plain numbers too, so the derivation above cannot drift
    // into agreeing with a wrong builder: 150 / 160 = 0.9375.
    expect(ratioNote(r, "point_ratio", msg)).toBe(
      'table.ratioNote.point_ratio:{"won":"150","lost":"160","ratio":"0.94"}',
    );
    // board_ratio falls out of the same code: its own pair, not the points'.
    expect(ratioNote(r, "board_ratio", msg)).toBe(expected(r, "board_ratio"));
    expect(ratioNote(r, "board_ratio", msg)).toContain('"won":"7","lost":"3","ratio":"2.33"');
  });

  it("boundaries: unbeaten (lost 0) and winless (won 0) are real ledgers and DO get a note", () => {
    const unbeaten = row("u", { points_won: 50, points_lost: 0 });
    expect(derivedMetricText(unbeaten, "point_ratio")).toBe("∞");
    expect(ratioNote(unbeaten, "point_ratio", msg)).toBe(
      'table.ratioNote.point_ratio:{"won":"50","lost":"0","ratio":"∞"}',
    );
    const winless = row("w", { points_won: 0, points_lost: 42 });
    expect(ratioNote(winless, "point_ratio", msg)).toBe(
      'table.ratioNote.point_ratio:{"won":"0","lost":"42","ratio":"0.00"}',
    );
  });

  it("set_ratio has NO note: its unit is the sport's word (sets in volleyball, games in badminton), which this sentence cannot know", () => {
    const r = row("a", LEDGER);
    // The cell itself still prints — only the popover is withheld.
    expect(derivedMetricText(r, "set_ratio")).toBe("2.00");
    expect(ratioNote(r, "set_ratio", msg)).toBeNull();
    expect(Object.keys(RATIO_NOTE_KEYS).sort()).toEqual(["board_ratio", "point_ratio"]);
  });

  it("non-ratio columns have no note, ledger or not", () => {
    const r = row("a", { ...LEDGER, runs_for: 100, balls_faced_eff: 60, runs_against: 90, balls_bowled_eff: 60, buchholz: 7 });
    for (const key of ["nrr", "buchholz", "buchholz_cut1", "sberger", "points", "gd"]) {
      expect(ratioNote(r, key, msg), key).toBeNull();
    }
  });

  it("every note key is one of the engine's ratio ledgers", () => {
    for (const key of Object.keys(RATIO_NOTE_KEYS)) expect(RATIO_LEDGERS).toHaveProperty(key);
  });

  it("the English sentence is the owner-approved copy, and every locale authors its own with all three slots", () => {
    const r = row("a", { points_won: 120, points_lost: 98 });
    const english = ratioNote(r, "point_ratio", (k, v) => t(en as Dict, k, v));
    expect(english).toBe("Points won 120 · Points lost 98 · Ratio 1.22");
    for (const key of Object.values(RATIO_NOTE_KEYS)) {
      for (const [locale, dict] of Object.entries(LOCALES)) {
        const s = dict[key!];
        expect(s, `${key} missing in ${locale}`).toBeTypeOf("string");
        for (const slot of ["{won}", "{lost}", "{ratio}"]) expect(s, `${locale} ${key} lost ${slot}`).toContain(slot);
        if (locale !== "en") expect(s, `${locale} ${key} is untranslated English`).not.toBe(LOCALES.en![key!]);
      }
    }
  });
});

describe("buildTableView — cellNotes, parallel to cells", () => {
  const input = (rows: StandingsRow[]): TableViewInput => ({
    id: "div-s1-overall",
    division: { id: "d1", slug: "div", name: "Div" },
    caption: "League",
    fullHref: "/shared/o/c/div?tab=standings",
    rows,
    metricSpecs: [],
    cascade: ["points", "wins", "set_ratio", "point_ratio"],
    entrantNames: { a: "Alpha", b: "Beta" },
    entrantLogos: {},
    entrantColours: {},
    championId: null,
    updatedAt: "2026-09-22T00:00:00.000Z",
    msg,
  });

  it("the point_ratio column carries the note, every other column null; a row with no ledger is all null", () => {
    const withLedger = row("a", LEDGER, { rank: 1, played: 3, won: 2, lost: 1, points: 2 });
    const without = row("b", {}, { rank: 2 });
    const view = buildTableView(input([withLedger, without]));
    const keys = view.columns.map((c) => c.key);
    expect(keys).toContain("point_ratio");
    expect(keys).toContain("set_ratio");

    const [a, b] = view.rows;
    expect(a!.cellNotes).toHaveLength(a!.cells.length);
    keys.forEach((key, i) => {
      expect(a!.cellNotes![i], key).toBe(key === "point_ratio" ? expected(withLedger, "point_ratio") : null);
    });
    // Negative pair: the ledger-less row keeps its dash cell and gets no note.
    expect(b!.cells[keys.indexOf("point_ratio")]).toBe("—");
    expect(b!.cellNotes).toEqual(keys.map(() => null));
    expect(TableView.safeParse(view).success).toBe(true);
  });

  it("a document cached before cellNotes existed still parses (the field is optional)", () => {
    const view = buildTableView(input([row("a", LEDGER, { rank: 1 })]));
    const legacy = { ...view, rows: view.rows.map(({ cellNotes: _drop, ...r }) => r) };
    expect(TableView.safeParse(legacy).success).toBe(true);
  });
});
