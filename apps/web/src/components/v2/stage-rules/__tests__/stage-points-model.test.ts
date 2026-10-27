// W2c Task 18 (review I9) - the decisions the stage points section makes live in a pure helper with unit killers, never in
// a browser. Expected values come from the SERVER's own door (`refuseStagePoints`) and the engine's declarations
// (`pointsRuleAwardReachesTable`, `validatePointsRule`, `payout`), never from a table typed here; every sweep reports how
// many items it checked and zero is a failure. W2d Task 10 (spec §5.3, §11 "W2c's inexpressible card is deleted"): Q1's
// pre-check and its "inexpressible" section state are retired with the engine's expressibility check — every
// division opens the editor, and what a rule does not pay is the server's coverage refusal (POINTS_OUTCOME_UNCOVERED).
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { StageKind } from "@seazn/engine/core";
import { PointsRule, legacyPointsRule, payout, pointsRuleAwardReachesTable } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { refuseStagePoints } from "@/server/usecases/stage-rules-merge";
import { pointsLine } from "@/lib/points-line";
import {
  BONUS_KINDS,
  PARAM_BONUS_KINDS,
  divisionBasePoints,
  draftFromStored,
  draftIsDirty,
  offeredBonusKinds,
  offersWalkoverScore,
  parseNumber,
  pinInForce,
  pointsBasis,
  pointsEditorFits,
  previewClauses,
  ruleFromDraft,
  stageTakesPoints,
  storedPointsRule,
  type PointsDraft,
} from "../stage-points-model";
import { RULEBOOK_SPLITS, TABLE_KINDS } from "./_points-split-rulebook";

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
const generic = sport("generic");
const badminton = sport("badminton");
const football = sport("football");

/** Every (sport, variant, division config) the registry ships: the config a division of that variant stores. */
const DIVISIONS = builtinModules.flatMap((m) => Object.keys(m.variants).map((variant) => ({ m, variant, cfg: m.variants[variant] as Record<string, unknown> })));

/** The division's config as the sport reads it (its schema's defaults filled), and whether its points map pays more than one
 *  pair - read off the config, never off the helper under test. */
const parsedCfg = (m: AnySportModule, cfg: unknown): Record<string, unknown> => m.configSchema.parse(cfg) as Record<string, unknown>;
const twoPairMap = (m: AnySportModule, cfg: unknown): boolean => {
  const map = parsedCfg(m, cfg).pointsMap;
  return typeof map === "object" && map !== null && new Set(Object.values(map).map((v) => JSON.stringify(v))).size > 1;
};

/** The server's answer to a rule on a league stage: undefined when it takes it, else the refusal's code/field. W2d T10: the
 *  door no longer reads the division's config (Q1 retired); `cfg` stays in the signature so each sweep names its division. */
function serverAnswer(m: AnySportModule, _cfg: unknown, rule: PointsRule, kind: StageKind = "league"): { code?: string; field?: string } | undefined {
  try {
    refuseStagePoints(m, kind, rule);
    return undefined;
  } catch (e) {
    const err = e as { code?: string; extra?: { field?: string }; message: string };
    return { code: err.code, field: err.extra?.field };
  }
}

/** A W2c `base`: what a stored pre-W2d row carries (read through `legacyPointsRule`). */
const BASE = { win: 3, draw: 1, loss: 0 };
/** W2d: the editor's three boxes as the outcome-keyed rule it saves — the engine's own reading of the W2c rule
 *  (`legacyPointsRule`), never a shape typed here. */
const editorRule = (win: number, draw: number, loss: number): PointsRule => legacyPointsRule({ base: { win, draw, loss } });
const plain = (): PointsRule => editorRule(BASE.win, BASE.draw, BASE.loss);

