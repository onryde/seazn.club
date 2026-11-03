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
  buildTableView,
  columnHeader,
  METRIC_HEADER_KEYS,
  NOTATION_HEADERS,
  STRUCTURAL_KEYS,
} from "@/server/public-site/standings-view";
import { builtinModules } from "@seazn/engine/sports";
import { RATIO_LEDGERS, validateCascade, type StandingsRow } from "@seazn/engine/competition";
import { StandingsTableView } from "../standings-table-view";
import { defaultOrderOf } from "@seazn/engine/testkit";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";

/** Painted width (px) of each header word, measured in Chromium — see above. */
const MEASURED: Readonly<Record<string, number>> = {
  "Overwinningen": 100,
  "Difference": 72.9, "Différence": 72.9, "Diferencia": 70.6, "Gewonnen": 69.2, "Buchholz": 64,
  "Victorias": 63.2, "Verloren": 63, "Victoires": 62.5, "tableros": 60.8, "perdidos": 60.2,
  "plateaux": 59.9, "Verschil": 58.7, "ganados": 58.6, "Against": 51.2, "contra": 49.1,
  "gagnés": 48.8, "Juegos": 48.5, "Contre": 48.2, "puntos": 48.1, "perdus": 47.5, "points": 43.2,
  "Games": 42.1, "games": 42.1, "Board": 41.1, "Tegen": 38.6, "favor": 38.4, "Ratio": 34.6,
  "ratio": 34.6, "Voor": 34, "Cut-1": 33.5, "Pour": 33.2, "Wins": 31.3, "Jeux": 30.7, "lost": 29.9,
  "Sets": 29.7, "sets": 29.7, "won": 28.8, "Diff": 26.1, "Emp": 25.4, "NRR": 24.9, "For": 24.3,
  "Verh.": 34.9, "verh.": 34.9, "Bord": 33.6, "Ptn": 23.4, "Gel": 22.9, "Pts": 22.3,
  "GC": 17, "GA": 16.9, "GD": 16.9, "DG": 16.9, "GU": 16.8, "NR": 16.7, "BC": 16.6, "GS": 16.4,
  "DS": 16.3, "SB": 16.2, "DV": 16.2, "SR": 16.1, "En": 16, "BP": 16, "Ég": 15.9, "de": 15.8,
  "GF": 15.7, "DT": 14.9, "PJ": 14.3, "W": 11.5, "N": 8.8, "G": 8.5, "A": 8.4, "V": 8.4, "D": 8.3,
  "P": 7.9, "E": 7.3, "J": 7.3, "L": 7, "T": 7,
  // W2d T17 (ST-G29, IH-PT-1): the new columns' words, measured the same way on the built app, 2026-10-27 (the same
  // run re-read "Difference" 72.9, "Overwinningen" 100, "Pts" 22.3, "GD" 16.9 — the values above).
  "campo": 43.3, "champ": 43, "Veldd.": 41.6, "Saldo": 39.5, "saldo": 39.5, "Game": 34.3, "Diff.": 28.3, "OTW": 26.8,
  "diff": 26.1, "GPr": 24.3, "PPr": 23.4, "pts": 22.3, "OTL": 22.1, "Dif.": 21.3, "WV": 19.7, "VV": 16.6, "GV": 16.5,
  "DP": 16.3, "VP": 15.9, "FG": 15.7, "RJ": 15.5, "G.": 11.6, "B.": 11.2,
  // W3 T1 (X-SW-31, engine 2.0.0 `opp_diff`): the four new words of table.abbr.oppDiff ("Opp diff", "Dif. rivales",
  // "Diff. adv.", "Saldo tegenst."), measured the same way on the built app (live prod build of this tree, Geist 11px
  // uppercase, 0.05em tracking, weight 600, one word at a time, 2026-11-03). The same run re-read "Difference" 72.9,
  // "Against" 51.2, "Overwinningen" 100, "GD" 16.9, "Pts" 22.3, "diff" 26.1, "Dif." 21.3, "Diff." 28.3, "Saldo" 39.5 and
  // "Buchholz" 64 - the values above - so the method is the one that produced them. "diff", "Dif.", "Diff." and "Saldo"
  // were already in the table.
  "tegenst.": 54.9, "rivales": 48.7, "adv.": 26.5, "Opp": 24.5,
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
    fullHref: "/live/o/c/div?tab=standings",
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
    for (const w of ["Difference", "Against", "Overwinningen", "Buchholz", "Victorias", "verh."]) expect(seen).toContain(w);
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
    // Below md: 48 rank + 120 name (the 7.5rem phone floor, ruling (d)) + P 32
    // + Pts 44 = 244 (Difference folds). From md: 48 + 96 + 32 + 96 + 44 = 316.
    expect(markup).toContain('style="--sv-min:244px;--sv-min-md:316px"');
  });
});

