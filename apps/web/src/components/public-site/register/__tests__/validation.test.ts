// RS006 chassis — WHO-step field requirements + validation, ENTRIES-step
// validation (pure, no DOM).
import { describe, expect, it } from "vitest";
import { validateContact, validateEntries, whoFieldRequirements } from "../validation";
import { EMPTY_CART, EMPTY_CONTACT, type CartState, type ContactState, type DivisionLike } from "../types";

const BASE_DIVISION: DivisionLike = {
  division_id: "d1",
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
  it("an empty cart is invalid — at least one entry is required to proceed", () => {
    expect(validateEntries(EMPTY_CART).valid).toBe(false);
  });

  it("one entry, any shape, is enough to proceed (naming is encouraged in the UI, not gated here — schemas.ts leaves team_name/partner_name nullish)", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [
        { id: "e1", division_id: "d1", entrant_kind: "team", team_name: null, partner_name: null, free_agent: false },
      ],
    };
    expect(validateEntries(cart).valid).toBe(true);
  });
});
