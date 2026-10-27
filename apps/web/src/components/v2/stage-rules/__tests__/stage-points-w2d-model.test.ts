// W2d Task 16 (spec §9 "Points section, widened", §5.3, B2, D6, D10(a), X-PT-3) — the widened stage points section's answers:
// one row per outcome the stage can reach, the shoot-out row by `shootoutAs`, a volleyball row per set score, the sport's
// presets, and an editor that says every split (so the W2c/T10 "can't be set per stage yet" state is gone). Expected values
// come from the rulebooks (FIVB 3-2 = 2/1, IIHF 3-2-1-0, ICC tie and NR 1, ITTF 3.7.5.1, FIDE 1/½/0, B2's +1) and the
// engine's own declarations (`reachableOutcomes`, `tablePointsRule`, `tablePresets`, `coverage`) — never the model's. Every
// sweep counts what it checked, and zero is a failure.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { DRAW_KINDS } from "@seazn/engine/core";
import { PointsRule, coverage, reachableOutcomes, type OutcomeKey } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { liveStageCfg } from "@/lib/stage-decider-off";
import { flattenedSplits, sportStageRule, splitsLost } from "@/lib/stage-points-splits";
import {
  draftFromStored,
  draftRefusal,
  draftIsDirty,
  pointsPresets,
  pointsRows,
  presetActive,
  ruleFromDraft,
  stagePointsContext,
  type PointsDraft,
} from "../stage-points-model";

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
const football = sport("football");
const hockey = sport("hockey");
const icehockey = sport("icehockey");
const volleyball = sport("volleyball");
const cricket = sport("cricket");
const tabletennis = sport("tabletennis");
const boardgame = sport("boardgame");

const cfg = (m: AnySportModule, variant: string): Record<string, unknown> => m.variants[variant] as Record<string, unknown>;
/** The outcomes a stage reaches under its merged cfg, as the ENGINE answers (the loader's own function). */
const reach = (m: AnySportModule, division: unknown, kind = "league", config: Record<string, unknown> = {}): OutcomeKey[] =>
  [...reachableOutcomes(m, liveStageCfg(division, { kind, config }, m), kind as never)];
/** The sport's own rule for the stage, as the ENGINE answers. */
const sportRule = (m: AnySportModule, division: unknown, kind = "league", config: Record<string, unknown> = {}): PointsRule =>
  sportStageRule(m, liveStageCfg(division, { kind, config }, m), kind)!.rule;

const DIVISIONS = builtinModules.flatMap((m) => Object.keys(m.variants).map((variant) => ({ m, variant, cfg: cfg(m, variant) })));
const TABLE_KINDS = [...DRAW_KINDS];

describe("X-PT-3 the rows are the reachable outcomes", () => {
  it("an outcome key the app has no row for is refused by name, never dropped: alone, and sorted beside a known one", () => {
    const rule = sportRule(icehockey, cfg(icehockey, "iihf"));
    const bogus = "win.penalties" as OutcomeKey;
    expect(() => pointsRows([bogus], rule)).toThrow('stage points: no row for the outcome "win.penalties"');
    expect(() => pointsRows(["win.regulation", bogus], rule)).toThrow('stage points: no row for the outcome "win.penalties"');
    // The positive pair: every key the engine can reach has a row (the X-PT-3 sweep below counts them).
    expect(pointsRows(["win.regulation"], rule).map((r) => r.key)).toEqual(["win.regulation"]);
  });

  it("X-PT-3 rows are exactly reachableOutcomes: IIHF shows OT and shoot-out rows; recreational shows a draw row and none of them", () => {
    const iihf = reach(icehockey, cfg(icehockey, "iihf"));
    const rows = pointsRows(iihf, sportRule(icehockey, cfg(icehockey, "iihf")));
    expect(rows.map((r) => r.key).sort()).toEqual([...iihf].sort());
    for (const k of ["win.ot", "loss.ot", "win.so", "loss.so"] as const) expect(rows.some((r) => r.key === k && r.shown), `IIHF shows ${k}`).toBe(true);
    expect(rows.some((r) => r.key === "draw"), "IIHF: no draw (IIHF has no draws)").toBe(false);

    const rec = reach(icehockey, cfg(icehockey, "recreational"));
    const recRows = pointsRows(rec, sportRule(icehockey, cfg(icehockey, "recreational")));
    expect(recRows.map((r) => r.key).sort()).toEqual([...rec].sort());
    expect(recRows.some((r) => r.key === "draw" && r.shown), "recreational: a draw row").toBe(true);
    expect(recRows.some((r) => /\.(ot|so)$/.test(r.key)), "and no overtime or shoot-out row").toBe(false);

    // The sweep: every division × table kind — one row per reachable outcome, none other, each once.
    let stages = 0;
    let rowsChecked = 0;
    for (const { m, variant, cfg: c } of DIVISIONS) {
      for (const kind of TABLE_KINDS) {
        const ctx = stagePointsContext(m, c, { kind, config: {} });
        if (ctx === null) continue;
        const want = reach(m, c, kind);
        const got = pointsRows(ctx.reachable, ctx.rule).map((r) => r.key);
        expect(got.length, `${m.key}/${variant} ${kind}: each outcome once`).toBe(new Set(got).size);
        expect([...got].sort(), `${m.key}/${variant} ${kind}`).toEqual([...want].sort());
        stages++;
        rowsChecked += got.length;
      }
    }
    expect(stages, "stages swept").toBeGreaterThan(DIVISIONS.length);
    expect(rowsChecked, "rows checked").toBeGreaterThan(stages * 2);
  });
});

