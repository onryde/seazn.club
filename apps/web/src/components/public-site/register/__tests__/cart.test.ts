// RS006 chassis — cart reducer (pure, no DOM). Every action returns a NEW
// state (no mutation) so back-navigation + sessionStorage round-tripping
// (storage.ts) can treat CartState as a plain snapshot.
import { describe, expect, it } from "vitest";
import {
  autoSeedSingleDivision,
  canAddEntry,
  cartReducer,
  toGroupEntry,
} from "../cart";
import { EMPTY_CART, MAX_CART_ENTRIES, type CartEntry, type CartState, type DivisionLike } from "../types";

const TEAM_DIVISION: DivisionLike = {
  division_id: "div-team",
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
};

const INDIVIDUAL_DIVISION: DivisionLike = {
  ...TEAM_DIVISION,
  division_id: "div-indiv",
  entrant_kind: "individual",
  allow_free_agents: false,
};

describe("cartReducer — ADD_ENTRY", () => {
  it("appends a new entry for the division, defaults blank", () => {
    const next = cartReducer(EMPTY_CART, {
      type: "ADD_ENTRY",
      id: "e1",
      division_id: TEAM_DIVISION.division_id,
      entrant_kind: TEAM_DIVISION.entrant_kind,
    });
    expect(next.entries).toEqual([
      {
        id: "e1",
        division_id: "div-team",
        entrant_kind: "team",
        team_name: null,
        partner_name: null,
        free_agent: false,
      },
    ]);
    // Does not touch the self-link.
    expect(next.selfEntryId).toBeNull();
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
      entries: Array.from({ length: MAX_CART_ENTRIES }, (_, i) => ({
        id: `e${i}`,
        division_id: "div-team",
        entrant_kind: "team" as const,
        team_name: null,
        partner_name: null,
        free_agent: false,
      })),
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
      entries: Array.from({ length: MAX_CART_ENTRIES }, (_, i) => ({
        id: `e${i}`,
        division_id: "d",
        entrant_kind: "individual" as const,
        team_name: null,
        partner_name: null,
        free_agent: false,
      })),
    };
    expect(canAddEntry(atCap)).toBe(false);
  });
});

describe("cartReducer — REMOVE_ENTRY", () => {
  const withTwo: CartState = {
    entries: [
      { id: "e1", division_id: "div-team", entrant_kind: "team", team_name: "Team A", partner_name: null, free_agent: false },
      { id: "e2", division_id: "div-indiv", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false },
    ],
    selfEntryId: "e2",
    selfPlayerIndex: 0,
  };

  it("drops the entry by id", () => {
    const next = cartReducer(withTwo, { type: "REMOVE_ENTRY", id: "e1" });
    expect(next.entries.map((e) => e.id)).toEqual(["e2"]);
  });

  it("clears the self-link when the removed entry WAS the self entry", () => {
    const next = cartReducer(withTwo, { type: "REMOVE_ENTRY", id: "e2" });
    expect(next.selfEntryId).toBeNull();
    expect(next.selfPlayerIndex).toBeNull();
  });

  it("leaves the self-link untouched when a different entry is removed", () => {
    const next = cartReducer(withTwo, { type: "REMOVE_ENTRY", id: "e1" });
    expect(next.selfEntryId).toBe("e2");
    expect(next.selfPlayerIndex).toBe(0);
  });
});

describe("cartReducer — DUPLICATE_ENTRY", () => {
  it("clones the division/kind with a FRESH id and blank name (not the source name)", () => {
    const one: CartState = {
      ...EMPTY_CART,
      entries: [
        { id: "e1", division_id: "div-team", entrant_kind: "team", team_name: "Team A", partner_name: null, free_agent: false },
      ],
    };
    const next = cartReducer(one, { type: "DUPLICATE_ENTRY", sourceId: "e1", newId: "e2" });
    expect(next.entries).toHaveLength(2);
    const clone = next.entries[1]!;
    expect(clone.id).toBe("e2");
    expect(clone.division_id).toBe("div-team");
    expect(clone.entrant_kind).toBe("team");
    expect(clone.team_name).toBeNull(); // "Team B" is the rep's call, not a guess
  });

  it("is a no-op at the cart cap", () => {
    const full: CartState = {
      ...EMPTY_CART,
      entries: Array.from({ length: MAX_CART_ENTRIES }, (_, i) => ({
        id: `e${i}`,
        division_id: "div-team",
        entrant_kind: "team" as const,
        team_name: null,
        partner_name: null,
        free_agent: false,
      })),
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
    entries: [
      { id: "e1", division_id: "div-team", entrant_kind: "team", team_name: null, partner_name: null, free_agent: false },
    ],
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

describe("cartReducer — SET_SELF_ENTRY (single-select cart-wide)", () => {
  const two: CartState = {
    entries: [
      { id: "e1", division_id: "div-team", entrant_kind: "team", team_name: "Team A", partner_name: null, free_agent: false },
      { id: "e2", division_id: "div-indiv", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false },
    ],
    selfEntryId: "e1",
    selfPlayerIndex: 2,
  };

  it("switching the self entry resets selfPlayerIndex (new entry's roster is unknown)", () => {
    const next = cartReducer(two, { type: "SET_SELF_ENTRY", id: "e2" });
    expect(next.selfEntryId).toBe("e2");
    expect(next.selfPlayerIndex).toBeNull();
  });

  it("passing null clears the self-link entirely", () => {
    const next = cartReducer(two, { type: "SET_SELF_ENTRY", id: null });
    expect(next.selfEntryId).toBeNull();
    expect(next.selfPlayerIndex).toBeNull();
  });

  it("at most one entry is ever self — setting a new one is exclusive by construction (single field, not per-entry flags)", () => {
    const next = cartReducer(two, { type: "SET_SELF_ENTRY", id: "e2" });
    const selfCount = next.entries.filter((e) => e.id === next.selfEntryId).length;
    expect(selfCount).toBe(1);
  });
});

describe("autoSeedSingleDivision — single-open-division collapse (RS006 prompt)", () => {
  it("seeds one blank entry for the division, marked self by default for an individual kind", () => {
    const entries = autoSeedSingleDivision(INDIVIDUAL_DIVISION, "seed-1");
    expect(entries).toEqual<CartEntry[]>([
      {
        id: "seed-1",
        division_id: "div-indiv",
        entrant_kind: "individual",
        team_name: null,
        partner_name: null,
        free_agent: false,
      },
    ]);
  });
});

describe("toGroupEntry — maps a CartEntry onto PublicRegisterGroupEntry's step-2 fields", () => {
  const entry: CartEntry = {
    id: "e1",
    division_id: "div-team",
    entrant_kind: "team",
    team_name: "Team A",
    partner_name: null,
    free_agent: false,
  };

  it("drops the client-only id and maps 1:1 otherwise", () => {
    const mapped = toGroupEntry(entry, { isSelf: false, selfPlayerIndex: null });
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
    const indiv: CartEntry = { ...entry, entrant_kind: "individual", team_name: null };
    const mapped = toGroupEntry(indiv, { isSelf: true, selfPlayerIndex: null });
    expect(mapped.registering_self).toBe(true);
    expect(mapped.self_player_index).toBeUndefined();
  });

  it("a team self entry carries self_player_index explicitly once step 3 resolves it", () => {
    const mapped = toGroupEntry(entry, { isSelf: true, selfPlayerIndex: 2 });
    expect(mapped.registering_self).toBe(true);
    expect(mapped.self_player_index).toBe(2);
  });
});
