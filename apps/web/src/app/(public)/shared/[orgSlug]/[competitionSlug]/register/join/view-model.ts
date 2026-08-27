// Pure view-model logic for the public join page (RS007 §2 — "join becomes
// CLAIM-first", `_INDEX.md` ruling 2026-08-27). Zero React, zero DB: every
// export is a plain function of plain data, so the rules that matter most
// (which slot is pre-selected, what a claim-vs-insert submit actually
// sends, how a status code maps to a DESIGNED state rather than a raw
// error) are provable without a render. Mirrors register/status/
// view-model.ts's own "pure logic, own file" convention for this route.
import type { CartState, ContactState } from "@/components/public-site/register/types";
import type { WhoFieldRequirements } from "@/components/public-site/register/validation";

/** Sentinel for "add me as a new player" — never a real player_id (those
 *  are uuids). PublicJoinRequest's own contract is "player_id omitted ->
 *  insert", so the picker needs its own selectable value for that case
 *  rather than reusing null (null stays "nothing chosen yet" — see
 *  defaultSlotChoice/canSubmitJoin). */
export const NEW_PLAYER_CHOICE = "new" as const;
export type SlotChoice = string;

export interface JoinSlot {
  player_id: string;
  full_name: string;
}

/**
 * What the picker starts on. In priority order:
 *  1. A per-slot link (`?player_id=`) that still names a REAL unclaimed
 *     slot — honoured even when other slots exist (status page's own
 *     claimHref mints these; "a per-slot link arrives with that slot
 *     pre-selected" is the acceptance bar, not merely offered).
 *  2. Exactly one possible answer — one unclaimed slot and no "someone
 *     else" option (a pair, or a team with one captain-entered row left
 *     and an already-full sport cap), or zero slots with ONLY "someone
 *     else" — nothing to ask, so the sole option is pre-picked rather than
 *     making the joiner click a radio that was never really a choice.
 *  3. Otherwise genuinely ambiguous (2+ options): null, forcing an
 *     explicit pick before Join can be pressed (canSubmitJoin below).
 *
 * A stale/unmatched `requestedPlayerId` (already claimed by someone else,
 * or simply wrong) is silently ignored rather than surfaced as its own
 * error — surfacing "that specific id doesn't exist" would be the exact
 * existence oracle the join_code 404 shape exists to avoid.
 */
export function defaultSlotChoice(
  slots: readonly Pick<JoinSlot, "player_id">[],
  allowNewPlayer: boolean,
  requestedPlayerId: string | null,
): SlotChoice | null {
  if (requestedPlayerId && slots.some((s) => s.player_id === requestedPlayerId)) {
    return requestedPlayerId;
  }
  if (slots.length === 1 && !allowNewPlayer) return slots[0]!.player_id;
  if (slots.length === 0 && allowNewPlayer) return NEW_PLAYER_CHOICE;
  return null;
}

export function canSubmitJoin(selected: SlotChoice | null): boolean {
  return selected !== null;
}

/**
 * Synthesizes a single-entry CartState around the joiner's OWN name — the
 * only reason this exists is so StepConsent's reused, already-tested
 * `guardianRequired`/`cartHasOtherPlayers` (validation.ts/cart.ts) see
 * exactly what a join actually is: one person, registering themselves,
 * naming nobody else. `cartHasOtherPlayers` reads `players.length - (1 if
 * registering_self)`, so a single self-linked player row always reads as
 * zero "other" players — the captain-facing roster notice (about naming
 * OTHER people) never fires for a joiner. `players[0].dob`/`.gender` stay
 * null on purpose so effectiveSelfDob/effectiveSelfPlayers fall back to
 * `contact.dob`/`.gender` — the join form's WHO fields ARE the joiner's own
 * row; unlike the captain's cart there is no separate roster input to
 * source them from.
 */
export function joinerCart(contact: Pick<ContactState, "name">): CartState {
  return {
    entries: [
      {
        id: "join",
        division_id: "",
        entrant_kind: "individual",
        team_name: null,
        partner_name: null,
        free_agent: false,
        players: [
          { full_name: contact.name, dob: null, gender: null, email: "", squad_number: "", is_captain: false },
        ],
        answers: {},
        registering_self: true,
        self_player_index: 0,
      },
    ],
  };
}

