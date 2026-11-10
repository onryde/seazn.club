import "server-only";
// Confirmed entry -> entrant: materialise, join an existing entrant, clear the expiry (see ./index.ts).
// W3 T9 (X-SW-13): a confirmed entry or a promotion into a running Swiss is an automatic arrival — case (c) only.
import { admitKnockoutLateEntrant } from "../knockout-late-entry";
import { admitSwissLateEntrant } from "../swiss-late-entry";
import { divisionPlaysOnline } from "@/server/external-play/online-play";
import { type SeatGate } from "../online-seat-gate";
import { assertDivisionTakesKind, loadEntrantShape } from "../entrant-shape";
import { submitterAccounts } from "../registration-submitter-account";
import type { Tx, RegistrationRow, RegistrationPlayerRow } from "./types";
import { resolvePlayerPerson, findOrCreatePlayerPerson } from "./people";

/**
 * Roster reads (RS001 registration demolition): players now come from
 * `registration_players` (design §6) instead of the dropped `registrations.roster`
 * jsonb. `is_captain desc` orders a team's captain first — the closest
 * available analogue of the old "declared self" row, for callers that only
 * want one representative player (there is none of those left in this file,
 * but the order is a harmless, cheap default for whoever reads `players[0]`
 * next).
 *
 * #402 self-link note: `registration_players.user_id` replaces the old
 * roster's boolean `self` flag — instead of a flag `materialise` had to
 * interpret itself, whichever caller wrote the row (RS002/RS003 at submit,
 * RS008 at claim) decides directly which ONE row, if any, carries the
 * account. `materialise` (via `resolvePlayerPerson`, above) trusts that
 * decision verbatim: a row with a `user_id` resolves into the linked
 * player-lane person; a row without one still mints a fresh, unlinked person
 * exactly as before.
 */
// Projected off RegistrationPlayerRow rather than restated: the row type is the
// table's shape, so a column that appears in the SELECT but never in the
// interface (as `user_id` briefly did) fails the typecheck instead of drifting
// quietly — this file has no other consumer of the type to catch it.
// `email` added for #22 — materialise() below threads it through to
// findOrCreatePlayerPerson so a captain-entered row that DOES carry one
// (typed at submit, or persisted by a claim before this entry's own
// materialise() call fires) dedupes on it.
async function loadPlayers(tx: Tx, registrationId: string): Promise<
  Pick<
    RegistrationPlayerRow,
    "id" | "full_name" | "dob" | "gender" | "email" | "squad_number" | "user_id" | "is_captain"
  >[]
> {
  return tx`
    select id, full_name, dob, gender, email, squad_number, user_id, is_captain from registration_players
    where registration_id = ${registrationId}
    order by is_captain desc, created_at`;
}

/**
 * On an ONLINE division, the submitter's own row - which carries no `user_id` when they gave no date of birth (`deriveLinkUserId`) - is
 * resolved by the account that submitted the cart, as a tied row would be: `resolvePlayerPerson` reuses the person that account already
 * holds in the club (`persons_org_user_lane_uq`: one person per account, so there is no duplicate and no unique-index error to meet) or
 * makes one tied to it. The board reads a Lichess link by the PERSON's account, so a seat left untied is one the gate allowed and the board
 * then turns away. Which row is the submitter's, and whose account, is `registration-submitter-account.ts` - the same rule the seat gate
 * asks. Nobody else is touched: a teammate (typed in, claimed or joined), a minor, an entry made on a guardian's behalf. Left as it was on
 * a division that is not played online: tying every dob-less self-registration to an account is a change for other consumers of the person.
 */
async function withSubmitterAccount<P extends { id: string; user_id: string | null }>(tx: Tx, reg: RegistrationRow, players: P[]): Promise<P[]> {
  const accounts = await submitterAccounts(tx, reg.id);
  if (accounts.size === 0) return players;
  const [division] = await tx<{ sport_key: string; config: unknown }[]>`select sport_key, config from divisions where id = ${reg.division_id}`;
  if (!division || !divisionPlaysOnline(division)) return players;
  return players.map((p) => ({ ...p, user_id: p.user_id ?? accounts.get(p.id) ?? null }));
}

