// W2c Task 18 (S3) - the stage points section, REACHED: the real component, rendered the way the stage card renders it. Static
// markup (no DOM, no effects): this is the "is the control on the screen, in this state, for this sport" half; clicking,
// saving and reloading are the e2e's. Expected values come from the engine's declarations (`pointsRuleAwardReachesTable`,
// `offeredBonusKinds` over `validatePointsRule`, `pointsRuleExpressible`) and from the dictionaries the product renders -
// none is typed here. Every sweep reports how many items it checked and zero is a failure.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { pointsRuleAwardReachesTable, type PointsRule } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { pointsLine } from "@/lib/points-line";
import { pointsLineDict, rulesLineText } from "@/lib/rules-line";
import { StagePointsSection } from "../stage-points-section";
import { divisionExpressible, offeredBonusKinds } from "../stage-points-model";

const sport = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)!;
const UI = enUi as Record<string, string>;
const POINTS_DICT = pointsLineDict(enPublic as Dict);
const ID = "11111111-1111-4111-8111-111111111111";

const BASE = { win: 3, draw: 1, loss: 0 };
const FORFEIT_RULE: PointsRule = { base: BASE, bonuses: [], forfeit: { winnerPoints: 4, loserPoints: 1 } };
const SCORED_RULE: PointsRule = { base: BASE, bonuses: [], forfeit: { winnerPoints: 4, loserPoints: 1, awardScore: [3, 0] } };

function render(m: AnySportModule, variant: string, stored: unknown, over: { customPointsAllowed?: boolean; readOnly?: boolean; pointsDict?: Dict } = {}): string {
  return renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <StagePointsSection
        stageId={ID}
        module={m}
        divisionConfig={m.variants[variant] as Record<string, unknown>}
        stored={stored}
        pointsDict={"pointsDict" in over ? over.pointsDict : POINTS_DICT}
        customPointsAllowed={over.customPointsAllowed ?? true}
        readOnly={over.readOnly ?? false}
        onSaved={() => undefined}
      />
    </DictProvider>,
  );
}

const has = (html: string, testId: string): boolean => html.includes(`data-testid="${testId}"`);
/** The tag that carries a testid, for reading its attributes. */
function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `${testId} is on the page`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}
const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const football = sport("football");
const badminton = sport("badminton");
const generic = sport("generic");

describe("I3: the walkover SCORE is shown on goal sports and hidden on the sports whose table never reads it (a render per family)", () => {
  it("a goal sport (football) shows the score boxes beside the walkover points", () => {
    const html = render(football, "11-a-side", SCORED_RULE);
    expect(has(html, "stage-points-walkover-w") && has(html, "stage-points-walkover-l"), "the walkover points are there").toBe(true);
    expect(has(html, "stage-points-award-w") && has(html, "stage-points-award-l"), "and so is the score").toBe(true);
    expect(tagOf(html, "stage-points-award-w")).toContain('value="3"');
    expect(tagOf(html, "stage-points-award-l")).toContain('value="0"');
  });

  it("a set sport (badminton) shows the walkover points and NO score box - the server would refuse it", () => {
    const html = render(badminton, "bwf", { base: { win: 2, draw: 0, loss: 0 }, bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1 } });
    expect(has(html, "stage-points-walkover-w") && has(html, "stage-points-walkover-l"), "the walkover points are offered").toBe(true);
    expect(has(html, "stage-points-award-w") || has(html, "stage-points-award-l") || has(html, "stage-points-award"), "no score input").toBe(false);
  });

  it("sweep: every expressible sport and variant shows the score iff the engine's table reads it", () => {
    let shown = 0;
    let hidden = 0;
    let checked = 0;
    for (const m of builtinModules)
      for (const variant of Object.keys(m.variants)) {
        if (!divisionExpressible(m, m.variants[variant]).ok) continue;
        const html = render(m, variant, { base: BASE, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } });
        const score = has(html, "stage-points-award-w") && has(html, "stage-points-award-l");
        expect(score, `${m.key}/${variant}`).toBe(pointsRuleAwardReachesTable(m));
        expect(has(html, "stage-points-walkover-w"), `${m.key}/${variant}: the walkover points are on every sport`).toBe(true);
        if (score) shown++;
        else hidden++;
        checked++;
      }
    expect(checked, "expressible divisions swept").toBeGreaterThan(10);
    expect(shown, "goal sports").toBeGreaterThan(0);
    expect(hidden, "set sports and the rest").toBeGreaterThan(0);
  });
});

