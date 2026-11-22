// W5 app PR B Task 4 (X-UP-3; R24 pick 16 B, preflight C3): the unequal-pool basis renders ONLY under the Standings pool tables
// (`BestNthBasisNote`, the division pages), never as a progression-panel line - the brief's panel test became this Standings
// render test (C3). Copy is each locale's public.json, read here, never typed; the basis is an engine `ComparisonBasis`.
// No DOM (vitest environment node): renderToStaticMarkup, as the repo's other island tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComparisonBasis } from "@seazn/engine/competition";
import { bestNthBasisNote, comparedMatches, ordinalText, stageBasisNotes } from "@/lib/bestnth-basis-note";
import { BestNthBasisNote } from "@/components/public-site/bestnth-basis-note";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const dictOf = (locale: string) => JSON.parse(readFileSync(new URL(`../../../dictionaries/${locale}/public.json`, import.meta.url), "utf8")) as Record<string, string>;
const tOf = (locale: string) => {
  const dict = dictOf(locale);
  return (key: string, vars?: Record<string, string | number>) => {
    const s = dict[key];
    if (s === undefined) throw new Error(`${locale}: no ${key}`);
    return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`)) : s;
  };
};

// The R24 pick 16 B case: pools of 5, 5 and 4; best runners-up compared on 3 matches, each 5-pool's 5th left out.
const rows = (ids: string[]) => ids.map((entrantId, i) => ({ entrantId, rank: i + 1 }));
const POOLS = [
  { key: "A", rows: rows(["a1", "marsh", "a3", "a4", "dunmore"]) },
  { key: "B", rows: rows(["b1", "quay", "b3", "b4", "sandbar"]) },
  { key: "C", rows: rows(["c1", "millbrook", "c3", "c4"]) },
];
const NAMES = { marsh: "Marsh Lane", dunmore: "Dunmore Park", quay: "Quay Street", sandbar: "Sandbar Juniors", millbrook: "Millbrook" };
// The engine lists `dropped` in its comparison's order (B before A here), never the reader's: the footnote reads A, B.
const BASIS: ComparisonBasis = { nth: 2, matchesCounted: 3, dropped: [{ pool: "B", against: ["sandbar"] }, { pool: "A", against: ["dunmore"] }], levelWith: [] };

describe("X-UP-3 the source table shows the basis (Standings, R24 pick 16 B)", () => {
  it("the line and every result left out, as the owner approved them", () => {
    const note = bestNthBasisNote(BASIS, POOLS, NAMES, new Set(), tOf("en"), "en");
    expect(note).toEqual({
      line: "Best runners-up compared on 3 matches (results v 5th in Group A and Group B not counted)",
      leftOutTitle: "Results left out",
      leftOut: ["Marsh Lane v Dunmore Park (5th in Group A)", "Quay Street v Sandbar Juniors (5th in Group B)", "Millbrook: nothing left out, Group C is the smallest group"],
    });
    const html = renderToStaticMarkup(<BestNthBasisNote note={note} />);
    expect(html).toContain('data-testid="standings-bestnth-basis"');
    expect(html).toContain(">Best runners-up compared on 3 matches (results v 5th in Group A and Group B not counted)</p>");
    // The left-out results sit behind a disclosure with the 44px tap floor.
    expect(html).toMatch(/<summary class="[^"]*\bmin-h-11\b[^"]*">Results left out<\/summary>/);
    expect((html.match(/<li /g) ?? []).length, "one item per left-out line").toBe(3);
    // C4: the number is what the comparison counted, never "matches played".
    expect(html).not.toMatch(/played/i);
  });

  it("equal pools show no source footnote (the empty case: nothing dropped -> nothing rendered)", () => {
    const equal: ComparisonBasis = { nth: 2, matchesCounted: 4, dropped: [], levelWith: [] };
    expect(bestNthBasisNote(equal, POOLS.slice(0, 2), NAMES, new Set(), tOf("en"), "en")).toBeNull();
    expect(renderToStaticMarkup(<BestNthBasisNote note={null} />)).toBe("");
    // No stored basis at all (an on_complete seed, no proposal yet): none.
    expect(stageBasisNotes("s1", undefined, POOLS, NAMES, [], tOf("en"), "en")).toEqual([]);
  });

  it("several dropped places read in place order, a short pool (RB5-U7) supplies no line, an expunged leaver holds no place", () => {
    // Pools of 6 (one expunged), 6 and 4 and a pool of 1: effective 5/6/4. A drops its 5th; B its 5th and 6th. D has no 2nd.
    const pools = [
      { key: "A", rows: rows(["a1", "a2", "gone", "a4", "a5", "a6"]) },
      { key: "B", rows: rows(["b1", "b2", "b3", "b4", "b5", "b6"]) },
      { key: "C", rows: rows(["c1", "c2", "c3", "c4"]) },
      { key: "D", rows: rows(["d1"]) },
    ];
    const basis: ComparisonBasis = { nth: 2, matchesCounted: 3, dropped: [{ pool: "A", against: ["a6"] }, { pool: "B", against: ["b5", "b6"] }], levelWith: [] };
    const withdrawals = [{ stage_id: "s1", entrant_id: "gone", policy: "expunge" }, { stage_id: "other", entrant_id: "a2", policy: "expunge" }];
    const [note, ...more] = stageBasisNotes("s1", { bases: [basis], openings: new Map() }, pools, {}, withdrawals, tOf("en"), "en");
    expect(more).toHaveLength(0);
    expect(note!.line).toBe("Best runners-up compared on 3 matches (results v 5th in Group A and Group B and 6th in Group B not counted)");
    expect(note!.leftOut).toEqual(["a2 v a6 (5th in Group A)", "b2 v b5 (5th in Group B)", "b2 v b6 (6th in Group B)", "c2: nothing left out, Group C is the smallest group"]);
  });

  it("C4 n is the matches compared IN the stage: a carried opening's played is never counted, and the line says so", () => {
    // Pools of 4 and 3 on a tier fed with carry "full": each row opens with its first-tier played (4 or 3). Every candidate is
    // compared on (3 - 1) = 2 tier-2 matches (RB5-U1); the engine's matchesCounted (largest compared `played`) reads 2 + 4.
    const played = (ids: string[], p: number[]) => ids.map((entrantId, i) => ({ entrantId, rank: i + 1, played: p[i]! }));
    const pools = [{ key: "A", rows: played(["a1", "a2", "a3", "a4"], [7, 7, 7, 7]) }, { key: "B", rows: played(["b1", "b2", "b3"], [6, 6, 5]) }];
    const openings = new Map([["a1", 4], ["a2", 4], ["a3", 4], ["a4", 4], ["b1", 4], ["b2", 4], ["b3", 3]]);
    const basis: ComparisonBasis = { nth: 2, matchesCounted: 6, dropped: [{ pool: "A", against: ["a4"] }], levelWith: [] };
    expect(comparedMatches(basis, pools, new Set(), openings), "B (k = 0): b2 played 6, 4 of them carried").toBe(2);
    const [note] = stageBasisNotes("s1", { bases: [basis], openings }, pools, {}, [], tOf("en"), "en");
    expect(note!.line).toBe("Best runners-up compared on 2 matches (results v 4th in Group A not counted)");
    // differential: without the openings the stage's own played (6) is read - the engine's count, first-tier matches included.
    expect(comparedMatches(basis, pools, new Set(), new Map())).toBe(6);
    // no opening: the k = 0 candidate's played IS the engine's count (the X-UP-1 case)
    expect(comparedMatches({ ...basis, matchesCounted: 2 }, [{ key: "A", rows: played(["a1", "a2", "a3", "a4"], [3, 3, 3, 3]) }, { key: "B", rows: played(["b1", "b2", "b3"], [2, 2, 2]) }], new Set(), new Map())).toBe(2);
  });

  it("C4 falls back to the engine's count only when no candidate row carries a played (a caller that passed none)", () => {
    expect(comparedMatches(BASIS, POOLS, new Set(), new Map([["millbrook", 9]])), "the R24 rows carry no played").toBe(BASIS.matchesCounted);
    // every supplying pool left something out (no k = 0 pool - the engine never answers this, RB5-U7's minimum always drops nothing)
    const all: ComparisonBasis = { ...BASIS, dropped: [...BASIS.dropped, { pool: "C", against: ["c4"] }] };
    const withPlayed = POOLS.map((p) => ({ ...p, rows: p.rows.map((r) => ({ ...r, played: 99 })) }));
    expect(comparedMatches(all, withPlayed, new Set(), new Map())).toBe(BASIS.matchesCounted);
  });

  it("a left-out entrant the pool has no row for is refused by name, never printed as a guess", () => {
    const stray: ComparisonBasis = { nth: 2, matchesCounted: 3, dropped: [{ pool: "A", against: ["nobody"] }], levelWith: [] };
    expect(() => bestNthBasisNote(stray, POOLS, NAMES, new Set(), tOf("en"), "en")).toThrow(/nobody.*pool A/);
  });

  it("every locale renders the footnote from its own copy, ordinals by its own rules (no key left raw)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const t = tOf(locale);
      for (const nth of [1, 2, 3]) {
        for (const n of [1, 3]) {
          const note = bestNthBasisNote({ ...BASIS, nth, matchesCounted: n }, POOLS, NAMES, new Set(), t, locale);
          const text = [note!.line, note!.leftOutTitle, ...note!.leftOut].join("\n");
          expect(text, `${locale} nth ${nth} n ${n}`).not.toMatch(/table\.|\{\w+\}/);
          expect(note!.line, `${locale}: the count is in the line`).toContain(String(n));
          checked++;
        }
      }
      expect(ordinalText(5, locale, t), `${locale} 5th`).toBe({ en: "5th", es: "5.º", fr: "5e", nl: "5e" }[locale]);
    }
    expect(ordinalText(1, "en", tOf("en"))).toBe("1st");
    expect(ordinalText(22, "en", tOf("en"))).toBe("22nd");
    expect(ordinalText(13, "en", tOf("en"))).toBe("13th");
    expect(ordinalText(1, "fr", tOf("fr"))).toBe("1er");
    expect(checked, "anti-vacuity: 4 locales x 3 places x 2 counts").toBe(24);
  });
});
