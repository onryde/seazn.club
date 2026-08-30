import "server-only";
// RS009 — placing a pooled solo sign-up onto a team entry.
//
// A "solo sign-up" is someone who entered a TEAM division on their own
// (`registrations.free_agent`), because the division allows it. Until this
// module existed they had no way out of the pool: `joinTeamEntry` explicitly
// refuses a free agent, and nothing else wrote a roster row for them. The
// public stepper has nonetheless promised, since RS006, that "the organiser
// will assign you to a team once one has space" — this is that promise's
// implementation.
//
// A separate module rather than more of `registrations.ts` on purpose. That
// file is where this programme's lanes keep colliding (its index records
// two waves serialised behind exactly that), and everything here is reached
// through paths it already exports — `joinExistingEntrant`, `rosterCapExpr`,
// `audit`, `orgReg`. Nothing is reimplemented; the roster
// write, the person resolution and the cap expression each have one home
// and this is a caller, not a second copy.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  audit,
  divisionCtx,
  joinExistingEntrant,
  orgReg,
  releaseSoloSignUpPlacement,
  rosterCapExpr,
} from "./registrations";
import { sql } from "@/lib/db";
import { sendSoloSignUpAssignedEmail } from "@/lib/email";
import { toLocale } from "@/lib/i18n-constants";

type Tx = postgres.TransactionSql;

export interface AssignSoloSignUpInput {
  /** The pooled solo sign-up's own registration. */
  registration_id: string;
  /** The team entry to place them on. Must be in the same division. */
  target_registration_id: string;
}

export interface AssignSoloSignUpResult {
  registration_id: string;
  target_registration_id: string;
  /** The roster row created (or the one already there — this is idempotent). */
  player_id: string;
  target_display_name: string;
  roster_count: number;
  roster_cap: number | null;
}

export interface UnassignSoloSignUpResult {
  registration_id: string;
  /** Null when the entry was already in the pool — unassign is idempotent. */
  target_registration_id: string | null;
}

/** The one roster row that represents a solo sign-up's placement, if any.
 *  `assigned_from_registration_id` is unique where non-null (V388), so this
 *  is at most one row by construction rather than by convention. */
async function placementOf(
  tx: Tx,
  registrationId: string,
): Promise<{ id: string; registration_id: string; person_id: string | null } | null> {
  const [row] = await tx<{ id: string; registration_id: string; person_id: string | null }[]>`
    select id, registration_id, person_id from registration_players
    where assigned_from_registration_id = ${registrationId}`;
  return row ?? null;
}

/** Live roster size and cap for a team entry.
 *
 *  The cap comes from `rosterCapExpr` — the single source RS005 extracted so
 *  the join-time cap and the displayed `5/7` could not drift. Re-inlining
 *  that expression here is exactly the fork that extraction exists to
 *  prevent, so this joins the sports row as `sp` to satisfy its hardcoded
 *  alias. A NULL cap means unlimited, not zero. */
async function rosterState(
  tx: Tx,
  registrationId: string,
): Promise<{ count: number; cap: number | null }> {
  const [row] = await tx<{ count: string; cap: number | null }[]>`
    select
      (select count(*)::text from registration_players rp where rp.registration_id = r.id) as count,
      ${rosterCapExpr(tx)} as cap
    from registrations r
    join divisions d on d.id = r.division_id
    join sports sp on sp.key = d.sport_key
    where r.id = ${registrationId}`;
  return { count: Number(row?.count ?? 0), cap: row?.cap ?? null };
}

/** Does the target roster still satisfy its division's gender rule once this
 *  person joins?
 *
 *  Only `mixed` constrains composition (design §2 ruling 3: a mixed roster
 *  needs at least one of each gender). The check runs on the roster AS IT
 *  WOULD BE, not as it is — a mixed team of three men is legal while it is
 *  still filling and only becomes a problem if this is the last slot. So the
 *  refusal fires when adding this player makes the roster FULL and still
 *  single-gendered: blocking earlier would refuse a placement that the very
 *  next one would have made valid.
 *
 *  Returns a human reason, or null when the placement is fine. */