describe("the section's three states, in the order inexpressible, gate, editor", () => {
  it("inexpressible: an ice-hockey division that splits its points says why, in words, with NO inputs - even for an org that has the feature", () => {
    const m = sport("icehockey");
    const variant = Object.keys(m.variants).find((v) => !divisionExpressible(m, m.variants[v]).ok)!;
    expect(variant, "premise: a splitting variant exists").toBeDefined();
    for (const customPointsAllowed of [true, false]) {
      const html = render(m, variant, null, { customPointsAllowed });
      expect(html).toContain('data-stage-points-state="inexpressible"');
      const said = text(tagOf(html, "stage-points-inexpressible") + html.slice(html.indexOf('data-testid="stage-points-inexpressible"'), html.indexOf("</p>", html.indexOf('data-testid="stage-points-inexpressible"'))));
      expect(said, "the reason names the split points").toMatch(/overtime/i);
      expect(said, "and says the stage cannot take them").toMatch(/can't be set per stage/i);
      expect(html, "no input at all").not.toContain("<input");
      expect(has(html, "stage-points-upgrade"), "a sport that cannot use the feature is not sold it").toBe(false);
    }
  });

  it("inexpressible is judged per VARIANT: the same sport's recreational variant has an editor", () => {
    const m = sport("icehockey");
    const variant = Object.keys(m.variants).find((v) => divisionExpressible(m, m.variants[v]).ok)!;
    expect(variant).toBeDefined();
    expect(render(m, variant, null)).toContain('data-stage-points-state="editor"');
  });

  it("gate: the base sentence is there and editable; the upgrade note stands where the walkover and bonus rows would be", () => {
    const html = render(football, "11-a-side", { base: BASE, bonuses: [] }, { customPointsAllowed: false });
    expect(html).toContain('data-stage-points-state="gate"');
    for (const id of ["stage-points-win", "stage-points-draw", "stage-points-loss"]) {
      expect(has(html, id), id).toBe(true);
      expect(tagOf(html, id), `${id} is editable`).not.toContain("disabled");
    }
    expect(has(html, "stage-points-upgrade")).toBe(true);
    expect(text(html)).toContain(UI["stagePoints.upgrade"]!);
    for (const id of ["stage-points-walkover-w", "stage-points-walkover-l", "stage-points-award-w", "stage-points-bonuses", "stage-points-bonus-add"]) {
      expect(has(html, id), `${id} is not offered without the entitlement`).toBe(false);
    }
  });

  it("editor: the walkover row and the bonus add menu are there, and the upgrade note is not", () => {
    const html = render(football, "11-a-side", { base: BASE, bonuses: [] });
    expect(html).toContain('data-stage-points-state="editor"');
    expect(has(html, "stage-points-walkover-w") && has(html, "stage-points-bonus-add")).toBe(true);
    expect(has(html, "stage-points-upgrade")).toBe(false);
  });

  it("the gate holds a stored walkover row's base boxes (the same rule SENT is 402) and leaves 'Use the division's points' as the way out", () => {
    const html = render(football, "11-a-side", FORFEIT_RULE, { customPointsAllowed: false });
    expect(has(html, "stage-points-gate-held")).toBe(true);
    for (const id of ["stage-points-win", "stage-points-draw", "stage-points-loss"]) expect(tagOf(html, id), id).toContain("disabled");
    expect(tagOf(html, "stage-points-use-division"), "null asks no gate").not.toContain("disabled");
    // the positive pair: a gated org whose stored rule is the plain base sentence is NOT held
    const plain = render(football, "11-a-side", { base: BASE, bonuses: [] }, { customPointsAllowed: false });
    expect(has(plain, "stage-points-gate-held")).toBe(false);
  });
});

describe("the use-division toggle and the preview", () => {
  it("nothing stored: 'Use the division's points' is checked, no inputs, the division's base is previewed, and there is nothing to save", () => {
    const html = render(football, "11-a-side", null);
    expect(tagOf(html, "stage-points-use-division")).toContain('checked=""');
    expect(has(html, "stage-points-win"), "no inputs while inheriting").toBe(false);
    expect(has(html, "stage-points-save"), "nothing to save").toBe(false);
    expect(text(tagOf(html, "stage-points-preview") + html.slice(html.indexOf('data-testid="stage-points-preview"')))).toContain(rulesLineText(POINTS_DICT, pointsLine({ base: BASE, bonuses: [] })));
  });

  it("a stored rule: unchecked, the boxes hold its numbers, the preview is its sentence in the public line's words, Save is offered but not yet enabled", () => {
    const html = render(football, "11-a-side", SCORED_RULE);
    expect(tagOf(html, "stage-points-use-division")).not.toContain("checked");
    expect(tagOf(html, "stage-points-win")).toContain('value="3"');
    expect(tagOf(html, "stage-points-draw")).toContain('value="1"');
    expect(tagOf(html, "stage-points-loss")).toContain('value="0"');
    expect(tagOf(html, "stage-points-walkover-w")).toContain('value="4"');
    const want = rulesLineText(POINTS_DICT, pointsLine(SCORED_RULE, { awardReaches: true }));
    expect(text(html)).toContain(want);
    expect(tagOf(html, "stage-points-save"), "untouched: nothing to save").toContain("disabled");
  });

  it("the preview says the walkover score on a goal sport and not on a set sport, for the same stored score", () => {
    const stored = { base: { win: 2, draw: 0, loss: 0 }, bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1, awardScore: [21, 0] } };
    expect(text(render(football, "11-a-side", stored))).toContain(rulesLineText(POINTS_DICT, [{ key: "format.points.forfeitScore", params: { winner: 21, loser: 0 } }]).toLowerCase());
    expect(text(render(badminton, "bwf", stored))).not.toContain(rulesLineText(POINTS_DICT, [{ key: "format.points.forfeitScore", params: { winner: 21, loser: 0 } }]).toLowerCase());
  });

  it("no public dictionary, no preview - and the section still works", () => {
    const html = render(football, "11-a-side", SCORED_RULE, { pointsDict: undefined });
    expect(has(html, "stage-points-preview")).toBe(false);
    expect(has(html, "stage-points-win")).toBe(true);
  });

  it("a sport that cannot draw gets the two-part sentence (no draw box)", () => {
    const html = render(badminton, "bwf", { base: { win: 2, draw: 0, loss: 0 }, bonuses: [] });
    expect(has(html, "stage-points-draw")).toBe(false);
    expect(has(html, "stage-points-win") && has(html, "stage-points-loss")).toBe(true);
    expect(has(render(football, "11-a-side", { base: BASE, bonuses: [] }), "stage-points-draw")).toBe(true);
  });
});

