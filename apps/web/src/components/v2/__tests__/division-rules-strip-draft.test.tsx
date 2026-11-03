// Match Day C9 (owner 2026-11-02): the division builder's Division rules step IS the Division rules strip, in a draft
// mode. A draft has no division yet, so the strip edits state the builder owns and sends at Create:
//   - it draws no Save anywhere (format, points, tie-breaks), and its editors are handed no save;
//   - every control calls the builder's own setter (variant, rule values, online play, points, order) - never its own
//     form, so what was typed survives the builder moving between its steps;
//   - the rule grid inherits the PICKED variant's preset (nothing is stored yet), as the create lays the overrides over it;
//   - an organisation's own preset is marked as the org's in the builder's picker (as the builder's own select did);
//   - for chess, online play is asked BEFORE the variant: it decides which clocks the division may use. That order holds in
//     the saved strip too (one component, one order).
// Driven through the real strip (hook harness, editors opened by `expandRules`); expected values come from the engine's
// variant presets and the dictionaries, never from the strip.
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { MatchFormatEditor } from "@/components/v2/rules/match-format-editor";
import { PointsEditor } from "@/components/v2/rules/points-editor";
import { TiebreaksEditor } from "@/components/v2/rules/tiebreaks-editor";
import type { DivisionRulesDraft } from "@/components/v2/rules/division-rules-strip";
import uiEn from "@/dictionaries/en/ui.json";
import { ALL_PANELS, DivisionRulesStrip, expandRules, stripPropsOf } from "./_rules-strip";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
  useLocaleOrDefault: () => "en" as const,
}));
const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

beforeEach(() => apiV1Mock.mockReset());

const UI = uiEn as Record<string, string>;
const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return m as AnySportModule;
};
const variantsOf = (key: string) =>
  Object.entries(mod(key).variants as Record<string, Record<string, unknown>>).map(([k, config]) => ({ key: k, name: k, system: true, config }));

/** A draft whose every setter is a spy, opening on `variantKey`. */
function draftOn(variantKey: string, over: Partial<DivisionRulesDraft> = {}): DivisionRulesDraft {
  return {
    variantKey,
    onVariantChange: vi.fn(),
    ruleValues: {},
    setRuleValues: vi.fn(),
    onlinePlay: "off",
    setOnlinePlay: vi.fn(),
    pointsValues: null,
    setPointsValues: vi.fn(),
    order: null,
    setOrder: vi.fn(),
    ...over,
  };
}

/** The strip in draft mode for `sport`, every panel open (so a Save anywhere would be drawn), as the builder mounts it:
 *  no division id, the picked variant's preset as the config, a league table. */
