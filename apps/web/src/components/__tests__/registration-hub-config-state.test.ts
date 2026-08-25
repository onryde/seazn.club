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
  currency: "usd",
  refund_lock_at: "2026-01-20T00:00:00Z",
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

describe("initialConfigState", () => {
  it("takes registration_settings fields from the GET response", () => {
    const state = initialConfigState(RESPONSE, { category: null, age_min: null, age_max: null });
    expect(state.enabled).toBe(true);
    expect(state.entrant_kind).toBe("team");
    expect(state.opens_at).toBe("2026-01-01T00:00:00Z");
    expect(state.closes_at).toBe("2026-02-01T00:00:00Z");
    expect(state.capacity).toBe(32);
    expect(state.fee_cents).toBe(1500);
    expect(state.refund_lock_at).toBe("2026-01-20T00:00:00Z");
    expect(state.form_fields).toEqual(FORM_FIELDS);
    expect(state.payment_method).toBe("stripe");
    expect(state.approval).toBe("manual");
    expect(state.allow_free_agents).toBe(true);
  });

  it("takes category/age_min/age_max from the division eligibility argument, NOT the response (the GET has no such columns)", () => {
    const state = initialConfigState(RESPONSE, { category: "mixed", age_min: 10, age_max: 18 });
    expect(state.category).toBe("mixed");
    expect(state.age_min).toBe(10);
    expect(state.age_max).toBe(18);
  });
});

describe("toDivisionPatchBody", () => {
  it("carries exactly category/age_min/age_max, never a fourth key", () => {
    const state = initialConfigState(RESPONSE, { category: "mens", age_min: 18, age_max: null });
    const body = toDivisionPatchBody(state);
    expect(body).toEqual({ category: "mens", age_min: 18, age_max: null });
    expect(Object.keys(body).sort()).toEqual(["age_max", "age_min", "category"]);
  });
});

describe("toRegistrationSettingsPutBody — full replace hazard", () => {
  const FULL_STATE: RegistrationConfigState = {
    category: "open",
    age_min: null,
    age_max: null,
    enabled: true,
    entrant_kind: "team",
    opens_at: "2026-01-01T00:00:00Z",
    closes_at: "2026-02-01T00:00:00Z",
    capacity: 32,
    fee_cents: 1500,
    refund_lock_at: "2026-01-20T00:00:00Z",
    form_fields: FORM_FIELDS,
    payment_method: "stripe",
    payment_instructions: "Bank transfer to club account.",
    approval: "manual",
    allow_free_agents: true,
  };

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
      form_fields: FORM_FIELDS,
      payment_method: "stripe",
      payment_instructions: "Bank transfer to club account.",
      approval: "manual",
      allow_free_agents: true,
    });
  });

  it("never includes category/age_min/age_max — those belong to the OTHER endpoint", () => {
    const body = toRegistrationSettingsPutBody(FULL_STATE);
    expect(body).not.toHaveProperty("category");
    expect(body).not.toHaveProperty("age_min");
    expect(body).not.toHaveProperty("age_max");
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
    expect(body.opens_at).toBe("2026-01-01T00:00:00Z");
    expect(body.closes_at).toBe("2026-02-01T00:00:00Z");
    expect(body.capacity).toBe(32);
    expect(body.approval).toBe("manual");
    expect(body.allow_free_agents).toBe(true);
    expect(body.payment_method).toBe("stripe");
    expect(body.entrant_kind).toBe("team");
  });
});