describe("stage points model (I9 killers for t18)", () => {
  it("W2d T10: the server's points door (`refuseStagePoints`: the kind and metrics questions) takes the plain rule on every division the registry ships (counted); which divisions keep the EDITOR is `pointsEditorFits`'s (fix round 1 I2, below)", () => {
    // The W2c answer was "inexpressible" for ice hockey, hockey's shoot-out, cricket and indoor volleyball (Q1), asked by
    // this door. W2d retired that question here (spec §5.3: those divisions' points are outcome-keyed now); the door asks
    // only what a rule is on any division. Fix round 1 I2 (owner 2026-10-26) keeps the editor's own "not yet" state, and the
    // stage save's flat-over-split refusal, beside it (`table-rule-guards.ts`): neither is this door. The sweep counts the
    // divisions W2c split, by their own config, so it witnesses them.
    let swept = 0;
    let wasSplit = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      expect(serverAnswer(m, cfg, plain()), `${m.key}/${variant}: the door takes the editor's rule`).toBeUndefined();
      const c = parsedCfg(m, cfg);
      const pts = (typeof c.points === "object" && c.points !== null ? c.points : {}) as Record<string, unknown>;
      if (twoPairMap(m, cfg) || ["otWin", "otLoss", "soBonus", "tie", "noResult"].some((k) => k in pts)) wasSplit++;
      swept++;
    }
    expect(swept, "every division swept").toBe(DIVISIONS.length);
    expect(wasSplit, "and some of them are ones W2c kept out of the editor").toBeGreaterThan(0);
  });

  it("the section is mounted on table stages only: the server's own door refuses every other kind (sweep of every StageKind)", () => {
    let checked = 0;
    let tables = 0;
    for (const kind of StageKind.options) {
      const refused = serverAnswer(generic, { resultMode: "win_loss", allowDraws: true, points: { w: 3, d: 1, l: 0 } }, plain(), kind);
      const serverTakes = refused === undefined || refused.field !== "points";
      expect(stageTakesPoints(kind), `${kind}: the section follows the server`).toBe(serverTakes);
      if (stageTakesPoints(kind)) tables++;
      checked++;
    }
    expect(checked, "every stage kind").toBe(StageKind.options.length);
    expect(tables, "and some of them are table kinds").toBeGreaterThan(0);
    expect(tables, "and some are not").toBeLessThan(checked);
  });

  it("I3: the walkover SCORE is offered exactly where the server accepts it, for every sport and variant (set sports, goal sports, both)", () => {
    let checked = 0;
    let offered = 0;
    let hidden = 0;
    const withScore: PointsRule = { ...plain(), forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [3, 0] } };
    for (const { m, variant, cfg } of DIVISIONS) {
      // W2d T10: no division is skipped as inexpressible any more (Q1 retired); every one is checked.
      const answer = serverAnswer(m, cfg, withScore);
      const serverRefusesScore = answer?.field === "points.forfeit.awardScore";
      expect(offersWalkoverScore(m), `${m.key}/${variant}: the input is shown iff the server takes the score`).toBe(!serverRefusesScore);
      expect(offersWalkoverScore(m), `${m.key}/${variant}: the engine's declaration`).toBe(pointsRuleAwardReachesTable(m));
      if (offersWalkoverScore(m)) offered++;
      else hidden++;
      checked++;
    }
    expect(checked, "every division is checked").toBe(DIVISIONS.length);
    expect(offered, "goal sports reach the table").toBeGreaterThan(0);
    expect(hidden, "set sports, carrom and the board games do not").toBeGreaterThan(0);
  });

  it("every rule the section builds is one the server takes: every division, with a walkover pair, a score, and every offered bonus kind", () => {
    let saved = 0;
    let blank = 0;
    let bonusesChecked = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      const draft = draftFromStored(m, cfg, null);
      if (draft.win === "") {
        // W2d T10: a division whose map pays two different pairs has no one win to start from, so the boxes open blank (the
        // organiser types them; a blank box is not zero, below). Counted, and only for such a map, from its own config.
        expect(twoPairMap(m, cfg), `${m.key}/${variant}: blank only for a two-pair map`).toBe(true);
        blank++;
        continue;
      }
      const offered = offeredBonusKinds(m, cfg);
      const filled: PointsDraft = {
        ...draft,
        useDivision: false,
        walkoverW: "4",
        walkoverL: "1",
        awardW: "7",
        awardL: "0",
        bonuses: offered.map((when) => ({ when, param: "2", points: "1" })),
      };
      const built = ruleFromDraft(m, filled);
      expect(built.ok, `${m.key}/${variant}: the filled draft is a rule`).toBe(true);
      if (!built.ok || built.rule === null) continue;
      expect(serverAnswer(m, cfg, built.rule), `${m.key}/${variant}: the server takes what the section sends`).toBeUndefined();
      expect(built.rule.forfeit?.awardScore !== undefined, `${m.key}/${variant}: the score leaves only where the table reads it`).toBe(offersWalkoverScore(m));
      saved++;
      bonusesChecked += built.rule.bonuses.length;
    }
    expect(saved + blank, "every division swept").toBe(DIVISIONS.length);
    expect(saved, "divisions saved").toBeGreaterThan(10);
    expect(bonusesChecked, "bonus rows swept").toBeGreaterThan(0);
  });

  it("the bonus kinds offered are the ones the server's metrics check takes; a margin bonus on a sport with no scores is refused by the server and not offered", () => {
    let withMargins = 0;
    let without = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      const offered = new Set(offeredBonusKinds(m, cfg));
      for (const when of PARAM_BONUS_KINDS) {
        const answer = serverAnswer(m, cfg, { ...plain(), bonuses: [{ when, param: 1, points: 1 }] });
        expect(offered.has(when), `${m.key}/${variant}: ${when} offered iff the server takes it (${JSON.stringify(answer)})`).toBe(answer === undefined);
      }
      if (offered.has("loss_margin_lte")) withMargins++;
      else without++;
    }
    expect(withMargins, "generic has for/against").toBeGreaterThan(0);
    // W2d F11: football's gd / ga / gf is a score now (tiebreakers.ts aliases), so only the sports with none are left.
    expect(without, "badminton emits no score").toBeGreaterThan(0);
  });

  it("a draw bonus is offered only where the sport can draw; a no-result bonus only where the sport records one; the rest everywhere", () => {
    expect(offeredBonusKinds(football, football.variants["11-a-side"]), "football draws").toContain("draw");
    expect(offeredBonusKinds(badminton, badminton.variants.bwf), "badminton cannot draw").not.toContain("draw");
    // W2d T10: cricket reaches this editor now (Q1 retired), and it records a no-result: offered exactly where the sport
    // declares the metric, on both sides of the line.
    let recordsNr = 0;
    let none = 0;
    for (const { m, cfg } of DIVISIONS) {
      expect(offeredBonusKinds(m, cfg), `${m.key}: a walkover bonus is a bonus on every sport`).toEqual(expect.arrayContaining(["forfeit_win", "forfeit_loss"]));
      const declares = m.metrics.some((k) => k.key === "no_results");
      expect(offeredBonusKinds(m, cfg).includes("no_result"), `${m.key}: a no-result bonus iff the sport records one`).toBe(declares);
      if (declares) recordsNr++;
      else none++;
    }
    expect(recordsNr, "cricket records a no-result").toBeGreaterThan(0);
    expect(none, "and most sports do not").toBeGreaterThan(0);
  });

  it("the kinds that read a threshold are the ones the engine's fold reads it for (probe over the engine's own payout)", () => {
    const winner = { entrantId: "a", played: 1, won: 1, drawn: 0, lost: 0, points: 0, metrics: { for: 5, against: 3, diff: 2 } };
    const loser = { entrantId: "b", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: { for: 3, against: 5, diff: -2 } };
    const drawn = [{ ...winner, won: 0, drawn: 1, metrics: { for: 2, against: 2, diff: 0 } }, { ...loser, lost: 0, drawn: 1, metrics: { for: 2, against: 2, diff: 0 } }];
    const probes = [
      { outcome: { kind: "win", winner: "a", loser: "b" } as const, pair: [winner, loser], played: true },
      { outcome: { kind: "draw" } as const, pair: drawn, played: true },
      { outcome: { kind: "no_result" } as const, pair: drawn, played: true },
      { outcome: { kind: "award", winner: "a", loser: "b", reason: "walkover" } as const, pair: [winner, loser], played: false },
    ];
    const pointsFor = (when: PointsRule["bonuses"][number]["when"], param: number): number[] =>
      probes.flatMap((p) =>
        (payout(p.outcome, p.outcome.kind === "win" ? "regulation" : null, p.pair as never, p.played, { ...plain(), bonuses: [{ when, param, points: 1 }] }, undefined, undefined) as unknown as { points: number }[]).map((d) => d.points),
      );
    const reading = BONUS_KINDS.filter((when) => JSON.stringify(pointsFor(when, 0)) !== JSON.stringify(pointsFor(when, 1000)));
    expect(BONUS_KINDS.length, "the engine's enum has its kinds").toBe(7);
    expect([...reading].sort()).toEqual([...PARAM_BONUS_KINDS].sort());
    expect(reading.length, "and the probe saw some").toBeGreaterThan(0);
    expect(reading.length, "and not all").toBeLessThan(BONUS_KINDS.length);
  });

  it("the division's base numbers: what the sport pays, from its own config (rulebook spot checks), and never invented", () => {
    const b = (m: AnySportModule, v: string) => divisionBasePoints(m, m.variants[v]);
    expect(b(football, "11-a-side")).toEqual({ win: 3, draw: 1, loss: 0 });
    expect(b(generic, "win_loss"), "generic writes w/d/l").toEqual({ win: 3, draw: 1, loss: 0 });
    expect(b(badminton, "bwf"), "a set sport's one-pair map; no draw").toEqual({ win: 2, draw: null, loss: 0 });
    expect(b(sport("tennis"), "tour"), "tennis pays win and loss").toEqual({ win: 2, draw: null, loss: 0 });
    expect(b(sport("boardgame"), "classical"), "chess keeps `scoring` (half-points)").toEqual({ win: 2, draw: 1, loss: 0 });
    let swept = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      if (twoPairMap(m, cfg)) continue; // below
      const base = divisionBasePoints(m, cfg);
      expect(base.win, `${m.key}/${variant}: a win`).not.toBeNull();
      expect(base.loss, `${m.key}/${variant}: a loss`).not.toBeNull();
      swept++;
    }
    expect(swept).toBeGreaterThan(10);
    // A pointsMap that pays TWO different pairs has no one win / loss: null, never the first pair's numbers. (W2d T10: such a
    // division reaches the editor now, which opens blank on it - a base invented from one of two pairs would be a lie.)
    expect(divisionBasePoints(badminton, { pointsMap: { "2-0": [3, 0], "2-1": [2, 1] } })).toEqual({ win: null, draw: null, loss: null });
    expect(divisionBasePoints(badminton, { pointsMap: { "2-0": [3, 0], "2-1": [3, 0] } }), "the same pair twice is one pair").toEqual({ win: 3, draw: null, loss: 0 });
  });

  it("an unchecked 'Use the division's points' starts from the division's numbers, and a sport that cannot draw sends draw 0", () => {
    const d = draftFromStored(badminton, badminton.variants.bwf, null);
    expect(d).toMatchObject({ useDivision: true, win: "2", draw: "0", loss: "0" });
    const built = ruleFromDraft(badminton, { ...d, useDivision: false });
    expect(built).toEqual({ ok: true, rule: editorRule(2, 0, 0) });
  });

  it("round trip: a stored rule opens as the draft that rebuilds it (key order is not part of it)", () => {
    const rules: [AnySportModule, PointsRule][] = [
      [football, { ...plain(), forfeit: { winnerPoints: 4, loserPoints: 1, awardScore: [3, 0] } }],
      [generic, { ...editorRule(2.5, 1, -1), bonuses: [{ points: 1, when: "loss_margin_lte", param: 7 }, { when: "forfeit_loss", points: -1 }], forfeit: { loserPoints: 0, winnerPoints: 3 } }],
      [badminton, { ...editorRule(2, 0, 0), forfeit: { winnerPoints: 3, loserPoints: 1 } }],
    ];
    for (const [m, rule] of rules) {
      const draft = draftFromStored(m, {}, rule);
      expect(draft.useDivision).toBe(false);
      const out = ruleFromDraft(m, draft);
      expect(out.ok && out.rule !== null && !draftIsDirty(m, draft, rule), `${m.key}: not dirty after opening`).toBe(true);
      expect(JSON.parse(JSON.stringify(out.ok ? out.rule : null))).toEqual(JSON.parse(JSON.stringify(PointsRule.parse(rule))));
    }
  });

  it("a blank box is not zero; zero is a number; a word is neither (the Number('') trap)", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("   ")).toBeNull();
    expect(parseNumber("0")).toBe(0);
    expect(parseNumber("-1.5")).toBe(-1.5);
    expect(parseNumber("abc")).toBeNull();
    const d = { ...draftFromStored(football, football.variants["11-a-side"], null), useDivision: false };
    expect(ruleFromDraft(football, { ...d, loss: "" })).toEqual({ ok: false, problem: "number" });
    expect(ruleFromDraft(football, { ...d, loss: "0" }).ok).toBe(true);
  });

  it("the walkover row is both numbers or neither; a score alone pays the base win and loss; the score never leaves a sport that does not read it", () => {
    const d = { ...draftFromStored(football, football.variants["11-a-side"], null), useDivision: false };
    expect(ruleFromDraft(football, d)).toMatchObject({ ok: true, rule: { win: { regulation: BASE.win }, draw: BASE.draw, loss: { regulation: BASE.loss } } });
    expect((ruleFromDraft(football, d) as { rule: PointsRule }).rule.forfeit, "no walkover row by default").toBeUndefined();
    expect(ruleFromDraft(football, { ...d, walkoverW: "4" })).toEqual({ ok: false, problem: "walkover" });
    expect(ruleFromDraft(football, { ...d, walkoverL: "0" })).toEqual({ ok: false, problem: "walkover" });
    expect(ruleFromDraft(football, { ...d, walkoverW: "4", walkoverL: "0" })).toMatchObject({ ok: true, rule: { forfeit: { winnerPoints: 4, loserPoints: 0 } } });
    expect(ruleFromDraft(football, { ...d, awardW: "3" })).toEqual({ ok: false, problem: "score" });
    expect(ruleFromDraft(football, { ...d, awardW: "3", awardL: "0" })).toMatchObject({ ok: true, rule: { forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] } } });
    const set = { ...draftFromStored(badminton, badminton.variants.bwf, null), useDivision: false, awardW: "21", awardL: "0" };
    const noRow = ruleFromDraft(badminton, set) as { rule: PointsRule };
    expect(noRow.rule.forfeit, "a score on a set sport is dropped, and with it the row it would have created").toBeUndefined();
    const withRow = ruleFromDraft(badminton, { ...set, walkoverW: "3", walkoverL: "0" }) as { rule: PointsRule };
    expect(withRow.rule.forfeit).toEqual({ winnerPoints: 3, loserPoints: 0 });
  });

  it("a threshold kind needs its number; a kind that reads none sends none; a bonus needs its points", () => {
    const d = { ...draftFromStored(generic, generic.variants.win_loss, null), useDivision: false };
    const rule = (bonuses: PointsDraft["bonuses"]) => ruleFromDraft(generic, { ...d, bonuses });
    expect(rule([{ when: "loss_margin_lte", param: "", points: "1" }])).toEqual({ ok: false, problem: "bonus" });
    expect(rule([{ when: "loss_margin_lte", param: "7", points: "" }])).toEqual({ ok: false, problem: "bonus" });
    expect(rule([{ when: "loss_margin_lte", param: "7", points: "1" }])).toMatchObject({ ok: true, rule: { bonuses: [{ when: "loss_margin_lte", param: 7, points: 1 }] } });
    const noParam = rule([{ when: "forfeit_win", param: "99", points: "1" }]) as { rule: PointsRule };
    expect(noParam.rule.bonuses, "a stale threshold on a kind that reads none is not sent").toEqual([{ when: "forfeit_win", points: 1 }]);
  });

  it("'Use the division's points' is points: null, and it is dirty only against a stored rule", () => {
    const own: PointsRule = plain();
    const inherit = draftFromStored(football, football.variants["11-a-side"], null);
    expect(ruleFromDraft(football, inherit)).toEqual({ ok: true, rule: null });
    expect(draftIsDirty(football, inherit, null), "nothing stored, nothing changed").toBe(false);
    expect(draftIsDirty(football, inherit, undefined)).toBe(false);
    expect(draftIsDirty(football, inherit, own), "a stored rule, 'use the division' checked: a save clears it").toBe(true);
    const opened = draftFromStored(football, football.variants["11-a-side"], own);
    expect(draftIsDirty(football, opened, own)).toBe(false);
    expect(draftIsDirty(football, { ...opened, win: "4" }, own)).toBe(true);
    expect(draftIsDirty(football, { ...opened, win: "" }, own), "an invalid draft is never 'unchanged'").toBe(true);
    expect(draftIsDirty(football, { ...inherit, useDivision: false }, null), "unchecking with nothing stored pins the division's numbers: a change").toBe(true);
    // jsonb gives keys back in its own order
    expect(draftIsDirty(football, opened, { bonuses: [], unit: "whole", shootoutAs: "result", noResult: 0, tie: 0, loss: { regulation: 0 }, draw: 1, win: { regulation: 3 } })).toBe(false);
    // W2d: a stored W2c row (`base`) reads through `legacyPointsRule`, so an untouched one is not dirty either.
    expect(draftIsDirty(football, draftFromStored(football, football.variants["11-a-side"], { base: BASE, bonuses: [] }), { base: BASE, bonuses: [] })).toBe(false);
  });

  it("a stored row the schema refuses reads as NO rule: the stage inherits rather than opening on garbage", () => {
    const junk: unknown[] = [undefined, null, 5, "rule", [], {}, { bonuses: [] }, { win: { regulation: "x" }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] }, { base: BASE, bonuses: "none" }];
    for (const stored of junk) {
      expect(storedPointsRule(stored), JSON.stringify(stored)).toBeNull();
      expect(draftFromStored(football, football.variants["11-a-side"], stored).useDivision, `${JSON.stringify(stored)} opens inheriting`).toBe(true);
    }
    expect(junk.length, "rows tried").toBeGreaterThan(5);
    expect(storedPointsRule(plain()), "and a real rule is still a rule").not.toBeNull();
    // W2d Task 9 (PS-9f): the read path takes the outcome-keyed shape alone - the migration (Task 7) converted every stored W2c
    // row, so a `base` row is one nobody wrote since and reads as none (found red at T10's base: the T9 change outran this pin).
    expect(storedPointsRule({ base: BASE, bonuses: [] }), "a stored W2c row reads as none since T9").toBeNull();
  });

  it("the preview says the walkover score only where the sport's table reads it, and nothing for a draft that is not a rule yet", () => {
    const forfeit = { walkoverW: "4", walkoverL: "1", awardW: "3", awardL: "0" };
    const goal = { ...draftFromStored(football, football.variants["11-a-side"], null), useDivision: false, ...forfeit };
    const set = { ...draftFromStored(badminton, badminton.variants.bwf, null), useDivision: false, ...forfeit };
    expect(previewClauses(football, {}, goal).map((c) => c.key)).toEqual(["format.points.base", "format.points.forfeit", "format.points.forfeitScore"]);
    expect(previewClauses(badminton, {}, set).map((c) => c.key), "another sport family").toEqual(["format.points.base", "format.points.forfeit"]);
    expect(previewClauses(football, {}, { ...goal, win: "" })).toEqual([]);
    expect(previewClauses(football, football.variants["11-a-side"], draftFromStored(football, football.variants["11-a-side"], null)).map((c) => c.key), "inheriting: the division's base").toEqual(["format.points.base"]);
  });

  it("anti-vacuity: the registry the sweeps walk is the engine's, and it is not small", () => {
    expect(DIVISIONS.length).toBeGreaterThan(20);
    expect(DIVISIONS.filter((d) => d.m.key === "football").length, "football's variants are in it").toBeGreaterThan(0);
  });
});

