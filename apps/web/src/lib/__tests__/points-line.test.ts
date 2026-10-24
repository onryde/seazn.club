// W2c Task 16 (X-PT-1, D12) - `pointsLine`: the ONE sentence for a stage's own points rule on the public stage line (a
// later task's editor preview is meant to call it too, so the two cannot word one rule two ways). Clauses, like every
// format line: dictionary keys plus params, resolved against whichever dictionary the surface holds (`rulesLineText`).
//
// Every number is handed in by the test and read back out of the resolved text; the right answers differ from the
// wrong ones' constants (a walkover row of 2 beside a base win of 3; two bonuses, not one; an awarded score of 7).
import { describe, expect, it } from "vitest";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import { rulesLineText } from "@/lib/rules-line";
import { pointsLine } from "../points-line";

type Rule = Parameters<typeof pointsLine>[0];

/** W2d: the outcome-keyed head the line reads (`win.regulation`, `draw`, `loss.regulation`). */
const HEAD = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole" } as const;
/** A W2c `base`: what a stored row carries until it is converted (W2d Task 7). */
const BASE = { win: 3, draw: 1, loss: 0 } as const;
const bonus = (when: string, param: number | undefined, points: number) => ({ when, ...(param === undefined ? {} : { param }), points });
const DICTS = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic } as const;
/** The dash between a walkover's two point figures is NON-BREAKING (U+2011): a line that wraps at 320 must never split
 *  "1-0" over two lines. Built from its code point so the test cannot be mistaken for a plain hyphen. */
const NB = String.fromCharCode(0x2011);

