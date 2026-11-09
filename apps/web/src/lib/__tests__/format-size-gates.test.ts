// W4 app-A Task 15 (FX-G14's gate half, QM-2; rules X-PL-1, X-QM-1, X-QM-2, X-QM-5; owner pick 5A): which fields a stage graph
// can be played on, read off the graph. Expected values are the rulebook's: a plate needs a field of 4 (two round-one losers, spec
// §5.1), qualifying_main at the builder's q = 4 completes from 4 (the driving sweep, qualifying-main-sizes.test.ts), a knockout's
// cut is a whole round. Never the gate's own arithmetic.
import { describe, expect, it } from "vitest";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { formatPickerView, formatStagesFor } from "@/lib/division-builder/format-choice";
import { estimateMinutes, estimateTemplate } from "@/lib/division-builder/format-estimate";
import { collapsedPicks, isPairRotationTemplate, keepSizeGatedInView, SUGGESTED_COUNT, type PlanInput } from "@/lib/division-builder/model";
import { PLATE_MIN, QUALIFYING_MAIN_MIN, isWholeRoundCut, stageGraphSizeGate, stageGraphSizeRefusal } from "@/lib/format-size-gates";
import { buildTemplateStages, templatesForSport, type TemplateKnobs } from "@/lib/format-templates";

const KNOBS: TemplateKnobs = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };
const ALL_OFFER = templatesForSport("badminton", ["individual"]).map((t) => t.key);
const plan = (entrants: number): PlanInput => ({ entrants, venues: 2, hours: 4, matchMinutes: 20 });
const viewAt = (entrants: number, template = "league", offer: readonly string[] = ALL_OFFER) =>
  formatPickerView({
    offer,
    plan: plan(entrants),
    template,
    stages: buildTemplateStages(template, KNOBS),
    showAll: false,
    templateLocks: {},
    carryAllowed: true,
    standingsCarry: "none",
  });

const root = { kind: "knockout", progression: null };
const take = (rule: Record<string, unknown>, stage: unknown = "previous") => ({ sources: [{ stage, take: [rule] }], placement: "rank_order", timing: "setup" });

describe("the constants, as the rulebook and the driving sweep name them", () => {
  it("a plate needs 4 (spec §5.1), and qualifying_main at the builder's q completes from 4 (the sweep)", () => {
    expect(PLATE_MIN).toBe(4);
    expect(QUALIFYING_MAIN_MIN).toBe(4);
  });
});

