// The hub Table tab's column HEADERS each fit their own column.
//
// The header row is `text-[11px] uppercase tracking-wider font-semibold` and
// right-aligned, inside a `table-fixed` column sized from CHARACTER counts —
// the same count for a header letter as for a body digit. A whole-word header
// is wider than that: "DIFFERENCE" paints 72.9px and sat in a 64px column
// (60px of content), so it spilled LEFT into "AGAINST" and the generic table's
// header read "AGAINST DIFFERENCE PTS" as one run. Dutch "PUNTENVERHOUDING"
// (125.4px) was twice its column.
//
// `apps/web` vitest has no layout, so the painted widths below were MEASURED
// in Chromium on the built app (Geist, 11px, uppercase, 0.55px tracking,
// weight 600), one word at a time, 2026-09-23. The assertion is independent of
// the component's own estimate: each column's content box (its `w-*` less its
// padding) must hold the widest word its header paints, and a header may wrap
// at a space but never inside a word. `e2e/standings-qualification.spec.ts`
// ("hub Table tab at …") measures the real paint at 1280, 768 and 320.
//
// Every header a shipped table can print is enumerated from the source of
// truth — `columnHeader` over the structural columns, `METRIC_HEADER_KEYS` and
// `NOTATION_HEADERS`, in all four locales — and every word it produces must be
// in the measured table, so new copy cannot arrive unmeasured.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { TableColumnT, TableViewT } from "@/server/public-site/competition-hub-schema";
import {
  columnHeader,
  METRIC_HEADER_KEYS,
  NOTATION_HEADERS,
  STRUCTURAL_KEYS,
} from "@/server/public-site/standings-view";
import { StandingsTableView } from "../standings-table-view";

/** Painted width (px) of each header word, measured in Chromium — see above. */
const MEASURED: Readonly<Record<string, number>> = {
  "Puntenverhouding": 125.4, "Bordverhouding": 111.4, "Overwinningen": 100, "Verhouding": 78.2,
  "Difference": 72.9, "Différence": 72.9, "Diferencia": 70.6, "Gewonnen": 69.2, "Buchholz": 64,
  "Victorias": 63.2, "Verloren": 63, "Victoires": 62.5, "tableros": 60.8, "perdidos": 60.2,
  "plateaux": 59.9, "Verschil": 58.7, "ganados": 58.6, "Against": 51.2, "contra": 49.1,
  "gagnés": 48.8, "Juegos": 48.5, "Contre": 48.2, "puntos": 48.1, "perdus": 47.5, "points": 43.2,
  "Games": 42.1, "games": 42.1, "Board": 41.1, "Tegen": 38.6, "favor": 38.4, "Ratio": 34.6,
  "ratio": 34.6, "Voor": 34, "Cut-1": 33.5, "Pour": 33.2, "Wins": 31.3, "Jeux": 30.7, "lost": 29.9,
  "Sets": 29.7, "sets": 29.7, "won": 28.8, "Diff": 26.1, "Emp": 25.4, "NRR": 24.9, "For": 24.3,
  "Ptn": 23.4, "Gel": 22.9, "Pts": 22.3,
  "GC": 17, "GA": 16.9, "GD": 16.9, "DG": 16.9, "GU": 16.8, "NR": 16.7, "BC": 16.6, "GS": 16.4,
  "DS": 16.3, "SB": 16.2, "DV": 16.2, "SR": 16.1, "En": 16, "BP": 16, "Ég": 15.9, "de": 15.8,
  "GF": 15.7, "DT": 14.9, "PJ": 14.3, "W": 11.5, "N": 8.8, "G": 8.5, "A": 8.4, "V": 8.4, "D": 8.3,
  "P": 7.9, "E": 7.3, "J": 7.3, "L": 7, "T": 7,
};

const LOCALES = { en, es, fr, nl } as unknown as Record<string, Dict>;

