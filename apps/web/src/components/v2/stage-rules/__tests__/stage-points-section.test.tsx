// W2c Task 18 (S3) - the stage points section, REACHED: the real component, rendered the way the stage card renders it. Static
// markup (no DOM, no effects): this is the "is the control on the screen, in this state, for this sport" half; clicking,
// saving and reloading are the e2e's. Expected values come from the engine's declarations (`pointsRuleAwardReachesTable`,
// `offeredBonusKinds` over `validatePointsRule`) and from the dictionaries the product renders - none is typed here. Every
// sweep reports how many items it checked and zero is a failure. W2d Task 10 fix round 1, I2 (owner, 2026-10-26): the
// editor's boxes are a flat rule, so a division whose sport pays an outcome its own way (the rulebooks' list,
// `_points-split-rulebook.ts`) gets "can't be set per stage yet" with its reason and no inputs; every other the editor.
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
import { ApiV1Error } from "@/lib/client-v1";
import { msg as enMsg } from "@/lib/messages";
import { StagePointsSection, failureText } from "../stage-points-section";
import { offeredBonusKinds } from "../stage-points-model";
import { RULEBOOK_SPLITS } from "./_points-split-rulebook";

const sport = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)!;
const UI = enUi as Record<string, string>;
const POINTS_DICT = pointsLineDict(enPublic as Dict);
const ID = "11111111-1111-4111-8111-111111111111";

/** W2d: the editor's own rule for win 3 / draw 1 / loss 0 (the outcome-keyed reading of the W2c boxes, `legacyPointsRule`). */
const HEAD = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, tie: 0, noResult: 0, shootoutAs: "result", unit: "whole" } as const;
const FORFEIT_RULE: PointsRule = { ...HEAD, bonuses: [], forfeit: { winnerPoints: 4, loserPoints: 1 } };
const SCORED_RULE: PointsRule = { ...HEAD, bonuses: [], forfeit: { winnerPoints: 4, loserPoints: 1, awardScore: [3, 0] } };

