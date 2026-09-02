// R2/task B — the v3 chassis's generic padSpec(cfg) action form (spec item
// 4, "the More sheet"). PORTED from the legacy universal renderer's own
// action-form.tsx + cricket-skin.tsx's AdminGroup (line 831/863) — never
// IMPORTED from either: cricket-skin.tsx is v2 skin surface R8 deletes, and
// the legacy renderer is the visual/interaction layer v3 supersedes (design
// doc §1). Reuses view-model.ts's PURE decision helpers
// (checkActionValidity/buildActionPayload) verbatim — those already have
// their own coverage (view-model.test.ts/view-model-coverage.test.ts); this
// suite proves the NEW wiring on top: initial values, the fast-path vs
// expand decision, locked rendering, and ActionFormList's generic walk over
// whatever `PadActionView[]` it is handed.
//
// SPLIT: initialActionValues is a pure, exported builder proved directly.
// ActionFormList is the ONE stateful component in this file (own header:
// the node-only `_hook-harness` renders one function component ONE level
// deep, so N independently-stateful `<ActionTile/>` children per action
// would be invisible to walk()/textOf() — every action's expand/values
// state lives in ActionFormList itself instead), proved through the shared
// harness (renderIsland/walk/textOf/propsOf), same as guided-sheet.test.ts
// proves GuidedSheet.
import { describe, it, expect } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import type { LineupPair, SquadState } from "@seazn/engine/core";
import type { PadActionView } from "../../view-model";
import { ActionFormList, initialActionValues, type ActionFormListProps } from "../action-form";

// Deliberately NOT a real dictionary key — PAD_LABEL_SET (scoring-vocab.ts)
// cannot contain it, so padLabel()'s fallback branch (the action/field's own
// `engineLabel`) is what fires, deterministically, regardless of what the
// real dictionaries happen to carry.
function label(engineLabel: string) {
  return { key: `pad.__fixture__.${engineLabel}`, label: engineLabel };
}

function action(over: Partial<PadActionView> = {}): PadActionView {
  return {
    type: "cricket.toss",
    labelKey: label("Toss"),
    fields: [],
    attribution: [],
    availability: { kind: "available" },
    ...over,
  };
}

const t: ActionFormListProps["t"] = (k) => k;

// Shared squad/lineup fixture for the pre-existing tests below (none of them
// exercise attribution, so its actual content is inert for those — but
// ActionFormListProps requires it, on purpose: an optional prop here is
// exactly how S10's own attribution picker shipped reachable only if a
// caller remembered to pass it, per this programme's own repeated
// post-mortem). The attribution-specific describe block at the bottom of
// this file defines its OWN richer fixture.
const NO_SQUADS: SquadState = {
  home: { entrantId: "home-1", members: [], subsUsed: 0, exemptUsed: {} },
  away: { entrantId: "away-1", members: [], subsUsed: 0, exemptUsed: {} },
};
const NO_LINEUPS: LineupPair = {
  home: { entrantId: "home-1", slots: [] },
  away: { entrantId: "away-1", slots: [] },
};
const NO_NAMES = {};

describe("initialActionValues", () => {
  it("defaults every toggle field to false and leaves enum/number fields unset", () => {
    const values = initialActionValues({
      fields: [
        { kind: "toggle", path: "retired" },
        { kind: "enum", path: "kind", values: ["a", "b"] },
        { kind: "number", path: "overs", min: 0, max: 50 },
      ],
    });
    expect(values).toEqual({ retired: false });
  });

  it("returns an empty object for a zero-field action", () => {
    expect(initialActionValues({ fields: [] })).toEqual({});
  });
});

function buttonsOf(tree: ReturnType<typeof walk>) {
  return tree.filter((el) => el.type === "button");
}

function click(el: ReturnType<typeof buttonsOf>[number]): void {
  (propsOf(el).onClick as () => void)();
}

