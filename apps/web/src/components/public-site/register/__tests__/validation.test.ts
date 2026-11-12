// RS006 chassis — WHO-step field requirements + validation, ENTRIES-step
// validation, DETAILS-step (step 3) validation (pure, no DOM).
import { describe, expect, it } from "vitest";
import {
  entryDetailsComplete,
  guardianRequired,
  mixedPaymentConflict,
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
  free_agent_fee_cents: null,
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

  // INVERTED, RS007 — this test used to read "one entry, any shape, is enough
  // to proceed (naming is encouraged in the UI, not gated here — api-v1/schemas/
  // leaves team_name/partner_name nullish)" and passed a NAMELESS TEAM entry.
  // It was asserting one side of a client/server disagreement as though it
  // were the contract: `registration-submit.ts`'s `entryDisplayName` 422s that
  // exact entry with "A team name is required". The test froze the bug, which
  // is why five waves of green never surfaced it. Kept and corrected rather
  // than deleted, so the inversion stays visible to the next reader.
  it("one NAMED entry is enough to proceed — the shape still doesn't matter beyond the name the server demands", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team", team_name: "Rockets" })],
    };
    expect(validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
  });

  it("the same entry WITHOUT a name does not proceed — the pre-RS007 assertion, now the defect probe", () => {
    const cart: CartState = {
      ...EMPTY_CART,
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team" })],
    };
    expect(validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(false);
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

  // RS007. This closed a CLIENT/SERVER DISAGREEMENT, not a missing nicety:
  // validation.ts asserted naming was "encouraged in the UI but not required"
  // while registration-submit.ts's `entryDisplayName` 422s a nameless TEAM
  // entry. The zod schema leaves it nullish, so nothing in between caught it,
  // and the registrant met "A team name is required" only after five steps —
  // a message naming neither the step nor which of up to ten entries.
  describe("a team entry with no name blocks its own step, attributed to the entry", () => {
    it("blocks with missingTeamNameEntryId set — error stays null, per-entry cause like staleClosedEntryId", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team", team_name: null })],
      };
      const r = validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.valid).toBe(false);
      expect(r.error).toBeNull();
      expect(r.missingTeamNameEntryId).toBe("e1");
    });

    it("treats whitespace as absent — the server trims before deciding, so a space would 422 at submit", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team", team_name: "   " })],
      };
      expect(validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).missingTeamNameEntryId).toBe("e1");
    });

    it("names the OFFENDING entry, not the first one — the whole point of attributing it", () => {
      const cart: CartState = {
        entries: [
          entry({ id: "e1", division_id: "d1", entrant_kind: "team", team_name: "Rockets" }),
          entry({ id: "e2", division_id: "d1", entrant_kind: "team", team_name: null }),
        ],
      };
      expect(validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).missingTeamNameEntryId).toBe("e2");
    });

    // The three cases the SERVER accepts without a name. Blocking any of them
    // would be the same defect in the opposite direction — a client refusing
    // a submission the server would have taken.
    it("does NOT block a free agent — entrant_kind 'team' but one person, named from the contact server-side", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team", free_agent: true, team_name: null })],
      };
      const r = validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.valid).toBe(true);
      expect(r.missingTeamNameEntryId).toBeNull();
    });

    it("does NOT block a nameless pair — the server composes 'A & B' from the players", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "pair", team_name: null })],
      };
      expect(validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).missingTeamNameEntryId).toBeNull();
    });

    it("does NOT block an individual", () => {
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "individual", team_name: null })],
      };
      expect(validateEntries(cart, [BASE_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).missingTeamNameEntryId).toBeNull();
    });

    it("reports a stale-closed division FIRST — that one loses the entire cart at submit, a missing name is a local typo", () => {
      const stale: DivisionLike = { ...BASE_DIVISION, division_id: "d-stale", closed_reason: "window" };
      const cart: CartState = {
        entries: [entry({ id: "e1", division_id: "d-stale", entrant_kind: "team", team_name: null })],
      };
      const r = validateEntries(cart, [stale], EMPTY_CONTACT, SEASON_START_YEAR);
      expect(r.staleClosedEntryId).toBe("e1");
      expect(r.missingTeamNameEntryId).toBeNull();
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
  // Polish wave P5 (H-1): a solo sign-up's Details step collects its player (Assign places that row), so its one row must be named.
  // A solo with no row at all (a cart saved before this) stays complete: the server makes the row from the contact.
  it("a free-agent entry is complete when its one row is named, or when it has no row (an older cart); a blank row is not", () => {
    const solo = (players: CartEntry["players"]) => entry({ id: "e1", division_id: "d1", entrant_kind: "team", free_agent: true, players });
    const table: [CartEntry["players"], boolean][] = [
      [[], true],
      [[{ ...EMPTY_ROSTER_PLAYER }], false],
      [[{ ...EMPTY_ROSTER_PLAYER, full_name: "   " }], false],
      [[{ ...EMPTY_ROSTER_PLAYER, full_name: "Priya Raman" }], true],
    ];
    for (const [players, want] of table) expect(entryDetailsComplete(solo(players), BASE_DIVISION), JSON.stringify(players)).toBe(want);
    expect(table.length, "four solo shapes checked").toBe(4);
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

  // H-1: the solo's ONE row is held to the person's own eligibility (the server's rule), never to a team's composition.
  it("a solo's named row in a mixed division passes (one player is never a mixed roster); its own age band still blocks", () => {
    const solo = (division_id: string, dob: string | null) =>
      entry({
        id: "e1",
        division_id,
        entrant_kind: "team",
        free_agent: true,
        players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Mia Solo", gender: "f", dob }],
      });
    expect(validateDetails({ ...EMPTY_CART, entries: [solo("d-mixed", null)] }, [MIXED_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(true);
    const under12: DivisionLike = { ...BASE_DIVISION, division_id: "d-u12", entrant_kind: "team", age_max: 11, requires_dob: true };
    expect(validateDetails({ ...EMPTY_CART, entries: [solo("d-u12", "1990-01-01")] }, [under12], EMPTY_CONTACT, SEASON_START_YEAR).valid).toBe(false);
    expect(
      validateDetails({ ...EMPTY_CART, entries: [{ ...solo("d-mixed", null), players: [{ ...EMPTY_ROSTER_PLAYER }] }] }, [MIXED_DIVISION], EMPTY_CONTACT, SEASON_START_YEAR),
    ).toEqual({ valid: false, error: "incomplete" });
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

  // H-1: a solo sign-up's row is the registrant's own (the server treats it as their self row), so a minor there needs a guardian -
  // from the row's own dob, falling back to the contact's, exactly as a self-linked row.
  it("a solo sign-up counts as registering yourself: its row's dob (else the contact's) decides", () => {
    const solo = (dob: string | null) => ({
      entries: [entry({ id: "e1", division_id: "d1", entrant_kind: "team", free_agent: true, players: [{ ...EMPTY_ROSTER_PLAYER, full_name: "Kid", dob }] })],
    });
    const table: [string | null, string | null, boolean][] = [
      ["2015-01-01", "1990-01-01", true],
      ["1990-01-01", "2015-01-01", false],
      [null, "2015-01-01", true],
      [null, null, false],
    ];
    for (const [rowDob, contactDob, want] of table) {
      expect(guardianRequired(solo(rowDob), { dob: contactDob }, NOW), `${rowDob} / ${contactDob}`).toBe(want);
    }
    expect(table.length, "four solo dob shapes checked").toBe(4);
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

// ---------------------------------------------------------------------------
// Polish wave P4 (walkthrough W9) — a cart that mixes card and pay-the-organiser divisions can never be collected in one session, and the
// server refuses it. The form used to let the registrant add both, fill four steps, and refuse only at submit. These are the rules the
// ENTRIES step now applies as the second division is added; they mirror registration-submit.ts's assertUniformPaymentMethod: only a
// division that actually charges (fee_cents > 0) counts, and a waitlisted one still does (the structural check runs before waitlisting).
// ---------------------------------------------------------------------------

describe("mixedPaymentConflict / validateEntries — a mixed card + offline cart is refused on the ENTRIES step (W9)", () => {
  const SEASON_START_YEAR = 2026;
  const CARD: DivisionLike = { ...BASE_DIVISION, division_id: "d-card", name: "Open Singles", fee_cents: 1500, payment_method: "stripe" };
  const OFFLINE: DivisionLike = { ...BASE_DIVISION, division_id: "d-off", name: "Social Singles", fee_cents: 800, payment_method: "offline" };
  const cartFor = (...divisionIds: string[]): CartState => ({
    entries: divisionIds.map((id, i) => entry({ id: `e${i}`, division_id: id, entrant_kind: "individual" })),
  });

  it("the walkthrough's cart (Open Singles by card, Social Singles to the organiser) names BOTH divisions", () => {
    expect(mixedPaymentConflict(cartFor("d-card", "d-off"), [CARD, OFFLINE])).toEqual({
      cardDivision: "Open Singles",
      offlineDivision: "Social Singles",
    });
    // Cart order does not matter: the card division is still the card one.
    expect(mixedPaymentConflict(cartFor("d-off", "d-card"), [CARD, OFFLINE])).toEqual({
      cardDivision: "Open Singles",
      offlineDivision: "Social Singles",
    });
  });

  it("blocks Next with a per-cart cause (error stays null, like the stale-closed and team-name causes) and clears once one side is removed", () => {
    const mixed = validateEntries(cartFor("d-card", "d-off"), [CARD, OFFLINE], EMPTY_CONTACT, SEASON_START_YEAR);
    expect(mixed.valid).toBe(false);
    expect(mixed.error).toBeNull();
    expect(mixed.mixedPayment).toEqual({ cardDivision: "Open Singles", offlineDivision: "Social Singles" });
    const onlyCard = validateEntries(cartFor("d-card"), [CARD, OFFLINE], EMPTY_CONTACT, SEASON_START_YEAR);
    expect(onlyCard.valid).toBe(true);
    expect(onlyCard.mixedPayment).toBeNull();
  });

  it("the empty case: an empty cart and a one-entry cart are never a conflict", () => {
    expect(mixedPaymentConflict(EMPTY_CART, [CARD, OFFLINE])).toBeNull();
    expect(mixedPaymentConflict(cartFor("d-card"), [CARD, OFFLINE])).toBeNull();
    expect(mixedPaymentConflict(cartFor("d-card", "d-card"), [CARD, OFFLINE]), "the same division twice (Add another)").toBeNull();
  });

  it("a division the server never collects for (fee 0) imposes no constraint, whatever its method", () => {
    const freeOffline: DivisionLike = { ...OFFLINE, division_id: "d-free", fee_cents: 0 };
    const freeCard: DivisionLike = { ...CARD, division_id: "d-free-card", fee_cents: 0 };
    expect(mixedPaymentConflict(cartFor("d-card", "d-free"), [CARD, freeOffline])).toBeNull();
    expect(mixedPaymentConflict(cartFor("d-off", "d-free-card"), [OFFLINE, freeCard])).toBeNull();
  });

  it("a waitlisted division still counts: the server's structural check runs before waitlisting", () => {
    const fullOffline: DivisionLike = { ...OFFLINE, closed_reason: "full" };
    expect(mixedPaymentConflict(cartFor("d-card", "d-off"), [CARD, fullOffline])).not.toBeNull();
  });

  it("an entry whose division is unknown, or a division with no method/fee given, is never a conflict (degrade, do not throw)", () => {
    expect(mixedPaymentConflict(cartFor("d-card", "ghost"), [CARD])).toBeNull();
    expect(mixedPaymentConflict(cartFor("a", "b"), [{ division_id: "a" }, { division_id: "b" }])).toBeNull();
  });

  it("the whole table: every method pair x fee pair conflicts exactly when both charge and the methods differ (counted)", () => {
    const methods = ["stripe", "offline"] as const;
    const fees = [0, 1000] as const;
    let checked = 0;
    let conflicts = 0;
    for (const m1 of methods)
      for (const m2 of methods)
        for (const f1 of fees)
          for (const f2 of fees) {
            const a: DivisionLike = { ...BASE_DIVISION, division_id: "a", name: "A", fee_cents: f1, payment_method: m1 };
            const b: DivisionLike = { ...BASE_DIVISION, division_id: "b", name: "B", fee_cents: f2, payment_method: m2 };
            const want = f1 > 0 && f2 > 0 && m1 !== m2;
            expect(mixedPaymentConflict(cartFor("a", "b"), [a, b]) !== null, `${m1}/${f1} + ${m2}/${f2}`).toBe(want);
            checked += 1;
            if (want) conflicts += 1;
          }
    expect(checked).toBe(16);
    expect(conflicts, "premise: the table has conflicting rows (two: stripe+offline both ways round)").toBe(2);
  });
});