function render(
  m: AnySportModule,
  variant: string,
  stored: unknown,
  over: { readOnly?: boolean; pointsDict?: Dict; kind?: string; stageConfig?: Record<string, unknown>; divisionConfig?: Record<string, unknown> } = {},
): string {
  return renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <StagePointsSection
        stageId={ID}
        module={m}
        kind={over.kind ?? "league"}
        stageConfig={over.stageConfig ?? {}}
        divisionConfig={over.divisionConfig ?? (m.variants[variant] as Record<string, unknown>)}
        stored={stored}
        pointsDict={"pointsDict" in over ? over.pointsDict : POINTS_DICT}
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

/** Every (sport, variant) the registry ships. */
const VARIANTS = builtinModules.flatMap((m) => Object.keys(m.variants).map((variant) => ({ m, variant })));
/** The divisions the rulebooks split (fix round 1 I2): the section's state there, never the editor. */
const SPLIT = VARIANTS.filter(({ m, variant }) => RULEBOOK_SPLITS[`${m.key}/${variant}`] !== undefined);
const EDITABLE = VARIANTS.filter(({ m, variant }) => RULEBOOK_SPLITS[`${m.key}/${variant}`] === undefined);
/** The state's sentence for a rulebook row, built from the en dictionary the product renders (never the helper's own). */
const stateSentence = (id: string): string =>
  UI["rules.err.pointsRuleInexpressible"]!.replace(
    "{reason}",
    UI["rules.err.pointsSplit"]!.replace("{fields}", RULEBOOK_SPLITS[id]!.map((r) => UI[`rules.err.pointsSplit.${r}`]!).join(", ")),
  );

describe("I3: the walkover SCORE is shown on goal sports and hidden on the sports whose table never reads it (a render per family)", () => {
  it("a goal sport (football) shows the score boxes beside the walkover points", () => {
    const html = render(football, "11-a-side", SCORED_RULE);
    expect(has(html, "stage-points-walkover-w") && has(html, "stage-points-walkover-l"), "the walkover points are there").toBe(true);
    expect(has(html, "stage-points-award-w") && has(html, "stage-points-award-l"), "and so is the score").toBe(true);
    expect(tagOf(html, "stage-points-award-w")).toContain('value="3"');
    expect(tagOf(html, "stage-points-award-l")).toContain('value="0"');
  });

  it("a set sport (badminton) shows the walkover points and NO score box - the server would refuse it", () => {
    const html = render(badminton, "bwf", { win: { regulation: 2 }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1 } });
    expect(has(html, "stage-points-walkover-w") && has(html, "stage-points-walkover-l"), "the walkover points are offered").toBe(true);
    expect(has(html, "stage-points-award-w") || has(html, "stage-points-award-l") || has(html, "stage-points-award"), "no score input").toBe(false);
  });

  it("carrom and the board games (chess keeps half-points) show the walkover points and NO score box either", () => {
    for (const key of ["carrom", "boardgame"]) {
      const m = sport(key);
      const variant = Object.keys(m.variants)[0]!;
      expect(variant, `${key}: a variant exists`).toBeDefined();
      expect(pointsRuleAwardReachesTable(m), `${key}: premise, the engine's table never reads a walkover score`).toBe(false);
      const html = render(m, variant, { win: { regulation: 2 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } });
      expect(has(html, "stage-points-walkover-w"), `${key}: walkover points`).toBe(true);
      expect(has(html, "stage-points-award-w") || has(html, "stage-points-award-l"), `${key}: no score box`).toBe(false);
    }
  });

  it("sweep: every sport and variant the editor fits shows the score iff the engine's table reads it (the rulebook splits show no input at all, I2)", () => {
    let shown = 0;
    let hidden = 0;
    let checked = 0;
    for (const { m, variant } of EDITABLE) {
        const html = render(m, variant, { ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } });
        const score = has(html, "stage-points-award-w") && has(html, "stage-points-award-l");
        expect(score, `${m.key}/${variant}`).toBe(pointsRuleAwardReachesTable(m));
        expect(has(html, "stage-points-walkover-w"), `${m.key}/${variant}: the walkover points are on every sport`).toBe(true);
        if (score) shown++;
        else hidden++;
        checked++;
    }
    expect(checked, "every editable division swept").toBe(EDITABLE.length);
    expect(checked + SPLIT.length, "and with the rulebook splits, every division").toBe(VARIANTS.length);
    expect(shown, "goal sports").toBeGreaterThan(0);
    expect(hidden, "set sports and the rest").toBeGreaterThan(0);
  });
});