describe("the shoot-out row (B2)", () => {
  it("B2 football/hockey SO row reads 'counts as a draw; the winner gets +soBonus'; ice hockey shows won/lost after a shoot-out", () => {
    // A football group stage with its shoot-out switched on (a stage-scope key, W2c).
    const fbRules = { shootout: true };
    const fbReach = reach(football, cfg(football, "11-a-side"), "group", { rules: fbRules });
    expect(fbReach, "premise: the engine says a group shoot-out is reachable").toEqual(expect.arrayContaining(["win.so", "loss.so", "draw"]));
    const fb = pointsRows(fbReach, sportRule(football, cfg(football, "11-a-side"), "group", { rules: fbRules }));
    const fbSo = fb.find((r) => r.key === "win.so")!;
    // B2: booked a draw (football's draw is 1), the shoot-out winner +1 by default.
    expect([fbSo.shown, fbSo.value, fbSo.drawPlusBonus], "one row: a draw (1), the winner +1").toEqual([true, 1, 1]);
    expect(fb.find((r) => r.key === "loss.so")!.shown, "the loser's half is the same row").toBe(false);

    // FIH Pro League (fih-shootout): draw 1, the winner +1 (D10(f), B2).
    const hkReach = reach(hockey, cfg(hockey, "fih-shootout"));
    const hk = pointsRows(hkReach, sportRule(hockey, cfg(hockey, "fih-shootout"))).find((r) => r.key === "win.so")!;
    expect([hk.value, hk.drawPlusBonus]).toEqual([1, 1]);

    // IIHF: a GWS pays the overtime values, 2 and 1 (RBG 3-2-1-0); no bonus, the loser has its own row.
    const ih = pointsRows(reach(icehockey, cfg(icehockey, "iihf")), sportRule(icehockey, cfg(icehockey, "iihf")));
    const won = ih.find((r) => r.key === "win.so")!;
    const lost = ih.find((r) => r.key === "loss.so")!;
    expect([won.value, won.drawPlusBonus, won.shown, won.fallback], "won after a shoot-out: 2, through the overtime value").toEqual([2, null, true, true]);
    expect([lost.value, lost.shown], "lost after a shoot-out: 1").toEqual([1, true]);
    // The positive pair for the bonus: a stated soBonus is read, never the default.
    const two = pointsRows(fbReach, { ...sportRule(football, cfg(football, "11-a-side"), "group", { rules: fbRules }), soBonus: 2 });
    expect(two.find((r) => r.key === "win.so")!.drawPlusBonus).toBe(2);
  });

  it("a draw-plus-bonus shoot-out with no draw payout is uncovered on its row (§5.3: a reachable so needs draw)", () => {
    const fbRules = { shootout: true };
    const r = sportRule(football, cfg(football, "11-a-side"), "group", { rules: fbRules });
    const noDraw: PointsRule = { ...r };
    delete (noDraw as { draw?: number }).draw;
    const rows = pointsRows(reach(football, cfg(football, "11-a-side"), "group", { rules: fbRules }), noDraw);
    expect(rows.find((x) => x.key === "win.so")!.value).toBeNull();
    expect(rows.find((x) => x.key === "draw")!.value).toBeNull();
  });
});