/** The join-equivalent of whoFieldRequirements (validation.ts) — a joiner
 *  is unconditionally "playing" (there is no non-playing-club-rep case on a
 *  join link), so this is a straight pass-through of the division's own
 *  requirement, never gated behind an imPlaying toggle the join form
 *  doesn't render (see join-form.tsx's showSelfToggle={false}). */
export function joinWhoRequirements(requiresDob: boolean, requiresGender: boolean): WhoFieldRequirements {
  return { dobRequired: requiresDob, genderRequired: requiresGender };
}

export interface JoinRequestBody {
  join_code: string;
  player_id?: string;
  player: { full_name: string; dob: string | null; gender: string | null; email: string };
  guardian_name: string | null;
  guardian_consent: boolean;
}

/** Mirrors PublicJoinRequest's wire shape field-for-field (schemas.ts).
 *  `player_id` is OMITTED (not sent as an explicit null) for the
 *  NEW_PLAYER_CHOICE case — joinTeamEntry's own contract is "player_id
 *  absent -> insert", and omitting the key is the more honest wire shape
 *  for "this field does not apply" (matches submit.ts's own
 *  SubmitRequestBody convention of never sending a field that means
 *  nothing for the current case). */
export function buildJoinBody(joinCode: string, selected: SlotChoice, contact: ContactState): JoinRequestBody {
  return {
    join_code: joinCode,
    ...(selected === NEW_PLAYER_CHOICE ? {} : { player_id: selected }),
    player: {
      full_name: contact.name.trim(),
      dob: contact.dob,
      gender: contact.gender,
      email: contact.email.trim(),
    },
    guardian_name: contact.guardian_name,
    guardian_consent: contact.guardian_consent,
  };
}

/**
 * Maps a join POST's HTTP status to one of the page's DESIGNED states —
 * never the raw server string (CRITICAL: join_code is a capability token;
 * join-form.tsx's own contract, enforced by its tests, is that no server
 * error text ever reaches the rendered page). Deliberately its OWN
 * classification, not a reuse of submit.ts's classifySubmitFailure: that
 * function reads 409 as "retry" (a checkout-mint race, safe to resubmit
 * unchanged) — here 409 means "someone else already claimed this exact
 * slot" (joinTeamEntry's own doc comment), a genuine conflict that must
 * show a DIFFERENT message and offer a refresh, never "click Join again".
 *  - notFound (404): the join_code itself is dead — a `player_id` that
 *    stopped resolving reads identically (joinTeamEntry's own "reads
 *    exactly like an invalid link" contract), so this and the page's own
 *    initial-load 404 render the SAME copy.
 *  - conflict (409): a real race, the slot is gone — offer a refresh.
 *  - retry (no response / 5xx): transient, the exact same click is
 *    expected to work.
 *  - rejected (everything else — 400/422/…): the server refused what was
 *    submitted (roster cap, pair-can't-add, guardian missing, eligibility).
 */
export type JoinFailureKind = "notFound" | "conflict" | "retry" | "rejected";

export function classifyJoinFailure(status: number | undefined): JoinFailureKind {
  if (status === undefined) return "retry";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status >= 500) return "retry";
  return "rejected";
}

export interface RosterMeter {
  claimed: number;
  total: number;
}

/**
 * The success state's fill meter, computed ENTIRELY from what the page
 * already knew before the submit — previewJoinEntry's `total_players`/
 * `unclaimed_slots` — rather than a second round-trip: a CLAIM flips one
 * pending row to granted/guardian (total unchanged, claimed +1); an INSERT
 * (`viaNewPlayer`) adds a brand-new, already-consented row (both +1).
 */
export function rosterMeterAfterJoin(
  totalBefore: number,
  unclaimedBefore: number,
  viaNewPlayer: boolean,
): RosterMeter {
  const claimedBefore = totalBefore - unclaimedBefore;
  return viaNewPlayer
    ? { claimed: claimedBefore + 1, total: totalBefore + 1 }
    : { claimed: claimedBefore + 1, total: totalBefore };
}
