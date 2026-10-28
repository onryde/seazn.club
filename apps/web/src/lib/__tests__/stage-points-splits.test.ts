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
import { flatOf, flattenedSplits, isFlatRule, sportPointsSplits } from "../stage-points-splits";

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

// W2d Task 13 (N2, N3; orchestrator ruling): the server asks the RULE SENT, not only the sport; one that flattens a split
// is refused naming the sport's splits (the wire `sportPointsSplits` has always named). Fix round 1 (I1): N2's premise —
// that a flat rule can pay a split sport as the sport does — is false. ITTF's 2/1 with a `forfeit` row paying the walkover
// 2/0 looked equal, but the row reaches only the walkover: a retirement AFTER play pays the flat rule's loss (1), where
// ITTF pays the retired loser 0 (rulebook-W2-sets-cricket.md:218-221, spec D6). So it is refused too.
const ITTF_EQUAL: PointsRule = { win: { regulation: 2 }, loss: { regulation: 1 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } };

describe("flattenedSplits: the splits a flat rule SENT would flatten (N2, N3)", () => {
  it("sweep: the sport's own rule made flat is refused naming the rulebook's splits — so is the closest flat rule (a forfeit row paying the walkover as the sport does, I1) — and accepted where the rulebook names none; the sport's own rule (its splits stated) is never refused (counted)", () => {
    let checked = 0;
    let refused = 0;
    for (const { m, variant } of DIVISIONS) {
      const want = (RULEBOOK_SPLITS[`${m.key}/${variant}`] ?? []).filter((r) => !LEVEL.has(r));
      const cfg = m.configSchema.parse(m.variants[variant]);
      for (const kind of TABLE_KINDS) {
        const own = m.tablePointsRule(cfg, kind as StageKind);
        expect(flattenedSplits(m, cfg, kind, flatOf(own)), `${m.key}/${variant} ${kind}: flattened`).toEqual(want);
        // The closest a flat rule comes: the sport's amounts, and a forfeit row paying the walkover the sport's way.
        const closest: PointsRule = { ...flatOf(own), forfeit: { winnerPoints: own.win.regulation, loserPoints: own.loss.unplayed ?? own.loss.regulation } };
        expect(flattenedSplits(m, cfg, kind, closest), `${m.key}/${variant} ${kind}: closest flat`).toEqual(want);
        if (!isFlatRule(own)) expect(flattenedSplits(m, cfg, kind, own), `${m.key}/${variant} ${kind}: stated`).toEqual([]);
        if (want.length > 0) refused++;
        checked++;
      }
    }
    expect(checked, "every division × every table kind").toBe(DIVISIONS.length * TABLE_KINDS.length);
    expect(refused, "the refusals were reached").toBeGreaterThan(0);
    expect(checked - refused, "and the acceptances").toBeGreaterThan(0);
  });

  it("ITTF: a flat 2/1 is refused ['unplayed'] on every table-tennis format and table kind even with a forfeit row paying the walkover 2/0 — a retirement after play pays it the flat loss (I1); the rule stating loss.unplayed 0 is accepted (counted)", () => {
    // single-sport: table tennis is the one rulebook split (a loss not played) a forfeit row seems to pay whole.
    const tt = builtinModules.find((m) => m.key === "tabletennis") as AnySportModule;
    let checked = 0;
    for (const variant of Object.keys(tt.variants)) {
      expect(RULEBOOK_SPLITS[`tabletennis/${variant}`], `premise: ${variant} splits the loss not played`).toEqual(["unplayed"]);
      const cfg = tt.configSchema.parse(tt.variants[variant]);
      for (const kind of TABLE_KINDS) {
        // The split the ENGINE declares for this stage, not this helper's answer: a loss not played paid apart.
        const declared = tt.tablePointsRule(cfg, kind as StageKind);
        expect(declared.loss.unplayed, `premise: ${variant} ${kind} declares the loss not played`).toBeDefined();
        expect(declared.loss.unplayed, `premise: ${variant} ${kind} pays it apart`).not.toBe(declared.loss.regulation);
        expect(isFlatRule(ITTF_EQUAL), "premise: the rule is flat").toBe(true);
        expect(flattenedSplits(tt, cfg, kind, ITTF_EQUAL), `${variant} ${kind}: the retired loser is paid 1, not 0`).toEqual(["unplayed"]);
        const noRow: PointsRule = { ...ITTF_EQUAL, forfeit: undefined };
        expect(flattenedSplits(tt, cfg, kind, noRow), `${variant} ${kind}: no forfeit row`).toEqual(["unplayed"]);
        expect(flattenedSplits(tt, cfg, kind, { ...ITTF_EQUAL, forfeit: { winnerPoints: 3, loserPoints: 0 } }), `${variant} ${kind}: 3/0`).toEqual(["unplayed"]);
        const stated: PointsRule = { ...ITTF_EQUAL, loss: { regulation: declared.loss.regulation, unplayed: declared.loss.unplayed } };
        expect(isFlatRule(stated), "premise: stating the loss not played is not flat").toBe(false);
        expect(flattenedSplits(tt, cfg, kind, stated), `${variant} ${kind}: stated`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBe(Object.keys(tt.variants).length * TABLE_KINDS.length);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
  });

  it("another sport: no flat rule pays IIHF's overtime 2/1 — IIHF-equal amounts on regulation still flatten it; a flat sport takes any flat rule; nothing to ask is never a refusal", () => {
    const ih = builtinModules.find((m) => m.key === "icehockey") as AnySportModule;
    const g = builtinModules.find((m) => m.key === "generic") as AnySportModule;
    expect(flattenedSplits(ih, ih.variants.iihf, "league", { ...FLAT, win: { regulation: 3 }, loss: { regulation: 0 } })).toEqual(["otWin", "otLoss"]);
    expect(flattenedSplits(ih, ih.variants.iihf, "league", { ...FLAT, win: { regulation: 2 }, loss: { regulation: 1 } }), "OT's 2/1 everywhere").toEqual(["otWin", "otLoss"]);
    expect(flattenedSplits(g, g.variants.score, "league", { ...FLAT, win: { regulation: 7 } }), "generic pays nothing apart").toEqual([]);
    // A rule that STATES its splits is the caller's choice, never refused for them — even paying other amounts than IIHF's.
    const stated: PointsRule = { ...FLAT, win: { regulation: 3, ot: 6, so: 9 }, loss: { regulation: 0, ot: 4, so: 7 } };
    expect(isFlatRule(stated), "premise: not flat").toBe(false);
    expect(flattenedSplits(ih, ih.variants.iihf, "league", stated), "stated, other amounts").toEqual([]);
    expect(flattenedSplits(ih, ih.variants.iihf, "knockout", FLAT), "a bracket kind").toEqual([]);
    expect(flattenedSplits(ih, { periods: "many" }, "league", FLAT), "a cfg the schema refuses").toEqual([]);
  });

  it("the split is asked of what the rule PAYS, not of its shape: a set table stating a regulation amount no reachable outcome is paid takes the flat rule paying its set scores (a contrived module: no shipped split is one)", () => {
    // single-sport: volleyball beach's table pays every set score 2/0 (FIVB beach); the contrived sport adds a regulation
    // win of 9 that no reachable result is paid by, so its own rule made flat (9/0) flattens it, and a flat 2/0 does not.
    const vb = builtinModules.find((m) => m.key === "volleyball") as AnySportModule;
    const contrived: AnySportModule = { ...vb, tablePointsRule: (cfg, kind) => ({ ...vb.tablePointsRule(cfg, kind), win: { regulation: 9 } }) };
    const cfg = vb.configSchema.parse(vb.variants.beach);
    expect(sportPointsSplits(contrived, cfg, "league"), "premise: its own rule made flat flattens the set table").toEqual(["pointsMap"]);
    expect(flattenedSplits(contrived, cfg, "league", { ...FLAT, win: { regulation: 2 }, loss: { regulation: 0 }, draw: undefined }), "pays as it does").toEqual([]);
    expect(flattenedSplits(contrived, cfg, "league", { ...FLAT, win: { regulation: 3 }, loss: { regulation: 0 }, draw: undefined }), "pays 3, not 2").toEqual(["pointsMap"]);
  });

  it("a sport whose own rule carries a forfeit row still splits the loss not played: the after-play award names it 'unplayed' (contrived: no shipped sport has both, I1)", () => {
    // single-sport: table tennis declares the loss not played (ITTF 2/1/0); the contrived sport adds a forfeit row paying
    // the walkover as it does, so only a retirement after play is paid apart from a flat rule — and still named.
    const tt = builtinModules.find((m) => m.key === "tabletennis") as AnySportModule;
    const cfg = tt.configSchema.parse(tt.variants.bo5);
    const own = tt.tablePointsRule(cfg, "league");
    expect(own.loss.unplayed, "premise: declared apart").not.toBe(own.loss.regulation);
    const row = { winnerPoints: own.win.regulation, loserPoints: own.loss.unplayed! };
    const contrived: AnySportModule = { ...tt, tablePointsRule: (c, kind) => ({ ...tt.tablePointsRule(c, kind), forfeit: row }) };
    expect(sportPointsSplits(contrived, cfg, "league")).toEqual(["unplayed"]);
    expect(flattenedSplits(contrived, cfg, "league", { ...ITTF_EQUAL, forfeit: row }), "the flat rule with the same row").toEqual(["unplayed"]);
  });
});
