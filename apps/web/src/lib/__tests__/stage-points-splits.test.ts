// W2d Task 10 fix round 1, I2 (owner decision 2026-10-26) — `sportPointsSplits`, the server's defence-in-depth question:
// what does a sport pay apart on a stage that a FLAT rule (one amount per win and per loss) would flatten? Expected values
// are the rulebooks' (`_points-split-rulebook.ts`: IIHF, FIVB, ITTF, FIH's shoot-out), never the function's own answer.
// A flat rule carries a tie and a no result itself, so cricket's (ICC) are the editor's limit, not a split here. Every
// sweep reports how many items it checked; zero is a failure.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { StageKind } from "@seazn/engine/core";
import { PointsRule } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { RULEBOOK_SPLITS, TABLE_KINDS } from "@/components/v2/stage-rules/__tests__/_points-split-rulebook";
import { flatOf, isFlatRule, sportPointsSplits } from "../stage-points-splits";

const LEVEL = new Set(["tie", "noResult"]);
const DIVISIONS = builtinModules.flatMap((m) => Object.keys(m.variants).map((variant) => ({ m: m as AnySportModule, variant })));
const FLAT: PointsRule = { win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] };

describe("sportPointsSplits: what a flat rule would flatten, per (sport, variant, table kind)", () => {
  it("sweep: the rulebooks' per-outcome splits on every division they name, none on the rest (counted, both sides > 0)", () => {
    let checked = 0;
    let split = 0;
    for (const { m, variant } of DIVISIONS) {
      const want = (RULEBOOK_SPLITS[`${m.key}/${variant}`] ?? []).filter((r) => !LEVEL.has(r));
      for (const kind of TABLE_KINDS) {
        expect(sportPointsSplits(m, m.variants[variant], kind), `${m.key}/${variant} ${kind}`).toEqual(want);
        if (want.length > 0) split++;
        checked++;
      }
    }
    expect(checked, "every division × every table kind").toBe(DIVISIONS.length * TABLE_KINDS.length);
    expect(split, "the splits were reached").toBeGreaterThan(0);
    expect(checked - split, "and the flat sports").toBeGreaterThan(0);
  });

  it("nothing to ask: a bracket kind, a stage kind outside the vocabulary, a config the sport refuses - no split (the server's other questions answer those)", () => {
    const ih = builtinModules.find((m) => m.key === "icehockey") as AnySportModule;
    expect(sportPointsSplits(ih, ih.variants.iihf, "league"), "the positive pair").toEqual(["otWin", "otLoss"]);
    let bracket = 0;
    for (const kind of StageKind.options) {
      if (TABLE_KINDS.includes(kind)) continue;
      expect(sportPointsSplits(ih, ih.variants.iihf, kind), kind).toEqual([]);
      bracket++;
    }
    expect(bracket, "bracket kinds").toBeGreaterThan(0);
    expect(sportPointsSplits(ih, ih.variants.iihf, "not_a_kind")).toEqual([]);
    expect(sportPointsSplits(ih, { periods: "many" }, "league"), "a cfg the schema refuses").toEqual([]);
  });
});

describe("isFlatRule / flatOf", () => {
  it("a rule is flat exactly when no field pays one win or loss apart; flatOf takes each such field out and keeps the rest", () => {
    expect(isFlatRule(FLAT)).toBe(true);
    expect(isFlatRule({ ...FLAT, tie: 1, noResult: 1, forfeit: { winnerPoints: 3, loserPoints: 0 } }), "a tie, a no result and a walkover row are flat").toBe(true);
    const apart: PointsRule[] = [
      { ...FLAT, win: { regulation: 3, ot: 2 } },
      { ...FLAT, win: { regulation: 3, so: 2 } },
      { ...FLAT, loss: { regulation: 0, ot: 1 } },
      { ...FLAT, loss: { regulation: 0, so: 1 } },
      { ...FLAT, loss: { regulation: 1, unplayed: 0 } },
      { ...FLAT, shootoutAs: "draw_plus_bonus" },
      { ...FLAT, shootoutAs: "draw_plus_bonus", soBonus: 1 },
      { ...FLAT, bySetScore: { "*": [3, 0] } },
    ];
    for (const rule of apart) {
      expect(isFlatRule(rule), JSON.stringify(rule)).toBe(false);
      expect(isFlatRule(flatOf(rule)), `flatOf ${JSON.stringify(rule)}`).toBe(true);
    }
    expect(apart.length, "every split field tried").toBe(8);
    // `soBonus` is not a conjunct of its own: the schema refuses it beside a shoot-out booked as a result, so a parsed rule
    // that carries one is draw-plus-bonus, which `shootoutAs` answers (the assumption, as a guard).
    expect(PointsRule.safeParse({ ...FLAT, soBonus: 1 }).success, "the schema refuses soBonus with shootoutAs result").toBe(false);
    expect(PointsRule.safeParse({ ...FLAT, shootoutAs: "draw_plus_bonus", soBonus: 1 }).success, "and takes it with draw-plus-bonus").toBe(true);
    const kept = flatOf({ ...FLAT, tie: 1, noResult: 2, unit: "half", bonuses: [{ when: "draw", points: 1 }], win: { regulation: 3, ot: 2 } });
    expect(kept).toEqual({ ...FLAT, tie: 1, noResult: 2, unit: "half", bonuses: [{ when: "draw", points: 1 }] });
  });
});
