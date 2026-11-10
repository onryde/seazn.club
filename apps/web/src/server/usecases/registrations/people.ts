import "server-only";
// The person behind a registration: lookup / create / reconcile, and claim invites (see ./index.ts).
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { dispatchNow } from "@/server/email-outbox";
import { log } from "@/server/logger";
import { createSystemClaimInvite } from "../person-claims";
import { queueClaimInviteEmail } from "../claim-invite-mail";
import type { Tx, AnySql } from "./types";
import { fallbackOrigin } from "./lookups";

/**
 * Materialise a confirmed registration into an entrant (doc 16 §1.1:
 * "Registration → entrant on confirm"). Idempotent: entrant_id is set exactly
 * once under a row lock; a second call is a no-op. Individuals also get a
 * person (dob/gender feed eligibility). New persons are created with
 * consent.public_name = true (owner ruling 5 — registering is consent to a
 * public name); a REUSED or user_id-linked person's own consent, including
 * any opt-out, is left untouched — see findOrCreatePlayerPerson below.
 */
/**
 * #402 — resolve the registrant's player-lane person, or create it.
 *
 * The upsert (not select-then-insert) is what closes the race: two divisions
 * confirmed concurrently by one signed-in registrant both miss a select, and
 * both insert. Here `persons_org_user_lane_uq` arbitrates and the loser is
 * handed the winner's id. `do update set full_name = persons.full_name` is a
 * deliberate no-op — `do nothing` returns no row, and the existing person's own
 * data must win, so a later entry never overwrites full_name/dob/gender. A
 * divergence is a signal for #404's review queue, never an in-place edit.
 *
 * #404: the WHERE below must repeat `persons_org_user_lane_uq`'s predicate
 * VERBATIM, `and merged_into is null` included. Postgres infers a partial index
 * only when the index's predicate is implied by the statement's, so a stale
 * predicate here fails at RUNTIME with 42P10 ("no unique or exclusion
 * constraint matching the ON CONFLICT specification") — never at compile time.
 * The tombstone clause is also what lets a merged duplicate release the
 * identity slot so the survivor can hold it.
 *
 * Restored to `materialise`'s call path (RS001 follow-up): the account
 * lives on `registration_players.user_id` — set for the submitter's own row
 * at submit (design §4 step 1) or at claim/join (design §2 item 4), never on
 * the group, whose contact is often a rep entering OTHER people's entries
 * (see `loadPlayers`'s doc comment). `materialise` calls this per player, in
 * both the individual and team branches, whenever that player's row carries a
 * `user_id`; a row with none keeps the plain unlinked insert.
 */