describe("ActionFormList — zero-field, zero-attribution fast path", () => {
  it("submits immediately on tap, with no expand step", () => {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [action()],
      t,
      submittingType: null,
      onSubmit: (type, payload) => calls.push({ type, payload }),
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    const [tile] = buttonsOf(island.tree());
    expect(textOf(tile!)).toBe("Toss");
    click(tile!);
    expect(calls).toEqual([{ type: "cricket.toss", payload: {} }]);
    // No confirm/cancel pair ever appeared — the fast path never expands.
    expect(island.text()).not.toContain("scorepad.action.confirm");
  });

  it("meets the 44px floor and is disabled while THAT action is submitting", () => {
    const island = renderIsland(ActionFormList, {
      actions: [action()],
      t,
      submittingType: "cricket.toss",
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    const [tile] = buttonsOf(island.tree());
    expect(propsOf(tile!).style).toMatchObject({ minHeight: 44 });
    expect(propsOf(tile!).disabled).toBe(true);
  });
});

describe("ActionFormList — an action with fields expands, validates, and confirms", () => {
  const withField = action({
    type: "cricket.review",
    labelKey: label("Review"),
    fields: [{ kind: "enum", path: "by", values: ["home", "away"], labelKey: label("Side") }],
  });

  it("tapping the collapsed row expands it instead of submitting", () => {
    const calls: unknown[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [withField],
      t,
      submittingType: null,
      onSubmit: (...args) => calls.push(args),
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!);
    expect(calls).toEqual([]);
    expect(island.text()).toContain("scorepad.action.confirm");
    expect(island.text()).toContain("scorepad.action.cancel");
  });

  it("Confirm is disabled until every declared field is set, matching checkActionValidity", () => {
    const island = renderIsland(ActionFormList, {
      actions: [withField],
      t,
      submittingType: null,
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBe(true);
  });

  it("confirming with a value set builds the payload via buildActionPayload and calls onSubmit with the action's own type", () => {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [withField],
      t,
      submittingType: null,
      onSubmit: (type, payload) => calls.push({ type, payload }),
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const select = island.tree().find((el) => el.type === "select")!;
    (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: "home" } });
    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    click(confirm);
    expect(calls).toEqual([{ type: "cricket.review", payload: { by: "home" } }]);
  });

  it("Cancel resets the values and collapses back to the tile with no submit", () => {
    const calls: unknown[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [withField],
      t,
      submittingType: null,
      onSubmit: (...args) => calls.push(args),
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const cancel = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.cancel")!;
    click(cancel);
    expect(calls).toEqual([]);
    expect(island.text()).toContain("Review"); // collapsed row shows the action's own label again
    expect(island.text()).not.toContain("scorepad.action.confirm");
  });

  it("re-expanding after Cancel starts from FRESH values, not whatever was typed before cancelling", () => {
    const island = renderIsland(ActionFormList, {
      actions: [withField],
      t,
      submittingType: null,
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const select = island.tree().find((el) => el.type === "select")!;
    (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: "home" } });
    click(buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.cancel")!);
    click(buttonsOf(island.tree())[0]!); // re-expand
    const reopenedSelect = island.tree().find((el) => el.type === "select")!;
    expect(propsOf(reopenedSelect).value).toBe(""); // not "home"
  });
});

describe("ActionFormList — each action's expand state is independent", () => {
  it("expanding one action does not collapse or discard another's in-progress entry", () => {
    const withA = action({
      type: "cricket.toss",
      labelKey: label("Toss"),
      fields: [{ kind: "enum", path: "by", values: ["home", "away"], labelKey: label("Side") }],
    });
    const withB = action({
      type: "cricket.declare",
      labelKey: label("Declare"),
      fields: [{ kind: "enum", path: "batting", values: ["home", "away"], labelKey: label("Side") }],
    });
    const island = renderIsland(ActionFormList, {
      actions: [withA, withB],
      t,
      submittingType: null,
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree()).find((b) => textOf(b) === "Toss")!);
    const [selectA] = island.tree().filter((el) => el.type === "select");
    (propsOf(selectA!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "home" } });
    click(buttonsOf(island.tree()).find((b) => textOf(b) === "Declare")!);

    // Both rows are now expanded, and A's own selection survived B's expand.
    const selects = island.tree().filter((el) => el.type === "select");
    expect(selects).toHaveLength(2);
    expect(propsOf(selects[0]!).value).toBe("home");
    expect(propsOf(selects[1]!).value).toBe("");
  });
});

describe("ActionFormList — locked availability", () => {
  it("renders the worded lock reason, never a bare tile, and offers no submit control", () => {
    const calls: unknown[] = [];
    const locked = action({
      availability: { kind: "locked", reason: { key: "scorepad.locked.reason", label: "Upgrade your plan to unlock this action." } },
    });
    const island = renderIsland(ActionFormList, {
      actions: [locked],
      t,
      submittingType: null,
      onSubmit: (...args) => calls.push(args),
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    expect(island.text()).toContain("scorepad.locked.reason");
    expect(buttonsOf(island.tree())).toHaveLength(0); // no tappable control at all
    expect(calls).toEqual([]);
  });
});

describe("ActionFormList — generic walk over any padSpec(cfg) action", () => {
  it("renders one row per action, in the order given, dispatching each tap with its OWN action's type", () => {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [action({ type: "cricket.toss", labelKey: label("Toss") }), action({ type: "cricket.declare", labelKey: label("Declare") })],
      t,
      submittingType: null,
      onSubmit: (type, payload) => calls.push({ type, payload }),
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    const buttons = buttonsOf(island.tree());
    expect(buttons.map((b) => textOf(b))).toEqual(["Toss", "Declare"]);
    click(buttons[1]!);
    expect(calls).toEqual([{ type: "cricket.declare", payload: {} }]);
  });

  it("renders the empty-state copy for a genuinely empty action list, not a blank sheet", () => {
    const island = renderIsland(ActionFormList, {
      actions: [],
      t,
      submittingType: null,
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    expect(island.text()).toContain("pad.host.moreEmpty");
  });

  it("marks only the currently-submitting action's own row as submitting", () => {
    const island = renderIsland(ActionFormList, {
      actions: [action({ type: "cricket.toss", labelKey: label("Toss") }), action({ type: "cricket.declare", labelKey: label("Declare") })],
      t,
      submittingType: "cricket.declare",
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    const buttons = buttonsOf(island.tree());
    expect(propsOf(buttons.find((b) => textOf(b) === "Toss")!).disabled).toBeFalsy();
    expect(propsOf(buttons.find((b) => textOf(b) === "Declare")!).disabled).toBe(true);
  });
});

// --- Defect 1 (r2-cricket review) --------------------------------------
//
// checkActionValidity (view-model.ts) used to never gate on attribution at
// all, and buildActionPayload omits any attribution path with no collected
// value — so BEFORE this fix, an action with declared `attribution` items
// (cricket.review: by/person/against; cricket.toss: wonBy) rendered no
// control for them at all: Confirm stayed enabled and the submitted
// payload silently dropped the attributed people, with nothing shown to
// the scorer. This block proves the collection UI exists and reaches the
// built payload. As of R8/WS-B2 (`PadAttributionItem.required`,
// engine-stamped, d4c8ddbfb), an item explicitly marked required DOES gate
// Confirm — see the dedicated describe block below — but the fixtures in
// THIS block never set `required` on their attribution items, so they
// stay optional/skippable exactly as before (the reviewAction below is
// hand-typed with no `required` key, matching a hand-built fixture never
// run through the engine's own stamp).
describe("ActionFormList — attribution items (defect 1: the seam was dropped, not ported)", () => {
  const SQUADS: SquadState = {
    home: {
      entrantId: "home-1",
      members: [
        { personId: "p-home", role: "player", provenance: "named", orderNo: 1, onField: true, started: true, timesOff: 0, timesOn: 0 },
      ],
      subsUsed: 0,
      exemptUsed: {},
    },
    away: {
      entrantId: "away-1",
      members: [
        { personId: "p-away", role: "player", provenance: "named", orderNo: 1, onField: true, started: true, timesOff: 0, timesOn: 0 },
      ],
      subsUsed: 0,
      exemptUsed: {},
    },
  };
  const LINEUPS: LineupPair = {
    home: { entrantId: "home-1", slots: [{ personId: "p-home", slot: "starting", orderNo: 1 }] },
    away: { entrantId: "away-1", slots: [{ personId: "p-away", slot: "starting", orderNo: 1 }] },
  };
  const NAMES = { "p-home": "Home Player", "p-away": "Away Player" };

  // Mirrors the REAL cricket.review shape verbatim (cricket.ts:2499-2514) —
  // two required fields PLUS a side item and two person items on the same
  // action, exactly the shape a single attribution.kind discriminant could
  // not express (PadAttribution's own doc comment).
  const reviewAction = action({
    type: "cricket.review",
    labelKey: label("Review"),
    fields: [
      { kind: "enum", path: "kind", values: ["player", "umpire"], labelKey: label("Kind") },
      { kind: "enum", path: "outcome", values: ["upheld", "struck_down", "umpires_call"], labelKey: label("Outcome") },
    ],
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "person" },
      { kind: "person", path: "against" },
    ],
  });

  function renderReview() {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [reviewAction],
      t,
      submittingType: null,
      onSubmit: (type, payload) => calls.push({ type, payload }),
      squads: SQUADS,
      lineups: LINEUPS,
      personNames: NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    return { island, calls };
  }

  function groupFor(tree: ReturnType<typeof walk>, path: string) {
    return tree.find((el) => propsOf(el)["data-attribution-path"] === path);
  }
  function chipsOf(group: ReturnType<typeof walk>[number]) {
    return walk(propsOf(group).children as never).filter((el) => el.type === "button");
  }

  it("renders one group per declared attribution item, each with its own real candidates", () => {
    const { island } = renderReview();
    const tree = island.tree();

    const byGroup = groupFor(tree, "by");
    expect(byGroup).toBeDefined(); // <- reds today: no attribution group renders at all
    const byChips = chipsOf(byGroup!);
    expect(byChips.map((c) => propsOf(c)["data-value"])).toEqual(["home-1", "away-1"]);

    const personGroup = groupFor(tree, "person")!;
    const personChips = chipsOf(personGroup);
    expect(personChips.map((c) => propsOf(c)["data-value"]).sort()).toEqual(["p-away", "p-home"]);
    expect(personChips.map((c) => textOf(c)).sort()).toEqual(["Away Player", "Home Player"]);

    const againstGroup = groupFor(tree, "against")!;
    expect(chipsOf(againstGroup).map((c) => propsOf(c)["data-value"]).sort()).toEqual(["p-away", "p-home"]);
  });

  it("selecting a chip per item and confirming builds a payload carrying every attributed person/side", () => {
    const { island, calls } = renderReview();

    // Fill the two ordinary fields first (unrelated to this defect, but
    // required for checkActionValidity to allow Confirm at all). Re-fetch
    // the tree between the two edits — each onChange re-renders
    // synchronously and rebinds a fresh handler closure, exactly like a
    // real browser would between two separate user interactions; reusing a
    // stale element reference for the SECOND select would invoke a
    // closure captured before the first value was set.
    const kindSelect = island.tree().filter((el) => el.type === "select")[0]!;
    (propsOf(kindSelect).onChange as (e: { target: { value: string } }) => void)({ target: { value: "player" } });
    const outcomeSelect = island.tree().filter((el) => el.type === "select")[1]!;
    (propsOf(outcomeSelect).onChange as (e: { target: { value: string } }) => void)({ target: { value: "upheld" } });

    click(chipsOf(groupFor(island.tree(), "by")!)[0]!); // "home-1"
    click(chipsOf(groupFor(island.tree(), "person")!)[0]!);
    click(chipsOf(groupFor(island.tree(), "against")!)[1]!);

    const finalTree = island.tree();
    const confirm = buttonsOf(finalTree).find((b) => textOf(b) === "scorepad.action.confirm")!;
    click(confirm);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe("cricket.review");
    expect(calls[0]!.payload).toMatchObject({ kind: "player", outcome: "upheld", by: "home-1" });
    // person/against both draw from the same 2-candidate pool — assert only
    // that BOTH attributed paths made it into the payload at all (today
    // neither does), not which of the two ids landed in which slot.
    expect(calls[0]!.payload.person).toBeDefined();
    expect(calls[0]!.payload.against).toBeDefined();
  });

  it("re-tapping a pressed chip clears it back to unselected, mirroring every other chip control in v3", () => {
    const { island } = renderReview();
    const byGroup = () => groupFor(island.tree(), "by")!;
    const homeChip = () => chipsOf(byGroup())[0]!;

    click(homeChip());
    expect(propsOf(chipsOf(byGroup())[0]!)["aria-pressed"]).toBe(true);
    click(homeChip());
    expect(propsOf(chipsOf(byGroup())[0]!)["aria-pressed"]).toBe(false);
  });

  it("Confirm stays enabled with every OPTIONAL attribution item unfilled (none of this fixture's items are `required`)", () => {
    const { island } = renderReview();
    const kindSelect = island.tree().filter((el) => el.type === "select")[0]!;
    (propsOf(kindSelect).onChange as (e: { target: { value: string } }) => void)({ target: { value: "player" } });
    const outcomeSelect = island.tree().filter((el) => el.type === "select")[1]!;
    (propsOf(outcomeSelect).onChange as (e: { target: { value: string } }) => void)({ target: { value: "upheld" } });

    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBeFalsy(); // fields alone satisfy checkActionValidity
  });

  it("a person attribution item with zero eligible candidates renders worded 'no roster', never a bare empty group", () => {
    const island = renderIsland(ActionFormList, {
      actions: [
        action({
          type: "cricket.review",
          labelKey: label("Review"),
          attribution: [{ kind: "person", path: "person" }],
        }),
      ],
      t,
      submittingType: null,
      onSubmit: () => {},
      squads: NO_SQUADS, // both sides have zero members -> candidatesForPerson is []
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const group = groupFor(island.tree(), "person");
    expect(group).toBeDefined();
    expect(textOf(group!)).toContain("scorepad.attribution.noRoster");
    expect(chipsOf(group!)).toHaveLength(0);
  });

  it("a SIDE item always offers exactly Home/Away regardless of squads — its candidates come from lineups, not the roster", () => {
    const island = renderIsland(ActionFormList, {
      actions: [
        action({
          type: "cricket.toss",
          labelKey: label("Toss"),
          attribution: [{ kind: "side", path: "wonBy" }],
        }),
      ],
      t,
      submittingType: null,
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const group = groupFor(island.tree(), "wonBy");
    expect(group).toBeDefined();
    expect(chipsOf(group!).map((c) => propsOf(c)["data-value"])).toEqual(["home-1", "away-1"]);
  });
});

// R8/WS-B2 — the owner-picked "disabled-until-complete" design: a required
// attribution item's row gets a red asterisk + a "required" microcopy line,
// and Confirm is disabled with a one-line reason until it's filled. Uses a
// hand-typed `required: true` item (this file's own established
// convention — see reviewAction above, "mirrors the REAL cricket.review
// shape verbatim"), never the real engine padSpec (that derivation is
// view-model.test.ts's job, per memory rule #19 — this file proves the
// RENDERING wiring on top, using the same node-only `_hook-harness` the
// rest of this file already relies on for `disabled` prop assertions).
describe("ActionFormList — required attribution gates Confirm (R8/WS-B2, disabled-until-complete)", () => {
  const tossAction = action({
    type: "cricket.toss",
    labelKey: label("Toss"),
    attribution: [{ kind: "side", path: "wonBy", required: true }],
  });

  function chipsOf(group: ReturnType<typeof walk>[number]) {
    return walk(propsOf(group).children as never).filter((el) => el.type === "button");
  }

  function renderToss() {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [tossAction],
      t,
      submittingType: null,
      onSubmit: (type, payload) => calls.push({ type, payload }),
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    return { island, calls };
  }

  it("marks the required row with a red asterisk and the 'required' microcopy", () => {
    const { island } = renderToss();
    const group = island.tree().find((el) => propsOf(el)["data-attribution-path"] === "wonBy")!;
    expect(propsOf(group)["data-required"]).toBe(true);
    expect(textOf(group)).toContain("scorepad.attribution.required");
  });

  it("Confirm is disabled with a one-line reason while the required item is unfilled", () => {
    const { island } = renderToss();
    const tree = island.tree();
    const confirm = buttonsOf(tree).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBe(true);
    expect(island.text()).toContain("scorepad.validity.missingAttribution");
  });

  it("Confirm enables once the required item is filled, and the built payload carries it — no dead-end tap", () => {
    const { island, calls } = renderToss();
    const group = () => island.tree().find((el) => propsOf(el)["data-attribution-path"] === "wonBy")!;
    click(chipsOf(group())[0]!); // "home-1"

    const finalTree = island.tree();
    const confirm = buttonsOf(finalTree).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBeFalsy();

    click(confirm);
    expect(calls).toEqual([{ type: "cricket.toss", payload: { wonBy: "home-1" } }]);
  });

  it("re-clearing the required item (re-tap to deselect) disables Confirm again", () => {
    const { island } = renderToss();
    const group = () => island.tree().find((el) => propsOf(el)["data-attribution-path"] === "wonBy")!;
    click(chipsOf(group())[0]!); // select
    click(chipsOf(group())[0]!); // deselect

    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBe(true);
  });
});