/** Every header a shipped table can print, per locale. */
function everyHeader(): { locale: string; key: string; abbr: string }[] {
  const out: { locale: string; key: string; abbr: string }[] = [];
  for (const [locale, dict] of Object.entries(LOCALES)) {
    const msg = (k: string) => t(dict, k);
    for (const key of STRUCTURAL_KEYS) out.push({ locale, key, abbr: columnHeader({ key, label: key }, msg).abbr });
    for (const [key, byLabel] of Object.entries(METRIC_HEADER_KEYS)) {
      for (const label of Object.keys(byLabel)) out.push({ locale, key, abbr: columnHeader({ key, label }, msg).abbr });
    }
    for (const [key, labels] of Object.entries(NOTATION_HEADERS)) {
      for (const label of labels) out.push({ locale, key, abbr: columnHeader({ key, label }, msg).abbr });
    }
  }
  return out;
}

const words = (abbr: string) => abbr.split(/\s+/).filter(Boolean);

const TESTID = "mh-table-h";
const FILLER: TableColumnT = { key: "zz_filler", abbr: "Z", title: "Z", compact: true };

function viewWith(columns: TableColumnT[], cells: string[]): TableViewT {
  return {
    id: "h",
    divisionId: "d1",
    divisionSlug: "div",
    divisionName: "Div",
    caption: "League",
    fullHref: "/shared/o/c/div?tab=standings",
    updatedAt: "2026-09-23T10:00:00Z",
    columns,
    rows: [
      {
        rank: 1,
        entrantId: "a",
        name: "Alpha",
        badgeUrl: null,
        colour: null,
        cells,
        tieBreakText: null,
        qual: null,
        champion: false,
      },
    ],
    qualification: null,
  };
}

const html = (v: TableViewT) =>
  renderToStaticMarkup(<StandingsTableView view={v} dict={en as unknown as Dict} testid={TESTID} />);

/** The header cell's width class and its content box: `w-N` is N × 4px, less
 *  `pl-0.5` and whichever end padding the cell carries at its widest. */
function headerBox(markup: string, key: string): { cls: string; content: number } {
  const th = markup.match(new RegExp(`<th[^>]*data-col="${key}"[^>]*class="([^"]*)"`));
  expect(th, `a header for ${key}`).not.toBeNull();
  const classes = th![1]!.split(/\s+/);
  const width = classes.find((c) => /^w-\d+$/.test(c));
  expect(width, `${key} carries a w-N class`).toBeDefined();
  const px = Number(width!.slice(2)) * 4;
  const endPad = classes.some((c) => c === "pr-2" || c === "md:pr-2" || c === "max-md:pr-2") ? 8 : 2;
  return { cls: width!, content: px - 2 - endPad };
}

