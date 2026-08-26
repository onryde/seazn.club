// RS006 chassis — cart reducer (pure, no DOM). Every action returns a NEW
// CartState (or the SAME reference when refused/no-op) so callers can rely
// on identity for "did anything change" and so storage.ts can snapshot the
// result directly.
//
// Id generation is deliberately NOT this module's job — actions carry their
// own fresh id(s) (`crypto.randomUUID()` at the call site in the component),
// keeping the reducer a pure function of (state, action) with no hidden
// randomness, the standard `useReducer` shape.
import { MAX_CART_ENTRIES, type CartEntry, type CartState, type DivisionLike } from "./types";

export type CartAction =
  | { type: "ADD_ENTRY"; id: string; division_id: string; entrant_kind: CartEntry["entrant_kind"] }
  | { type: "REMOVE_ENTRY"; id: string }
  | { type: "DUPLICATE_ENTRY"; sourceId: string; newId: string }
  | {
      type: "UPDATE_ENTRY";
      id: string;
      patch: Partial<Pick<CartEntry, "team_name" | "partner_name" | "free_agent">>;
    }
  | { type: "SET_SELF_ENTRY"; id: string | null };

export function canAddEntry(cart: CartState): boolean {
  return cart.entries.length < MAX_CART_ENTRIES;
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "ADD_ENTRY": {
      if (!canAddEntry(state)) return state; // caller should have gated the "Add" control on canAddEntry
      const entry: CartEntry = {
        id: action.id,
        division_id: action.division_id,
        entrant_kind: action.entrant_kind,
        team_name: null,
        partner_name: null,
        free_agent: false,
      };
      return { ...state, entries: [...state.entries, entry] };
    }

    case "REMOVE_ENTRY": {
      const wasSelf = state.selfEntryId === action.id;
      return {
        entries: state.entries.filter((e) => e.id !== action.id),
        selfEntryId: wasSelf ? null : state.selfEntryId,
        selfPlayerIndex: wasSelf ? null : state.selfPlayerIndex,
      };
    }

    case "DUPLICATE_ENTRY": {
      if (!canAddEntry(state)) return state;
      const source = state.entries.find((e) => e.id === action.sourceId);
      if (!source) return state;
      // Blank name fields on purpose — "Team B" is the rep's call to make,
      // not a guess this chassis should bake in (two entries silently
      // sharing "Team A" is worse than an empty field).
      const clone: CartEntry = {
        id: action.newId,
        division_id: source.division_id,
        entrant_kind: source.entrant_kind,
        team_name: null,
        partner_name: null,
        free_agent: false,
      };
      return { ...state, entries: [...state.entries, clone] };
    }

    case "UPDATE_ENTRY": {
      const patch = { ...action.patch };
      // A free agent has no team/pair name yet (assigned by an organiser
      // later, design §4 step 2) — clear both rather than leave a stale
      // name attached to an entry that no longer has one.
      if (patch.free_agent === true) {
        patch.team_name = null;
        patch.partner_name = null;
      }
      return {
        ...state,
        entries: state.entries.map((e) => (e.id === action.id ? { ...e, ...patch } : e)),
      };
    }

    case "SET_SELF_ENTRY": {
      // Single-select cart-wide (schemas.ts PublicRegisterGroupRequest
      // superRefine: at most one entry may set registering_self) —
      // switching resets selfPlayerIndex because the new entry's roster
      // hasn't been picked yet (step 3's job).
      return { ...state, selfEntryId: action.id, selfPlayerIndex: null };
    }

    default:
      return state;
  }
}

/** Design §4: "step 2 collapses when the competition has one open
 *  division" — that one division is auto-added so the cart is never empty
 *  once WHO is complete. `id` is caller-supplied (same reasoning as the
 *  reducer actions above — no hidden randomness in a function a snapshot
 *  test wants to be deterministic). */