describe("stageGraphSizeRefusal", () => {
  it("empty case first: no stages, no gate, at any field", () => {
    for (const n of [0, 1, 2, 3, 4, 40]) expect(stageGraphSizeRefusal([], n)).toBeNull();
  });

  it("a graph with no root knockout feeding anything is no business of this gate, at any field", () => {
    let checked = 0;
    for (const key of ["league", "knockout", "swiss", "double_elim", "league_ko", "groups_ko", "swiss_knockout"]) {
      for (const n of [0, 2, 3]) {
        expect(stageGraphSizeRefusal(buildTemplateStages(key, KNOBS), n), `${key} n=${n}`).toBeNull();
        checked++;
      }
    }
    expect(checked).toBe(21);
  });

  it("reads an API-built graph, not a template key: roundLosers into any stage, by `previous` and by a named source", () => {
    const named = [{ id: "s1", ...root }, { id: "s2", kind: "league", progression: null }, { id: "s3", kind: "league", progression: take({ kind: "roundLosers", round: 1, count: 2 }, { stageId: "s1" }) }];
    expect(stageGraphSizeRefusal(named, 3)).toBe("KO_PLATE_TOO_FEW");
    expect(stageGraphSizeRefusal(named, 4)).toBeNull();
    const previous = [root, { kind: "league", progression: take({ kind: "roundLosers", round: 1, count: 2 }) }];
    expect(stageGraphSizeRefusal(previous, 3)).toBe("KO_PLATE_TOO_FEW");
    expect(stageGraphSizeRefusal(previous, 4)).toBeNull();
  });

  it("only a ROOT knockout: a fed knockout's own losers are sized by its feed, a league's cut by its own rules", () => {
    const fedKnockout = [root, { kind: "knockout", progression: take({ kind: "rankRange", from: 1, to: 2 }) }, { kind: "knockout", progression: take({ kind: "roundLosers", round: 1, count: 2 }) }];
    expect(stageGraphSizeRefusal(fedKnockout, 3), "the third stage's source is fed; the second's cut needs only 2").toBeNull();
    const league = [{ kind: "league", progression: null }, { kind: "knockout", progression: take({ kind: "rankRange", from: 1, to: 4 }) }];
    expect(stageGraphSizeRefusal(league, 3)).toBeNull();
  });

  it("a rank cut into a knockout needs a field that fills it, whatever the cut (the sweep: q = 2 completes at 2 and 3, q = 8 is stuck below 8)", () => {
    const graph = (to: number) => [root, { kind: "knockout", progression: take({ kind: "rankRange", from: 1, to }) }];
    expect(stageGraphSizeGate(graph(2), 2)).toBeNull();
    expect(stageGraphSizeGate(graph(2), 1)).toEqual({ code: "QUALIFYING_MAIN_TOO_FEW", min: 2 });
    expect(stageGraphSizeGate(graph(4), 3)).toEqual({ code: "QUALIFYING_MAIN_TOO_FEW", min: 4 });
    expect(stageGraphSizeGate(graph(8), 7)).toEqual({ code: "QUALIFYING_MAIN_TOO_FEW", min: 8 });
    expect(stageGraphSizeGate(graph(8), 8)).toBeNull();
  });

  it("where both rules apply the larger bound is the one said, whichever stage comes first", () => {
    const r = { id: "r", ...root };
    const main = (to: number) => ({ id: "m", kind: "knockout", progression: take({ kind: "rankRange", from: 1, to }, { stageId: "r" }) });
    const plate = { id: "p", kind: "knockout", progression: take({ kind: "roundLosers", round: 1, count: 2 }, { stageId: "r" }) };
    let checked = 0;
    for (const graph of [[r, main(8), plate], [r, plate, main(8)]]) {
      expect(stageGraphSizeGate(graph, 5), graph.map((g) => g.id).join("")).toEqual({ code: "QUALIFYING_MAIN_TOO_FEW", min: 8 });
      checked++;
    }
    for (const graph of [[r, main(2), plate], [r, plate, main(2)]]) {
      expect(stageGraphSizeGate(graph, 3), graph.map((g) => g.id).join("")).toEqual({ code: "KO_PLATE_TOO_FEW", min: 4 });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a rank cut into a table stage is not this refusal's: the sentence names a main draw", () => {
    expect(stageGraphSizeRefusal([root, { kind: "league", progression: take({ kind: "rankRange", from: 1, to: 4 }) }], 3)).toBeNull();
  });
});

describe("X-QM-1 qualifying_main is two knockout stages joined by rankRange", () => {
  it("the template, at the q the builder sends whatever the box says", () => {
    for (const qualified of [4, 99, 0]) {
      const drafts = formatStagesFor("qualifying_main", { ...KNOBS, qualified, standingsCarry: "none" });
      expect(drafts.map((d) => d.kind)).toEqual(["knockout", "knockout"]);
      expect(drafts[0]!.progression).toBeNull();
      expect(drafts[1]!.progression?.sources).toEqual([{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: QUALIFYING_MAIN_MIN }] }]);
      expect(drafts[1]!.progression?.timing).toBe("setup");
    }
  });
});

describe("X-QM-2 isWholeRoundCut", () => {
  it("a power of two from 1: a table of widths", () => {
    const table: [number, boolean][] = [[1, true], [2, true], [4, true], [8, true], [16, true], [64, true], [0, false], [-2, false], [3, false], [5, false], [6, false], [7, false], [12, false], [2.5, false], [Number.NaN, false]];
    for (const [width, whole] of table) expect(isWholeRoundCut(width), `width ${width}`).toBe(whole);
    expect(table.length).toBe(15);
  });
});

describe("X-PL-1 the builder shows Knockout + Plate disabled below 4 with the reason, and the estimate agrees", () => {
  it("the picker's view at 3 and at 4", () => {
    expect(viewAt(3).sizeGate("ko_plate")).toEqual({ code: "KO_PLATE_TOO_FEW", min: 4 });
    expect(viewAt(4).sizeGate("ko_plate")).toBeNull();
    expect(viewAt(3).sizeGate("knockout"), "a plain knockout is open at 3").toBeNull();
    expect(viewAt(3).sizeGate("no_such_template"), "an unoffered key is nothing to gate").toBeNull();
  });

  it("shown, not folded away: the card sits in the suggested five at 3, for every sport that is offered it, Americano and Mexicano still last", () => {
    let swept = 0;
    for (const m of builtinModules) {
      for (const kind of effectiveEntrantModel(m.entrantModel ?? null, null).kinds) {
        const offer = templatesForSport(m.key, [kind]).map((t) => t.key);
        if (!offer.includes("ko_plate")) continue;
        const view = viewAt(3, "league", offer);
        expect(view.suggested, `${m.key}/${kind}`).toContain("ko_plate");
        expect(view.folded("ko_plate"), `${m.key}/${kind}`).toBe(false);
        expect(view.suggested.length, `${m.key}/${kind}`).toBe(SUGGESTED_COUNT);
        const rotation = view.pickerOrder.findIndex((k) => isPairRotationTemplate(k));
        if (rotation !== -1) expect(view.pickerOrder.slice(rotation).every((k) => isPairRotationTemplate(k)), `${m.key}/${kind}`).toBe(true);
        swept++;
      }
    }
    expect(swept, "anti-vacuity: the sweep read the registry").toBeGreaterThanOrEqual(builtinModules.length);
  });

  it("at 4 the card goes back to where the ranking puts it", () => {
    const view = viewAt(4);
    expect(view.pickerOrder).toEqual(keepSizeGatedInView(view.pickerOrder, new Set()));
    expect(view.sizeGate("ko_plate")).toBeNull();
  });

  for (const [key, min] of [["ko_plate", 4], ["qualifying_main", 4]] as const) {
    it(`${key}: the estimate and the gate give the same verdict at every field from 0 to 40 (41 checked)`, () => {
      let checked = 0;
      const drafts = buildTemplateStages(key, KNOBS);
      for (let n = 0; n <= 40; n++) {
        const refused = n < min;
        const est = estimateTemplate(key, n, KNOBS);
        expect(stageGraphSizeRefusal(drafts, n) !== null, `gate n=${n}`).toBe(refused);
        expect(est.matches === null, `estimate n=${n}: no draw to count below the gate`).toBe(refused);
        expect(est.stages.length, `n=${n}: the graph's stages are still listed`).toBe(2);
        expect(estimateMinutes(est, 2, 20) === null, `minutes n=${n}`).toBe(refused);
        checked++;
      }
      expect(checked).toBe(41);
    });
  }
});