describe("hub table: every header word fits its own column", () => {
  it("premise: the enumeration reaches every locale and the long words", () => {
    const all = everyHeader();
    expect(new Set(all.map((h) => h.locale))).toEqual(new Set(["en", "es", "fr", "nl"]));
    const seen = new Set(all.flatMap((h) => words(h.abbr)));
    for (const w of ["Difference", "Against", "Puntenverhouding", "Buchholz", "Victorias"]) expect(seen).toContain(w);
  });

  it("every word a header can print has a measured width (new copy cannot arrive unmeasured)", () => {
    const missing = [...new Set(everyHeader().flatMap((h) => words(h.abbr)))].filter((w) => !Object.hasOwn(MEASURED, w));
    expect(missing).toEqual([]);
  });

  it("each header's column holds its widest word — mid-row and at the end of the row, in all four locales", () => {
    const short: string[] = [];
    for (const h of everyHeader()) {
      const col: TableColumnT = { key: h.key, abbr: h.abbr, title: h.abbr, compact: true };
      const need = Math.max(...words(h.abbr).map((w) => MEASURED[w] ?? Number.POSITIVE_INFINITY));
      for (const [placement, markup] of [
        ["mid-row", html(viewWith([col, FILLER], ["1", "1"]))],
        ["last", html(viewWith([FILLER, col], ["1", "1"]))],
      ] as const) {
        const box = headerBox(markup, h.key);
        if (box.content < need) short.push(`${h.locale} ${h.key} "${h.abbr}" ${placement}: ${box.cls} holds ${box.content}px, needs ${need}px`);
      }
    }
    expect(short).toEqual([]);
  });

  it("the generic table (the one that read AGAINST DIFFERENCE PTS): Difference and Against widen, For and the letters do not", () => {
    const generic = html(
      viewWith(
        [
          { key: "played", abbr: "P", title: "Played", compact: true },
          { key: "won", abbr: "W", title: "Won", compact: true },
          { key: "lost", abbr: "L", title: "Lost", compact: true },
          { key: "for", abbr: "For", title: "For", compact: false },
          { key: "against", abbr: "Against", title: "Against", compact: false },
          { key: "diff", abbr: "Difference", title: "Difference", compact: false },
          { key: "points", abbr: "Pts", title: "Points", compact: true },
        ],
        ["3", "2", "1", "12", "7", "+5", "6"],
      ),
    );
    // Differential: a mutant that grows every column, or none, reds here.
    expect(headerBox(generic, "diff").cls).toBe("w-24");
    expect(headerBox(generic, "against").cls).toBe("w-18");
    expect(headerBox(generic, "for").cls).toBe("w-11");
    expect(headerBox(generic, "played").cls).toBe("w-8");
    expect(headerBox(generic, "points").cls).toBe("w-11");
  });

  it("the column at the END of the row books its 6px wider gutter too — the last column from md up, and the last shown one below md", () => {
    // Nine pixels a character is generous enough that no measured word needs
    // the gutter today (the sweep above stays green without it), so pin the
    // booking itself: the same word one bucket wider where it ends the row.
    const P: TableColumnT = { key: "played", abbr: "P", title: "Played", compact: true };
    const diff = (compact: boolean): TableColumnT => ({ key: "diff", abbr: "Difference", title: "Difference", compact });
    const pts: TableColumnT = { key: "points", abbr: "Pts", title: "Points", compact: true };
    const nrr: TableColumnT = { key: "nrr", abbr: "NRR", title: "NRR", compact: false };
    // Mid-row at every width.
    expect(headerBox(html(viewWith([P, diff(true), pts], ["1", "+5", "6"])), "diff").cls).toBe("w-24");
    // Last from md up only: a long-tail column after points.
    expect(headerBox(html(viewWith([P, pts, diff(false)], ["1", "6", "+5"])), "diff").cls).toBe("w-26");
    // Last below md only: the last COMPACT column, with a long tail after it.
    expect(headerBox(html(viewWith([P, diff(true), nrr], ["1", "+5", "+1.000"])), "diff").cls).toBe("w-26");
  });

  it("a header wraps at its spaces, so its column is sized by its LONGEST word, not its whole label", () => {
    // "Juegos ganados" is 14 characters; sized whole it would book ~130px.
    const markup = html(
      viewWith([{ key: "games_won", abbr: "Juegos ganados", title: "Juegos ganados", compact: true }, FILLER], ["12", "1"]),
    );
    expect(headerBox(markup, "games_won").cls).toBe("w-18");
  });

  it("the floors book the wider columns, so the name keeps its 96px from md up", () => {
    const markup = html(
      viewWith(
        [
          { key: "played", abbr: "P", title: "Played", compact: true },
          { key: "diff", abbr: "Difference", title: "Difference", compact: false },
          { key: "points", abbr: "Pts", title: "Points", compact: true },
        ],
        ["3", "+5", "6"],
      ),
    );
    // 48 rank + 96 name + P 32 + Pts 44 below md (Difference folds); + 96 from md.
    expect(markup).toContain('style="--sv-min:220px;--sv-min-md:316px"');
  });
});
