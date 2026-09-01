// RS004 W3c — pure state shaping for the config panel: GET response +
// division eligibility -> local edit state -> the two save payloads. Kept
// DOM-free and separate from the component so the full-replace hazard (PUT
// /registration-settings clears any field the request omits) is provable
// without the hook harness.
import { describe, expect, it } from "vitest";
import {
  initialConfigState,
  toDivisionPatchBody,
  toRegistrationSettingsPutBody,
  validateConfigState,
  type RegistrationConfigState,
  type RegistrationSettingsResponse,
} from "@/components/registration-hub-config-state";
import type { FormField } from "@/components/registration-hub-form-builder";

const FORM_FIELDS: FormField[] = [
  { key: "shirt_size", label: "Shirt size", kind: "text", required: true },
];

const RESPONSE: RegistrationSettingsResponse = {
  division_id: "div-1",
  enabled: true,
  entrant_kind: "team",
  opens_at: "2026-01-01T00:00:00Z",
  closes_at: "2026-02-01T00:00:00Z",
  capacity: 32,
  fee_cents: 1500,
  free_agent_fee_cents: null,
  currency: "usd",
  refund_lock_at: "2026-01-20T00:00:00Z",
  place_by_at: "2026-01-25T00:00:00Z",
  form_fields: FORM_FIELDS,
  payment_method: "stripe",
  payment_instructions: null,
  approval: "manual",
  allow_free_agents: true,
  org_payment_instructions: "Pay the club treasurer.",
  org_default_payment_method: "offline",
  charges_enabled: true,
  updated_at: "2026-01-05T00:00:00Z",
};

const NO_ELIGIBILITY = {
  category: null,
  age_min: null,
  age_max: null,
  age_cutoff_month: null,
  age_cutoff_day: null,
  eligibility_note: null,
};

describe("initialConfigState", () => {
  it("takes registration_settings fields from the GET response", () => {
    const state = initialConfigState(RESPONSE, NO_ELIGIBILITY);
    expect(state.enabled).toBe(true);
    expect(state.entrant_kind).toBe("team");
    expect(state.opens_at).toBe("2026-01-01T00:00:00Z");
    expect(state.closes_at).toBe("2026-02-01T00:00:00Z");
    expect(state.capacity).toBe(32);
    expect(state.fee_cents).toBe(1500);
    expect(state.refund_lock_at).toBe("2026-01-20T00:00:00Z");
    expect(state.place_by_at).toBe("2026-01-25T00:00:00Z");
    expect(state.form_fields).toEqual(FORM_FIELDS);
    expect(state.payment_method).toBe("stripe");
    expect(state.approval).toBe("manual");
    expect(state.allow_free_agents).toBe(true);
  });

  it("takes category/age_min/age_max/age_cutoff_month/age_cutoff_day/eligibility_note from the division eligibility argument, NOT the response (the GET has no such columns)", () => {
    const state = initialConfigState(RESPONSE, {
      category: "mixed",
      age_min: 10,
      age_max: 18,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "School-registered students only",
    });
    expect(state.category).toBe("mixed");
    expect(state.age_min).toBe(10);
    expect(state.age_max).toBe(18);
    expect(state.age_cutoff_month).toBe(9);
    expect(state.age_cutoff_day).toBe(1);
    expect(state.eligibility_note).toBe("School-registered students only");
  });
});

describe("toDivisionPatchBody", () => {
  it("carries exactly category/age_min/age_max/age_cutoff_month/age_cutoff_day/eligibility_note, never a seventh key", () => {
    const state = initialConfigState(RESPONSE, {
      category: "mens",
      age_min: 18,
      age_max: null,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "Note",
    });
    const body = toDivisionPatchBody(state);
    expect(body).toEqual({
      category: "mens",
      age_min: 18,
      age_max: null,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "Note",
    });
    expect(Object.keys(body).sort()).toEqual([
      "age_cutoff_day",
      "age_cutoff_month",
      "age_max",
      "age_min",
      "category",
      "eligibility_note",
    ]);
  });
});

