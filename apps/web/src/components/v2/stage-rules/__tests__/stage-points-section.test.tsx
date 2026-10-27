// W2c Task 18 (S3) - the stage points section, REACHED: the real component, rendered the way the stage card renders it. Static
// markup (no DOM, no effects): this is the "is the control on the screen, in this state, for this sport" half; clicking,
// saving and reloading are the e2e's. Expected values come from the engine's declarations (`pointsRuleAwardReachesTable`,
// `offeredBonusKinds` over `validatePointsRule`) and from the dictionaries the product renders - none is typed here. Every
// sweep reports how many items it checked and zero is a failure. W2d Task 16 (spec §9 "Points section, widened") retired
// Task 10 fix round 1 I2's "can't be set per stage yet" state: every division gets the editor, one row per outcome the
// stage reaches, and a division whose sport pays an outcome its own way (the rulebooks' list, `_points-split-rulebook.ts`)
// says the split in its own rows — a flat rule stored there is refused INLINE, in the server's words.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { PointsRule, legacyPointsRule, pointsRuleAwardReachesTable, reachableOutcomes } from "@seazn/engine/competition";
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
import { offeredBonusKinds, pointsRows, stagePointsContext } from "../stage-points-model";
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
  over: { readOnly?: boolean; pointsDict?: Dict; kind?: string; stageConfig?: Record<string, unknown>; divisionConfig?: Record<string, unknown>; pinned?: unknown } = {},
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
        pinned={over.pinned}
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
/** The divisions the rulebooks split: W2c/T10's flat editor could not say their points; T16's rows do. */
const SPLIT = VARIANTS.filter(({ m, variant }) => RULEBOOK_SPLITS[`${m.key}/${variant}`] !== undefined);
/** The flat-over-split refusal's sentence for a rulebook row, built from the en dictionary the product renders (never the
 *  helper's own). */
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

  it("sweep: every sport and variant shows the score iff the engine's table reads it (W2d T16: the rulebook splits get the editor too)", () => {
    let shown = 0;
    let hidden = 0;
    let checked = 0;
    for (const { m, variant } of VARIANTS) {
        const html = render(m, variant, { ...HEAD, bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0 } });
        const score = has(html, "stage-points-award-w") && has(html, "stage-points-award-l");
        expect(score, `${m.key}/${variant}`).toBe(pointsRuleAwardReachesTable(m));
        expect(has(html, "stage-points-walkover-w"), `${m.key}/${variant}: the walkover points are on every sport`).toBe(true);
        if (score) shown++;
        else hidden++;
        checked++;
    }
    expect(checked, "every division swept").toBe(VARIANTS.length);
    expect(SPLIT.length, "the rulebook splits among them").toBeGreaterThan(0);
    expect(shown, "goal sports").toBeGreaterThan(0);
    expect(hidden, "set sports and the rest").toBeGreaterThan(0);
  });
});

/** The outcome rows a render shows, in order (their testids' outcome part). */
const rowKeys = (html: string): string[] => [...html.matchAll(/data-testid="stage-points-row-([a-zA-Z0-9-]+)"/g)].map((x) => x[1]!);
const rowId = (key: string): string => key.replace(/[.:]/g, "-");

