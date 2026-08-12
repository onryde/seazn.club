// pad-renderer.tsx + panel.tsx + action-form.tsx (S10/#419 W8, chassis item
// 2) — the React surface that draws a PadView. Driven through the repo's
// node-only `_hook-harness` (no DOM/jsdom in this workspace): `renderIsland`
// installs React's own hook dispatcher and returns the rendered element
// tree, so a click/change handler can be found and invoked directly — see
// reference_hook_harness_click_without_dom.md. `ActionForm` and `Panel` are
// tested directly here (their own `renderIsland` calls) rather than in
// separate files — this file is their only test coverage, per the S10
// dispatch's FILES YOU OWN list.
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import type { PadActionView } from "../view-model";
import { ActionForm } from "../action-form";
import { Panel } from "../panel";

function find(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement {
  const el = tree.find(pred);
  if (!el) throw new Error("element not found in rendered tree");
  return el;
}
function findAll(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement[] {
  return tree.filter(pred);
}
const isType = (type: unknown) => (el: ReactElement) => el.type === type;

const AVAILABLE = { kind: "available" as const };

describe("ActionForm — zero-field action submits on a single tap", () => {
  it("calls onSubmit with an empty-ish payload immediately, no expansion step", () => {
    const action: PadActionView = {
      type: "cricket.newball",
      labelKey: { key: "pad.cricket.action.newBall", label: "New ball" },
      fields: [],
      attribution: [],
      availability: AVAILABLE,
    };
    let submitted: unknown = "not called";
    const island = renderIsland(ActionForm, { action, onSubmit: (p: unknown) => (submitted = p) });
    const button = find(island.tree(), isType("button"));
    expect(textOf(button)).toContain("New ball");
    propsOf(button).onClick as () => void;
    (propsOf(button).onClick as () => void)();
    expect(submitted).toEqual({});
  });
});

describe("ActionForm — an action with fields expands, validates, and only submits once valid", () => {
  const action: PadActionView = {
    type: "cricket.ball",
    labelKey: { key: "pad.cricket.action.ball", label: "Ball" },
    fields: [{ kind: "number", path: "runs.bat", min: 0, max: 6, labelKey: { key: "pad.x", label: "Runs" } }],
    attribution: [],
    availability: AVAILABLE,
  };

  it("tapping the tile expands the field editor instead of submitting", () => {
    let submitted: unknown = null;
    const island = renderIsland(ActionForm, { action, onSubmit: (p: unknown) => (submitted = p) });
    const tile = find(island.tree(), isType("button"));
    (propsOf(tile).onClick as () => void)();
    const tree = island.tree();
    expect(findAll(tree, isType("input")).length).toBeGreaterThan(0);
    expect(submitted).toBeNull();
  });

  it("the confirm button is disabled until the required field is filled, then submits the built payload", () => {
    let submitted: unknown = null;
    const island = renderIsland(ActionForm, { action, onSubmit: (p: unknown) => (submitted = p) });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();

    let tree = island.tree();
    const buttons = findAll(tree, isType("button"));
    const confirmBtn = find(buttons, (b) => textOf(b).length > 0 && propsOf(b)["data-role"] === "confirm");
    expect(propsOf(confirmBtn).disabled).toBe(true);

    const numberInput = find(tree, isType("input"));
    (propsOf(numberInput).onChange as (e: unknown) => void)({ target: { value: "4" } });

    tree = island.tree();
    const confirmBtn2 = find(findAll(tree, isType("button")), (b) => propsOf(b)["data-role"] === "confirm");
    expect(propsOf(confirmBtn2).disabled).toBe(false);
    (propsOf(confirmBtn2).onClick as () => void)();
    expect(submitted).toEqual({ runs: { bat: 4 } });
  });

  it("clamps an out-of-range number to the field's own max — never accepts it verbatim", () => {
    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const numberInput = find(island.tree(), isType("input"));
    (propsOf(numberInput).onChange as (e: unknown) => void)({ target: { value: "999" } });
    const updatedInput = find(island.tree(), isType("input"));
    expect(propsOf(updatedInput).value).toBe(6); // field.max, never 999
  });

  it("clamps a below-range number up to the field's own min", () => {
    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const numberInput = find(island.tree(), isType("input"));
    (propsOf(numberInput).onChange as (e: unknown) => void)({ target: { value: "-5" } });
    const updatedInput = find(island.tree(), isType("input"));
    expect(propsOf(updatedInput).value).toBe(0); // field.min
  });

  it("cancel collapses the form and forgets the entered value", () => {
    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const numberInput = find(island.tree(), isType("input"));
    (propsOf(numberInput).onChange as (e: unknown) => void)({ target: { value: "3" } });

    let tree = island.tree();
    const cancelBtn = find(findAll(tree, isType("button")), (b) => propsOf(b)["data-role"] === "cancel");
    (propsOf(cancelBtn).onClick as () => void)();

    tree = island.tree();
    expect(findAll(tree, isType("input")).length).toBe(0); // collapsed back to a single tile
    // Re-expand — the value must NOT have survived.
    (propsOf(find(tree, isType("button"))).onClick as () => void)();
    const reopened = find(island.tree(), isType("input"));
    expect(propsOf(reopened).value).toBe("");
  });
});

describe("ActionForm — enum field renders its values, number bounds come from the SPEC (never hardcoded)", () => {
  it("an enum field offers exactly its declared values as options", () => {
    const action: PadActionView = {
      type: "cricket.ball",
      labelKey: { key: "pad.cricket.action.wicket", label: "Wicket" },
      fields: [{ kind: "enum", path: "wicket.kind", values: ["bowled", "caught", "lbw"] }],
      attribution: [],
      availability: AVAILABLE,
    };
    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const select = find(island.tree(), isType("select"));
    const options = findAll(walk(propsOf(select).children as never), isType("option")).filter(
      (o) => propsOf(o).value !== "",
    );
    expect(options.map((o) => propsOf(o).value)).toEqual(["bowled", "caught", "lbw"]);
  });

  it("a cfg whose bounds differ from the default renders THAT bound, not a hardcoded one", () => {
    const narrow: PadActionView = {
      type: "cricket.ball",
      labelKey: { key: "pad.cricket.action.ball", label: "Ball" },
      fields: [{ kind: "number", path: "over", min: 0, max: 19 }], // 20-over format
      attribution: [],
      availability: AVAILABLE,
    };
    const wide: PadActionView = { ...narrow, fields: [{ kind: "number", path: "over", min: 0, max: 49 }] }; // 50-over
    for (const [action, expectedMax] of [
      [narrow, 19],
      [wide, 49],
    ] as const) {
      const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
      (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
      const input = find(island.tree(), isType("input"));
      expect(propsOf(input).max).toBe(expectedMax);
    }
  });
});

describe("ActionForm — attribution seam (the picker itself is a later pass)", () => {
  it("attribution requirements pass through untouched to renderAttribution once expanded", () => {
    const action: PadActionView = {
      type: "cricket.review",
      labelKey: { key: "pad.cricket.action.review", label: "Review" },
      fields: [{ kind: "enum", path: "kind", values: ["player", "umpire"] }],
      attribution: [{ kind: "side", path: "by" }],
      availability: AVAILABLE,
    };
    let renderedAttribution: unknown = null;
    const island = renderIsland(ActionForm, {
      action,
      onSubmit: () => {},
      renderAttribution: (a: PadActionView) => {
        renderedAttribution = a.attribution;
        return null;
      },
    });
    expect(renderedAttribution, "must not fire before the form is expanded").toBeNull();
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    expect(renderedAttribution).toEqual([{ kind: "side", path: "by" }]);
  });
});

describe("Panel — layout-driven container; locked actions render a reason, never a working form", () => {
  it("a locked action renders its reason text and no interactive submit control", () => {
    const panelView = {
      labelKey: { key: "pad.cricket.panel.post", label: "Scorecard" },
      phase: "post" as const,
      layout: "primary" as const,
      actions: [
        {
          type: "cricket.player.line",
          labelKey: { key: "pad.cricket.action.playerLine", label: "Scorecard line" },
          fields: [],
          attribution: [],
          availability: { kind: "locked" as const, reason: { key: "scorepad.locked.reason", label: "Upgrade your plan to unlock this action." } },
        },
      ],
    };
    const island = renderIsland(Panel, { panel: panelView, onSubmit: () => {} });
    const tree = island.tree();
    // The locked tile is a PLAIN function call (see panel.tsx's own header),
    // so unlike a nested ActionForm its markup IS flat in Panel's own output
    // — no separate component boundary for `text()`/`walk()` to miss.
    expect(island.text()).toContain("Upgrade your plan to unlock this action.");
    // No interactive button anywhere — a locked action is a static div, not
    // a disabled button standing in for one.
    expect(findAll(tree, isType("button")).length).toBe(0);
  });

  it("an available action gets a real ActionForm child, wired to Panel's own onSubmit(type, payload)", () => {
    const panelView = {
      labelKey: { key: "pad.cricket.panel.over", label: "Over" },
      phase: "live" as const,
      layout: "primary" as const,
      actions: [
        {
          type: "cricket.newball",
          labelKey: { key: "pad.cricket.action.newBall", label: "New ball" },
          fields: [],
          attribution: [],
          availability: AVAILABLE,
        },
      ],
    };
    let submitted: { type: string; payload: unknown } | null = null;
    const island = renderIsland(Panel, {
      panel: panelView,
      onSubmit: (type: string, payload: unknown) => (submitted = { type, payload }),
    });
    // ActionForm owns real per-instance hook state (expanded/values), which
    // this hand-rolled harness cannot invoke a SECOND nested component's
    // hooks through (see panel.tsx's header) — so this asserts on the
    // <ActionForm> ELEMENT's own props, the "children are elements, not
    // markup" pattern, rather than clicking through its rendered interior
    // (already fully covered by the ActionForm describe blocks above).
    const actionFormEl = find(island.tree(), isType(ActionForm));
    expect(propsOf(actionFormEl).action).toEqual(panelView.actions[0]);
    (propsOf(actionFormEl).onSubmit as (p: unknown) => void)({ foo: "bar" });
    expect(submitted).toEqual({ type: "cricket.newball", payload: { foo: "bar" } });
  });
});
