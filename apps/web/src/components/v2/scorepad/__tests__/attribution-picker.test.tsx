// attribution-picker.tsx (S10/#419 W8, chassis item 3) — plugs into
// pad-renderer.tsx's `renderAttribution` typed seam. Driven through the
// repo's node-only `_hook-harness` (no DOM/jsdom in this workspace) — see
// its header and reference_hook_harness_click_without_dom.md.
//
// Real engine fixtures throughout (cricket + hockey), never a hand-rolled
// SquadState: the keeper test in particular folds a REAL `core.lineup.position`
// event through the actual kernel (`foldClient`) so a snapshot-based
// implementation of "who is the keeper" genuinely reds.
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import type { LineupPair } from "@seazn/engine/core";
import { foldClient } from "../module-client";
import { defaultLineupPair, makeEnvelope, lineupFromCatalog } from "@seazn/engine/testkit";
import { cricket } from "@seazn/engine/sports/cricket";
import { hockey } from "@seazn/engine/sports/hockey";
import { ActionForm, type ActionValues } from "../action-form";
import type { PadActionView } from "../view-model";
import type { PadFieldValue } from "@seazn/engine/sport";
import {
  AttributionPicker,
  attributionItemCaption,
  candidatesForPerson,
  isSquadState,
  resolveSquads,
} from "../attribution-picker";