describe("set scores (D10(a), VB-PT-3)", () => {
  it("VB-PT-3 volleyball best of 5 shows one row per reachable set score; a two-pair map missing 3-1 marks it uncovered", () => {
    const vbReach = reach(volleyball, cfg(volleyball, "indoor"));
    const rows = pointsRows(vbReach, sportRule(volleyball, cfg(volleyball, "indoor")));
    const sets = rows.filter((r) => r.key.startsWith("set:") && r.shown);
    // FIVB / D10(a): 3-0 and 3-1 pay 3:0, 3-2 pays 2:1.
    expect(sets.map((r) => [r.key, r.pair])).toEqual([
      ["set:3-0", [3, 0]],
      ["set:3-1", [3, 0]],
      ["set:3-2", [2, 1]],
    ]);
    expect(rows.filter((r) => (r.key === "win.regulation" || r.key === "loss.regulation") && r.shown), "the set table is the whole payout: no plain win/loss row").toEqual([]);

    const missing: PointsRule = { ...sportRule(volleyball, cfg(volleyball, "indoor")), bySetScore: { "3-0": [3, 0], "3-2": [2, 1] } };
    const gap = pointsRows(vbReach, missing).find((r) => r.key === "set:3-1")!;
    expect([gap.value, gap.pair], "3-1 is uncovered").toEqual([null, null]);
    expect(coverage(missing, new Set(vbReach)), "the engine agrees").toEqual({ ok: false, uncovered: ["set:3-1"], inapplicable: [] });
    // The "*" guard: "*" never counts toward a map that pays two pairs.
    const star: PointsRule = { ...missing, bySetScore: { "*": [3, 0], "3-2": [2, 1] } };
    expect(pointsRows(vbReach, star).find((r) => r.key === "set:3-1")!.value, "'*' does not cover a two-pair map").toBeNull();
    // A one-pair map is flat and covers every score (the positive pair).
    const flat: PointsRule = { ...missing, bySetScore: { "*": [2, 0] } };
    const all = pointsRows(vbReach, flat).filter((r) => r.key.startsWith("set:"));
    expect(all.every((r) => r.fallback && r.pair?.[0] === 2 && r.pair[1] === 0)).toBe(true);
  });

  it("a set sport whose rule pays no set table (table tennis) shows no set rows — its win and loss pay every score", () => {
    const tt = pointsRows(reach(tabletennis, cfg(tabletennis, "bo5")), sportRule(tabletennis, cfg(tabletennis, "bo5")));
    expect(tt.filter((r) => r.key.startsWith("set:")).length, "premise: the set scores are reachable").toBe(3);
    expect(tt.filter((r) => r.key.startsWith("set:") && r.shown)).toEqual([]);
    expect(tt.find((r) => r.key === "win.regulation")!.shown).toBe(true);
  });
});

describe("sport rows", () => {
  it("cricket shows tie and no result; TT shows 'a loss not played'", () => {
    const cr = pointsRows(reach(cricket, cfg(cricket, "t20")), sportRule(cricket, cfg(cricket, "t20")));
    // ICC playing conditions: a tie and a no result pay each side 1.
    expect(cr.find((r) => r.key === "tie")).toMatchObject({ value: 1, shown: true });
    expect(cr.find((r) => r.key === "noResult")).toMatchObject({ value: 1, shown: true, fallback: false });
    expect(cr.some((r) => r.key === "loss.unplayed")).toBe(false);
    const tt = pointsRows(reach(tabletennis, cfg(tabletennis, "bo5")), sportRule(tabletennis, cfg(tabletennis, "bo5")));
    // ITTF 3.7.5.1 (D6): a played loss pays 1, a loss not played 0.
    expect(tt.find((r) => r.key === "loss.regulation")).toMatchObject({ value: 1 });
    expect(tt.find((r) => r.key === "loss.unplayed")).toMatchObject({ value: 0, shown: true, fallback: false });
    expect(tt.some((r) => r.key === "tie" || r.key === "noResult")).toBe(false);
  });

  it("chess presets 1/½/0 and 3/1/0 on a round robin; 3/1/0 absent on Swiss", () => {
    const rr = pointsPresets(boardgame, "league");
    expect(rr.map((p) => p.id)).toEqual(["fide_1_half_0", "three_one_zero"]);
    // FIDE 1/½/0 in half-points (unit "half": 2/1/0 stored); RB2B-18's 3/1/0 in whole points.
    expect(rr[0]!.rule).toMatchObject({ win: { regulation: 2 }, draw: 1, loss: { regulation: 0 }, unit: "half" });
    expect(rr[1]!.rule).toMatchObject({ win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, unit: "whole" });
    expect(pointsPresets(boardgame, "swiss").map((p) => p.id), "a Swiss stage pairs on the score: no 3/1/0").toEqual(["fide_1_half_0"]);
    expect(pointsPresets(hockey, "league").map((p) => p.id), "hockey: Pro League").toEqual(["pro_league"]);
    expect(pointsPresets(football, "league"), "a sport with no presets offers none").toEqual([]);
    expect(pointsPresets(boardgame, "knockout"), "a bracket kind has no table").toEqual([]);
  });

  it("a preset chip is active exactly when the draft's rule IS the preset", () => {
    const kind = "league";
    const stage = { kind, config: {} };
    const [fide, three] = pointsPresets(boardgame, kind);
    const draft = { ...draftFromStored(boardgame, cfg(boardgame, "classical"), fide!.rule, null, stage) };
    expect(presetActive(boardgame, draft, fide!.rule)).toBe(true);
    expect(presetActive(boardgame, draft, three!.rule)).toBe(false);
    expect(presetActive(boardgame, { ...draft, win: "9" }, fide!.rule), "edited away from it").toBe(false);
  });
});

