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
import { resolveModuleClient } from "../module-client";
import type { AppendCallResult, AppendEventBody, ScoringTransport } from "../pipeline";
import type { FixtureStateResult, PadTransport } from "../transport";
import type { LedgerSlotEvent, OwnIdentity } from "../types";
import type { PadActionView, PadPanelView } from "../view-model";
import { ActionForm } from "../action-form";
import { Panel } from "../panel";
import { FidelitySwitcher } from "../fidelity-switcher";
import { PadRenderer } from "../pad-renderer";

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
    async appendEvent(_fixtureId: string, _body: AppendEventBody) {
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

describe("PadRenderer — timeline seam (a later pass fills it in; this pass only reserves the slot)", () => {
  it("renders whatever timelineSlot is handed, verbatim", () => {
    const marker = "TIMELINE-SLOT-MARKER";
    const island = renderIsland(PadRenderer, {
      module: resolveModuleClient("generic", "1.0.0"),
      cfg: { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      fixtureId: "fx-1",
      lineups: defaultLineupPair(resolveModuleClient("generic", "1.0.0").positions),
      identity: ME,
      transport: fakeTransport({ appendResults: [] }),
      band: 3 as const,
      entitlements: {},
      timelineSlot: marker,
    });
    expect(island.text()).toContain(marker);
  });
});