describe("toRegistrationSettingsPutBody — full replace hazard", () => {
  const FULL_STATE: RegistrationConfigState = {
    category: "open",
    age_min: null,
    age_max: null,
    age_cutoff_month: null,
    age_cutoff_day: null,
    eligibility_note: null,
    enabled: true,
    entrant_kind: "team",
    opens_at: "2026-01-01T00:00:00Z",
    closes_at: "2026-02-01T00:00:00Z",
    capacity: 32,
    fee_cents: 1500,
    refund_lock_at: "2026-01-20T00:00:00Z",
    place_by_at: "2026-01-25T00:00:00Z",
    form_fields: FORM_FIELDS,
    payment_method: "stripe",
    payment_instructions: "Bank transfer to club account.",
    approval: "manual",
    allow_free_agents: true,
    free_agent_fee_cents: 500,
  };

  // The hazard this file is named for cuts BOTH ways, and only one direction
  // was covered. `toEqual` below catches a field that should not be sent; it
  // cannot catch one that SHOULD be and is not, because the expectation is
  // hand-written beside the code it checks. RS009 added
  // free_agent_fee_cents to the endpoint and to the panel state and did not
  // add it here — every save then wrote NULL over whatever price the
  // organiser had set, silently re-opening the double-charge V388 exists to
  // close. Derived from the server schema instead, so the next field cannot
  // be forgotten the same way.
  it("sends exactly the keys PutRegistrationSettings declares — no more, none missing", async () => {
    const { PutRegistrationSettings } = await import("@/server/api-v1/schemas");
    const declared = Object.keys(PutRegistrationSettings.shape).sort();
    const sent = Object.keys(toRegistrationSettingsPutBody(FULL_STATE)).sort();
    expect(sent).toEqual(declared);
  });

  it("sends every PutRegistrationSettings field the endpoint accepts", () => {
    const body = toRegistrationSettingsPutBody(FULL_STATE);
    expect(body).toEqual({
      enabled: true,
      entrant_kind: "team",
      opens_at: "2026-01-01T00:00:00Z",
      closes_at: "2026-02-01T00:00:00Z",
      capacity: 32,
      fee_cents: 1500,
      refund_lock_at: "2026-01-20T00:00:00Z",
      place_by_at: "2026-01-25T00:00:00Z",
      form_fields: FORM_FIELDS,
      payment_method: "stripe",
      payment_instructions: "Bank transfer to club account.",
      approval: "manual",
      allow_free_agents: true,
      free_agent_fee_cents: 500,
    });
  });

  it("never includes category/age_min/age_max/age_cutoff_month/age_cutoff_day/eligibility_note — those belong to the OTHER endpoint", () => {
    const body = toRegistrationSettingsPutBody(FULL_STATE);
    expect(body).not.toHaveProperty("category");
    expect(body).not.toHaveProperty("age_min");
    expect(body).not.toHaveProperty("age_max");
    expect(body).not.toHaveProperty("age_cutoff_month");
    expect(body).not.toHaveProperty("age_cutoff_day");
    expect(body).not.toHaveProperty("eligibility_note");
  });

  // The hazard itself: editing ONE field (fee_cents) must not silently
  // drop every other field from the outgoing PUT — this endpoint is a full
  // replace, not a merge (RS004 brief). A body missing e.g. `form_fields`
  // or `payment_instructions` would clear them server-side.
  it("editing only fee_cents still sends every other field unchanged", () => {
    const edited: RegistrationConfigState = { ...FULL_STATE, fee_cents: 2500 };
    const body = toRegistrationSettingsPutBody(edited);
    expect(body.fee_cents).toBe(2500);
    expect(body.form_fields).toEqual(FORM_FIELDS);
    expect(body.payment_instructions).toBe("Bank transfer to club account.");
    expect(body.refund_lock_at).toBe("2026-01-20T00:00:00Z");
    expect(body.place_by_at).toBe("2026-01-25T00:00:00Z");
    expect(body.opens_at).toBe("2026-01-01T00:00:00Z");
    expect(body.closes_at).toBe("2026-02-01T00:00:00Z");
    expect(body.capacity).toBe(32);
    expect(body.approval).toBe("manual");
    expect(body.allow_free_agents).toBe(true);
    expect(body.payment_method).toBe("stripe");
    expect(body.entrant_kind).toBe("team");
  });
});

