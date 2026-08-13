// Football skin tests (S11/#420 W9). `layout()` is PURE and is the only part
// of a skin this repo's node-only vitest can exercise directly (no jsdom, no
// @testing-library — see skins/types.ts's own header). Every test below
// therefore asserts on `footballSkin.layout()` output, or on the shared
// `createSkinDispatch` primitive fed a REAL football view — never on
// rendered DOM.
//
// `fullView` below is a deliberate, exact duplicate of skin-coverage.test.ts's
// own local (unexported) helper of the same name — see that file's header
// for why "sweep exactly the cfg space the shared gate sweeps" requires this
// rather than a hand-abbreviated stand-in. `cfgSpace`/`grantAllEntitlements`
// ARE exported by `_cfg-space.ts` for exactly this kind of per-skin reuse
// (its own header: "extracted... so both suites import it").
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import type { AnySportModule, PadSpec } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { allActionViews, buildPadView, type PadActionView, type PadView } from "../view-model";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { ActionForm } from "../action-form";
import { FootballSkin, footballSkin } from "../skins/football-skin";
import { createSkinDispatch, layoutActionTypes, layoutActionTypesAt, type SkinLayout, type SkinProps } from "../skins/types";
import { cfgSpace, grantAllEntitlements } from "./_cfg-space";

const FULL_BAND = 3 as const;

const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football");
if (!footballModule) throw new Error("football module missing from builtinModules — cannot test the football skin");

function fullView(spec: PadSpec, ctx: { band: typeof FULL_BAND; entitlements: Record<string, boolean> }): PadView {
  const resolved = allActionViews(spec, ctx);
  const byType = new Map(resolved.map((action) => [action.type, action]));
  const panels = spec.panels
    .map((panel) => ({
      labelKey: panel.labelKey,
      phase: panel.phase,
      layout: panel.layout,
      actions: panel.actions.map((action) => byType.get(action.type)).filter((a) => a !== undefined),
    }))
    .filter((panel) => panel.actions.length > 0);
  return { phase: "live", phases: ["pre", "live", "post"], panels };
}

interface CfgEntry {
  cfg: unknown;
  spec: PadSpec;
}

/** Every distinct cfg in football's whole cfg space, spec-resolved — default,
 *  every named variant (11-a-side/youth/small-sided/mini-soccer), and every
 *  single cfg-leaf override, INCLUDING `shootout: true`, which no shipped
 *  variant sets (module header, this file's own dispatch brief). */
function footballCfgSpace(): CfgEntry[] {
  const entries: CfgEntry[] = [];
  for (const cfg of cfgSpace(footballModule!)) {
    const spec = footballModule!.padSpec?.(cfg);
    if (spec) entries.push({ cfg, spec });
  }
  return entries;
}

function isShootoutCfg(cfg: unknown): boolean {
  return !!cfg && typeof cfg === "object" && (cfg as { shootout?: unknown }).shootout === true;
}

describe("football skin: cfg space sanity", () => {
  it("walks more than one cfg and includes a shootout:true leaf no shipped variant sets", () => {
    const entries = footballCfgSpace();
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.some((e) => isShootoutCfg(e.cfg))).toBe(true);
    expect(entries.some((e) => !isShootoutCfg(e.cfg))).toBe(true);
  });
});

describe("football skin: coverage (own scope of the shared gate)", () => {
  it("places every action the view declares exactly once, invents none, for every cfg", () => {
    const problems: string[] = [];
    for (const { cfg, spec } of footballCfgSpace()) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const view = fullView(spec, ctx);
      const expected = new Set(allActionViews(spec, ctx).map((a) => a.type));
      const layout = footballSkin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
      const placed = layoutActionTypes(layout);
      const placedSet = new Set(placed);
      const cfgId = JSON.stringify(cfg).slice(0, 100);

      if (placed.length !== placedSet.size) problems.push(`duplicate in ${cfgId}`);
      for (const type of expected) if (!placedSet.has(type)) problems.push(`missing ${type} in ${cfgId}`);
      for (const type of placedSet) if (!expected.has(type)) problems.push(`invented ${type} in ${cfgId}`);
    }
    expect(problems).toEqual([]);
  });

  it("places football.shootout.kick if and only if cfg.shootout is true", () => {
    const withIt = footballCfgSpace().filter((e) => isShootoutCfg(e.cfg));
    const withoutIt = footballCfgSpace().filter((e) => !isShootoutCfg(e.cfg));
    expect(withIt.length).toBeGreaterThan(0);
    expect(withoutIt.length).toBeGreaterThan(0);

    for (const { cfg, spec } of withIt) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      expect(layoutActionTypes(layout)).toContain("football.shootout.kick");
    }
    for (const { cfg, spec } of withoutIt) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      expect(layoutActionTypes(layout)).not.toContain("football.shootout.kick");
    }
  });

  it("never produces a duplicate group id or an empty group, for any cfg", () => {
    for (const { cfg, spec } of footballCfgSpace()) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      const ids = layout.groups.map((g) => g.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const group of layout.groups) expect(group.actions.length).toBeGreaterThan(0);
    }
  });

  it("never falls back to the unlisted safety-net group against today's real spec", () => {
    // KNOWN_GROUPS in football-skin.tsx names every one of the 9 real action
    // types; "more-unlisted" exists only as a forward-compat net for an
    // action type this table does not yet know about. It should never fire
    // against the spec as it exists today -- a regression here means the
    // module grew a 10th action type this skin has not been told about.
    for (const { cfg, spec } of footballCfgSpace()) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      expect(layout.groups.map((g) => g.id)).not.toContain("more-unlisted");
    }
  });
});

