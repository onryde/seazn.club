// RS006 chassis — WHO-step field requirements + validation, ENTRIES-step
// validation, DETAILS-step (step 3) validation (pure, no DOM).
import { describe, expect, it } from "vitest";
import { entryDetailsComplete, validateContact, validateDetails, validateEntries, whoFieldRequirements } from "../validation";
import {
  EMPTY_CART,
  EMPTY_CONTACT,
  EMPTY_ROSTER_PLAYER,
  type CartEntry,
  type CartState,
  type ContactState,
  type DivisionLike,
} from "../types";

const BASE_DIVISION: DivisionLike = {
  division_id: "d1",
  name: "Open",
  entrant_kind: "individual",
  category: null,
  age_min: null,
  age_max: null,
  requires_dob: false,
  requires_gender: false,
  allow_free_agents: false,
  open: true,
  closed_reason: null,
  capacity: null,
  remaining: null,
  taken: 0,
  opens_at: null,
  closes_at: null,
  fee_cents: 0,
  currency: "gbp",
  payment_method: "offline",
  form_fields: [],
};

/** Base fixture for a hand-built CartEntry — matches cart.test.ts's helper
 *  so every field a real reducer output would carry is present. */
function entry(overrides: Partial<CartEntry> & Pick<CartEntry, "id" | "division_id" | "entrant_kind">): CartEntry {
  return {
    team_name: null,
    partner_name: null,
    free_agent: false,
    players: [],
    answers: {},
    ...overrides,
  };
}

describe("whoFieldRequirements", () => {
  it("neither dob nor gender required when nothing needs them and the contact isn't playing", () => {
    expect(whoFieldRequirements([BASE_DIVISION], false)).toEqual({
      dobRequired: false,
      genderRequired: false,
    });
  });

  it("dob required when the contact toggles 'I'm playing' — INDEPENDENT of any division's requires_dob (schemas.ts superRefine: dob is required whenever any entry is registering_self)", () => {
    expect(whoFieldRequirements([BASE_DIVISION], true).dobRequired).toBe(true);
  });

  it("dob required when any OPEN division requires it, even if the contact isn't playing", () => {
    const withDob: DivisionLike = { ...BASE_DIVISION, requires_dob: true };
    expect(whoFieldRequirements([withDob], false).dobRequired).toBe(true);
  });

  it("a CLOSED division's requires_dob does not force the field (nothing can be added for it yet)", () => {
    const closedRequiresDob: DivisionLike = { ...BASE_DIVISION, requires_dob: true, open: false };
    expect(whoFieldRequirements([closedRequiresDob], false).dobRequired).toBe(false);
  });

  it("gender required when any open division requires it; imPlaying alone does not force gender", () => {
    const withGender: DivisionLike = { ...BASE_DIVISION, requires_gender: true };
    expect(whoFieldRequirements([withGender], false).genderRequired).toBe(true);
    expect(whoFieldRequirements([BASE_DIVISION], true).genderRequired).toBe(false);
  });
});

describe("validateContact", () => {
  const noneRequired = { dobRequired: false, genderRequired: false };

  it("requires a non-blank name and a valid email even when nothing else is required", () => {
    const r = validateContact(EMPTY_CONTACT, noneRequired);
    expect(r.valid).toBe(false);
    expect(r.errors.name).toBeTruthy();
    expect(r.errors.email).toBeTruthy();
  });

  it("rejects an obviously malformed email", () => {
    const c: ContactState = { ...EMPTY_CONTACT, name: "Alex Test", email: "not-an-email" };
    const r = validateContact(c, noneRequired);
    expect(r.valid).toBe(false);
    expect(r.errors.email).toBeTruthy();
  });

  it("passes with just name+email when nothing else is required", () => {
    const c: ContactState = { ...EMPTY_CONTACT, name: "Alex Test", email: "alex@example.com" };
    const r = validateContact(c, noneRequired);
    expect(r.valid).toBe(true);
    expect(r.errors.dob).toBeUndefined();
    expect(r.errors.gender).toBeUndefined();
  });

  it("blocks on a missing dob/gender when required, and passes once both are filled", () => {
    const required = { dobRequired: true, genderRequired: true };
    const partial: ContactState = { ...EMPTY_CONTACT, name: "Alex Test", email: "alex@example.com" };
    expect(validateContact(partial, required).valid).toBe(false);
    const full: ContactState = { ...partial, dob: "2000-01-01", gender: "x" };
    expect(validateContact(full, required).valid).toBe(true);
  });

  it("rejects a dob that isn't a real ISO date even when present", () => {
    const required = { dobRequired: true, genderRequired: false };
    const c: ContactState = { ...EMPTY_CONTACT, name: "Alex Test", email: "alex@example.com", dob: "not-a-date" };
    expect(validateContact(c, required).valid).toBe(false);
  });
});

