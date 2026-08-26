// RS006 chassis — cart reducer (pure, no DOM). Every action returns a NEW
// CartState (or the SAME reference when refused/no-op) so callers can rely
// on identity for "did anything change" and so storage.ts can snapshot the
// result directly.
//
// Id generation is deliberately NOT this module's job — actions carry their
// own fresh id(s) (`crypto.randomUUID()` at the call site in the component),
// keeping the reducer a pure function of (state, action) with no hidden
// randomness, the standard `useReducer` shape.
//
// RS006 W3 (step 3 — DETAILS) added the roster (`*_PLAYER`/`IMPORT_PLAYERS`)
// and answers (`SET_ANSWERS`) actions. Two of the new per-player actions are
// FINE-GRAINED (`REMOVE_PLAYER` takes an index, `UPDATE_PLAYER` takes an
// index+patch) rather than a single coarse "SET_PLAYERS" the caller
// computes — REMOVE specifically needs the reducer itself to shift/clear
// that entry's `self_player_index` correctly (see its own doc comment),
// which only works if the reducer knows WHICH index was removed, not just
// the resulting array.
//
// RS006 (post-W3 fix): self-link state (`registering_self`/
// `self_player_index`) moved from a single cart-level pair onto EACH
// `CartEntry` — see types.ts's `CartEntry`/`CartState` doc comments for why
// (a registrant may link themselves on more than one entry). `SET_SELF_ENTRY`
// (cart-wide) is replaced by `SET_ENTRY_SELF` (per-entry); the old cart-level
// `SET_SELF_PLAYER_INDEX` now carries an `id` too.
import {
  MAX_CART_ENTRIES,
  type CartEntry,
  type CartState,
  type DivisionLike,
  type RosterPlayerState,
  EMPTY_ROSTER_PLAYER,
} from "./types";

export const MAX_ROSTER_PLAYERS = 50; // PublicRegisterGroupEntry.players.max(50), schemas.ts:2396

export type CartAction =
  | { type: "ADD_ENTRY"; id: string; division_id: string; entrant_kind: CartEntry["entrant_kind"] }
  | { type: "REMOVE_ENTRY"; id: string }
  | { type: "DUPLICATE_ENTRY"; sourceId: string; newId: string }
  | {
      type: "UPDATE_ENTRY";
      id: string;
      patch: Partial<Pick<CartEntry, "team_name" | "partner_name" | "free_agent">>;
    }
  | { type: "SET_ENTRY_SELF"; id: string; isSelf: boolean }
  | { type: "ADD_PLAYER"; id: string }
  | { type: "REMOVE_PLAYER"; id: string; index: number }
  | { type: "UPDATE_PLAYER"; id: string; index: number; patch: Partial<RosterPlayerState> }
  | { type: "IMPORT_PLAYERS"; id: string; players: RosterPlayerState[] }
  | { type: "SET_ANSWERS"; id: string; answers: Record<string, string | boolean> }
  | { type: "SET_SELF_PLAYER_INDEX"; id: string; index: number | null };

export function canAddEntry(cart: CartState): boolean {
  return cart.entries.length < MAX_CART_ENTRIES;
}

/** Individual: exactly 1 row (the schema's own minimum AND maximum —
 *  `registration-submit.ts` rejects anything else). Pair: exactly 2 (the
 *  second IS the partner field, design §4 step 3). Team: unconstrained, so
 *  it starts at 0 and grows via ADD_PLAYER/IMPORT_PLAYERS — the schema
 *  places no minimum on a team roster (unlike individual/pair). Free-agent
 *  status is deliberately NOT a parameter: `entrant_kind` alone decides the
 *  seed, because ADD_ENTRY always constructs kind team/pair/individual
 *  first and free_agent is set via a SEPARATE UPDATE_ENTRY dispatch right
 *  after (step-entries.tsx's solo-signup handler) — seeding by kind here
 *  keeps this function correct regardless of which order those two
 *  dispatches land in. A free-agent entry's `players` is simply never
 *  rendered (design: "Free-agent entries need nothing extra"). */