export function autoSeedSingleDivision(division: DivisionLike, id: string): CartEntry[] {
  return [
    {
      id,
      division_id: division.division_id,
      entrant_kind: division.entrant_kind,
      team_name: null,
      partner_name: null,
      free_agent: false,
    },
  ];
}

/** Reactive convenience for the WHO step's "I'm playing" toggle: when there is
 *  exactly ONE cart entry and nothing is linked yet, that entry is the only
 *  possible answer to "which entry is you", so link it automatically instead
 *  of making the rep re-state the obvious. Never overrides an EXPLICIT choice
 *  (a non-null `selfEntryId`) and never guesses across 2+ entries — that
 *  ambiguity is the rep's call (cart.ts's SET_SELF_ENTRY, driven by the
 *  ENTRIES step's per-entry "This is me" control). Returns the SAME
 *  reference when there is nothing to do, matching every other action here. */
export function autoLinkObviousSelf(cart: CartState, imPlaying: boolean): CartState {
  if (!imPlaying) return cart;
  if (cart.selfEntryId) return cart;
  if (cart.entries.length !== 1) return cart;
  return cartReducer(cart, { type: "SET_SELF_ENTRY", id: cart.entries[0]!.id });
}

/** Inverse of `autoLinkObviousSelf` (fix wave finding #2): once "I'm playing"
 *  is un-toggled, NO entry may remain linked as the contact — regardless of
 *  whether the link was made by the auto-link convenience above or an
 *  EXPLICIT "This is me" click. `imPlaying=false` means step 1's dob field
 *  may never have been shown/required (validation.ts's whoFieldRequirements
 *  keys dobRequired off imPlaying independently of any division), so a
 *  stale self-link would submit `registering_self:true` with
 *  `contact.dob:null` — guaranteed rejected by schemas.ts's superRefine
 *  (PublicRegisterGroupRequest, ~line 2446), with no client-side warning
 *  before that 400/422. Returns the SAME reference when there is nothing to
 *  clear, matching every other function here. */
export function clearSelfLinkWhenNotPlaying(cart: CartState, imPlaying: boolean): CartState {
  if (imPlaying) return cart;
  if (cart.selfEntryId === null) return cart;
  return cartReducer(cart, { type: "SET_SELF_ENTRY", id: null });
}

/** Maps one cart line onto the step-2 subset of `PublicRegisterGroupEntry`
 *  (schemas.ts:2381) — drops the client-only `id`, adds the self-link
 *  fields resolved from the CART-LEVEL self state (types.ts). `players`/
 *  `answers` are NOT added here (step 3's job); a caller building the full
 *  request object spreads this together with those once they exist.
 *
 *  `self_player_index` stays `undefined` for an INDIVIDUAL entry — the
 *  schema itself implies index 0 for a one-player individual entry
 *  (schemas.ts:2456-2458), so sending it explicitly would just repeat what
 *  the server already assumes. Every other self-linked kind (team/pair/
 *  free-agent) needs it explicit once step 3 resolves which roster row is
 *  the contact (schemas.ts superRefine rejects an unresolved claim rather
 *  than silently defaulting it — see that schema's own comment on why 0
 *  is not a safe default there). */
export function toGroupEntry(
  entry: CartEntry,
  self: { isSelf: boolean; selfPlayerIndex: number | null },
): {
  division_id: string;
  entrant_kind: CartEntry["entrant_kind"];
  team_name: string | null;
  partner_name: string | null;
  free_agent: boolean;
  registering_self: boolean;
  self_player_index?: number;
} {
  const impliesZero = entry.entrant_kind === "individual";
  return {
    division_id: entry.division_id,
    entrant_kind: entry.entrant_kind,
    team_name: entry.team_name,
    partner_name: entry.partner_name,
    free_agent: entry.free_agent,
    registering_self: self.isSelf,
    self_player_index:
      self.isSelf && !impliesZero && self.selfPlayerIndex != null
        ? self.selfPlayerIndex
        : undefined,
  };
}