describe("validateEntries", () => {
  const SEASON_START_YEAR = 2026;

  it("an empty cart is invalid — at least one entry is required to proceed", () => {
    expect(validateEntries(EMPTY_CART, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(false);
    expect(validateEntries(EMPTY_CART, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).error).toBe("cartEmpty");
  });

  it("one entry, any shape, is enough to proceed (naming is encouraged in the UI, not gated here — schemas.ts leaves team_name/partner_name nullish)", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team" })],
    };
    expect(validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  describe("self-linked ineligible entry blocks progression (fix wave finding #3)", () => {
    const WOMENS_DIVISION: DivisionLike = { ...BASE_DIVISION, division_id: "d-womens", category: "womens" };

    it("blocks with error 'selfIneligible' when the SELF-LINKED entry's division rejects the contact", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d-womens", entrant_kind: "individual" })],
        selfEntryId: "e1",
        selfPlayerIndex: 0,
      };
      const male: ContactState = { ...EMPTY_CONTACT, gender: "m" };
      const r = validateEntries(cart, [WOMENS_DIVISION], male, SEASON_START_YEAR);
      expect(r.valid).toBe(false);
      expect(r.error).toBe("selfIneligible");
    });

    it("passes when the self-linked entry's division accepts the contact", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d-womens", entrant_kind: "individual" })],
        selfEntryId: "e1",
        selfPlayerIndex: 0,
      };
      const female: ContactState = { ...EMPTY_CONTACT, gender: "f" };
      const r = validateEntries(cart, [WOMENS_DIVISION], female, SEASON_START_YEAR);
      expect(r.valid).toBe(true);
      expect(r.error).toBeNull();
    });

    it("an ineligible division does NOT block when it is not the self-linked one", () => {
      const cart: CartState = {
        entries: [
          entry({ id: "e1", division_id: "d-womens", entrant_kind: "individual" }),
          entry({ id: "e2", division_id: "d1", entrant_kind: "individual" }),
        ],
        selfEntryId: "e2", // linked to the OPEN/unrestricted division, not d-womens
        selfPlayerIndex: 0,
      };
      const male: ContactState = { ...EMPTY_CONTACT, gender: "m" };
      const r = validateEntries(cart, [WOMENS_DIVISION, BASE_DIVISION], male, SEASON_START_YEAR);
      expect(r.valid).toBe(true);
    });

    it("no self-link at all — never evaluates eligibility, even with an ineligible-shaped division in the cart", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d-womens", entrant_kind: "individual" })],
        selfEntryId: null,
        selfPlayerIndex: null,
      };
      const male: ContactState = { ...EMPTY_CONTACT, gender: "m" };
      expect(validateEntries(cart, [WOMENS_DIVISION], male, SEASON_START_YEAR).valid).toBe(true);
    });

    it("the self-linked entry's division missing from the list (data gap) does not crash and does not block", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d-unknown", entrant_kind: "individual" })],
        selfEntryId: "e1",
        selfPlayerIndex: 0,
      };
      expect(() => validateEntries(cart, [], EMPTY_CONTACT, SEASON_START_YEAR)).not.toThrow();
      expect(validateEntries(cart, [], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
    });
  });
});