describe("bonus rows", () => {
  const STORED: PointsRule = { base: BASE, bonuses: [{ when: "loss_margin_lte", param: 7, points: 1 }, { when: "forfeit_win", points: 2 }] };

  it("a stored bonus is a row with its threshold and points; a kind that reads no threshold has no threshold box", () => {
    const html = render(generic, "score", STORED);
    expect(tagOf(html, "stage-points-bonus-param-0")).toContain('value="7"');
    expect(tagOf(html, "stage-points-bonus-points-0")).toContain('value="1"');
    expect(has(html, "stage-points-bonus-param-1"), "a walkover bonus reads no threshold").toBe(false);
    expect(tagOf(html, "stage-points-bonus-points-1")).toContain('value="2"');
    expect(has(html, "stage-points-bonus-remove-0") && has(html, "stage-points-bonus-remove-1")).toBe(true);
  });

  it("the add menu offers the kinds the sport's metrics can feed: the margin kinds on generic, none on badminton", () => {
    const options = (html: string): string[] => [...html.slice(html.indexOf('data-testid="stage-points-bonus-add"')).split("</select>")[0]!.matchAll(/<option value="([a-z_]+)"/g)].map((x) => x[1]!);
    const g = options(render(generic, "score", { base: BASE, bonuses: [] }));
    expect(g).toEqual(offeredBonusKinds(generic, generic.variants.score));
    expect(g).toContain("loss_margin_lte");
    const b = options(render(badminton, "bwf", { base: { win: 2, draw: 0, loss: 0 }, bonuses: [] }));
    expect(b).toEqual(offeredBonusKinds(badminton, badminton.variants.bwf));
    expect(b.length, "badminton still has walkover bonuses").toBeGreaterThan(0);
    expect(b).not.toContain("loss_margin_lte");
  });

  it("a stored bonus the add menu would not offer is still shown (never silently dropped)", () => {
    const html = render(badminton, "bwf", { base: { win: 2, draw: 0, loss: 0 }, bonuses: [{ when: "loss_margin_lte", param: 3, points: 1 }] });
    expect(has(html, "stage-points-bonus-0")).toBe(true);
    expect(tagOf(html, "stage-points-bonus-param-0")).toContain('value="3"');
  });
});