describe("W2d T16: every division gets the editor, one row per outcome the stage reaches (the I2 state is retired)", () => {
  it("ice hockey (IIHF): the editor, its overtime and shoot-out rows read as the sport pays them (3 / 2 / 1 / 0) — never the can't-set state", () => {
    const m = sport("icehockey");
    const html = render(m, "iihf", null);
    expect(html).toContain('data-stage-points-state="editor"');
    expect(has(html, "stage-points-inexpressible")).toBe(false);
    // IIHF RBG: 3 for a regulation win, 2 for a win in overtime or a shoot-out, 1 for such a loss, 0 for a regulation loss.
    const rows = text(html.slice(html.indexOf('data-testid="stage-points-rows"')));
    for (const [label, n] of [["stagePoints.row.win", 3], ["stagePoints.row.winOt", 2], ["stagePoints.row.winSo", 2], ["stagePoints.row.lossOt", 1], ["stagePoints.row.lossSo", 1], ["stagePoints.row.loss", 0]] as const)
      expect(rows, label).toContain(`${UI[label]!}: ${n}`);
    expect(has(html, "stage-points-row-draw"), "IIHF has no draws").toBe(false);
    // Opened as its own rule: a box per split.
    const own = render(m, "iihf", PointsRule.parse(m.tablePointsRule(m.configSchema.parse(m.variants.iihf), "league")));
    expect(tagOf(own, "stage-points-win-ot")).toContain('value="2"');
    expect(tagOf(own, "stage-points-loss-ot")).toContain('value="1"');
    expect(has(own, "stage-points-win-so") && has(own, "stage-points-loss-so"), "shoot-out boxes (blank: the overtime value)").toBe(true);
    expect(has(own, "stage-points-refusal"), "the sport's own rule is taken").toBe(false);
  });

  it("sweep: every (sport, variant) in the registry gets the editor; nothing stored, it lists exactly the rows the stage reaches (counted, rulebook splits reached)", () => {
    let checked = 0;
    let rowsSeen = 0;
    let splits = 0;
    for (const { m, variant } of VARIANTS) {
      const id = `${m.key}/${variant}`;
      const cfg = m.variants[variant] as Record<string, unknown>;
      const html = render(m, variant, null);
      expect(html, id).toContain('data-stage-points-state="editor"');
      expect(has(html, "stage-points-inexpressible"), `${id}: no state card`).toBe(false);
      const ctx = stagePointsContext(m, cfg, { kind: "league", config: {} })!;
      const reach = [...reachableOutcomes(m, cfg, "league")];
      const want = pointsRows(ctx.reachable, ctx.rule).filter((r) => r.shown).map((r) => rowId(r.key));
      expect(rowKeys(html), id).toEqual(want);
      // Each row the page shows is an outcome the engine says the stage reaches.
      for (const k of rowKeys(html)) expect(reach.map(rowId), `${id}: ${k}`).toContain(k);
      rowsSeen += want.length;
      if (RULEBOOK_SPLITS[id] !== undefined) splits++;
      checked++;
    }
    expect(checked, "every division").toBe(VARIANTS.length);
    expect(splits, "the rulebook splits, each reached").toBe(Object.keys(RULEBOOK_SPLITS).length);
    expect(rowsSeen, "rows checked").toBeGreaterThan(checked * 2);
  });

  it("the stage's own rules move it: a hockey league stage switching FIH's shoot-out on gets B2's row — 'counts as a draw; the winner gets +1' — and a bonus box when it is its own", () => {
    const m = sport("hockey");
    const shootout = (m.configSchema.parse(m.variants["fih-shootout"]) as { shootout: unknown }).shootout;
    const plain = render(m, "fih-outdoor", null);
    expect(has(plain, "stage-points-row-win-so"), "no shoot-out: no row").toBe(false);
    const so = render(m, "fih-outdoor", null, { stageConfig: { rules: { shootout } } });
    expect(text(tagOf(so, "stage-points-row-win-so") + so.slice(so.indexOf('data-testid="stage-points-row-win-so"')))).toContain(UI["stagePoints.row.soDraw"]!.replace("{bonus}", "1"));
    expect(has(so, "stage-points-row-loss-so"), "one row for both sides").toBe(false);
    const own = render(m, "fih-shootout", PointsRule.parse(m.tablePointsRule(m.configSchema.parse(m.variants["fih-shootout"]), "league")));
    expect(has(own, "stage-points-so-bonus"), "its own rule: the bonus box").toBe(true);
  });

  it("fail-closed: a division config the sport refuses (no sport rule to read) gets the state with the general sentence and no control, never the editor", () => {
    const m = sport("icehockey");
    const refused = { ...(m.variants.iihf as Record<string, unknown>), periods: "many" };
    expect(m.configSchema.safeParse(refused).success, "premise: the sport refuses this config").toBe(false);
    const html = render(m, "iihf", null, { divisionConfig: refused });
    expect(html).toContain('data-stage-points-state="inexpressible"');
    expect(text(html), "the general sentence").toContain(UI["stagePoints.inexpressible"]!);
    expect(html, "no control").not.toMatch(/<(input|select|button)/);
  });

  it("fail-closed with a rule the stage STORES: the general sentence AND the rule (its line, its preview); an editor can clear it, a viewer cannot; no preview without the public dictionary", () => {
    const m = sport("icehockey");
    const refused = { ...(m.variants.iihf as Record<string, unknown>), periods: "many" };
    expect(m.configSchema.safeParse(refused).success, "premise: the sport refuses this config").toBe(false);
    const own = { ...HEAD, bonuses: [] };
    expect(PointsRule.safeParse(own).success, "premise: the stored rule is one the schema takes").toBe(true);
    const after = (html: string, testId: string): string => {
      const at = html.indexOf(`data-testid="${testId}"`);
      expect(at, `${testId} is on the page`).toBeGreaterThan(-1);
      return text(html.slice(html.indexOf(">", at) + 1, html.indexOf("</", at)));
    };
    const editor = render(m, "iihf", own, { divisionConfig: refused });
    expect(editor).toContain('data-stage-points-state="inexpressible"');
    expect(text(editor), "the general sentence").toContain(UI["stagePoints.inexpressible"]!);
    expect(after(editor, "stage-points-readonly"), "the rule is read").toContain(UI["stagePoints.ownPoints"]!);
    expect(after(editor, "stage-points-preview").trim().length, "the stored rule's preview says something").toBeGreaterThan(0);
    expect(tagOf(editor, "stage-points-clear"), "an editor can clear it").toMatch(/^<button/);
    expect(editor.match(/<(input|select)/g), "and nothing else to edit").toBeNull();

    const viewer = render(m, "iihf", own, { divisionConfig: refused, readOnly: true });
    expect(after(viewer, "stage-points-readonly"), "a viewer reads the rule").toContain(UI["stagePoints.ownPoints"]!);
    expect(has(viewer, "stage-points-preview")).toBe(true);
    expect(has(viewer, "stage-points-clear"), "a viewer cannot clear it").toBe(false);
    expect(viewer, "a viewer has no control").not.toMatch(/<(input|select|button)/);

    expect(has(render(m, "iihf", own, { divisionConfig: refused, pointsDict: undefined }), "stage-points-preview"), "no public dictionary: no preview").toBe(false);
  });

  it("editor: the outcome boxes, the walkover row and the bonus add menu are all there for every stored rule - no plan note, no held boxes", () => {
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

  it("chess shows points, not half-points: 1 / ½ / 0 read, 1 / 0.5 / 0 in the boxes, and its presets as chips (3 / 1 / 0 off Swiss only)", () => {
    const m = sport("boardgame");
    const html = render(m, "classical", null);
    const rows = text(html.slice(html.indexOf('data-testid="stage-points-rows"')));
    expect(rows).toContain(`${UI["stagePoints.row.win"]!}: 1`);
    expect(rows).toContain(`${UI["stagePoints.row.draw"]!}: ½`);
    const own = render(m, "classical", PointsRule.parse(m.tablePointsRule(m.configSchema.parse(m.variants.classical), "league")));
    expect(tagOf(own, "stage-points-draw")).toContain('value="0.5"');
    expect(tagOf(own, "stage-points-preset-fide_1_half_0")).toContain('aria-pressed="true"');
    expect(tagOf(own, "stage-points-preset-three_one_zero")).toContain('aria-pressed="false"');
    const swiss = render(m, "classical", PointsRule.parse(m.tablePointsRule(m.configSchema.parse(m.variants.classical), "swiss")), { kind: "swiss" });
    expect(has(swiss, "stage-points-preset-fide_1_half_0") && !has(swiss, "stage-points-preset-three_one_zero"), "Swiss: no 3 / 1 / 0").toBe(true);
  });
});

describe("W2d T16: a flat rule STORED on a division the rulebooks split opens in the editor with the server's refusal inline, never hidden", () => {
  const OWN: PointsRule = { win: { regulation: 4 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 1 } };

  it("an editable stage: its numbers in the boxes and, inline, what the server says of it — the splits it flattens, or the outcome it leaves unpaid (counted over every rulebook split)", () => {
    let checked = 0;
    for (const { m, variant } of SPLIT) {
      const id = `${m.key}/${variant}`;
      const html = render(m, variant, OWN);
      expect(html, id).toContain('data-stage-points-state="editor"');
      expect(tagOf(html, "stage-points-win"), `${id}: its own numbers`).toContain('value="4"');
      // A reachable tie the stored rule does not pay is coverage's refusal (cricket); every other split the flat-over-split one.
      const reach = reachableOutcomes(m, m.variants[variant], "league");
      const want =
        reach.has("tie") && OWN.tie === undefined
          ? UI["rules.err.pointsOutcomeUncovered"]!.replace("{outcome}", UI["rules.err.outcome.tie"]!)
          : stateSentence(id);
      expect(text(tagOf(html, "stage-points-refusal") + html.slice(html.indexOf('data-testid="stage-points-refusal"'))), `${id}: the refusal`).toContain(want);
      expect(tagOf(html, "stage-points-save"), `${id}: nothing to send`).toContain("disabled");
      checked++;
    }
    expect(checked, "rulebook splits swept").toBe(SPLIT.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a locked stage or a viewer: the stored rule is read, row by row, and there is no control at all", () => {
    const m = sport("icehockey");
    const html = render(m, "iihf", OWN, { readOnly: true });
    expect(html).toContain('data-stage-points-state="readonly"');
    expect(has(html, "stage-points-readonly") && has(html, "stage-points-preview") && has(html, "stage-points-rows"), "the rule is read").toBe(true);
    expect(text(html)).toContain(`${UI["stagePoints.row.winOt"]!}: 4`);
    expect(html).not.toMatch(/<(input|select|button)/);
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

  it("a viewer of a division with no split reads the division's points (and no state card)", () => {
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

// W2d final review I1 (controller ruling, 2026-10-26): a stage pinned at generate keeps paying its pin after a division
// points save lands, so its card must say the PIN's points, in words that say they were fixed when it started - never "the
// division's points" over a number the table does not pay. Expected: the pin is football's own table rule for the division
// as it stood (11-a-side's 3/1/0), the live division is the one the test stores (win 2), the words are the en dictionary's.
describe("W2d final review I1: a pinned stage's card says the pin's points and that they were fixed at the start", () => {
  const CFG = football.variants["11-a-side"] as Record<string, unknown>;
  const PIN = PointsRule.parse(football.tablePointsRule(football.configSchema.parse(CFG), "league"));
  type Flat = { win: number; draw: number; loss: number };
  const LIVE_POINTS: Flat = { ...(football.configSchema.parse(CFG) as { points: Flat }).points, win: 2 };
  const LIVE = { ...CFG, points: LIVE_POINTS };
  const say = (win: number, draw: number, loss: number) =>
    rulesLineText(POINTS_DICT, pointsLine(legacyPointsRule({ base: { win, draw, loss } }), { awardReaches: pointsRuleAwardReachesTable(football) }));
  const PIN_WORDS = say(PIN.win.regulation, PIN.draw!, PIN.loss.regulation);
  const LIVE_WORDS = say(LIVE_POINTS.win, LIVE_POINTS.draw, LIVE_POINTS.loss);
  const previewOf = (html: string): string => {
    const at = html.indexOf('data-testid="stage-points-preview"');
    expect(at, "a preview is on the card").toBeGreaterThan(-1);
    return text(html.slice(html.indexOf(">", at) + 1, html.indexOf("</p>", at))).trim();
  };

  it("premise: the pin pays win 3, the live division win 2, and the two read differently", () => {
    expect(PIN.win.regulation).toBe(3);
    expect(LIVE_POINTS.win).toBe(2);
    expect(PIN_WORDS).not.toBe(LIVE_WORDS);
  });

  it("read-only (a started stage): the pin's 3 under the started wording - never 2, never the division wording; unpinned it is the live 2 under the division wording", () => {
    const pinned = render(football, "11-a-side", null, { readOnly: true, divisionConfig: LIVE, pinned: PIN });
    expect(pinned).toContain('data-stage-points-basis="pin"');
    expect(text(tagOf(pinned, "stage-points-readonly") + pinned.slice(pinned.indexOf('data-testid="stage-points-readonly"')))).toContain(UI["stagePoints.startedPoints"]!);
    expect(text(pinned)).not.toContain(UI["stagePoints.divisionPoints"]!);
    expect(previewOf(pinned)).toBe(PIN_WORDS);
    const unpinned = render(football, "11-a-side", null, { readOnly: true, divisionConfig: LIVE });
    expect(unpinned, "the positive pair").toContain('data-stage-points-basis="division"');
    expect(text(unpinned)).toContain(UI["stagePoints.divisionPoints"]!);
    expect(text(unpinned)).not.toContain(UI["stagePoints.startedPoints"]!);
    expect(previewOf(unpinned)).toBe(LIVE_WORDS);
  });

  it("the editor (pinned, not yet scored): the inheriting preview is the pin's 3 with the started line; unpinned it is the live 2 with none", () => {
    const pinned = render(football, "11-a-side", null, { divisionConfig: LIVE, pinned: PIN });
    expect(pinned).toContain('data-stage-points-state="editor"');
    expect(tagOf(pinned, "stage-points-use-division")).toContain('checked=""');
    // PR B carry: the checkbox never claims a pinned stage plays the division's points.
    const label = (html: string) => text(html.slice(html.indexOf('data-testid="stage-points-use-division"'), html.indexOf("</label>", html.indexOf('data-testid="stage-points-use-division"'))));
    expect(label(pinned)).toContain(UI["stagePoints.keepStarted"]!);
    expect(label(pinned)).not.toContain(UI["stagePoints.useDivision"]!);
    expect(text(tagOf(pinned, "stage-points-started") + pinned.slice(pinned.indexOf('data-testid="stage-points-started"')))).toContain(UI["stagePoints.startedPoints"]!);
    expect(previewOf(pinned)).toBe(PIN_WORDS);
    expect(has(pinned, "stage-points-save"), "inheriting the pin: nothing to save").toBe(false);
    const unpinned = render(football, "11-a-side", null, { divisionConfig: LIVE });
    expect(has(unpinned, "stage-points-started"), "the positive pair: no started line").toBe(false);
    expect(label(unpinned), "the positive pair: the division's points").toContain(UI["stagePoints.useDivision"]!);
    expect(previewOf(unpinned)).toBe(LIVE_WORDS);
  });

  it("an own rule outranks the pin: the own wording and the own rule's words, on the editor and read-only", () => {
    const own: PointsRule = { ...HEAD, win: { regulation: 5 }, bonuses: [] };
    for (const readOnly of [true, false]) {
      const html = render(football, "11-a-side", own, { readOnly, divisionConfig: LIVE, pinned: PIN });
      expect(html, `readOnly=${readOnly}`).toContain('data-stage-points-basis="own"');
      expect(has(html, "stage-points-started"), `readOnly=${readOnly}: no started line`).toBe(false);
      expect(previewOf(html)).toBe(rulesLineText(POINTS_DICT, pointsLine(own, { awardReaches: true })));
    }
  });
});