function mountDraft(sport: string, draft: DivisionRulesDraft, variants = variantsOf(sport), overrides: Record<string, unknown> = {}) {
  // The builder hands the strip the config the division would be created with: the preset under the typed overrides.
  const preset = { ...(variants.find((v) => v.key === draft.variantKey)?.config ?? {}), ...overrides };
  return renderIsland(
    DivisionRulesStrip,
    stripPropsOf(
      { division: { id: "", sport_key: sport, variant_key: draft.variantKey, config: preset }, variants, onlineChessOffered: true },
      { draft, initialOpen: ALL_PANELS, tableKinds: ["league"] },
    ),
    expandRules,
  );
}
const byTestId = (tree: ReactElement[], id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
const SAVES = ["division-rules-format-save", "division-points-save", "division-tiebreaks-save"];

describe("the Division rules strip in the builder's draft mode", () => {
  it("draws no Save on any panel, and hands its editors no save; the saved strip's positive pair draws them (counts)", () => {
    const sport = "football";
    const draft = mountDraft(sport, draftOn(variantsOf(sport)[0]!.key, { pointsValues: { win: "5", draw: "1", loss: "0" }, order: ["points"] as TiebreakerKey[] }));
    const tree = draft.tree();
    let checked = 0;
    for (const id of SAVES) {
      expect(byTestId(tree, id), `draft: ${id}`).toBeUndefined();
      checked++;
    }
    for (const type of [PointsEditor, TiebreaksEditor]) {
      const el = tree.find((e) => e.type === type && propsOf(e).scope === "division");
      expect(el, `draft: the ${type.name} is drawn`).toBeDefined();
      expect(propsOf(el!).onSave, `draft: ${type.name} has no save`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(5);
    // The positive pair: the saved strip, the same panels open and the same edits typed into its own forms, draws a Save.
    const saved = renderIsland(
      DivisionRulesStrip,
      stripPropsOf({ division: { id: "d1", sport_key: sport, variant_key: variantsOf(sport)[0]!.key, config: {} }, variants: variantsOf(sport) }, { initialOpen: ALL_PANELS, tableKinds: ["league"] }),
      expandRules,
    );
    expect(byTestId(saved.tree(), "division-rules-format-save"), "saved: the format Save").toBeDefined();
    expect(propsOf(saved.tree().find((e) => e.type === PointsEditor && propsOf(e).scope === "division")!).onSave, "saved: points can save").toBeTypeOf("function");
  });

  it("every control calls the builder's setter: variant, rule grid, points, order (and nothing is PATCHed)", () => {
    const sport = "badminton";
    const [first, second] = variantsOf(sport);
    expect(second, "premise: badminton has a second variant").toBeDefined();
    const d = draftOn(first!.key);
    const tree = mountDraft(sport, d).tree();

    (propsOf(byTestId(tree, "division-settings-variant")!).onChange as (e: unknown) => void)({ target: { value: second!.key } });
    expect(d.onVariantChange).toHaveBeenCalledWith(second!.key);
    expect(d.setRuleValues, "a variant pick does not re-seed the grid itself: the builder does").not.toHaveBeenCalled();

    const grid = tree.find((e) => e.type === MatchFormatEditor && propsOf(e).mode === "edit")!;
    (propsOf(grid).onChange as (v: Record<string, string>) => void)({ setTo: "15" });
    expect(d.setRuleValues).toHaveBeenCalledWith({ setTo: "15" });

    const points = tree.find((e) => e.type === PointsEditor && propsOf(e).scope === "division")!;
    (propsOf(points).onChange as (v: Record<string, string>) => void)({ w: "3" });
    expect(d.setPointsValues).toHaveBeenCalledWith({ w: "3" });

    const order = tree.find((e) => e.type === TiebreaksEditor && propsOf(e).scope === "division")!;
    (propsOf(order).onChange as (v: TiebreakerKey[] | null) => void)(["wins"] as TiebreakerKey[]);
    expect(d.setOrder).toHaveBeenCalledWith(["wins"]);

    expect(apiV1Mock, "a draft never PATCHes").not.toHaveBeenCalled();
  });

  it("the grid inherits the PICKED variant's preset - not the config with the typed overrides laid over it - for every variant", () => {
    const sport = "badminton";
    const variants = variantsOf(sport);
    let checked = 0;
    for (const v of variants) {
      // A typed set target (19) the builder's config already carries: inherited is what the grid shows UNDER it.
      const tree = mountDraft(sport, draftOn(v.key, { ruleValues: { setTo: "19" } }), variants, { setTo: 19 }).tree();
      const grid = tree.find((e) => e.type === MatchFormatEditor && propsOf(e).mode === "edit")!;
      expect((v.config as { setTo?: unknown }).setTo, `${v.key}: premise, the preset's own target differs`).not.toBe(19);
      expect(propsOf(grid).inherited, v.key).toEqual(v.config);
      checked++;
    }
    expect(checked, "every badminton variant").toBe(variants.length);
    expect(checked).toBeGreaterThan(1);
  });

  it("an organisation's own preset is marked as the org's in the draft's picker, and only there", () => {
    const sport = "badminton";
    const variants = [...variantsOf(sport), { key: "club-night", name: "Club night", system: false, config: {} }];
    const optionText = (tree: ReactElement[], key: string) =>
      // The harness joins an element's text children with a space; the browser does not, so whitespace is normalised.
      textOf(tree.find((e) => e.type === "option" && propsOf(e).value === key)!).replace(/\s+/g, " ").trim();
    const draft = mountDraft(sport, draftOn("club-night"), variants).tree();
    expect(optionText(draft, "club-night")).toBe(`Club night${UI["wizard.orgPreset"]}`);
    expect(optionText(draft, variants[0]!.key), "a system variant carries no mark").not.toContain(UI["wizard.orgPreset"]!.trim());
    const saved = renderIsland(
      DivisionRulesStrip,
      stripPropsOf({ division: { id: "d1", sport_key: sport, variant_key: "club-night", config: {} }, variants }, { initialOpen: ALL_PANELS }),
      expandRules,
    ).tree();
    expect(optionText(saved, "club-night"), "Settings names it as the organiser did").toBe("Club night");
  });
});

describe("chess asks online play before the variant (owner 2026-11-02)", () => {
  const order = (tree: ReactElement[]) =>
    tree.map((e) => propsOf(e)["data-testid"]).filter((id): id is string => id === "division-online-play" || id === "division-settings-variant");

  it("in the draft and in the saved strip: online play, then the variant", () => {
    const chess = variantsOf("boardgame");
    expect(order(mountDraft("boardgame", draftOn(chess[0]!.key)).tree())).toEqual(["division-online-play", "division-settings-variant"]);
    const saved = renderIsland(
      DivisionRulesStrip,
      stripPropsOf({ division: { id: "d1", sport_key: "boardgame", variant_key: chess[0]!.key, config: {} }, variants: chess, onlineChessOffered: true }, { initialOpen: ALL_PANELS }),
      expandRules,
    );
    expect(order(saved.tree())).toEqual(["division-online-play", "division-settings-variant"]);
  });

  it("Lichess picked in the draft: the builder's setter is called, and the eight-control clock appears beside it", () => {
    const chess = variantsOf("boardgame");
    const d = draftOn(chess[0]!.key);
    const tree = mountDraft("boardgame", d).tree();
    (propsOf(byTestId(tree, "division-online-play")!).onChange as (e: unknown) => void)({ target: { value: "lichess" } });
    expect(d.setOnlinePlay).toHaveBeenCalledWith("lichess");
    expect(byTestId(tree, "division-time-control"), "off: no Lichess clock").toBeUndefined();
    const on = mountDraft("boardgame", draftOn(chess[0]!.key, { onlinePlay: "lichess" })).tree();
    const clock = byTestId(on, "division-time-control");
    expect(clock, "on: the Lichess clock").toBeDefined();
    // Lichess plays eight controls (online-time-control.ts); the select lists them, plus "Choose" while none is picked.
    const options = walk(propsOf(clock!).children as ReactNode).filter((e) => e.type === "option" && propsOf(e).value !== "");
    expect(options.length).toBe(8);
  });
});