describe("a started stage, or a viewer, reads the section and changes nothing", () => {
  it("read-only: no input, no checkbox, no Save; it says whose points the stage plays and previews them", () => {
    const own = render(football, "11-a-side", SCORED_RULE, { readOnly: true });
    expect(own).toContain('data-stage-points-state="readonly"');
    expect(own, "no control of any kind").not.toMatch(/<(input|select|button)/);
    expect(text(tagOf(own, "stage-points-readonly") + own.slice(own.indexOf('data-testid="stage-points-readonly"')))).toContain(UI["stagePoints.ownPoints"]!);
    expect(text(own)).toContain(rulesLineText(POINTS_DICT, pointsLine(SCORED_RULE, { awardReaches: true })));
    const inherited = render(football, "11-a-side", null, { readOnly: true });
    expect(text(inherited)).toContain(UI["stagePoints.divisionPoints"]!);
    expect(text(inherited)).toContain(rulesLineText(POINTS_DICT, pointsLine({ base: BASE, bonuses: [] })));
  });

  it("an inexpressible division is explained to a viewer too (the reason is not a control)", () => {
    const m = sport("icehockey");
    const variant = Object.keys(m.variants).find((v) => !divisionExpressible(m, m.variants[v]).ok)!;
    expect(render(m, variant, null, { readOnly: true })).toContain('data-testid="stage-points-inexpressible"');
  });
});

describe("pointsLineDict carries every key the preview can emit", () => {
  it("each clause pointsLine produces, for a rule that uses every part, is in the slice and in the real dictionary", () => {
    const everything: PointsRule = {
      base: BASE,
      bonuses: [{ when: "loss_margin_lte", param: 7, points: 1 }, { when: "forfeit_win", points: 2 }],
      forfeit: { winnerPoints: 4, loserPoints: 1, awardScore: [3, 0] },
    };
    const keys = new Set([...pointsLine(everything, { awardReaches: true }), ...pointsLine({ base: BASE, bonuses: [] }), ...pointsLine({ base: BASE, bonuses: [{ when: "draw", points: 1 }] })].map((c) => c.key));
    expect(keys.size, "clause keys exercised").toBeGreaterThanOrEqual(4);
    for (const key of keys) {
      expect(Object.hasOwn(POINTS_DICT, key), `${key} is in the slice`).toBe(true);
      expect(Object.hasOwn(enPublic, key), `${key} is in public.json`).toBe(true);
    }
  });
});
