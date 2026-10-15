// W2c Task 16 (X-PT-1, D12) - `pointsLine`: the ONE sentence for a stage's own points rule on the public stage line (a
// later task's editor preview is meant to call it too, so the two cannot word one rule two ways). Clauses, like every
// format line: dictionary keys plus params, resolved against whichever dictionary the surface holds (`rulesLineText`).
//
// Every number is handed in by the test and read back out of the resolved text; the right answers differ from the
// wrong ones' constants (a walkover row of 2 beside a base win of 3; two bonuses, not one).
import { describe, expect, it } from "vitest";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import { rulesLineText } from "@/lib/rules-line";
import { pointsLine } from "../points-line";

type Rule = Parameters<typeof pointsLine>[0];

const BASE = { win: 3, draw: 1, loss: 0 } as const;
const bonus = (when: string, param: number | undefined, points: number) => ({ when, ...(param === undefined ? {} : { param }), points });
const DICTS = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic } as const;
/** The dash between a walkover's two point figures is NON-BREAKING (U+2011): a line that wraps at 320 must never split
 *  "1-0" over two lines. Built from its code point so the test cannot be mistaken for a plain hyphen. */
const NB = String.fromCharCode(0x2011);

describe("X-PT-1 the stage points sentence", () => {
  it("base only", () => {
    expect(rulesLineText(enPublic as never, pointsLine({ base: BASE, bonuses: [] }))).toBe("Win 3, draw 1, loss 0");
  });

  it("a forfeit row is its own clause, with its own numbers (2 is not the base win's 3)", () => {
    const text = rulesLineText(enPublic as never, pointsLine({ base: BASE, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } }));
    expect(text).toBe(`Win 3, draw 1, loss 0, walkover pays 2${NB}0 points`);
  });

  it("a forfeit's awarded SCORE is NOT said (X-WO-1 B is Task 16b): the headline still reads the division's award, so a 7-0 here would contradict it; the points clauses stay", () => {
    const rule: Rule = { base: BASE, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [7, 0] } };
    const line = pointsLine(rule);
    expect(line.map((c) => c.key), "base and walkover points are still said").toEqual(["format.points.base", "format.points.forfeit"]);
    const text = rulesLineText(enPublic as never, line);
    expect(text).toBe(`Win 3, draw 1, loss 0, walkover pays 2${NB}0 points`);
    expect(text).not.toMatch(/scored/i);
    expect(text, "7 is the award score; it appears nowhere").not.toMatch(/\b7\b/);
    // The award changes nothing about the sentence: the same rule without it reads identically.
    expect(pointsLine({ ...rule, forfeit: { winnerPoints: 2, loserPoints: 0 } })).toEqual(line);
  });

  it("the walkover's two figures are joined by a non-breaking dash in every locale, so no width can split them", () => {
    const line = pointsLine({ base: BASE, bonuses: [], forfeit: { winnerPoints: 1, loserPoints: 0 } });
    let checked = 0;
    for (const [locale, dict] of Object.entries(DICTS)) {
      const text = rulesLineText(dict as never, line);
      expect(text, locale).toContain(`1${NB}0`);
      expect(text, locale).not.toMatch(/1[-\u2010\u2012-\u2015]0/);
      checked++;
    }
    expect(checked).toBe(Object.keys(DICTS).length);
  });

  it("bonuses are counted, not listed (one clause)", () => {
    const line = pointsLine({ base: { win: 4, draw: 2, loss: 0 }, bonuses: [bonus("loss_margin_lte", 7, 1), bonus("win_margin_gte", 4, 1)] } as never);
    expect(line.at(-1)).toEqual({ key: "format.points.bonuses", params: { n: 2 } });
    expect(rulesLineText(enPublic as never, line)).toBe("Win 4, draw 2, loss 0, 2 bonus rules");
  });

  it("ONE bonus reads in the singular, and no bonus says nothing about bonuses (the empty case)", () => {
    const one = pointsLine({ base: BASE, bonuses: [bonus("draw", undefined, 1)] } as never);
    expect(one.at(-1)).toEqual({ key: "format.points.bonus" });
    expect(rulesLineText(enPublic as never, one)).toBe("Win 3, draw 1, loss 0, 1 bonus rule");
    const none = pointsLine({ base: BASE, bonuses: [] });
    expect(none.map((c) => c.key)).toEqual(["format.points.base"]);
  });

  it("fractional and negative points are legal and print as they are (Jul3/09)", () => {
    const text = rulesLineText(enPublic as never, pointsLine({ base: { win: 2.5, draw: 1.25, loss: -1 }, bonuses: [], forfeit: { winnerPoints: 1.5, loserPoints: 0.5 } }));
    expect(text).toBe(`Win 2.5, draw 1.25, loss -1, walkover pays 1.5${NB}0.5 points`);
  });

  it("a rule the view rebuilt with a missing or non-numeric part says nothing about that part (never a confident 0)", () => {
    // `public_stages_v` rebuilds the rule from only the keys PointsRule reads; a malformed stored rule can reach it.
    expect(pointsLine({} as never)).toEqual([]);
    expect(pointsLine({ base: { win: "3", draw: 1, loss: 0 }, bonuses: [] } as never)).toEqual([]);
    expect(pointsLine({ base: BASE, bonuses: [], forfeit: { winnerPoints: 2 } } as never).map((c) => c.key)).toEqual(["format.points.base"]);
    expect(pointsLine({ base: BASE, bonuses: "x" } as never).map((c) => c.key)).toEqual(["format.points.base"]);
    expect(pointsLine({ base: BASE, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [5] } } as never).map((c) => c.key))
      .toEqual(["format.points.base", "format.points.forfeit"]);
  });

  it("a number that is not finite (NaN, Infinity, the JSON null of a lost value) is no number - never printed as one", () => {
    expect(pointsLine({ base: { win: Number.NaN, draw: 1, loss: 0 }, bonuses: [] })).toEqual([]);
    expect(pointsLine({ base: { win: 3, draw: Number.POSITIVE_INFINITY, loss: 0 }, bonuses: [] })).toEqual([]);
    expect(pointsLine({ base: { win: 3, draw: 1, loss: null }, bonuses: [] } as never)).toEqual([]);
    const forfeit = (f: unknown) => pointsLine({ base: BASE, bonuses: [], forfeit: f } as never).map((c) => c.key);
    expect(forfeit({ winnerPoints: Number.NaN, loserPoints: 0 })).toEqual(["format.points.base"]);
    expect(forfeit({ winnerPoints: 2, loserPoints: Number.POSITIVE_INFINITY })).toEqual(["format.points.base"]);
    // The award score is never read, whatever shape it has (it is not said until Task 16b): the line is the same.
    for (const award of [[5, Number.POSITIVE_INFINITY], [Number.NaN, 0], [5, 0, 1], "5-0", { 0: 5, 1: 0, length: 2 }, [7, 0]])
      expect(forfeit({ winnerPoints: 2, loserPoints: 0, awardScore: award }), JSON.stringify(award)).toEqual(["format.points.base", "format.points.forfeit"]);
    expect(forfeit("walkover")).toEqual(["format.points.base"]);
    // A zero is a number (a walkover that pays nobody is legal): it is said.
    expect(forfeit({ winnerPoints: 0, loserPoints: 0 })).toEqual(["format.points.base", "format.points.forfeit"]);
  });

  it("every clause it can emit resolves in all four locales with no unfilled placeholder (counted)", () => {
    const rules: Rule[] = [
      { base: BASE, bonuses: [] },
      { base: BASE, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [5, 1] } },
      { base: BASE, bonuses: [bonus("draw", undefined, 1)] } as never,
      { base: BASE, bonuses: [bonus("draw", undefined, 1), bonus("forfeit_win", undefined, 1), bonus("no_result", undefined, 1)] } as never,
    ];
    const seen = new Set<string>();
    let checked = 0;
    for (const rule of rules)
      for (const [locale, dict] of Object.entries(DICTS)) {
        const line = pointsLine(rule);
        for (const c of line) seen.add(c.key);
        const text = rulesLineText(dict as never, line);
        expect(text, `${locale}`).not.toMatch(/format\.points\./);
        expect(text, `${locale}`).not.toMatch(/\{\w+\}/);
        checked++;
      }
    expect(checked).toBe(rules.length * Object.keys(DICTS).length);
    expect([...seen].sort()).toEqual(["format.points.base", "format.points.bonus", "format.points.bonuses", "format.points.forfeit"]);
  });

  it("the other locales speak: the same clauses are not the English words", () => {
    const line = pointsLine({ base: BASE, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [5, 0] } });
    const en = rulesLineText(enPublic as never, line);
    for (const [locale, dict] of Object.entries(DICTS).filter(([l]) => l !== "en")) expect(rulesLineText(dict as never, line), locale).not.toBe(en);
  });
});
