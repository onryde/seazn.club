// W4 app-A Task 15 (FX-G14's gate half, QM-2; rules X-PL-1, X-QM-1, X-QM-2, X-QM-5; owner pick 5A): which fields a stage graph
// can be played on, read off the graph. Expected values are the rulebook's: a plate needs a field of 4 (two round-one losers, spec
// §5.1), qualifying_main at the builder's q = 4 completes from 4 (the driving sweep, qualifying-main-sizes.test.ts), a knockout's
// cut is a whole round. Never the gate's own arithmetic.
import { describe, expect, it } from "vitest";
import { generatePagePlayoff } from "@seazn/engine/scheduling";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { formatPickerView, formatStagesFor } from "@/lib/division-builder/format-choice";
import { estimateMinutes, estimateTemplate } from "@/lib/division-builder/format-estimate";
import { collapsedPicks, isPairRotationTemplate, keepSizeGatedInView, openingKnobs, SUGGESTED_COUNT, type PlanInput } from "@/lib/division-builder/model";
import { PAGE_PLAYOFF_SIZE, PLATE_MIN, QUALIFYING_MAIN_MIN, isWholeRoundCut, stageGraphSizeGate, stageGraphSizeRefusal } from "@/lib/format-size-gates";
import { buildTemplateStages, STAGE_TEMPLATES, templatesForSport, type TemplateKnobs } from "@/lib/format-templates";

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

/** The page playoff's size, read off the ENGINE's generator (T26c fix round 1, I1): the field sizes `generatePagePlayoff` draws
 *  without refusing, and the entrants it seats there. Never the gate's constant. */
function enginePagePlayoffSize(): number {
  const accepted: number[] = [];
  let seated = 0;
  for (let n = 0; n <= 16; n++) {
    const entrants = Array.from({ length: n }, (_, i) => `e${i + 1}`);
    try {
      const drawn = generatePagePlayoff({ entrants });
      accepted.push(n);
      seated = new Set(drawn.fixtures.flatMap((f) => [f.home, f.away]).filter((x): x is string => typeof x === "string")).size;
    } catch {
      // any other count is the engine's refusal
    }
  }
  if (accepted.length !== 1) throw new Error(`enginePagePlayoffSize: the engine drew ${accepted.length} sizes (${accepted.join(", ")}), not one`);
  if (seated !== accepted[0]) throw new Error(`enginePagePlayoffSize: drew ${accepted[0]} but seated ${seated}`);
  return accepted[0]!;
}
const PAGE_SIZE = enginePagePlayoffSize();
const PAGE_PLAYOFF_TEMPLATES = ["group_playoffs", "swiss_playoff"] as const;
const take = (rule: Record<string, unknown>, stage: unknown = "previous") => ({ sources: [{ stage, take: [rule] }], placement: "rank_order", timing: "setup" });