function blankPlayers(kind: CartEntry["entrant_kind"]): RosterPlayerState[] {
  const n = kind === "individual" ? 1 : kind === "pair" ? 2 : 0;
  return Array.from({ length: n }, () => ({ ...EMPTY_ROSTER_PLAYER }));
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
        players: blankPlayers(action.entrant_kind),
        answers: {},
        registering_self: false,
        self_player_index: null,
      };
      return { ...state, entries: [...state.entries, entry] };
    }

    case "REMOVE_ENTRY": {
      // Self-link state lives ON the entry now, so dropping it needs no
      // separate cart-level cleanup — it simply leaves with the entry.
      return { ...state, entries: state.entries.filter((e) => e.id !== action.id) };
    }

    case "DUPLICATE_ENTRY": {
      if (!canAddEntry(state)) return state;
      const source = state.entries.find((e) => e.id === action.sourceId);
      if (!source) return state;
      // Blank name fields on purpose — "Team B" is the rep's call to make,
      // not a guess this chassis should bake in (two entries silently
      // sharing "Team A" is worse than an empty field). Same philosophy for
      // the roster/answers below: a captain duplicating "Team A" into a
      // blank "Team B" must NOT inherit Team A's players or answers —
      // re-SEED by kind (blankPlayers), never copy `source.players`. The
      // self-link never carries over either — a duplicate is a fresh,
      // unlinked entry, same as every other field here.
      const clone: CartEntry = {
        id: action.newId,
        division_id: source.division_id,
        entrant_kind: source.entrant_kind,
        team_name: null,
        partner_name: null,
        free_agent: false,
        players: blankPlayers(source.entrant_kind),
        answers: {},
        registering_self: false,
        self_player_index: null,
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

    case "SET_ENTRY_SELF": {
      // PER-ENTRY (RS006) — independently settable on any number of
      // entries, no cart-wide exclusivity. Every transition (on OR off)
      // resets THIS entry's self_player_index to null: unlinking then
      // re-linking the SAME entry must not silently keep a stale row pick
      // from an earlier link, matching the old cart-level behaviour's
      // "switching resets the index" rule, now scoped to one entry instead
      // of the whole cart.
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.id === action.id ? { ...e, registering_self: action.isSelf, self_player_index: null } : e,
        ),
      };
    }

    case "ADD_PLAYER": {
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.id === action.id && e.players.length < MAX_ROSTER_PLAYERS
            ? { ...e, players: [...e.players, { ...EMPTY_ROSTER_PLAYER }] }
            : e,
        ),
      };
    }

    case "REMOVE_PLAYER": {
      const entry = state.entries.find((e) => e.id === action.id);
      if (!entry || !entry.players[action.index]) return state;
      const entries = state.entries.map((e) => {
        if (e.id !== action.id) return e;
        const players = e.players.filter((_, i) => i !== action.index);
        // The self-link points at a ROW POSITION within THIS entry's own
        // roster — removing a row shifts every later index down by one, so
        // a stale `self_player_index` would silently point at the WRONG
        // player after a removal (not just an out-of-range one). Scoped
        // entirely to this entry now — no cart-level cross-reference needed,
        // since the index already lives where the roster it indexes does.
        const self_player_index =
          e.self_player_index === null
            ? null
            : e.self_player_index === action.index
              ? null // the linked row itself was removed
              : e.self_player_index > action.index
                ? e.self_player_index - 1 // shift down with the row it was tracking
                : e.self_player_index; // a LATER row was removed — unaffected
        return { ...e, players, self_player_index };
      });
      return { ...state, entries };
    }

    case "UPDATE_PLAYER": {
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.id === action.id
            ? {
                ...e,
                players: e.players.map((p, i) => (i === action.index ? { ...p, ...action.patch } : p)),
              }
            : e,
        ),
      };
    }

    case "IMPORT_PLAYERS": {
      // Appends (never overwrites/replaces existing rows) — same behaviour
      // as the recovered TeamRoster's "Add N players from list", and capped
      // at MAX_ROSTER_PLAYERS the same way ADD_PLAYER is.
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.id === action.id
            ? { ...e, players: [...e.players, ...action.players].slice(0, MAX_ROSTER_PLAYERS) }
            : e,
        ),
      };
    }

    case "SET_ANSWERS": {
      return {
        ...state,
        entries: state.entries.map((e) => (e.id === action.id ? { ...e, answers: action.answers } : e)),
      };
    }

    case "SET_SELF_PLAYER_INDEX": {
      // Sibling of SET_ENTRY_SELF, but this one only ever narrows WITHIN
      // the named entry's own roster — it does not touch `registering_self`,
      // so dispatching it against an entry that isn't self-linked is a
      // harmless (if pointless) no-op-shaped write, not an error: the UI
      // only ever renders this control once that entry's `registering_self`
      // is already true.
      return {
        ...state,
        entries: state.entries.map((e) => (e.id === action.id ? { ...e, self_player_index: action.index } : e)),
      };
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
      players: blankPlayers(division.entrant_kind),
      answers: {},
      registering_self: false,
      self_player_index: null,
    },
  ];
}