export async function resolvePlayerPerson(
  tx: Tx,
  orgId: string,
  userId: string,
  fullName: string,
  dob: string | null,
  gender: string | null,
): Promise<string> {
  // consent defaults to public_name=true on the INSERT branch only (ruling
  // 5, review BLOCKER — this is the PRIMARY path a signed-in registrant's
  // own first-ever linked person takes, so it owes the ruling exactly like
  // findOrCreatePlayerPerson's anonymous-path insert does). The DO UPDATE
  // branch stays untouched: it never mentions consent, so a returning
  // person's own consent (including an opt-out) is never overwritten.
  const [person] = await tx<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, user_id, lane, consent)
    values (
      ${orgId}, ${fullName}, ${dob}, ${gender}, ${userId}, 'player',
      ${tx.json({ public_name: true } as never)}
    )
    on conflict (org_id, user_id, lane)
      where user_id is not null and lane = 'player' and merged_into is null
    do update set full_name = persons.full_name
    returning id`;
  return person.id;
}

/**
 * #22 — exact-one player-lane person match by email, org-scoped, tombstones
 * excluded. Same conservatism as the dob rule below: zero or ambiguous
 * matches return null rather than guessing. Exported so
 * `registration-submit.ts`'s `joinTeamEntry` can reconcile a claim against
 * the directory too (module topology: that file already imports from this
 * one; never the other way).
 */
export async function findPlayerPersonByEmail(
  db: AnySql,
  orgId: string,
  email: string,
): Promise<string | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;
  const matches = await db<{ id: string }[]>`
    select id from persons
    where org_id = ${orgId} and lane = 'player' and merged_into is null
      and lower(email) = lower(${trimmed})`;
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * RS008 review fix #8 (Minor) — like `findPlayerPersonByEmail` above, but for
 * a DISPLAY-NAME MASKING decision rather than identity resolution.
 * `findPlayerPersonByEmail`'s "zero or ambiguous both return null" rule is
 * correct for IDENTITY (never guess which of several duplicate people —
 * merge/#404 — a row belongs to), but wrong for a PRIVACY decision built on
 * top of it: treating "ambiguous" the same as "no match" makes the decision
 * fail OPEN (preview raw) exactly when it is least certain it should. This
 * returns every matching person's consent, org-scoped, tombstones excluded —
 * `anyOptedOut` (lib/name-display.ts) then applies its own "stricter wins
 * across several people" rule (ANY match opted out masks) the same way it
 * already does for a pair/team's several roster members. Zero matches
 * returns `[]` (`anyOptedOut([])` is `false`, identical to today's
 * behaviour for that case). Never used for identity/reconciliation — those
 * callers need `findPlayerPersonByEmail`'s EXACT-ONE guarantee and must keep
 * failing toward "create/leave as-is," not toward a privacy default.
 */
export async function playerPersonConsentsByEmail(
  db: AnySql,
  orgId: string,
  email: string,
): Promise<({ public_name?: boolean } | null)[]> {
  const trimmed = email.trim();
  if (!trimmed) return [];
  const matches = await db<{ consent: { public_name?: boolean } | null }[]>`
    select consent from persons
    where org_id = ${orgId} and lane = 'player' and merged_into is null
      and lower(email) = lower(${trimmed})`;
  return matches.map((m) => m.consent);
}

/**
 * #22 — fills a MISSING email onto an already-resolved person; never
 * overwrites one that differs (the `email is null` guard IS the rule, not
 * just an optimisation — a concurrent backfill from two rows racing the
 * same person is then a harmless double no-op instead of a decision about
 * which value wins). Matches the standing "never touch an existing
 * person's own data" rule's one stated exception (#22 brief: "adding an
 * email to a person that has none is acceptable"). Exported for
 * `registration-submit.ts`'s `joinTeamEntry` — a claim that finds no
 * BETTER match than the dummy person already on its row still gives that
 * dummy the email it was minted without.
 */
export async function backfillPersonEmail(tx: Tx, personId: string, email: string): Promise<void> {
  const trimmed = email.trim();
  if (!trimmed) return;
  await tx`update persons set email = ${trimmed} where id = ${personId} and email is null`;
}

/**
 * RS002 — person get-or-create for a player row with NO `user_id`.
 *
 * The only persons identity index (`persons_org_user_lane_uq`) is scoped to
 * `user_id is not null`, so it arbitrates nothing for an anonymous player.
 * Ruling taken this session (design §6, `_INDEX.md` "Person get-or-create
 * does NOT dedupe on name alone" — there is no `(org, name, dob)` unique
 * index and this does not add one): reuse an existing person ONLY when the
 * row carries a `dob` AND exactly one non-merged, player-lane person in this
 * org matches on `(lower(trim(full_name)), dob)`. No dob, zero matches, or
 * an AMBIGUOUS (2+) match all mint a new person rather than guess — a
 * duplicate person is a one-click #404 merge, whereas silently fusing two
 * different humans (same-named juniors, for instance) is not cleanly
 * reversible. A small per-org query by design; no index added for it.
 *
 * #22 (2026-08-30): EMAIL is now tried FIRST, ahead of dob — a captain-
 * entered row essentially never carries a dob (nothing requires one unless
 * the registrant ticks "I'm playing"), so the dob rule above rarely even
 * runs; email is the signal that is actually usually present (the cart
 * contact always has one, a claimer always gives one at their own claim
 * moment). Same conservatism, same "never guess" shape — see
 * `findPlayerPersonByEmail`. A person found via EITHER rule gets its email
 * backfilled if (and only if) it doesn't have one yet, so the NEXT
 * registration for the same human can match on email even if this one
 * matched on dob.
 *
 * Never touches an EXISTING person's own data (name/dob/gender/consent) —
 * that person may already carry answers, including a consent opt-out, that a
 * later same-named entry must not overwrite. New persons are created with
 * `consent.public_name = true` (owner ruling 5: registering is consent to a
 * public name; opt-out happens later, on the person, never here).
 */
export async function findOrCreatePlayerPerson(
  tx: Tx,
  orgId: string,
  fullName: string,
  dob: string | null,
  gender: string | null,
  email: string | null,
): Promise<string> {
  const trimmedEmail = email?.trim() || null;
  if (trimmedEmail) {
    const matchId = await findPlayerPersonByEmail(tx, orgId, trimmedEmail);
    if (matchId) {
      await backfillPersonEmail(tx, matchId, trimmedEmail);
      return matchId;
    }
  }
  if (dob) {
    const matches = await tx<{ id: string }[]>`
      select id from persons
      where org_id = ${orgId} and lane = 'player' and merged_into is null
        and dob = ${dob} and lower(trim(full_name)) = lower(trim(${fullName}))`;
    if (matches.length === 1) {
      if (trimmedEmail) await backfillPersonEmail(tx, matches[0]!.id, trimmedEmail);
      return matches[0]!.id;
    }
  }
  const [created] = await tx<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, email, consent)
    values (${orgId}, ${fullName}, ${dob}, ${gender}, ${trimmedEmail}, ${tx.json({ public_name: true } as never)})
    returning id`;
  return created!.id;
}

