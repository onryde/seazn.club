// RS006 chassis — cart reducer (pure, no DOM). Every action returns a NEW
// state (no mutation) so back-navigation + sessionStorage round-tripping
// (storage.ts) can treat CartState as a plain snapshot.
import { describe, expect, it } from "vitest";
import {
  MAX_ROSTER_PLAYERS,
  autoLinkObviousSelf,
  autoSeedSingleDivision,
  canAddEntry,
  cartHasOtherPlayers,
  cartReducer,
  clearSelfLinkWhenNotPlaying,
  lineFeeCents,
  lineMethod,
  payableDivision,
  registeringSelfAnywhere,
  reviewHeadingKey,
  submitLabelKey,
  summarizeCart,
  toGroupEntry,
} from "../cart";
import {
  EMPTY_CART,
  EMPTY_ROSTER_PLAYER,
  MAX_CART_ENTRIES,
  type CartEntry,
  type CartState,
  type DivisionLike,
  type RosterPlayerState,
} from "../types";

const TEAM_DIVISION: DivisionLike = {
  division_id: "div-team",
  name: "Open Teams",
  entrant_kind: "team",
  category: null,
  age_min: null,
  age_max: null,
  requires_dob: false,
  requires_gender: false,
  allow_free_agents: true,
  open: true,
  closed_reason: null,
  capacity: 16,
  remaining: 4,
  taken: 12,
  opens_at: null,
  closes_at: null,
  fee_cents: 1000,
  free_agent_fee_cents: null,
  currency: "gbp",
  payment_method: "offline",
  form_fields: [],
};

const INDIVIDUAL_DIVISION: DivisionLike = {
  ...TEAM_DIVISION,
  division_id: "div-indiv",
  entrant_kind: "individual",
  allow_free_agents: false,
};

/** Base fixture for a hand-built CartEntry in these tests — every field a
 *  real reducer output would carry, so `toEqual` assertions below compare
 *  the WHOLE shape rather than silently ignoring players/answers/self
 *  fields. `registering_self`/`self_player_index` default to the same
 *  "unlinked" state ADD_ENTRY seeds. */
function entry(overrides: Partial<CartEntry> & Pick<CartEntry, "id" | "division_id" | "entrant_kind">): CartEntry {
  return {
    team_name: null,
    partner_name: null,
    free_agent: false,
    players: [],
    answers: {},
    registering_self: false,
    self_player_index: null,
    self_link_declined: false,
    ...overrides,
  };
}

describe("cartReducer — ADD_ENTRY", () => {
  it("appends a new entry for the division, defaults blank, players/answers empty for a team", () => {
    const next = cartReducer(EMPTY_CART, {
      type: "ADD_ENTRY",
      id: "e1",
      division_id: TEAM_DIVISION.division_id,
      entrant_kind: TEAM_DIVISION.entrant_kind,
    });
    expect(next.entries).toEqual([entry({ id: "e1", division_id: "div-team", entrant_kind: "team" })]);
    // Does not touch the self-link.
    expect(next.entries[0]!.registering_self).toBe(false);
  });

  it("seeds exactly 1 blank player row for an individual entry (schema's own min AND max)", () => {
    const next = cartReducer(EMPTY_CART, {
      type: "ADD_ENTRY",
      id: "e1",
      division_id: "div-indiv",
      entrant_kind: "individual",
    });
    expect(next.entries[0]!.players).toEqual([EMPTY_ROSTER_PLAYER]);
  });

  it("seeds exactly 2 blank player rows for a pair entry (the second is the partner field)", () => {
    const next = cartReducer(EMPTY_CART, {
      type: "ADD_ENTRY",
      id: "e1",
      division_id: "div-pair",
      entrant_kind: "pair",
    });
    expect(next.entries[0]!.players).toEqual([EMPTY_ROSTER_PLAYER, EMPTY_ROSTER_PLAYER]);
  });

  it("does not mutate the input state", () => {
    const before = JSON.stringify(EMPTY_CART);
    cartReducer(EMPTY_CART, {
      type: "ADD_ENTRY",
      id: "e1",
      division_id: "div-team",
      entrant_kind: "team",
    });
    expect(JSON.stringify(EMPTY_CART)).toBe(before);
  });

  it("refuses a cart already at MAX_CART_ENTRIES (schemas.ts entries.max(10))", () => {
    const full: CartState = {
      ...EMPTY_CART,
      entries: Array.from({ length: MAX_CART_ENTRIES }, (_, i) =>
        entry({ id: `e${i}`, division_id: "div-team", entrant_kind: "team" }),
      ),
    };
    const next = cartReducer(full, {
      type: "ADD_ENTRY",
      id: "overflow",
      division_id: "div-team",
      entrant_kind: "team",
    });
    expect(next).toBe(full); // unchanged reference — caller should have gated the button on canAddEntry
    expect(next.entries).toHaveLength(MAX_CART_ENTRIES);
  });
});

describe("canAddEntry", () => {
  it("is true below the cap and false at/above it", () => {
    expect(canAddEntry(EMPTY_CART)).toBe(true);
    const atCap: CartState = {
      ...EMPTY_CART,
      entries: Array.from({ length: MAX_CART_ENTRIES }, (_, i) =>
        entry({ id: `e${i}`, division_id: "d", entrant_kind: "individual" }),
      ),
    };
    expect(canAddEntry(atCap)).toBe(false);
  });
});

describe("cartReducer — REMOVE_ENTRY", () => {
  const withTwo: CartState = {
    entries: [
      entry({ id: "e1", division_id: "div-team", entrant_kind: "team", team_name: "Team A" }),
      entry({ id: "e2", division_id: "div-indiv", entrant_kind: "individual", registering_self: true, self_player_index: 0 }),
    ],
  };

  it("drops the entry by id", () => {
    const next = cartReducer(withTwo, { type: "REMOVE_ENTRY", id: "e1" });
    expect(next.entries.map((e) => e.id)).toEqual(["e2"]);
  });

  it("the self-link leaves WITH the entry when the self-linked entry is removed — no cart-level state to clean up any more", () => {
    const next = cartReducer(withTwo, { type: "REMOVE_ENTRY", id: "e2" });
    expect(next.entries.some((e) => e.registering_self)).toBe(false);
  });

  it("leaves a different entry's self-link untouched when this entry is removed", () => {
    const next = cartReducer(withTwo, { type: "REMOVE_ENTRY", id: "e1" });
    expect(next.entries.find((e) => e.id === "e2")!.registering_self).toBe(true);
    expect(next.entries.find((e) => e.id === "e2")!.self_player_index).toBe(0);
  });
});

describe("cartReducer — DUPLICATE_ENTRY", () => {
  it("clones the division/kind with a FRESH id and blank name (not the source name)", () => {
    const one: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "div-team", entrant_kind: "team", team_name: "Team A" })],
    };
    const next = cartReducer(one, { type: "DUPLICATE_ENTRY", sourceId: "e1", newId: "e2" });
    expect(next.entries).toHaveLength(2);
    const clone = next.entries[1]!;
    expect(clone.id).toBe("e2");
    expect(clone.division_id).toBe("div-team");
    expect(clone.entrant_kind).toBe("team");
    expect(clone.team_name).toBeNull(); // "Team B" is the rep's call, not a guess
  });

  it("re-seeds a BLANK roster by kind rather than copying the source's players", () => {
    const withRoster: CartState = {
      ...EMPTY_CART,
      entries: [
        {
          ...entry({ id: "e1", division_id: "div-pair", entrant_kind: "pair" }),
          players: [
            { ...EMPTY_ROSTER_PLAYER, full_name: "Alex Kim" },
            { ...EMPTY_ROSTER_PLAYER, full_name: "Sam Ortiz" },
          ],
        },
      ],
    };
    const next = cartReducer(withRoster, { type: "DUPLICATE_ENTRY", sourceId: "e1", newId: "e2" });
    const clone = next.entries[1]!;
    // Still 2 rows (pair's required count) but BLANK, not "Alex Kim"/"Sam Ortiz".
    expect(clone.players).toEqual([EMPTY_ROSTER_PLAYER, EMPTY_ROSTER_PLAYER]);
  });

  it("does not inherit the source's self-link either — a duplicate is a fresh, unlinked entry", () => {
    const selfLinked: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "div-team", entrant_kind: "team", registering_self: true, self_player_index: 1 })],
    };
    const next = cartReducer(selfLinked, { type: "DUPLICATE_ENTRY", sourceId: "e1", newId: "e2" });
    const clone = next.entries[1]!;
    expect(clone.registering_self).toBe(false);
    expect(clone.self_player_index).toBeNull();
  });

  it("is a no-op at the cart cap", () => {
    const full: CartState = {
      ...EMPTY_CART,
      entries: Array.from({ length: MAX_CART_ENTRIES }, (_, i) =>
        entry({ id: `e${i}`, division_id: "div-team", entrant_kind: "team" }),
      ),
    };
    const next = cartReducer(full, { type: "DUPLICATE_ENTRY", sourceId: "e0", newId: "overflow" });
    expect(next).toBe(full);
  });

  it("is a no-op when the source id does not exist", () => {
    const next = cartReducer(EMPTY_CART, { type: "DUPLICATE_ENTRY", sourceId: "missing", newId: "e2" });
    expect(next).toBe(EMPTY_CART);
  });
});

