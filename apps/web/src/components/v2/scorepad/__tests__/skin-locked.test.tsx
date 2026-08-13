// Skin locked-action rendering (S11/#420 W9 — defect found by review).
//
// THE DEFECT: every `PadActionView` carries `availability` — `{kind:
// "available"}` or `{kind:"locked", reason}` ("locked" = the org's plan does
// not include that action's fidelity band). panel.tsx's universal renderer
// branches on it (`renderLockedTile`, panel.tsx:57-69): available draws a
// real `ActionForm`, locked draws a static, dimmed, non-submitting tile with
// its reason — "never a form that would fail server-side" (view-model.ts's
// own header). cricket-skin.tsx, tennis-skin.tsx and football-skin.tsx each
// do the same. racquet-skin.tsx and period-skin.tsx did NOT check
// `availability` at all before this fix — zero references in either file —
// so a locked action for volleyball, badminton, tabletennis, hockey or
// icehockey rendered as a live, tappable control the server would then
// refuse.
//
// WHY skin-coverage.test.ts NEVER CAUGHT THIS: its sweep (and every other
// skin test file's own sweep) calls `grantAllEntitlements(spec)`
// (_cfg-space.ts) before every cfg it walks, so `availability.kind` is
// `"locked"` NOWHERE in that suite, for any skin, ever. That gate proves
// "every action the sport declares gets PLACED somewhere"; it is
// structurally blind to whether a placed action is a live control or a
// static tile. This file is the coverage for that entirely different
// class — the gate itself stays untouched (dispatch brief).
//
// CONTROL GROUP: cricket/tennis/football already branch correctly (the
// defect report's own words: "each do the same" as panel.tsx), so their
// cases below must be GREEN from the very first run, with zero production
// changes. racquet/period must be RED first (TDD — this file is written and
// run BEFORE either skin is touched), then green once fixed. Three-pass/
// two-fail is the actual proof this suite exercises the branch, rather than
// just asserting a tile shows up somewhere regardless of what else renders
// beside it.
//
// WHY A CUSTOM `expand`: this repo's node-only `_hook-harness` renders ONE
// function component one level deep — `walk()` never CALLS a nested
// component, it only follows the STATIC `.props.children` a JSX literal
// already carries (pad-renderer.test.tsx's own header; panel.tsx's: "PLAIN
// FUNCTIONS ... called directly rather than JSX-instantiated"). tennis-
// skin.tsx, football-skin.tsx and period-skin.tsx compose their action lists
// entirely through plain function calls (period-skin.tsx's own header names
// this convention explicitly) — `walk()` alone already sees everything
// those three render, including the locked tile. cricket-skin.tsx and
// racquet-skin.tsx do NOT: their action lists are drawn inside `AdminGroup`
// and `GroupBody`, genuine JSX-instantiated components, so a plain `walk()`
// sees only an opaque `<AdminGroup/>`/`<GroupBody/>` element and nothing of
// what — or whether a bug — is inside it. `deepExpand` below is `walk()`
// plus one extra rule: for a closed allowlist of function components THIS
// FILE HAS READ AND CONFIRMED HOOKLESS, call them directly and keep walking
// their real return value — exactly the extension point the harness's own
// header documents ("a caller passes its own [expand] when a CHILD
// component also has to be expanded — only safe for hookless children").
// `ActionForm` (a real per-instance-state component, same as everywhere
// else in this codebase) and cricket's OTHER nested component,
// `ThisOverGroup` (owns real `useState` for the ball/wicket flow), are
// deliberately NOT in that allowlist — calling either outside React's own
// render would throw "Invalid hook call". This suite never needs
// `ThisOverGroup`: the cricket case below places its locked action in a
// group id other than "thisOver", which routes to `AdminGroup` instead.
import { describe, expect, it } from "vitest";
import { isValidElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ActionForm } from "../action-form";
import { cricketSkin } from "../skins/cricket-skin";
import { tennisSkin } from "../skins/tennis-skin";
import { footballSkin } from "../skins/football-skin";
import { racquetSkin } from "../skins/racquet-skin";
import { periodSkin } from "../skins/period-skin";
import type { SkinLayout, SkinLayoutCtx, SkinProps } from "../skins/types";
import type { PadActionView, PadPanelView, PadView } from "../view-model";
import type { PadSpec } from "@seazn/engine/sport";