function compositionRefusal(
  category: string | null,
  genders: (string | null)[],
  capReached: boolean,
): string | null {
  if (category !== "mixed") return null;
  if (!capReached) return null;
  const seen = new Set(genders.filter((g): g is string => g === "m" || g === "f"));
  if (seen.size >= 2) return null;
  return "This would fill the team with players of one gender, and the division is mixed — a mixed team needs at least one of each.";
}

/**
 * Place a pooled solo sign-up onto a team entry in the same division.
 *
 * Idempotent: re-running with the same pair is a no-op that returns the
 * existing placement, because an organiser double-clicking Assign is not an
 * error and `entrant_members`' own PK already treats a repeat as nothing.
 *
 * The whole check-then-write runs inside ONE transaction holding a row lock
 * on the TARGET registration — the same `for update` lock `joinTeamEntry`
 * takes on the row it writes to. Assign and join compete for the same last
 * roster slot, so without sharing that lock two writers could each read
 * `6/7`, each decide there is room, and both insert. Whoever loses the race
 * here fails cleanly on a full roster instead of overfilling it.
 */
export async function assignSoloSignUp(
  auth: AuthCtx,
  input: AssignSoloSignUpInput,
): Promise<AssignSoloSignUpResult> {
  const { registration_id: sourceId, target_registration_id: targetId } = input;
  if (sourceId === targetId) {
    throw new HttpError(422, "An entry cannot be assigned to itself");
  }

  const result = await withTenant(auth.orgId, async (tx) => {
    // LOCK ORDER: source, then target. Both functions in this file must use
    // the SAME order or they deadlock against each other — `orgReg` is not
    // just a read, it ends in `for update`, so it is the source-side lock.
    // The first version of this function locked target-then-source while
    // `unassignSoloSignUp` locked source-then-target, which is the textbook
    // AB/BA cycle: an assign and an unassign touching the same pair would
    // have had one side aborted by Postgres with a raw deadlock error, not a
    // clean refusal. Found in review, not by a test — a deadlock needs two
    // live transactions and nothing here runs two.
    const source = await orgReg(tx, sourceId);
    const [target] = await tx<
      { id: string; division_id: string; display_name: string; free_agent: boolean; status: string; entrant_id: string | null }[]
    >`
      select id, division_id, display_name, free_agent, status, entrant_id
      from registrations where id = ${targetId} for update`;
    if (!target) throw new HttpError(404, "That team entry no longer exists");
    if (!source.free_agent) {
      throw new HttpError(422, "Only a solo sign-up can be assigned to a team");
    }
    if (target.free_agent) {
      throw new HttpError(422, "A solo sign-up has no roster to assign anyone to");
    }
    if (target.division_id !== source.division_id) {
      throw new HttpError(422, "A solo sign-up can only join a team in the same division");
    }
    if (["withdrawn", "rejected", "expired"].includes(target.status)) {
      throw new HttpError(422, `That team entry is ${target.status} and is not taking players`);
    }
    if (["withdrawn", "rejected", "expired"].includes(source.status)) {
      throw new HttpError(422, `This entry is ${source.status} and cannot be placed on a team`);
    }
    // Waitlisted is NOT terminal, so neither guard above catches it — and it
    // is exactly the state that must not be placed. A waitlisted entry holds
    // no capacity spot and was charged nothing (`registration-submit.ts`
    // quotes `waitlisted ? 0 : fee`), so placing one would hand out a roster
    // place for free; and a waitlisted TEAM is not in the division yet, so
    // filling its roster commits a player to an entry that may never be
    // promoted. Promote first, then assign.
    // Neither terminal nor waitlisted, and still not seatable: a `pending`
    // entry has not paid (or has not been approved on a manual division), and
    // nothing downstream ever charges or confirms someone who was seated
    // early — assign is not a payment path. `paid` is fine: the money is in
    // and only the organiser's own confirm step is outstanding.
    if (!["confirmed", "paid"].includes(source.status)) {
      throw new HttpError(
        422,
        `This entry is ${source.status} — confirm it (or mark it paid) before placing them on a team`,
      );
    }
    if (source.status === "waitlisted") {
      throw new HttpError(
        422,
        "This entry is on the waitlist — promote it before placing them on a team",
      );
    }
    if (target.status === "waitlisted") {
      throw new HttpError(
        422,
        `${target.display_name} is on the waitlist — promote it before adding players`,
      );
    }

    // Already placed? Same target = idempotent success; different target =
    // a refusal that names where they are, so the organiser can unassign
    // rather than guess why Assign did nothing.
    const existing = await placementOf(tx, sourceId);
    if (existing) {
      if (existing.registration_id === targetId) {
        const state = await rosterState(tx, targetId);
        const [{ full_name: existingPlayerName }] = await tx<{ full_name: string }[]>`
          select full_name from registration_players where id = ${existing.id}`;
        const [{ name: existingDivisionName }] = await tx<{ name: string }[]>`
          select name from divisions where id = ${target.division_id}`;
        return {
          registration_id: sourceId,
          target_registration_id: targetId,
          player_id: existing.id,
          target_display_name: target.display_name,
          roster_count: state.count,
          roster_cap: state.cap,
          alreadyPlaced: true,
          // The REAL notification data, not blanks. An earlier version put
          // nulls here "because the notification is skipped anyway", which
          // made `alreadyPlaced` redundant with the null-email check and left
          // the double-click guard untested: a mutant that dropped
          // `!result.alreadyPlaced` still sent nothing, so the test passed
          // for the wrong reason and the mutant SURVIVED. With real data
          // here, `alreadyPlaced` is the only thing preventing a second
          // email, which is exactly what the test should be pinning.
          notify: {
            email: source.contact_email,
            locale: source.locale,
            playerName: existingPlayerName,
            divisionId: target.division_id,
            divisionName: existingDivisionName,
          },
        };
      }
      const [{ display_name: onTeam }] = await tx<{ display_name: string }[]>`
        select display_name from registrations where id = ${existing.registration_id}`;
      throw new HttpError(409, `This player is already on ${onTeam}. Remove them from that team first.`);
    }

    const state = await rosterState(tx, targetId);
    if (state.cap !== null && state.count >= state.cap) {
      throw new HttpError(422, `${target.display_name} is full (${state.count}/${state.cap}).`);
    }

    // The solo sign-up's OWN roster row is the person being placed. A solo
    // entry has exactly one; if it somehow has none there is no name to put
    // on the roster and nothing sensible to invent.
    // consent_status/consent_at are read HERE, with the rest of the player,
    // rather than re-fetched inside the INSERT by a cross join. The cross
    // join made the insert silently write ZERO rows if that subselect ever
    // returned nothing, and `inserted.id` was then dereferenced three times
    // on undefined. One read, one guard, no second lookup that can disagree
    // with the first.
    const [player] = await tx<
      {
        id: string; full_name: string; email: string | null; dob: string | null;
        gender: string | null; user_id: string | null;
        consent_status: string; consent_at: Date | null;
      }[]
    >`
      select id, full_name, email, dob, gender, user_id, consent_status, consent_at
      from registration_players where registration_id = ${sourceId}
      order by created_at, id limit 1`;
    if (!player) {
      throw new HttpError(422, "This entry has no player details to place on a team");
    }

    const capReached = state.cap !== null && state.count + 1 >= state.cap;
    const [division] = await tx<{ category: string | null; competition_id: string; name: string }[]>`
      select category, competition_id, name from divisions where id = ${target.division_id}`;
    const existingGenders = await tx<{ gender: string | null }[]>`
      select gender from registration_players where registration_id = ${targetId}`;
    if (!division) throw new HttpError(404, "That division no longer exists");
    const refusal = compositionRefusal(
      division.category,
      [...existingGenders.map((g) => g.gender), player.gender],
      capReached,
    );
    if (refusal) throw new HttpError(422, refusal);

    // The placed row carries the solo sign-up's OWN consent forward rather
    // than starting at 'pending'. They consented at their own submit — they
    // filled the form themselves — so making them re-consent would ask a
    // second time for something already given, and would show the organiser
    // a consent-pending player who has in fact consented. This is the one
    // way an `organiser_assigned` row differs from a `captain_entered` one,
    // where 'pending' is right because someone else typed the name.
    let inserted: { id: string } | undefined;
    try {
      [inserted] = await tx<{ id: string }[]>`
        insert into registration_players
          (registration_id, org_id, full_name, email, dob, gender, source,
           consent_status, consent_at, assigned_from_registration_id)
        select ${targetId}, r.org_id, ${player.full_name}, ${player.email}, ${player.dob},
               ${player.gender}, 'organiser_assigned', ${player.consent_status},
               ${player.consent_at}, ${sourceId}
        from registrations r where r.id = ${targetId}
        returning id`;
    } catch (err) {
      // 23505 is the partial unique index on assigned_from_registration_id:
      // one person, one team. The `existing` check above catches the ordinary
      // case, but two organisers pressing Assign on the same pooled player at
      // the same instant both pass it and the index decides. Without this the
      // loser gets a raw Postgres error as a 500; the refusal it deserves is
      // the same 409 the checked path already gives.
      if ((err as { code?: string }).code === "23505") {
        throw new HttpError(409, "This player has just been placed on another team");
      }
      throw err;
    }
    if (!inserted) throw new HttpError(404, "That team entry no longer exists");

    // Already materialised? Then `materialise()` will never revisit this
    // registration (it returns early once `entrant_id` is set), so the row
    // just inserted would never become an `entrant_members` row on its own —
    // the player would appear on the registration and be missing from the
    // team that actually gets fielded. That is finding #23's exact shape.
    // `joinExistingEntrant` is the shared path for precisely this, and its
    // docstring names RS009 as a caller.
    if (target.entrant_id) {
      await joinExistingEntrant(tx, auth.orgId, target.entrant_id, {
        id: inserted.id,
        full_name: player.full_name,
        dob: player.dob,
        gender: player.gender,
        email: player.email,
        user_id: player.user_id,
      });
    }

    await audit(
      tx,
      division.competition_id,
      auth.orgId,
      "registration.solo_signup_assigned",
      { registration_id: sourceId, target_registration_id: targetId, player_id: inserted.id },
      auth.userId,
    );

    const after = await rosterState(tx, targetId);
    return {
      registration_id: sourceId,
      target_registration_id: targetId,
      player_id: inserted.id,
      target_display_name: target.display_name,
      roster_count: after.count,
      roster_cap: after.cap,
      alreadyPlaced: false,
      // Carried out for the notification below — read inside the tx because
      // that is where the row is already locked and consistent, but USED
      // outside it: a mail send must never sit inside a transaction holding
      // a row lock on a contended roster.
      notify: {
        email: source.contact_email,
        locale: source.locale,
        playerName: player.full_name,
        divisionId: target.division_id,
        divisionName: division.name,
      },
    };
  });

  // The one message this feature owes (owner ruling, 2026-08-30): the person
  // who entered alone is told they now have a team. Fire-and-forget AFTER the
  // transaction commits — a placement that succeeded must not be rolled back
  // because a mail server was slow, and a send must never hold the roster
  // lock. Skipped on an idempotent repeat: an organiser double-clicking
  // Assign should not email the registrant twice.
  if (!result.alreadyPlaced && result.notify.email) {
    void (async () => {
      try {
        const ctx = await divisionCtx(sql, result.notify.divisionId);
        await sendSoloSignUpAssignedEmail({
          to: result.notify.email as string,
          locale: toLocale(result.notify.locale),
          orgName: ctx.org_name,
          competitionName: ctx.comp_name,
          divisionName: result.notify.divisionName,
          playerName: result.notify.playerName,
          teamName: result.target_display_name,
          refStatusUrl: null,
        });
      } catch (err) {
        log.warn(
          { registrationId: result.registration_id, err: String(err) },
          "registration: solo sign-up assigned, but the notification failed",
        );
      }
    })();
  }

  log.info(
    {
      orgId: auth.orgId,
      actorId: auth.userId,
      registrationId: result.registration_id,
      targetRegistrationId: result.target_registration_id,
      rosterCount: result.roster_count,
      rosterCap: result.roster_cap,
      alreadyPlaced: result.alreadyPlaced,
    },
    "registration: solo sign-up assigned to a team",
  );

  return {
    registration_id: result.registration_id,
    target_registration_id: result.target_registration_id,
    player_id: result.player_id,
    target_display_name: result.target_display_name,
    roster_count: result.roster_count,
    roster_cap: result.roster_cap,
  };
}