describe("W2d T10 fix round 1 I2: the editor keeps a can't-set-per-stage state where its flat rule would flatten the sport's own (owner 2026-10-26)", () => {
  const fit = (m: AnySportModule, cfg: unknown, kind = "league", config: Record<string, unknown> = {}) => pointsEditorFits(m, cfg, { kind, config });

  it("named: ice hockey (IIHF's 3-2-1-0), indoor volleyball (FIVB's 3-2 = 2/1) and cricket (ICC's tie and no result) get the state with their reasons; a plain 3/1/0 sport (generic) keeps the editor", () => {
    const ih = sport("icehockey");
    const vb = sport("volleyball");
    const cr = sport("cricket");
    expect(fit(ih, ih.variants.iihf), "ice hockey").toEqual({ fits: false, reasons: ["otWin", "otLoss"] });
    expect(fit(vb, vb.variants.indoor), "indoor volleyball").toEqual({ fits: false, reasons: ["pointsMap"] });
    expect(fit(cr, cr.variants.t20), "cricket").toEqual({ fits: false, reasons: ["tie", "noResult"] });
    // The positive pair, on the sport whose 3/1/0 the editor's boxes were built for.
    const plainCfg = generic.variants.score as Record<string, unknown>;
    expect((generic.configSchema.parse(plainCfg) as { points: unknown }).points, "premise: generic pays 3/1/0").toEqual({ w: 3, d: 1, l: 0 });
    expect(fit(generic, plainCfg), "generic").toEqual({ fits: true });
  });

  it("sweep: every (sport, variant) the registry ships × every table stage kind — the state exactly on the divisions the rulebooks split, with their reasons; the editor on the rest (counted, both sides > 0, every rulebook row reached)", () => {
    let checked = 0;
    let state = 0;
    let editor = 0;
    const reached = new Set<string>();
    for (const { m, variant, cfg } of DIVISIONS) {
      const id = `${m.key}/${variant}`;
      for (const kind of TABLE_KINDS) {
        const want = RULEBOOK_SPLITS[id];
        const got = fit(m, cfg, kind);
        if (want === undefined) {
          expect(got, `${id} ${kind}: the editor`).toEqual({ fits: true });
          editor++;
        } else {
          expect(got, `${id} ${kind}: the state, named`).toEqual({ fits: false, reasons: [...want] });
          reached.add(id);
          state++;
        }
        checked++;
      }
    }
    expect(checked, "every division × every table kind").toBe(DIVISIONS.length * TABLE_KINDS.length);
    expect(TABLE_KINDS.length, "anti-vacuity: table kinds").toBeGreaterThan(1);
    expect(state, "the state was reached").toBe(Object.keys(RULEBOOK_SPLITS).length * TABLE_KINDS.length);
    expect(editor, "and the editor").toBeGreaterThan(0);
    expect([...reached].sort(), "every rulebook row is a division the registry ships").toEqual(Object.keys(RULEBOOK_SPLITS).sort());
  });

  it("it follows the division's config, not the sport's name: ice hockey's recreational variant keeps the editor, and so does an IIHF division edited to pay overtime like regulation; an empty config reads the sport's defaults", () => {
    const ih = sport("icehockey");
    expect(fit(ih, ih.variants.recreational), "recreational: no overtime split").toEqual({ fits: true });
    const iihf = ih.configSchema.parse(ih.variants.iihf) as { points: Record<string, number> };
    const flat = { ...iihf, points: { ...iihf.points, otWin: iihf.points.win!, otLoss: iihf.points.loss! } };
    expect(fit(ih, flat), "IIHF paying an overtime win and loss as regulation's").toEqual({ fits: true });
    expect(fit(ih, iihf), "the same division as shipped (the positive pair)").toEqual({ fits: false, reasons: ["otWin", "otLoss"] });
    // A second call answers the same (pure): no state carried between asks.
    expect(fit(ih, iihf), "asked twice").toEqual(fit(ih, iihf));
    const empty = fit(ih, {});
    expect(empty, "the empty config: the sport's defaults decide").toEqual(fit(ih, ih.configSchema.parse({})));
  });

  it("the STAGE's own rules are read, not the division's alone: a hockey league stage that switches FIH's shoot-out on (its division has none) gets the state; the same stage without it keeps the editor", () => {
    const hk = sport("hockey");
    const outdoor = hk.variants["fih-outdoor"];
    const shootout = (hk.configSchema.parse(hk.variants["fih-shootout"]) as { shootout: unknown }).shootout;
    expect(shootout, "premise: FIH's shoot-out, from the sport's own variant").toBeDefined();
    expect(fit(hk, outdoor, "league", {}), "no shoot-out on the table: the editor").toEqual({ fits: true });
    expect(fit(hk, outdoor, "league", { rules: { shootout } }), "the stage's shoot-out: booked drawn plus a bonus").toEqual({ fits: false, reasons: ["soBonus"] });
  });

  it("fail-closed: a division config the sport refuses leaves no sport rule to compare against - the state, no reason named (never the editor)", () => {
    const ih = sport("icehockey");
    const refused = { ...(ih.variants.iihf as Record<string, unknown>), periods: "many" };
    expect(ih.configSchema.safeParse(refused).success, "premise: the sport refuses this config").toBe(false);
    expect(fit(ih, refused)).toEqual({ fits: false, reasons: [] });
    const recreational = { ...(ih.variants.recreational as Record<string, unknown>), periods: "many" };
    expect(fit(ih, recreational), "even on the variant whose editor fits").toEqual({ fits: false, reasons: [] });
  });

  it("a stage kind with no table is never asked (the section is not mounted there): fits", () => {
    const ih = sport("icehockey");
    let bracket = 0;
    for (const kind of StageKind.options) {
      if (stageTakesPoints(kind)) continue;
      expect(fit(ih, ih.variants.iihf, kind), kind).toEqual({ fits: true });
      bracket++;
    }
    expect(bracket, "bracket kinds checked").toBeGreaterThan(0);
  });
});