describe("the editor says every split (carry: the T10 'not yet' state is gone)", () => {
  it("round trip on every division × table kind: the editor opened on the sport's own points builds a rule that pays every reachable outcome as the sport does, which the server's flat-over-split guard accepts", () => {
    let checked = 0;
    let split = 0;
    for (const { m, variant, cfg: c } of DIVISIONS) {
      for (const kind of TABLE_KINDS) {
        const stage = { kind, config: {} };
        const ctx = stagePointsContext(m, c, stage);
        if (ctx === null) continue;
        const opened = draftFromStored(m, c, null, null, stage);
        expect(opened.useDivision, `${m.key}/${variant} ${kind}: nothing stored, it inherits`).toBe(true);
        const built = ruleFromDraft(m, { ...opened, useDivision: false });
        expect(built.ok, `${m.key}/${variant} ${kind}: the opened draft is a rule`).toBe(true);
        if (!built.ok || built.rule === null) continue;
        const sportOwn = sportStageRule(m, liveStageCfg(c, stage, m), kind)!;
        expect(splitsLost(m, sportOwn, built.rule).differs, `${m.key}/${variant} ${kind}: pays as the sport pays`).toBe(false);
        expect(flattenedSplits(m, liveStageCfg(c, stage, m), kind, built.rule), `${m.key}/${variant} ${kind}: the server's N2 guard takes it`).toEqual([]);
        expect(coverage(built.rule, new Set(ctx.reachable)), `${m.key}/${variant} ${kind}: covered`).toEqual({ ok: true });
        expect(draftRefusal(m, c, stage, { ...opened, useDivision: false }), `${m.key}/${variant} ${kind}: nothing to refuse`).toBeNull();
        // The same rule STORED as the stage's own opens unchanged: an untouched section offers no Save (jsonb-safe compare).
        const own = draftFromStored(m, c, sportOwn.rule, null, stage);
        expect(own.useDivision, `${m.key}/${variant} ${kind}: an own rule opens as own`).toBe(false);
        expect(draftIsDirty(m, own, sportOwn.rule), `${m.key}/${variant} ${kind}: opened own rule is not dirty`).toBe(false);
        if (sportOwn.rule.win.ot !== undefined || sportOwn.rule.loss.unplayed !== undefined || sportOwn.rule.bySetScore !== undefined || sportOwn.rule.tie !== undefined) split++;
        checked++;
      }
    }
    expect(checked, "stages swept").toBeGreaterThan(DIVISIONS.length);
    expect(split, "including the divisions the rulebooks split (IIHF, FIVB, ICC, ITTF)").toBeGreaterThan(10);
  });

  it("carry (T10): the volleyball indoor editor opens with its set scores, never blank", () => {
    const d = draftFromStored(volleyball, cfg(volleyball, "indoor"), null, null, { kind: "league", config: {} });
    expect(d.sets).toEqual({ "3-0": ["3", "0"], "3-1": ["3", "0"], "3-2": ["2", "1"] });
    // A second open answers the same (pure).
    expect(draftFromStored(volleyball, cfg(volleyball, "indoor"), null, null, { kind: "league", config: {} }).sets).toEqual(d.sets);
  });

  it("a blank row pays its fallback; a reachable draw left blank is uncovered; TT's 'loss not played' left blank flattens the split (the server's words, inline)", () => {
    const stage = { kind: "league", config: {} };
    const ih = { ...draftFromStored(icehockey, cfg(icehockey, "iihf"), null, null, stage), useDivision: false };
    const noSo = ruleFromDraft(icehockey, { ...ih, winSo: "", lossSo: "" });
    expect(noSo.ok && noSo.rule?.win.so === undefined, "blank: no `so` (it falls back to overtime)").toBe(true);

    const fb = { ...draftFromStored(football, cfg(football, "11-a-side"), null, null, stage), useDivision: false };
    expect(draftRefusal(football, cfg(football, "11-a-side"), stage, { ...fb, draw: "" })).toEqual({ code: "POINTS_OUTCOME_UNCOVERED", uncovered: ["draw"] });

    const tt = { ...draftFromStored(tabletennis, cfg(tabletennis, "bo5"), null, null, stage), useDivision: false };
    expect(tt.lossUnplayed, "premise: ITTF's 0 is prefilled").toBe("0");
    expect(draftRefusal(tabletennis, cfg(tabletennis, "bo5"), stage, { ...tt, lossUnplayed: "" })).toEqual({ code: "POINTS_SPLIT_FLATTENED", splits: ["unplayed"] });
    expect(draftRefusal(tabletennis, cfg(tabletennis, "bo5"), stage, { ...tt, lossUnplayed: "1" }), "a stated 1 is the organiser's own split: taken").toBeNull();
  });

  it("chess: the boxes show points (1 / 0.5 / 0), the rule stores half-points (2 / 1 / 0)", () => {
    const stage = { kind: "league", config: {} };
    const d = draftFromStored(boardgame, cfg(boardgame, "classical"), null, null, stage);
    expect([d.win, d.draw, d.loss]).toEqual(["1", "0.5", "0"]);
    const built = ruleFromDraft(boardgame, { ...d, useDivision: false });
    expect(built.ok && built.rule).toMatchObject({ win: { regulation: 2 }, draw: 1, loss: { regulation: 0 }, unit: "half" });
    // The positive pair: a stored 1 / ½ / 0 opened and changed to 1 / 1 / 0 IS dirty, and stores 2 / 2 / 0.
    const own = draftFromStored(boardgame, cfg(boardgame, "classical"), built.ok ? built.rule : null, null, stage);
    expect(draftIsDirty(boardgame, own, built.ok ? built.rule : null)).toBe(false);
    expect(draftIsDirty(boardgame, { ...own, draw: "1" }, built.ok ? built.rule : null)).toBe(true);
    const more = ruleFromDraft(boardgame, { ...own, draw: "1" });
    expect(more.ok && more.rule?.draw).toBe(2);
  });

  it("a set score needs both numbers or neither", () => {
    const stage = { kind: "league", config: {} };
    const d: PointsDraft = { ...draftFromStored(volleyball, cfg(volleyball, "indoor"), null, null, stage), useDivision: false };
    expect(ruleFromDraft(volleyball, { ...d, sets: { ...d.sets, "3-2": ["2", ""] } })).toEqual({ ok: false, problem: "set" });
    const cleared = ruleFromDraft(volleyball, { ...d, sets: { ...d.sets, "3-2": ["", ""] } });
    // A cleared row pays what its placeholder shows: the win and loss (3 / 0), written out (the "*" guard).
    expect(cleared.ok && cleared.rule?.bySetScore).toEqual({ "3-0": [3, 0], "3-1": [3, 0], "3-2": [3, 0] });
  });
});

describe("the retired notice stays retired", () => {
  it("W2c's inexpressible notice stays gone: no key POINTS_RULE_INEXPRESSIBLE is referenced (source scan of stage-rules/, files scanned > 0) — green from Step 2 on, because Task 10 deleted it; kept as the guard", () => {
    const dir = join(__dirname, "..");
    const retired = ["POINTS_RULE", "INEXPRESSIBLE"].join("_");
    let scanned = 0;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!statSync(path).isFile() || !/\.(ts|tsx)$/.test(name)) continue;
      expect(readFileSync(path, "utf8").includes(retired), name).toBe(false);
      scanned++;
    }
    expect(scanned, "files scanned").toBeGreaterThan(3);
  });
});