describe("football skin: prominence and the goal / card / sub flows", () => {
  it("draws football.goal and football.period at primary prominence, for every cfg", () => {
    for (const { cfg, spec } of footballCfgSpace()) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      const primary = layoutActionTypesAt(layout, "primary");
      expect(primary).toContain("football.goal");
      expect(primary).toContain("football.period");
    }
  });

  it("gives football.card its own reachable group, never merged with goal/period/subs", () => {
    for (const { cfg, spec } of footballCfgSpace()) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      const group = layout.groups.find((g) => g.actions.includes("football.card"));
      expect(group).toBeDefined();
      expect(group!.actions).toEqual(["football.card"]);
      expect(group!.prominence).not.toBe("drawer"); // reachable without an extra disclosure tap
    }
  });

  it("gives football.sub its own reachable group, never merged with goal/period/cards", () => {
    for (const { cfg, spec } of footballCfgSpace()) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      const group = layout.groups.find((g) => g.actions.includes("football.sub"));
      expect(group).toBeDefined();
      expect(group!.actions).toEqual(["football.sub"]);
      expect(group!.prominence).not.toBe("drawer");
    }
  });

  it("keeps sin-bin start/end and (when present) the shoot-out kick in one drawer group", () => {
    for (const { cfg, spec } of footballCfgSpace()) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      const group = layout.groups.find((g) => g.actions.includes("football.sinbin.start"));
      expect(group).toBeDefined();
      expect(group!.prominence).toBe("drawer");
      expect(group!.actions).toContain("football.sinbin.end");
      if (isShootoutCfg(cfg)) expect(group!.actions).toContain("football.shootout.kick");
    }
  });

  it("football.goal declares side + scorer + assist as attribution, with no other required field -- the fact the fast goal/assist tile's tap budget depends on", () => {
    const { spec } = footballCfgSpace()[0]!;
    const goal = spec.panels.flatMap((p) => p.actions).find((a) => a.type === "football.goal")!;
    expect(goal.attribution.map((a) => `${a.kind}:${a.path}`)).toEqual(["side:by", "person:scorer", "person:assist"]);
    for (const field of goal.fields) {
      // ownGoal/penalty are toggles (default false, never block submit); the
      // `at.*` stamp fields are the only non-toggle fields and are excluded
      // from the fast tile entirely (see football-skin.tsx's own header).
      expect(field.kind === "toggle" || field.path.startsWith("at.")).toBe(true);
    }
  });

  it("football.card declares side + person attribution, with color as the one required field", () => {
    const { spec } = footballCfgSpace()[0]!;
    const card = spec.panels.flatMap((p) => p.actions).find((a) => a.type === "football.card")!;
    expect(card.attribution.map((a) => `${a.kind}:${a.path}`)).toEqual(["side:by", "person:person"]);
    expect(card.fields.find((f) => f.path === "color")).toBeDefined();
  });

  it("football.sub declares side + off + on as attribution -- both off and on are mandatory, which is why the fast tile needs exactly two chip picks", () => {
    const { spec } = footballCfgSpace()[0]!;
    const sub = spec.panels.flatMap((p) => p.actions).find((a) => a.type === "football.sub")!;
    expect(sub.attribution.map((a) => `${a.kind}:${a.path}`)).toEqual(["side:by", "person:off", "person:on"]);
  });
});