/**
 * Clears the cart's shared `expires_at` ONLY when no OTHER entry in it is
 * still `pending` — i.e. nothing else still depends on the deadline. The
 * counterpart to `promoteWaitlistedRow`'s monotonic-extend ruling (RS002 W5
 * whole-branch review): a deadline can only be EXTENDED while money is still
 * owed, but must still be CLEARED once nothing does, or it lingers stale
 * forever and `groupByRef`/`publicRegistrationStatus` keep surfacing a dead
 * deadline. Call whenever an entry LEAVES `pending` for a reason that is not
 * a fresh promotion: confirm (`materialise`, below — the original site this
 * was factored out of), withdraw (`withdrawCore`), and expiry
 * (`sweepRegistrations`'s overdue branch). Exported for
 * `registration-approval.ts`'s `rejectRegistration`, which has the identical
 * gap on its own reject-a-pending-entry path.
 */
export async function clearExpiresIfNoLongerNeeded(
  tx: Tx,
  groupId: string,
  exceptRegId: string,
): Promise<void> {
  await tx`
    update registration_groups
    set expires_at = case
          when not exists (
            select 1 from registrations
            where group_id = ${groupId} and id <> ${exceptRegId} and status = 'pending'
          ) then null
          else expires_at
        end,
        updated_at = now()
    where id = ${groupId}`;
}

/** Exported for `registration-submit.ts` (RS002 W4) — the submit path
 *  auto-confirms a free, auto-approval, non-waitlisted entry INLINE in the
 *  same transaction by calling this directly, rather than re-deriving
 *  materialization. */