describe("cartReducer — UPDATE_ENTRY", () => {
  const one: CartState = {
    ...EMPTY_CART,
    entries: [entry({ id: "e1", division_id: "div-team", entrant_kind: "team" })],
  };

  it("patches team_name on the matching entry only", () => {
    const next = cartReducer(one, { type: "UPDATE_ENTRY", id: "e1", patch: { team_name: "Team A" } });
    expect(next.entries[0]!.team_name).toBe("Team A");
  });

  it("setting free_agent true clears team_name (a free agent has no team yet)", () => {
    const named: CartState = {
      ...EMPTY_CART,
      entries: [{ ...one.entries[0]!, team_name: "Team A" }],
    };
    const next = cartReducer(named, { type: "UPDATE_ENTRY", id: "e1", patch: { free_agent: true } });
    expect(next.entries[0]!.free_agent).toBe(true);
    expect(next.entries[0]!.team_name).toBeNull();
  });

  // Polish wave P5 (H-1): a solo sign-up's Details step collects the player (Assign has nobody to place without a player row) -
  // ONE row, the solo player's own, starting blank (details-seed fills it from the contact).
  it("becoming a solo sign-up gives the entry ONE blank player row, whatever roster it had", () => {
    const withRows: CartState = {
      ...EMPTY_CART,
      entries: [{ ...one.entries[0]!, players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Cap" }, { ...EMPTY_ROSTER_PLAYER }] }],
    };
    for (const cart of [one, withRows]) {
      const next = cartReducer(cart, { type: "UPDATE_ENTRY", id: "e1", patch: { free_agent: true } });
      expect(next.entries[0]!.players).toEqual([EMPTY_ROSTER_PLAYER]);
    }
    // Sequence: a second identical patch keeps the one row (no growth).
    const twice = cartReducer(cartReducer(one, { type: "UPDATE_ENTRY", id: "e1", patch: { free_agent: true } }), {
      type: "UPDATE_ENTRY",
      id: "e1",
      patch: { free_agent: true },
    });
    expect(twice.entries[0]!.players).toHaveLength(1);
    // ...and a repeat never wipes a name the registrant already typed on the solo row.
    const named = cartReducer(twice, { type: "UPDATE_PLAYER", id: "e1", index: 0, patch: { full_name: "Priya Raman" } });
    const repeated = cartReducer(named, { type: "UPDATE_ENTRY", id: "e1", patch: { free_agent: true } });
    expect(repeated.entries[0]!.players.map((p) => p.full_name)).toEqual(["Priya Raman"]);
  });
});

// RS006 follow-up. Self-linking across divisions is free (the describe below
// pins that); within ONE division it is exclusive. Two self-linked entries in
// the same division are not two entries, they are one person entered twice:
// `persons` get-or-create keys on name+dob, both rows resolve to the same
// person, and that person then holds two slots in one draw and pays for both.
// No unique index on (division_id, entrant) catches it downstream.
describe("cartReducer — SET_ENTRY_SELF is exclusive WITHIN a division (RS006 follow-up)", () => {
  const sameDivision: CartState = {
    entries: [
      entry({ id: "p1", division_id: "div-pair", entrant_kind: "pair", registering_self: true, self_player_index: 1 }),
      entry({ id: "p2", division_id: "div-pair", entrant_kind: "pair" }),
      entry({ id: "p3", division_id: "div-pair", entrant_kind: "pair" }),
    ],
  };

  it("linking a second entry in the SAME division unlinks the first", () => {
    const next = cartReducer(sameDivision, { type: "SET_ENTRY_SELF", id: "p2", isSelf: true });
    expect(next.entries.find((e) => e.id === "p1")!.registering_self).toBe(false);
    expect(next.entries.find((e) => e.id === "p2")!.registering_self).toBe(true);
    expect(next.entries.filter((e) => e.registering_self)).toHaveLength(1);
  });

  it("clears the displaced entry's stale self_player_index along with its link", () => {
    const next = cartReducer(sameDivision, { type: "SET_ENTRY_SELF", id: "p2", isSelf: true });
    expect(next.entries.find((e) => e.id === "p1")!.self_player_index).toBeNull();
  });

  it("does NOT mark the displaced entry as declined — the registrant never said 'not me' about it", () => {
    const next = cartReducer(sameDivision, { type: "SET_ENTRY_SELF", id: "p2", isSelf: true });
    // self_link_declined is what autoLinkObviousSelf reads to tell "never
    // asked" from "asked, and said no". Setting it here would answer a
    // question the registrant was never put.
    expect(next.entries.find((e) => e.id === "p1")!.self_link_declined).toBe(false);
  });

  it("three entries in one doubles division stay in the cart — only the SELF-LINK is exclusive, not the entries", () => {
    const next = cartReducer(sameDivision, { type: "SET_ENTRY_SELF", id: "p3", isSelf: true });
    // A club entering three pairs is the real use case and must keep working;
    // what cannot happen is one person appearing on more than one of them.
    expect(next.entries).toHaveLength(3);
    expect(next.entries.every((e) => e.division_id === "div-pair")).toBe(true);
    expect(next.entries.filter((e) => e.registering_self)).toHaveLength(1);
  });

  it("unlinking still touches only its own entry — no sibling is dragged along", () => {
    const next = cartReducer(sameDivision, { type: "SET_ENTRY_SELF", id: "p1", isSelf: false });
    expect(next.entries.find((e) => e.id === "p2")).toEqual(sameDivision.entries[1]);
    expect(next.entries.find((e) => e.id === "p3")).toEqual(sameDivision.entries[2]);
  });
});

describe("cartReducer — SET_ENTRY_SELF (per-entry, independently settable — RS006)", () => {
  const two: CartState = {
    entries: [
      entry({ id: "e1", division_id: "div-team", entrant_kind: "team", team_name: "Team A", registering_self: true, self_player_index: 2 }),
      entry({ id: "e2", division_id: "div-indiv", entrant_kind: "individual" }),
    ],
  };

  it("linking a SECOND entry does NOT unlink the first — a registrant may self-link more than one entry (e.g. singles + doubles)", () => {
    const next = cartReducer(two, { type: "SET_ENTRY_SELF", id: "e2", isSelf: true });
    expect(next.entries.find((e) => e.id === "e1")!.registering_self).toBe(true);
    expect(next.entries.find((e) => e.id === "e2")!.registering_self).toBe(true);
    const selfCount = next.entries.filter((e) => e.registering_self).length;
    expect(selfCount).toBe(2); // BOTH stay checked — no cart-wide exclusivity any more
  });

  it("unlinking one entry leaves a DIFFERENT self-linked entry untouched", () => {
    const bothSelf = cartReducer(two, { type: "SET_ENTRY_SELF", id: "e2", isSelf: true });
    const next = cartReducer(bothSelf, { type: "SET_ENTRY_SELF", id: "e1", isSelf: false });
    expect(next.entries.find((e) => e.id === "e1")!.registering_self).toBe(false);
    expect(next.entries.find((e) => e.id === "e2")!.registering_self).toBe(true);
  });

  it("(re-)linking an entry resets ITS OWN self_player_index (the roster pick is stale)", () => {
    const next = cartReducer(two, { type: "SET_ENTRY_SELF", id: "e1", isSelf: true });
    expect(next.entries.find((e) => e.id === "e1")!.self_player_index).toBeNull();
  });

  it("unlinking clears self_player_index too", () => {
    const next = cartReducer(two, { type: "SET_ENTRY_SELF", id: "e1", isSelf: false });
    expect(next.entries.find((e) => e.id === "e1")!.registering_self).toBe(false);
    expect(next.entries.find((e) => e.id === "e1")!.self_player_index).toBeNull();
  });

  it("never touches an unrelated entry's own fields", () => {
    const next = cartReducer(two, { type: "SET_ENTRY_SELF", id: "e1", isSelf: false });
    expect(next.entries.find((e) => e.id === "e2")).toEqual(two.entries[1]);
  });

  // RS006 fix wave — self_link_declined is the memory autoLinkObviousSelf
  // reads to tell "never asked" apart from "asked, and said no" (see that
  // function's own describe block below, and CartEntry.self_link_declined's
  // doc comment in types.ts).
  it("an explicit isSelf:false sets self_link_declined:true", () => {
    const next = cartReducer(two, { type: "SET_ENTRY_SELF", id: "e1", isSelf: false });
    expect(next.entries.find((e) => e.id === "e1")!.self_link_declined).toBe(true);
  });

  it("an explicit isSelf:true clears self_link_declined — a registrant changing their mind back has nothing left to remember", () => {
    const declined = cartReducer(two, { type: "SET_ENTRY_SELF", id: "e1", isSelf: false });
    const next = cartReducer(declined, { type: "SET_ENTRY_SELF", id: "e1", isSelf: true });
    expect(next.entries.find((e) => e.id === "e1")!.self_link_declined).toBe(false);
  });

  // RS006 §D (known gap): a free-agent entry has NO roster UI (design:
  // "Free-agent entries need nothing extra"), so nothing could ever resolve
  // self_player_index for one — self-linking it would submit
  // registering_self:true with an unresolvable index and 422 at submit with
  // an error the registrant cannot act on (api-v1/schemas/ folder's own comment on this
  // exact class of request). Refusing it HERE, at the reducer, is the
  // innermost of three layers that make the UI structurally unable to
  // produce it (the others: entry-cart.tsx's checkbox never renders for a
  // free-agent entry; autoLinkObviousSelf below skips one too) — belt and
  // suspenders, since a future call site could otherwise dispatch this
  // directly.
  it("refuses to set registering_self on a FREE-AGENT entry — no roster UI could ever resolve its self_player_index", () => {
    const withFreeAgent: CartState = {
      entries: [entry({ id: "fa1", division_id: "div-team", entrant_kind: "team", free_agent: true })],
    };
    const next = cartReducer(withFreeAgent, { type: "SET_ENTRY_SELF", id: "fa1", isSelf: true });
    expect(next.entries[0]!.registering_self).toBe(false);
  });
});

describe("cartReducer — SET_SELF_PLAYER_INDEX (step 3's self-row picker, per-entry)", () => {
  it("sets the named entry's self_player_index, independent of any other entry", () => {
    const cart: CartState = {
      entries: [
        entry({ id: "e1", division_id: "div-team", entrant_kind: "team", registering_self: true, self_player_index: null }),
        entry({ id: "e2", division_id: "div-team", entrant_kind: "team", registering_self: true, self_player_index: 3 }),
      ],
    };
    const next = cartReducer(cart, { type: "SET_SELF_PLAYER_INDEX", id: "e1", index: 1 });
    expect(next.entries.find((e) => e.id === "e1")!.self_player_index).toBe(1);
    expect(next.entries.find((e) => e.id === "e2")!.self_player_index).toBe(3); // untouched
  });

  it("null clears the row pick without clearing registering_self", () => {
    const cart: CartState = {
      entries: [entry({ id: "e1", division_id: "div-team", entrant_kind: "team", registering_self: true, self_player_index: 1 })],
    };
    const next = cartReducer(cart, { type: "SET_SELF_PLAYER_INDEX", id: "e1", index: null });
    expect(next.entries[0]!.self_player_index).toBeNull();
    expect(next.entries[0]!.registering_self).toBe(true);
  });
});

describe("cartReducer — ADD_PLAYER / REMOVE_PLAYER / UPDATE_PLAYER (team roster building)", () => {
  const teamEntry = entry({ id: "e1", division_id: "div-team", entrant_kind: "team" });
  const base: CartState = { ...EMPTY_CART, entries: [teamEntry] };

  it("ADD_PLAYER appends one blank row", () => {
    const next = cartReducer(base, { type: "ADD_PLAYER", id: "e1" });
    expect(next.entries[0]!.players).toEqual([EMPTY_ROSTER_PLAYER]);
    const next2 = cartReducer(next, { type: "ADD_PLAYER", id: "e1" });
    expect(next2.entries[0]!.players).toHaveLength(2);
  });

  it("ADD_PLAYER refuses past MAX_ROSTER_PLAYERS (schemas.ts players.max(50))", () => {
    const full: CartState = {
      ...EMPTY_CART,
      entries: [{ ...teamEntry, players: Array.from({ length: MAX_ROSTER_PLAYERS }, () => ({ ...EMPTY_ROSTER_PLAYER })) }],
    };
    const next = cartReducer(full, { type: "ADD_PLAYER", id: "e1" });
    expect(next.entries[0]!.players).toHaveLength(MAX_ROSTER_PLAYERS);
  });

  it("UPDATE_PLAYER patches one row's fields by index, leaves others untouched", () => {
    const twoRows: CartState = {
      ...EMPTY_CART,
      entries: [{ ...teamEntry, players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Row 0" }, { ...EMPTY_ROSTER_PLAYER, full_name: "Row 1" }] }],
    };
    const next = cartReducer(twoRows, {
      type: "UPDATE_PLAYER",
      id: "e1",
      index: 1,
      patch: { full_name: "Jamie Lee", dob: "2005-04-12" },
    });
    expect(next.entries[0]!.players[0]!.full_name).toBe("Row 0"); // untouched
    expect(next.entries[0]!.players[1]!).toEqual({ ...EMPTY_ROSTER_PLAYER, full_name: "Jamie Lee", dob: "2005-04-12" });
  });

  it("REMOVE_PLAYER drops the row at index and leaves self_player_index alone when this isn't the self entry", () => {
    const three: CartState = {
      entries: [{ ...teamEntry, players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "A" }, { ...EMPTY_ROSTER_PLAYER, full_name: "B" }, { ...EMPTY_ROSTER_PLAYER, full_name: "C" }] }],
    };
    const next = cartReducer(three, { type: "REMOVE_PLAYER", id: "e1", index: 1 });
    expect(next.entries[0]!.players.map((p) => p.full_name)).toEqual(["A", "C"]);
  });

  it("REMOVE_PLAYER is a no-op when the index doesn't exist", () => {
    const cart: CartState = { ...EMPTY_CART, entries: [{ ...teamEntry, players: [EMPTY_ROSTER_PLAYER] }] };
    const next = cartReducer(cart, { type: "REMOVE_PLAYER", id: "e1", index: 5 });
    expect(next).toBe(cart);
  });

  describe("REMOVE_PLAYER — self_player_index tracking (only on the entry the removal happened on)", () => {
    function threeRowSelfCart(selfPlayerIndex: number): CartState {
      return {
        entries: [
          {
            ...teamEntry,
            registering_self: true,
            self_player_index: selfPlayerIndex,
            players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "A" }, { ...EMPTY_ROSTER_PLAYER, full_name: "B" }, { ...EMPTY_ROSTER_PLAYER, full_name: "C" }],
          },
        ],
      };
    }

    it("removing the LINKED row clears self_player_index to null", () => {
      const next = cartReducer(threeRowSelfCart(1), { type: "REMOVE_PLAYER", id: "e1", index: 1 });
      expect(next.entries[0]!.self_player_index).toBeNull();
    });

    it("removing a row BEFORE the linked one shifts the index down (still tracks the same player)", () => {
      const next = cartReducer(threeRowSelfCart(2), { type: "REMOVE_PLAYER", id: "e1", index: 0 });
      expect(next.entries[0]!.players.map((p) => p.full_name)).toEqual(["B", "C"]);
      expect(next.entries[0]!.self_player_index).toBe(1); // "C" is now at index 1, same player as before
    });

    it("removing a row AFTER the linked one leaves the index unchanged", () => {
      const next = cartReducer(threeRowSelfCart(0), { type: "REMOVE_PLAYER", id: "e1", index: 2 });
      expect(next.entries[0]!.self_player_index).toBe(0);
    });

    it("a removal on a DIFFERENT entry never touches ANOTHER entry's self-link", () => {
      const cart: CartState = {
        entries: [
          { ...teamEntry, id: "e1", players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "A" }] },
          {
            ...teamEntry,
            id: "e2",
            registering_self: true,
            self_player_index: 1,
            players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "X" }, { ...EMPTY_ROSTER_PLAYER, full_name: "Y" }],
          },
        ],
      };
      const next = cartReducer(cart, { type: "REMOVE_PLAYER", id: "e1", index: 0 });
      const e2 = next.entries.find((e) => e.id === "e2")!;
      expect(e2.registering_self).toBe(true);
      expect(e2.self_player_index).toBe(1);
    });
  });
});

