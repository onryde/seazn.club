// RS006 public stepper — client state shapes. Pure types, no runtime code.
//
// Designed to map cleanly onto `PublicRegisterGroupRequest`
// (server/api-v1/schemas.ts:2416) without reshaping later — this session
// builds the chassis + WHO (step 1) + ENTRIES (step 2) only; steps 3-5
// (DETAILS/roster, CONSENT, REVIEW→PAY) extend this state, they do not
// replace it. See `toGroupContact`/`toGroupEntry` in `cart.ts` for the
// mapping this shape exists to make trivial once submit (step 5) lands.

export type Gender = "m" | "f" | "x";

/** Step 1 (WHO) contact fields, cart-wide. Mirrors
 *  `PublicRegisterGroupContact` (schemas.ts:2359) minus guardian_name/
 *  guardian_consent, which are CONSENT-step (4) fields the design keeps
 *  separate from WHO — this session doesn't collect them, so they are
 *  intentionally absent here rather than reserved-but-unused. */
export interface ContactState {
  name: string;
  email: string;
  /** ISO date (`YYYY-MM-DD`), or null until collected/needed. */
  dob: string | null;
  gender: Gender | null;
}

export const EMPTY_CONTACT: ContactState = { name: "", email: "", dob: null, gender: null };

/** The subset of `PublicRegistrationDivision` (schemas.ts:2312) the chassis'
 *  pure logic reads. Narrow on purpose — the same reason
 *  registration-eligibility.ts's `EligibilityDivision` is narrow: callers
 *  (including tests) can pass a hand-built object with no cast. */
export interface DivisionLike {
  division_id: string;
  name: string;
  entrant_kind: "team" | "individual" | "pair";
  category: string | null;
  age_min: number | null;
  age_max: number | null;
  requires_dob: boolean;
  requires_gender: boolean;
  allow_free_agents: boolean;
  open: boolean;
  closed_reason: string | null;
  capacity: number | null;
  remaining: number | null;
  taken: number;
  opens_at: string | null;
  closes_at: string | null;
  fee_cents: number;
  currency: string;
  payment_method: "offline" | "stripe";
}

/** One cart line, mid-build. `id` is CLIENT-ONLY — a stable React key and
 *  the handle every reducer action and the self-link both address an entry
 *  by — and is never sent to the server (`toGroupEntry` below drops it).
 *  `players`/`answers` (roster, custom form fields — step 3) are
 *  deliberately ABSENT rather than reserved-empty: adding them is that
 *  session's job, and an empty array here would be a lie about what step 2
 *  actually collected. */
export interface CartEntry {
  id: string;
  division_id: string;
  entrant_kind: "team" | "individual" | "pair";
  team_name: string | null;
  partner_name: string | null;
  free_agent: boolean;
}

/** The whole cart. `selfEntryId`/`selfPlayerIndex` are CART-LEVEL, not
 *  per-entry, because at most one entry cart-wide may be `registering_self`
 *  (schemas.ts:2426-2436 superRefine) — a single nullable field makes that
 *  invariant true by construction instead of a rule the reducer has to
 *  police across N booleans. `selfPlayerIndex` stays null until step 3
 *  resolves it (an individual entry's implied index-0 needs no value here
 *  at all — see `toGroupEntry`); reset to null whenever `selfEntryId`
 *  changes, since a new entry's roster hasn't been picked yet. */
export interface CartState {
  entries: CartEntry[];
  selfEntryId: string | null;
  selfPlayerIndex: number | null;
}

export const EMPTY_CART: CartState = { entries: [], selfEntryId: null, selfPlayerIndex: null };

export const MAX_CART_ENTRIES = 10;

export type StepId = "who" | "entries";