describe("the constants, as the rulebook and the driving sweep name them", () => {
  it("a plate needs 4 (spec §5.1), and qualifying_main at the builder's q completes from 4 (the sweep)", () => {
    expect(PLATE_MIN).toBe(4);
    expect(QUALIFYING_MAIN_MIN).toBe(4);
  });

  it("a page playoff's size is the engine's: the one field generatePagePlayoff draws, every seat filled", () => {
    expect(PAGE_PLAYOFF_SIZE).toBe(PAGE_SIZE);
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

  it("X-PL-6 a firstLosses plate is gated exactly as a roundLosers one: it needs the plate's minimum field, from a root knockout", () => {
    const plate = [root, { kind: "knockout", progression: take({ kind: "firstLosses" }) }];
    let checked = 0;
    for (const n of [0, 1, 2, 3]) {
      expect(stageGraphSizeRefusal(plate, n), `n=${n}`).toBe("KO_PLATE_TOO_FEW");
      checked++;
    }
    for (const n of [4, 5, 13, 64]) {
      expect(stageGraphSizeRefusal(plate, n), `n=${n}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(8);
    expect(stageGraphSizeGate(plate, 3)).toEqual({ code: "KO_PLATE_TOO_FEW", min: 4 });
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

  // T26c fix round 1 (I1, controller ruling 2026-11-09): a fed page playoff seats the engine's four, so a smaller field leaves a
  // seat no stage can fill — and its lines took a time and a court (the T26c sweep). Refused by name below that size.
  it("I1 a fed page playoff (group_playoffs, swiss_playoff) is refused below the page playoff's size, open from it", () => {
    let checked = 0;
    for (const key of PAGE_PLAYOFF_TEMPLATES) {
      const drafts = buildTemplateStages(key, KNOBS);
      expect(drafts.map((d) => d.kind)[1], `premise: ${key} ends in a page playoff`).toBe("page_playoff");
      for (let n = 0; n <= 12; n++) {
        expect(stageGraphSizeGate(drafts, n), `${key} n=${n}`).toEqual(n < PAGE_SIZE ? { code: "PAGE_PLAYOFF_TOO_FEW", min: PAGE_SIZE } : null);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two templates, 13 fields each").toBe(26);
  });

  it("I1 reads the graph: a page playoff fed by a named source is gated; a standalone (legacy) one is not this rule's", () => {
    const named = [{ id: "s1", kind: "swiss", progression: null }, { id: "s2", kind: "page_playoff", progression: take({ kind: "rankRange", from: 1, to: 4 }, { stageId: "s1" }) }];
    expect(stageGraphSizeRefusal(named, PAGE_SIZE - 1)).toBe("PAGE_PLAYOFF_TOO_FEW");
    expect(stageGraphSizeRefusal(named, PAGE_SIZE)).toBeNull();
    expect(stageGraphSizeRefusal([{ kind: "page_playoff", progression: null }], PAGE_SIZE - 1), "the engine's own refusal says that one").toBeNull();
  });

  it("I1 beside a qualifying cut the larger bound is said: a cut of 8 outranks the page playoff's four", () => {
    const r = { id: "r", ...root };
    const main = { id: "m", kind: "knockout", progression: take({ kind: "rankRange", from: 1, to: 8 }, { stageId: "r" }) };
    const pp = { id: "p", kind: "page_playoff", progression: take({ kind: "rankRange", from: 1, to: 4 }, { stageId: "r" }) };
    expect(stageGraphSizeGate([r, main, pp], 3)).toEqual({ code: "QUALIFYING_MAIN_TOO_FEW", min: 8 });
    expect(stageGraphSizeGate([r, pp], 3)).toEqual({ code: "PAGE_PLAYOFF_TOO_FEW", min: PAGE_SIZE });
  });
});

describe("X-QM-1 qualifying_main is two knockout stages joined by rankRange", () => {
  it("the template, at the q the builder sends whatever the box says", () => {
    for (const qualified of [4, 99, 0]) {
      const drafts = formatStagesFor("qualifying_main", { ...KNOBS, qualified, standingsCarry: "none", thirdPlace: "shared" });
      expect(drafts.map((d) => d.kind)).toEqual(["knockout", "knockout"]);
      expect(drafts[0]!.progression).toBeNull();
      expect(drafts[1]!.progression?.sources).toEqual([{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: QUALIFYING_MAIN_MIN }] }]);
      expect(drafts[1]!.progression?.timing).toBe("setup");
    }
  });
});

describe("X-QM-2 isWholeRoundCut: a cut starts on a finishing band's first place and ends on a band's last (RB4-Q2, ruling 273)", () => {
  // The finishing bands of a knockout, written out and not computed: 1st, 2nd, 3rd-4th (the two semi-final losers share 3rd
  // unless a third-place match is played), 5th-8th (the quarter-final losers), 9th-16th ... A cut that starts or ends inside a
  // band would be decided by seed, which is what the rule is for.
  const BANDS: readonly (readonly [number, number])[] = [[1, 1], [2, 2], [3, 4], [5, 8], [9, 16], [17, 32], [33, 64]];
  // With a third-place match 3rd and 4th are two places.
  const BANDS_WITH_PLAYOFF: readonly (readonly [number, number])[] = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 8], [9, 16], [17, 32], [33, 64]];

  it("a table of cuts, expected values from the bands above, by hand", () => {
    // [from, to, third-place match played, whole]
    const table: [number, number, boolean, boolean][] = [
      [1, 1, false, true], [1, 2, false, true], [1, 4, false, true], [2, 2, false, true], [2, 3, false, false], [2, 4, false, true],
      [3, 4, false, true], [3, 8, false, true], [4, 5, false, false], [3, 3, false, false], [5, 8, false, true], [5, 6, false, false],
      [4, 4, false, false], [1, 3, false, false], [1, 8, false, true], [1, 16, false, true], [9, 16, false, true], [9, 12, false, false],
      [6, 8, false, false], [4, 8, false, false], [2, 8, false, true], [1, 5, false, false], [1, 6, false, false], [1, 7, false, false],
      [3, 5, false, false], [3, 16, false, true], [17, 32, false, true], [1, 64, false, true],
      // a third-place match splits 3rd-4th: 3 and 4 become places of their own
      [3, 3, true, true], [4, 4, true, true], [1, 3, true, true], [2, 3, true, true], [4, 8, true, true], [3, 4, true, true], [2, 4, true, true],
      // and nothing else moves
      [4, 5, true, false], [5, 6, true, false], [1, 5, true, false], [4, 6, true, false], [6, 8, true, false], [1, 1, true, true], [5, 8, true, true],
    ];
    for (const [from, to, playoff, whole] of table) expect(isWholeRoundCut(from, to, playoff), `${from}-${to}${playoff ? " with a third-place match" : ""}`).toBe(whole);
    expect(table.length, "anti-vacuity: the table was read").toBe(42);
    expect(table.filter((r) => r[3]).length, "and it holds both verdicts: 24 whole, 18 not").toBe(24);
  });

  it("every cut 1 <= from <= to <= 40, against the bands: exactly the cuts that start on a band's first place and end on its last", () => {
    for (const [bands, playoff, expectedWhole] of [[BANDS, false, 21], [BANDS_WITH_PLAYOFF, true, 28]] as const) {
      const starts = bands.map(([first]) => first);
      const ends = bands.map(([, last]) => last);
      let checked = 0;
      let whole = 0;
      for (let from = 1; from <= 40; from++) {
        for (let to = from; to <= 40; to++) {
          const expected = starts.includes(from) && ends.includes(to);
          expect(isWholeRoundCut(from, to, playoff), `${from}-${to} (third-place match: ${playoff})`).toBe(expected);
          checked++;
          if (expected) whole++;
        }
      }
      expect(checked, "anti-vacuity: every pair was asked").toBe(820);
      // Counted by hand from the starts and ends above: the pairs with from <= to <= 40.
      expect(whole, `the cuts that are whole (third-place match: ${playoff})`).toBe(expectedWhole);
    }
  });

  it("a cut that runs backwards, starts below 1 or is no integer is never whole", () => {
    const bad: [number, number][] = [[4, 3], [2, 1], [0, 1], [-1, 2], [1, 0], [1.5, 2], [1, 2.5], [Number.NaN, 1], [1, Number.NaN], [1, Number.POSITIVE_INFINITY]];
    for (const [from, to] of bad) {
      expect(isWholeRoundCut(from, to, false), `${from}-${to}`).toBe(false);
      expect(isWholeRoundCut(from, to, true), `${from}-${to} with a third-place match`).toBe(false);
    }
    expect(bad.length).toBe(10);
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

  for (const [key, min] of [["ko_plate", 4], ["qualifying_main", 4], ...PAGE_PLAYOFF_TEMPLATES.map((k) => [k, PAGE_SIZE] as const)] as const) {
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

  it("below every bound each gated card stays in view; the order keeps the ranking's among the rest", () => {
    const view = viewAt(2);
    const gated = ["ko_plate", "qualifying_main", ...PAGE_PLAYOFF_TEMPLATES].filter((k) => ALL_OFFER.includes(k)).sort();
    expect(gated, "premise: badminton is offered all four size-gated formats").toEqual(["group_playoffs", "ko_plate", "qualifying_main", "swiss_playoff"]);
    expect(view.suggested.slice(-gated.length).sort()).toEqual(gated);
    expect(view.foldedCount).toBe(ALL_OFFER.length - SUGGESTED_COUNT);
  });
});

describe("I1 group_playoffs and swiss_playoff below the page playoff's size (builder)", () => {
  it("disabled below the engine's page playoff size with that bound, open from it", () => {
    let checked = 0;
    for (const key of PAGE_PLAYOFF_TEMPLATES) {
      expect(viewAt(PAGE_SIZE - 1).sizeGate(key), key).toEqual({ code: "PAGE_PLAYOFF_TOO_FEW", min: PAGE_SIZE });
      expect(viewAt(PAGE_SIZE).sizeGate(key), key).toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
  });

  // The server's Generate pre-flight (usecases/stages/generate.ts generateStageFixturesWrite) runs the size gate on a NON-knockout root only
  // when its division holds a fed page playoff, so a root of any other division pays no round trip for it
  // (generate-roundtrips.test.ts). That rests on an assumption, held here as a guard: every graph the gate refuses whose
  // roots hold no knockout contains a fed page playoff. A new gate on a league or Swiss root breaks it here first.
  it("guard: a graph refused with no knockout root always holds a fed page playoff (the server's pre-filter)", () => {
    let graphs = 0;
    let nonKnockoutRefused = 0;
    for (const t of STAGE_TEMPLATES) {
      for (let n = 0; n <= 16; n++) {
        const stages = buildTemplateStages(t.key, openingKnobs(n));
        graphs++;
        if (stageGraphSizeGate(stages, n) === null) continue;
        if (stages.some((s) => s.progression === null && s.kind === "knockout")) continue;
        nonKnockoutRefused++;
        expect(stages.some((s) => s.kind === "page_playoff" && s.progression !== null), `${t.key} n=${n}`).toBe(true);
      }
    }
    expect(graphs, "anti-vacuity: every template at 0..16").toBe(STAGE_TEMPLATES.length * 17);
    expect(nonKnockoutRefused, "anti-vacuity: the page templates below four are refused graphs with no knockout root").toBeGreaterThan(0);
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
