// The division page's standings table and suspensions strip speak the page's
// dictionary (Task 16 review, I1). Both components printed English literals —
// "Team", "P W D L Pts", "GF GA GD", "Level with … — separated on goal/run
// difference", "Suspensions", "2 to serve" — on every division page, every
// embed and the organiser console, in every locale.
//
// Spanish is the witness throughout: its values differ from English for every
// word asserted (each premise is checked, not assumed), and its "P" is the
// LOST column's letter, so a header that fell back to the engine's English
// letters would put "P" over the played count.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { StandingsRow } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import { StandingsTable } from "../standings-table";
import { SuspensionsStrip } from "../suspensions-strip";

const row = (entrantId: string, over: Partial<StandingsRow>): StandingsRow => ({
  entrantId,
  played: 2,
  won: 1,
  drawn: 1,
  lost: 0,
  points: 4,
  metrics: { gf: 3, ga: 1, gd: 2 },
  ...over,
});

const GOALS = [
  { key: "gf", label: "GF" },
  { key: "ga", label: "GA" },
  { key: "gd", label: "GD" },
];

function table(dict: Record<string, string>) {
  return renderToStaticMarkup(
    createElement(StandingsTable, {
      rows: [row("a", { rank: 1, tieBreak: { key: "diff", with: ["b"] } }), row("b", { rank: 2 })],
      metricSpecs: GOALS,
      cascade: ["points", "gd"],
      entrantNames: { a: "Alpha", b: "Beta" },
      dict,
    }),
  );
}

/** The `<th scope="col">` cells of the header, as [title, visible letters]. */
const headers = (html: string) =>
  [...html.matchAll(/<th scope="col" title="([^"]*)"[^>]*><span class="sr-only">([^<]*)<\/span><span aria-hidden="true">([^<]*)<\/span><\/th>/g)].map(
    (m) => {
      expect(m[2], "the sr-only word is the title").toBe(m[1]);
      return [m[1], m[3]];
    },
  );

describe("StandingsTable — every header word is the page dictionary's", () => {
  it("premise: every Spanish word asserted below differs from its English one", () => {
    for (const k of ["table.team", "table.abbr.played", "table.abbr.won", "table.abbr.drawn", "table.col.played", "table.abbr.ga", "table.abbr.gd", "table.col.gf", "table.tieBreak", "table.tieBreak.diff"] as const) {
      expect(es[k], k).not.toBe(en[k]);
    }
  });

  it("structural and goal columns print the locale's letters, each titled with its word", () => {
    const html = table(es);
    const keys = ["played", "won", "drawn", "lost", "gf", "ga", "gd", "points"];
    expect(headers(html)).toEqual(
      keys.map((k) => [es[`table.col.${k}` as keyof typeof es], es[`table.abbr.${k}` as keyof typeof es]]),
    );
    expect(html).toContain(`>${es["table.team"]}</th>`);
  });

  it("English renders the English letters from the same keys (positive pair)", () => {
    expect(headers(table(en)).map(([, abbr]) => abbr)).toEqual(["P", "W", "D", "L", "GF", "GA", "GD", "Pts"]);
  });

  it("the tie note is the dictionary's sentence with the dictionary's rule name", () => {
    const html = table(es);
    const sentence = es["table.tieBreak"].replace("{with}", "Beta").replace("{rule}", es["table.tieBreak.diff"]);
    expect(html).toContain(`>${sentence}</span>`);
    expect(html).not.toContain("Level with");
    expect(html).not.toContain(en["table.tieBreak.diff"]);
  });
});

