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
import { pointsLine, type PointsClause } from "../points-line";

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

  it("W2d: a stored W2c rule (`base`) says the same sentence until it is converted, and a head with no draw says win and loss only", () => {
    expect(rulesLineText(enPublic as never, pointsLine({ base: BASE, bonuses: [] } as never))).toBe("Win 3, draw 1, loss 0");
    expect(rulesLineText(enPublic as never, pointsLine({ base: { win: 4, draw: 2, loss: 1 }, bonuses: [] } as never))).toBe("Win 4, draw 2, loss 1");
    // W2d M5: an outcome-keyed rule with no draw pays none (IIHF's): the line says its win and loss, never "draw 0" and
    // never nothing at all.
    const noDraw = pointsLine({ win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] });
    expect(noDraw).toEqual([{ key: "format.points.winLoss", params: { win: 3, loss: 0 } }]);
    expect(rulesLineText(enPublic as never, noDraw)).toBe("Win 3, loss 0");
    // a draw that is there but no number is still never said, and never dropped into the win-and-loss sentence either
    expect(pointsLine({ win: { regulation: 3 }, draw: "1", loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] } as never)).toEqual([]);
    // ...and nothing after the missing head either: a walkover row, a split or a bonus is no sentence without its base
    const tail = { win: { regulation: 3, ot: 2 }, draw: "1", loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", forfeit: { winnerPoints: 2, loserPoints: 0 }, bonuses: [{ when: "margin_gte", param: 1, points: 1 }] };
    expect(pointsLine(tail as never)).toEqual([]);
    expect(pointsLine({ ...tail, draw: 1 } as never).map((c) => c.key), "the positive pair: the same rule with a numeric draw says it all").toEqual(["format.points.base", "format.points.ot", "format.points.forfeit", "format.points.bonus"]);
  });

  it("W2d M5: an overtime split is said with its own numbers (IIHF 3/2/1/0: 2 and 1 are neither the regulation win nor loss)", () => {
    const iihf = pointsLine({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0, ot: 1 }, shootoutAs: "result", unit: "whole", bonuses: [] });
    expect(iihf).toEqual([
      { key: "format.points.winLoss", params: { win: 3, loss: 0 } },
      { key: "format.points.ot", params: { win: 2, loss: 1 } },
    ]);
    expect(rulesLineText(enPublic as never, iihf)).toBe("Win 3, loss 0, overtime win 2, overtime loss 1");
    // one side split alone: the other side's overtime result pays its regulation number (D9's fallback), said as such
    const winOnly = pointsLine({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] });
    expect(winOnly.at(-1)).toEqual({ key: "format.points.ot", params: { win: 2, loss: 0 } });
    // ...and the loss split alone is a split too: the clause is said, the win side at its regulation number
    const lossOnly = pointsLine({ win: { regulation: 3 }, loss: { regulation: 0, ot: 1 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] });
    expect(lossOnly.at(-1)).toEqual({ key: "format.points.ot", params: { win: 3, loss: 1 } });
    // no split, no clause (the regulation numbers already said it)
    expect(pointsLine({ ...HEAD, bonuses: [] }).map((c) => c.key)).toEqual(["format.points.base"]);
    // a split that is no number says nothing of overtime (never the regulation number in its place)
    expect(pointsLine({ ...HEAD, win: { regulation: 3, ot: null }, bonuses: [] } as never).map((c) => c.key)).toEqual(["format.points.base"]);
    expect(pointsLine({ ...HEAD, loss: { regulation: 0, ot: "1" }, bonuses: [] } as never).map((c) => c.key)).toEqual(["format.points.base"]);
  });

  it("W2d M5: a shoot-out booked as a result says its pair, each side falling back so → ot → regulation (D9)", () => {
    const rule: Rule = { win: { regulation: 3, ot: 2, so: 5 }, loss: { regulation: 0, ot: 1 }, shootoutAs: "result", unit: "whole", bonuses: [] };
    const line = pointsLine(rule);
    expect(line.map((c) => c.key)).toEqual(["format.points.winLoss", "format.points.ot", "format.points.so"]);
    // the shoot-out loss is not split: it pays the overtime loss (1), not the regulation loss (0)
    expect(line.at(-1)).toEqual({ key: "format.points.so", params: { win: 5, loss: 1 } });
    expect(rulesLineText(enPublic as never, line)).toBe("Win 3, loss 0, overtime win 2, overtime loss 1, shoot-out win 5, shoot-out loss 1");
    // only the loss split, no overtime split: the win falls back to regulation
    expect(pointsLine({ ...HEAD, loss: { regulation: 0, so: 1 }, bonuses: [] }).at(-1)).toEqual({ key: "format.points.so", params: { win: 3, loss: 1 } });
    // the win side's own fallback: no shoot-out win, an overtime win (2) - it pays 2, not the regulation 3
    const winFalls = pointsLine({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0, ot: 1, so: 1 }, shootoutAs: "result", unit: "whole", bonuses: [] });
    expect(winFalls.at(-1)).toEqual({ key: "format.points.so", params: { win: 2, loss: 1 } });
  });

  it("W2d M5: a draw-plus-bonus shoot-out says its bonus where the rule sets one, and says nothing where it does not", () => {
    const fb = { ...HEAD, shootoutAs: "draw_plus_bonus" } as const;
    const two = pointsLine({ ...fb, soBonus: 2, bonuses: [] });
    expect(two).toEqual([
      { key: "format.points.base", params: { win: 3, draw: 1, loss: 0 } },
      { key: "format.points.soBonus", params: { bonus: 2 } },
    ]);
    expect(rulesLineText(enPublic as never, two)).toBe("Win 3, draw 1, loss 0, a shoot-out is a draw plus 2 for the winner");
    expect(pointsLine({ ...fb, bonuses: [] }).map((c) => c.key)).toEqual(["format.points.base"]);
    expect(pointsLine({ ...fb, soBonus: Number.NaN, bonuses: [] }).map((c) => c.key)).toEqual(["format.points.base"]);
  });

  it("W2d M5: a set-score map is the whole table: each score says its own pair, any other score last, and the regulation head is not said", () => {
    const fivb = { "3-2": [2, 1], "3-0": [3, 0], "3-1": [3, 0] } as const;
    const line = pointsLine({ win: { regulation: 7 }, loss: { regulation: 7 }, bySetScore: fivb, shootoutAs: "result", unit: "whole", bonuses: [] } as never);
    expect(line).toEqual([
      { key: "format.points.setScore", params: { won: 3, lost: 0, winner: 3, loser: 0 } },
      { key: "format.points.setScore", params: { won: 3, lost: 1, winner: 3, loser: 0 } },
      { key: "format.points.setScore", params: { won: 3, lost: 2, winner: 2, loser: 1 } },
    ]);
    expect(rulesLineText(enPublic as never, line)).toBe(`A 3${NB}0 win pays 3${NB}0 points, a 3${NB}1 win pays 3${NB}0 points, a 3${NB}2 win pays 2${NB}1 points`);
    const star = pointsLine({ win: { regulation: 7 }, loss: { regulation: 7 }, bySetScore: { "*": [3, 0], "2-1": [2, 1] }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } } as never);
    expect(star.map((c) => c.key)).toEqual(["format.points.setScore", "format.points.setScoreOther", "format.points.forfeit"]);
    expect(rulesLineText(enPublic as never, star)).toBe(`A 2${NB}1 win pays 2${NB}1 points, any other score pays 3${NB}0 points, walkover pays 2${NB}0 points`);
    // the map overrides every split too (SPEC §5.3: a set map pays every win), so a split the rule carries is not said
    const split = pointsLine({ win: { regulation: 7, ot: 6, so: 5 }, loss: { regulation: 7, ot: 4, so: 3 }, bySetScore: fivb, shootoutAs: "result", unit: "whole", bonuses: [] } as never);
    expect(split).toEqual(line);
    // a map with one pair it cannot read says nothing of the table (never a table missing a row)
    expect(pointsLine({ win: { regulation: 3 }, loss: { regulation: 0 }, bySetScore: { "2-0": [3, 0], "2-1": [2] }, shootoutAs: "result", unit: "whole", bonuses: [] } as never)).toEqual([]);
    expect(pointsLine({ win: { regulation: 3 }, loss: { regulation: 0 }, bySetScore: { "x": [3, 0] }, shootoutAs: "result", unit: "whole", bonuses: [] } as never)).toEqual([]);
    expect(pointsLine({ win: { regulation: 3 }, loss: { regulation: 0 }, bySetScore: { "2-0": [3, null] }, shootoutAs: "result", unit: "whole", bonuses: [] } as never)).toEqual([]);
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
      { win: { regulation: 3, ot: 2, so: 2 }, loss: { regulation: 0, ot: 1, so: 1 }, shootoutAs: "result", unit: "whole", bonuses: [] },
      { ...HEAD, shootoutAs: "draw_plus_bonus", soBonus: 1, bonuses: [] },
      { ...HEAD, bySetScore: { "2-0": [3, 0], "*": [2, 1] }, bonuses: [] },
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
    expect([...seen].sort()).toEqual([
      "format.points.base",
      "format.points.bonus",
      "format.points.bonuses",
      "format.points.forfeit",
      "format.points.forfeitScore",
      "format.points.ot",
      "format.points.setScore",
      "format.points.setScoreOther",
      "format.points.so",
      "format.points.soBonus",
      "format.points.winLoss",
    ]);
  });

  it("the other locales speak: the same clauses are not the English words", () => {
    const line = pointsLine({ ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [5, 0] } }, { awardReaches: true });
    const en = rulesLineText(enPublic as never, line);
    for (const [locale, dict] of Object.entries(DICTS).filter(([l]) => l !== "en")) expect(rulesLineText(dict as never, line), locale).not.toBe(en);
  });

  it("W2d M5: each new clause speaks every locale on its own, and a set score's figures never split (non-breaking dash; counted)", () => {
    const lines: PointsClause[][] = [
      [{ key: "format.points.winLoss", params: { win: 3, loss: 0 } }],
      [{ key: "format.points.ot", params: { win: 2, loss: 1 } }],
      [{ key: "format.points.so", params: { win: 2, loss: 1 } }],
      [{ key: "format.points.soBonus", params: { bonus: 1 } }],
      [{ key: "format.points.setScore", params: { won: 3, lost: 2, winner: 2, loser: 1 } }],
      [{ key: "format.points.setScoreOther", params: { winner: 3, loser: 0 } }],
    ];
    let checked = 0;
    for (const line of lines) {
      const en = rulesLineText(enPublic as never, line);
      for (const [locale, dict] of Object.entries(DICTS)) {
        const text = rulesLineText(dict as never, line);
        expect(text, `${locale} ${line[0]!.key}`).not.toMatch(/format\.points\.|\{\w+\}/);
        if (locale !== "en") expect(text, `${locale} ${line[0]!.key}`).not.toBe(en);
        for (const [a, b] of [["3", "2"], ["2", "1"], ["3", "0"]] as const)
          if (text.includes(`${a}${NB}${b}`)) expect(text, locale).not.toMatch(new RegExp(`${a}[-\u2010\u2012-\u2015]${b}`));
        checked++;
      }
    }
    expect(checked).toBe(lines.length * Object.keys(DICTS).length);
    // the set score and its pair: both figures joined by the non-breaking dash in every locale
    for (const [locale, dict] of Object.entries(DICTS)) {
      const text = rulesLineText(dict as never, lines[4]!);
      expect(text, locale).toContain(`3${NB}2`);
      expect(text, locale).toContain(`2${NB}1`);
    }
  });
});