/**
 * #22 — reconciles a JOIN/CLAIM against the directory, for
 * `registration-submit.ts`'s `joinTeamEntry` (a claim is the strongest
 * identity moment in the whole flow: the human gives their own email, or is
 * signed in). Returns an EXISTING person only — never creates one, unlike
 * `findOrCreatePlayerPerson` — because a fresh person for a row that
 * resolves to neither a user_id nor a known email is exactly what
 * `materialise()` already handles correctly whenever it eventually runs
 * (immediately for a free auto-approval entry, later for a paid or
 * manual-approval one); this function's whole job is to catch the case
 * `materialise()` CANNOT retry — a claim landing on an entry that is
 * already confirmed, where `materialise()`'s own `if (reg.entrant_id)
 * return` guard means it will never run again for this registration.
 *
 * `userId` (signed-in claimer) is the stronger signal and is tried first:
 * `resolvePlayerPerson` already reuses-or-creates atomically via the
 * unique `(org, user, lane)` index, so it always resolves to SOME person —
 * matching materialise()'s own precedence (`p.user_id ? resolvePlayerPerson
 * : findOrCreatePlayerPerson`). Email is the fallback, and unlike the
 * userId branch it can genuinely find nothing (zero or ambiguous matches),
 * in which case this returns null and the caller leaves the row exactly as
 * it is today.
 */
export async function reconcileClaimedPerson(
  tx: Tx,
  orgId: string,
  fullName: string,
  dob: string | null,
  gender: string | null,
  userId: string | null,
  email: string | null,
): Promise<string | null> {
  if (userId) return resolvePlayerPerson(tx, orgId, userId, fullName, dob, gender);
  const trimmedEmail = email?.trim() || null;
  return trimmedEmail ? findPlayerPersonByEmail(tx, orgId, trimmedEmail) : null;
}

/**
 * RS008 — invite ONE person to claim their profile, post-commit,
 * best-effort. Guards against the double-send `_INDEX.md` calls out: an
 * unclaimed person with several registrations (across unrelated
 * competitions, or a materialise() re-run) must never be re-invited (and
 * have their still-pending invite silently revoked) every time one of them
 * converges here — so this checks for an OPEN (unclaimed, unrevoked) claim
 * FIRST and skips silently if one already exists, rather than relying on
 * `createSystemClaimInvite`'s own revoke-and-replace (correct for the
 * deliberate, session-authed organiser action it was written for; wrong for
 * an automatic sweep that can run many times for the same person). Never
 * throws — a mail-provider hiccup, or any other failure here, must never
 * break the registration flow that triggered it.
 *
 * The claim and its invite email are one transaction of this function's own
 * (opened after the registration's has committed): the email goes on the
 * outbox (kind `claim_invite`, ref = the person) with the claim it carries,
 * so a refused enqueue rolls the claim back too and the next convergence
 * invites again. The first attempt is made right after that commits.
 */