describe("X-PT-1 the stage points sentence", () => {
  it("base only", () => {
    expect(rulesLineText(enPublic as never, pointsLine({ ...HEAD, bonuses: [] }))).toBe("Win 3, draw 1, loss 0");
  });

  it("W2d: a stored W2c rule (`base`) says the same sentence until it is converted, and a head with no draw says nothing", () => {
    expect(rulesLineText(enPublic as never, pointsLine({ base: BASE, bonuses: [] } as never))).toBe("Win 3, draw 1, loss 0");
    expect(rulesLineText(enPublic as never, pointsLine({ base: { win: 4, draw: 2, loss: 1 }, bonuses: [] } as never))).toBe("Win 4, draw 2, loss 1");
    // An outcome-keyed rule with no draw pays none: the line has no honest draw to say, so it says nothing (never "draw 0").
    expect(pointsLine({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] })).toEqual([]);
  });

  it("a forfeit row is its own clause, with its own numbers (2 is not the base win's 3)", () => {
    const text = rulesLineText(enPublic as never, pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } }));
    expect(text).toBe(`Win 3, draw 1, loss 0, walkover pays 2${NB}0 points`);
  });

  // X-WO-1 part B (Task 16b): the walkover headline now reads the stage rule's award wherever the award reaches the sport's
  // table, so the line may say it again - and says it ONLY where the caller states that reach (`pointsRuleAwardReachesTable`).
  it("a forfeit's awarded SCORE is said where the award reaches the table, with the rule's number (7 is neither the base win nor the walkover points)", () => {
    const rule: Rule = { ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [7, 0] } };
    const line = pointsLine(rule, { awardReaches: true });
    expect(line.map((c) => c.key)).toEqual(["format.points.base", "format.points.forfeit", "format.points.forfeitScore"]);
    expect(line.at(2)).toEqual({ key: "format.points.forfeitScore", params: { winner: 7, loser: 0 } });
    expect(rulesLineText(enPublic as never, line)).toBe(`Win 3, draw 1, loss 0, walkover pays 2${NB}0 points, walkover scored 7${NB}0`);
  });

  it("...and NOT said where the caller does not state the reach (a sport whose table never reads it, a retired module): the same rule without the award reads identically", () => {
    const rule: Rule = { ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [7, 0] } };
    const plain = pointsLine({ ...rule, forfeit: { winnerPoints: 2, loserPoints: 0 } });
    expect(pointsLine(rule), "no option").toEqual(plain);
    expect(pointsLine(rule, {}), "empty option").toEqual(plain);
    expect(pointsLine(rule, { awardReaches: false }), "reach denied").toEqual(plain);
    expect(plain.map((c) => c.key), "the positive pair: base and walkover points are still said").toEqual(["format.points.base", "format.points.forfeit"]);
    // And a rule with no award says none even where the award would reach.
    expect(pointsLine({ ...rule, forfeit: { winnerPoints: 2, loserPoints: 0 } }, { awardReaches: true })).toEqual(plain);
  });

  it("a 0-0 award is a score like any other (it is said), and an award on a rule with no walkover row says nothing", () => {
    const zero = pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [0, 0] } }, { awardReaches: true });
    expect(zero.at(-1)).toEqual({ key: "format.points.forfeitScore", params: { winner: 0, loser: 0 } });
    const noRow = pointsLine({ ...HEAD, bonuses: [], forfeit: { awardScore: [7, 0] } } as never, { awardReaches: true });
    expect(noRow.map((c) => c.key)).toEqual(["format.points.base"]);
  });

  it("the awarded score's two figures are joined by a non-breaking dash in every locale too, and the clause is not the English words elsewhere", () => {
    const line = pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [5, 1] } }, { awardReaches: true });
    let checked = 0;
    const texts: Record<string, string> = {};
    for (const [locale, dict] of Object.entries(DICTS)) {
      const text = rulesLineText(dict as never, line);
      texts[locale] = text;
      expect(text, locale).toContain(`5${NB}1`);
      expect(text, locale).not.toMatch(/5[-\u2010\u2012-\u2015]1/);
      checked++;
    }
    expect(checked).toBe(Object.keys(DICTS).length);
    for (const locale of ["es", "fr", "nl"]) expect(texts[locale], locale).not.toBe(texts.en);
  });

  it("the walkover's two figures are joined by a non-breaking dash in every locale, so no width can split them", () => {
    const line = pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 1, loserPoints: 0 } });
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
    const line = pointsLine({ win: { regulation: 4 }, draw: 2, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [bonus("loss_margin_lte", 7, 1), bonus("win_margin_gte", 4, 1)] } as never);
    expect(line.at(-1)).toEqual({ key: "format.points.bonuses", params: { n: 2 } });
    expect(rulesLineText(enPublic as never, line)).toBe("Win 4, draw 2, loss 0, 2 bonus rules");
  });

  it("ONE bonus reads in the singular, and no bonus says nothing about bonuses (the empty case)", () => {
    const one = pointsLine({ ...HEAD, bonuses: [bonus("draw", undefined, 1)] } as never);
    expect(one.at(-1)).toEqual({ key: "format.points.bonus" });
    expect(rulesLineText(enPublic as never, one)).toBe("Win 3, draw 1, loss 0, 1 bonus rule");
    const none = pointsLine({ ...HEAD, bonuses: [] });
    expect(none.map((c) => c.key)).toEqual(["format.points.base"]);
  });

  it("fractional and negative points are legal and print as they are (Jul3/09)", () => {
    const text = rulesLineText(enPublic as never, pointsLine({ win: { regulation: 2.5 }, draw: 1.25, loss: { regulation: -1 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 1.5, loserPoints: 0.5 } }));
    expect(text).toBe(`Win 2.5, draw 1.25, loss -1, walkover pays 1.5${NB}0.5 points`);
  });

  it("a rule the view rebuilt with a missing or non-numeric part says nothing about that part (never a confident 0)", () => {
    // `public_stages_v` rebuilds the rule from only the keys PointsRule reads; a malformed stored rule can reach it.
    expect(pointsLine({} as never)).toEqual([]);
    expect(pointsLine({ win: { regulation: "3" }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] } as never)).toEqual([]);
    expect(pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 2 } } as never).map((c) => c.key)).toEqual(["format.points.base"]);
    expect(pointsLine({ ...HEAD, bonuses: "x" } as never).map((c) => c.key)).toEqual(["format.points.base"]);
    expect(pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [5] } } as never, { awardReaches: true }).map((c) => c.key))
      .toEqual(["format.points.base", "format.points.forfeit"]);
  });

  it("a number that is not finite (NaN, Infinity, the JSON null of a lost value) is no number - never printed as one", () => {
    expect(pointsLine({ win: { regulation: Number.NaN }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] })).toEqual([]);
    expect(pointsLine({ win: { regulation: 3 }, draw: Number.POSITIVE_INFINITY, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] })).toEqual([]);
    expect(pointsLine({ win: { regulation: 3 }, draw: 1, loss: { regulation: null }, shootoutAs: "result", unit: "whole", bonuses: [] } as never)).toEqual([]);
    const forfeit = (f: unknown) => pointsLine({ ...HEAD, bonuses: [], forfeit: f } as never).map((c) => c.key);
    expect(forfeit({ winnerPoints: Number.NaN, loserPoints: 0 })).toEqual(["format.points.base"]);
    expect(forfeit({ winnerPoints: 2, loserPoints: Number.POSITIVE_INFINITY })).toEqual(["format.points.base"]);
    // An award score that is not a pair of finite numbers is no score - never said, even where the award reaches the table.
    const keysWith = (award: unknown) =>
      pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: award } } as never, { awardReaches: true }).map((c) => c.key);
    let shapes = 0;
    for (const award of [[5, Number.POSITIVE_INFINITY], [Number.NaN, 0], [5, 0, 1], [5], "5-0", { 0: 5, 1: 0, length: 2 }, [null, 0], ["5", 0]]) {
      expect(keysWith(award), JSON.stringify(award)).toEqual(["format.points.base", "format.points.forfeit"]);
      shapes++;
    }
    expect(shapes, "shapes checked").toBe(8);
    expect(keysWith([7, 0]), "the positive pair: a real pair is said").toEqual(["format.points.base", "format.points.forfeit", "format.points.forfeitScore"]);
    expect(forfeit("walkover")).toEqual(["format.points.base"]);
    // A zero is a number (a walkover that pays nobody is legal): it is said.
    expect(forfeit({ winnerPoints: 0, loserPoints: 0 })).toEqual(["format.points.base", "format.points.forfeit"]);
  });

  it("every clause it can emit resolves in all four locales with no unfilled placeholder (counted)", () => {
    const rules: Rule[] = [
      { ...HEAD, bonuses: [] },
      { ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [5, 1] } },
      { ...HEAD, bonuses: [bonus("draw", undefined, 1)] } as never,
      { ...HEAD, bonuses: [bonus("draw", undefined, 1), bonus("forfeit_win", undefined, 1), bonus("no_result", undefined, 1)] } as never,
    ];
    const seen = new Set<string>();
    let checked = 0;
    for (const rule of rules)
      for (const [locale, dict] of Object.entries(DICTS)) {
        const line = pointsLine(rule, { awardReaches: true });
        for (const c of line) seen.add(c.key);
        const text = rulesLineText(dict as never, line);
        expect(text, `${locale}`).not.toMatch(/format\.points\./);
        expect(text, `${locale}`).not.toMatch(/\{\w+\}/);
        checked++;
      }
    expect(checked).toBe(rules.length * Object.keys(DICTS).length);
    expect([...seen].sort()).toEqual(["format.points.base", "format.points.bonus", "format.points.bonuses", "format.points.forfeit", "format.points.forfeitScore"]);
  });

  it("the other locales speak: the same clauses are not the English words", () => {
    const line = pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [5, 0] } }, { awardReaches: true });
    const en = rulesLineText(enPublic as never, line);
    for (const [locale, dict] of Object.entries(DICTS).filter(([l]) => l !== "en")) expect(rulesLineText(dict as never, line), locale).not.toBe(en);
  });
});