describe("entryDetailsComplete", () => {
  it("a free-agent entry is always complete — 'nothing extra' (design §4 step 3)", () => {
    const freeAgent = entry({ id: "e1", division_id: "d1", entrant_kind: "team", free_agent: true });
    expect(entryDetailsComplete(freeAgent, BASE_DIVISION)).toBe(true);
  });

  describe("individual — exactly 1 named row required", () => {
    it("1 row, named -> complete", () => {
      const e = entry({ id: "e1", division_id: "d1", entrant_kind: "individual", players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }] });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(true);
    });

    it("1 row, blank name -> incomplete", () => {
      const e = entry({ id: "e1", division_id: "d1", entrant_kind: "individual", players: [EMPTY_ROSTER_PLAYER] });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(false);
    });

    it("0 rows -> incomplete (the schema requires exactly 1)", () => {
      const e = entry({ id: "e1", division_id: "d1", entrant_kind: "individual", players: [] });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(false);
    });
  });

  describe("pair — exactly 2 named rows required (the second IS the partner field)", () => {
    it("2 rows, both named -> complete", () => {
      const e = entry({
        id: "e1",
        division_id: "d1",
        entrant_kind: "pair",
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }, { ...EMPTY_ROSTER_PLAYER, full_name: "Sam" }],
      });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(true);
    });

    it("one row blank -> incomplete", () => {
      const e = entry({
        id: "e1",
        division_id: "d1",
        entrant_kind: "pair",
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }, EMPTY_ROSTER_PLAYER],
      });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(false);
    });

    it("only 1 row present -> incomplete (schema requires exactly 2)", () => {
      const e = entry({ id: "e1", division_id: "d1", entrant_kind: "pair", players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }] });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(false);
    });
  });

  describe("team — unconstrained roster (the schema places no minimum)", () => {
    it("0 rows -> complete (leave blank, organiser can fill in later)", () => {
      const e = entry({ id: "e1", division_id: "d1", entrant_kind: "team", players: [] });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(true);
    });

    it("all rows named -> complete, regardless of count", () => {
      const e = entry({
        id: "e1",
        division_id: "d1",
        entrant_kind: "team",
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "A" }, { ...EMPTY_ROSTER_PLAYER, full_name: "B" }],
      });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(true);
    });

    it("an EXISTING blank row blocks — added-then-left-blank is not the same as never adding it", () => {
      const e = entry({
        id: "e1",
        division_id: "d1",
        entrant_kind: "team",
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "A" }, EMPTY_ROSTER_PLAYER],
      });
      expect(entryDetailsComplete(e, BASE_DIVISION)).toBe(false);
    });
  });

  describe("required form_fields", () => {
    const DIVISION_WITH_FIELDS: DivisionLike = {
      ...BASE_DIVISION,
      form_fields: [
        { key: "shirt_size", label: "Shirt size", kind: "select", options: ["S", "M"], required: true },
        { key: "notes", label: "Notes", kind: "text", required: false },
        { key: "ack", label: "I agree", kind: "checkbox", required: true },
      ],
    };

    it("blocks when a required select/text answer is missing or blank", () => {
      const e = entry({
        id: "e1",
        division_id: "d1",
        entrant_kind: "individual",
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
        answers: { ack: true },
      });
      expect(entryDetailsComplete(e, DIVISION_WITH_FIELDS)).toBe(false);
    });

    it("blocks when a required checkbox is false/unanswered", () => {
      const e = entry({
        id: "e1",
        division_id: "d1",
        entrant_kind: "individual",
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
        answers: { shirt_size: "M" },
      });
      expect(entryDetailsComplete(e, DIVISION_WITH_FIELDS)).toBe(false);
    });

    it("a non-required field left blank never blocks", () => {
      const e = entry({
        id: "e1",
        division_id: "d1",
        entrant_kind: "individual",
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
        answers: { shirt_size: "M", ack: true },
      });
      expect(entryDetailsComplete(e, DIVISION_WITH_FIELDS)).toBe(true);
    });

    it("passes once every required field is answered", () => {
      const e = entry({
        id: "e1",
        division_id: "d1",
        entrant_kind: "individual",
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
        answers: { shirt_size: "M", ack: true, notes: "" },
      });
      expect(entryDetailsComplete(e, DIVISION_WITH_FIELDS)).toBe(true);
    });
  });
});