function find(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement {
  const el = tree.find(pred);
  if (!el) throw new Error("element not found in rendered tree");
  return el;
}
function findAll(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement[] {
  return tree.filter(pred);
}
const isType = (type: unknown) => (el: ReactElement) => el.type === type;
const isNamed = (name: string) => (el: ReactElement) => typeof el.type === "function" && el.type.name === name;

/** Function components hand-verified (by reading their bodies) to call no
 *  React hooks — see this file's own header for why that is the bar, and
 *  why `ThisOverGroup`/`ActionForm`/`QuickActionCard` are deliberately
 *  absent. `AdminGroup` (cricket-skin.tsx) and `GroupBody` (racquet-
 *  skin.tsx) are the only two nested, JSX-instantiated components either
 *  skin ever routes a placed action's rendering through. */
const EXPANDABLE = new Set(["AdminGroup", "GroupBody"]);

/** `walk()` (_hook-harness.tsx) plus one rule: an allowlisted function
 *  component is CALLED directly (props exactly as its JSX-instantiating
 *  parent already built them) and its own return value is walked too,
 *  recursively — so a component nested two components deep would still be
 *  reached. Everything else (host elements, and any component NOT on the
 *  allowlist — `ActionForm` chief among them) is pushed as an opaque
 *  element and never called, exactly matching `walk()`'s own behaviour. */
function deepExpand(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) deepExpand(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  const type = node.type;
  if (typeof type === "function" && EXPANDABLE.has(type.name)) {
    return deepExpand((type as (p: unknown) => ReactNode)(node.props), out);
  }
  return deepExpand((node.props as { children?: ReactNode }).children, out);
}

/** All visible text across the (already `deepExpand`-ed) flat element list —
 *  `textOf` on the whole array visits every entry independently and
 *  descends into whatever REAL children it finds, so text that only exists
 *  inside an expanded `AdminGroup`/`GroupBody` call is included. Some
 *  duplication across overlapping ancestor/descendant entries is expected
 *  and harmless for a `.toContain()` check. */
function allText(tree: ReactElement[]): string {
  return textOf(tree);
}

const REASON_KEY = "scorepad.locked.reason";
const REASON_TEXT = "Upgrade your plan to unlock this action.";
const LOCKED_REASON = { key: REASON_KEY, label: REASON_TEXT } as const;

/** Mirrors racquet-skin.test.ts's own `action()` fixture helper exactly
 *  (same `pad.test.${type}` fake-key convention, proven there to typecheck
 *  and to resolve to `label` verbatim via `padLabel`'s own fallback rule —
 *  scoring-vocab.ts: an unrecognised key returns `engineLabel` unchanged).
 *  `fields`/`attribution` both empty on purpose: an empty `attribution`
 *  makes racquet-skin.tsx's own `isSideTapOnly` false regardless of type
 *  name, which is what routes this fixture through `GroupBody`'s "detailed"
 *  branch (`ActionForm`) rather than `SideTapAction` — the one live-control
 *  shape every one of these five cases actually shares. */
function lockedAction(type: string, label: string): PadActionView {
  return {
    type,
    labelKey: { key: `pad.test.${type}`, label },
    fields: [],
    attribution: [],
    availability: { kind: "locked", reason: LOCKED_REASON },
  };
}

function view(action: PadActionView): PadView {
  const panel: PadPanelView = {
    labelKey: { key: "pad.test.panel", label: "Test panel" },
    phase: "live",
    layout: "primary",
    actions: [action],
  };
  return { phase: "live", phases: ["live"], panels: [panel] };
}

const EMPTY_CTX: SkinLayoutCtx = { cfg: {}, state: {}, summary: {}, band: 3 };

/** Renders a skin's real exported `Component` through the node-only harness,
 *  with `deepExpand` as the flattener — see this file's header for why that
 *  is not just `walk()`. `spec` is the one `SkinProps` field none of these
 *  five Components ever reads (each destructures view/layout/ctx/dispatch/
 *  submittingType/offline/queueDepth only — confirmed by reading all five),
 *  so a bare cast stands in for it, matching this test family's own
 *  established `as never`/`as unknown as X` convention for a fixture field
 *  that is structurally irrelevant to what is under test.
 *
 *  `SkinDef.Component` is typed `ComponentType<SkinProps>` (types.ts) —
 *  class-or-function, because React's own type allows both — but every
 *  skin actually exported here is a plain function component (`export
 *  function XxxSkin(props: SkinProps)`), which is exactly what
 *  `renderIsland` needs to call directly. The cast reflects that real,
 *  already-true shape; it does not paper over a genuine mismatch. */
function renderSkin(Component: ComponentType<SkinProps>, props: Omit<SkinProps, "spec">) {
  return renderIsland(Component as (p: SkinProps) => ReactNode, { ...props, spec: {} as unknown as PadSpec } as SkinProps, deepExpand);
}

describe("cricket skin — locked action (control group: must pass with zero production changes)", () => {
  it("renders the label and locked reason in a static tile, never an ActionForm", () => {
    const action = lockedAction("cricket.newball", "New ball");
    const layout: SkinLayout = { header: null, groups: [{ id: "misc", prominence: "primary", actions: ["cricket.newball"] }] };
    const island = renderSkin(cricketSkin.Component, {
      view: view(action),
      layout,
      ctx: EMPTY_CTX,
      dispatch: async () => {},
      queueDepth: 0,
      offline: false,
      submittingType: null,
    });
    const tree = island.tree();
    const text = allText(tree);
    expect(text).toContain("New ball");
    expect(text).toContain(REASON_TEXT);
    expect(findAll(tree, isType(ActionForm)).length).toBe(0);
  });
});

describe("tennis skin — locked action (control group: must pass with zero production changes)", () => {
  it("renders the label and locked reason in a static tile, never an ActionForm", () => {
    // Deliberately NOT "tennis.point": that one bare type name gets a
    // bespoke plain Home/Away button pair (renderPrimaryAction's
    // `isPlainPoint`) instead of `ActionForm` — this case is the ordinary
    // `renderActionTile` path every other tennis action takes.
    const action = lockedAction("tennis.fault", "Fault");
    const layout: SkinLayout = { header: null, groups: [{ id: "point", prominence: "primary", actions: ["tennis.fault"] }] };
    const island = renderSkin(tennisSkin.Component, {
      view: view(action),
      layout,
      ctx: EMPTY_CTX,
      dispatch: async () => {},
      queueDepth: 0,
      offline: false,
      submittingType: null,
    });
    const tree = island.tree();
    const text = allText(tree);
    expect(text).toContain("Fault");
    expect(text).toContain(REASON_TEXT);
    expect(findAll(tree, isType(ActionForm)).length).toBe(0);
  });
});

describe("football skin — locked action (control group: must pass with zero production changes)", () => {
  it("renders the label and locked reason in a static tile, never an ActionForm or a QuickActionCard", () => {
    // football.card is football's own "fast tile" shape: available renders
    // a REAL stateful `QuickActionCard` (owns useState — never expanded
    // here), guarded by the exact same `if (action.availability.kind ===
    // "locked") return renderLockedTile(...)` check BEFORE that component
    // is ever instantiated (renderQuickSection, football-skin.tsx). That
    // means the ActionForm check alone would not catch a regression here —
    // this is the one case in this file that needs the extra assertion.
    // Label deliberately NOT "Card": the group's own heading resolves to
    // "Cards" (src/dictionaries/en/ui.json's scorepad.skin.football.group.
    // cards), which contains "Card" as a bare substring — asserting that
    // exact word would pass even if the tile itself rendered nothing, off
    // the group heading alone. Same reasoning for racquet's/period's labels
    // below (measured against "Timeouts"/"Goals" the same way).
    const action = lockedAction("football.card", "Book a player");
    const layout: SkinLayout = { header: null, groups: [{ id: "cards", prominence: "secondary", actions: ["football.card"] }] };
    const island = renderSkin(footballSkin.Component, {
      view: view(action),
      layout,
      ctx: EMPTY_CTX,
      dispatch: async () => {},
      queueDepth: 0,
      offline: false,
      submittingType: null,
    });
    const tree = island.tree();
    const text = allText(tree);
    expect(text).toContain("Book a player");
    expect(text).toContain(REASON_TEXT);
    expect(findAll(tree, isType(ActionForm)).length).toBe(0);
    expect(findAll(tree, isNamed("QuickActionCard")).length).toBe(0);
  });
});

describe("racquet skin — locked action (S11/#420 W9 fix: racquet-skin.tsx never checked availability)", () => {
  it("renders the label and locked reason in a static tile, never an ActionForm", () => {
    // Label deliberately NOT "Timeout" — see the football case's comment on
    // why: this group's own heading resolves to "Timeouts".
    const action = lockedAction("volleyball.timeout", "Pause the clock");
    const layout: SkinLayout = { header: null, groups: [{ id: "timeouts", prominence: "drawer", actions: ["volleyball.timeout"] }] };
    const island = renderSkin(racquetSkin.Component, {
      view: view(action),
      layout,
      ctx: EMPTY_CTX,
      dispatch: async () => {},
      queueDepth: 0,
      offline: false,
      submittingType: null,
    });
    const tree = island.tree();
    const text = allText(tree);
    expect(text).toContain("Pause the clock");
    expect(text).toContain(REASON_TEXT);
    expect(findAll(tree, isType(ActionForm)).length).toBe(0);
  });
});

describe("period skin — locked action (S11/#420 W9 fix: period-skin.tsx never checked availability)", () => {
  it("renders the label and locked reason in a static tile, never an ActionForm", () => {
    // Label deliberately NOT "Goal" — see the football case's comment on
    // why: this group's own heading resolves to "Goals".
    const action = lockedAction("hockey.goal", "Record the goal");
    const layout: SkinLayout = { header: null, groups: [{ id: "goal", prominence: "primary", actions: ["hockey.goal"] }] };
    const island = renderSkin(periodSkin.Component, {
      view: view(action),
      layout,
      ctx: EMPTY_CTX,
      dispatch: async () => {},
      queueDepth: 0,
      offline: false,
      submittingType: null,
    });
    const tree = island.tree();
    const text = allText(tree);
    expect(text).toContain("Record the goal");
    expect(text).toContain(REASON_TEXT);
    expect(findAll(tree, isType(ActionForm)).length).toBe(0);
  });
});

describe("racquet + period skins — an AVAILABLE action still renders its real control (fix must not over-lock)", () => {
  it("racquet: an available action still gets a real ActionForm, wired to dispatch", () => {
    const action: PadActionView = {
      type: "volleyball.timeout",
      labelKey: { key: "pad.test.volleyball.timeout", label: "Timeout" },
      fields: [],
      attribution: [],
      availability: { kind: "available" },
    };
    const layout: SkinLayout = { header: null, groups: [{ id: "timeouts", prominence: "drawer", actions: ["volleyball.timeout"] }] };
    const island = renderSkin(racquetSkin.Component, {
      view: view(action),
      layout,
      ctx: EMPTY_CTX,
      dispatch: async () => {},
      queueDepth: 0,
      offline: false,
      submittingType: null,
    });
    const tree = island.tree();
    const formEl = find(tree, isType(ActionForm));
    expect((propsOf(formEl).action as PadActionView).type).toBe("volleyball.timeout");
  });

  it("period: an available action still gets a real ActionForm, wired to dispatch", () => {
    const action: PadActionView = {
      type: "hockey.goal",
      labelKey: { key: "pad.test.hockey.goal", label: "Goal" },
      fields: [],
      attribution: [],
      availability: { kind: "available" },
    };
    const layout: SkinLayout = { header: null, groups: [{ id: "goal", prominence: "primary", actions: ["hockey.goal"] }] };
    const island = renderSkin(periodSkin.Component, {
      view: view(action),
      layout,
      ctx: EMPTY_CTX,
      dispatch: async () => {},
      queueDepth: 0,
      offline: false,
      submittingType: null,
    });
    const tree = island.tree();
    const formEl = find(tree, isType(ActionForm));
    expect((propsOf(formEl).action as PadActionView).type).toBe("hockey.goal");
  });
});
