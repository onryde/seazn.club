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
// and answers (`SET_ANSWER`) actions. All three of the new per-item actions
// are FINE-GRAINED (`REMOVE_PLAYER`/`UPDATE_PLAYER` take an index,
// `SET_ANSWER` takes one key+value) rather than a coarse "SET_PLAYERS"/
// "SET_ANSWERS" the caller computes — REMOVE specifically needs the reducer
// itself to shift/clear that entry's `self_player_index` correctly (see its
// own doc comment), which only works if the reducer knows WHICH index was
// removed, not just the resulting array. SET_ANSWER started life coarse
// (a whole `answers` object) and was narrowed to one key+value (RS006 fix
// wave finding #1, MEDIUM): the coarse shape made the CALLER build the next
// object by spreading `entry.answers` — a RENDER-time prop closure — so two
// onChange events firing off the same render (a transition, an autofill
// event, a future "clear all" control) both closed over the SAME
// pre-first-write `entry`, and the second dispatch silently overwrote the
// first with no error. A fine-grained action lets the REDUCER own the
// merge against its own `state` argument (always fresh — see
// `dispatchCart`'s `setCart((prev) => cartReducer(prev, action))` in
// register-stepper.tsx, which applies queued actions sequentially against
// the real previous state, never a stale closure) — same fix REMOVE_PLAYER/
// UPDATE_PLAYER already relied on.
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

