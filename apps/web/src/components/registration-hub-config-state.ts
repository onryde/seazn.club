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
import type { ConfigFieldKey } from "@/components/registration-hub-save-error";

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

// ---------------------------------------------------------------------------
// Client-side validation (RS005 R4 task 2)
// ---------------------------------------------------------------------------
//
// The server already enforces every one of these (PutRegistrationSettings in
// server/api-v1/schemas.ts, plus the usecase-level guards in
// server/usecases/registrations.ts this panel does not own and must not
// reimplement) — this function exists so the organiser learns about a
// problem BEFORE the round trip, not after. It returns a RULE KEY per field,
// never a message string: the message is organiser-facing copy and belongs
// in the four dictionaries, resolved by the caller (registration-hub-config-
// panel.tsx, which already has `msg`) — keeping this file message-free and
// DOM-free, the same character every other export here already has.
//
// Deliberately NOT exhaustive against the server's own schema — capacity/
// fee_cents/form_fields/payment_instructions bounds not listed below are
// already prevented some other way (a `maxLength` attribute, a hidden "add"
// control once the cap is hit) and don't need a second, redundant gate here.
export type ConfigValidationIssue =
  | "capacityRange"
  | "feeCentsRange"
  | "cardFeeMinimum"
  | "datesOrder"
  | "duplicateFormFieldKeys"
  | "selectNeedsOptions";

/** Mirrors PutRegistrationSettings' capacity bound (server/api-v1/schemas.ts). */
const CAPACITY_MIN = 1;
const CAPACITY_MAX = 10_000;
/** Mirrors PutRegistrationSettings' fee_cents bound. */
const FEE_CENTS_MAX = 10_000_000;
/** Mirrors the card-payment minimum charge (server/usecases/registrations.ts
 *  "Card entry fees must be at least 1.00 (or 0 for free)"). */
const CARD_FEE_CENTS_MIN = 100;

export function validateConfigState(
  state: RegistrationConfigState,
): Partial<Record<ConfigFieldKey, ConfigValidationIssue>> {
  const issues: Partial<Record<ConfigFieldKey, ConfigValidationIssue>> = {};

  // null capacity is a deliberate, valid "uncapped" — never a violation.
  if (
    state.capacity !== null &&
    (!Number.isInteger(state.capacity) || state.capacity < CAPACITY_MIN || state.capacity > CAPACITY_MAX)
  ) {
    issues.capacity = "capacityRange";
  }

  if (!Number.isInteger(state.fee_cents) || state.fee_cents < 0 || state.fee_cents > FEE_CENTS_MAX) {
    issues.fee_cents = "feeCentsRange";
  } else if (
    state.payment_method === "stripe" &&
    state.fee_cents > 0 &&
    state.fee_cents < CARD_FEE_CENTS_MIN
  ) {
    issues.fee_cents = "cardFeeMinimum";
  }

  // Both null (neither side set yet) is not a violation — the server's own
  // guard only fires once BOTH sides are known, and a division with no
  // window configured at all is a normal, valid in-progress state.
  if (
    state.opens_at !== null &&
    state.closes_at !== null &&
    Date.parse(state.closes_at) <= Date.parse(state.opens_at)
  ) {
    issues.closes_at = "datesOrder";
  }

  const keys = state.form_fields.map((f) => f.key);
  const hasDuplicateKeys = new Set(keys).size !== keys.length;
  const hasSelectMissingOptions = state.form_fields.some(
    (f) => f.kind === "select" && !(f.options ?? []).some((o) => o.trim() !== ""),
  );
  // One slot (`form_fields`) for two different problems — checked in this
  // order because a save with BOTH is realistically dominated by the
  // duplicate-key problem (it also implies malformed authoring), and
  // firstErrorSection/the field's error paragraph can only show one message
  // at a time either way.
  if (hasDuplicateKeys) {
    issues.form_fields = "duplicateFormFieldKeys";
  } else if (hasSelectMissingOptions) {
    issues.form_fields = "selectNeedsOptions";
  }

  return issues;
}
