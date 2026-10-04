// The two request bodies an organiser sends to configure a registration
// division, in ONE place.
//
// This file exists because there were two copies — `drivers/http.ts` and
// `drivers/browser.ts` each built their own `putBody` inline — and they drifted
// the moment a field was added. `payment_method` was added to the http copy;
// the browser copy kept omitting it, and `PutRegistrationSettings` defaults an
// omitted key to "offline" (api-v1/schemas.ts:2334), so the browser driver
// silently reset every division it configured back to offline. The live symptom
// was three runs later and nowhere near the cause: a 422 from the checkout mint
// reading "This entry fee is paid directly to the organiser".
//
// Nothing here talks to the network. The drivers own transport (Playwright's
// request context vs `lib/http.ts`); they no longer own the payload.
import type { RegistrationBlockConfig } from "./types.ts";

/** `PATCH /api/v1/divisions/{id}` — the division-level restriction fields.
 *  Nulls are meaningful: clearing an age band is a real edit, not "omitted". */
export function registrationPatchBody(block: RegistrationBlockConfig): {
  category: string;
  age_min: number | null;
  age_max: number | null;
} {
  return {
    category: block.category,
    age_min: block.ageMin ?? null,
    age_max: block.ageMax ?? null,
  };
}

/** `PUT /api/v1/divisions/{id}/registration-settings`.
 *
 *  Every field is sent EXPLICITLY. The product's PUT schema defaults each key
 *  it does not receive, so an omitted field does not mean "leave it alone" —
 *  it means "set it to the default on every configure". That is why
 *  `payment_method` is here rather than conditional on `feeCents > 0`: a
 *  division that has been "stripe" and is reconfigured must be able to go back
 *  to "offline", and only an unconditional send can express both directions. */
export function registrationSettingsBody(block: RegistrationBlockConfig): {
  enabled: boolean;
  entrant_kind: string;
  fee_cents: number;
  payment_method: string;
  approval: string;
  capacity: number | null;
} {
  return {
    enabled: true,
    entrant_kind: block.entrantKind,
    fee_cents: block.feeCents,
    payment_method: block.paymentMethod,
    approval: block.approval,
    capacity: block.capacity ?? null,
  };
}