// RS006 step 4/5 (CONSENT, REVIEW→PAY) added the three cart-derived pure
// functions at the end of this file: `registeringSelfAnywhere` (the
// guardian gate's trigger), `cartHasOtherPlayers` (the captain-roster
// notice's trigger), and `summarizeCart` (the ONE subtotal/waitlist
// computation shared by entry-cart.tsx and step-review.tsx — see
// `summarizeCart`'s own doc comment for why forking this math is the
// specific thing the RS006 dispatch calls out not to do).

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
  | { type: "SET_ANSWER"; id: string; key: string; value: string | boolean }
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
        self_link_declined: false,
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
        self_link_declined: false,
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
        entries: state.entries.map((e) => {
          if (e.id !== action.id) return e;
          const next = { ...e, ...patch };
          // RS007 finding #17. A pair's partner is typed on the ENTRIES step
          // ("Partner's name"), and the DETAILS step then renders the pair's
          // TWO roster rows EMPTY — so the captain types the same person
          // twice, on two screens, and nothing compares the two values. Type
          // anything different the second time and the entry keeps the
          // display name built from the FIRST while its roster says the
          // second, permanently and with no warning. It surfaces on the join
          // page, whose heading is the display name and whose "Which one are
          // you?" list is the roster: the partner following their own invite
          // link sees a heading naming someone who is not in the list.
          //
          // Seeding row 1 means the name is typed once. Only ever seeded when
          // the captain has not made that row their own — it is still blank,
          // or still carries exactly what the partner field said a keystroke
          // ago. A row they have edited themselves is never overwritten, and
          // clearing the partner field never destroys a typed row (`next`
          // must be non-empty), because losing typed roster data to fix a
          // naming mismatch would be the worse trade.
          if (next.entrant_kind !== "pair" || !("partner_name" in patch)) return next;
          const typed = (patch.partner_name ?? "").trim();
          const previous = (e.partner_name ?? "").trim();
          const row = next.players[1];
          if (!row || !typed) return next;
          const rowName = row.full_name.trim();
          if (rowName !== "" && rowName !== previous) return next;
          return {
            ...next,
            players: next.players.map((p, i) => (i === 1 ? { ...p, full_name: typed } : p)),
          };
        }),
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
      //
      // A FREE-AGENT entry refuses `isSelf: true` (RS006 §D, known gap):
      // it has no roster UI (design: "Free-agent entries need nothing
      // extra"), so nothing could ever resolve self_player_index for one —
      // linking it would submit registering_self:true with an unresolvable
      // index and 422 at submit with an error the registrant cannot act on.
      // This is the innermost of three layers making the UI structurally
      // unable to produce that state (the others: entry-cart.tsx never
      // renders the checkbox for a free-agent entry; autoLinkObviousSelf
      // below skips one too). `isSelf: false` (unlinking) is always allowed
      // — refusing THAT would leave a stale link with no way to clear it.
      //
      // `self_link_declined` (RS006 fix wave) mirrors the action's OWN
      // isSelf, inverted: an explicit `isSelf: false` is what "declining"
      // means, so it flips to `true`; an explicit `isSelf: true` is the
      // registrant changing their mind back, so it flips to `false` — a
      // freshly re-linked entry has nothing left to remember. See
      // `CartEntry.self_link_declined`'s own doc comment (types.ts) for why
      // this exists: without it, autoLinkObviousSelf cannot tell "never
      // asked" apart from "asked, and said no."
      // Self-linking is exclusive WITHIN ONE DIVISION, and only there.
      // Across divisions it must stay free — singles + doubles at the same
      // tournament is the common racket-sport case, and schemas.ts's own
      // superRefine calls a cart-wide cap "the defect, not a guard".
      //
      // But twice in the SAME division is not a second entry, it is the same
      // person entered twice: `persons` get-or-create keys on name+dob, so
      // both rows resolve to one person, who then holds two slots in one
      // draw and is charged for both. The phantom slot can push a real
      // entrant onto the waitlist, and the organiser is left to spot the
      // duplicate and refund it by hand. Nothing downstream catches it —
      // there is no unique index on (division_id, entrant).
      //
      // The displaced sibling is unlinked WITHOUT setting
      // `self_link_declined`: the registrant never declined it, we moved
      // their link. Recording a decline would teach autoLinkObviousSelf that
      // they said "not me" about an entry they said nothing about.
      const target = state.entries.find((e) => e.id === action.id);
      const linking = action.isSelf && !!target && !target.free_agent;
      return {
        ...state,
        entries: state.entries.map((e) => {
          if (e.id === action.id) {
            return !action.isSelf || !e.free_agent
              ? { ...e, registering_self: action.isSelf, self_player_index: null, self_link_declined: !action.isSelf }
              : e;
          }
          return linking && e.registering_self && e.division_id === target!.division_id
            ? { ...e, registering_self: false, self_player_index: null }
            : e;
        }),
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

    case "SET_ANSWER": {
      // MERGE against `e.answers` — this entry's answers as THIS reducer
      // application actually sees them, never a caller-built whole object —
      // see the file header for why (fix wave finding #1).
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.id === action.id ? { ...e, answers: { ...e.answers, [action.key]: action.value } } : e,
        ),
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
      self_link_declined: false,
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
 *  matching every other function here.
 *
 *  RS006 fix wave — this is called from an EFFECT keyed on
 *  `cart.entries.length` (register-stepper.tsx), which re-fires on ANY
 *  cart-shape change, not just the one that made it relevant. Before the
 *  `self_link_declined` check below, "not currently linked" was the ONLY
 *  signal available, which is indistinguishable from "explicitly declined,
 *  then an unrelated entry was added and removed" — a length round-trip
 *  (1 -> 2 -> 1) silently re-linked an entry the registrant had just said
 *  was not them. `self_link_declined` (set by SET_ENTRY_SELF) is what
 *  "never overrides an EXPLICIT choice" above actually means now. */
export function autoLinkObviousSelf(cart: CartState, imPlaying: boolean): CartState {
  if (!imPlaying) return cart;
  if (cart.entries.length !== 1) return cart;
  const only = cart.entries[0]!;
  if (only.registering_self) return cart;
  if (only.self_link_declined) return cart;
  // RS006 §D (known gap) — a free-agent entry has no roster UI to ever
  // resolve self_player_index (see SET_ENTRY_SELF's own doc comment above,
  // which the reducer call below would hit anyway — this early return just
  // makes the refusal explicit at THIS call site too, rather than relying
  // solely on the reducer's silent no-op).
  if (only.free_agent) return cart;
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

/** Mirrors `registration-submit.ts`'s own cart-wide `registeringSelfAnywhere`
 *  flag (the guardian-consent gate's trigger, ~line 429) — computed off the
 *  CART's actual links, not the WHO step's `imPlaying` toggle: `imPlaying`
 *  can be true with ZERO entries actually linked (2+ entries is ambiguous,
 *  the rep must explicitly choose one), so gating the guardian block on
 *  `imPlaying` alone would over-trigger it. Step 4 (CONSENT) uses this to
 *  decide both whether to SHOW the guardian block and whether to REQUIRE it
 *  before "Next" — see validation.ts's `guardianRequired`. */
export function registeringSelfAnywhere(cart: CartState): boolean {
  return cart.entries.some((e) => e.registering_self);
}

/** Design §4 step 4: "Notice that captain-entered players will be asked to
 *  confirm when they join/claim" — true whenever the cart, once submitted,
 *  names at least one player row who is NOT the contact's own self-linked
 *  row. A free-agent entry never contributes (design: "nothing extra" — it
 *  has no roster to speak of); an entry with no self-link at all counts
 *  EVERY player row as "other" (nobody has claimed to be the contact on
 *  it); a self-linked entry subtracts exactly one row (the linked one) from
 *  its own player count, whether or not that row's index has been resolved
 *  yet — an unresolved self-link still means "the OTHER rows are other
 *  people," which is the only thing this notice claims. */
export function cartHasOtherPlayers(cart: CartState): boolean {
  return cart.entries.some((e) => {
    if (e.free_agent) return false;
    const selfRows = e.registering_self ? 1 : 0;
    return e.players.length - selfRows > 0;
  });
}

/** One cart line's payability, shared by `summarizeCart` below. */
export interface CartLineSummary {
  entry: CartEntry;
  /** Absent for a stale/unresolvable division_id — same "degrade, don't
   *  throw" precedent as entry-cart.tsx's own division lookup predates this
   *  refactor with. */
  division: DivisionLike | undefined;
  /** True when this entry will NOT be charged now — waitlisted OR the
   *  division has gone stale-closed since it was added (design: "not
   *  charged now" covers both; a restored cart is never re-validated
   *  against live divisions, storage.ts's own doc comment). Undefined
   *  division counts as not-charged-now too (nothing to charge). */
  notChargedNow: boolean;
  /** True specifically for the waitlist case (`closed_reason === "full"`) —
   *  distinct from a stale-closed entry, same distinction entry-cart.tsx
   *  already drew (fix wave finding #4) before this refactor. */
  waitlisted: boolean;
  /** True for a NON-"full" closed reason (the division's window/payment
   *  method changed since this entry was added), as opposed to waitlisted. */
  staleClosed: boolean;
}

export interface CartSummary {
  lines: CartLineSummary[];
  subtotalCents: number;
  /** The subtotal's currency, or null when the cart has nothing payable yet
   *  (matches entry-cart.tsx's own pre-refactor `currency` variable). Every
   *  payable division in a cart shares one currency by construction
   *  (assertUniformPaymentMethod/same-currency rule, registration-submit.ts)
   *  — the LAST payable line's currency is as good as any, same as the
   *  pre-refactor loop's own behaviour. */
  currency: string | null;
}

/**
 * THE subtotal/waitlist computation for the whole cart — design §4 step 5:
 * "waitlisted entries flagged 'not charged now' and excluded from the
 * subtotal (step 2's cart already does this — reuse, do not fork the
 * logic)". Extracted from entry-cart.tsx's own inline loop (RS006 step 2)
 * so BOTH entry-cart.tsx (step 2, editable) and step-review.tsx (step 5,
 * read-only) call this ONE function — a defect in "what counts as payable"
 * can now only exist in one place, not two that could silently drift.
 */
export function summarizeCart(cart: CartState, divisions: readonly DivisionLike[]): CartSummary {
  const byId = new Map(divisions.map((d) => [d.division_id, d]));
  let subtotalCents = 0;
  let currency: string | null = null;
  const lines: CartLineSummary[] = cart.entries.map((entry) => {
    const division = byId.get(entry.division_id);
    const waitlisted = division?.closed_reason === "full";
    const staleClosed = division != null && division.closed_reason != null && division.closed_reason !== "full";
    const notChargedNow = division == null || division.closed_reason != null;
    if (division && division.closed_reason == null) {
      subtotalCents += division.fee_cents;
      currency = division.currency;
    }
    return { entry, division, notChargedNow, waitlisted, staleClosed };
  });
  return { lines, subtotalCents, currency };
}

/** The division that decides the cart's payment PRESENTATION — step 5's
 *  submit button label (register.submit.card/.fee) and its payment-method
 *  note both read this, so the two can never disagree. The first line that
 *  is actually charged now (not waitlisted/stale-closed, fee > 0); every
 *  payable division in a cart shares one payment method by construction
 *  (assertUniformPaymentMethod, registration-submit.ts), so any one of them
 *  is representative. Undefined for an all-free/all-waitlisted cart — there
 *  is nothing to describe how it's paid. */
export function payableDivision(summary: CartSummary): DivisionLike | undefined {
  return summary.lines.find((l) => !l.notChargedNow && l.division && l.division.fee_cents > 0)?.division;
}