describe("cartReducer — IMPORT_PLAYERS (pasted roster)", () => {
  const teamEntry = entry({ id: "e1", division_id: "div-team", entrant_kind: "team" });

  it("appends parsed rows rather than replacing the existing roster", () => {
    const cart: CartState = { ...EMPTY_CART, entries: [{ ...teamEntry, players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Existing" }] }] };
    const imported: RosterPlayerState[] = [
      { ...EMPTY_ROSTER_PLAYER, full_name: "Jordan Blake", squad_number: "7" },
      { ...EMPTY_ROSTER_PLAYER, full_name: "Sam Ortiz", dob: "2004-11-30" },
    ];
    const next = cartReducer(cart, { type: "IMPORT_PLAYERS", id: "e1", players: imported });
    expect(next.entries[0]!.players.map((p) => p.full_name)).toEqual(["Existing", "Jordan Blake", "Sam Ortiz"]);
  });

  it("caps the result at MAX_ROSTER_PLAYERS", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [{ ...teamEntry, players: Array.from({ length: MAX_ROSTER_PLAYERS - 1 }, () => ({ ...EMPTY_ROSTER_PLAYER, full_name: "X" })) }],
    };
    const imported: RosterPlayerState[] = [
      { ...EMPTY_ROSTER_PLAYER, full_name: "Y1" },
      { ...EMPTY_ROSTER_PLAYER, full_name: "Y2" },
      { ...EMPTY_ROSTER_PLAYER, full_name: "Y3" },
    ];
    const next = cartReducer(cart, { type: "IMPORT_PLAYERS", id: "e1", players: imported });
    expect(next.entries[0]!.players).toHaveLength(MAX_ROSTER_PLAYERS);
  });
});

describe("cartReducer — SET_ANSWER (fix wave finding #1: narrowed from a whole-object SET_ANSWERS to one key+value, reducer-owned merge)", () => {
  it("merges one key into the matching entry's answers, other entries untouched", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [
        entry({ id: "e1", division_id: "div-team", entrant_kind: "team" }),
        entry({ id: "e2", division_id: "div-team", entrant_kind: "team" }),
      ],
    };
    const next = cartReducer(cart, { type: "SET_ANSWER", id: "e1", key: "shirt_size", value: "L" });
    expect(next.entries[0]!.answers).toEqual({ shirt_size: "L" });
    expect(next.entries[1]!.answers).toEqual({}); // untouched
  });

  it("merges against EXISTING answers on the entry rather than replacing them", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "div-team", entrant_kind: "team", answers: { shirt_size: "L" } })],
    };
    const next = cartReducer(cart, { type: "SET_ANSWER", id: "e1", key: "court_rules_ack", value: true });
    expect(next.entries[0]!.answers).toEqual({ shirt_size: "L", court_rules_ack: true });
  });

  it("overwrites an existing key's own value without touching sibling keys", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [
        entry({
          id: "e1",
          division_id: "div-team",
          entrant_kind: "team",
          answers: { shirt_size: "L", court_rules_ack: true },
        }),
      ],
    };
    const next = cartReducer(cart, { type: "SET_ANSWER", id: "e1", key: "shirt_size", value: "XL" });
    expect(next.entries[0]!.answers).toEqual({ shirt_size: "XL", court_rules_ack: true });
  });

  it("two dispatches for different keys, folded sequentially (no shared render closure at this layer), both survive", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "div-team", entrant_kind: "team" })],
    };
    const afterFirst = cartReducer(cart, { type: "SET_ANSWER", id: "e1", key: "shirt_size", value: "L" });
    const afterSecond = cartReducer(afterFirst, {
      type: "SET_ANSWER",
      id: "e1",
      key: "court_rules_ack",
      value: true,
    });
    expect(afterSecond.entries[0]!.answers).toEqual({ shirt_size: "L", court_rules_ack: true });
  });
});