// W2d final review I1 (controller ruling, 2026-10-26): a stage is PINNED at generate, and a division points save after that
// lands ("Saved") but never reaches it (`rule-locks.ts` lets it through; the pin keeps the table paying the pinned rule). So a
// pinned stage with no rule of its own opens, previews and prefills from its PIN, never from the live division. Expected
// values: the pin is the engine's own rule for the division as it was (`tablePointsRule`), the live number is the one the
// test stores, and each case has a right answer that differs from the wrong one's.
describe("W2d final review I1: a pinned stage with no rule of its own plays its pin, never the live division", () => {
  const FOOTBALL_CFG = football.variants["11-a-side"] as Record<string, unknown>;
  /** What generate pinned: football's own table rule for the division as it stood (11-a-side's declared 3/1/0, FIFA). */
  const PIN = PointsRule.parse(football.tablePointsRule(football.configSchema.parse(FOOTBALL_CFG), "league"));
  /** The division after a points save the pin never sees: win 2. */
  const LIVE = { ...FOOTBALL_CFG, points: { ...(parsedCfg(football, FOOTBALL_CFG).points as Record<string, number>), win: 2 } };
  const LIVE_POINTS = parsedCfg(football, LIVE).points as { win: number; draw: number; loss: number };
  const AWARD = pointsRuleAwardReachesTable(football);

  it("premise: the pin pays win 3 and the live division win 2 (the right answer differs from the wrong one)", () => {
    expect(PIN.win.regulation).toBe(3);
    expect(LIVE_POINTS.win).toBe(2);
  });

  it("the draft opens inheriting at the PIN's numbers; the same stage unpinned opens at the live division's", () => {
    const pinned = draftFromStored(football, LIVE, null, PIN);
    expect(pinned.useDivision, "nothing of its own: it inherits").toBe(true);
    expect([pinned.win, pinned.draw, pinned.loss]).toEqual([String(PIN.win.regulation), String(PIN.draw), String(PIN.loss.regulation)]);
    const unpinned = draftFromStored(football, LIVE, null);
    expect([unpinned.win, unpinned.draw, unpinned.loss], "the positive pair: no pin, the live division").toEqual([String(LIVE_POINTS.win), String(LIVE_POINTS.draw), String(LIVE_POINTS.loss)]);
  });

  it("the inheriting preview says the PIN's points (win 3), never the live division's (win 2); unpinned it says the live 2", () => {
    const checked = draftFromStored(football, LIVE, null, PIN);
    expect(previewClauses(football, LIVE, checked, PIN)).toEqual(pointsLine(editorRule(PIN.win.regulation, PIN.draw!, PIN.loss.regulation), { awardReaches: AWARD }));
    expect(previewClauses(football, LIVE, checked, PIN)).not.toEqual(previewClauses(football, LIVE, checked));
    expect(previewClauses(football, LIVE, draftFromStored(football, LIVE, null))).toEqual(pointsLine(editorRule(LIVE_POINTS.win, LIVE_POINTS.draw, LIVE_POINTS.loss), { awardReaches: AWARD }));
  });

  it("an own rule outranks the pin; the pin is in force only while the stage stores none (and an unreadable pin is none)", () => {
    const own = editorRule(5, 2, 1);
    expect(pinInForce(own, PIN), "own rule: the pin says nothing").toBeNull();
    expect(pinInForce(null, PIN)).toEqual(PIN);
    expect(pinInForce(undefined, PIN), "absent is no rule too").toEqual(PIN);
    expect(pinInForce(null, null), "unpinned").toBeNull();
    expect(pinInForce(null, { win: "three" }), "a pin the schema refuses is read as none (never half-read)").toBeNull();
    expect(pointsBasis(own, PIN)).toBe("own");
    expect(pointsBasis(null, PIN)).toBe("pin");
    expect(pointsBasis(null, null)).toBe("division");
    const opened = draftFromStored(football, LIVE, own, PIN);
    expect([opened.useDivision, opened.win], "an own rule opens as itself").toEqual([false, "5"]);
  });

  it("sweep: on every division the registry ships, a pinned stage with no rule opens and previews at its pin's numbers, not the division's (counted)", () => {
    // A pin with numbers no shipped division declares, so a draft read from the division instead is visible on every row.
    const pin = PointsRule.parse({ win: { regulation: 7 }, loss: { regulation: 2 }, draw: 5, shootoutAs: "result", unit: "whole", bonuses: [] });
    let checked = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      const live = draftFromStored(m, cfg, null);
      expect(live.win, `${m.key}/${variant}: premise, the division's own win is not the pin's`).not.toBe("7");
      const d = draftFromStored(m, cfg, null, pin);
      expect([d.useDivision, d.win, d.draw, d.loss], `${m.key}/${variant}`).toEqual([true, "7", "5", "2"]);
      expect(previewClauses(m, cfg, d, pin), `${m.key}/${variant}: the preview`).toEqual(pointsLine(editorRule(7, 5, 2), { awardReaches: pointsRuleAwardReachesTable(m) }));
      checked++;
    }
    expect(checked, "anti-vacuity: divisions checked").toBeGreaterThan(0);
    expect(checked, "every division swept").toBe(DIVISIONS.length);
  });
});