describe("W2d T10 fix round 1 I2: the editor where its flat rule says the sport's points, the can't-set-per-stage state where it would flatten them (owner 2026-10-26)", () => {
  it("ice hockey (IIHF's overtime 2/1): the state, the reason in the reader's words, no input, no Save - and recreational ice hockey (no split) the editor", () => {
    const m = sport("icehockey");
    const html = render(m, "iihf", null);
    expect(html).toContain('data-stage-points-state="inexpressible"');
    expect(text(tagOf(html, "stage-points-inexpressible") + html.slice(html.indexOf('data-testid="stage-points-inexpressible"')))).toContain(stateSentence("icehockey/iihf"));
    expect(html, "no control: nothing can be sent").not.toMatch(/<(input|select|button)/);
    expect(has(html, "stage-points-save")).toBe(false);
    const plain = render(m, "recreational", null);
    expect(plain, "the positive pair: the same sport where the editor fits").toContain('data-stage-points-state="editor"');
    expect(has(plain, "stage-points-inexpressible")).toBe(false);
  });

  it("sweep: every (sport, variant) in the registry - the state with its rulebook reason on the rulebook splits, the editor on every other (counted, both sides > 0)", () => {
    let checked = 0;
    let state = 0;
    for (const { m, variant } of VARIANTS) {
      const id = `${m.key}/${variant}`;
      const html = render(m, variant, null);
      if (RULEBOOK_SPLITS[id] !== undefined) {
        expect(html, id).toContain('data-stage-points-state="inexpressible"');
        expect(text(html), `${id}: the reason`).toContain(stateSentence(id));
        expect(html, `${id}: no control`).not.toMatch(/<(input|select|button)/);
        state++;
      } else {
        expect(html, id).toContain('data-stage-points-state="editor"');
        expect(has(html, "stage-points-inexpressible"), `${id}: no state card`).toBe(false);
      }
      checked++;
    }
    expect(checked, "every division").toBe(VARIANTS.length);
    expect(state, "the rulebook splits, each reached").toBe(Object.keys(RULEBOOK_SPLITS).length);
    expect(checked - state, "and editors").toBeGreaterThan(0);
  });

  it("the stage's own rules move it: a hockey league stage switching FIH's shoot-out on gets the state; a bracket stage is never asked", () => {
    const m = sport("hockey");
    const shootout = (m.configSchema.parse(m.variants["fih-shootout"]) as { shootout: unknown }).shootout;
    expect(render(m, "fih-outdoor", null), "no shoot-out: the editor").toContain('data-stage-points-state="editor"');
    expect(render(m, "fih-outdoor", null, { stageConfig: { rules: { shootout } } }), "the stage's own shoot-out").toContain('data-stage-points-state="inexpressible"');
  });

  it("fail-closed: a division config the sport refuses (no sport rule to compare against) gets the state with the general sentence and no control, never the editor", () => {
    const m = sport("icehockey");
    const refused = { ...(m.variants.iihf as Record<string, unknown>), periods: "many" };
    expect(m.configSchema.safeParse(refused).success, "premise: the sport refuses this config").toBe(false);
    const html = render(m, "iihf", null, { divisionConfig: refused });
    expect(html).toContain('data-stage-points-state="inexpressible"');
    expect(text(html), "no split to name: the general sentence").toContain(UI["stagePoints.inexpressible"]!);
    expect(html, "no control").not.toMatch(/<(input|select|button)/);
  });

  it("editor: the base sentence, the walkover row and the bonus add menu are all there for every stored rule - no plan note, no held boxes", () => {
    let checked = 0;
    for (const stored of [{ ...HEAD, bonuses: [] }, FORFEIT_RULE, { ...HEAD, bonuses: [{ when: "draw", points: 1 }] }]) {
      const html = render(football, "11-a-side", stored);
      expect(html).toContain('data-stage-points-state="editor"');
      expect(has(html, "stage-points-walkover-w") && has(html, "stage-points-bonus-add"), JSON.stringify(stored)).toBe(true);
      for (const id of ["stage-points-win", "stage-points-draw", "stage-points-loss"]) expect(tagOf(html, id), `${JSON.stringify(stored)}: ${id} is editable`).not.toContain("disabled");
      // the plan copy is gone from the product: neither a note nor a held-boxes line
      for (const id of ["stage-points-upgrade", "stage-points-gate-held"]) expect(has(html, id), id).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
    expect(render(football, "11-a-side", null), "and nothing stored inherits the division's, still the editor").toContain('data-stage-points-state="editor"');
  });
});

describe("fix round 1 I2: a STORED own rule on a division the editor cannot say is read beside the reason, never hidden, and clears", () => {
  const OWN: PointsRule = { win: { regulation: 4 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1 } };

  it("an editable stage: the reason, the stored rule in the public line's words, and 'Use the division's points' (the one change that flattens nothing) - no input (counted over every rulebook split)", () => {
    let checked = 0;
    for (const { m, variant } of SPLIT) {
      const id = `${m.key}/${variant}`;
      const html = render(m, variant, OWN);
      expect(html, id).toContain('data-stage-points-state="inexpressible"');
      expect(text(html), `${id}: the reason`).toContain(stateSentence(id));
      expect(text(html.slice(html.indexOf('data-testid="stage-points-readonly"'))), `${id}: it says the stage has its own`).toContain(UI["stagePoints.ownPoints"]!);
      expect(text(html), `${id}: the stored rule, read`).toContain(rulesLineText(POINTS_DICT, pointsLine(OWN, { awardReaches: pointsRuleAwardReachesTable(m) })));
      expect(text(tagOf(html, "stage-points-clear") + html.slice(html.indexOf('data-testid="stage-points-clear"'))), `${id}: clear`).toContain(UI["stagePoints.useDivision"]!);
      expect(html, `${id}: no input`).not.toMatch(/<(input|select)/);
      checked++;
    }
    expect(checked, "rulebook splits swept").toBe(SPLIT.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a locked stage or a viewer: the reason and the stored rule are read, and there is no control at all (the server holds the same lock)", () => {
    const m = sport("icehockey");
    const html = render(m, "iihf", OWN, { readOnly: true });
    expect(html).toContain('data-stage-points-state="inexpressible"');
    expect(has(html, "stage-points-readonly") && has(html, "stage-points-preview"), "the rule is read").toBe(true);
    expect(text(html)).toContain(stateSentence("icehockey/iihf"));
    expect(html).not.toMatch(/<(input|select|button)/);
    const inheriting = render(m, "iihf", null, { readOnly: true });
    expect(inheriting, "nothing stored, a viewer: the reason alone").not.toMatch(/<(input|select|button)/);
    expect(has(inheriting, "stage-points-readonly"), "no own rule to read").toBe(false);
  });
});

describe("what a failed Save says (review M2)", () => {
  const m = enMsg;

  it("a 402 says the server's own reason when it names one, else the server's message - never a canned plan sentence", () => {
    const reason = "Custom points need the Pro plan.";
    expect(failureText(new ApiV1Error("Payment required", 402, "PAYMENT_REQUIRED", { reason }), m)).toBe(reason);
    expect(failureText(new ApiV1Error("Payment required", 402, "PAYMENT_REQUIRED", {}), m), "no reason: the message").toBe("Payment required");
    expect(failureText(new ApiV1Error("Payment required", 402, "PAYMENT_REQUIRED", { reason: 3 }), m), "a reason that is not text is not said").toBe("Payment required");
  });

  it("a rule refusal is said in the app's words; one it cannot say keeps the server's message; a plain error its own", () => {
    // W2d T10: the points save's own refusal now is POINTS_OUTCOME_UNCOVERED (coverage), said from its `uncovered` outcomes.
    const refused = failureText(new ApiV1Error("english from the server", 422, "POINTS_OUTCOME_UNCOVERED", { stage_name: "Pool A", uncovered: ["draw"] }), m);
    expect(refused).toBe(UI["rules.err.pointsOutcomeUncovered"]!.replace("{outcome}", UI["rules.err.outcome.draw"]!));
    expect(refused).not.toBe("english from the server");
    expect(failureText(new ApiV1Error("english from the server", 422, "POINTS_OUTCOME_UNCOVERED", { uncovered: [] }), m), "no outcome to name: the message").toBe("english from the server");
    // Fix round 1 I2: the flat-over-split refusal, from its `splits` (a stale page that still showed the editor).
    const flattened = failureText(new ApiV1Error("english from the server", 422, "POINTS_SPLIT_FLATTENED", { splits: ["otWin", "otLoss"] }), m);
    expect(flattened).toBe(stateSentence("icehockey/iihf"));
    expect(failureText(new ApiV1Error("english from the server", 422, "POINTS_SPLIT_FLATTENED", { splits: ["a_future_split"] }), m), "a split it cannot name: the message").toBe("english from the server");
    expect(failureText(new ApiV1Error("boom", 500, "INTERNAL", {}), m)).toBe("boom");
    expect(failureText(new Error("offline"), m)).toBe("offline");
    expect(failureText("odd", m)).toBe("odd");
  });
});

describe("the use-division toggle and the preview", () => {
  it("nothing stored: 'Use the division's points' is checked, no inputs, the division's base is previewed, and there is nothing to save", () => {
    const html = render(football, "11-a-side", null);
    expect(tagOf(html, "stage-points-use-division")).toContain('checked=""');
    expect(has(html, "stage-points-win"), "no inputs while inheriting").toBe(false);
    expect(has(html, "stage-points-save"), "nothing to save").toBe(false);
    expect(text(tagOf(html, "stage-points-preview") + html.slice(html.indexOf('data-testid="stage-points-preview"')))).toContain(rulesLineText(POINTS_DICT, pointsLine({ ...HEAD, bonuses: [] })));
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
    const stored = { win: { regulation: 2 }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1, awardScore: [21, 0] } };
    expect(text(render(football, "11-a-side", stored))).toContain(rulesLineText(POINTS_DICT, [{ key: "format.points.forfeitScore", params: { winner: 21, loser: 0 } }]).toLowerCase());
    expect(text(render(badminton, "bwf", stored))).not.toContain(rulesLineText(POINTS_DICT, [{ key: "format.points.forfeitScore", params: { winner: 21, loser: 0 } }]).toLowerCase());
  });

  it("no public dictionary, no preview - and the section still works", () => {
    const html = render(football, "11-a-side", SCORED_RULE, { pointsDict: undefined });
    expect(has(html, "stage-points-preview")).toBe(false);
    expect(has(html, "stage-points-win")).toBe(true);
  });

  it("a sport that cannot draw gets the two-part sentence (no draw box)", () => {
    const html = render(badminton, "bwf", { win: { regulation: 2 }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] });
    expect(has(html, "stage-points-draw")).toBe(false);
    expect(has(html, "stage-points-win") && has(html, "stage-points-loss")).toBe(true);
    expect(has(render(football, "11-a-side", { ...HEAD, bonuses: [] }), "stage-points-draw")).toBe(true);
  });
});