// RS005 R4 task 2 — client-side prevention of every server-enforced rule the
// dispatch names (except the ones a `maxLength` attribute or a hidden
// "add" control already prevents client-side — see the function's own
// header comment). Every rule gets an ACCEPT case and a REJECT case, so a
// future change to the bound shows up here rather than only at the server.
describe("validateConfigState", () => {
  const VALID_STATE: RegistrationConfigState = {
    category: "open",
    age_min: null,
    age_max: null,
    age_cutoff_month: null,
    age_cutoff_day: null,
    eligibility_note: null,
    enabled: true,
    entrant_kind: "team",
    opens_at: "2026-01-01T00:00:00.000Z",
    closes_at: "2026-02-01T00:00:00.000Z",
    capacity: 32,
    fee_cents: 1500,
    free_agent_fee_cents: null,
    refund_lock_at: null,
    place_by_at: null,
    form_fields: [{ key: "shirt_size", label: "Shirt size", kind: "text", required: true }],
    payment_method: "offline",
    payment_instructions: null,
    approval: "manual",
    allow_free_agents: true,
  };

  it("a well-formed state has no issues at all", () => {
    expect(validateConfigState(VALID_STATE)).toEqual({});
  });

  describe("capacity (server bound: 1..10000)", () => {
    it("accepts null — a deliberate 'uncapped' division, not a violation", () => {
      expect(validateConfigState({ ...VALID_STATE, capacity: null })).toEqual({});
    });
    it("accepts the boundary values 1 and 10000", () => {
      expect(validateConfigState({ ...VALID_STATE, capacity: 1 })).toEqual({});
      expect(validateConfigState({ ...VALID_STATE, capacity: 10_000 })).toEqual({});
    });
    it("rejects 0 and 10001", () => {
      expect(validateConfigState({ ...VALID_STATE, capacity: 0 }).capacity).toBe("capacityRange");
      expect(validateConfigState({ ...VALID_STATE, capacity: 10_001 }).capacity).toBe("capacityRange");
    });
    it("rejects a non-integer", () => {
      expect(validateConfigState({ ...VALID_STATE, capacity: 32.5 }).capacity).toBe("capacityRange");
    });
  });

  describe("fee_cents (server bound: 0..10000000)", () => {
    it("accepts the boundary values 0 and 10000000", () => {
      expect(validateConfigState({ ...VALID_STATE, fee_cents: 0 })).toEqual({});
      expect(validateConfigState({ ...VALID_STATE, fee_cents: 10_000_000 })).toEqual({});
    });
    it("rejects a negative fee and one over the cap", () => {
      expect(validateConfigState({ ...VALID_STATE, fee_cents: -1 }).fee_cents).toBe("feeCentsRange");
      expect(validateConfigState({ ...VALID_STATE, fee_cents: 10_000_001 }).fee_cents).toBe("feeCentsRange");
    });
  });

  describe("card fee minimum (server: 'Card entry fees must be at least 1.00 (or 0 for free)')", () => {
    it("free (0) is fine on a card division", () => {
      expect(validateConfigState({ ...VALID_STATE, payment_method: "stripe", fee_cents: 0 })).toEqual({});
    });
    it("the minimum charge (100 = 1.00) is fine on a card division", () => {
      expect(validateConfigState({ ...VALID_STATE, payment_method: "stripe", fee_cents: 100 })).toEqual({});
    });
    it("1-99 cents on a card division is rejected", () => {
      expect(
        validateConfigState({ ...VALID_STATE, payment_method: "stripe", fee_cents: 50 }).fee_cents,
      ).toBe("cardFeeMinimum");
    });
    it("the SAME 50 cents is fine when paying the organiser offline — the rule is card-only", () => {
      expect(validateConfigState({ ...VALID_STATE, payment_method: "offline", fee_cents: 50 })).toEqual({});
    });
  });

  describe("dates order (server: 'closes_at must be after opens_at')", () => {
    it("closes strictly after opens is fine", () => {
      expect(validateConfigState(VALID_STATE)).toEqual({});
    });
    it("neither side set yet is fine — not every division has a window configured", () => {
      expect(validateConfigState({ ...VALID_STATE, opens_at: null, closes_at: null })).toEqual({});
    });
    it("closes BEFORE opens is rejected", () => {
      expect(
        validateConfigState({ ...VALID_STATE, opens_at: "2026-02-01T00:00:00.000Z", closes_at: "2026-01-01T00:00:00.000Z" })
          .closes_at,
      ).toBe("datesOrder");
    });
    it("closes at the SAME instant as opens is rejected too — 'after' is strict", () => {
      const same = "2026-01-01T00:00:00.000Z";
      expect(validateConfigState({ ...VALID_STATE, opens_at: same, closes_at: same }).closes_at).toBe(
        "datesOrder",
      );
    });
  });

  describe("duplicate form field keys (server: 'duplicate form field keys')", () => {
    it("unique keys are fine", () => {
      expect(
        validateConfigState({
          ...VALID_STATE,
          form_fields: [
            { key: "a", label: "A", kind: "text", required: false },
            { key: "b", label: "B", kind: "text", required: false },
          ],
        }),
      ).toEqual({});
    });
    it("two fields sharing a key is rejected on form_fields", () => {
      expect(
        validateConfigState({
          ...VALID_STATE,
          form_fields: [
            { key: "shirt_size", label: "Shirt size", kind: "text", required: false },
            { key: "shirt_size", label: "T-shirt size", kind: "text", required: false },
          ],
        }).form_fields,
      ).toBe("duplicateFormFieldKeys");
    });
  });

  describe("select fields need options (server: 'select fields need options')", () => {
    it("a select field with a real option is fine", () => {
      expect(
        validateConfigState({
          ...VALID_STATE,
          form_fields: [{ key: "size", label: "Size", kind: "select", options: ["S", "M"], required: false }],
        }),
      ).toEqual({});
    });
    it("a select field with NO options at all is rejected", () => {
      expect(
        validateConfigState({
          ...VALID_STATE,
          form_fields: [{ key: "size", label: "Size", kind: "select", options: [], required: false }],
        }).form_fields,
      ).toBe("selectNeedsOptions");
    });
    it("a select field with only a blank/whitespace option is ALSO rejected — the FormBuilder kind-switch seed", () => {
      // FormBuilder seeds `options: [""]` the instant a field is switched to
      // "select" and never touched again — length 1, but not a real option.
      expect(
        validateConfigState({
          ...VALID_STATE,
          form_fields: [{ key: "size", label: "Size", kind: "select", options: ["   "], required: false }],
        }).form_fields,
      ).toBe("selectNeedsOptions");
    });
    it("a text field with no options is fine — the rule is select-only", () => {
      expect(
        validateConfigState({
          ...VALID_STATE,
          form_fields: [{ key: "notes", label: "Notes", kind: "text", required: false }],
        }),
      ).toEqual({});
    });
  });
});
