// attribution-picker.tsx (S10/#419 W8, chassis item 3) — the pure attribution
// SELECTORS. R7/G demolished the v2 pad lane, and with it this file's own
// `AttributionPicker` component and the `pad-renderer.tsx` `renderAttribution`
// seam it plugged into; the component's render tests went with it (the v3
// chassis proves the same capabilities from `v3/__tests__/action-form.test.ts`
// and `v3/skins/__tests__/cricket.test.ts`). What remains here is the
// sport-agnostic RULES half, which is still live on both callers.
//
// Driven through the repo's node-only `_hook-harness` (no DOM/jsdom in this
// workspace) — see its header and reference_hook_harness_click_without_dom.md.
//
// Real engine fixtures throughout (cricket + hockey), never a hand-rolled
// SquadState: the keeper test in particular folds a REAL `core.lineup.position`
// event through the actual kernel (`foldClient`) so a snapshot-based
// implementation of "who is the keeper" genuinely reds.
import { describe, expect, it } from "vitest";
import type { LineupPair } from "@seazn/engine/core";
import { foldClient } from "../module-client";
import { defaultLineupPair, makeEnvelope, lineupFromCatalog } from "@seazn/engine/testkit";
import { cricket } from "@seazn/engine/sports/cricket";
import { hockey } from "@seazn/engine/sports/hockey";
import type { PadActionView } from "../view-model";
import {
  attributionItemCaption,
  candidatesForPerson,
  isSquadState,
} from "../attribution-picker";
// R7/G review (2026-09-01): the degrade these tests exercise moved to its one
// remaining caller. `attribution-picker.tsx` used to export `resolveSquads`,
// which was byte-for-byte `v3/pad-host.tsx`'s `squadStateOf`; the v2 copy died
// with the lane, so these assertions now drive the LIVE function rather than
// its retired twin. The rule under test is unchanged: verify `state.squads`
// structurally, else fall back to `initSquads(lineups)`.
import { squadStateOf } from "../v3/pad-host";

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

  it("squadStateOf(state, lineups) surfaces the LIVE keeper after a position change, not the kickoff one", () => {
    const state = foldedStateAfterKeeperMove();
    const squads = squadStateOf(state, HOCKEY_LINEUPS);
    const candidates = candidatesForPerson(GK_ITEM, squads);
    const homeCandidates = candidates.filter((c) => c.side === "home").map((c) => c.personId);
    expect(homeCandidates).toEqual([NEW_KEEPER]);
    expect(homeCandidates).not.toContain(ORIGINAL_KEEPER);
  });

  it("BEFORE any position change, the kickoff keeper alone is offered (proves the test fixture itself is meaningful)", () => {
    const events = [makeEnvelope(0, { type: "core.start", payload: {} })];
    const state = foldClient(hockey, HOCKEY_CFG, HOCKEY_LINEUPS, events);
    const squads = squadStateOf(state, HOCKEY_LINEUPS);
    const candidates = candidatesForPerson(GK_ITEM, squads).filter((c) => c.side === "home");
    expect(candidates.map((c) => c.personId)).toEqual([ORIGINAL_KEEPER]);
  });
});

describe("attribution-picker — squadStateOf degrades gracefully: no live squads, or a private non-adopting shape, falls back to the team sheet", () => {
  const CRICKET_LINEUPS: LineupPair = defaultLineupPair(cricket.positions);

  it("no `state.squads` at all -> falls back to initSquads(lineups), the kickoff team sheet", () => {
    const squads = squadStateOf(undefined, CRICKET_LINEUPS);
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
    const squads = squadStateOf(fakeState, CRICKET_LINEUPS);
    // Degrades to the team sheet rather than reading the private shape as if
    // it were a SquadState (which would crash/misbehave downstream).
    const homeIds = candidatesForPerson({ kind: "person", path: "striker" }, squads)
      .filter((c) => c.side === "home")
      .map((c) => c.personId);
    expect(homeIds).toContain("H-p1");
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
    const squads = squadStateOf(undefined, withCoach);
    const ids = candidatesForPerson({ kind: "person", path: "striker" }, squads).map((c) => c.personId);
    expect(ids).not.toContain("H-coach");
  });
});

// The "end to end through the REAL renderAttribution seam" describe block
// that lived here exercised the (now-deleted) universal `action-form.tsx`'s
// `ActionForm` + this file's `AttributionPicker` combo — the exact wiring
// pattern `pad-renderer.tsx` used, and the R7 lane demolition removed both.
// Equivalent coverage of the SAME cricket-toss/wonBy capability survives on
// the v3 chassis: `v3/__tests__/action-form.test.ts` ("a SIDE item always
// offers exactly Home/Away...") proves the attribution group renders from
// lineups, and `v3/skins/__tests__/cricket.test.ts` ("toss: who won ->
// elected, both required, in that order") proves the guided-sheet path
// produces the exact `{ type: "cricket.toss", payload: { wonBy, elected } }`
// event. Removed as a duplicate rather than ported, per R7's lane-demolition
// brief.

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