describe("validateDetails — step 3's Next gate", () => {
  const SEASON_START_YEAR = 2026;
  const MIXED_DIVISION: DivisionLike = { ...BASE_DIVISION, division_id: "d-mixed", entrant_kind: "team", category: "mixed" };

  it("blocks when any entry is structurally incomplete", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "individual", players: [EMPTY_ROSTER_PLAYER] })],
    };
    const r = validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR);
    expect(r.valid).toBe(false);
    expect(r.error).toBe("incomplete");
  });

  it("blocks a mixed-category roster with only one gender present, and clears once fixed (the meter's own scenario)", () => {
    const allMale: CartState = {
      ...EMPTY_CART,
      entries: [
        entry({
          id: "e1",
          division_id: "d-mixed",
          entrant_kind: "team",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "A", gender: "m" }, { ...EMPTY_ROSTER_PLAYER, full_name: "B", gender: "m" }],
        }),
      ],
    };
    expect(validateDetails(allMale, [MIXED_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(false);

    const fixed: CartState = {
      ...allMale,
      entries: [{ ...allMale.entries[0]!, players: [allMale.entries[0]!.players[0]!, { ...EMPTY_ROSTER_PLAYER, full_name: "C", gender: "f" }] }],
    };
    expect(validateDetails(fixed, [MIXED_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  it("passes an empty team roster on a mixed division as INCOMPLETE-safe (structurally allowed to be empty, but composition still unmet — MIXED_NEEDS_BOTH_GENDERS fires on zero players too)", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "d-mixed", entrant_kind: "team", players: [] })],
    };
    expect(validateDetails(cart, [MIXED_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(false);
  });

  it("a free-agent entry never blocks, even with an otherwise-ineligible-shaped division", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "d-mixed", entrant_kind: "team", free_agent: true })],
    };
    expect(validateDetails(cart, [MIXED_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  it("uses the CONTACT's dob/gender as a fallback for the self row — does not false-positive block on a blank self row (design: 'collected once')", () => {
    const genderNeeded: DivisionLike = { ...BASE_DIVISION, division_id: "d-womens", category: "womens" };
    const cart: CartState = {
      entries: [entry({ id: "e1", division_id: "d-womens", entrant_kind: "individual", players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Self" }] })],
      selfEntryId: "e1",
      selfPlayerIndex: 0,
    };
    const contact: ContactState = { ...EMPTY_CONTACT, gender: "f" };
    expect(validateDetails(cart, [genderNeeded], contact, SEASON_START_YEAR).valid).toBe(true);
  });

  it("blocks a self-linked TEAM/PAIR entry with no self_player_index resolved yet (schemas.ts superRefine would otherwise silently drop the link)", () => {
    const cart: CartState = {
      entries: [
        entry({
          id: "e1",
          division_id: "d1",
          entrant_kind: "team",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
        }),
      ],
      selfEntryId: "e1",
      selfPlayerIndex: null,
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(false);
  });

  it("does NOT block a self-linked INDIVIDUAL entry lacking self_player_index (schema implies index 0)", () => {
    const cart: CartState = {
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "individual", players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }] })],
      selfEntryId: "e1",
      selfPlayerIndex: null,
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  it("does NOT block a self-linked FREE-AGENT entry lacking self_player_index (no roster UI exists for it this session — documented seam, not a regression)", () => {
    const cart: CartState = {
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team", free_agent: true })],
      selfEntryId: "e1",
      selfPlayerIndex: null,
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  it("an unknown/stale division_id is skipped, not thrown on or blocked", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "d-gone", entrant_kind: "individual", players: [] })],
    };
    expect(() => validateDetails(cart, [], EMPTY_CONTACT, SEASON_START_YEAR)).not.toThrow();
    expect(validateDetails(cart, [], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  it("an empty cart is valid at this step (validateEntries already gates cart-emptiness on the PREVIOUS step)", () => {
    expect(validateDetails(EMPTY_CART, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });
});
