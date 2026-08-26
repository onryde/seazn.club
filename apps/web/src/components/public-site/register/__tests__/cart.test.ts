// RS006 chassis — cart reducer (pure, no DOM). Every action returns a NEW
// state (no mutation) so back-navigation + sessionStorage round-tripping
// (storage.ts) can treat CartState as a plain snapshot.
import { describe, expect, it } from "vitest";
import {
  MAX_ROSTER_PLAYERS,
  autoLinkObviousSelf,
  autoSeedSingleDivision,
  canAddEntry,
  cartReducer,
  clearSelfLinkWhenNotPlaying,
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

describe("cartReducer — SET_ANSWERS", () => {
  it("replaces the answers object for the matching entry only", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [
        entry({ id: "e1", division_id: "div-team", entrant_kind: "team" }),
        entry({ id: "e2", division_id: "div-team", entrant_kind: "team" }),
      ],
    };
    const next = cartReducer(cart, { type: "SET_ANSWERS", id: "e1", answers: { shirt_size: "L", court_rules_ack: true } });
    expect(next.entries[0]!.answers).toEqual({ shirt_size: "L", court_rules_ack: true });
    expect(next.entries[1]!.answers).toEqual({}); // untouched
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

  it("does nothing when the cart is empty or has 2+ entries — ambiguous, the rep must choose", () => {
    expect(autoLinkObviousSelf(EMPTY_CART, true)).toBe(EMPTY_CART);
    const two: CartState = {
      entries: [...oneEntry.entries, entry({ id: "e2", division_id: "d2", entrant_kind: "individual" })],
    };
    expect(autoLinkObviousSelf(two, true)).toBe(two);
  });

  it("re-links automatically when the rep un-links then re-toggles imPlaying (still exactly one entry, still no explicit choice)", () => {
    const unlinked: CartState = { entries: [{ ...oneEntry.entries[0]!, registering_self: false }] };
    const next = autoLinkObviousSelf(unlinked, true);
    expect(next.entries[0]!.registering_self).toBe(true);
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
