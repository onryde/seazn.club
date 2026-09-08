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
import { cricket } from "@seazn/engine/sports/cricket";
import { t as translate } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import fr from "@/dictionaries/fr/ui.json";
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

// W1 / Task 4 (entitlements v18): a "locked availability" describe stood
// here, proving an action whose band the org had not bought rendered its
// worded reason and no tappable control. `ActionAvailability` is deleted —
// there is no locked state for this list to render, and no producer that
// could raise one — so the block is removed rather than kept as a test of a
// branch that no longer exists.

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

  // R8 branch review, finding 6 — a REQUIRED person item with an empty
  // roster renders "no roster" and zero chips, so `checkActionValidity` can
  // never be satisfied and Confirm is disabled FOREVER. Not a regression
  // (the engine's strictObject already refused the payload), but before R8
  // the tap dead-ended at the engine, and now it dead-ends at a screen that
  // offers no way out at all. The scorer needs to be told what to do.
  it("a REQUIRED person item with zero candidates words the way out — Confirm is otherwise permanently unsatisfiable", () => {
    const island = renderIsland(ActionFormList, {
      actions: [
        action({
          type: "cricket.review",
          labelKey: label("Review"),
          attribution: [{ kind: "person", path: "person", required: true }],
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
    const group = groupFor(island.tree(), "person")!;

    // The dead end is real: nothing to tap, and Confirm cannot be satisfied.
    expect(chipsOf(group)).toHaveLength(0);
    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBe(true);

    // ...so the row must say what to DO, not merely that the roster is empty.
    expect(textOf(group)).toContain("scorepad.attribution.noRosterRequired");
  });

  it("an OPTIONAL item with zero candidates keeps the plain 'no roster' wording — nothing to escalate, Confirm still works", () => {
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
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const group = groupFor(island.tree(), "person")!;
    expect(textOf(group)).not.toContain("scorepad.attribution.noRosterRequired");
    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBeFalsy();
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

// Task 18 — owner ruling 12 (S18): cricket.player.line's real padSpec entry
// (packages/engine/src/sports/cricket/cricket.ts) now sets `chips: true` on
// its `batting.dismissal.kind` field (PadFieldEnum, module.ts) — the SAME
// "enum" kind every other pad enum field already uses, rendered as a chip
// row instead of a `<select>`, per this file's existing per-KIND branching
// (renderField), never a per-path one. A hand-typed fixture, mirroring this
// file's own convention (see `reviewAction` above) rather than the real
// engine padSpec (view-model.test.ts's job, memory rule #19).
describe("ActionFormList — an enum field with chips: true renders a chip row, not a select (owner ruling 12, S18)", () => {
  const chipField = { kind: "enum" as const, path: "batting.dismissal.kind", values: ["bowled", "caught", "lbw"], chips: true };
  const lineAction = action({
    type: "cricket.player.line",
    labelKey: label("Scorecard line"),
    fields: [chipField],
  });

  function renderLine() {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [lineAction],
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

  it("renders one chip per declared value, each ≥44px carrying its own data-value — never a <select>", () => {
    const { island } = renderLine();
    const tree = island.tree();
    expect(tree.some((el) => el.type === "select")).toBe(false);
    const chips = buttonsOf(tree).filter((b) => propsOf(b)["data-value"] !== undefined);
    expect(chips.map((c) => propsOf(c)["data-value"])).toEqual(["bowled", "caught", "lbw"]);
    for (const chip of chips) expect(propsOf(chip).style).toMatchObject({ minHeight: 44 });
  });

  it("tapping a chip marks it pressed, and confirming builds the payload nesting the tapped value", () => {
    const { island, calls } = renderLine();
    const chip = () => buttonsOf(island.tree()).find((b) => propsOf(b)["data-value"] === "caught")!;
    click(chip());
    expect(propsOf(chip())["aria-pressed"]).toBe(true);

    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    click(confirm);
    expect(calls).toEqual([{ type: "cricket.player.line", payload: { batting: { dismissal: { kind: "caught" } } } }]);
  });

  it("re-tapping a pressed chip clears it back to unselected, mirroring every other chip control in v3", () => {
    const { island } = renderLine();
    const chip = () => buttonsOf(island.tree()).find((b) => propsOf(b)["data-value"] === "bowled")!;
    click(chip());
    expect(propsOf(chip())["aria-pressed"]).toBe(true);
    click(chip());
    expect(propsOf(chip())["aria-pressed"]).toBe(false);
  });
});

// Task 18 — owner ruling 12 (S18): `field.optional` (module.ts, hand-authored)
// lets a declared field stay unset without blocking Confirm — proved here at
// the RENDERING layer (checkActionValidity's own unit is view-model.test.ts's
// job). Mutant (a) in the task's verification: drop the `field.optional !==
// true` half of the missingFields filter and this test reds (Confirm stays
// disabled forever).
describe("ActionFormList — an optional field does not block Confirm (owner ruling 12, S18)", () => {
  const mixedAction = action({
    type: "cricket.player.line",
    labelKey: label("Scorecard line"),
    fields: [
      { kind: "number" as const, path: "batting.runs", min: 0, max: 300 },
      { kind: "number" as const, path: "batting.fours", min: 0, max: 20, optional: true },
    ],
  });

  function numberInputs(island: { tree: () => ReturnType<typeof walk> }) {
    return island.tree().filter((el) => el.type === "input" && propsOf(el).type === "number");
  }

  it("Confirm enables once the required field is set, even though the optional one is left unset", () => {
    const island = renderIsland(ActionFormList, {
      actions: [mixedAction],
      t,
      submittingType: null,
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const [runsInput] = numberInputs(island);
    (propsOf(runsInput!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "30" } });

    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBeFalsy();
  });

  it("the required (non-optional) field still blocks Confirm when left unset — negative pair for the check above", () => {
    const island = renderIsland(ActionFormList, {
      actions: [mixedAction],
      t,
      submittingType: null,
      onSubmit: () => {},
      squads: NO_SQUADS,
      lineups: NO_LINEUPS,
      personNames: NO_NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    const [, foursInput] = numberInputs(island);
    (propsOf(foursInput!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "2" } });

    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    expect(propsOf(confirm).disabled).toBe(true);
  });
});

// Task 18 — ruling 4: `Number("")` is `0`, so a cleared numeric input must
// reach the built payload as genuinely ABSENT, never a coerced 0. The
// renderer's existing number-field `onChange` already special-cases the
// empty string (pre-dates this task); this proves the full round trip
// through a real optional field the scorer can legitimately leave blank
// after having typed into it. Mutant (b): make the `raw === ""` branch fall
// through to `Number(raw)` and this test reds (payload carries `fours: 0`).
describe("ActionFormList — clearing a numeric field never coerces to 0 (owner ruling 12, ruling 4)", () => {
  it("typing then clearing batting.fours builds no key at all, never fours: 0", () => {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const withField = action({
      type: "cricket.player.line",
      labelKey: label("Scorecard line"),
      fields: [{ kind: "number" as const, path: "batting.fours", min: 0, max: 20, optional: true }],
    });
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
    const input = () => island.tree().find((el) => el.type === "input" && propsOf(el).type === "number")!;
    (propsOf(input()).onChange as (e: { target: { value: string } }) => void)({ target: { value: "3" } });
    expect(propsOf(input()).value).toBe(3);
    (propsOf(input()).onChange as (e: { target: { value: string } }) => void)({ target: { value: "" } });
    expect(propsOf(input()).value).toBe("");

    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    click(confirm);
    expect(calls).toEqual([{ type: "cricket.player.line", payload: {} }]);
  });
});

// Task 18 — the brief's own acceptance criterion: "the legacy 7-field
// payload is byte-identical when no new field is touched". A hand-typed
// fixture mirroring cricket.player.line's REAL 13-field/3-attribution shape
// (cricket.ts's playerLineAction post-Task-18), per this file's own
// established convention of mirroring rather than importing the real
// padSpec (memory rule #19 — the derivation itself is proved in
// player-line.test.ts/view-model.test.ts). Only the seven legacy fields plus
// the one required attribution are ever touched here; the six new fields
// and the two optional attributions are never set.
describe("ActionFormList — the legacy 7-field player-line payload stays byte-identical (owner ruling 12, S18)", () => {
  const lineAction = action({
    type: "cricket.player.line",
    labelKey: label("Scorecard line"),
    fields: [
      { kind: "number" as const, path: "innings", min: 1, max: 4 },
      { kind: "toggle" as const, path: "batting.out" },
      { kind: "number" as const, path: "batting.runs", min: 0, max: 300 },
      { kind: "number" as const, path: "batting.balls", min: 0, max: 300 },
      { kind: "number" as const, path: "batting.fours", min: 0, max: 300, optional: true },
      { kind: "number" as const, path: "batting.sixes", min: 0, max: 300, optional: true },
      { kind: "enum" as const, path: "batting.dismissal.kind", values: ["bowled", "caught"], chips: true, optional: true },
      { kind: "number" as const, path: "bowling.legalBalls", min: 0, max: 300 },
      { kind: "number" as const, path: "bowling.runs", min: 0, max: 300 },
      { kind: "number" as const, path: "bowling.wickets", min: 0, max: 10 },
      { kind: "number" as const, path: "bowling.maidens", min: 0, max: 50, optional: true },
      { kind: "number" as const, path: "bowling.wides", min: 0, max: 300, optional: true },
      { kind: "number" as const, path: "bowling.noBalls", min: 0, max: 300, optional: true },
    ],
    attribution: [
      { kind: "person" as const, path: "person" },
      { kind: "person" as const, path: "batting.dismissal.bowler", optional: true, requiresField: "batting.dismissal.kind" },
      { kind: "person" as const, path: "batting.dismissal.fielder", optional: true, requiresField: "batting.dismissal.kind" },
    ],
  });

  const SQUADS: SquadState = {
    home: {
      entrantId: "home-1",
      members: [
        { personId: "p-home", role: "player", provenance: "named", orderNo: 1, onField: true, started: true, timesOff: 0, timesOn: 0 },
      ],
      subsUsed: 0,
      exemptUsed: {},
    },
    away: { entrantId: "away-1", members: [], subsUsed: 0, exemptUsed: {} },
  };
  const LINEUPS: LineupPair = {
    home: { entrantId: "home-1", slots: [{ personId: "p-home", slot: "starting", orderNo: 1 }] },
    away: { entrantId: "away-1", slots: [] },
  };
  const NAMES = { "p-home": "Home Player" };

  it("touching only the seven legacy fields plus person builds the exact legacy payload — no extra keys", () => {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [lineAction],
      t,
      submittingType: null,
      onSubmit: (type, payload) => calls.push({ type, payload }),
      squads: SQUADS,
      lineups: LINEUPS,
      personNames: NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand

    const numberInputByOrder = (n: number) =>
      island.tree().filter((el) => el.type === "input" && propsOf(el).type === "number")[n]!;
    const setNumber = (n: number, v: string) =>
      (propsOf(numberInputByOrder(n)).onChange as (e: { target: { value: string } }) => void)({ target: { value: v } });

    // Declared order: innings(0, number), batting.out(toggle, skipped from
    // this indexed list), batting.runs(1), batting.balls(2), fours(3, SKIPPED
    // — legacy-only), sixes(4, SKIPPED), dismissal.kind(enum, SKIPPED),
    // bowling.legalBalls(5), bowling.runs(6), bowling.wickets(7),
    // maidens(8, SKIPPED), wides(9, SKIPPED), noBalls(10, SKIPPED).
    setNumber(0, "1"); // innings
    setNumber(1, "30"); // batting.runs
    setNumber(2, "20"); // batting.balls
    setNumber(5, "12"); // bowling.legalBalls
    setNumber(6, "20"); // bowling.runs
    setNumber(7, "2"); // bowling.wickets

    const toggle = island.tree().find((el) => el.type === "input" && propsOf(el).type === "checkbox")!;
    (propsOf(toggle).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });

    const personGroup = island.tree().find((el) => propsOf(el)["data-attribution-path"] === "person")!;
    const personChip = walk(propsOf(personGroup).children as never).filter((el) => el.type === "button")[0]!;
    click(personChip);

    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    click(confirm);

    expect(calls).toEqual([
      {
        type: "cricket.player.line",
        payload: {
          innings: 1,
          person: "p-home",
          batting: { out: true, runs: 30, balls: 20 },
          bowling: { legalBalls: 12, runs: 20, wickets: 2 },
        },
      },
    ]);
  });
});

// Review round 1 (task-18-review.md, Important #1) — the six new fields
// plus the two dismissal-credit attributions now carry real `labelKey`s
// (cricket.ts), registered in `PAD_LABEL_KEYS` (scoring-vocab.ts) and
// translated in all four `ui.json` dictionaries. This proves the FULL
// chain end to end against the REAL engine padSpec and the REAL French
// dictionary (never a fixture `t = (k) => k` stub, and never the real
// engine padSpec elsewhere in this file per its own header note — this is
// the one test in this file for which reading the real translated string
// IS the point): every label renders the French dictionary value, and the
// English fallback (`field.labelKey.label`, e.g. "Fours") never leaks
// through for a viewer with no English at all.
describe("ActionFormList — cricket.player.line's new labels render the REAL French dictionary, not the English fallback (owner ruling 12, review round 1)", () => {
  const frDict = fr as unknown as Dict;
  const tFr: ActionFormListProps["t"] = (key, vars) => translate(frDict, key, vars);

  const cfg = cricket.configSchema.parse({});
  const lineAction = cricket
    .padSpec!(cfg)
    .panels.flatMap((p) => p.actions)
    .find((a) => a.type === "cricket.player.line")!;

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

  function renderFrenchLine() {
    const island = renderIsland(ActionFormList, {
      actions: [lineAction],
      t: tFr,
      submittingType: null,
      onSubmit: () => {},
      squads: SQUADS,
      lineups: LINEUPS,
      personNames: NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    return island;
  }

  // The six new FIELD captions the review named explicitly.
  it.each([
    ["batting.fours", "Quatres", "Fours"],
    ["batting.sixes", "Six", "Sixes"],
    ["batting.dismissal.kind", "Comment éliminé", "How out"],
    ["bowling.maidens", "Maidens", "Maidens"],
    ["bowling.wides", "Wides", "Wides"],
    ["bowling.noBalls", "No-balls", "No-balls"],
  ])("field %s renders the French dict value %j, never the English fallback %j", (path, frText, enFallback) => {
    const island = renderFrenchLine();
    const text = island.text();
    expect(text).toContain(frText);
    // "Maidens"/"No-balls"/"Wides" are deliberately IDENTICAL in French and
    // English (cricket notation, matching the pre-existing `extra.wide`/
    // `extra.noball` precedent of staying unstranslated in every locale) —
    // for those, containment alone cannot distinguish "real French lookup"
    // from "coincidentally the same word", so this only asserts the
    // stronger negative check (fallback absent) where the two strings
    // actually differ.
    if (frText !== enFallback) expect(text).not.toContain(enFallback);
    void path; // documents which field this row covers; not queried directly
  });

  // The two dismissal-credit ATTRIBUTION captions (added alongside the six
  // fields in this same fix round).
  //
  // Task B — both rows are now GATED on the dismissal kind and are not drawn
  // until one is picked, so this test picks "caught" (bowler-credited, so
  // both rows are admissible) before looking for them. Deliberately NOT
  // weakened to match the new markup: the captions still have to be French,
  // the test just has to reach the state that draws them.
  it("the bowler/fielder attribution captions render the French dict value, never the English fallback", () => {
    const island = renderFrenchLine();
    click(buttonsOf(island.tree()).find((b) => propsOf(b)["data-value"] === "caught")!);
    const bowlerGroup = island.tree().find((el) => propsOf(el)["data-attribution-path"] === "batting.dismissal.bowler")!;
    const fielderGroup = island.tree().find((el) => propsOf(el)["data-attribution-path"] === "batting.dismissal.fielder")!;
    expect(textOf(bowlerGroup)).toContain("Lanceur");
    expect(textOf(bowlerGroup)).not.toContain("Bowler");
    expect(textOf(fielderGroup)).toContain("Joueur de champ");
    expect(textOf(fielderGroup)).not.toContain("Fielder");
  });

  // -------------------------------------------------------------------------
  // P5 (whole-branch review) — THE CHIP ROW ITSELF HAD NO ACCESSIBLE NAME
  // -------------------------------------------------------------------------
  //
  // Every OTHER field kind in `renderField` wraps its caption and its control
  // in one `<label>`, which is what associates the two. The `chips: true` arm
  // cannot: a `<label>` names one control, and this arm draws ten. Its caption
  // was therefore a bare `<span>` naming nothing, so a screen-reader user
  // arriving at the row heard "Bowled, button. Caught, button. LBW, button."
  // with nothing saying which field they belong to — the ONE thing the caption
  // exists for, and invisible to every test in this file, which read the
  // caption's TEXT and never asked what it named.
  //
  // The name is the field's own visible caption, REFERENCED (`aria-labelledby`)
  // rather than copied into an `aria-label`: one string, already translated in
  // all four dictionaries, and the two cannot drift apart.
  it("the chip row is a group named by the field's own caption, not ten unattached buttons", () => {
    const island = renderFrenchLine();
    const tree = island.tree();
    const wrapper = tree.find((el) => propsOf(el)["data-field-path"] === "batting.dismissal.kind")!;
    expect(wrapper, "the chip field did not render at all").toBeDefined();
    const nodes = walk(wrapper);

    const group = nodes.find((el) => propsOf(el).role === "group");
    expect(group, "the chip row declares no role=group, so it is not a group at all").toBeDefined();

    const labelledBy = propsOf(group!)["aria-labelledby"] as string | undefined;
    expect(labelledBy, "the group carries no aria-labelledby — it has no name").toBeTruthy();
    const caption = nodes.find((el) => propsOf(el).id === labelledBy);
    expect(caption, `nothing inside the field carries id="${labelledBy}"`).toBeDefined();

    // The name is LOCALISED, and it is the caption a sighted scorer reads.
    expect(textOf(caption!)).toBe("Comment éliminé");
    expect(textOf(caption!)).not.toContain("How out");

    // …and the chips are INSIDE the named group. A group that named the
    // caption but wrapped nothing would satisfy every assertion above.
    const chips = walk(group!).filter((el) => propsOf(el)["data-value"] !== undefined);
    expect(chips.length, "the named group contains no chips").toBeGreaterThanOrEqual(3);
    expect(chips.every((c) => c.type === "button")).toBe(true);
  });

  it("every chip still carries its own name too — the group adds to them, it does not replace them", () => {
    // Negative pair for the group: a fix that moved the caption onto the row
    // and left the buttons empty would trade one defect for a worse one.
    const island = renderFrenchLine();
    const wrapper = island.tree().find((el) => propsOf(el)["data-field-path"] === "batting.dismissal.kind")!;
    const chips = walk(wrapper).filter((el) => propsOf(el)["data-value"] !== undefined);
    expect(chips.length).toBeGreaterThanOrEqual(3);
    for (const chip of chips) expect(textOf(chip).trim(), String(propsOf(chip)["data-value"])).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// Task A — the SEVEN fields and ONE attribution item on `cricket.player.line`
// that shipped with no `labelKey` at all.
//
// An uncaptioned control does not render blank and does not render a key: it
// renders `deriveFieldPathLabel(field.path)` (view-model.ts), a word-split of
// the engine's internal dotted path, deliberately never routed through a
// dictionary. So a French scorer read "Bowling legal balls", "Batting out"
// and "Scorecard line — Person" off this form — untranslated copy nothing in
// the i18n toolchain can see (`i18n:check` walks `src/dictionaries/**`; these
// strings are computed at render time and exist in no file).
//
// Driven against the REAL engine padSpec and the REAL French dictionary, and
// every assertion is SCOPED to its own row (`data-field-path` /
// `data-attribution-path`) rather than to the island's whole text. That is
// load-bearing here, not tidiness: "Joueur" (the person picker) is a prefix
// of "Joueur de champ" (the fielder, captioned in an earlier round), so an
// unscoped `toContain("Joueur")` passes with the person caption still
// English. Same trap for "Runs marqués" / "Runs concédés".
// ---------------------------------------------------------------------------
describe("ActionFormList — cricket.player.line's SEVEN uncaptioned fields now render the French dictionary (Task A)", () => {
  const frDict = fr as unknown as Dict;
  const tFr: ActionFormListProps["t"] = (key, vars) => translate(frDict, key, vars);

  const cfg = cricket.configSchema.parse({});
  const lineAction = cricket
    .padSpec!(cfg)
    .panels.flatMap((p) => p.actions)
    .find((a) => a.type === "cricket.player.line")!;

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

  function renderFrenchLine() {
    const island = renderIsland(ActionFormList, {
      actions: [lineAction],
      t: tFr,
      submittingType: null,
      onSubmit: () => {},
      squads: SQUADS,
      lineups: LINEUPS,
      personNames: NAMES,
    });
    click(buttonsOf(island.tree())[0]!); // expand
    return island;
  }

  // [path, French dictionary value, the derived ENGLISH the pad used to show]
  it.each([
    ["innings", "Manche", "Innings"],
    ["batting.out", "Éliminé", "Batting out"],
    ["batting.runs", "Runs marqués", "Batting runs"],
    ["batting.balls", "Balles jouées", "Batting balls"],
    ["bowling.legalBalls", "Balles lancées", "Bowling legal balls"],
    ["bowling.runs", "Runs concédés", "Bowling runs"],
    ["bowling.wickets", "Guichets", "Bowling wickets"],
  ])("field %s is captioned %j in French, never the derived English %j", (path, frText, derivedEnglish) => {
    const island = renderFrenchLine();
    const row = island.tree().find((el) => propsOf(el)["data-field-path"] === path);
    expect(row, `no row carries data-field-path="${path}"`).toBeDefined();
    expect(textOf(row!)).toContain(frText);
    // The whole island, because the derived label must not survive ANYWHERE
    // on the form — including as some other row's caption.
    expect(island.text()).not.toContain(derivedEnglish);
  });

  it("the person attribution is captioned 'Joueur', not 'Ligne de la feuille de match — Personne'", () => {
    const island = renderFrenchLine();
    const row = island.tree().find((el) => propsOf(el)["data-attribution-path"] === "person")!;
    expect(row, "the person attribution row did not render").toBeDefined();
    const caption = textOf(row!);
    // Scoped, and asserted as an EXACT prefix rather than containment: the
    // chips inside this row are person NAMES ("Home Player"), so containment
    // alone would not distinguish the caption from them.
    expect(caption.startsWith("Joueur"), `caption was ${JSON.stringify(caption)}`).toBe(true);
    expect(island.text()).not.toContain("Personne");
    // The captioned branch of `attributionItemCaption` drops the owning
    // action's name; the uncaptioned one prefixed it. Pin that it is gone.
    expect(caption).not.toContain("Ligne de la feuille de match");
  });

  it("no control on this form is left on the derived-path fallback at all", () => {
    // Completeness, so a field added later without a labelKey reds here
    // rather than shipping English into three locales unnoticed.
    const uncaptioned = [
      ...lineAction.fields.filter((f) => f.labelKey === undefined).map((f) => `field ${f.path}`),
      ...lineAction.attribution.filter((a) => a.labelKey === undefined).map((a) => `attribution ${a.path}`),
    ];
    expect(uncaptioned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task B — the pad must not OFFER a bowler on a dismissal the engine refuses
// one for.
//
// W1 review finding P2 tightened `applyPlayerLine` (cricket.ts): naming
// `dismissal.bowler` on any kind outside `BOWLER_CREDITED_KINDS` is refused
// outright. `requiresField` gated only the PAYLOAD BUILD, never the render,
// so the row appeared the moment ANY kind was picked: tap "Run out", see the
// Bowler chips, name a bowler, hit Confirm, watch the engine refuse the
// event. This programme's own standing rule is "never offer what the engine
// will refuse".
//
// Driven against the REAL engine padSpec, so the admissible set is the one
// cricket actually declares (`requiresFieldIn: [...BOWLER_CREDITED_KINDS]`),
// never a list retyped here.
// ---------------------------------------------------------------------------
describe("ActionFormList — the bowler row is not OFFERED on a dismissal the engine refuses a bowler for (Task B)", () => {
  const cfg = cricket.configSchema.parse({});
  const lineAction = cricket
    .padSpec!(cfg)
    .panels.flatMap((p) => p.actions)
    .find((a) => a.type === "cricket.player.line")!;
  const bowlerItem = lineAction.attribution.find((a) => a.path === "batting.dismissal.bowler")!;
  const admissible = bowlerItem.requiresFieldIn ?? [];
  const kindField = lineAction.fields.find((f) => f.path === "batting.dismissal.kind")!;
  const allKinds = kindField.kind === "enum" ? kindField.values : [];
  const inadmissible = allKinds.filter((k) => !admissible.includes(k));

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

  function renderLine() {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const island = renderIsland(ActionFormList, {
      actions: [lineAction],
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
  const pickKind = (island: { tree: () => ReturnType<typeof walk> }, kind: string) =>
    click(buttonsOf(island.tree()).find((b) => propsOf(b)["data-value"] === kind)!);
  const rowFor = (island: { tree: () => ReturnType<typeof walk> }, path: string) =>
    island.tree().find((el) => propsOf(el)["data-attribution-path"] === path);

  it("the engine declares both a non-empty admissible set and a non-empty refused set — neither arm below is vacuous", () => {
    expect(admissible.length).toBeGreaterThan(0);
    expect(inadmissible.length).toBeGreaterThan(0);
  });

  it("draws NEITHER dismissal-credit row before any kind is picked", () => {
    const { island } = renderLine();
    expect(rowFor(island, "batting.dismissal.bowler")).toBeUndefined();
    expect(rowFor(island, "batting.dismissal.fielder")).toBeUndefined();
    // …but the ungated person picker is there, so this is a gate and not a
    // form that failed to render its attribution at all.
    expect(rowFor(island, "person")).toBeDefined();
  });

  it.each(inadmissible.map((k) => [k]))("hides the bowler row on %s — the engine refuses a bowler there", (kind) => {
    const { island } = renderLine();
    pickKind(island, kind);
    expect(rowFor(island, "batting.dismissal.bowler")).toBeUndefined();
    // The FIELDER stays: `creditFielding` accepts one on any kind, so this
    // is a per-item gate, not the whole dismissal block disappearing.
    expect(rowFor(island, "batting.dismissal.fielder")).toBeDefined();
  });

  it.each(admissible.map((k) => [k]))("offers the bowler row on %s — the engine credits a bowler there", (kind) => {
    const { island } = renderLine();
    pickKind(island, kind);
    expect(rowFor(island, "batting.dismissal.bowler")).toBeDefined();
    expect(rowFor(island, "batting.dismissal.fielder")).toBeDefined();
  });

  it("a bowler tapped on a credited kind does not survive a change to a refused one — the payload drops it too", () => {
    // The render gate alone would leave the tapped value in `values` and let
    // it reach the payload once the row vanished; the builder gate alone
    // would leave the dead end visible. This drives BOTH halves in one flow.
    const { island, calls } = renderLine();
    pickKind(island, "caught");
    const bowlerRow = rowFor(island, "batting.dismissal.bowler")!;
    const bowlerChip = walk(propsOf(bowlerRow).children as never).filter((el) => el.type === "button")[0]!;
    click(bowlerChip);

    pickKind(island, "caught"); // re-tap clears the chip field
    pickKind(island, "runout");
    expect(rowFor(island, "batting.dismissal.bowler")).toBeUndefined();

    // Re-queried on EVERY call, never captured once: a handler held from a
    // previous render closes over that render's `values`, so three writes
    // through stale nodes leave only the last one standing.
    const numberInputByOrder = (n: number) =>
      island.tree().filter((el) => el.type === "input" && propsOf(el).type === "number")[n]!;
    const setNumber = (n: number, v: string) =>
      (propsOf(numberInputByOrder(n)).onChange as (e: { target: { value: string } }) => void)({ target: { value: v } });
    setNumber(0, "1"); // innings
    setNumber(1, "30"); // batting.runs
    setNumber(2, "20"); // batting.balls

    const personRow = rowFor(island, "person")!;
    click(walk(propsOf(personRow).children as never).filter((el) => el.type === "button")[0]!);

    const confirm = buttonsOf(island.tree()).find((b) => textOf(b) === "scorepad.action.confirm")!;
    click(confirm);
    expect(calls).toHaveLength(1);
    const payload = calls[0]!.payload as { batting: { dismissal: Record<string, unknown> } };
    expect(payload.batting.dismissal).toEqual({ kind: "runout" });
  });
});