function find(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement {
  const el = tree.find(pred);
  if (!el) throw new Error("element not found in rendered tree");
  return el;
}
function findAll(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement[] {
  return tree.filter(pred);
}
const isType = (type: unknown) => (el: ReactElement) => el.type === type;
const byPath = (tree: ReactElement[], path: string) =>
  find(tree, (el) => propsOf(el)["data-attribution-path"] === path);
const chipsOf = (group: ReactElement) => findAll(walk(propsOf(group).children as never), isType("button"));

const AVAILABLE = { kind: "available" as const };

function noop() {
  /* setValue stub */
}

describe("attribution-picker — shape sweep (table-driven over the real PadAttribution shapes)", () => {
  const CRICKET_LINEUPS: LineupPair = defaultLineupPair(cricket.positions);

  const cases: { name: string; attribution: PadActionView["attribution"] }[] = [
    { name: "zero items", attribution: [] },
    { name: "one side", attribution: [{ kind: "side", path: "wonBy" }] },
    { name: "one person", attribution: [{ kind: "person", path: "striker" }] },
    {
      // "WK" is cricket's own wicketkeeper position group — defaultLineupPair's
      // round-robin fill (BAT,BOWL,AR,WK,...) always seats exactly one starting
      // player there, so this case has a real, non-empty candidate list.
      name: "one person with a role",
      attribution: [{ kind: "person", path: "wicketkeeperOnField", role: "WK" }],
    },
    {
      name: "several persons at distinct paths",
      attribution: [
        { kind: "person", path: "striker" },
        { kind: "person", path: "nonStriker" },
        { kind: "person", path: "bowler" },
        { kind: "person", path: "wicket.fielder" },
      ],
    },
    {
      name: "side-plus-persons on one action",
      attribution: [
        { kind: "side", path: "by" },
        { kind: "person", path: "person" },
        { kind: "person", path: "against" },
      ],
    },
  ];

  for (const { name, attribution } of cases) {
    it(`renders without crashing and wires setValue for: ${name}`, () => {
      let lastSet: [string, unknown] | null = null;
      const island = renderIsland(AttributionPicker, {
        action: { attribution, labelKey: { key: "pad.cricket.action.ball", label: "Ball" } },
        values: {},
        setValue: (path: string, value: unknown) => (lastSet = [path, value]),
        lineups: CRICKET_LINEUPS,
        state: undefined,
      });
      const tree = island.tree();
      if (attribution.length === 0) {
        expect(tree.length).toBe(0);
        return;
      }
      // Every declared item gets its own addressable group.
      for (const item of attribution) {
        const group = byPath(tree, item.path);
        expect(group).toBeDefined();
      }
      // Tapping the FIRST chip of the FIRST item calls setValue with THAT
      // item's own path — never a neighbour's (each item is independently
      // wired, proven by picking on one path and checking no cross-talk).
      const firstGroup = byPath(tree, attribution[0]!.path);
      const chips = chipsOf(firstGroup);
      expect(chips.length, `${name}: expected at least one selectable chip`).toBeGreaterThan(0);
      (propsOf(chips[0]!).onClick as () => void)();
      expect(lastSet?.[0]).toBe(attribution[0]!.path);
    });
  }

  it("side-plus-persons: selecting one item's value does not touch a sibling item's value", () => {
    const sets: Record<string, unknown> = {};
    const attribution: PadActionView["attribution"] = [
      { kind: "side", path: "by" },
      { kind: "person", path: "person" },
    ];
    const island = renderIsland(AttributionPicker, {
      action: { attribution, labelKey: { key: "pad.cricket.action.review", label: "Review" } },
      values: {},
      setValue: (path: string, value: unknown) => (sets[path] = value),
      lineups: CRICKET_LINEUPS,
      state: undefined,
    });
    const tree = island.tree();
    const sideGroup = byPath(tree, "by");
    (propsOf(chipsOf(sideGroup)[0]!).onClick as () => void)();
    expect(Object.keys(sets)).toEqual(["by"]);
    expect(sets["person"]).toBeUndefined();
  });
});

describe("attribution-picker — the keeper must be read via personsAtPosition from FOLDED state, never the lineup prop", () => {
  const HOCKEY_CFG = hockey.configSchema.parse({});
  const HOCKEY_LINEUPS: LineupPair = defaultLineupPair(hockey.positions);
  const H = HOCKEY_LINEUPS.home.entrantId;
  // Default lineup: H's group-order fill puts the GK group first (min:1,
  // max:1) so "H-p1" starts at GK and "H-p2" starts at the next group (DF).
  const ORIGINAL_KEEPER = "H-p1";
  const NEW_KEEPER = "H-p2";

  const GK_ITEM: PadActionView["attribution"][number] = {
    kind: "person",
    path: "goalkeeper",
    role: "GK",
    labelKey: { key: "pad.hockey.action.shot.field.goalkeeper", label: "Goalkeeper" },
  };

  function foldedStateAfterKeeperMove(): unknown {
    const events = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      // Swap: the ORIGINAL keeper moves to DF, the new one moves to GK — so
      // afterwards exactly one person is at "GK" for home, and it is NOT the
      // team sheet's starting keeper.
      makeEnvelope(1, {
        type: "core.lineup.position",
        payload: { side: H, personId: ORIGINAL_KEEPER, positionKey: "DF" },
      }),
      makeEnvelope(2, {
        type: "core.lineup.position",
        payload: { side: H, personId: NEW_KEEPER, positionKey: "GK" },
      }),
    ];
    return foldClient(hockey, HOCKEY_CFG, HOCKEY_LINEUPS, events);
  }

  it("resolveSquads(state, lineups) surfaces the LIVE keeper after a position change, not the kickoff one", () => {
    const state = foldedStateAfterKeeperMove();
    const squads = resolveSquads(state, HOCKEY_LINEUPS);
    const candidates = candidatesForPerson(GK_ITEM, squads);
    const homeCandidates = candidates.filter((c) => c.side === "home").map((c) => c.personId);
    expect(homeCandidates).toEqual([NEW_KEEPER]);
    expect(homeCandidates).not.toContain(ORIGINAL_KEEPER);
  });

  it("the rendered picker offers the NEW keeper as a chip once folded state carries the move", () => {
    const state = foldedStateAfterKeeperMove();
    let lastSet: [string, unknown] | null = null;
    const island = renderIsland(AttributionPicker, {
      action: { attribution: [GK_ITEM], labelKey: { key: "pad.hockey.action.shot", label: "Shot" } },
      values: {},
      setValue: (path: string, value: unknown) => (lastSet = [path, value]),
      lineups: HOCKEY_LINEUPS,
      state,
    });
    const group = byPath(island.tree(), "goalkeeper");
    const chips = chipsOf(group);
    expect(chips.map((c) => propsOf(c)["data-value"])).toContain(NEW_KEEPER);
    expect(chips.map((c) => propsOf(c)["data-value"])).not.toContain(ORIGINAL_KEEPER);
    const newKeeperChip = find(chips, (c) => propsOf(c)["data-value"] === NEW_KEEPER);
    (propsOf(newKeeperChip).onClick as () => void)();
    expect(lastSet).toEqual(["goalkeeper", NEW_KEEPER]);
  });

  it("BEFORE any position change, the kickoff keeper alone is offered (proves the test fixture itself is meaningful)", () => {
    const events = [makeEnvelope(0, { type: "core.start", payload: {} })];
    const state = foldClient(hockey, HOCKEY_CFG, HOCKEY_LINEUPS, events);
    const squads = resolveSquads(state, HOCKEY_LINEUPS);
    const candidates = candidatesForPerson(GK_ITEM, squads).filter((c) => c.side === "home");
    expect(candidates.map((c) => c.personId)).toEqual([ORIGINAL_KEEPER]);
  });
});

describe("attribution-picker — degrades gracefully: no live squads -> team sheet; no roster at all -> side-only", () => {
  const CRICKET_LINEUPS: LineupPair = defaultLineupPair(cricket.positions);

  it("no `state.squads` at all -> falls back to initSquads(lineups), the kickoff team sheet", () => {
    const squads = resolveSquads(undefined, CRICKET_LINEUPS);
    const candidates = candidatesForPerson({ kind: "person", path: "striker" }, squads);
    const homeIds = candidates.filter((c) => c.side === "home").map((c) => c.personId);
    // defaultLineupPair seeds "H-p1".."H-p11" as home's starting XI.
    expect(homeIds.length).toBe(CRICKET_LINEUPS.home.slots.length);
    expect(homeIds).toContain("H-p1");
  });

  it("a module's own PRIVATE `state.squads` shape (not the kernel SquadState) is rejected, not misread", () => {
    // Mirrors football's own FootballSquad shape at the same field name
    // (onPitch/bench/... — no `members` array) — isSquadState must say no.
    const fakeState = { squads: { home: { onPitch: ["x"] }, away: { onPitch: ["y"] } } };
    expect(isSquadState(fakeState.squads)).toBe(false);
    const squads = resolveSquads(fakeState, CRICKET_LINEUPS);
    // Degrades to the team sheet rather than reading the private shape as if
    // it were a SquadState (which would crash/misbehave downstream).
    const homeIds = candidatesForPerson({ kind: "person", path: "striker" }, squads)
      .filter((c) => c.side === "home")
      .map((c) => c.personId);
    expect(homeIds).toContain("H-p1");
  });

  it("no roster at all (empty lineups) -> side chips still render, person chips render nothing, no crash", () => {
    const emptyLineups: LineupPair = {
      home: { entrantId: "H", slots: [] },
      away: { entrantId: "A", slots: [] },
    };
    const attribution: PadActionView["attribution"] = [
      { kind: "side", path: "wonBy" },
      { kind: "person", path: "striker" },
    ];
    const island = renderIsland(AttributionPicker, {
      action: { attribution, labelKey: { key: "pad.cricket.action.toss", label: "Toss" } },
      values: {},
      setValue: noop,
      lineups: emptyLineups,
      state: undefined,
    });
    const tree = island.tree();
    const sideGroup = byPath(tree, "wonBy");
    expect(chipsOf(sideGroup).length).toBe(2); // Home / Away always available
    const personGroup = byPath(tree, "striker");
    expect(chipsOf(personGroup).length).toBe(0);
    expect(textOf(personGroup).length).toBeGreaterThan(0); // a hint, not silence
  });

  it("a coach is never offered as a candidate, even though they are on the team sheet", () => {
    const catalogLineup = lineupFromCatalog(cricket.positions, "H");
    const withCoach: LineupPair = {
      home: {
        entrantId: "H",
        slots: [...catalogLineup.slots, { personId: "H-coach", slot: "starting", orderNo: 99, role: "coach" }],
      },
      away: defaultLineupPair(cricket.positions).away,
    };
    const squads = resolveSquads(undefined, withCoach);
    const ids = candidatesForPerson({ kind: "person", path: "striker" }, squads).map((c) => c.personId);
    expect(ids).not.toContain("H-coach");
  });
});

describe("attribution-picker — side items resolve to the REAL entrant id, never the literal 'home'/'away' string", () => {
  it("selecting Home stores lineups.home.entrantId, matching what sideOf()/EntrantId schemas expect", () => {
    const CRICKET_LINEUPS: LineupPair = defaultLineupPair(cricket.positions);
    let lastSet: [string, unknown] | null = null;
    const island = renderIsland(AttributionPicker, {
      action: {
        attribution: [{ kind: "side", path: "wonBy" }],
        labelKey: { key: "pad.cricket.action.toss", label: "Toss" },
      },
      values: {},
      setValue: (path: string, value: unknown) => (lastSet = [path, value]),
      lineups: CRICKET_LINEUPS,
      state: undefined,
    });
    const group = byPath(island.tree(), "wonBy");
    const chips = chipsOf(group);
    const homeChip = find(chips, (c) => propsOf(c)["data-value"] === CRICKET_LINEUPS.home.entrantId);
    (propsOf(homeChip).onClick as () => void)();
    expect(lastSet).toEqual(["wonBy", CRICKET_LINEUPS.home.entrantId]);
    expect(lastSet?.[1]).not.toBe("home"); // the literal string is NOT a valid EntrantId value here
  });
});

describe("attribution-picker — optional items: re-tapping a selected chip clears it", () => {
  it("selecting then re-selecting the same chip calls setValue with undefined", () => {
    const CRICKET_LINEUPS: LineupPair = defaultLineupPair(cricket.positions);
    const calls: unknown[] = [];
    function Wrapper() {
      // A tiny controlled wrapper so the SECOND click sees the value the
      // FIRST click produced — AttributionPicker itself is stateless.
      return null;
    }
    void Wrapper;
    let value: unknown;
    function setValue(_path: string, v: unknown) {
      value = v;
      calls.push(v);
    }
    const island = renderIsland(AttributionPicker, {
      action: {
        attribution: [{ kind: "person", path: "striker" }],
        labelKey: { key: "pad.cricket.action.ball", label: "Ball" },
      },
      values: {},
      setValue,
      lineups: CRICKET_LINEUPS,
      state: undefined,
    });
    const group = byPath(island.tree(), "striker");
    const chip = chipsOf(group)[0]!;
    (propsOf(chip).onClick as () => void)();
    expect(calls[0]).toBe("H-p1");
    // Re-render with the now-selected value so the SAME chip reads as pressed.
    island.rerender({
      action: {
        attribution: [{ kind: "person", path: "striker" }],
        labelKey: { key: "pad.cricket.action.ball", label: "Ball" },
      },
      values: { striker: value as string },
      setValue,
      lineups: CRICKET_LINEUPS,
      state: undefined,
    });
    const chip2 = chipsOf(byPath(island.tree(), "striker"))[0]!;
    expect(propsOf(chip2)["aria-pressed"]).toBe(true);
    (propsOf(chip2).onClick as () => void)();
    expect(calls[1]).toBeUndefined();
  });
});

describe("attribution-picker — end to end through the REAL renderAttribution seam: closes action-form.tsx's documented gap", () => {
  it("cricket's toss (wonBy REQUIRED by the zod schema) builds a payload that PARSES against cricket.eventSchemas['cricket.toss']", () => {
    const CRICKET_LINEUPS: LineupPair = defaultLineupPair(cricket.positions);
    const tossAction: PadActionView = {
      type: "cricket.toss",
      labelKey: { key: "pad.cricket.action.toss", label: "Toss" },
      fields: [{ kind: "enum", path: "elected", values: ["bat", "bowl"] }],
      attribution: [{ kind: "side", path: "wonBy" }],
      availability: AVAILABLE,
    };
    let submitted: Record<string, unknown> | null = null;
    const island = renderIsland(ActionForm, {
      action: tossAction,
      onSubmit: (p: Record<string, unknown>) => (submitted = p),
      renderAttribution: (
        action: PadActionView,
        values: ActionValues,
        setValue: (path: string, value: PadFieldValue | undefined) => void,
      ) =>
        AttributionPicker({
          action,
          values,
          setValue,
          lineups: CRICKET_LINEUPS,
          state: undefined,
        }),
    });

    // Expand the tile.
    (propsOf(find(island.tree(), isType("button"))).onClick as () => void)();
    let tree = island.tree();

    // Pick the required FIELD.
    const select = find(tree, isType("select"));
    (propsOf(select).onChange as (e: unknown) => void)({ target: { value: "bat" } });

    // Pick the attribution: Home won the toss.
    tree = island.tree();
    const sideGroup = byPath(tree, "wonBy");
    const homeChip = find(chipsOf(sideGroup), (c) => propsOf(c)["data-value"] === CRICKET_LINEUPS.home.entrantId);
    (propsOf(homeChip).onClick as () => void)();

    // Confirm.
    tree = island.tree();
    const confirmBtn = find(findAll(tree, isType("button")), (b) => propsOf(b)["data-role"] === "confirm");
    expect(propsOf(confirmBtn).disabled).toBe(false); // elected is set; attribution never blocks confirm
    (propsOf(confirmBtn).onClick as () => void)();

    expect(submitted).not.toBeNull();
    const schema = cricket.eventSchemas!["cricket.toss"]!;
    const result = schema.safeParse(submitted);
    expect(result.success, result.success ? "" : JSON.stringify((result as { error?: unknown }).error)).toBe(true);
    expect((submitted as unknown as { wonBy: string }).wonBy).toBe(CRICKET_LINEUPS.home.entrantId);
  });
});

describe("attributionItemCaption — labelled items use padLabel; unlabelled items fall back to a positional caption", () => {
  it("uses the engine's own labelKey when present — routed through padLabel, which calls msg() for a REGISTERED key", () => {
    const item: PadActionView["attribution"][number] = {
      kind: "person",
      path: "wicket.fielderAssist",
      labelKey: { key: "pad.cricket.action.wicket.field.fielderAssist", label: "Assisting fielder" },
    };
    // "pad.cricket.action.wicket.field.fielderAssist" is one of S7/#427's
    // registered PAD_LABEL_KEYS, so padLabel() must call msg(key) — never
    // fall back to the engine's baked English — proven by a stub that
    // returns a DIFFERENT, recognizable string only for that exact key.
    const caption = attributionItemCaption(
      item,
      0,
      ((k: string) => (k === "pad.cricket.action.wicket.field.fielderAssist" ? "TRANSLATED" : `UNEXPECTED:${k}`)) as never,
    );
    expect(caption).toBe("TRANSLATED");
  });

  // SUPERSEDED by S12/#421, deliberately rewritten rather than deleted. This
  // used to pin the ordinal fallback ("Person #3"). Measured in a real
  // browser, that fallback captioned football's two goal pickers "Goal —
  // Person #2" and "Goal — Person #3", so a scorer could not tell which one
  // credited the goal and which the assist. A PERSON item's path is a real
  // name (`scorer`, `assist`, `wicket.fielder`), so it is humanised the same
  // way S10/#419 already humanises uncaptioned FIELDS — in the renderer, not
  // by minting engine label keys in four locales.
  it("humanises a person item's own path when there is no labelKey", () => {
    const item: PadActionView["attribution"][number] = { kind: "person", path: "striker" };
    const caption = attributionItemCaption(item, 2, ((k: string) => k) as never);
    expect(caption).toBe("Striker");
  });

  it("humanises a dotted person path too, and prefixes the action label when given", () => {
    const item: PadActionView["attribution"][number] = { kind: "person", path: "wicket.fielder" };
    expect(attributionItemCaption(item, 1, ((k: string) => k) as never)).toBe("Wicket fielder");
    expect(attributionItemCaption(item, 1, ((k: string) => k) as never, "Ball")).toBe("Ball — Wicket fielder");
  });

  // SIDE items keep the ordinal fallback on purpose: their path is normally
  // `by`, and "Goal — By" reads worse than "Goal — Side".
  it("a side item still falls back to the kind+index caption", () => {
    const item: PadActionView["attribution"][number] = { kind: "side", path: "by" };
    const caption = attributionItemCaption(item, 2, ((k: string) => (k === "scorepad.attribution.side" ? "Side" : k)) as never);
    expect(caption).toContain("Side");
    expect(caption).toContain("3"); // 1-based
  });
});