/** Reactive convenience for the WHO step's "I'm playing" toggle: when there is
 *  exactly ONE cart entry and it isn't self-linked yet, that entry is the only
 *  possible answer to "which entry is you", so link it automatically instead
 *  of making the rep re-state the obvious. Never overrides an EXPLICIT choice
 *  and never guesses across 2+ entries — that ambiguity is the rep's call
 *  (cart.ts's SET_ENTRY_SELF, driven by the ENTRIES step's per-entry "This is
 *  me" control). Returns the SAME reference when there is nothing to do,
 *  matching every other function here. */
export function autoLinkObviousSelf(cart: CartState, imPlaying: boolean): CartState {
  if (!imPlaying) return cart;
  if (cart.entries.length !== 1) return cart;
  const only = cart.entries[0]!;
  if (only.registering_self) return cart;
  return cartReducer(cart, { type: "SET_ENTRY_SELF", id: only.id, isSelf: true });
}

/** Inverse of `autoLinkObviousSelf` (fix wave finding #2): once "I'm playing"
 *  is un-toggled, NO entry may remain linked as the contact — regardless of
 *  whether the link was made by the auto-link convenience above or an
 *  EXPLICIT "This is me" click, and regardless of how MANY entries are
 *  currently linked (RS006: a registrant may link more than one). `imPlaying
 *  =false` means step 1's dob field may never have been shown/required
 *  (validation.ts's whoFieldRequirements keys dobRequired off imPlaying
 *  independently of any division), so a stale self-link would submit
 *  `registering_self:true` with `contact.dob:null` — guaranteed rejected by
 *  schemas.ts's superRefine (PublicRegisterGroupRequest), with no
 *  client-side warning before that 400/422. Returns the SAME reference when
 *  there is nothing to clear, matching every other function here. */
export function clearSelfLinkWhenNotPlaying(cart: CartState, imPlaying: boolean): CartState {
  if (imPlaying) return cart;
  if (!cart.entries.some((e) => e.registering_self)) return cart;
  return {
    ...cart,
    entries: cart.entries.map((e) =>
      e.registering_self ? { ...e, registering_self: false, self_player_index: null } : e,
    ),
  };
}

/** Maps one cart line onto the step-2 subset of `PublicRegisterGroupEntry`
 *  (schemas.ts:2390) — drops the client-only `id`, reading the self-link
 *  fields off the entry itself (RS006: PER-ENTRY, not cart-level — see
 *  types.ts's `CartEntry` doc comment). `players`/`answers` are NOT added
 *  here (step 3's job); a caller building the full request object spreads
 *  this together with those once they exist.
 *
 *  `self_player_index` stays `undefined` for an INDIVIDUAL entry — the
 *  schema itself implies index 0 for a one-player individual entry
 *  (schemas.ts superRefine), so sending it explicitly would just repeat what
 *  the server already assumes. Every other self-linked kind (team/pair/
 *  free-agent) needs it explicit once step 3 resolves which roster row is
 *  the contact (schemas.ts superRefine rejects an unresolved claim rather
 *  than silently defaulting it — see that schema's own comment on why 0
 *  is not a safe default there). */
export function toGroupEntry(entry: CartEntry): {
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
    registering_self: entry.registering_self,
    self_player_index:
      entry.registering_self && !impliesZero && entry.self_player_index != null
        ? entry.self_player_index
        : undefined,
  };
}