// ── The md+ budget ────────────────────────────────────────────────────────
//
// Widening a column for its header costs the table width. From `md` up a full
// table folds nothing, so its `md:` floor (`--sv-min-md`) is every column at
// once — and a table whose floor exceeds its card scrolls sideways inside its
// region at 768/834 (review m2: Dutch carrom's three ratio columns needed
// 828px). The hub card at 768 is 768 − 2×16 gutter − 2×1 border = 734px wide,
// measured: `e2e/standings-qualification.spec.ts` logs the header row running
// from x 17 to x 751 at 768, and asserts the region does not scroll there.
const MD_CARD_PX = 768 - 2 * 16 - 2;

/** Every built-in sport's table at its WIDEST: its default cascade's columns,
 *  every displayed metric recorded, a draw so `D` shows, three-digit totals
 *  and a ratio in every derived cell. W2d T17: under the sport's own stage
 *  rules — so IIHF books OTW/OTL — and a draw only where those rules can
 *  produce a level result (`reachable`, the engine's own declaration): a
 *  tennis row never draws, so its table never shows `D`. */
function widestView(sport: (typeof builtinModules)[number], dict: Dict): TableViewT {
  // the sport's defaults, or (generic: no defaults parse) its first declared variant
  const cfg = sport.configSchema.safeParse({}).success ? {} : Object.values(sport.variants)[0];
  const rules = unpinnedRulesDoc({ module: sport, divisionConfig: cfg });
  const drawn = rules.reachable.some((k) => k === "draw" || k === "tie" || k === "noResult") ? 1 : 0;
  const ledgers = new Set<string>([...sport.metrics.map((m) => m.key), ...Object.values(RATIO_LEDGERS).flat()]);
  const metrics = Object.fromEntries([...ledgers].map((k) => [k, /lost|against/.test(k) ? 45 : 123]));
  const row = (id: string, rank: number): StandingsRow => ({
    entrantId: id,
    rank,
    played: 12,
    won: 10,
    drawn,
    lost: 1,
    points: 123,
    metrics: { ...metrics, balls_faced_eff: 600, balls_bowled_eff: 600, buchholz: 12.5, buchholz_cut1: 10.5, sberger: 45.25 },
  });
  return buildTableView({
    id: "t",
    division: { id: "d1", slug: "div", name: "Div" },
    caption: "League",
    // W2d T17: the sport's own stage rules, so a table that counts overtime apart (IIHF) books its OTW/OTL columns too
    rules,
    dateOf: () => null,
    fullHref: "/x",
    metricSpecs: sport.metrics,
    cascade: defaultOrderOf(sport),
    rows: [row("a", 1), row("b", 2)],
    entrantNames: { a: "Alpha", b: "Beta" },
    entrantLogos: {},
    entrantColours: {},
    championId: null,
    updatedAt: "2026-09-24T10:00:00Z",
    msg: (k, v) => t(dict, k, v),
  });
}

const mdFloor = (markup: string): number => {
  const m = markup.match(/--sv-min-md:(\d+)px/);
  expect(m, "the md floor").not.toBeNull();
  return Number(m![1]);
};