describe("X-QM-5 qualifying_main below its bound (builder)", () => {
  it("disabled below 4 with its bound, open from 4", () => {
    expect(viewAt(3).sizeGate("qualifying_main")).toEqual({ code: "QUALIFYING_MAIN_TOO_FEW", min: QUALIFYING_MAIN_MIN });
    expect(viewAt(4).sizeGate("qualifying_main")).toBeNull();
  });

  it("below both bounds both cards stay in view; the order keeps the ranking's among the rest", () => {
    const view = viewAt(2);
    expect(view.suggested.slice(-2).sort()).toEqual(["ko_plate", "qualifying_main"]);
    expect(view.foldedCount).toBe(ALL_OFFER.length - SUGGESTED_COUNT);
  });
});

describe("collapsedPicks: a pick outside the five never folds a card the field is too small for", () => {
  const ORDER = ["a", "b", "c", "plate", "main", "f", "g"];
  it("the empty case: nothing kept, the pick takes the last slot, as ever", () => {
    expect(collapsedPicks(ORDER, "g")).toEqual(["a", "b", "c", "plate", "g"]);
    expect(collapsedPicks(ORDER, "g", new Set())).toEqual(["a", "b", "c", "plate", "g"]);
  });
  it("a pick in the five, no pick and a pick nobody offers change nothing", () => {
    const head = ORDER.slice(0, SUGGESTED_COUNT);
    expect(collapsedPicks(ORDER, "b", new Set(["plate", "main"]))).toEqual(head);
    expect(collapsedPicks(ORDER, null, new Set(["plate", "main"]))).toEqual(head);
    expect(collapsedPicks(ORDER, "nobody", new Set(["plate", "main"]))).toEqual(head);
  });
  it("two kept in the last slots: the pick takes the last slot that keeps nothing", () => {
    const shown = collapsedPicks(ORDER, "g", new Set(["plate", "main"]));
    expect(shown.length).toBe(SUGGESTED_COUNT);
    expect([...shown].sort()).toEqual(["a", "b", "g", "main", "plate"]);
  });
  it("every slot kept: the pick is shown beside them, one over, rather than lost", () => {
    const all = ORDER.slice(0, SUGGESTED_COUNT);
    expect(collapsedPicks(ORDER, "g", new Set(all))).toEqual([...all, "g"]);
  });
});

describe("keepSizeGatedInView", () => {
  const order = ["a", "b", "c", "d", "e", "f", "g", "h"];
  it("empty case first: nothing gated, the order is untouched", () => {
    expect(keepSizeGatedInView(order, new Set())).toEqual(order);
  });
  it("a gated card past the fold takes the last of the five; one already inside moves to it too", () => {
    expect(keepSizeGatedInView(order, new Set(["g"]))).toEqual(["a", "b", "c", "d", "g", "e", "f", "h"]);
    expect(keepSizeGatedInView(order, new Set(["b"]))).toEqual(["a", "c", "d", "e", "b", "f", "g", "h"]);
    expect(keepSizeGatedInView(order, new Set(["g", "b"]))).toEqual(["a", "c", "d", "b", "g", "e", "f", "h"]);
  });
  it("a short order keeps everyone", () => {
    expect(keepSizeGatedInView(["a", "b"], new Set(["a"]))).toEqual(["b", "a"]);
  });
});