/**
 * Return a placed solo sign-up to the pool.
 *
 * Idempotent for the same reason assign is: an entry already in the pool is
 * the desired end state, so saying so again is not an error.
 *
 * Refused once the division has started. After that the roster is
 * scheduling's territory — fixtures, and possibly results, already reference
 * the entrant, and quietly pulling a player out from under them would leave
 * a board that no longer matches the teams that played.
 */
export async function unassignSoloSignUp(
  auth: AuthCtx,
  input: { registration_id: string },
): Promise<UnassignSoloSignUpResult> {
  const sourceId = input.registration_id;

  const result = await withTenant(auth.orgId, async (tx) => {
    // Lock order: source, then target — the same order assignSoloSignUp
    // uses, so the two can never deadlock. `orgReg` ends in `for update`, so
    // it IS the source-side lock; `releaseSoloSignUpPlacement` takes the
    // target-side one itself.
    const source = await orgReg(tx, sourceId);
    const found = await placementOf(tx, sourceId);
    if (!found) return { registration_id: sourceId, target_registration_id: null };

    // "Has the division started?" has two honest answers and this refuses on
    // either, because either means the roster is no longer the organiser's to
    // shuffle freely:
    //
    //  - FIXTURES EXIST. The real commitment: a fixture names the entrant, so
    //    pulling a player out from under it leaves a board that no longer
    //    matches the team about to play. Note `divisions` has no start date
    //    of its own — an earlier version read `divisions.starts_on` and every
    //    test said `column "starts_on" does not exist`.
    //  - The competition's own `starts_on` has passed. A date can arrive
    //    before anyone builds a schedule, and once a competition is under way
    //    its rosters should be settled regardless.
    // `started` is computed IN SQL, by the same expression `listRegistrations`
    // uses for its `division_started` column. The first version compared
    // `new Date(starts_on) <= new Date()` in JS while the read path compared
    // `c.starts_on <= current_date` in Postgres: two different clocks, which
    // disagree for hours around a start-date boundary. The hub would then
    // show Remove on a row the server refuses, or hide it on one the server
    // would have accepted. One expression, one answer.
    const [division] = await tx<{ competition_id: string; started: boolean }[]>`
      select d.competition_id,
             (exists (select 1 from fixtures f where f.division_id = d.id)
               or (c.starts_on is not null and c.starts_on <= current_date)) as started
      from divisions d join competitions c on c.id = d.competition_id
      where d.id = ${source.division_id}`;
    if (!division) throw new HttpError(404, "That division no longer exists");
    const started = division.started;
    if (started) {
      throw new HttpError(
        422,
        "This division has already started — its team sheets are set by the schedule now",
      );
    }

    // The delete itself is `releaseSoloSignUpPlacement` — the SAME helper
    // withdraw, reject and expiry call. Unassign used to carry its own inline
    // copy of those two deletes; four copies of one rule is four chances for
    // a fifth terminal path to be wired into only three of them. It re-reads
    // the placement under its own lock, which is also what closed the
    // stale-person_id race an earlier version of this function had.
    await releaseSoloSignUpPlacement(tx, sourceId);

    await audit(
      tx,
      division.competition_id,
      auth.orgId,
      "registration.solo_signup_unassigned",
      { registration_id: sourceId, target_registration_id: found.registration_id },
      auth.userId,
    );

    return { registration_id: sourceId, target_registration_id: found.registration_id };
  });

  log.info(
    {
      orgId: auth.orgId,
      actorId: auth.userId,
      registrationId: sourceId,
      targetRegistrationId: result.target_registration_id,
    },
    "registration: solo sign-up returned to the pool",
  );
  return result;
}

