// RS006 public stepper — client state shapes. Pure types, no runtime code.
//
// Designed to map cleanly onto `PublicRegisterGroupRequest`
// (server/api-v1/schemas.ts:2416) without reshaping later — the chassis +
// WHO (step 1) + ENTRIES (step 2) were built first; steps 4-5 (CONSENT,
// REVIEW→PAY) still extend this state, they do not replace it. See
// `toGroupContact`/`toGroupEntry` in `cart.ts` for the mapping this shape
// exists to make trivial once submit (step 5) lands.
//
// RS006 W3 (step 3 — DETAILS) added `RosterPlayerState`/`CartEntry.players`/
// `CartEntry.answers` — see their own doc comments below for why they land
// on `CartEntry` rather than a parallel per-entry map.

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
  /** Step 3's custom-questions renderer (design §4 step 3). A LOCAL shape,
   *  not an import of `RegistrationFormField` (server/api-v1/schemas.ts) —
   *  same "narrow on purpose" reasoning as the rest of this interface: a
   *  hand-built test fixture needs no cast, and this file stays decoupled
   *  from the wire schema module. Structurally identical to the wire shape
   *  (schemas.ts:2153-2165), so a real `PublicRegistrationDivision` value
   *  satisfies this with no mapping step. */
  form_fields: FormFieldDef[];
}

/** See `DivisionLike.form_fields` above for why this is a local mirror of
 *  `RegistrationFormField` rather than an import. */
export interface FormFieldDef {
  key: string;
  label: string;
  kind: "text" | "select" | "checkbox";
  /** Present (min 1) only when `kind === "select"` — mirrors the wire
   *  schema's `.refine`, not re-validated here (this is a read-only view of
   *  organiser-authored config, never user input). */
  options?: string[];
  required: boolean;
}

/** One roster row, mid-edit (step 3 — DETAILS). Numeric/date-shaped fields
 *  stay PLAIN STRINGS while being typed — the recovered `parseRoster`'s
 *  `Player` shape (git history `76ef7987b`), renamed `name` -> `full_name`
 *  to match the wire field (`PublicRegisterGroupPlayer.full_name`) instead
 *  of inventing a second name for the same thing. Converted to the wire's
 *  typed fields only at the submit-mapping boundary (`roster.ts`'s
 *  `toGroupPlayer`) — this file stays a pure, controlled-`<input>`-friendly
 *  editing shape, matching `ContactState`'s own convention
 *  (`dob: string | null`, not `Date`).
 *
 *  `email`/`is_captain` are on the shape (matching the wire's full player
 *  fields) but have NO dedicated input in this session's roster builder —
 *  same scope line the OLD pre-redesign form drew (its `TeamRoster` never
 *  collected email or a captain flag either); kept here so the state shape
 *  — and `roster.ts`'s wire mapping — are complete even though the UI
 *  doesn't populate them yet. */
export interface RosterPlayerState {
  full_name: string;
  dob: string | null;
  gender: Gender | null;
  email: string;
  /** Digits only, "" = unset — stays a string like `parseRoster`'s
   *  `squad_number` (parsed to the wire's 0-999 integer only at submit). */
  squad_number: string;
  is_captain: boolean;
}

export const EMPTY_ROSTER_PLAYER: RosterPlayerState = {
  full_name: "",
  dob: null,
  gender: null,
  email: "",
  squad_number: "",
  is_captain: false,
};

/** One cart line, mid-build. `id` is CLIENT-ONLY — a stable React key and
 *  the handle every reducer action and the self-link both address an entry
 *  by — and is never sent to the server (`toGroupEntry` below drops it).
 *
 *  `players`/`answers` (step 3 — DETAILS) land HERE rather than a parallel
 *  `Record<entryId, ...>` map for two reasons: `toGroupEntry`'s own doc
 *  comment already anticipated "a caller spreads this together with those
 *  once they exist" (i.e. per-ENTRY, not cart-wide), and `storage.ts`
 *  persists the whole `CartState` as one blob — putting roster/answers on
 *  `CartEntry` means mid-flow refresh survival (chassis rule) needs NO
 *  changes to `storage.ts` at all. A free-agent entry's `players` stays
 *  whatever it was seeded with (usually `[]`) and is never rendered (design
 *  §4 step 3: "Free-agent entries need nothing extra"). */
export interface CartEntry {
  id: string;
  division_id: string;
  entrant_kind: "team" | "individual" | "pair";
  team_name: string | null;
  partner_name: string | null;
  free_agent: boolean;
  /** Individual: exactly 1 row. Pair: exactly 2 (the second IS the
   *  "partner field for pairs" the design calls out — labeled distinctly
   *  in entry-details.tsx, not a separate top-level field). Team:
   *  unconstrained (0..50, matching `PublicRegisterGroupEntry.players.max(50)`
   *  and, unlike individual/pair, the server places NO minimum on a team
   *  roster — `registration-submit.ts` only rejects individual !== 1 and
   *  pair !== 2, never team's count). Seeded by `cart.ts`'s `blankPlayers`
   *  at ADD_ENTRY/DUPLICATE_ENTRY time, keyed off `entrant_kind` alone —
   *  see that function's doc comment for why free-agent status doesn't
   *  change the seed. */
  players: RosterPlayerState[];
  /** Step 3's `form_fields` answers, keyed by `FormFieldDef.key`. text/select
   *  answers are strings, checkbox answers are booleans — a narrowing of
   *  `PublicRegisterGroupEntry.answers`'s wire shape
   *  (`z.record(z.string(), z.unknown())`) to what this renderer actually
   *  ever produces. */
  answers: Record<string, string | boolean>;
  /** True when the CONTACT themselves is one of THIS entry's players —
   *  mirrors `PublicRegisterGroupEntry.registering_self` (schemas.ts:2399)
   *  1:1, including its field name. PER-ENTRY on purpose (RS006): a
   *  registrant may link themselves on more than one cart entry at once
   *  (singles + doubles at the same tournament is the common racket-sports
   *  case) — the schema's superRefine no longer caps this cart-wide, so the
   *  client state must not reintroduce that cap either. Set/cleared by
   *  `cart.ts`'s `SET_ENTRY_SELF` action. */
  registering_self: boolean;
  /** 0-based index into THIS entry's own `players`, identifying which row
   *  is the contact — mirrors `PublicRegisterGroupEntry.self_player_index`
   *  1:1. Stays `null` until step 3 resolves it (an individual entry's
   *  implied index-0 needs no value here at all — see `toGroupEntry`).
   *  Reset to `null` whenever `registering_self` flips on THIS entry (a
   *  freshly (re-)linked entry's roster hasn't been picked yet), and
   *  shifted/cleared by `REMOVE_PLAYER` when a row before/at the linked
   *  index is removed — see that action's own doc comment. */
  self_player_index: number | null;
}

/** The whole cart. Self-link state lives PER-ENTRY (`CartEntry.
 *  registering_self`/`self_player_index` above) since RS006 — earlier this
 *  was a single cart-level `selfEntryId`/`selfPlayerIndex` pair, enforcing
 *  (via the client alone; the server never required it) that at most one
 *  entry cart-wide could be the contact. That was a defect inherited from
 *  the pre-redesign single-entry schema, not a real constraint: a
 *  registrant may link themselves on more than one entry (singles +
 *  doubles). Do not reintroduce a cart-level self field "for safety" —
 *  that would bring the defect back one layer down. */
export interface CartState {
  entries: CartEntry[];
}

export const EMPTY_CART: CartState = { entries: [] };

export const MAX_CART_ENTRIES = 10;

export type StepId = "who" | "entries" | "details";