describe("football skin: header", () => {
  it("is non-null with score/clock/period fields for every cfg, even against an empty {} state", () => {
    for (const { cfg, spec } of footballCfgSpace()) {
      const ctx = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
      const layout = footballSkin.layout(fullView(spec, ctx), { cfg, state: {}, summary: {}, band: FULL_BAND });
      expect(layout.header).not.toBeNull();
      const ids = layout.header!.fields.map((f) => f.id);
      expect(ids).toEqual(expect.arrayContaining(["score", "clock", "period"]));
      for (const field of layout.header!.fields) {
        expect(field.value.length).toBeGreaterThan(0);
        expect(typeof field.emphasis).toBe("boolean");
      }
    }
  });

  it("reflects real goals and the current phase from a folded state", () => {
    const { cfg, spec } = footballCfgSpace()[0]!;
    const state = {
      phase: "H1",
      goals: { home: 2, away: 1 },
      asOf: { period: "H1", elapsed: 632 }, // 10:32
    };
    const layout = footballSkin.layout(fullView(spec, { band: FULL_BAND, entitlements: grantAllEntitlements(spec) }), {
      cfg,
      state,
      summary: {},
      band: FULL_BAND,
    });
    const byId = Object.fromEntries(layout.header!.fields.map((f) => [f.id, f.value]));
    expect(byId.score).toContain("2");
    expect(byId.score).toContain("1");
    expect(byId.period).toBe("H1");
    expect(byId.clock).toBe("10:32");
  });

  it("does not show a clock reading stamped for a phase the state has since left", () => {
    const { cfg, spec } = footballCfgSpace()[0]!;
    const state = { phase: "H2", goals: { home: 0, away: 0 }, asOf: { period: "H1", elapsed: 2700 } };
    const layout = footballSkin.layout(fullView(spec, { band: FULL_BAND, entitlements: grantAllEntitlements(spec) }), {
      cfg,
      state,
      summary: {},
      band: FULL_BAND,
    });
    const clock = layout.header!.fields.find((f) => f.id === "clock")!;
    expect(clock.value).not.toContain("45"); // not the stale H1 reading
  });

  it("defaults the score to 0-0 and the period to pre-kickoff when state carries no goals/phase at all", () => {
    const { cfg, spec } = footballCfgSpace()[0]!;
    const layout = footballSkin.layout(fullView(spec, { band: FULL_BAND, entitlements: grantAllEntitlements(spec) }), {
      cfg,
      state: {},
      summary: {},
      band: FULL_BAND,
    });
    const byId = Object.fromEntries(layout.header!.fields.map((f) => [f.id, f.value]));
    expect(byId.score).toContain("0");
    expect(byId.period).toBe("pre");
  });
});

describe("football skin: dispatch safety against a real football view", () => {
  function realView(): PadView {
    const cfg = cfgSpace(footballModule!)[0];
    const spec = footballModule!.padSpec!(cfg);
    return buildPadView(spec, {
      state: {},
      summary: {},
      phase: "live",
      band: FULL_BAND,
      entitlements: grantAllEntitlements(spec),
    });
  }

  it("refuses an action type the football view does not declare", async () => {
    const sent: string[] = [];
    const dispatch = createSkinDispatch(realView(), async (type) => void sent.push(type));
    await expect(dispatch("football.invented", { by: "home-1" })).rejects.toThrow(/does not declare/);
    expect(sent).toEqual([]);
  });

  it("passes a declared football.goal straight through to the chassis submit", async () => {
    const sent: { type: string; payload: unknown }[] = [];
    const dispatch = createSkinDispatch(realView(), async (type, payload) => void sent.push({ type, payload }));
    await dispatch("football.goal", { by: "home-1", scorer: "p1", assist: "p2" });
    expect(sent).toEqual([{ type: "football.goal", payload: { by: "home-1", scorer: "p1", assist: "p2" } }]);
  });
});

// ---------------------------------------------------------------------------
// Component rendering (S11 review gap 1). `footballLayout` above places every
// group generically (KNOWN_GROUPS + the leftover net), and every test above
// this point only exercises that pure function — the one thing this repo's
// node-only vitest can call directly (skins/types.ts's own header). But the
// COMPONENT, before this fix, gated its primary/secondary sections on FIVE
// HARDCODED literal checks (`primary.has("football.goal")` etc.) — only the
// drawer section walked `layout.groups` generically. A KNOWN_GROUPS entry
// added at primary/secondary prominence under any other id would satisfy
// every test above AND the shared skin-coverage.test.ts gate (both assert on
// layout() data alone) while rendering NOTHING on screen.
//
// These tests drive the real `FootballSkin` Component through this repo's
// node-only `_hook-harness` (`renderIsland` — no jsdom; see
// pad-renderer.test.tsx, this workspace's worked example) against a
// HAND-BUILT layout carrying exactly that shape, and assert on the rendered
// ELEMENT (an `<ActionForm action=.../>`'s own props), not on markup —
// same idiom pad-renderer.test.tsx's own Panel tests use.
// ---------------------------------------------------------------------------

