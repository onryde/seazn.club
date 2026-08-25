// Registration hub config panel — pure state shaping (RS004 W3c).
//
// Kept separate from the panel component so the FULL-REPLACE hazard on
// PUT /registration-settings ("send every field every time or you will
// silently clear the ones you omit") is provable with a DOM-free test, and
// so the merge of two different resources (a division's category/age_min/
// age_max, and its registration_settings row) into one edit surface is
// pinned in one small, obviously-correct place.
import type { FormField } from "@/components/registration-hub-form-builder";
import type { DivisionCategoryValue } from "@/components/registration-hub-row-derive";

export type EntrantKindValue = "individual" | "team" | "pair";
export type ApprovalValue = "auto" | "manual";
export type PaymentMethodValue = "offline" | "stripe";

/** Everything the config panel edits, across BOTH endpoints. */
export interface RegistrationConfigState {
  // divisions (PATCH /api/v1/divisions/{id})
  category: DivisionCategoryValue | null;
  age_min: number | null;
  age_max: number | null;
  // registration_settings (PUT /api/v1/divisions/{id}/registration-settings)
  enabled: boolean;
  entrant_kind: EntrantKindValue;
  opens_at: string | null;
  closes_at: string | null;
  capacity: number | null;
  fee_cents: number;
  refund_lock_at: string | null;
  form_fields: FormField[];
  payment_method: PaymentMethodValue;
  payment_instructions: string | null;
  approval: ApprovalValue;
  allow_free_agents: boolean;
}

/** The GET response shape (RegistrationSettingsRow & OrgPaymentDefaults on
 *  the server, `RegistrationSettings` in server/api-v1/schemas.ts — declared
 *  locally rather than imported from that DO-NOT-TOUCH, value-heavy file,
 *  same precedent as FormField). No category/age_min/age_max: those live on
 *  `divisions`, not `registration_settings`. */
export interface RegistrationSettingsResponse
  extends Omit<RegistrationConfigState, "category" | "age_min" | "age_max"> {
  division_id: string;
  /** Org's registration currency (RS001b) — read-only echo, never sent back. */
  currency: string;
  /** Stripe Connect charges readiness — gates the card payment-method option. */
  charges_enabled: boolean;
  /** Org-level fallback shown as the payment-instructions placeholder. */
  org_payment_instructions: string | null;
  org_default_payment_method: string;
  updated_at: string | null;
}

/** Division-level fields the row already carries — the GET above has no
 *  such columns, so these come from the caller (the row's own data), not
 *  from the registration-settings fetch. */
export interface DivisionEligibility {
  category: DivisionCategoryValue | null;
  age_min: number | null;
  age_max: number | null;
}

/** Seed the panel's local edit state: registration_settings fields from the
 *  GET response, eligibility fields from the division row. */
export function initialConfigState(
  settings: RegistrationSettingsResponse,
  eligibility: DivisionEligibility,
): RegistrationConfigState {
  return {
    category: eligibility.category,
    age_min: eligibility.age_min,
    age_max: eligibility.age_max,
    enabled: settings.enabled,
    entrant_kind: settings.entrant_kind,
    opens_at: settings.opens_at,
    closes_at: settings.closes_at,
    capacity: settings.capacity,
    fee_cents: settings.fee_cents,
    refund_lock_at: settings.refund_lock_at,
    form_fields: settings.form_fields,
    payment_method: settings.payment_method,
    payment_instructions: settings.payment_instructions,
    approval: settings.approval,
    allow_free_agents: settings.allow_free_agents,
  };
}

/** PATCH /api/v1/divisions/{id} body — always all three keys together (a
 *  patch missing every key is rejected by PatchDivision's own "empty
 *  patch" refine, and these three are logically one "eligibility" edit). */
export function toDivisionPatchBody(
  state: RegistrationConfigState,
): Pick<RegistrationConfigState, "category" | "age_min" | "age_max"> {
  return { category: state.category, age_min: state.age_min, age_max: state.age_max };
}

/** PUT /api/v1/divisions/{id}/registration-settings body — FULL REPLACE.
 *  Every field the endpoint accepts, every save, regardless of which one
 *  the organiser actually touched. */
export function toRegistrationSettingsPutBody(
  state: RegistrationConfigState,
): Omit<RegistrationConfigState, "category" | "age_min" | "age_max"> {
  const {
    enabled,
    entrant_kind,
    opens_at,
    closes_at,
    capacity,
    fee_cents,
    refund_lock_at,
    form_fields,
    payment_method,
    payment_instructions,
    approval,
    allow_free_agents,
  } = state;
  return {
    enabled,
    entrant_kind,
    opens_at,
    closes_at,
    capacity,
    fee_cents,
    refund_lock_at,
    form_fields,
    payment_method,
    payment_instructions,
    approval,
    allow_free_agents,
  };
}