describe("StandingsTable — the scroll box is a named, focusable region (final review B m3)", () => {
  // The table is wider than a phone at 320 and this box is what scrolls it. A
  // keyboard user reaches it only through `tabindex`, and axe's
  // `scrollable-region-focusable` asks the same. The hub's table
  // (`standings-table-view.tsx`) and the match centre's scorecard and sets
  // regions already carry all three.
  const scrollBox = (html: string) => {
    const tag = /<div ([^>]*class="[^"]*overflow-x-auto[^"]*"[^>]*)>/.exec(html);
    expect(tag, "the overflow-x-auto box").not.toBeNull();
    return tag![1]!;
  };
  const render = (dict: Record<string, string>, caption?: string) =>
    renderToStaticMarkup(
      createElement(StandingsTable, {
        rows: [row("a", { rank: 1 }), row("b", { rank: 2 })],
        metricSpecs: GOALS,
        cascade: ["points"],
        entrantNames: { a: "Alpha", b: "Beta" },
        ...(caption === undefined ? {} : { caption }),
        dict,
      }),
    );

  it("premise: the Spanish name differs from the English one", () => {
    expect(es["table.region"]).not.toBe(en["table.region"]);
    expect(es["table.regionCaptioned"]).not.toBe(en["table.regionCaptioned"]);
  });

  it("es with a caption: tabindex 0, role region, named by the dictionary around the caption", () => {
    const box = scrollBox(render(es, "Liga — Grupo A"));
    expect(box).toContain('tabindex="0"');
    expect(box).toContain('role="region"');
    expect(box).toContain(`aria-label="${es["table.regionCaptioned"].replace("{caption}", "Liga — Grupo A")}"`);
  });

  it("no caption: still focusable, and named by the dictionary's word alone", () => {
    const box = scrollBox(render(es));
    expect(box).toContain('tabindex="0"');
    expect(box).toContain('role="region"');
    expect(box).toContain(`aria-label="${es["table.region"]}"`);
  });
});

describe("StandingsTable — every OTHER sport's metric headers are the page dictionary's too (fix round 2)", () => {
  // The REAL module declarations, so the label the table is handed is the one a
  // badminton or cricket division actually hands it.
  const specsOf = (key: string) => builtinModules.find((m) => m.key === key)!.metrics;
  const render = (sport: string, metrics: Record<string, number>, cascade: string[]) =>
    renderToStaticMarkup(
      createElement(StandingsTable, {
        rows: [row("a", { rank: 1, metrics }), row("b", { rank: 2, metrics })],
        metricSpecs: specsOf(sport),
        cascade,
        entrantNames: { a: "Alpha", b: "Beta" },
        dict: es,
      }),
    );

  it("badminton: 'Games won' / 'Games lost' and the ratio column print Spanish, never the engine's English", () => {
    const html = render("badminton", { sets_won: 4, sets_lost: 1 }, ["points", "set_ratio"]);
    const words = headers(html).map(([title]) => title);
    expect(words).toEqual(expect.arrayContaining([es["table.col.gamesWon"], es["table.col.gamesLost"], es["table.col.ratio"]]));
    for (const english of ["Games won", "Games lost", "Sets won"]) expect(html, english).not.toContain(english);
  });

  it("volleyball's same metric key reads as SETS, not games — the label decides the word", () => {
    const words = headers(render("volleyball", { sets_won: 3, sets_lost: 0 }, ["points"])).map(([title]) => title);
    expect(words).toEqual(expect.arrayContaining([es["table.col.setsWon"], es["table.col.setsLost"]]));
    expect(words).not.toContain(es["table.col.gamesWon"]);
  });

  it("cricket: ties and no-results get Spanish letters and words; NRR stays notation", () => {
    const html = render("cricket", { ties: 1, no_results: 1, runs_for: 120, balls_faced_eff: 120, runs_against: 100, balls_bowled_eff: 120 }, ["points", "nrr"]);
    const pairs = headers(html);
    expect(pairs).toEqual(
      expect.arrayContaining([
        [es["table.col.ties"], es["table.abbr.ties"]],
        [es["table.col.noResults"], es["table.abbr.noResults"]],
        ["NRR", "NRR"],
      ]),
    );
    expect(es["table.abbr.ties"]).not.toBe(en["table.abbr.ties"]);
  });
});

describe("SuspensionsStrip — heading and count in the page's language, plural chosen by its locale", () => {
  it("es: the heading and both plural forms", () => {
    expect(es["info.suspensions"]).not.toBe(en["info.suspensions"]);
    const html = renderToStaticMarkup(
      createElement(SuspensionsStrip, {
        suspensions: [
          { name: "Ana", remaining: 1 },
          { name: "Luis", remaining: 3 },
        ],
        dict: es,
        locale: "es",
      }),
    );
    expect(html).toContain(`>${es["info.suspensions"]}</h3>`);
    expect(html).toContain(`>${es["info.toServe.one"].replace("{count}", "1")}</span>`);
    expect(html).toContain(`>${es["info.toServe.other"].replace("{count}", "3")}</span>`);
    expect(html).not.toContain("to serve");
  });
});