function findAll(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement[] {
  return tree.filter(pred);
}
const isType = (type: unknown) => (el: ReactElement) => el.type === type;

function actionFormTypes(tree: ReactElement[]): string[] {
  return findAll(tree, isType(ActionForm)).map((el) => (propsOf(el).action as PadActionView).type);
}

function mysteryActionView(): PadActionView {
  return {
    type: "football.mystery",
    labelKey: { key: "pad.football.action.mystery", label: "Mystery Action" },
    fields: [],
    attribution: [],
    availability: { kind: "available" },
  };
}

/** A layout carrying ONE group at the given prominence, under an id
 *  ("mystery") none of `FootballSkin`'s five hardcoded clauses name — the
 *  exact shape a future `KNOWN_GROUPS` entry would produce. */
function renderWithUnnamedGroup(prominence: "primary" | "secondary") {
  const { cfg, spec } = footballCfgSpace()[0]!;
  const view: PadView = {
    phase: "live",
    phases: ["live"],
    panels: [
      {
        labelKey: { key: "pad.football.panel.mystery", label: "Mystery" },
        phase: "live",
        layout: "grid",
        actions: [mysteryActionView()],
      },
    ],
  };
  const layout: SkinLayout = {
    header: { fields: [{ id: "score", value: "0 - 0", captionKey: "scorepad.skin.football.header.score", emphasis: true }] },
    groups: [{ id: "mystery", prominence, actions: ["football.mystery"] }],
  };
  const props: SkinProps = {
    view,
    spec,
    ctx: { cfg, state: {}, summary: {}, band: FULL_BAND },
    layout,
    dispatch: async () => {},
    queueDepth: 0,
    offline: false,
    submittingType: null,
  };
  return renderIsland(FootballSkin, props);
}

describe("football skin: Component draws every primary/secondary group the layout produces (S11 review gap 1)", () => {
  it("renders an unnamed PRIMARY group's action, not just the five hardcoded ones", () => {
    const island = renderWithUnnamedGroup("primary");
    expect(actionFormTypes(island.tree())).toContain("football.mystery");
  });

  it("renders an unnamed SECONDARY group's action, not just the five hardcoded ones", () => {
    const island = renderWithUnnamedGroup("secondary");
    expect(actionFormTypes(island.tree())).toContain("football.mystery");
  });
});

// ---------------------------------------------------------------------------
// S12/#421 pass B (owner-approved widening into skins/**): the goal scorer/
// assist chip options rendered the raw person id as their label.
// `ctx.personNames` (S11's SkinLayoutCtx) has existed since S11 but this skin
// never consumed it. `personOptions()` (a plain function, not a component)
// runs as part of FootballSkin's own render pass -- it is called while
// building the `slots` PROP handed to the (uninvoked, nested)
// <QuickActionCard/> element, so its resolved output is already sitting on
// that element's props by the time the harness walks the tree; no click to
// open the tile is needed to read it.
// ---------------------------------------------------------------------------
describe("football skin: goal scorer/assist chip options show ctx.personNames, not a raw id (S12/#421 pass B)", () => {
  const SCORER = "p-scorer-1";

  interface QuickSlotLike {
    path: string;
    options: readonly { value: string; label: string }[];
  }

  function quickSlotsOf(tree: ReactElement[]): QuickSlotLike[] {
    const withSlots = tree.filter((el) => Array.isArray((propsOf(el) as { slots?: unknown }).slots));
    return withSlots.flatMap((el) => (propsOf(el) as unknown as { slots: QuickSlotLike[] }).slots);
  }

  function renderGoalsWithRoster(personNames: Readonly<Record<string, string>> | undefined) {
    const { cfg, spec } = footballCfgSpace()[0]!;
    const ctx0 = { band: FULL_BAND, entitlements: grantAllEntitlements(spec) };
    const view = fullView(spec, ctx0);
    const state = { squads: { home: { onPitch: [SCORER], bench: [] }, away: { onPitch: [], bench: [] } } };
    const layout = footballSkin.layout(view, { cfg, state, summary: {}, band: FULL_BAND });
    const props: SkinProps = {
      view,
      spec,
      ctx: { cfg, state, summary: {}, band: FULL_BAND, personNames },
      layout,
      dispatch: async () => {},
      queueDepth: 0,
      offline: false,
      submittingType: null,
    };
    return renderIsland(FootballSkin, props);
  }

  it("shows the resolved name in the scorer chip options, not the raw id", () => {
    const island = renderGoalsWithRoster({ [SCORER]: "Amara Scorer" });
    const labels = quickSlotsOf(island.tree())
      .filter((s) => s.path === "scorer")
      .flatMap((s) => s.options.map((o) => o.label));
    expect(labels).toContain("Amara Scorer");
    expect(labels).not.toContain(SCORER);
  });

  it("falls back to the raw id when ctx carries no personNames -- total without a roster", () => {
    const island = renderGoalsWithRoster(undefined);
    const labels = quickSlotsOf(island.tree())
      .filter((s) => s.path === "scorer")
      .flatMap((s) => s.options.map((o) => o.label));
    expect(labels).toContain(SCORER);
  });
});