describe("autoSeedSingleDivision — single-open-division collapse (RS006 prompt)", () => {
  it("seeds one blank entry for the division with kind-appropriate blank players (self-linking is autoLinkObviousSelf's job, not this function's)", () => {
    const entries = autoSeedSingleDivision(INDIVIDUAL_DIVISION, "seed-1");
    expect(entries).toEqual<CartEntry[]>([
      entry({ id: "seed-1", division_id: "div-indiv", entrant_kind: "individual", players: [EMPTY_ROSTER_PLAYER] }),
    ]);
  });

  it("seeds a team division with zero players (unconstrained roster)", () => {
    const entries = autoSeedSingleDivision(TEAM_DIVISION, "seed-1");
    expect(entries[0]!.players).toEqual([]);
  });
});

describe("autoLinkObviousSelf — links the ONE cart entry to 'I'm playing' when there's no ambiguity", () => {
  const oneEntry: CartState = {
    entries: [entry({ id: "e1", division_id: "div-indiv", entrant_kind: "individual" })],
  };

  it("links the single entry when imPlaying is true and nothing is linked yet", () => {
    const next = autoLinkObviousSelf(oneEntry, true);
    expect(next.entries[0]!.registering_self).toBe(true);
  });

  it("does nothing when imPlaying is false", () => {
    const next = autoLinkObviousSelf(oneEntry, false);
    expect(next).toBe(oneEntry);
  });

  it("does not override an already-explicit self choice", () => {
    const alreadyLinked: CartState = { entries: [{ ...oneEntry.entries[0]!, registering_self: true }] };
    const next = autoLinkObviousSelf(alreadyLinked, true);
    expect(next).toBe(alreadyLinked);
  });

  it("does nothing when the cart is empty", () => {
    expect(autoLinkObviousSelf(EMPTY_CART, true)).toBe(EMPTY_CART);
  });

  // Polish wave sign-off V1 (2026-11-12): a playing registrant is the player on EVERY entry they add. The old rule linked a cart of
  // exactly one entry and "never guessed across 2+", so the second division's entry of a singles+doubles registrant came out with
  // nobody linked: her own row typed again, stored consent-pending, and the panel showed her as "Consent pending" on her own entry.
  it("links EVERY entry of a playing registrant across divisions — individual, pair and team alike", () => {
    const three: CartState = {
      entries: [
        entry({ id: "e1", division_id: "d1", entrant_kind: "individual" }),
        entry({ id: "e2", division_id: "d2", entrant_kind: "pair" }),
        entry({ id: "e3", division_id: "d3", entrant_kind: "team" }),
      ],
    };
    const next = autoLinkObviousSelf(three, true);
    expect(next.entries.map((e) => e.registering_self)).toEqual([true, true, true]);
    // Linking never records a decline, and never pre-picks a row (details-seed.ts does that from the contact).
    expect(next.entries.map((e) => [e.self_link_declined, e.self_player_index])).toEqual([
      [false, null],
      [false, null],
      [false, null],
    ]);
    // Second pass over the linked cart: nothing left to do, the same reference.
    expect(autoLinkObviousSelf(next, true)).toBe(next);
  });

  it("links only the FIRST of two entries in one division — twice in one draw is the same person entered twice", () => {
    const sameDivision: CartState = {
      entries: [
        entry({ id: "e1", division_id: "d1", entrant_kind: "individual" }),
        entry({ id: "e2", division_id: "d1", entrant_kind: "individual" }),
        entry({ id: "e3", division_id: "d2", entrant_kind: "individual" }),
      ],
    };
    expect(autoLinkObviousSelf(sameDivision, true).entries.map((e) => e.registering_self)).toEqual([true, false, true]);
    // A division that ALREADY has the registrant (the second entry, linked by hand) keeps that choice; the first is not added.
    const handPicked: CartState = {
      entries: [sameDivision.entries[0]!, { ...sameDivision.entries[1]!, registering_self: true }, sameDivision.entries[2]!],
    };
    expect(autoLinkObviousSelf(handPicked, true).entries.map((e) => e.registering_self)).toEqual([false, true, true]);
  });

  it("keeps an explicit 'not me' on one entry of a multi-entry cart, skips a solo entry, and still links the others", () => {
    const mixed: CartState = {
      entries: [
        entry({ id: "e1", division_id: "d1", entrant_kind: "individual", self_link_declined: true }),
        entry({ id: "e2", division_id: "d2", entrant_kind: "individual" }),
        entry({ id: "fa", division_id: "d3", entrant_kind: "team", free_agent: true }),
      ],
    };
    const next = autoLinkObviousSelf(mixed, true);
    expect(next.entries.map((e) => e.registering_self)).toEqual([false, true, false]);
    expect(next.entries[0]).toBe(mixed.entries[0]);
    expect(next.entries[2]).toBe(mixed.entries[2]);
  });

  it("re-links automatically when the rep un-links then re-toggles imPlaying (still exactly one entry, still no explicit choice)", () => {
    const unlinked: CartState = { entries: [{ ...oneEntry.entries[0]!, registering_self: false }] };
    const next = autoLinkObviousSelf(unlinked, true);
    expect(next.entries[0]!.registering_self).toBe(true);
  });

  // RS006 fix wave — the contrasting case to the one above: THIS unlinked
  // state came from an EXPLICIT "This is me" uncheck (SET_ENTRY_SELF,
  // self_link_declined:true), not an imPlaying round-trip, and must NOT
  // re-link. This is the pure-function half of the fix; the mounted
  // add-then-remove SEQUENCE that actually shipped the bug is regression-
  // pinned in register-stepper-interaction.test.tsx (a reducer-level test
  // alone cannot see a bug that only exists across multiple dispatches).
  it("does NOT re-link when the sole entry was EXPLICITLY declined (self_link_declined:true), even though it is otherwise the obvious, unambiguous case", () => {
    const declined: CartState = {
      entries: [{ ...oneEntry.entries[0]!, registering_self: false, self_link_declined: true }],
    };
    const next = autoLinkObviousSelf(declined, true);
    expect(next).toBe(declined);
  });

  // RS006 §D (known gap) — see the matching SET_ENTRY_SELF test above for
  // why. Without this, "sign up solo" (a free-agent division's ONLY entry)
  // would auto-link on the very next imPlaying toggle and 422 at submit.
  it("never auto-links a sole FREE-AGENT entry — same reason SET_ENTRY_SELF refuses it", () => {
    const soleFreeAgent: CartState = {
      entries: [entry({ id: "fa1", division_id: "div-team", entrant_kind: "team", free_agent: true })],
    };
    const next = autoLinkObviousSelf(soleFreeAgent, true);
    expect(next).toBe(soleFreeAgent);
  });
});