describe("hub table: from md up no sport's table in any locale is wider than its card", () => {
  it("premise: the sweep reaches every built-in sport and every locale, and draws their ratio columns", () => {
    expect(builtinModules.length).toBeGreaterThan(10);
    const carrom = builtinModules.find((m) => m.key === "carrom")!;
    const cols = widestView(carrom, nl as unknown as Dict).columns.map((c) => c.key);
    expect(cols).toEqual(expect.arrayContaining(["set_ratio", "board_ratio", "point_ratio"]));
    // W2d T17: ice hockey's widest table carries its OTW/OTL columns, tennis its game ratio (ST-G29)
    const ih = widestView(builtinModules.find((m) => m.key === "icehockey")!, nl as unknown as Dict).columns.map((c) => c.key);
    expect(ih).toEqual(expect.arrayContaining(["otw", "otl"]));
    const tennis = widestView(builtinModules.find((m) => m.key === "tennis")!, nl as unknown as Dict).columns.map((c) => c.key);
    expect(tennis).toEqual(expect.arrayContaining(["set_ratio", "game_ratio"]));
    // a draw where the rules can produce one: football's widest table shows D, tennis's does not
    expect(widestView(builtinModules.find((m) => m.key === "football")!, nl as unknown as Dict).columns.map((c) => c.key)).toContain("drawn");
    expect(tennis).not.toContain("drawn");
    let drawing = 0;
    for (const m of builtinModules) if (widestView(m, en as unknown as Dict).columns.some((c) => c.key === "drawn")) drawing++;
    expect(drawing, "anti-vacuity: the sports that can draw still sweep their D column").toBeGreaterThan(0);
  });

  it(`every locale × every built-in sport: the md floor fits the ${MD_CARD_PX}px card`, () => {
    const over: string[] = [];
    let widest = { px: 0, at: "" };
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const sport of builtinModules) {
        const markup = renderToStaticMarkup(
          <StandingsTableView view={widestView(sport, dict)} dict={dict} testid={TESTID} />,
        );
        const px = mdFloor(markup);
        if (px > widest.px) widest = { px, at: `${locale} ${sport.key}` };
        if (px > MD_CARD_PX) over.push(`${locale} ${sport.key}: ${px}px`);
      }
    }
    console.log(`WIDEST md floor: ${widest.px}px (${widest.at})`);
    expect(over.join("; ")).toBe("");
  });
});