describe("bonus rows", () => {
  const STORED: PointsRule = { ...HEAD, bonuses: [{ when: "loss_margin_lte", param: 7, points: 1 }, { when: "forfeit_win", points: 2 }] };

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
    const g = options(render(generic, "score", { ...HEAD, bonuses: [] }));
    expect(g).toEqual(offeredBonusKinds(generic, generic.variants.score));
    expect(g).toContain("loss_margin_lte");
    const b = options(render(badminton, "bwf", { win: { regulation: 2 }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] }));
    expect(b).toEqual(offeredBonusKinds(badminton, badminton.variants.bwf));
    expect(b.length, "badminton still has walkover bonuses").toBeGreaterThan(0);
    expect(b).not.toContain("loss_margin_lte");
  });

  it("a stored bonus the add menu would not offer is still shown (never silently dropped)", () => {
    const html = render(badminton, "bwf", { win: { regulation: 2 }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [{ when: "loss_margin_lte", param: 3, points: 1 }] });
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
    expect(text(inherited)).toContain(rulesLineText(POINTS_DICT, pointsLine({ ...HEAD, bonuses: [] })));
  });

  it("fix round 1 I2: on a division the editor fits, a viewer reads the division's points - the state is the rulebook splits' alone", () => {
    const m = sport("icehockey");
    const html = render(m, "recreational", null, { readOnly: true });
    expect(html).toContain('data-stage-points-state="readonly"');
    expect(has(html, "stage-points-inexpressible")).toBe(false);
    expect(text(html)).toContain(UI["stagePoints.divisionPoints"]!);
  });
});

describe("pointsLineDict carries every key the preview can emit", () => {
  it("each clause pointsLine produces, for a rule that uses every part, is in the slice and in the real dictionary", () => {
    const everything: PointsRule = {
      ...HEAD,
      bonuses: [{ when: "loss_margin_lte", param: 7, points: 1 }, { when: "forfeit_win", points: 2 }],
      forfeit: { winnerPoints: 4, loserPoints: 1, awardScore: [3, 0] },
    };
    const keys = new Set([...pointsLine(everything, { awardReaches: true }), ...pointsLine({ ...HEAD, bonuses: [] }), ...pointsLine({ ...HEAD, bonuses: [{ when: "draw", points: 1 }] })].map((c) => c.key));
    expect(keys.size, "clause keys exercised").toBeGreaterThanOrEqual(4);
    for (const key of keys) {
      expect(Object.hasOwn(POINTS_DICT, key), `${key} is in the slice`).toBe(true);
      expect(Object.hasOwn(enPublic, key), `${key} is in public.json`).toBe(true);
    }
  });
});
