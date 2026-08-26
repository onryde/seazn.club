// RS006 chassis — WHO-step field requirements + validation, ENTRIES-step
// validation (pure, no DOM).
import { describe, expect, it } from "vitest";
import { validateContact, validateEntries, whoFieldRequirements } from "../validation";
import { EMPTY_CART, EMPTY_CONTACT, type CartState, type ContactState, type DivisionLike } from "../types";

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
};

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
      entries: [
        { id: "e1", division_id: "d1", entrant_kind: "team", team_name: null, partner_name: null, free_agent: false },
      ],
    };
    expect(validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  describe("self-linked ineligible entry blocks progression (fix wave finding #3)", () => {
    const WOMENS_DIVISION: DivisionLike = { ...BASE_DIVISION, division_id: "d-womens", category: "womens" };

    it("blocks with error 'selfIneligible' when the SELF-LINKED entry's division rejects the contact", () => {
      const cart: CartState = {
        entries: [{ id: "e1", division_id: "d-womens", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false }],
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
        entries: [{ id: "e1", division_id: "d-womens", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false }],
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
          { id: "e1", division_id: "d-womens", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false },
          { id: "e2", division_id: "d1", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false },
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
        entries: [{ id: "e1", division_id: "d-womens", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false }],
        selfEntryId: null,
        selfPlayerIndex: null,
      };
      const male: ContactState = { ...EMPTY_CONTACT, gender: "m" };
      expect(validateEntries(cart, [WOMENS_DIVISION], male, SEASON_START_YEAR).valid).toBe(true);
    });

    it("the self-linked entry's division missing from the list (data gap) does not crash and does not block", () => {
      const cart: CartState = {
        entries: [{ id: "e1", division_id: "d-unknown", entrant_kind: "individual", team_name: null, partner_name: null, free_agent: false }],
        selfEntryId: "e1",
        selfPlayerIndex: 0,
      };
      expect(() => validateEntries(cart, [], EMPTY_CONTACT, SEASON_START_YEAR)).not.toThrow();
      expect(validateEntries(cart, [], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
    });
  });
});