async function maybeInviteClaim(orgId: string, personId: string, email: string): Promise<void> {
  try {
    // RS008 review fix #7 — this guard used to check ONLY claimed_at/
    // revoked_at, never expires_at. person-claims.ts's natural-expiry path
    // never sets revoked_at (only claimPerson/revokeClaimInvite/unlinkPerson
    // do), so an unclaimed invite that simply lapsed past its 14-day window
    // still reads as "open" here forever — this guard returned early
    // FOREVER, and createSystemClaimInvite (the only place that would ever
    // revoke-and-replace that stale row) was never even reached again. A
    // person whose one invite lapsed unclaimed could NEVER be auto-invited a
    // second time, permanently defeating the whole point of C (RS008's
    // claim-invite sweep). `expires_at > now()` makes an expired-but-not-
    // revoked row read as NOT open, so the sweep proceeds to
    // createSystemClaimInvite below — which ALREADY revokes any row matching
    // `claimed_at is null and revoked_at is null` (regardless of its own
    // expiry) before inserting the new one, so the stale row is revoked
    // there rather than needing a second, redundant revoke here. This is
    // also what keeps the partial unique index `person_claims_open_uq` (V276,
    // `where claimed_at is null and revoked_at is null` — no expiry
    // predicate of its own) from ever seeing two "open" rows at once.
    const [openClaim] = await sql<{ id: string }[]>`
      select id from person_claims
      where person_id = ${personId} and claimed_at is null and revoked_at is null
        and expires_at > now()
      limit 1`;
    if (openClaim) return;
    const outboxId = await sql.begin(async (tx) => {
      const invite = await createSystemClaimInvite(tx, orgId, personId, email);
      if (!invite) return null;
      // The EMAIL secret, not the console one: this mail is the invite's only
      // channel (no organiser console shows it), and opening it signs the player
      // in and claims in one tap. `invite.secret` is never used.
      return queueClaimInviteEmail(tx, {
        kind: "claim_invite",
        refType: "person",
        refId: personId,
        orgId,
        to: email,
        claimUrl: `${fallbackOrigin()}${routes.claim(invite.emailSecret)}`,
        personName: invite.person_name,
        orgName: invite.org_name,
        expiresAt: new Date(invite.expires_at),
      });
    });
    if (outboxId !== null) await dispatchNow([outboxId]);
  } catch (err) {
    log.error({ err, event: "registration.claim_invite_failed", org_id: orgId, person_id: personId }, "RS008 claim invite failed");
  }
}

/**
 * RS008 — fire-and-forget, called AFTER the caller's own transaction has
 * committed (never from inside one: this reads via the pooled `sql`, so a
 * call from inside an open tx would see none of that tx's own uncommitted
 * writes, and the email send below is network I/O that must never run
 * inside a held connection). Re-derives, fresh, every current member of
 * `entrantId`'s roster whose row is consented (`granted`/`guardian`, never
 * `pending` — nobody has agreed to anything for those yet) with an email on
 * file and no linked account — the exact gap RS008 closes: a captain-
 * entered player (or an anonymous captain's own row) whose consent is real
 * but who has no way to ever reach the `/me` opt-out that already exists
 * for everyone else.
 *
 * Safe to call unconditionally, repeatedly, from every convergence point
 * (`materialise()`'s callers, `joinTeamEntry`) — re-deriving fresh rather
 * than trusting a caller-supplied candidate list means it never matters
 * WHICH write caused a row to newly qualify, and `maybeInviteClaim`'s own
 * open-claim guard makes a repeat sweep of the same entrant a cheap no-op.
 * `person_id is not null` excludes a row nobody has resolved a person for
 * yet (an unmaterialised captain-entered slot) — nothing to invite there.
 */
export async function inviteUnclaimedMembers(orgId: string, entrantId: string): Promise<void> {
  try {
    const rows = await sql<{ person_id: string; email: string | null }[]>`
      select rp.person_id, coalesce(rp.email, p.email) as email
      from registration_players rp
      join registrations r on r.id = rp.registration_id
      join persons p on p.id = rp.person_id
      where r.entrant_id = ${entrantId}
        and rp.consent_status in ('granted', 'guardian')
        and rp.person_id is not null
        and p.user_id is null`;
    for (const row of rows) {
      if (!row.email) continue;
      await maybeInviteClaim(orgId, row.person_id, row.email);
    }
  } catch (err) {
    log.error({ err, event: "registration.claim_invite_sweep_failed", org_id: orgId, entrant_id: entrantId }, "RS008 claim invite sweep failed");
  }
}
