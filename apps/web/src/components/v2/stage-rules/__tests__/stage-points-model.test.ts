// W2c Task 18 (review I9) - the decisions the stage points section makes live in a pure helper with unit killers, never in
// a browser. Expected values come from the SERVER's own door (`refuseStagePoints`) and the engine's declarations
// (`pointsRuleExpressible`, `pointsRuleAwardReachesTable`, `validatePointsRule`, `payout`), never from a table
// typed here; every sweep reports how many items it checked and zero is a failure.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { StageKind } from "@seazn/engine/core";
import { PointsRule, legacyPointsRule, payout, pointsRuleAwardReachesTable, pointsRuleExpressible } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { refuseStagePoints } from "@/server/usecases/stage-rules-merge";
import {
  BONUS_KINDS,
  PARAM_BONUS_KINDS,
  divisionBasePoints,
  divisionExpressible,
  draftFromStored,
  draftIsDirty,
  offeredBonusKinds,
  offersWalkoverScore,
  parseNumber,
  pointsSectionState,
  previewClauses,
  ruleFromDraft,
  stageTakesPoints,
  storedPointsRule,
  type PointsDraft,
} from "../stage-points-model";

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

/** The server's answer to a rule on a league stage: undefined when it takes it, else the refusal's code/field. */
function serverAnswer(m: AnySportModule, cfg: unknown, rule: PointsRule, kind: StageKind = "league"): { code?: string; field?: string } | undefined {
  try {
    refuseStagePoints(m, kind, cfg, rule);
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
  it("pointsSectionState: a division a stage rule cannot say is inexpressible, every other the editor - both answers, counted", () => {
    const rows: [boolean, string][] = [
      [true, "editor"],
      [false, "inexpressible"],
    ];
    let checked = 0;
    for (const [expressible, want] of rows) {
      expect(pointsSectionState(expressible), `expressible=${expressible}`).toBe(want);
      checked++;
    }
    expect(checked).toBe(2);
    // and against the SERVER's door, for every division the registry ships
    let swept = 0;
    let split = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      const refused = serverAnswer(m, cfg, plain())?.code === "POINTS_RULE_INEXPRESSIBLE";
      expect(pointsSectionState(divisionExpressible(m, cfg).ok), `${m.key}/${variant}`).toBe(refused ? "inexpressible" : "editor");
      if (refused) split++;
      swept++;
    }
    expect(swept, "every division swept").toBe(DIVISIONS.length);
    expect(split, "and some of them split").toBeGreaterThan(0);
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

  it("Q1: the section's pre-check says what the server's door says, for every sport and variant", () => {
    let expressible = 0;
    let split = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      const ui = divisionExpressible(m, cfg);
      const server = serverAnswer(m, cfg, plain());
      expect(server?.code === "POINTS_RULE_INEXPRESSIBLE", `${m.key}/${variant}: server refuses as inexpressible`).toBe(!ui.ok);
      if (ui.ok) expressible++;
      else {
        split++;
        expect(ui.keys.length, `${m.key}/${variant}: the split keys are named`).toBeGreaterThan(0);
      }
    }
    expect(expressible + split, "every division swept").toBe(DIVISIONS.length);
    expect(expressible, "some divisions are expressible").toBeGreaterThan(0);
    expect(split, "and some split their points (ice hockey, hockey shoot-out, cricket, indoor volleyball)").toBeGreaterThan(0);
  });

  it("I3: the walkover SCORE is offered exactly where the server accepts it, for every sport and variant (set sports, goal sports, both)", () => {
    let checked = 0;
    let skipped = 0;
    let offered = 0;
    let hidden = 0;
    const withScore: PointsRule = { ...plain(), forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [3, 0] } };
    for (const { m, variant, cfg } of DIVISIONS) {
      const answer = serverAnswer(m, cfg, withScore);
      if (answer?.code === "POINTS_RULE_INEXPRESSIBLE") {
        // asked first; the score is moot where nothing can be saved. Counted, so a skip is never silent.
        expect(divisionExpressible(m, cfg).ok, `${m.key}/${variant}: skipped only because the engine says it splits`).toBe(false);
        skipped++;
        continue;
      }
      const serverRefusesScore = answer?.field === "points.forfeit.awardScore";
      expect(offersWalkoverScore(m), `${m.key}/${variant}: the input is shown iff the server takes the score`).toBe(!serverRefusesScore);
      expect(offersWalkoverScore(m), `${m.key}/${variant}: the engine's declaration`).toBe(pointsRuleAwardReachesTable(m));
      if (offersWalkoverScore(m)) offered++;
      else hidden++;
      checked++;
    }
    expect(checked + skipped, "every division is either checked or skipped for a stated reason").toBe(DIVISIONS.length);
    expect(checked, "most divisions are checked").toBeGreaterThan(skipped);
    expect(skipped, "and some split their points (ice hockey, cricket, indoor volleyball)").toBeGreaterThan(0);
    expect(offered, "goal sports reach the table").toBeGreaterThan(0);
    expect(hidden, "set sports, carrom and the board games do not").toBeGreaterThan(0);
  });

  it("every rule the section builds is one the server takes: all expressible sports, with a walkover pair, a score, and every offered bonus kind", () => {
    let saved = 0;
    let bonusesChecked = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      if (!divisionExpressible(m, cfg).ok) continue;
      const draft = draftFromStored(m, cfg, null);
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
    expect(saved, "expressible divisions swept").toBeGreaterThan(10);
    expect(bonusesChecked, "bonus rows swept").toBeGreaterThan(0);
  });

  it("the bonus kinds offered are the ones the server's metrics check takes; a margin bonus on a sport with no scores is refused by the server and not offered", () => {
    let withMargins = 0;
    let without = 0;
    for (const { m, variant, cfg } of DIVISIONS) {
      if (!divisionExpressible(m, cfg).ok) continue;
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
    for (const { m, cfg } of DIVISIONS) {
      if (!divisionExpressible(m, cfg).ok) continue;
      expect(offeredBonusKinds(m, cfg), `${m.key}: a walkover bonus is a bonus on every sport`).toEqual(expect.arrayContaining(["forfeit_win", "forfeit_loss"]));
      expect(offeredBonusKinds(m, cfg), `${m.key}: no sport that reaches this editor records a no-result`).not.toContain("no_result");
    }
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
      if (!divisionExpressible(m, cfg).ok) continue;
      const base = divisionBasePoints(m, cfg);
      expect(base.win, `${m.key}/${variant}: a win`).not.toBeNull();
      expect(base.loss, `${m.key}/${variant}: a loss`).not.toBeNull();
      swept++;
    }
    expect(swept).toBeGreaterThan(10);
    // A pointsMap that pays TWO different pairs has no one win / loss: null, never the first pair's numbers. (Q1 keeps such a
    // division out of the editor, so this guards the reader itself - a base invented from one of two pairs would be a lie.)
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
    expect(storedPointsRule({ base: BASE, bonuses: [] }), "and so is a stored W2c row (W2d: read through legacyPointsRule)").toEqual(plain());
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
    expect(pointsRuleExpressible(football.variants["11-a-side"]).ok).toBe(true);
  });
});
