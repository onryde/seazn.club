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
import { defaultLineupPair } from "@seazn/engine/testkit";
import { cricket } from "@seazn/engine/sports/cricket";
import type { AnySportModule } from "@seazn/engine/sport";
import { resolveModuleClient } from "../module-client";
import type { AppendCallResult, AppendEventBody } from "../pipeline";
import type { FixtureStateResult, PadTransport } from "../transport";
import type { LedgerSlotEvent, OwnIdentity } from "../types";
import type { PadActionView, PadPanelView } from "../view-model";
import { ActionForm } from "../action-form";
import { Panel } from "../panel";
import { FidelitySwitcher } from "../fidelity-switcher";
import { AttributionPicker } from "@/components/v2/scorepad/attribution-picker";
import { Timeline, type TimelineEvent } from "../timeline";
import { PadRenderer } from "../pad-renderer";
import { skinFor } from "../skins/registry";

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

/** The visible caption span action-form.tsx's `renderField` renders for
 *  EVERY field kind (enum/number/toggle) once expanded — `className="label"`
 *  (plus toggle's own `!mb-0` modifier). Finding it by class rather than by
 *  `textOf(the whole <label>)` matters for the enum case specifically: the
 *  enclosing `<label>` also wraps a `<select>` whose own `<option>` text
 *  would otherwise pollute a whole-subtree text read. */
function captionText(tree: ReactElement[]): string {
  return textOf(
    find(
      tree,
      (el) => isType("span")(el) && typeof propsOf(el).className === "string" && (propsOf(el).className as string).includes("label"),
    ),
  );
}

describe("ActionForm — field captions (S10/#419 W8 fix 1): every field renders a REAL visible label", () => {
  it("a field WITH a labelKey renders the dictionary copy, not a derived one", () => {
    const action: PadActionView = {
      type: "cricket.ball",
      labelKey: { key: "pad.cricket.action.ball", label: "Ball" },
      fields: [
        { kind: "number", path: "runs.bat", min: 0, max: 6, labelKey: { key: "pad.x", label: "Runs off the bat" } },
      ],
      attribution: [],
      availability: AVAILABLE,
    };
    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const tree = island.tree();
    expect(captionText(tree)).toBe("Runs off the bat");
    const input = find(tree, isType("input"));
    const accessibleName = (propsOf(input)["aria-label"] as string | undefined) ?? captionText(tree);
    expect(accessibleName).toBe("Runs off the bat");
  });

  it("a NUMBER field with NO labelKey renders a label DERIVED from its path — visible, tied to the control", () => {
    const action: PadActionView = {
      type: "cricket.player.line",
      labelKey: { key: "pad.cricket.action.playerLine", label: "Scorecard line" },
      fields: [{ kind: "number", path: "bowling.legalBalls", min: 0, max: 300 }],
      attribution: [],
      availability: AVAILABLE,
    };
    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const tree = island.tree();
    expect(captionText(tree)).toBe("Bowling legal balls");
    const input = find(tree, isType("input"));
    // The accessible name (an explicit aria-label if present, else the
    // enclosing <label>'s own text) must be the SAME text a sighted scorer
    // reads — never a second, different string.
    const accessibleName = (propsOf(input)["aria-label"] as string | undefined) ?? captionText(tree);
    expect(accessibleName).toBe("Bowling legal balls");
  });

  it("a TOGGLE field with NO labelKey renders a label DERIVED from its path", () => {
    const action: PadActionView = {
      type: "cricket.player.line",
      labelKey: { key: "pad.cricket.action.playerLine", label: "Scorecard line" },
      fields: [{ kind: "toggle", path: "batting.out" }],
      attribution: [],
      availability: AVAILABLE,
    };
    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const tree = island.tree();
    expect(captionText(tree)).toBe("Batting out");
  });

  it("an ENUM field with NO labelKey renders a label DERIVED from its path (not polluted by its own options)", () => {
    const action: PadActionView = {
      type: "cricket.ball",
      labelKey: { key: "pad.cricket.action.wicket", label: "Wicket" },
      fields: [{ kind: "enum", path: "wicket.kind", values: ["bowled", "caught", "lbw"] }],
      attribution: [],
      availability: AVAILABLE,
    };
    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const tree = island.tree();
    expect(captionText(tree)).toBe("Wicket kind");
  });
});