describe("clearSelfLinkWhenNotPlaying — the inverse of autoLinkObviousSelf (fix wave finding #2)", () => {
  const linked: CartState = {
    entries: [entry({ id: "e1", division_id: "div-indiv", entrant_kind: "individual", registering_self: true, self_player_index: 0 })],
  };

  it("clears an AUTO-linked self entry once imPlaying flips false", () => {
    const next = clearSelfLinkWhenNotPlaying(linked, false);
    expect(next.entries[0]!.registering_self).toBe(false);
    expect(next.entries[0]!.self_player_index).toBeNull();
  });

  it("clears an EXPLICITLY-chosen self entry too — imPlaying=false means dob was never collected, so a stale link would submit registering_self:true with contact.dob:null (schemas.ts superRefine rejects that)", () => {
    const explicit: CartState = { entries: [{ ...linked.entries[0]!, self_player_index: 2 }] };
    const next = clearSelfLinkWhenNotPlaying(explicit, false);
    expect(next.entries[0]!.registering_self).toBe(false);
  });

  it("clears EVERY self-linked entry, not just one (RS006: a registrant may have linked more than one)", () => {
    const twoLinked: CartState = {
      entries: [
        entry({ id: "e1", division_id: "d1", entrant_kind: "individual", registering_self: true, self_player_index: 0 }),
        entry({ id: "e2", division_id: "d2", entrant_kind: "team", registering_self: true, self_player_index: 1 }),
      ],
    };
    const next = clearSelfLinkWhenNotPlaying(twoLinked, false);
    expect(next.entries.every((e) => !e.registering_self && e.self_player_index === null)).toBe(true);
  });

  it("does nothing while imPlaying is true", () => {
    expect(clearSelfLinkWhenNotPlaying(linked, true)).toBe(linked);
  });

  it("does nothing when nothing is linked (same reference back)", () => {
    const unlinked: CartState = {
      entries: linked.entries.map((e) => ({ ...e, registering_self: false, self_player_index: null })),
    };
    expect(clearSelfLinkWhenNotPlaying(unlinked, false)).toBe(unlinked);
  });
});

