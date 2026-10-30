// W2e Task 32 (B2-3; D3 (3) as amended by D15; checklist M12b) -- the "player injured, no replacement: the team plays short"
// control on the scoring pad.
//
// WHAT THIS PROVES, AND WHY IT IS BUILT THIS WAY. `core.lineup.retirement` already existed in the engine and the HTTP door;
// no pad control sent it (the catalogue's M12b `l2NoPath`). The control is an off-picker copied from the period pad's swap
// slot (`period-shared.ts`'s `buildSwap`): a `SwapSlot` that stops after the OFF pick. Three ways it could be declared and
// inert, so none of them is proved with a fixture on both ends (AGENTS.md class 1):
//   - the slot is built from the REAL skin of each sport over a view folded from the REAL module, and its payload is folded
//     back through `foldMatch` (the production consumer), reading the on-field count off the ENGINE's state;
//   - the picker is driven through the REAL `SwapSheet` and the REAL `adaptSwapSlot` (a field added to `SwapSlot` but not to
//     the hand-copied adapter is dead on the production path while both ends' unit tests stay green -- adaptSwapSlot's own doc);
//   - the tile is the one the skin's own `tiles()` returns, and it names a slot the skin's own `swap()` declares.
//
// Every expected value comes from the engine's declarations or the rulebook, never from the code under test: who is on the
// field comes from the lineup the fixture declares and from the engine's state after the fold; the reasons cricket and
// generic offer nothing are READ from their disposition rows (CK-DV-3, GN-DV-1), not typed here.
import { describe, expect, it } from "vitest";
import { foldMatch, onFieldPersons, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { allRows, makeEnvelope } from "@seazn/engine/testkit";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { adaptSwapSlot, resolveSwapSlot, squadStateOf } from "../pad-host";
import { resolvePad } from "../registry";
import { createSkinDispatch } from "../skin-dispatch";
import { SwapSheet } from "../swap-sheet";
import { RETIREMENT_BAND, RETIREMENT_REASON, RETIREMENT_TYPE, buildRetirement, retireSlotId } from "../retirement-slot";
import { hockeyPadRules } from "@seazn/engine/pad";
import type { FidelityBand } from "@seazn/engine/sport";
import type { PadHostView, SkinDefV3, SwapSlot, TileSpec } from "../types";
import { lineupsFor, periodCfg } from "./_period-fold";

const t = (key: string): string => key;
const SIDES = ["home", "away"] as const;
type Side = (typeof SIDES)[number];

/** The four sports the owner named (spec 6.2: "only where it changes something"). The sweep below proves nothing outside
 *  this set offers the control, and the engine-side declaration that makes the four different (a lineup policy and a squad
 *  that plays short) is asserted, so a fifth team sport is a red here rather than a silent omission. */
const OFFERING = ["football", "volleyball", "hockey", "icehockey"] as const;
/** The two sports the owner gave disposition rows instead (spec 6.2, checklist 18). */
const DISPOSITIONS = [
  { key: "cricket", id: "CK-DV-3", file: "cricket.md" },
  { key: "generic", id: "GN-DV-1", file: "generic.md" },
] as const;

function moduleOf(key: string): AnySportModule {
  const found = builtinModules.find((m) => m.key === key);
  if (!found) throw new Error(`no sport "${key}" in the registry`);
  return found as AnySportModule;
}

/** A view folded from the real module, the way the host builds it: `squads` is `squadStateOf(state, lineups)`, so a sport
 *  whose fold keeps a private squad shape (football) reads the frozen kickoff sheet here exactly as it does in production. */
type Spec = { type: string; payload?: unknown; voids?: string };

/** STRICT, as the write path folds a scorer's new event (`strictFromSeq: 0`): a refusal throws here instead of being
 *  dropped the way replay drops it, so a control whose event the engine would refuse cannot pass as one that worked. */
const STRICT = { strictFromSeq: 0 } as const;

function viewOf(
  key: string,
  specs: readonly Spec[] = [{ type: "core.start" }],
  o: { band?: FidelityBand; cfg?: Record<string, unknown>; lineups?: (declared: LineupPair) => LineupPair } = {},
): { view: PadHostView; module: AnySportModule; lineups: LineupPair; events: EventEnvelope[]; state: Record<string, unknown> } {
  const sportModule = moduleOf(key);
  const cfg = periodCfg(sportModule, o.cfg ?? {});
  const declared = lineupsFor(sportModule, cfg);
  const lineups = o.lineups === undefined ? declared : o.lineups(declared);
  // Envelope ids are `e-<seq>` with seq counting from 1 in `specs`, so a void names its target as `e-<index + 1>`.
  const events = specs.map((s, i) => makeEnvelope(i + 1, { type: s.type, payload: s.payload ?? {} } as never, s.voids));
  const state = foldMatch(sportModule as never, cfg as never, lineups, events, STRICT) as Record<string, unknown>;
  const view: PadHostView = {
    cfg,
    state,
    summary: sportModule.summary(state as never),
    phase: "live",
    band: o.band ?? 3,
    entitlements: {},
    personNames: {},
    squads: squadStateOf(state, lineups),
    events,
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
  };
  return { view, module: sportModule, lineups, events, state };
}

/** Who the ENGINE says is on the field for `side`: football keeps its own `{onPitch}` projection, every other adopter the
 *  kernel's `SquadState`. Read off the folded state, never off a skin. */
function engineOnField(state: Record<string, unknown>, lineups: LineupPair, side: Side): readonly string[] {
  const squads = (state as { squads?: Record<string, unknown> }).squads;
  const own = squads?.[side] as { onPitch?: readonly string[] } | undefined;
  if (own && Array.isArray(own.onPitch)) return own.onPitch;
  return onFieldPersons(squadStateOf(state, lineups)[side]);
}

/** The kickoff XI the fixture declares: the lineup, not the pad. */
function declaredStarters(lineups: LineupPair, side: Side): string[] {
  return lineups[side].slots.filter((s) => s.slot === "starting").map((s) => s.personId);
}

function skinOf(key: string): SkinDefV3<PadHostView> {
  return resolvePad(key, t) as SkinDefV3<PadHostView>;
}

function retireSlots(view: PadHostView, key: string): SwapSlot[] {
  return (skinOf(key).swap?.(view) ?? []).filter((s) => s.eventType === RETIREMENT_TYPE);
}
function retireTiles(view: PadHostView, key: string): TileSpec[] {
  return skinOf(key).tiles(view).filter((tile) => "swap" in tile.action && tile.action.swap.startsWith("retire-"));
}

/** Append `event` as the next envelope and fold it through the REAL module. */
function applyRetirement(
  key: string,
  base: ReturnType<typeof viewOf>,
  event: Spec,
): ReturnType<typeof viewOf> {
  const specs: Spec[] = [...base.events.map((e) => ({ type: e.type, payload: e.payload, ...(e.voids === undefined ? {} : { voids: e.voids }) })), event];
  return viewOf(key, specs);
}

describe("M12b the four sports offer the control and its payload folds through the real engine", () => {
  it("anti-vacuity: the four sports are in the registry and each declares a lineup policy (a squad that can play short)", () => {
    expect(OFFERING).toHaveLength(4);
    for (const key of OFFERING) {
      const m = moduleOf(key);
      expect(typeof m.lineupPolicy, `${key} declares a lineup policy`).toBe("function");
    }
  });

  it("sweep: every sport x side offers a retirement slot for exactly the people the fixture put on the field", () => {
    let checked = 0;
    for (const key of OFFERING) {
      const { view, lineups } = viewOf(key);
      const slots = retireSlots(view, key);
      expect(slots.map((s) => s.id).sort(), `${key} declares one retirement slot per side`).toEqual(
        SIDES.map((s) => retireSlotId(s)).sort(),
      );
      for (const side of SIDES) {
        const slot = slots.find((s) => s.id === retireSlotId(side))!;
        expect(slot.side).toBe(side);
        expect(slot.eventType, `${key}: the static event type is the one buildEvent returns`).toBe(RETIREMENT_TYPE);
        expect(slot.offOnly, `${key}: the picker stops after the OFF pick`).toBe(true);
        expect(slot.policyOk).toBe(true);
        expect([...(slot.offCandidates ?? [])].sort(), `${key} ${side}: who may leave is who the lineup put on the field`).toEqual(
          declaredStarters(lineups, side).sort(),
        );
        expect(slot.offCandidates!.length, `${key} ${side} has an XI/six/pair to choose from`).toBeGreaterThan(1);
        checked += 1;
      }
    }
    expect(checked, "4 sports x 2 sides were checked").toBe(OFFERING.length * SIDES.length);
  });

  it("the payload folds through the REAL engine: the retired person leaves the field, the squad plays one short, the other side is untouched", () => {
    let checked = 0;
    for (const key of OFFERING) {
      for (const side of SIDES) {
        const base = viewOf(key);
        const other = side === "home" ? "away" : "home";
        const before = engineOnField(base.state, base.lineups, side);
        const otherBefore = engineOnField(base.state, base.lineups, other);
        const slot = retireSlots(base.view, key).find((s) => s.id === retireSlotId(side))!;
        const leaving = slot.offCandidates![0]!;
        const event = slot.buildEvent(leaving, "");

        expect(event.type).toBe(RETIREMENT_TYPE);
        // The payload is what the engine's schema takes (a strict object: any extra key would be refused at the door), the
        // entrant is the lineup's own, and the reason is the pad's one word for "hurt, not replaced".
        expect(event.payload).toEqual({ side: base.lineups[side].entrantId, personId: leaving, reason: RETIREMENT_REASON });
        expect(RETIREMENT_REASON).toBe("injured");

        const after = applyRetirement(key, base, event);
        const onFieldAfter = engineOnField(after.state, after.lineups, side);
        expect(onFieldAfter.length, `${key} ${side}: one fewer on the field`).toBe(before.length - 1);
        expect(onFieldAfter, `${key} ${side}: the retired person is off`).not.toContain(leaving);
        expect(engineOnField(after.state, after.lineups, other), `${key}: the other side is untouched`).toEqual(otherBefore);
        checked += 1;
      }
    }
    expect(checked).toBe(OFFERING.length * SIDES.length);
  });

  it("a second call after a retirement: the person who left is not offered again and the slot shrinks by one", () => {
    let checked = 0;
    for (const key of OFFERING) {
      const base = viewOf(key);
      const slot = retireSlots(base.view, key).find((s) => s.id === retireSlotId("home"))!;
      const leaving = slot.offCandidates![0]!;
      const after = applyRetirement(key, base, slot.buildEvent(leaving, ""));
      const next = retireSlots(after.view, key).find((s) => s.id === retireSlotId("home"));
      expect(next, `${key}: still offered while others are on`).toBeDefined();
      expect(next!.offCandidates, `${key}: the retired person is gone from the picker`).not.toContain(leaving);
      expect(next!.offCandidates!.length).toBe(slot.offCandidates!.length - 1);
      // The away side is untouched by home's retirement.
      expect(retireSlots(after.view, key).find((s) => s.id === retireSlotId("away"))!.offCandidates!.length).toBe(
        slot.offCandidates!.length,
      );
      checked += 1;
    }
    expect(checked).toBe(OFFERING.length);
  });

  it("the empty case: with nobody left on the field the slot and its tile are gone, not an empty picker", () => {
    let checked = 0;
    for (const key of OFFERING) {
      let cur = viewOf(key);
      let guard = 0;
      for (;;) {
        const slot = retireSlots(cur.view, key).find((s) => s.id === retireSlotId("home"));
        if (!slot) break;
        expect(retireTiles(cur.view, key).some((tile) => tile.id === retireSlotId("home")), `${key}: tile and slot agree`).toBe(true);
        cur = applyRetirement(key, cur, slot.buildEvent(slot.offCandidates![0]!, ""));
        guard += 1;
        expect(guard, `${key}: the loop must terminate`).toBeLessThan(40);
      }
      expect(engineOnField(cur.state, cur.lineups, "home"), `${key}: nobody is left on the field`).toEqual([]);
      expect(retireTiles(cur.view, key).some((tile) => tile.id === retireSlotId("home")), `${key}: no tile for an empty side`).toBe(false);
      // The other side still has its own control.
      expect(retireSlots(cur.view, key).some((s) => s.id === retireSlotId("away"))).toBe(true);
      // ...and, being alone, its tile takes the whole row (T33a): a lone span-2 tile would leave the row half empty and shift every
      // tile after it by two columns. Both sides on the field is the pair of half tiles (the "one control, two halves" test below).
      const lone = retireTiles(cur.view, key);
      expect(lone.map((tile) => tile.id), `${key}: only the away tile is left`).toEqual([retireSlotId("away")]);
      expect(lone[0]!.span, `${key}: a lone retirement tile is a full row`).toBe(4);
      expect(guard, `${key}: the whole XI was retired one by one`).toBeGreaterThan(1);
      checked += 1;
    }
    expect(checked).toBe(OFFERING.length);
  });

  it("a fixture with no team sheet has nobody to retire: no slot, no tile (a rosterless division is ordinary)", () => {
    // single-sport exemption, one line: football's pad reads its own folded `onPitch`, whose empty case is the all-retired
    // test above; the three kernel sports read `view.squads`, which a rosterless fixture leaves with no members.
    let checked = 0;
    for (const key of OFFERING.filter((k) => k !== "football")) {
      const base = viewOf(key);
      const bare: PadHostView = {
        ...base.view,
        squads: { home: { ...base.view.squads.home, members: [] }, away: { ...base.view.squads.away, members: [] } },
      };
      expect(retireSlots(bare, key), `${key}: nothing to offer`).toEqual([]);
      expect(retireTiles(bare, key), `${key}: no tile for nobody`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

describe("M12b retire, then void: the person comes back (every sport, strict fold)", () => {
  it("a void of the retirement puts the person back on the field and back in the picker; a second retirement takes them off again", () => {
    let checked = 0;
    for (const key of OFFERING) {
      for (const side of SIDES) {
        const base = viewOf(key);
        const before = engineOnField(base.state, base.lineups, side);
        const slot = retireSlots(base.view, key).find((s) => s.id === retireSlotId(side))!;
        const leaving = slot.offCandidates![0]!;
        const retired = applyRetirement(key, base, slot.buildEvent(leaving, ""));
        expect(engineOnField(retired.state, retired.lineups, side), `${key} ${side}: off after the retirement`).not.toContain(leaving);
        // The retirement is the last envelope; its id is `e-<seq>` and seq is its 1-based position.
        const voided = applyRetirement(key, retired, { type: "core.void", payload: {}, voids: `e-${retired.events.length}` });
        expect([...engineOnField(voided.state, voided.lineups, side)].sort(), `${key} ${side}: the void restores the field`).toEqual(
          [...before].sort(),
        );
        const again = retireSlots(voided.view, key).find((s) => s.id === retireSlotId(side))!;
        expect(again.offCandidates, `${key} ${side}: offered again after the void`).toContain(leaving);
        const twice = applyRetirement(key, voided, again.buildEvent(leaving, ""));
        expect(engineOnField(twice.state, twice.lineups, side), `${key} ${side}: a second retirement folds`).not.toContain(leaving);
        expect(engineOnField(twice.state, twice.lineups, side)).toHaveLength(before.length - 1);
        checked += 1;
      }
    }
    expect(checked).toBe(OFFERING.length * SIDES.length);
  });
});

describe("M12b a substitute who came on through the pad's own Sub can then retire injured (PO decision I-1)", () => {
  /** The pad's ordinary substitution slot for `side` (not the retirement, not volleyball's libero exchange). */
  function subSlotOf(view: PadHostView, key: string, side: Side): SwapSlot | undefined {
    return (skinOf(key).swap?.(view) ?? []).find(
      (s) => s.side === side && s.eventType !== RETIREMENT_TYPE && s.eventType !== "core.lineup.replacement",
    );
  }

  it("Sub on, then Injured (no sub) for that substitute: the strict fold accepts it and he leaves the field", () => {
    // Volleyball's pad has no ordinary Sub (only the libero exchange, when a libero is named), so it is not in this sweep;
    // its retirement is covered by every other block in this file.
    const subbing = OFFERING.filter((k) => k !== "volleyball");
    let checked = 0;
    for (const key of subbing) {
      const base = viewOf(key);
      const sub = subSlotOf(base.view, key, "home");
      expect(sub, `${key}: the pad offers a Sub`).toBeDefined();
      const off = sub!.offCandidates![0]!;
      const on = (sub!.candidates ?? [])[0]!;
      expect(on, `${key}: there is someone on the bench`).toBeDefined();
      const subbed = applyRetirement(key, base, sub!.buildEvent(off, on));
      expect(engineOnField(subbed.state, subbed.lineups, "home"), `${key}: the substitute is on`).toContain(on);

      const slot = retireSlots(subbed.view, key).find((s) => s.id === retireSlotId("home"))!;
      expect(slot.offCandidates, `${key}: the substitute is offered`).toContain(on);
      expect(slot.offCandidates, `${key}: the player he replaced is not`).not.toContain(off);
      const retired = applyRetirement(key, subbed, slot.buildEvent(on, ""));
      const field = engineOnField(retired.state, retired.lineups, "home");
      expect(field, `${key}: the substitute left`).not.toContain(on);
      expect(field, `${key}: the player he replaced did not come back`).not.toContain(off);
      expect(field, `${key}: the side plays one short`).toHaveLength(declaredStarters(base.lineups, "home").length - 1);

      // And a void of the retirement brings the substitute back, not the starter.
      const voided = applyRetirement(key, retired, { type: "core.void", payload: {}, voids: `e-${retired.events.length}` });
      expect(engineOnField(voided.state, voided.lineups, "home"), `${key}: void restores the substitute`).toContain(on);
      expect(engineOnField(voided.state, voided.lineups, "home")).not.toContain(off);
      checked += 1;
    }
    expect(checked).toBe(subbing.length);
    expect(subbing).toContain("football");
  });

  it("a pad whose Sub sends the sport's OWN event (not core.lineup.*) is exactly a sport that tells the engine its pitch", () => {
    // The engine judges core.lineup.* against its own squads unless the module hands it the pitch (`squadsForLineup`). A pad
    // substituting with a module event (football.sub) moves a pitch the kernel never folds, so it needs the hook; one
    // substituting with core.lineup.* moves the kernel's squads directly and must not need it.
    let checked = 0;
    for (const key of OFFERING) {
      const { view } = viewOf(key);
      const subTypes = SIDES.flatMap((side) => {
        const slot = subSlotOf(view, key, side);
        return slot === undefined ? [] : [slot.eventType];
      });
      const ownEvent = subTypes.some((type) => !type.startsWith("core.lineup."));
      const declares = typeof (moduleOf(key) as { squadsForLineup?: unknown }).squadsForLineup === "function";
      expect(declares, `${key}: Sub sends ${subTypes.join(", ") || "nothing"}`).toBe(ownEvent);
      checked += 1;
    }
    expect(checked).toBe(OFFERING.length);
    expect(typeof (moduleOf("football") as { squadsForLineup?: unknown }).squadsForLineup).toBe("function");
  });
});

describe("M12b a coach or staff member on the team sheet is never offered (review M6)", () => {
  // The lineup editor lets any row be a coach and any row be "starting" (`lineup-editor.tsx`), and `initSquads` seats a
  // starting slot whatever its role, so a coach can sit in `view.squads` with `onField: true`. The engine never lets a
  // non-player leave or take the field (`takeOff` / `bringOn`: "not-a-player", ruling 3), so offering one is a dead tap.
  const withOfficials = (declared: LineupPair): LineupPair => ({
    home: {
      ...declared.home,
      slots: [
        ...declared.home.slots,
        { personId: "H-coach", slot: "starting", orderNo: 90, role: "coach" },
        { personId: "H-staff", slot: "bench", orderNo: 91, role: "staff" },
      ],
    },
    away: declared.away,
  });

  it("the engine refuses a coach's retirement (the reason the pad must not offer one)", () => {
    const base = viewOf("hockey", undefined, { lineups: withOfficials });
    expect(() =>
      applyRetirement("hockey", base, { type: RETIREMENT_TYPE, payload: { side: base.lineups.home.entrantId, personId: "H-coach", reason: RETIREMENT_REASON } }),
    ).toThrow(/coach/);
  });

  it("no retirement picker and no Sub picker offers a non-player, in any of the four sports", () => {
    let checked = 0;
    for (const key of OFFERING) {
      const { view } = viewOf(key, undefined, { lineups: withOfficials });
      // anti-vacuity: the coach IS seated by the kickoff sheet, so the filter is what keeps him out
      if (key !== "football") expect(view.squads.home.members.find((m) => m.personId === "H-coach")?.onField, `${key}: seated`).toBe(true);
      for (const slot of (skinOf(key).swap?.(view) ?? []).filter((s) => s.side === "home")) {
        expect(slot.offCandidates ?? [], `${key} ${slot.id}: off`).not.toContain("H-coach");
        expect(slot.candidates, `${key} ${slot.id}: on`).not.toContain("H-staff");
        expect(slot.candidates, `${key} ${slot.id}: on`).not.toContain("H-coach");
        checked += 1;
      }
    }
    expect(checked, "every sport's home slots were checked").toBeGreaterThanOrEqual(OFFERING.length);
  });
});

describe("M12b the control is gated like the swap slot: the band and the play phase", () => {
  it("the band is the swap slot's own: the band the engine gives a substitution event, and the period record's swapBand", () => {
    // RETIREMENT_BAND READS hockeyPadRules.swapBand, so comparing the two alone is a tautology. The independent fact is the band the
    // football module's own padSpec declares for its substitution, which the retirement control (a person off) is gated like.
    const football = moduleOf("football");
    const subBand = football.padSpec?.(football.configSchema.parse({})).fidelity?.["football.sub"];
    expect(subBand, "football declares a band for football.sub").toBeDefined();
    expect(RETIREMENT_BAND).toBe(subBand);
    expect(RETIREMENT_BAND).toBe(hockeyPadRules.swapBand);
  });

  it("below the band: no slot and no tile; at and above it: both, for every sport", () => {
    let checked = 0;
    for (const key of OFFERING) {
      for (const band of [0, 1, 2, 3] as const) {
        const { view } = viewOf(key, undefined, { band });
        const offered = band >= hockeyPadRules.swapBand;
        expect(retireSlots(view, key).length > 0, `${key} band ${band}: slot`).toBe(offered);
        expect(retireTiles(view, key).length > 0, `${key} band ${band}: tile`).toBe(offered);
        checked += 1;
      }
    }
    expect(checked).toBe(OFFERING.length * 4);
  });

  it("outside play (before the start, after the match is abandoned): no slot and no tile", () => {
    let checked = 0;
    for (const key of OFFERING) {
      const pre = viewOf(key, []);
      expect(retireSlots(pre.view, key), `${key}: before the start`).toEqual([]);
      expect(retireTiles(pre.view, key), `${key}: before the start`).toEqual([]);
      const over = viewOf(key, [{ type: "core.start" }, { type: "core.abandon", payload: { reason: "floodlight failure" } }]);
      expect(retireSlots(over.view, key), `${key}: abandoned`).toEqual([]);
      expect(retireTiles(over.view, key), `${key}: abandoned`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(OFFERING.length);
  });
});

describe("M12b the tile and the slot: one control, two declared halves", () => {
  it("each sport's tile per side is a minor swap tile naming a slot its own swap() declares", () => {
    let checked = 0;
    for (const key of OFFERING) {
      const { view } = viewOf(key);
      const tiles = retireTiles(view, key);
      const slots = skinOf(key).swap?.(view) ?? [];
      expect(tiles.map((x) => x.id).sort()).toEqual(SIDES.map((s) => retireSlotId(s)).sort());
      for (const tile of tiles) {
        const action = tile.action as { swap: string };
        expect(resolveSwapSlot(action.swap, slots), `${key}: ${tile.id} names a declared slot`).not.toBeNull();
        expect(tile.kind).toBe("minor");
        expect(tile.span, `${key}: with both sides on the field the two tiles pair in one row`).toBe(2);
        expect(tile.phases).toEqual(["live"]);
        expect(tile.sublabel, `${key}: the tile says whose player`).toBe(`scorepad.attribution.${tile.id === "retire-home" ? "home" : "away"}`);
        checked += 1;
      }
    }
    expect(checked).toBe(OFFERING.length * SIDES.length);
  });

  it("ids are unique within each skin: the retirement ids collide with no sub / libero / tile id", () => {
    for (const key of OFFERING) {
      const { view } = viewOf(key);
      const ids = skinOf(key).tiles(view).map((x) => x.id);
      expect(new Set(ids).size, `${key}: tile ids are unique`).toBe(ids.length);
      const slotIds = (skinOf(key).swap?.(view) ?? []).map((s) => s.id);
      expect(new Set(slotIds).size, `${key}: slot ids are unique`).toBe(slotIds.length);
    }
  });
});

describe("M12b the seam is driven through its real producer and consumer, not a fixture", () => {
  it("adaptSwapSlot carries offOnly across (it copies by hand), and a swap slot without it stays two-step", () => {
    for (const key of OFFERING) {
      const { view } = viewOf(key);
      const slot = retireSlots(view, key)[0]!;
      expect(adaptSwapSlot(slot, view.squads).spec.offOnly, `${key}: the sheet is told to stop after the OFF pick`).toBe(true);
      expect(adaptSwapSlot({ ...slot, offOnly: undefined }, view.squads).spec.offOnly).toBeUndefined();
    }
  });

  it("tapping a person on the real SwapSheet completes the retirement at once; the same sheet without offOnly asks who comes ON", () => {
    let checked = 0;
    for (const key of OFFERING) {
      const base = viewOf(key);
      const slot = retireSlots(base.view, key).find((s) => s.id === retireSlotId("home"))!;
      const adapted = adaptSwapSlot(slot, base.view.squads);
      const picks: [string, string][] = [];
      const names = Object.fromEntries(slot.offCandidates!.map((id) => [id, `Player ${id}`]));
      const island = renderIsland(SwapSheet, {
        spec: adapted.spec,
        view: adapted.view,
        policyVerdict: adapted.policyVerdict,
        personNames: names,
        t,
        onSwap: (off: string, on: string) => picks.push([off, on]),
      });
      const buttons = walk(island.tree()).filter((el) => el.type === "button");
      // The first candidate button (the last button is Cancel).
      // (a row carries its shirt number / position decoration beside the name, so match on containing the name)
      const buttonFor = (els: typeof buttons, id: string) => els.find((b) => textOf(b).includes(`Player ${id}`))!;
      const first = buttonFor(buttons, slot.offCandidates![0]!);
      expect(first, `${key}: the on-field person is a button`).toBeDefined();
      (propsOf(first).onClick as () => void)();
      expect(picks, `${key}: one tap completes it`).toHaveLength(1);
      const [off, on] = picks[0]!;
      expect(off).toBe(slot.offCandidates![0]!);
      // The producer's event, folded through the consumer.
      const after = applyRetirement(key, base, slot.buildEvent(off, on));
      expect(engineOnField(after.state, after.lineups, "home")).not.toContain(off);

      // The contrast, so the one-tap result above cannot be a property of the harness: the SAME slot adapted WITHOUT its
      // offOnly flag is the ordinary two-step sheet -- the first tap completes nothing and asks who comes on.
      const twoStep = adaptSwapSlot({ ...slot, offOnly: undefined }, base.view.squads);
      const stepped: [string, string][] = [];
      const island2 = renderIsland(SwapSheet, {
        spec: twoStep.spec,
        view: twoStep.view,
        policyVerdict: twoStep.policyVerdict,
        personNames: names,
        t,
        onSwap: (a: string, b: string) => stepped.push([a, b]),
      });
      const firstOf2 = buttonFor(walk(island2.tree()).filter((el) => el.type === "button"), slot.offCandidates![0]!);
      (propsOf(firstOf2).onClick as () => void)();
      expect(stepped, `${key}: without offOnly the first tap only picks who goes OFF`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(OFFERING.length);
  });

  it("the skin dispatch gate admits the retirement for a sport whose spec does not declare it (kernel events are dispatchable)", async () => {
    const sent: string[] = [];
    const dispatch = createSkinDispatch({ panels: [] } as never, async (type) => {
      sent.push(type);
    });
    await dispatch(RETIREMENT_TYPE, {});
    expect(sent).toEqual([RETIREMENT_TYPE]);
  });

  it("buildRetirement ignores the ON argument: an off-only slot's buildEvent(off, '') equals buildEvent(off, 'x')", () => {
    const { view } = viewOf("hockey");
    const slot = retireSlots(view, "hockey")[0]!;
    const off = slot.offCandidates![0]!;
    expect(slot.buildEvent(off, "")).toEqual(slot.buildEvent(off, "someone-else"));
  });

  it("buildRetirement refuses a person who is not on the field (a stray id never becomes an event)", () => {
    const { view } = viewOf("hockey");
    const slot = buildRetirement(view, "home", { inPlay: true, by: "H" })!;
    expect(slot).not.toBeNull();
    expect(() => slot.buildEvent("not-on-the-field", "")).toThrow(/on the field/);
  });
});

/** Read one row of an engine rules table: `| id | rule | citation | status | enforced at | proved by |`. Through the testkit's own parser
 *  (`allRows()`, the rules the installed package ships), not a path into the engine's tree. */
function ruleRow(file: string, id: string): { rule: string; status: string } {
  const row = allRows().find((r) => r.file === file && r.id === id);
  if (!row) throw new Error(`no ${id} row in ${file}`);
  return { rule: row.rule, status: row.status };
}

describe("M12b cricket and generic offer none", () => {
  it("the reason is the disposition row's, read from the rulebook, and it names the retirement", () => {
    for (const d of DISPOSITIONS) {
      const row = ruleRow(d.file, d.id);
      expect(row.rule, `${d.id} is about the lineup retirement`).toMatch(/retirement/i);
      expect(row.status, `${d.id} is a W2e disposition, signed or deviation`).toMatch(/^(deviation|signed) 223 /);
    }
    // And what each row says is the reason (cricket: the all-out count stays; generic: no squad), so the absence is a
    // product decision on record, not an omission.
    expect(ruleRow("cricket.md", "CK-DV-3").rule).toMatch(/all-out/);
    expect(ruleRow("generic.md", "GN-DV-1").rule).toMatch(/LINEUP_NOT_SUPPORTED/);
    // the lookup is by file AND id: a real id asked of the wrong rules file is a refusal, not a row
    expect(() => ruleRow("generic.md", "CK-DV-3")).toThrow(/no CK-DV-3 row in generic\.md/);
  });

  it("cricket and generic offer no retirement slot and no retirement tile", () => {
    const cricket = viewOf("cricket");
    const generic = viewOf("generic", undefined, { cfg: { resultMode: "score", allowDraws: true } });
    for (const [key, v] of [["cricket", cricket], ["generic", generic]] as const) {
      expect(retireSlots(v.view, key), `${key}: no slot`).toEqual([]);
      expect(retireTiles(v.view, key), `${key}: no tile`).toEqual([]);
    }
  });
});

describe("M12b no other sport offers it: the control is for the team sports whose pad this wave names", () => {
  // single reason, one line: M12 applies to team-entrant sports only (the catalogue's R16 rule), and the racquet, board and
  // carrom pads have no squad to play short.
  it("the registry sweep: every other sport's skin has no retirement slot and no retirement tile", () => {
    let checked = 0;
    const rest = builtinModules.filter((m) => !(OFFERING as readonly string[]).includes(m.key) && !DISPOSITIONS.some((d) => d.key === m.key));
    for (const m of rest) {
      const parsed = m.configSchema.safeParse({});
      if (!parsed.success) continue;
      const { view } = viewOf(m.key);
      expect(retireSlots(view, m.key), `${m.key}: no slot`).toEqual([]);
      expect(retireTiles(view, m.key), `${m.key}: no tile`).toEqual([]);
      checked += 1;
    }
    expect(checked, "at least the racquet and board sports were swept").toBeGreaterThan(3);
  });
});