/** One assignable team in `listAssignTargets`' response. */
export interface AssignTarget {
  registration_id: string;
  display_name: string;
  roster_count: number;
  /** null = unlimited (the sport declares no lineup config) — same
   *  convention as `AssignSoloSignUpResult.roster_cap`. */
  roster_cap: number | null;
  is_full: boolean;
  genders: ("m" | "f" | "x" | null)[];
}

export interface ListAssignTargetsResult {
  division_id: string;
  division_category: string | null;
  targets: AssignTarget[];
}

/**
 * Every team `registrationId` (a pooled solo sign-up) could be assigned to:
 * the other registrations in its division that are NOT themselves free
 * agents and are not terminal (`withdrawn`/`rejected`/`expired` — the same
 * three statuses `assignSoloSignUp` refuses a TARGET for, above).
 *
 * `genders` rides along per target so the caller can explain, BEFORE the
 * click, why a mixed division will refuse a placement — the same rule
 * `compositionRefusal` (above) enforces server-side once the organiser
 * actually presses Assign. This is read-only and does not run that check
 * itself; it hands over what a caller would need to.
 *
 * `roster_cap` is a division/sport property (`rosterCapExpr`), so it is
 * identical across every target here — repeated per row rather than lifted
 * to the top level because a caller reading one target should not have to
 * cross-reference a sibling field to know whether it is full.
 *
 * Throws 404 when `registrationId` does not exist OR is not itself a solo
 * sign-up (`free_agent = false`) — the list is meaningless for anything
 * else. `assignSoloSignUp` refuses a non-free-agent SOURCE with a 422
 * instead, because that call is already committed to acting; a listing has
 * nothing to act on, so 404 (nothing to list) is the honest status.
 */