describe("toGroupEntry — maps a CartEntry onto PublicRegisterGroupEntry's step-2 fields", () => {
  const one = entry({ id: "e1", division_id: "div-team", entrant_kind: "team", team_name: "Team A" });

  it("drops the client-only id and maps 1:1 otherwise", () => {
    const mapped = toGroupEntry(one);
    expect(mapped).toEqual({
      division_id: "div-team",
      entrant_kind: "team",
      team_name: "Team A",
      partner_name: null,
      free_agent: false,
      registering_self: false,
    });
    expect(mapped).not.toHaveProperty("id");
  });

  it("an individual self entry needs no explicit self_player_index (schema implies 0)", () => {
    const indiv: CartEntry = { ...one, entrant_kind: "individual", team_name: null, registering_self: true, self_player_index: null };
    const mapped = toGroupEntry(indiv);
    expect(mapped.registering_self).toBe(true);
    expect(mapped.self_player_index).toBeUndefined();
  });

  it("a team self entry carries self_player_index explicitly once step 3 resolves it", () => {
    const mapped = toGroupEntry({ ...one, registering_self: true, self_player_index: 2 });
    expect(mapped.registering_self).toBe(true);
    expect(mapped.self_player_index).toBe(2);
  });

  it("a NON-self entry never leaks self_player_index, even if one is sitting on the entry from an earlier link", () => {
    const mapped = toGroupEntry({ ...one, registering_self: false, self_player_index: 3 });
    expect(mapped.registering_self).toBe(false);
    expect(mapped.self_player_index).toBeUndefined();
  });

  it("two entries mapped independently can BOTH carry registering_self:true (RS006 — no cart-wide state to consult)", () => {
    const a = toGroupEntry({ ...one, id: "e1", registering_self: true, self_player_index: 0 });
    const b = toGroupEntry({ ...one, id: "e2", entrant_kind: "individual", registering_self: true, self_player_index: null });
    expect(a.registering_self).toBe(true);
    expect(b.registering_self).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RS006 step 4 (CONSENT) — registeringSelfAnywhere mirrors
// registration-submit.ts's own cart-wide flag of the same name (the guardian
// gate's trigger condition), computed off the CART rather than the WHO
// step's imPlaying toggle: imPlaying can be true with zero entries actually
// linked (2+ entries is ambiguous — the rep must explicitly choose), and the
// server's own gate keys off the ACTUAL link, not the intent to link.
// ---------------------------------------------------------------------------

describe("registeringSelfAnywhere", () => {
  it("false for an empty cart or a cart with no self-linked entries", () => {
    expect(registeringSelfAnywhere(EMPTY_CART)).toBe(false);
    const none: CartState = { entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "individual" })] };
    expect(registeringSelfAnywhere(none)).toBe(false);
  });

  it("true when ANY entry is self-linked, even if others aren't", () => {
    const mixed: CartState = {
      entries: [
        entry({ id: "e1", division_id: "d1", entrant_kind: "individual" }),
        entry({ id: "e2", division_id: "d2", entrant_kind: "individual", registering_self: true, self_player_index: 0 }),
      ],
    };
    expect(registeringSelfAnywhere(mixed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RS006 step 4 (CONSENT) — the captain-roster notice's trigger (design §4
// step 4: "Notice that captain-entered players will be asked to confirm
// when they join/claim"). True whenever the cart, once submitted, names at
// least one player who is NOT the contact's own self-linked row.
// ---------------------------------------------------------------------------

describe("cartHasOtherPlayers", () => {
  it("false for an empty cart", () => {
    expect(cartHasOtherPlayers(EMPTY_CART)).toBe(false);
  });

  it("false for a free-agent entry regardless of players — free agents carry no roster of 'other' people", () => {
    const cart: CartState = {
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team", free_agent: true })],
    };
    expect(cartHasOtherPlayers(cart)).toBe(false);
  });

  it("false for a solo self-linked individual entry — the only player IS the contact", () => {
    const cart: CartState = {
      entries: [
        {
          ...entry({ id: "e1", division_id: "d1", entrant_kind: "individual", registering_self: true, self_player_index: 0 }),
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
        },
      ],
    };
    expect(cartHasOtherPlayers(cart)).toBe(false);
  });

  it("true for a team roster with players beyond the self-linked row", () => {
    const cart: CartState = {
      entries: [
        {
          ...entry({ id: "e1", division_id: "d1", entrant_kind: "team", registering_self: true, self_player_index: 0 }),
          players: [
            { ...EMPTY_ROSTER_PLAYER, full_name: "Alex" },
            { ...EMPTY_ROSTER_PLAYER, full_name: "Sam" },
          ],
        },
      ],
    };
    expect(cartHasOtherPlayers(cart)).toBe(true);
  });

  it("true for an entry with players and NO self-link at all — every row is someone else", () => {
    const cart: CartState = {
      entries: [
        {
          ...entry({ id: "e1", division_id: "d1", entrant_kind: "pair" }),
          players: [
            { ...EMPTY_ROSTER_PLAYER, full_name: "Sam" },
            { ...EMPTY_ROSTER_PLAYER, full_name: "Jordan" },
          ],
        },
      ],
    };
    expect(cartHasOtherPlayers(cart)).toBe(true);
  });

  it("false for a team entry with an EMPTY roster — nobody entered yet", () => {
    const cart: CartState = { entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team" })] };
    expect(cartHasOtherPlayers(cart)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RS006 §C — summarizeCart is the ONE subtotal/waitlist computation shared
// by entry-cart.tsx (step 2) and step-review.tsx (step 5): "waitlisted
// entries flagged 'not charged now' and excluded from the subtotal (step 2's
// cart already does this — reuse, do not fork the logic)". entry-cart.tsx's
// OWN existing tests (register-stepper-interaction.test.tsx findings #4/#8)
// pin its rendered COPY; these pin the shared MATH underneath both renderers.
// ---------------------------------------------------------------------------

describe("summarizeCart", () => {
  const OPEN_PAID: DivisionLike = { ...TEAM_DIVISION, division_id: "open-paid", fee_cents: 2500, currency: "gbp" };
  // A full division as the wire carries it: `closed_reason "full"` IS "open and 0 places left" (settings.ts), so the fixture says both.
  const WAITLIST_DIV: DivisionLike = { ...TEAM_DIVISION, division_id: "waitlist", closed_reason: "full", capacity: 16, remaining: 0, taken: 16, fee_cents: 1000 };
  const STALE_CLOSED_DIV: DivisionLike = {
    ...TEAM_DIVISION,
    division_id: "stale",
    open: false,
    closed_reason: "window",
    fee_cents: 1500,
    free_agent_fee_cents: null,
  };

  it("sums only OPEN (non-closed) entries into the subtotal, in that division's currency", () => {
    const cart: CartState = {
      entries: [
        entry({ id: "e1", division_id: "open-paid", entrant_kind: "team" }),
        entry({ id: "e2", division_id: "waitlist", entrant_kind: "team" }),
      ],
    };
    const summary = summarizeCart(cart, [OPEN_PAID, WAITLIST_DIV]);
    expect(summary.subtotalCents).toBe(2500);
    expect(summary.currency).toBe("gbp");
  });

  it("flags a 'full' closed division as waitlisted and not-charged-now, excluded from the subtotal", () => {
    const cart: CartState = { entries: [entry({ id: "e1", division_id: "waitlist", entrant_kind: "team" })] };
    const summary = summarizeCart(cart, [WAITLIST_DIV]);
    expect(summary.lines[0]!.waitlisted).toBe(true);
    expect(summary.lines[0]!.staleClosed).toBe(false);
    expect(summary.lines[0]!.notChargedNow).toBe(true);
    expect(summary.subtotalCents).toBe(0);
  });

  it("flags a non-'full' closed (stale) division distinctly — not-charged-now but NOT waitlisted", () => {
    const cart: CartState = { entries: [entry({ id: "e1", division_id: "stale", entrant_kind: "team" })] };
    const summary = summarizeCart(cart, [STALE_CLOSED_DIV]);
    expect(summary.lines[0]!.waitlisted).toBe(false);
    expect(summary.lines[0]!.staleClosed).toBe(true);
    expect(summary.lines[0]!.notChargedNow).toBe(true);
    expect(summary.subtotalCents).toBe(0);
  });

  it("an open, payable entry is charged now — neither flag set", () => {
    const cart: CartState = { entries: [entry({ id: "e1", division_id: "open-paid", entrant_kind: "team" })] };
    const summary = summarizeCart(cart, [OPEN_PAID]);
    expect(summary.lines[0]!.waitlisted).toBe(false);
    expect(summary.lines[0]!.staleClosed).toBe(false);
    expect(summary.lines[0]!.notChargedNow).toBe(false);
  });

  it("a cart entry whose division cannot be found degrades to a not-found line, contributing nothing to the subtotal", () => {
    const cart: CartState = { entries: [entry({ id: "e1", division_id: "missing", entrant_kind: "team" })] };
    const summary = summarizeCart(cart, []);
    expect(summary.lines[0]!.division).toBeUndefined();
    expect(summary.subtotalCents).toBe(0);
  });

  // Registration redesign B3 T12 (spec §4.1 cart arithmetic, Review Focus 2). The cart used to read the wire's `closed_reason`
  // alone, so a division with ONE place left priced two entries at full and the server then waitlisted the second: the review
  // quoted a total the card was never charged. The verdicts now come from `cartWaitlisted` (capacity.ts), which follows submit's
  // own loop; these pin what the SUMMARY does with them — the flag, the "not charged now" state and the total — and the DB
  // parity test (server/usecases/__tests__/registration-cart-parity.test.ts) holds the whole of it to the real submit.
  describe("waitlist arithmetic — entries into a division take its remaining places in cart order (B3 T12)", () => {
    const ONE_LEFT: DivisionLike = { ...TEAM_DIVISION, division_id: "one-left", capacity: 16, remaining: 1, taken: 15, fee_cents: 1000 };
    const team = (id: string, division_id: string, patch: Partial<CartEntry> = {}) => entry({ id, division_id, entrant_kind: "team", ...patch });

    it("second entry beyond remaining is waitlisted in the cart and excluded from total", () => {
      const summary = summarizeCart({ entries: [team("e1", "one-left"), team("e2", "one-left")] }, [ONE_LEFT]);
      expect(summary.lines.map((l) => l.waitlisted), "[first takes the place, second waits]").toEqual([false, true]);
      expect(summary.lines.map((l) => l.notChargedNow)).toEqual([false, true]);
      expect(summary.lines.map((l) => l.staleClosed), "waiting is not a stale-closed division").toEqual([false, false]);
      expect(summary.subtotalCents, "the total is exactly ONE fee: the division's price, once").toBe(ONE_LEFT.fee_cents);
      expect(summary.currency).toBe("gbp");
      expect(payableDivision(summary)?.division_id).toBe("one-left");
      expect(summary.lines.map(lineMethod), "the waiting entry has no payment method to name").toEqual(["offline", null]);
    });

    it("the empty cart: no lines, nothing to pay, no currency", () => {
      expect(summarizeCart({ entries: [] }, [ONE_LEFT])).toEqual({ lines: [], subtotalCents: 0, currency: null });
    });

    it("remaining null never waitlists: every entry is charged", () => {
      const open = { ...ONE_LEFT, division_id: "uncapped", capacity: null, remaining: null };
      const summary = summarizeCart({ entries: [team("e1", "uncapped"), team("e2", "uncapped"), team("e3", "uncapped")] }, [open]);
      expect(summary.lines.map((l) => l.waitlisted)).toEqual([false, false, false]);
      expect(summary.subtotalCents).toBe(3 * open.fee_cents);
    });

    it("a division with 3 places left takes 3 entries; the 4th waits and is not in the total", () => {
      const three = { ...ONE_LEFT, division_id: "three", remaining: 3 };
      const summary = summarizeCart({ entries: [1, 2, 3, 4].map((n) => team(`e${n}`, "three")) }, [three]);
      expect(summary.lines.map((l) => l.waitlisted)).toEqual([false, false, false, true]);
      expect(summary.subtotalCents).toBe(3 * three.fee_cents);
    });

    it("after a sibling is removed (the real reducer), the entry behind it takes the place and is charged", () => {
      const before: CartState = { entries: [team("e1", "one-left"), team("e2", "one-left")] };
      expect(summarizeCart(before, [ONE_LEFT]).lines.map((l) => l.waitlisted)).toEqual([false, true]);
      const after = cartReducer(before, { type: "REMOVE_ENTRY", id: "e1" });
      const summary = summarizeCart(after, [ONE_LEFT]);
      expect(summary.lines.map((l) => [l.entry.id, l.waitlisted])).toEqual([["e2", false]]);
      expect(summary.subtotalCents, "the survivor is now the one charged entry").toBe(ONE_LEFT.fee_cents);
    });

    it("a duplicated entry (the real reducer) is queued behind its source when only one place is left", () => {
      const cart = cartReducer({ entries: [team("e1", "one-left")] }, { type: "DUPLICATE_ENTRY", sourceId: "e1", newId: "e2" });
      const summary = summarizeCart(cart, [ONE_LEFT]);
      expect(summary.lines.map((l) => [l.entry.id, l.waitlisted])).toEqual([["e1", false], ["e2", true]]);
    });

    it("divisions are counted separately, and only the entries that hold a place are charged", () => {
      const other: DivisionLike = { ...ONE_LEFT, division_id: "roomy", remaining: 5, fee_cents: 2500 };
      const cart: CartState = {
        entries: [team("a1", "one-left"), team("b1", "roomy"), team("a2", "one-left"), team("b2", "roomy")],
      };
      const summary = summarizeCart(cart, [ONE_LEFT, other]);
      expect(summary.lines.map((l) => l.waitlisted)).toEqual([false, false, true, false]);
      expect(summary.subtotalCents, "1000 for the first one-left entry + 2 x 2500 for roomy").toBe(1000 + 2 * 2500);
    });

    it("a full division waits every team entry into it (the pre-change behaviour, kept)", () => {
      const summary = summarizeCart({ entries: [team("e1", "waitlist"), team("e2", "waitlist")] }, [WAITLIST_DIV]);
      expect(summary.lines.map((l) => l.waitlisted)).toEqual([true, true]);
      expect(summary.subtotalCents).toBe(0);
    });

    it("a solo sign-up into a full division is NOT waitlisted: it is charged its own price, like submit (FP2)", () => {
      // Submit never queues a solo entry (it refuses a full solo pool instead). The cart used to flag it "waiting, not charged".
      const full: DivisionLike = { ...WAITLIST_DIV, free_agent_fee_cents: 500 };
      const summary = summarizeCart({ entries: [team("solo", "waitlist", { free_agent: true })] }, [full]);
      expect(summary.lines[0]!.waitlisted).toBe(false);
      expect(summary.lines[0]!.notChargedNow).toBe(false);
      expect(summary.subtotalCents).toBe(500);
    });

    it("a solo sign-up takes no place: one place left, team + solo + team gives [seated, seated, waiting]", () => {
      const summary = summarizeCart({ entries: [team("t1", "one-left"), team("solo", "one-left", { free_agent: true }), team("t2", "one-left")] }, [ONE_LEFT]);
      expect(summary.lines.map((l) => l.waitlisted)).toEqual([false, false, true]);
      expect(summary.subtotalCents, "two charged entries: the team fee and the solo price (a null solo price falls back to the team fee)").toBe(2 * ONE_LEFT.fee_cents);
    });

    it("a stale-closed division is never 'waiting', whatever its places say: it blocks Next instead", () => {
      const stale: DivisionLike = { ...STALE_CLOSED_DIV, remaining: 0 };
      const summary = summarizeCart({ entries: [team("e1", "stale")] }, [stale]);
      expect([summary.lines[0]!.waitlisted, summary.lines[0]!.staleClosed, summary.lines[0]!.notChargedNow]).toEqual([false, true, true]);
    });

    it("an unknown division is not 'waiting' either: nothing is known about its places", () => {
      const summary = summarizeCart({ entries: [team("e1", "ghost")] }, [ONE_LEFT]);
      expect([summary.lines[0]!.waitlisted, summary.lines[0]!.notChargedNow]).toEqual([false, true]);
    });
  });

  describe("payableDivision — the ONE division that decides the submit CTA and the payment-method note (step 5, so the two can never disagree)", () => {
    it("undefined for an all-free/all-waitlisted cart — nothing to describe", () => {
      const cart: CartState = { entries: [entry({ id: "e1", division_id: "waitlist", entrant_kind: "team" })] };
      expect(payableDivision(summarizeCart(cart, [WAITLIST_DIV]))).toBeUndefined();
    });

    it("the first line that is actually charged now", () => {
      const cart: CartState = {
        entries: [
          entry({ id: "e1", division_id: "waitlist", entrant_kind: "team" }),
          entry({ id: "e2", division_id: "open-paid", entrant_kind: "team" }),
        ],
      };
      const division = payableDivision(summarizeCart(cart, [WAITLIST_DIV, OPEN_PAID]));
      expect(division?.division_id).toBe("open-paid");
    });
  });

  // Registration redesign B3 T12 (B2 review m3). The forward button on Review names what submit will DO. A cart whose every entry
  // waits is a person joining a waiting list - "Enter the competition" (the free label, because the charged total is 0) is wrong for
  // it; a cart with one charged entry and one waiting entry still pays, and the label quotes the CHARGED total only.
  describe("submitLabelKey — the Review button names what submit will do", () => {
    const STRIPE_PAID: DivisionLike = { ...OPEN_PAID, division_id: "stripe-paid", payment_method: "stripe" };
    const FREE_DIV: DivisionLike = { ...TEAM_DIVISION, division_id: "free-div", fee_cents: 0, free_agent_fee_cents: null };
    const ONE_LEFT_STRIPE: DivisionLike = { ...STRIPE_PAID, division_id: "one-left-stripe", capacity: 8, remaining: 1, taken: 7 };
    const team = (id: string, division_id: string, patch: Partial<CartEntry> = {}) => entry({ id, division_id, entrant_kind: "team", ...patch });
    const key = (entries: CartEntry[], divisions: DivisionLike[]) => submitLabelKey(summarizeCart({ entries }, divisions));

    // The empty case first (TEST-STRATEGY): an empty cart has no line that is "all" anything, so it must NOT read as a waiting list.
    it("an empty cart is not a waiting list: it keeps the free label", () => {
      expect(key([], [WAITLIST_DIV])).toBe("register.submit.free");
    });

    it.each([
      { name: "one entry into a full division", entries: [team("e1", "waitlist")], divisions: [WAITLIST_DIV] },
      { name: "two entries into a full division", entries: [team("e1", "waitlist"), team("e2", "waitlist")], divisions: [WAITLIST_DIV] },
      {
        name: "entries into two different full divisions",
        entries: [team("e1", "waitlist"), team("e2", "waitlist-2")],
        divisions: [WAITLIST_DIV, { ...WAITLIST_DIV, division_id: "waitlist-2" }],
      },
    ])("every entry waits ($name): join the waiting list", ({ entries, divisions }) => {
      const summary = summarizeCart({ entries }, divisions);
      expect(summary.lines.every((l) => l.waitlisted), "premise: every line is waitlisted").toBe(true);
      expect(summary.lines.length, "premise: the cart is not empty").toBeGreaterThan(0);
      expect(submitLabelKey(summary)).toBe("register.submit.waitlist");
    });

    it.each([
      { name: "one charged card entry + one waiting entry", entries: [team("e1", "stripe-paid"), team("e2", "waitlist")], divisions: [STRIPE_PAID, WAITLIST_DIV], want: "register.submit.pay" },
      { name: "one charged offline entry + one waiting entry", entries: [team("e1", "open-paid"), team("e2", "waitlist")], divisions: [OPEN_PAID, WAITLIST_DIV], want: "register.submit.fee" },
      { name: "the same division: the first entry takes the last place, the second waits (card)", entries: [team("e1", "one-left-stripe"), team("e2", "one-left-stripe")], divisions: [ONE_LEFT_STRIPE], want: "register.submit.pay" },
      { name: "the waiting entry comes FIRST in the cart, the charged one after it", entries: [team("e1", "waitlist"), team("e2", "stripe-paid")], divisions: [WAITLIST_DIV, STRIPE_PAID], want: "register.submit.pay" },
    ])("mixed ($name): the Pay/Enter label stays, the waiting-list one does not", ({ entries, divisions, want }) => {
      const summary = summarizeCart({ entries }, divisions);
      expect(summary.lines.some((l) => l.waitlisted), "premise: one entry waits").toBe(true);
      expect(summary.lines.some((l) => !l.notChargedNow), "premise: one entry is charged").toBe(true);
      expect(submitLabelKey(summary)).toBe(want);
    });

    it("the fee the Pay label quotes is the charged total only: the waiting entry's own price never joins it", () => {
      const summary = summarizeCart({ entries: [team("e1", "stripe-paid"), team("e2", "waitlist")] }, [STRIPE_PAID, WAITLIST_DIV]);
      expect(WAITLIST_DIV.fee_cents, "premise: the waiting entry has a price of its own").toBeGreaterThan(0);
      expect(summary.subtotalCents).toBe(STRIPE_PAID.fee_cents);
    });

    it("a free entry beside a waiting one is not a waiting list: the person is entering the free division", () => {
      expect(key([team("e1", "free-div"), team("e2", "waitlist")], [FREE_DIV, WAITLIST_DIV])).toBe("register.submit.free");
    });

    it("a solo sign-up into a full division is not waiting (submit never queues it): it is charged, so it reads Pay", () => {
      const full: DivisionLike = { ...WAITLIST_DIV, payment_method: "stripe", free_agent_fee_cents: 500 };
      expect(key([team("solo", "waitlist", { free_agent: true })], [full])).toBe("register.submit.pay");
    });

    it("a stale-closed entry alone is not a waiting list, and neither is an unknown division", () => {
      expect(key([team("e1", "stale")], [STALE_CLOSED_DIV])).toBe("register.submit.free");
      expect(key([team("e1", "ghost")], [WAITLIST_DIV])).toBe("register.submit.free");
    });

    it("a waiting entry beside a stale-closed one is not 'every entry waits' (the stale one blocks Next, it does not wait)", () => {
      expect(key([team("e1", "waitlist"), team("e2", "stale")], [WAITLIST_DIV, STALE_CLOSED_DIV])).toBe("register.submit.free");
    });

    it("after the entry holding the last place is removed (the real reducer) the survivor takes it: the label flips from Pay back off the waiting list", () => {
      const before: CartState = { entries: [team("e1", "one-left-stripe"), team("e2", "one-left-stripe")] };
      const afterRemoval = cartReducer(before, { type: "REMOVE_ENTRY", id: "e1" });
      expect(submitLabelKey(summarizeCart(afterRemoval, [ONE_LEFT_STRIPE]))).toBe("register.submit.pay");
      // And the other direction: a division that fills up under a cart of waiting entries reads waiting for all of them.
      const full: DivisionLike = { ...ONE_LEFT_STRIPE, remaining: 0 };
      expect(submitLabelKey(summarizeCart(before, [full]))).toBe("register.submit.waitlist");
    });
  });

  // Owner ruling 2026-11-13 (B2/B3 fix round): Review's heading says "Review and pay" only when something IS charged now; a free cart,
  // or one whose every entry waits, has nothing to pay, so it is a plain "Review". The expected key is the ruling's, entry by entry
  // (what the person is charged), not read back from submitLabelKey.
  describe("reviewHeadingKey — Review says 'and pay' only when something is charged now", () => {
    const STRIPE_PAID: DivisionLike = { ...OPEN_PAID, division_id: "stripe-paid", payment_method: "stripe" };
    const FREE_DIV: DivisionLike = { ...TEAM_DIVISION, division_id: "free-div", fee_cents: 0, free_agent_fee_cents: null };
    const ONE_LEFT_STRIPE: DivisionLike = { ...STRIPE_PAID, division_id: "one-left-stripe", capacity: 8, remaining: 1, taken: 7 };
    const team = (id: string, division_id: string, patch: Partial<CartEntry> = {}) => entry({ id, division_id, entrant_kind: "team", ...patch });
    const PAY = "register.review.heading";
    const PLAIN = "register.review.headingPlain";

    it.each([
      { name: "an empty cart (nothing is charged)", entries: [], divisions: [WAITLIST_DIV], charged: false },
      { name: "a free entry", entries: [team("e1", "free-div")], divisions: [FREE_DIV], charged: false },
      { name: "one entry into a full, PRICED division (it waits, so nothing is charged)", entries: [team("e1", "waitlist")], divisions: [WAITLIST_DIV], charged: false },
      { name: "two entries into a full, priced division", entries: [team("e1", "waitlist"), team("e2", "waitlist")], divisions: [WAITLIST_DIV], charged: false },
      { name: "a free entry beside a waiting one", entries: [team("e1", "free-div"), team("e2", "waitlist")], divisions: [FREE_DIV, WAITLIST_DIV], charged: false },
      { name: "a card entry", entries: [team("e1", "stripe-paid")], divisions: [STRIPE_PAID], charged: true },
      { name: "a pay-the-organiser entry", entries: [team("e1", "open-paid")], divisions: [OPEN_PAID], charged: true },
      { name: "a charged entry beside a waiting one", entries: [team("e1", "stripe-paid"), team("e2", "waitlist")], divisions: [STRIPE_PAID, WAITLIST_DIV], charged: true },
      { name: "the waiting entry comes first, the charged one after", entries: [team("e1", "waitlist"), team("e2", "stripe-paid")], divisions: [WAITLIST_DIV, STRIPE_PAID], charged: true },
      { name: "a solo sign-up into a full division (submit never queues it, so it is charged)", entries: [team("solo", "waitlist", { free_agent: true })], divisions: [{ ...WAITLIST_DIV, payment_method: "stripe" as const, free_agent_fee_cents: 500 }], charged: true },
    ])("$name", ({ entries, divisions, charged }) => {
      const summary = summarizeCart({ entries }, divisions);
      // The premise is the rulebook's own: money is charged now exactly when some line is not "not charged now" and has a price.
      expect(summary.subtotalCents > 0, "premise: the cart's subtotal agrees with what the case says is charged").toBe(charged);
      expect(reviewHeadingKey(summary)).toBe(charged ? PAY : PLAIN);
    });

    it("the answer follows the cart: the last place taken by the first entry flips the second off the heading's 'pay'", () => {
      const both: CartState = { entries: [team("e1", "one-left-stripe"), team("e2", "one-left-stripe")] };
      expect(reviewHeadingKey(summarizeCart(both, [ONE_LEFT_STRIPE])), "one entry seats and pays").toBe(PAY);
      const full: DivisionLike = { ...ONE_LEFT_STRIPE, remaining: 0 };
      expect(reviewHeadingKey(summarizeCart(both, [full])), "the division fills under the cart: both wait, nothing is charged").toBe(PLAIN);
      const afterRemoval = cartReducer(both, { type: "REMOVE_ENTRY", id: "e1" });
      expect(reviewHeadingKey(summarizeCart(afterRemoval, [ONE_LEFT_STRIPE])), "removing the first lets the survivor take the place").toBe(PAY);
    });
  });
});


describe("lineFeeCents — the quote must equal what the server charges (RS009)", () => {
  // The defect: `summarizeCart` and step-review both read
  // `division.fee_cents` directly while `registration-submit.ts` charged
  // `free_agent_fee_cents` for a solo line. A 6000-per-team division with a
  // 500 solo price quoted 6000 on the review step and took 500 at Stripe.
  const division = {
    ...TEAM_DIVISION,
    fee_cents: 6000,
    free_agent_fee_cents: 500,
  };

  it("quotes the solo price for a solo sign-up", () => {
    expect(lineFeeCents({ free_agent: true }, division)).toBe(500);
  });

  it("quotes the team price for a team entry in the same division", () => {
    expect(lineFeeCents({ free_agent: false }, division)).toBe(6000);
  });

  it("falls back to the team price when no solo price is set", () => {
    expect(lineFeeCents({ free_agent: true }, { ...division, free_agent_fee_cents: null })).toBe(6000);
  });

  it("treats a zero solo price as free, not as unset", () => {
    // The `|| fee_cents` mistake would quote 6000 here — the full team fee
    // to someone the page is telling is free.
    expect(lineFeeCents({ free_agent: true }, { ...division, free_agent_fee_cents: 0 })).toBe(0);
  });
});


// Polish wave P4 (walkthrough W9): the review step labelled the WHOLE 23-pound cart "pay by card at sign-up" although one of its two
// entries was pay-the-organiser. Each line now carries its own division's method - and only a line that is charged now carries one.
describe("lineMethod - how ONE cart line is paid, for the review step's per-entry label (W9)", () => {
  const CARD: DivisionLike = { ...TEAM_DIVISION, division_id: "card", fee_cents: 1500, payment_method: "stripe" };
  const OFFLINE: DivisionLike = { ...TEAM_DIVISION, division_id: "offline", fee_cents: 800, payment_method: "offline" };
  const lineOf = (division: DivisionLike, patch: Partial<CartEntry> = {}) =>
    summarizeCart({ entries: [entry({ id: "e1", division_id: division.division_id, entrant_kind: "team", ...patch })] }, [division]).lines[0]!;

  it("a charged line reads its own division's method (the walkthrough's two entries, side by side)", () => {
    const summary = summarizeCart(
      { entries: [entry({ id: "a", division_id: "card", entrant_kind: "team" }), entry({ id: "b", division_id: "offline", entrant_kind: "team" })] },
      [CARD, OFFLINE],
    );
    expect(summary.lines.map(lineMethod)).toEqual(["stripe", "offline"]);
  });

  it("a line that is not charged now has no method: free, waitlisted, stale-closed, a free solo price, or an unknown division", () => {
    expect(lineMethod(lineOf({ ...CARD, fee_cents: 0 })), "free").toBeNull();
    expect(lineMethod(lineOf({ ...CARD, closed_reason: "full", remaining: 0 })), "waitlisted").toBeNull();
    expect(lineMethod(lineOf({ ...CARD, closed_reason: "window" })), "stale-closed").toBeNull();
    expect(lineMethod(lineOf({ ...CARD, free_agent_fee_cents: 0 }, { free_agent: true })), "a solo price of 0 on a paid division").toBeNull();
    expect(lineMethod(summarizeCart({ entries: [entry({ id: "e1", division_id: "ghost", entrant_kind: "team" })] }, []).lines[0]!), "unknown division").toBeNull();
  });

  it("the whole table: every method x fee x state resolves to the method exactly when the line is charged now (counted)", () => {
    let checked = 0;
    let labelled = 0;
    for (const method of ["stripe", "offline"] as const)
      for (const fee of [0, 1500] as const)
        for (const closed of [null, "full", "window"] as const) {
          // A "full" row is a full division on the wire: no places left. The other rows keep the fixture's places.
          const got = lineMethod(lineOf({ ...CARD, payment_method: method, fee_cents: fee, closed_reason: closed, remaining: closed === "full" ? 0 : CARD.remaining }));
          const charged = fee > 0 && closed === null;
          expect(got, `${method}/${fee}/${closed}`).toBe(charged ? method : null);
          checked += 1;
          if (got) labelled += 1;
        }
    expect(checked).toBe(12);
    expect(labelled, "premise: two rows are labelled (one per method)").toBe(2);
  });
});