// ── W3 T16 (SW-L11): the Swiss table's "Round X of N" chip ───────────────────
//
// The chip is the table heading's second line. The verdict arrives as DATA (`view.swissRound`); the sentence is filled
// from the org's dictionary. Every assertion on the markup anchors on `="` (AGENTS.md: React serialises an omitted prop
// as `"$undefined"`, so a bare `data-state` probe passes in both states). The strings are the copy decided for the four
// locales, typed here once - not read back from the component or the dictionary.
describe("hub table: a Swiss table's Round X of N chip (W3 T16, SW-L11)", () => {
  const CHIP = `data-testid="${TESTID}-swiss-round"`;
  const swiss = (swissRound: TableViewT["swissRound"]): TableViewT => ({
    ...viewWith([{ key: "played", abbr: "P", title: "Played", compact: true }], ["3"]),
    swissRound,
  });
  const markupIn = (v: TableViewT, locale: keyof typeof LOCALES, extra: { preview?: number } = {}) =>
    renderToStaticMarkup(<StandingsTableView view={v} dict={LOCALES[locale]!} testid={TESTID} {...extra} />);
  /** The chip element's opening tag and its text. */
  const chipOf = (markup: string) => {
    const open = markup.match(new RegExp(`<[a-z]+ ${CHIP}[^>]*>`));
    expect(open, "a chip is rendered").not.toBeNull();
    const tag = open![0];
    const text = markup.slice(open!.index! + tag.length).replace(/<[^>]*>/g, "\u0000").split("\u0000").filter((s) => s.trim() !== "")[0]!;
    return { tag, text };
  };

  const EXPECTED: Record<string, { paired: string; in_play: string; complete: string; final: string; finalOne: string }> = {
    en: { paired: "Round 2 of 5 · paired", in_play: "Round 2 of 5 · in play", complete: "Round 2 of 5 · complete", final: "Final standings after 3 rounds", finalOne: "Final standings after 1 round" },
    es: { paired: "Ronda 2 de 5 · emparejada", in_play: "Ronda 2 de 5 · en juego", complete: "Ronda 2 de 5 · terminada", final: "Clasificación final tras 3 rondas", finalOne: "Clasificación final tras 1 ronda" },
    fr: { paired: "Tour 2 sur 5 · apparié", in_play: "Tour 2 sur 5 · en cours", complete: "Tour 2 sur 5 · terminé", final: "Classement final après 3 tours", finalOne: "Classement final après 1 tour" },
    nl: { paired: "Ronde 2 van 5 · gekoppeld", in_play: "Ronde 2 van 5 · bezig", complete: "Ronde 2 van 5 · afgerond", final: "Eindstand na 3 rondes", finalOne: "Eindstand na 1 ronde" },
  };

  it("every state in every locale prints its sentence and names its state, anchored on =\"", () => {
    let checked = 0;
    for (const locale of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
      const want = EXPECTED[locale]!;
      const cases = [
        [{ round: 2, of: 5, state: "paired" }, want.paired],
        [{ round: 2, of: 5, state: "in_play" }, want.in_play],
        [{ round: 2, of: 5, state: "complete" }, want.complete],
        [{ round: 3, of: 3, state: "final" }, want.final],
        [{ round: 1, of: 1, state: "final" }, want.finalOne],
      ] as const;
      for (const [swissRound, text] of cases) {
        const { tag, text: got } = chipOf(markupIn(swiss(swissRound), locale));
        expect(got, `${locale} ${swissRound.state}`).toBe(text);
        expect(tag, `${locale} ${swissRound.state}`).toContain(`data-state="${swissRound.state}"`);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 5 chips").toBe(20);
  });

  it("the four states do not look alike: each carries its own look (the dot or tick says it before the words do)", () => {
    const looks = (["paired", "in_play", "complete", "final"] as const).map((state) => {
      const m = markupIn(swiss({ round: 2, of: 5, state }), "en");
      return chipOf(m).tag.match(/class="([^"]*)"/)![1]!;
    });
    expect(new Set(looks).size).toBe(4);
  });

  it("a league table has no chip: absent, null and the unmodified view are the SAME markup, with no chip testid anywhere", () => {
    const plain = markupIn(viewWith([{ key: "played", abbr: "P", title: "Played", compact: true }], ["3"]), "en");
    expect(plain).not.toContain("swiss-round");
    for (const none of [undefined, null]) {
      const m = markupIn(swiss(none), "en");
      expect(m).not.toContain("swiss-round");
      expect(m, "no extra DOM for a table without a chip").toBe(plain);
    }
  });

  it("a Swiss table renders its chip OUTSIDE the table's scroll region - a scrolled-away rail cannot hide the round", () => {
    const m = markupIn(swiss({ round: 2, of: 5, state: "in_play" }), "en");
    expect(m.indexOf(CHIP)).toBeGreaterThan(m.indexOf("<h3"));
    expect(m.indexOf(CHIP)).toBeLessThan(m.indexOf(`data-testid="${TESTID}-scroll"`));
  });

  it("the chip survives the Overview's preview, and a table with no rows still says what round it is", () => {
    expect(markupIn(swiss({ round: 2, of: 5, state: "paired" }), "en", { preview: 1 })).toContain(CHIP);
    const none = { ...swiss({ round: 1, of: 3, state: "paired" }), rows: [] };
    const m = markupIn(none, "en");
    expect(m).toContain(CHIP);
    expect(m).toContain(`data-testid="${TESTID}-empty"`);
  });

  it("with a chip the heading takes the row's remaining width (flex-1 basis-0), so a long stage name truncates beside Full division instead of pushing it onto its own line; without a chip the heading's class is the original string", () => {
    const h3Class = (markup: string) => markup.match(/<h3 class="([^"]*)"/)![1]!;
    const withChip = h3Class(markupIn({ ...swiss({ round: 2, of: 5, state: "in_play" }), caption: "Spring Championship Swiss Open" }, "en"));
    expect(withChip.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "truncate", "flex-1", "basis-0"]));
    expect(h3Class(markupIn(swiss(null), "en"))).toBe("min-w-0 truncate font-display text-lg font-semibold text-ink");
    // the link stays in the same row as the heading, ahead of the chip's own line (source order: heading, chip, link)
    const m = markupIn({ ...swiss({ round: 2, of: 5, state: "in_play" }), caption: "Spring Championship Swiss Open" }, "en");
    expect(m.indexOf(`data-testid="${TESTID}-full"`)).toBeGreaterThan(m.indexOf(CHIP));
    expect(m).toContain('class="order-last basis-full"');
  });

  it("the chip wraps instead of widening the page: a flexible, shrinkable box with no fixed width (the 320px rule)", () => {
    const { tag } = chipOf(markupIn(swiss({ round: 2, of: 5, state: "in_play" }), "en"));
    const classes = tag.match(/class="([^"]*)"/)![1]!.split(/\s+/);
    for (const c of ["max-w-full", "w-fit"]) expect(classes, c).toContain(c);
    expect(classes.some((c) => /^w-\d|^min-w-\[/.test(c)), "no fixed width").toBe(false);
  });
});