describe("ActionForm — cricket.player.line: the reported defect (seven fields all named 'Scorecard line #n')", () => {
  it("no control is named with a bare ordinal any more; all seven get their own distinct visible caption", () => {
    const cricketCfg = cricket.configSchema.parse({});
    const spec = cricket.padSpec!(cricketCfg);
    const rawAction = spec.panels.flatMap((p) => p.actions).find((a) => a.type === "cricket.player.line");
    expect(rawAction, "cricket.player.line must exist in the default cfg's spec").toBeDefined();
    const action: PadActionView = { ...rawAction!, availability: AVAILABLE };
    expect(action.fields.length, "pins the reported shape — 7 unlabelled fields").toBe(7);
    expect(action.fields.every((f) => f.labelKey === undefined)).toBe(true);

    const island = renderIsland(ActionForm, { action, onSubmit: () => {} });
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    const tree = island.tree();

    const controls = findAll(tree, (el) => isType("input")(el) || isType("select")(el));
    expect(controls.length).toBe(7);
    const ariaLabels = controls.map((c) => propsOf(c)["aria-label"]).filter((v): v is string => typeof v === "string");
    expect(ariaLabels.join(" | "), "no control should still need a raw-ordinal aria-label").not.toMatch(/#\d/);

    const captionSpans = findAll(
      tree,
      (el) => isType("span")(el) && typeof propsOf(el).className === "string" && (propsOf(el).className as string).includes("label"),
    );
    const captions = captionSpans.map((s) => textOf(s));
    expect(captions.length, "every one of the 7 fields must render its OWN visible caption").toBe(7);
    expect(new Set(captions).size, "captions must be genuinely distinct, not one name repeated").toBe(7);
    expect(captions).toContain("Innings");
    expect(captions).toContain("Bowling wickets");
    expect(captions).toContain("Batting out");
  });
});

describe("Panel — layout-driven container; locked actions render a reason, never a working form", () => {
  it("a locked action renders its reason text and no interactive submit control", () => {
    const panelView: PadPanelView = {
      labelKey: { key: "pad.cricket.panel.post", label: "Scorecard" },
      phase: "post",
      layout: "primary",
      actions: [
        {
          type: "cricket.player.line",
          labelKey: { key: "pad.cricket.action.playerLine", label: "Scorecard line" },
          fields: [],
          attribution: [],
          availability: { kind: "locked", reason: { key: "scorepad.locked.reason", label: "Upgrade your plan to unlock this action." } },
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

describe("Panel — single-action grid panel fills its row at md+ (S10/#419 W8 fix 2)", () => {
  // Mirrors football's real Cards/Substitutions/Shots panels: `layout:
  // "grid"` with exactly one action — the reported defect (a half-width
  // button, empty sibling cell, at 768/1280).
  function gridPanel(actionCount: 1 | 2): PadPanelView {
    const actions: PadActionView[] = Array.from({ length: actionCount }, (_, i) => ({
      type: `football.card.${i}`,
      labelKey: { key: "pad.football.action.card", label: `Card ${i}` },
      fields: [],
      attribution: [],
      availability: AVAILABLE,
    }));
    return { labelKey: { key: "pad.football.panel.cards", label: "Cards" }, phase: "live", layout: "grid", actions };
  }

  function actionsContainer(tree: ReactElement[]): ReactElement {
    return find(tree, (el) => propsOf(el)["data-role"] === "panel-actions");
  }

  it("a single-action grid panel adds md:grid-cols-1 — fills its row at tablet/desktop", () => {
    const island = renderIsland(Panel, { panel: gridPanel(1), onSubmit: () => {} });
    const className = propsOf(actionsContainer(island.tree())).className as string;
    // Unchanged below md (768px) — 375/320 already read correctly as a
    // dense 2-up tap grid (task ruling: do not regress the primary surface
    // to fix desktop).
    expect(className).toContain("grid-cols-2");
    // The fix: at md+ the lone action collapses to ONE column, so it fills
    // the row instead of sitting in column 1 with an empty sibling cell.
    expect(className).toContain("md:grid-cols-1");
  });

  it("a MULTI-action grid panel is untouched — a real sibling already fills the second column", () => {
    const island = renderIsland(Panel, { panel: gridPanel(2), onSubmit: () => {} });
    const className = propsOf(actionsContainer(island.tree())).className as string;
    expect(className).toContain("grid-cols-2");
    expect(className).not.toContain("md:grid-cols-1");
  });

  it("a single-action PRIMARY (non-grid) panel is untouched — the fix is grid-specific", () => {
    const panel: PadPanelView = { ...gridPanel(1), layout: "primary" };
    const island = renderIsland(Panel, { panel, onSubmit: () => {} });
    const className = propsOf(actionsContainer(island.tree())).className as string;
    expect(className).toBe("flex flex-col gap-2");
  });
});

// ---------------------------------------------------------------------------
// PadRenderer — the composed surface. Only ONE level of the tree is invoked
// by `renderIsland` (PadRenderer itself); `Panel` and `FidelitySwitcher` are
// REAL nested components with their own hook state, so — exactly like
// Panel's own tests above — this section asserts on THEIR ELEMENTS' props
// and calls their callback props directly (`onSubmit`, `onChange`) rather
// than clicking two component-boundaries deep, which this harness cannot
// reach. Each nested component's OWN click-through behaviour is already
// fully covered by its own describe blocks (ActionForm above,
// fidelity-switcher.test.tsx). What THIS section proves is PadRenderer's
// OWN wiring: phase state -> the right panels; band state -> the right
// view-model call; a Panel's onSubmit -> the real usePadPipeline.
// ---------------------------------------------------------------------------

const ME: OwnIdentity = { recordedBy: "user-1", deviceLinkId: null };

function fakeTransport(opts: {
  appendResults: AppendCallResult[];
  fetchStateImpl?: (fixtureId: string) => Promise<FixtureStateResult>;
}): PadTransport {
  let cursor = 0;
  return {
    async appendEvent() {
      const next = opts.appendResults[cursor];
      cursor += 1;
      if (!next) throw new Error("fakeTransport: no scripted appendEvent response left");
      return next;
    },
    async listEventsSince(): Promise<LedgerSlotEvent[]> {
      return [];
    },
    async getLastSeq(): Promise<number> {
      throw new Error("fakeTransport: getLastSeq not used by this suite");
    },
    async fetchState(fixtureId: string): Promise<FixtureStateResult> {
      if (opts.fetchStateImpl) return opts.fetchStateImpl(fixtureId);
      return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
    },
  };
}

const success = (seq: number): AppendCallResult => ({
  kind: "ok",
  data: { seq, state_summary: { seq }, outcome: null, status: "in_play" },
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function panelByKey(tree: ReactElement[], key: string): ReactElement {
  return find(findAll(tree, isType(Panel)), (el) => (propsOf(el).panel as PadPanelView).labelKey.key === key);
}

const CRICKET_CFG = cricket.configSchema.parse({});
const CRICKET_LINEUPS = defaultLineupPair(cricket.positions);

describe("PadRenderer — phase navigation", () => {
  // `skin: null` forces the UNIVERSAL path. Cricket is the only module that
  // declares all three phases, and since S11/#420 it is also skinned — so
  // without the opt-out these tests would assert panel structure against a
  // hand-crafted layout that deliberately does not draw Panels. The skin's own
  // routing is asserted separately below.
  function mountCricket() {
    return renderIsland(PadRenderer, {
      module: resolveModuleClient("cricket", "1.0.0"),
      cfg: CRICKET_CFG,
      fixtureId: "fx-1",
      lineups: CRICKET_LINEUPS,
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 3 as const,
      entitlements: { "stats.player": true, "scoring.ball_by_ball": true },
      skin: null,
    });
  }

  it("renders a tab for every phase the spec declares (cricket: pre, live, post)", () => {
    const island = mountCricket();
    const tabs = findAll(island.tree(), isType("button")).filter((b) => propsOf(b)["data-phase"] !== undefined);
    expect(tabs.map((t) => propsOf(t)["data-phase"]).sort()).toEqual(["live", "post", "pre"]);
  });

  it("defaults to the live phase — the Over panel is present, the pre-match Toss panel is not", () => {
    const island = mountCricket();
    const tree = island.tree();
    expect(() => panelByKey(tree, "pad.cricket.panel.over")).not.toThrow();
    expect(findAll(tree, isType(Panel)).some((p) => (propsOf(p).panel as PadPanelView).labelKey.key === "pad.cricket.panel.pre")).toBe(
      false,
    );
  });

  it("clicking the pre-match tab swaps the visible panels to that phase's", () => {
    const island = mountCricket();
    const preTab = find(findAll(island.tree(), isType("button")), (b) => propsOf(b)["data-phase"] === "pre");
    (propsOf(preTab).onClick as () => void)();
    const tree = island.tree();
    expect(() => panelByKey(tree, "pad.cricket.panel.pre")).not.toThrow();
    expect(findAll(tree, isType(Panel)).some((p) => (propsOf(p).panel as PadPanelView).labelKey.key === "pad.cricket.panel.over")).toBe(
      false,
    );
  });

  it("a phase with nothing visible at this band renders the empty-phase message, not a blank screen", () => {
    // Post-phase's only action (cricket.player.line) is banded 2 — at band 0
    // it is filtered out, so the whole panel (and phase) is empty.
    const island = renderIsland(PadRenderer, {
      module: resolveModuleClient("cricket", "1.0.0"),
      cfg: CRICKET_CFG,
      fixtureId: "fx-1",
      lineups: CRICKET_LINEUPS,
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 0 as const,
      entitlements: {},
    });
    const postTab = find(findAll(island.tree(), isType("button")), (b) => propsOf(b)["data-phase"] === "post");
    (propsOf(postTab).onClick as () => void)();
    const tree = island.tree();
    expect(findAll(tree, isType(Panel)).length).toBe(0);
    expect(island.text().length).toBeGreaterThan(0); // some message, not a blank screen
  });
});

describe("PadRenderer — a Panel's onSubmit reaches the REAL usePadPipeline", () => {
  it("calling the Score panel's onSubmit drains through the transport and the queue empties", async () => {
    const generic = resolveModuleClient("generic", "1.0.0");
    const cfg = { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
    const lineups = defaultLineupPair(generic.positions);
    const transport = fakeTransport({ appendResults: [success(2)] });
    const island = renderIsland(PadRenderer, {
      module: generic,
      cfg,
      fixtureId: "fx-1",
      lineups,
      identity: ME,
      transport,
      band: 3 as const,
      entitlements: {},
      initialEvents: [
        {
          id: "e-1",
          fixtureId: "fx-1",
          seq: 1,
          type: "core.start",
          payload: {},
          recordedAt: "2026-08-12T00:00:00.000Z",
          recordedBy: "user-1",
        },
      ],
    });
    await tick(); // let the mount-time resume/drain effect settle first

    const scorePanel = panelByKey(island.tree(), "pad.generic.panel.score");
    await (propsOf(scorePanel).onSubmit as (t: string, p: unknown) => Promise<void>)("generic.result", {
      p1Score: 5,
      p2Score: 3,
    });
    await tick();
    await tick();

    // Reached the transport with the real submitted payload — not merely
    // "queued": the queue/offline strip reads synced once the drain settles.
    expect(island.text()).toContain("All synced");
  });
});

describe("PadRenderer — fidelity band integration: reveals actions, never resets state", () => {
  it("upgrading the band reveals a higher-band action in the SAME panel, and the fold is untouched", async () => {
    const seenStates: unknown[] = [];
    const island = renderIsland(PadRenderer, {
      module: resolveModuleClient("cricket", "1.0.0"),
      cfg: CRICKET_CFG,
      fixtureId: "fx-1",
      lineups: CRICKET_LINEUPS,
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 1 as const,
      entitlements: { "stats.player": true, "scoring.ball_by_ball": true },
      onStateChange: (state) => seenStates.push(state),
      skin: null, // universal path — see the note on mountCricket above
    });
    await tick();

    // At band 1 the "Over" panel's only action (cricket.ball) is band 3 —
    // ABSENT means the whole panel is dropped (nothing left to draw), not
    // merely that ONE action is missing from an otherwise-present panel.
    const overPanelsBefore = findAll(island.tree(), isType(Panel)).filter(
      (p) => (propsOf(p).panel as PadPanelView).labelKey.key === "pad.cricket.panel.over",
    );
    expect(overPanelsBefore.length).toBe(0);
    expect(seenStates.length).toBeGreaterThan(0);
    const stateBeforeUpgrade = seenStates[seenStates.length - 1];

    const switcherEl = find(island.tree(), isType(FidelitySwitcher));
    (propsOf(switcherEl).onChange as (band: number) => void)(3);

    const overPanelAfter = panelByKey(island.tree(), "pad.cricket.panel.over");
    expect((propsOf(overPanelAfter).panel as PadPanelView).actions.some((a) => a.type === "cricket.ball")).toBe(true);
    // The fold itself never moved — same value (in this harness, the same
    // object reference: usePadPipeline's `foldedState` memo does not depend
    // on `band` at all) before and after the upgrade.
    expect(seenStates[seenStates.length - 1]).toBe(stateBeforeUpgrade);
  });
});

describe("PadRenderer — Timeline is the DEFAULT (S12/#421), not an opt-in", () => {
  // The regression this pins: `timeline.tsx` was imported by NOTHING outside
  // its own test and could not be wired by any caller even in principle —
  // `timelineSlot` was a bare ReactNode while Timeline needs `onVoid` ->
  // `submit`, and `UsePadPipelineResult` exposed neither `submit` upward nor
  // its event list. Sixth instance of this programme's signature defect
  // (_INDEX.md, S12/#421): a seam nothing can reach is not "left for later",
  // it is unreachable. Fixed on the SAME pattern `renderAttribution` already
  // used — see that describe block above.
  const GENERIC_CFG = { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };

  function mountWithHistory(transport: PadTransport, identity: OwnIdentity = ME) {
    const generic = resolveModuleClient("generic", "1.0.0");
    return renderIsland(PadRenderer, {
      module: generic,
      cfg: GENERIC_CFG,
      fixtureId: "fx-1",
      lineups: defaultLineupPair(generic.positions),
      identity,
      transport,
      band: 3 as const,
      entitlements: {},
      initialEvents: [
        {
          id: "e-1",
          fixtureId: "fx-1",
          seq: 1,
          type: "core.start",
          payload: {},
          recordedAt: "2026-08-13T00:00:00.000Z",
          recordedBy: "user-1",
        },
      ],
    });
  }

  it("renders Timeline from the pipeline's own events when no timelineSlot override is passed", async () => {
    const island = mountWithHistory(fakeTransport({ appendResults: [] }));
    await tick(); // let the mount-time resume/drain effect settle first
    const timelineEl = find(island.tree(), isType(Timeline));
    const events = propsOf(timelineEl).events as TimelineEvent[];
    expect(events.some((e) => e.id === "e-1" && e.type === "core.start")).toBe(true);
  });

  it("Timeline's onVoid fires submit(\"core.void\", {event_id}) through the REAL pipeline, not a stub", async () => {
    const appendCalls: { fixtureId: string; body: AppendEventBody }[] = [];
    const transport: PadTransport = {
      async appendEvent(fixtureId, body) {
        appendCalls.push({ fixtureId, body });
        return { kind: "ok", data: { seq: appendCalls.length + 1, state_summary: null, outcome: null, status: "in_play" } };
      },
      async listEventsSince(): Promise<LedgerSlotEvent[]> {
        return [];
      },
      async getLastSeq(): Promise<number> {
        throw new Error("fakeTransport: getLastSeq not used by this suite");
      },
      async fetchState(): Promise<FixtureStateResult> {
        return { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null };
      },
    };
    const island = mountWithHistory(transport);
    await tick();
    const timelineEl = find(island.tree(), isType(Timeline));
    const onVoid = propsOf(timelineEl).onVoid as (eventId: string) => void;
    expect(typeof onVoid).toBe("function");
    onVoid("e-1");
    await tick();
    await tick();
    const voidCall = appendCalls.find((c) => c.body.type === "core.void");
    expect(voidCall, "onVoid must reach the transport as a real core.void append").toBeTruthy();
    // pipeline.ts's own core.void translation: the wire payload carries the
    // voided event's id (server/usecases/scoring.ts extracts it into the
    // persisted envelope's `voids` field) — see use-pad-pipeline.ts's
    // toEnvelopeFields for the client-side mirror of that same rule.
    expect(voidCall!.body.payload).toEqual({ event_id: "e-1" });
  });

  it("feeds Timeline the REAL identity's deviceLinkId, never a hardcoded permissive default", async () => {
    const deviceIdentity: OwnIdentity = { recordedBy: "user-1", deviceLinkId: "dev-xyz" };
    const island = mountWithHistory(fakeTransport({ appendResults: [] }), deviceIdentity);
    await tick();
    const timelineEl = find(island.tree(), isType(Timeline));
    expect(propsOf(timelineEl).deviceLinkId).toBe("dev-xyz");
  });

  it("an explicit timelineSlot override still wins, receiving the resolved events and a wired onVoid", async () => {
    const marker = "TIMELINE-SLOT-OVERRIDE-MARKER";
    let receivedEvents: TimelineEvent[] | null = null;
    let receivedOnVoid: unknown = null;
    const generic = resolveModuleClient("generic", "1.0.0");
    const island = renderIsland(PadRenderer, {
      module: generic,
      cfg: GENERIC_CFG,
      fixtureId: "fx-1",
      lineups: defaultLineupPair(generic.positions),
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 3 as const,
      entitlements: {},
      initialEvents: [
        {
          id: "e-1",
          fixtureId: "fx-1",
          seq: 1,
          type: "core.start",
          payload: {},
          recordedAt: "2026-08-13T00:00:00.000Z",
          recordedBy: "user-1",
        },
      ],
      timelineSlot: (events: readonly TimelineEvent[], onVoid: (eventId: string) => void) => {
        receivedEvents = [...events];
        receivedOnVoid = onVoid;
        return marker;
      },
    });
    await tick();
    expect(island.text()).toContain(marker);
    // Never drawn when an override is supplied — same "one or the other"
    // contract the skin routing describe block pins below.
    expect(findAll(island.tree(), isType(Timeline)).length).toBe(0);
    expect(receivedEvents, "the override must receive the SAME resolved events the default draws").not.toBeNull();
    expect(receivedEvents!.some((e) => e.id === "e-1")).toBe(true);
    expect(typeof receivedOnVoid).toBe("function");
  });

  // S12/#421 pass G (_INDEX.md decision log, "the pad's own undo silently
  // does nothing for an event you just scored"). Every OTHER void test in
  // this block targets "e-1" from initialEvents — a server-known id that
  // never exposed the bug. This one scores through a REAL rendered action
  // tile first, so the row Timeline exposes carries the client-fabricated id
  // pendingToEnvelope stamps (use-pad-pipeline.ts), exactly like a scorer
  // tapping Undo on the goal they just entered — no reload, no poll tick in
  // between.
  it("a PAD-SUBMITTED event's own Undo control voids it with no reload and no intervening poll", async () => {
    const REAL_SERVER_ID = "server-real-score-row-id";
    const appendCalls: { fixtureId: string; body: AppendEventBody }[] = [];
    const transport: PadTransport = {
      async appendEvent(fixtureId, body) {
        appendCalls.push({ fixtureId, body });
        return { kind: "ok", data: { seq: appendCalls.length + 1, state_summary: null, outcome: null, status: "in_play" } };
      },
      async listEventsSince(): Promise<LedgerSlotEvent[]> {
        // The only row the resolution step ever asks about: the pad-
        // submitted score, at seq 2 (seq 1 is mountWithHistory's core.start).
        return [
          {
            id: REAL_SERVER_ID,
            seq: 2,
            type: "generic.score",
            payload: { points: 3 },
            recorded_at: "2026-08-13T00:00:01.000Z",
            recorded_by: "user-1",
            device_link_id: null,
          },
        ];
      },
      async getLastSeq(): Promise<number> {
        throw new Error("fakeTransport: getLastSeq not used by this suite");
      },
      async fetchState(): Promise<FixtureStateResult> {
        return { status: "in_play", last_seq: 2, state: null, summary: null, outcome: null };
      },
    };
    const island = mountWithHistory(transport);
    await tick();

    // Score through the REAL rendered Tally panel's own onSubmit prop —
    // this file's established boundary for a stateful nested child
    // (panel.tsx's own header: "children are elements, not markup" — the
    // SAME pattern the fidelity-switcher tests above use via panelByKey,
    // and Timeline's onVoid prop is exercised the identical way below).
    // ActionForm's OWN expand/validate/confirm interaction is that file's
    // separately-owned test surface, not this one's.
    const tallyPanel = panelByKey(island.tree(), "pad.generic.panel.tally");
    const submitAction = propsOf(tallyPanel).onSubmit as (type: string, payload: Record<string, unknown>) => void;
    submitAction("generic.score", { points: 3 });
    await tick();
    await tick();
    expect(appendCalls.some((c) => c.body.type === "generic.score")).toBe(true);

    // The row the pad itself just submitted — read off the REAL rendered
    // Timeline, exactly as a scorer would see it, not off the pipeline
    // directly.
    const timelineEl = find(island.tree(), isType(Timeline));
    const scoreRow = (propsOf(timelineEl).events as TimelineEvent[]).find((e) => e.type === "generic.score")!;
    const onVoid = propsOf(timelineEl).onVoid as (eventId: string) => Promise<void> | void;
    await onVoid(scoreRow.id);

    const voidCall = appendCalls.find((c) => c.body.type === "core.void");
    expect(voidCall, "the undo must reach the transport, not vanish silently").toBeTruthy();
    // THE regression: the wire payload must carry the server's real row id,
    // never the client-fabricated one Timeline happened to expose.
    expect(voidCall!.body.payload).toEqual({ event_id: REAL_SERVER_ID });
    expect(voidCall!.body.payload).not.toEqual({ event_id: scoreRow.id });
  });
});

describe("PadRenderer — score header (S10/#419 W8 fix 3)", () => {
  it("renders the fold's own headline and updates it as the fold advances", async () => {
    const generic = resolveModuleClient("generic", "1.0.0");
    const cfg = { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
    const lineups = defaultLineupPair(generic.positions);
    const transport = fakeTransport({ appendResults: [success(2)] });
    const island = renderIsland(PadRenderer, {
      module: generic,
      cfg,
      fixtureId: "fx-1",
      lineups,
      identity: ME,
      transport,
      band: 3 as const,
      entitlements: {},
      initialEvents: [
        {
          id: "e-1",
          fixtureId: "fx-1",
          seq: 1,
          type: "core.start",
          payload: {},
          recordedAt: "2026-08-12T00:00:00.000Z",
          recordedBy: "user-1",
        },
      ],
    });
    await tick(); // let the mount-time resume/drain effect settle first

    const findHeadline = () => find(island.tree(), (el) => propsOf(el)["data-role"] === "score-headline");
    const headlineBefore = textOf(findHeadline());
    expect(headlineBefore.length).toBeGreaterThan(0); // generic's summary() always sets one, even pre-result ("—")

    const scorePanel = panelByKey(island.tree(), "pad.generic.panel.score");
    await (propsOf(scorePanel).onSubmit as (t: string, p: unknown) => Promise<void>)("generic.result", {
      p1Score: 5,
      p2Score: 3,
    });
    await tick();
    await tick();

    const headlineAfter = textOf(findHeadline());
    expect(headlineAfter, "the header must reflect the NEW fold, not the stale one").not.toBe(headlineBefore);
    expect(headlineAfter).toContain("5");
    expect(headlineAfter).toContain("3");
  });

  it("renders nothing — no empty shell — when the module's own summary carries no usable headline", () => {
    const generic = resolveModuleClient("generic", "1.0.0");
    // A deliberately non-conforming test double: the REAL fold/init/padSpec
    // (so the rest of the pad renders normally), but a summary() that omits
    // `headline` — the shape `summaryHeadline` (view-model.ts) exists to
    // degrade gracefully against, since `pipeline.summary` reaches this
    // component typed `unknown`.
    const headlineless = { ...generic, summary: () => ({ perSide: [] }) } as unknown as AnySportModule;
    const lineups = defaultLineupPair(generic.positions);
    const island = renderIsland(PadRenderer, {
      module: headlineless,
      cfg: { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      fixtureId: "fx-1",
      lineups,
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 3 as const,
      entitlements: {},
    });
    const tree = island.tree();
    expect(findAll(tree, (el) => propsOf(el)["data-role"] === "score-headline").length).toBe(0);
    // Not merely absent — the rest of the header (phase nav, queue status)
    // must still render normally; this is a targeted degrade, not a crash.
    expect(island.text().length).toBeGreaterThan(0);
  });
});

describe("PadRenderer — the attribution picker is the DEFAULT, not an opt-in", () => {
  // The regression this pins: the picker shipped written, tested and wired to
  // NOTHING — reachable only if a caller remembered to pass
  // `renderAttribution`. That is this programme's recurring defect class (a
  // person-role discriminator tested engine-side but unreachable from real
  // code; stat models declared but inert; rows computed but unrenderable).
  //
  // Asserted on what PadRenderer HANDS DOWN, because the node-only harness
  // renders one component one level deep: `Panel` is an element here, not a
  // rendered subtree, so the picker cannot be found by walking. Calling the
  // forwarded function is the real contract anyway — it is exactly what
  // `ActionForm` does with it.
  const attributedAction = {
    type: "cricket.toss",
    labelKey: { key: "pad.cricket.action.toss", label: "Toss" },
    fields: [],
    attribution: [{ kind: "side", path: "wonBy" }],
  } as unknown as PadActionView;

  function forwardedRenderer(extra: Record<string, unknown>) {
    // `generic` with a started match: its Score panel is ungated, so a Panel
    // is guaranteed to render here. WHICH module draws is irrelevant — the
    // contract under test is what PadRenderer forwards to every Panel.
    const generic = resolveModuleClient("generic", "1.0.0");
    const cfg = {
      resultMode: "score" as const,
      allowDraws: false,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    };
    const island = renderIsland(PadRenderer, {
      module: generic,
      cfg,
      fixtureId: "fx-attr",
      lineups: defaultLineupPair(generic.positions),
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 3 as const,
      entitlements: {},
      initialEvents: [
        {
          id: "e-1",
          fixtureId: "fx-attr",
          seq: 1,
          type: "core.start",
          payload: {},
          recordedAt: "2026-08-12T00:00:00.000Z",
          recordedBy: "user-1",
        },
      ],
      ...extra,
    });
    const panels = findAll(island.tree(), isType(Panel));
    expect(panels.length).toBeGreaterThan(0);
    return propsOf(panels[0]!).renderAttribution as
      | ((a: PadActionView, v: Record<string, unknown>, set: () => void) => ReactElement | null)
      | undefined;
  }

  it("forwards a picker to every Panel when the caller passes no renderAttribution", () => {
    const forwarded = forwardedRenderer({});
    expect(typeof forwarded).toBe("function");
    const drawn = forwarded!(attributedAction, {}, () => undefined);
    expect(drawn?.type).toBe(AttributionPicker);
  });

  it("an explicit renderAttribution still WINS — S11's skins may draw their own", () => {
    const marker = { type: "custom" } as unknown as ReactElement;
    const forwarded = forwardedRenderer({ renderAttribution: () => marker });
    expect(forwarded!(attributedAction, {}, () => undefined)).toBe(marker);
  });
});

describe("PadRenderer — skin routing (S11/#420 W9)", () => {
  // The reachability proof. S10's attribution picker shipped written, tested
  // and reachable ONLY IF a caller remembered to pass it, and no unit test
  // could see it — "fifth instance of this programme's signature defect".
  // A skin registry that PadRenderer never consults would be the sixth. These
  // two tests fail the moment the consult is removed.
  it("routes a skinned sport to its skin by DEFAULT — no prop passed", () => {
    const skin = skinFor("cricket");
    expect(skin).not.toBeNull();
    const island = renderIsland(PadRenderer, {
      module: resolveModuleClient("cricket", "1.0.0"),
      cfg: CRICKET_CFG,
      fixtureId: "fx-1",
      lineups: CRICKET_LINEUPS,
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 3 as const,
      entitlements: { "stats.player": true, "scoring.ball_by_ball": true },
    });
    const tree = island.tree();
    expect(findAll(tree, isType(skin!.Component)).length).toBe(1);
    // and the universal panel walk is NOT also drawn — one or the other
    expect(findAll(tree, isType(Panel)).length).toBe(0);
  });

  it("leaves an unskinned sport on the universal panel walk", () => {
    const generic = resolveModuleClient("generic", "1.0.0");
    expect(skinFor("generic")).toBeNull();
    const island = renderIsland(PadRenderer, {
      module: generic,
      cfg: { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      fixtureId: "fx-1",
      lineups: defaultLineupPair(generic.positions),
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 3 as const,
      entitlements: {},
    });
    expect(findAll(island.tree(), isType(Panel)).length).toBeGreaterThan(0);
  });
});