export async function materialise(
  tx: Tx,
  reg: RegistrationRow,
  entrantKind: string,
  seatGate?: SeatGate,
  /** W3 T9: how the entrant arrives, for its `swiss_late_entry` row — a promotion out of the waitlist says so. */
  arrival: "registration" | "waitlist" = "registration",
): Promise<string | null> {
  if (reg.entrant_id) return reg.entrant_id;
  // RS009 — a SOLO SIGN-UP is not a team of one, and must not become an
  // entrant of its own. Design §6 of record: "Free agents materialize as
  // members of the team they were assigned to, or stay unmaterialized until
  // assigned."
  //
  // Without this guard, confirming one — which the card-payment webhook does
  // automatically, with no organiser involved — minted a one-person `team`
  // entrant. That entrant is schedulable and shows in standings, and once the
  // organiser then placed the person on a real team, the SAME person sat on
  // two entrants with a phantom one-player team left in the fixture list that
  // nothing ever removed.
  //
  // Returning null rather than throwing: confirmation itself is legitimate
  // (they have paid, and their entry is real), it simply seats nobody yet.
  // `assignSoloSignUp` is what puts them on a roster, through
  // `joinExistingEntrant`, onto the TEAM's entrant.
  if (reg.free_agent) {
    // Still CONFIRM them — they have paid and their entry is real; they are
    // simply not seated yet. `materialise` owns the status flip as well as
    // the entrant insert, so returning before this update left a paid solo
    // sign-up stuck at `pending` forever, with no organiser action able to
    // move it. Caught by the very test written for this guard.
    await tx`
      update registrations
      set status = 'confirmed', updated_at = now()
      where id = ${reg.id}`;
    // ...and clear the cart's payment clock, exactly as the normal path
    // below does. `materialise` owns this as well as the status flip, so
    // returning before it left `registration_groups.expires_at` set forever
    // when a solo sign-up was the cart's LAST pending entry — the same gap
    // RS002 W5 closed for every other confirm site.
    await clearExpiresIfNoLongerNeeded(tx, reg.group_id, reg.id);
    return null;
  }
  // FU1 ruling 4: the entrant must be of a kind the division takes - the same refusal `createEntrants` makes. The kind
  // was allowed at submit, but the organiser can narrow Entrant kinds while an entry waits for approval or payment. Refused
  // with the named code BEFORE any write, so nothing is inserted; the caller's transaction rolls back whatever it wrote
  // before this call (a webhook's `status = 'paid'` included: Stripe redelivers, see confirmPaidRegistration).
  assertDivisionTakesKind(await loadEntrantShape(tx, reg.division_id), entrantKind);
  const [entrant] = await tx<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, status)
    values (${reg.division_id}, ${entrantKind}, ${reg.display_name}, 'confirmed')
    returning id`;
  const players = await withSubmitterAccount(tx, reg, await loadPlayers(tx, reg.id));
  if (entrantKind === "individual") {
    // No player row yet (nothing populates registration_players until
    // RS002/RS003 ship the new submit flow) falls back to the entry's own
    // display_name with no dob/gender — byte-for-byte the old anonymous path.
    // A player row that DOES exist but carries only whitespace (review
    // MINOR) falls back the same way — `.trim() || …` matches the
    // team/pair branch below, which already trims and skips blank names.
    const p = players[0];
    const fullName = p?.full_name?.trim() || reg.display_name;
    const dob = p?.dob ?? null;
    const gender = p?.gender ?? null;
    const email = p?.email ?? null;
    // A player row carrying a user_id (#402) resolves into that account's
    // linked person — see resolvePlayerPerson. Otherwise
    // findOrCreatePlayerPerson applies the email/dob reuse rule (RS002, #22),
    // which also covers the no-player-row fallback above: no email and a
    // null dob there always mints fresh, byte-for-byte the old anonymous
    // path.
    const personId = p?.user_id
      ? await resolvePlayerPerson(tx, reg.org_id, p.user_id, fullName, dob, gender)
      : await findOrCreatePlayerPerson(tx, reg.org_id, fullName, dob, gender, email);
    // A RESOLVED person can already sit on this entrant (re-confirm), which the
    // fresh-insert path could never hit — so the membership write is idempotent.
    await tx`
      insert into entrant_members (entrant_id, person_id)
      values (${entrant.id}, ${personId})
      on conflict (entrant_id, person_id) do nothing`;
    // No player row when the fallback above ran (nothing to stamp).
    if (p) {
      await tx`
        update registration_players set person_id = ${personId}, updated_at = now()
        where id = ${p.id}`;
    }
  } else if ((entrantKind === "team" || entrantKind === "pair") && players.length > 0) {
    // Team/pair roster → a person + squad member per player row. Same #402
    // link check as the individual branch above, per player. `pair` (RS002:
    // registration_players now carries real rows for a pair entry, so it
    // takes the same per-player path team always has) carries squad_number
    // and is_captain exactly as team does — both columns already exist on
    // entrant_members and loadPlayers already selects them. Delegates to
    // `joinExistingEntrant` (#23) — same person-resolution precedence, same
    // idempotent entrant_members upsert, one copy instead of two that could
    // silently drift apart (RS007 review, medium).
    for (const p of players) {
      await joinExistingEntrant(tx, reg.org_id, entrant.id, {
        id: p.id,
        full_name: p.full_name,
        dob: p.dob,
        gender: p.gender,
        email: p.email,
        user_id: p.user_id,
        squad_number: p.squad_number,
        is_captain: p.is_captain,
      });
    }
  }
  // The seat gate (online-seat-gate.ts): the roster this entrant now HOLDS - whoever the players resolved to, a person minted a
  // moment ago included - must be able to play on an online division. Read back from the table rather than predicted from the
  // player rows, so it cannot drift from what the branches above wrote; a refusal rolls the whole confirmation back. Passed by the
  // doors that seat on a person's behalf (the organiser's approve / confirm / waive / mark-paid, a promotion that seats). The card
  // webhook does not pass it: the registrant has PAID, and a payment that has already moved cannot be un-taken by a 422 - the seat
  // was asked about at submit (the submitter) and is asked again at the organiser's own doors. The submit's inline confirm does not
  // pass it either, but asks the same gate itself, for everyone but the submitter (registration-submit.ts: the submitter is asked
  // by their own session link before the transaction).
  if (seatGate) {
    const seated = await tx<{ person_id: string }[]>`select person_id from entrant_members where entrant_id = ${entrant.id}`;
    await seatGate.assertRoster(tx, reg.division_id, seated.map((m) => m.person_id));
  }
  // W3 T9 (X-SW-13, ruling 250): a division whose Swiss is running takes this entrant as a late player — automatically,
  // so case (c) only: they join the next round's Pair and no published pairing moves. Never refused: with no round
  // left, or the Swiss over, the arrival is recorded as joining after the last round (Review Focus 4: a payment that has
  // moved cannot be un-taken by a 409). Null before Start, or with no running Swiss.
  // W4 T11 (X-LE-10, K7, ruling 271): or its started root knockout — where the arrival WAITS, flagged on the desk for the
  // organiser's one tap, never placed by the app and never refused. A division's entry stage is one or the other.
  if ((await admitSwissLateEntrant(tx, null, reg.division_id, entrant.id, arrival)) === null) {
    await admitKnockoutLateEntrant(tx, null, reg.division_id, entrant.id, arrival);
  }
  await tx`
    update registrations
    set entrant_id = ${entrant.id}, status = 'confirmed', updated_at = now()
    where id = ${reg.id}`;
  // expires_at (the pay-by deadline) lives on the cart, shared by every
  // entry in it (RS002 W5 review MAJOR — this used to clear it
  // UNCONDITIONALLY on every confirm, from all five confirm call sites:
  // confirmRegistration, markRegistrationPaidOffline,
  // confirmRegistrationWaived, confirmPaidRegistration, and
  // approveRegistration. A pending SIBLING's still-live Stripe deadline was
  // wiped whenever ANY other entry in its cart confirmed; that sibling then
  // never expired via sweepRegistrations, and groupByRef stopped showing a
  // deadline for money still owed on it). clearExpiresIfNoLongerNeeded, above,
  // clears only when nothing else in the cart still needs it — the SAME
  // helper withdrawCore and sweepRegistrations' expiry branch now call too.
  await clearExpiresIfNoLongerNeeded(tx, reg.group_id, reg.id);
  return entrant.id;
}

/**
 * Person-resolve one player row onto an entrant that already exists, and
 * write its `entrant_members` row + `registration_players.person_id` stamp.
 * Shared by two callers with different reasons for needing it:
 *
 *  - `materialise()`'s own team/pair branch, above — every player row
 *    present AT materialise time, `squad_number`/`is_captain` carried
 *    through as-is.
 *  - `joinTeamEntry`'s INSERT branch (#23, 2026-08-30) — a self-joiner
 *    landing on an entry that was ALREADY materialised before they joined.
 *    `materialise()`'s own idempotency guard (`if (reg.entrant_id) return`,
 *    above) means it never revisits that registration once confirmed, so
 *    the per-player `entrant_members` insert above never runs for a row
 *    inserted after — the joiner's `registration_players` row would exist
 *    and the join page would tell them "you're in", but nothing rosters
 *    them onto the entrant that actually gets fielded. Called with no
 *    `squad_number`/`is_captain` (a self-joiner is never seeded as either).
 *    Never called for the CLAIM branch — a claimed row's person resolution
 *    is `reconcileClaimedPerson`'s job, not this one's, because a claim
 *    UPDATES a row `materialise()` already turned into a member (dummy or
 *    real); there is no membership missing to create.
 *
 * Extracted (RS007 review, medium, 2026-08-30) rather than left as two
 * hand-copies of the same person-resolution + idempotent-upsert sequence —
 * a future change to it (a new column, a different resolution precedence)
 * is easy to apply to one copy and forget in the other.
 *
 * Returns the person seated, or null for a nameless row (it seats nobody).
 * It does not ask the ONLINE-PLAY SEAT GATE (online-seat-gate.ts) itself: the
 * caller that seats on a person's behalf does, with this id - `materialise`
 * for the whole roster it made, `assignSoloSignUp` for the player it placed.
 * `joinTeamEntry`'s self-joiner is asked by their own session link first.
 */
export async function joinExistingEntrant(
  tx: Tx,
  orgId: string,
  entrantId: string,
  player: {
    id: string;
    full_name: string;
    dob: string | null;
    gender: string | null;
    email: string | null;
    user_id: string | null;
    squad_number?: number | null;
    is_captain?: boolean;
  },
): Promise<string | null> {
  const name = player.full_name.trim();
  if (!name) return null;
  const personId = player.user_id
    ? await resolvePlayerPerson(tx, orgId, player.user_id, name, player.dob, player.gender)
    : await findOrCreatePlayerPerson(tx, orgId, name, player.dob, player.gender, player.email);
  await tx`
    insert into entrant_members (entrant_id, person_id, squad_number, is_captain)
    values (${entrantId}, ${personId}, ${player.squad_number ?? null}, ${player.is_captain ?? false})
    on conflict (entrant_id, person_id) do nothing`;
  await tx`
    update registration_players set person_id = ${personId}, updated_at = now()
    where id = ${player.id}`;
  return personId;
}
