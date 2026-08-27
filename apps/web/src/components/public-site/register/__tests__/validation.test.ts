// RS006 chassis — WHO-step field requirements + validation, ENTRIES-step
// validation, DETAILS-step (step 3) validation (pure, no DOM).
import { describe, expect, it } from "vitest";
import {
  entryDetailsComplete,
  guardianRequired,
  validateConsent,
  validateContact,
  validateDetails,
  validateEntries,
  whoFieldRequirements,
} from "../validation";
import {
  EMPTY_CART,
  EMPTY_CONSENT,
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
    registering_self: false,
    self_player_index: null,
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

  it("review finding 3 (2026-08-27): an open division's requires_dob alone does NOT force the field when the contact isn't playing — the field only ever feeds the self-row fallback, which never fires for a non-playing contact", () => {
    const withDob: DivisionLike = { ...BASE_DIVISION, requires_dob: true };
    expect(whoFieldRequirements([withDob], false).dobRequired).toBe(false);
  });

  it("a CLOSED division's requires_dob does not force the field even while playing (nothing can be added for it yet) — imPlaying alone is what forces it open", () => {
    const closedRequiresDob: DivisionLike = { ...BASE_DIVISION, requires_dob: true, open: false };
    expect(whoFieldRequirements([closedRequiresDob], false).dobRequired).toBe(false);
    expect(whoFieldRequirements([closedRequiresDob], true).dobRequired).toBe(true);
  });

  it("review finding 3 (2026-08-27): gender is required only when the contact is BOTH playing AND some open division needs it — never from division alone, and imPlaying alone does not force it either (the schema never requires contact.gender at all)", () => {
    const withGender: DivisionLike = { ...BASE_DIVISION, requires_gender: true };
    expect(whoFieldRequirements([withGender], false).genderRequired).toBe(false);
    expect(whoFieldRequirements([BASE_DIVISION], true).genderRequired).toBe(false);
    expect(whoFieldRequirements([withGender], true).genderRequired).toBe(true);
  });

  it("review finding 3 (2026-08-27): a non-playing contact needs NEITHER field, even facing a division that requires both", () => {
    const needsBoth: DivisionLike = { ...BASE_DIVISION, requires_dob: true, requires_gender: true };
    expect(whoFieldRequirements([needsBoth], false)).toEqual({ dobRequired: false, genderRequired: false });
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
        entries: [entry({ id: "e1", division_id: "d-womens", entrant_kind: "individual", registering_self: true, self_player_index: 0 })],
      };
      const male: ContactState = { ...EMPTY_CONTACT, gender: "m" };
      const r = validateEntries(cart, [WOMENS_DIVISION], male, SEASON_START_YEAR);
      expect(r.valid).toBe(false);
      expect(r.error).toBe("selfIneligible");
    });

    it("passes when the self-linked entry's division accepts the contact", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d-womens", entrant_kind: "individual", registering_self: true, self_player_index: 0 })],
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
          entry({ id: "e2", division_id: "d1", entrant_kind: "individual", registering_self: true, self_player_index: 0 }), // linked to the OPEN/unrestricted division, not d-womens
        ],
      };
      const male: ContactState = { ...EMPTY_CONTACT, gender: "m" };
      const r = validateEntries(cart, [WOMENS_DIVISION, BASE_DIVISION], male, SEASON_START_YEAR);
      expect(r.valid).toBe(true);
    });

    it("no self-link at all — never evaluates eligibility, even with an ineligible-shaped division in the cart", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d-womens", entrant_kind: "individual" })],
      };
      const male: ContactState = { ...EMPTY_CONTACT, gender: "m" };
      expect(validateEntries(cart, [WOMENS_DIVISION], male, SEASON_START_YEAR).valid).toBe(true);
    });

    it("the self-linked entry's division missing from the list (data gap) does not crash and does not block", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d-unknown", entrant_kind: "individual", registering_self: true, self_player_index: 0 })],
      };
      expect(() => validateEntries(cart, [], EMPTY_CONTACT, SEASON_START_YEAR)).not.toThrow();
      expect(validateEntries(cart, [], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
    });

    it("RS006: TWO self-linked entries — blocks if EITHER is ineligible for the contact, not just the first", () => {
      const cart: CartState = {
        entries: [
          entry({ id: "e1", division_id: "d1", entrant_kind: "individual", registering_self: true, self_player_index: 0 }), // eligible
          entry({ id: "e2", division_id: "d-womens", entrant_kind: "individual", registering_self: true, self_player_index: 0 }), // ineligible
        ],
      };
      const male: ContactState = { ...EMPTY_CONTACT, gender: "m" };
      const r = validateEntries(cart, [BASE_DIVISION, WOMENS_DIVISION], male, SEASON_START_YEAR);
      expect(r.valid).toBe(false);
      expect(r.error).toBe("selfIneligible");
    });

    it("RS006: TWO self-linked entries, BOTH eligible — passes", () => {
      const cart: CartState = {
        entries: [
          entry({ id: "e1", division_id: "d1", entrant_kind: "individual", registering_self: true, self_player_index: 0 }),
          entry({ id: "e2", division_id: "d-womens", entrant_kind: "individual", registering_self: true, self_player_index: 0 }),
        ],
      };
      const female: ContactState = { ...EMPTY_CONTACT, gender: "f" };
      const r = validateEntries(cart, [BASE_DIVISION, WOMENS_DIVISION], female, SEASON_START_YEAR);
      expect(r.valid).toBe(true);
    });
  });

  describe("review finding 2 (2026-08-27): a stale-closed division blocks progress, attributed to the entry, unless it's a waitlist ('full')", () => {
    const STALE_WINDOW_DIVISION: DivisionLike = { ...BASE_DIVISION, division_id: "d-stale", closed_reason: "window" };
    const STALE_PAYMENTS_DIVISION: DivisionLike = {
      ...BASE_DIVISION,
      division_id: "d-stale-pay",
      closed_reason: "payments_unavailable",
    };
    const FULL_DIVISION: DivisionLike = { ...BASE_DIVISION, division_id: "d-full", closed_reason: "full" };

    it("blocks with staleClosedEntryId set to the offending entry's id — error stays null, this is a per-entry cause, not a cart-wide banner code", () => {
      const cart: CartState = { entries: [entry({ id: "e1", division_id: "d-stale", entrant_kind: "individual" })] };
      const r = validateEntries(cart, [STALE_WINDOW_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.valid).toBe(false);
      expect(r.error).toBeNull();
      expect(r.staleClosedEntryId).toBe("e1");
    });

    it("blocks for 'payments_unavailable' too — every non-'full' closed_reason blocks", () => {
      const cart: CartState = { entries: [entry({ id: "e1", division_id: "d-stale-pay", entrant_kind: "individual" })] };
      const r = validateEntries(cart, [STALE_PAYMENTS_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.valid).toBe(false);
      expect(r.staleClosedEntryId).toBe("e1");
    });

    it("does NOT block on closed_reason 'full' — that path legitimately waitlists (summarizeCart's own waitlisted/staleClosed split)", () => {
      const cart: CartState = { entries: [entry({ id: "e1", division_id: "d-full", entrant_kind: "individual" })] };
      const r = validateEntries(cart, [FULL_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.valid).toBe(true);
      expect(r.staleClosedEntryId).toBeNull();
    });

    it("blocks regardless of self-link — an entry nobody is playing themselves still blocks the whole cart at submit", () => {
      const cart: CartState = { entries: [entry({ id: "e1", division_id: "d-stale", entrant_kind: "team" })] };
      const r = validateEntries(cart, [STALE_WINDOW_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.valid).toBe(false);
      expect(r.staleClosedEntryId).toBe("e1");
    });

    it("names the stale-closed entry even when a valid sibling entry is also in the cart", () => {
      const cart: CartState = {
        entries: [
          entry({ id: "e1", division_id: "d1", entrant_kind: "individual" }), // BASE_DIVISION — open, unaffected
          entry({ id: "e2", division_id: "d-stale", entrant_kind: "individual" }),
        ],
      };
      const r = validateEntries(cart, [BASE_DIVISION, STALE_WINDOW_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.valid).toBe(false);
      expect(r.staleClosedEntryId).toBe("e2");
    });

    it("an entry whose division is missing from the list (data gap) does not crash and does not block — same degrade-don't-throw precedent as the self-eligibility gate above", () => {
      const cart: CartState = { entries: [entry({ id: "e1", division_id: "d-unknown", entrant_kind: "individual" })] };
      expect(() => validateEntries(cart, [], EMPTY_CONTACT, SEASON_START_YEAR)).not.toThrow();
      const r = validateEntries(cart, [], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.valid).toBe(true);
      expect(r.staleClosedEntryId).toBeNull();
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
      entries: [
        entry({
          id: "e1",
          division_id: "d-womens",
          entrant_kind: "individual",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Self" }],
          registering_self: true,
          self_player_index: 0,
        }),
      ],
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
          registering_self: true,
          self_player_index: null,
        }),
      ],
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(false);
  });

  // RS006 follow-up. Every OTHER step-3 blocker has inline state of its own —
  // roster rows, the mixed meter, required-field markers. This one had none,
  // so a complete-looking roster with the self picker left on "None of these"
  // produced a dead Next under a step-wide "fill in the missing details
  // above" that marked no field at all. Reported distinctly so the banner can
  // name it and entry-details.tsx can flag the picker itself.
  it("reports an unresolved self_player_index as selfRowUnnamed, not the generic incomplete", () => {
    const cart: CartState = {
      entries: [
        entry({
          id: "e1",
          division_id: "d1",
          entrant_kind: "team",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
          registering_self: true,
          self_player_index: null,
        }),
      ],
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).error).toBe("selfRowUnnamed");
  });

  it("still reports a genuinely incomplete roster as incomplete — the two blockers stay distinguishable", () => {
    const cart: CartState = {
      entries: [
        entry({
          id: "e1",
          division_id: "d1",
          entrant_kind: "team",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "   " }],
          registering_self: true,
          self_player_index: 0,
        }),
      ],
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).error).toBe("incomplete");
  });

  it("does NOT block a self-linked INDIVIDUAL entry lacking self_player_index (schema implies index 0)", () => {
    const cart: CartState = {
      entries: [
        entry({
          id: "e1",
          division_id: "d1",
          entrant_kind: "individual",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
          registering_self: true,
          self_player_index: null,
        }),
      ],
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  it("does NOT block a self-linked FREE-AGENT entry lacking self_player_index (no roster UI exists for it this session — documented seam, not a regression)", () => {
    const cart: CartState = {
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team", free_agent: true, registering_self: true, self_player_index: null })],
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  it("RS006: TWO self-linked entries — an unresolved self_player_index on EITHER one blocks, not just the first", () => {
    const cart: CartState = {
      entries: [
        entry({
          id: "e1",
          division_id: "d1",
          entrant_kind: "individual",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
          registering_self: true,
          self_player_index: null, // implied 0 — fine
        }),
        entry({
          id: "e2",
          division_id: "d1",
          entrant_kind: "team",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
          registering_self: true,
          self_player_index: null, // team needs an EXPLICIT index — unresolved
        }),
      ],
    };
    expect(validateDetails(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(false);
  });

  it("RS006: TWO self-linked entries, both fully resolved — passes", () => {
    const cart: CartState = {
      entries: [
        entry({
          id: "e1",
          division_id: "d1",
          entrant_kind: "individual",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
          registering_self: true,
          self_player_index: null,
        }),
        entry({
          id: "e2",
          division_id: "d1",
          entrant_kind: "team",
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Alex" }],
          registering_self: true,
          self_player_index: 0,
        }),
      ],
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

// ---------------------------------------------------------------------------
// CONSENT (step 4) — guardianRequired mirrors registration-submit.ts's own
// gate (~line 430-444): true when ANY self-linked entry's EFFECTIVE self dob
// (roster.ts's effectiveSelfDob — the roster row's own dob, falling back to
// contact.dob) is under 18, not just contact.dob alone (guardian-consent-
// bypass fix, HIGH, 2026-08-26 — effectiveSelfDob's own test file,
// roster.test.ts, covers the row-resolution cases in more depth). Keyed off
// the CART's actual self-link, not the WHO step's imPlaying toggle — see
// cart.ts's registeringSelfAnywhere doc comment.
// ---------------------------------------------------------------------------

describe("guardianRequired", () => {
  const NOW = new Date("2026-06-15T00:00:00Z");
  const selfLinkedCart: CartState = {
    entries: [
      entry({ id: "e1", division_id: "d1", entrant_kind: "individual", registering_self: true, self_player_index: 0 }),
    ],
  };
  const unlinkedCart: CartState = {
    entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "individual" })],
  };

  it("false when the cart has no self-linked entry at all, regardless of dob", () => {
    expect(guardianRequired(unlinkedCart, { dob: "2015-01-01" }, NOW)).toBe(false);
  });

  it("false when the contact has no dob yet", () => {
    expect(guardianRequired(selfLinkedCart, { dob: null }, NOW)).toBe(false);
  });

  it("false when self-linked but the contact is an adult", () => {
    expect(guardianRequired(selfLinkedCart, { dob: "1990-01-01" }, NOW)).toBe(false);
  });

  it("true when self-linked AND the contact is under 18", () => {
    expect(guardianRequired(selfLinkedCart, { dob: "2015-01-01" }, NOW)).toBe(true);
  });

  it("guardian bypass fix: true when the self row's OWN dob is a minor's, even though contact.dob is an adult", () => {
    const cart: CartState = {
      entries: [
        entry({
          id: "e1",
          division_id: "d1",
          entrant_kind: "individual",
          registering_self: true,
          self_player_index: 0,
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Self", dob: "2015-01-01" }],
        }),
      ],
    };
    expect(guardianRequired(cart, { dob: "1990-01-01" }, NOW)).toBe(true);
  });

  it("guardian bypass fix: false when the self row's own dob is an adult's, even though contact.dob is a minor's (the row wins in both directions)", () => {
    const cart: CartState = {
      entries: [
        entry({
          id: "e1",
          division_id: "d1",
          entrant_kind: "individual",
          registering_self: true,
          self_player_index: 0,
          players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Self", dob: "1990-01-01" }],
        }),
      ],
    };
    expect(guardianRequired(cart, { dob: "2015-01-01" }, NOW)).toBe(false);
  });
});

describe("validateConsent", () => {
  const NOW = new Date("2026-06-15T00:00:00Z");
  const adultContact: ContactState = { ...EMPTY_CONTACT, dob: "1990-01-01" };
  const minorSelfContact: ContactState = { ...EMPTY_CONTACT, dob: "2015-01-01" };
  const selfLinkedCart: CartState = {
    entries: [
      entry({ id: "e1", division_id: "d1", entrant_kind: "individual", registering_self: true, self_player_index: 0 }),
    ],
  };
  const unlinkedCart: CartState = {
    entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "individual" })],
  };

  it("invalid without privacy consent, regardless of anything else", () => {
    const result = validateConsent(unlinkedCart, adultContact, EMPTY_CONSENT, NOW);
    expect(result.valid).toBe(false);
    expect(result.errors.privacy).toBe("required");
  });

  it("valid with privacy consent alone when no guardian is needed", () => {
    const result = validateConsent(unlinkedCart, adultContact, { ...EMPTY_CONSENT, privacy_consent: true }, NOW);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it("media consent is never required — omitting it never blocks", () => {
    const result = validateConsent(unlinkedCart, adultContact, { privacy_consent: true, media_consent: false }, NOW);
    expect(result.valid).toBe(true);
  });

  it("a self-registering minor without guardian name/consent is blocked, even with privacy consent given", () => {
    const result = validateConsent(selfLinkedCart, minorSelfContact, { ...EMPTY_CONSENT, privacy_consent: true }, NOW);
    expect(result.valid).toBe(false);
    expect(result.errors.guardianName).toBe("required");
    expect(result.errors.guardianConsent).toBe("required");
  });

  it("a self-registering minor with BOTH guardian fields given is valid", () => {
    const contact: ContactState = { ...minorSelfContact, guardian_name: "Pat Guardian", guardian_consent: true };
    const result = validateConsent(selfLinkedCart, contact, { ...EMPTY_CONSENT, privacy_consent: true }, NOW);
    expect(result.valid).toBe(true);
  });

  it("guardian name alone, without the consent checkbox, still blocks — and does not falsely report the name as missing", () => {
    const contact: ContactState = { ...minorSelfContact, guardian_name: "Pat Guardian", guardian_consent: false };
    const result = validateConsent(selfLinkedCart, contact, { ...EMPTY_CONSENT, privacy_consent: true }, NOW);
    expect(result.valid).toBe(false);
    expect(result.errors.guardianConsent).toBe("required");
    expect(result.errors.guardianName).toBeUndefined();
  });

  it("a minor NOT self-registering (nobody linked) never needs a guardian", () => {
    const result = validateConsent(unlinkedCart, minorSelfContact, { ...EMPTY_CONSENT, privacy_consent: true }, NOW);
    expect(result.valid).toBe(true);
  });
});