export async function listAssignTargets(
  auth: AuthCtx,
  registrationId: string,
): Promise<ListAssignTargetsResult> {
  return withTenant(auth.orgId, async (tx) => {
    const [source] = await tx<{ division_id: string; free_agent: boolean }[]>`
      select division_id, free_agent from registrations where id = ${registrationId}`;
    if (!source) throw new HttpError(404, "registration not found");
    if (!source.free_agent) {
      throw new HttpError(404, "This entry is not a solo sign-up");
    }

    const [division] = await tx<{ category: string | null }[]>`
      select category from divisions where id = ${source.division_id}`;

    const rows = await tx<
      {
        registration_id: string;
        display_name: string;
        roster_count: number;
        roster_cap: number | null;
        genders: (string | null)[];
      }[]
    >`
      select
        r.id as registration_id,
        r.display_name,
        (select count(*)::int from registration_players rp
          where rp.registration_id = r.id) as roster_count,
        ${rosterCapExpr(tx)} as roster_cap,
        -- jsonb_agg, not array_agg: postgres.js's text-array-literal parser
        -- collapses a genuine SQL NULL element to the STRING "NULL" (proven
        -- with a raw script against this exact driver version — a one-player
        -- roster with no gender set came back as genders: ["NULL"], not
        -- [null]). jsonb_agg decodes through the driver's JSON path instead,
        -- which round-trips SQL NULL as JS null correctly.
        coalesce(
          (select jsonb_agg(rp.gender) from registration_players rp
            where rp.registration_id = r.id),
          '[]'::jsonb
        ) as genders
      from registrations r
      join divisions d on d.id = r.division_id
      join sports sp on sp.key = d.sport_key
      where r.division_id = ${source.division_id}
        and r.free_agent = false
        -- 'waitlisted' joins the terminal three deliberately: a waitlisted
        -- team is not in the division yet, so filling its roster would commit
        -- a player to an entry that may never be promoted. assignSoloSignUp
        -- refuses it server-side; offering it here would only spend a click
        -- to learn that.
        and r.status not in ('withdrawn', 'rejected', 'expired', 'waitlisted')
      order by r.display_name`;

    const targets: AssignTarget[] = rows.map((row) => ({
      registration_id: row.registration_id,
      display_name: row.display_name,
      roster_count: row.roster_count,
      roster_cap: row.roster_cap,
      is_full: row.roster_cap !== null && row.roster_count >= row.roster_cap,
      genders: row.genders as ("m" | "f" | "x" | null)[],
    }));

    return {
      division_id: source.division_id,
      division_category: division?.category ?? null,
      targets,
    };
  });
}