// ── W3 app-B T9 (ST-G21): the public table of a Swiss stage shows the ladders ─────────────────────────────────────────
//
// Premise 9 of the plan: the public table already picks its columns through `tableColumns` over the stage's cascade, so the
// engine's Swiss default chain brings Buchholz Cut-1 / Buchholz / Opp diff into it with no new code. What was owed is the PROOF
// (here), the `opp_diff` header (Task 3) and the phone fold. Every assertion on the markup anchors on `="` (AGENTS.md: React
// serialises an omitted prop as `"$undefined"`, so a bare `data-col` probe passes in both states). The expected columns are the
// engine's: the keys the stage's rules doc holds that the engine refuses outside a Swiss (`validateCascade`, `stage_format`).
describe("ST-G21 the public table of a Swiss stage shows its tie-break ladders", () => {
  const sportOf = (key: string) => builtinModules.find((m) => m.key === key)!;
  const cfgOf = (m: (typeof builtinModules)[number]) => (m.configSchema.safeParse({}).success ? {} : Object.values(m.variants)[0]);

  function viewFor(m: (typeof builtinModules)[number], kind: "swiss" | "league", dict: Dict = en as unknown as Dict): TableViewT {
    const rules = unpinnedRulesDoc({ module: m, kind, divisionConfig: cfgOf(m) });
    const ledger = new Set<string>([...m.metrics.map((x) => x.key), ...Object.values(RATIO_LEDGERS).flat()]);
    const row = (id: string, rank: number): StandingsRow => ({
      entrantId: id,
      rank,
      played: 3,
      won: 2,
      drawn: 0,
      lost: 1,
      points: 6,
      metrics: { ...Object.fromEntries([...ledger].map((k) => [k, 5])), buchholz: 7.5, buchholz_cut1: 6, opp_diff: -3, sberger: 4.25 },
    });
    return buildTableView({
      id: "t",
      division: { id: "d1", slug: "div", name: "Div" },
      caption: kind === "swiss" ? "Swiss" : "League",
      fullHref: "/x",
      rows: [row("a", 1), row("b", 2)],
      metricSpecs: m.metrics,
      cascade: rules.tiebreakers,
      entrantNames: { a: "Alpha", b: "Beta" },
      entrantLogos: {},
      entrantColours: {},
      championId: null,
      updatedAt: "2026-11-03T10:00:00Z",
      msg: (k, v) => t(dict, k, v),
      rules,
      dateOf: () => null,
      stageKind: kind,
    });
  }
  /** A header cell's visible abbreviation and class list, found by its `data-col="…"`. */
  function headerOf(markup: string, key: string): { abbr: string; cls: string } | null {
    const m = markup.match(new RegExp(`<th[^>]*data-col="${key}"[^>]*class="([^"]*)"[^>]*>(?:(?!</th>).)*?<span aria-hidden="true">([^<]*)</span>`));
    return m === null ? null : { abbr: m[2]!, cls: m[1]! };
  }
  const draw = (v: TableViewT) => renderToStaticMarkup(<StandingsTableView view={v} dict={en as unknown as Dict} testid={TESTID} />);

  it("ST-G21 the public table of a Swiss stage under the default chain renders Buchholz Cut-1 and Buchholz headers", () => {
    const badminton = sportOf("badminton");
    const markup = draw(viewFor(badminton, "swiss"));
    expect(headerOf(markup, "buchholz_cut1")?.abbr).toBe("Buchholz Cut-1");
    expect(headerOf(markup, "buchholz")?.abbr).toBe("Buchholz");
    // the football family's second ladder, Opp diff (Task 3's header), beside its Buchholz
    const football = draw(viewFor(sportOf("football"), "swiss"));
    expect(headerOf(football, "buchholz")?.abbr).toBe("Buchholz");
    expect(headerOf(football, "opp_diff")?.abbr).toBe("Opp diff");
  });

  it("ST-G21 a league table renders neither", () => {
    for (const key of ["badminton", "football", "boardgame"]) {
      const markup = draw(viewFor(sportOf(key), "league"));
      expect(markup, `${key}: a league table still renders (the pair of the Swiss case above)`).toContain('data-col="points"');
      for (const col of ["buchholz_cut1", "buchholz", "opp_diff"]) expect(headerOf(markup, col), `${key} ${col}`).toBeNull();
    }
  });

  it("every sport's Swiss table carries the engine's Swiss-only keys of its default chain, and a league table of the same sport none (registry sweep, counted)", () => {
    let swiss = 0;
    let columns = 0;
    for (const m of builtinModules) {
      const rules = unpinnedRulesDoc({ module: m, kind: "swiss", divisionConfig: cfgOf(m) });
      const refused = validateCascade(rules.tiebreakers as never, { module: m, cfg: m.configSchema.parse(cfgOf(m)), stageKind: "league", crossGroup: false })
        .filter((r) => r.reason === "stage_format")
        .map((r) => String(r.key));
      const shown = viewFor(m, "swiss").columns.map((c) => c.key);
      expect(refused.length, `${m.key}: premise - the default Swiss chain holds Swiss-only keys`).toBeGreaterThan(0);
      for (const key of refused) expect(shown, `${m.key} ${key}`).toContain(key);
      for (const key of refused) expect(viewFor(m, "league").columns.map((c) => c.key), `${m.key} league ${key}`).not.toContain(key);
      swiss++;
      columns += refused.length;
    }
    expect(swiss, "sports swept").toBe(builtinModules.length);
    expect(builtinModules.length).toBe(11);
    expect(columns, "Swiss-only columns met").toBeGreaterThanOrEqual(22);
  });

  it("the phone fold: on a phone the ladders sit behind the table's own disclosure (max-md:hidden) while Pts stays; from md up nothing folds", () => {
    for (const key of ["badminton", "football", "boardgame"]) {
      const view = viewFor(sportOf(key), "swiss");
      const ladders = view.columns.filter((c) => ["buchholz_cut1", "buchholz", "opp_diff"].includes(c.key));
      expect(ladders.length, `${key}: ladders on the table`).toBeGreaterThan(0);
      for (const c of ladders) expect(c.compact, `${key} ${c.key} is long tail`).toBe(false);
      const markup = draw(view);
      for (const c of ladders) expect(headerOf(markup, c.key)!.cls, `${key} ${c.key}`).toMatch(/(^|\s)max-md:hidden(\s|$)/);
      expect(headerOf(markup, "points")!.cls, `${key}: Pts is never folded`).not.toMatch(/max-md:hidden/);
      expect(markup, `${key}: the disclosure exists`).toMatch(/data-testid="[^"]*-more"/);
    }
  });

  // T9 review m4 / fix round 1 (b): with the engine's Swiss chains carrom and tennis hold both ladders, and their Swiss tables'
  // `md` floor (`--sv-min-md`) is wider than the 734px card the hub gives a 768px page (measured on the built app: the card is
  // 734 at 768). Their leagues fit. The overflow is REACHABLE, which AGENTS.md #23 makes a feature: the card is the scrolling element
  // (`overflow-x-auto`) and carries a `tabindex`, a role and an accessible name, unconditionally. The page itself must not scroll
  // (the browser check is the 768 shot); here the markup is held to the rail contract for EVERY sport's Swiss table, wide or not,
  // and the sweep reports how many of each it met.
  const MD_CARD_PX = 734;
  it("every sport's Swiss table, whether or not its md floor fits the 734px card, scrolls inside ONE reachable rail: overflow-x-auto + role + tabindex 0 + a name (counted)", () => {
    const wide: string[] = [];
    const fits: string[] = [];
    for (const m of builtinModules) {
      const view = viewFor(m, "swiss");
      const markup = draw(view);
      const floor = Number(markup.match(/--sv-min-md:(\d+(?:\.\d+)?)px/)?.[1]);
      expect(Number.isFinite(floor), `${m.key}: the md floor is declared on the table`).toBe(true);
      (floor > MD_CARD_PX ? wide : fits).push(`${m.key} ${floor}px`);
      const region = markup.match(new RegExp(`<div[^>]*data-testid="${TESTID}-scroll"[^>]*>`))?.[0];
      expect(region, `${m.key}: the scrolling region`).toBeDefined();
      expect(region!, `${m.key}: the card is the scrolling element`).toMatch(/class="[^"]*(^|\s)overflow-x-auto(\s|")/);
      expect(region!, `${m.key}: a role`).toMatch(/role="region"/);
      expect(region!, `${m.key}: tabindex 0, unconditionally`).toMatch(/tabindex="0"/);
      expect(region!, `${m.key}: an accessible name (the division and the stage)`).toMatch(/aria-label="Div — Swiss"/);
      // one rail only: a second scroller inside it would be a scroll trap
      expect((markup.match(/overflow-x-auto/g) ?? []).length, `${m.key}: exactly one horizontal scroller`).toBe(1);
    }
    expect(fits.length + wide.length, "sports swept").toBe(builtinModules.length);
    expect(builtinModules.length).toBe(11);
    // anti-vacuity: the sweep met BOTH answers, so "the rail is there" was asked of a table that needs it and of one that does not
    expect(wide.length, `Swiss tables wider than the ${MD_CARD_PX}px card: ${wide.join(", ")}`).toBeGreaterThan(0);
    expect(fits.length, `Swiss tables that fit: ${fits.join(", ")}`).toBeGreaterThan(0);
  });
});
