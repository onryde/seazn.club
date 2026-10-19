import "server-only";
// Player-account claims (PROMPT-53, doc 16 §1.3): an organiser invites a
// person to claim their row; the token holder links persons.user_id to their
// login. Tokens are random secrets hashed at rest (device-links pattern);
// resolution runs on the superuser connection because the claimant is not an
// org member. Claim rows are never deleted — claimed_at/revoked_at/invited_by
// are the audit trail for claim and staff unlink.
//
// TWO secrets per claim (V464, owner-approved 2026-10-19 "split design"):
//   - the CONSOLE secret (`token_hash`) is shown to the organiser as a copyable
//     link + QR. Whoever holds it must sign in to claim — the organiser can hand
//     it to anyone, so it proves nothing about who is holding it.
//   - the EMAIL secret (`email_token_hash`) goes ONLY into the invite email and
//     is never returned by any API. Opening it proves control of the invited
//     inbox — the same basis a magic link relies on — so `claimByEmailLink` can
//     sign the invitee in and claim in one step.
// Both live on the SAME row, so revoke / re-invite / unlink / expiry / "already
// claimed" mean the same for either, and `resolveClaimToken` reports which one
// opened the claim (`via`).
import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { sql, withTenant, type Tx } from "@/lib/db";
import { AuthError, HttpError } from "@/lib/errors";
import { emailSigninOpen } from "@/lib/claim-signin-window";
import { stampTermsAcceptance } from "@/lib/legal";
import { resolveOrCreateUser } from "@/lib/users";
import type { AuthCtx } from "@/server/api-v1/auth";

export const CLAIM_PREFIX = "pc_";
const CLAIM_DAYS = 14;

// Both the superuser client and a withTenant tx serve createSystemClaimInvite
// below (registrations.ts's own AnySql precedent) — a caller MAY pass a `tx`
// to mint atomically inside a larger transaction, but every RS008 call site
// today calls this with the pooled `sql`, strictly AFTER its own enclosing
// transaction has committed (never inside one — this mints a row, the
// caller separately sends an email, and network I/O must never run inside
// an open tx, same reasoning `getLimit`'s own doc comment gives elsewhere).
type AnySql = Tx | postgres.Sql;

export function hashClaimToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mint a new claim secret. Shown once; only the sha256 is stored. */
export function mintClaimSecret(): string {
  return CLAIM_PREFIX + randomBytes(32).toString("base64url");
}

/** The two secrets minted together for one claim. `secret` is the CONSOLE one
 *  (shown to the organiser); `emailSecret` goes only into the invite email. */
export interface ClaimSecrets {
  secret: string;
  emailSecret: string;
}

function mintClaimSecrets(): ClaimSecrets {
  return { secret: mintClaimSecret(), emailSecret: mintClaimSecret() };
}

export interface ClaimRow {
  id: string;
  person_id: string;
  email: string;
  invited_by: string | null;
  expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const COLS = [
  "id", "person_id", "email", "invited_by", "expires_at",
  "claimed_at", "revoked_at", "created_at",
] as const;

function requireSessionEditor(auth: AuthCtx): void {
  // Claim invites mint a login capability — session editors only, never an
  // API key or device link (same rule as device-links minting).
  if (auth.via !== "session" || !auth.userId) {
    throw new HttpError(403, "Claim invites can only be managed with a session login");
  }
}

/**
 * Shared core (code-review fix, 2026-08-30): revoke any prior open invite
 * for `personId`, then insert the new one. `createClaimInvite` and
 * `createSystemClaimInvite` used to carry this as two byte-for-byte-similar
 * inline bodies — the exact "two lookup paths drift" defect class this
 * codebase has hit before — and `createSystemClaimInvite`'s own copy ran the
 * two statements UNTRANSACTED when called with the pooled `sql` (every real
 * call site today), each auto-committing on its own. A concurrent sweep for
 * the SAME person could then interleave: caller A's revoke commits, caller
 * B's insert lands and commits, then caller A's OWN insert fails against
 * `person_claims_open_uq` — and because A's revoke had ALREADY committed
 * with nothing transactional to undo it, that failure (silently swallowed by
 * `maybeInviteClaim`'s catch, registrations.ts) could leave a still-open
 * invite from the LOSING side's own revoke with no replacement. One
 * transaction makes the pair atomic: a losing insert now rolls its own
 * revoke back too, so a race always leaves whichever invite the WINNING
 * caller wrote, never a gap. Callers pass whatever `db` they already hold
 * (a `Tx` already inside a transaction runs this directly, atomic with the
 * rest of it; the pooled `sql` is wrapped in its own transaction by the
 * caller — see createSystemClaimInvite below).
 */
async function reviveClaimInvite(
  db: AnySql,
  orgId: string,
  personId: string,
  email: string,
  invitedBy: string | null,
  secrets: ClaimSecrets,
): Promise<ClaimRow | undefined> {
  // Revoking the OPEN row kills both of its secrets at once — they share the row.
  await db`
    update person_claims set revoked_at = now()
    where person_id = ${personId} and claimed_at is null and revoked_at is null`;
  const [created] = await db<ClaimRow[]>`
    insert into person_claims
      (org_id, person_id, email, token_hash, email_token_hash, invited_by, expires_at)
    values (${orgId}, ${personId}, ${email}, ${hashClaimToken(secrets.secret)},
            ${hashClaimToken(secrets.emailSecret)},
            ${invitedBy}, now() + ${`${CLAIM_DAYS} days`}::interval)
    returning ${db(COLS)}`;
  return created;
}

/** True for the plain pooled client (`.begin` — postgres.js's `Sql`), false
 *  for a `Tx` already inside a transaction (`.savepoint` instead — `Sql` and
 *  `TransactionSql` are siblings, neither extends the other). Lets
 *  `createSystemClaimInvite` open its OWN transaction only when it actually
 *  needs one. */
function isPooledSql(db: AnySql): db is postgres.Sql {
  return typeof (db as postgres.Sql).begin === "function";
}

/**
 * Invite a person to claim their profile. One open claim per person: minting
 * revokes any prior open invite (both secrets with it). Secrets returned
 * exactly once: `secret` is the console one (the organiser's copyable link +
 * QR), `emailSecret` is for the invite email and must NEVER reach the
 * organiser — every caller destructures it out before building a response.
 */
export async function createClaimInvite(
  auth: AuthCtx,
  personId: string,
  email: string,
): Promise<ClaimRow & ClaimSecrets & { person_name: string; org_name: string }> {
  requireSessionEditor(auth);
  const secrets = mintClaimSecrets();
  const row = await withTenant(auth.orgId, async (tx) => {
    const [person] = await tx<{ id: string; full_name: string; user_id: string | null }[]>`
      select id, full_name, user_id from persons
       where id = ${personId} and merged_into is null`;
    if (!person) throw new HttpError(404, "person not found");
    if (person.user_id) {
      throw new HttpError(409, "This profile is already claimed", "ALREADY_CLAIMED");
    }
    const [org] = await tx<{ name: string }[]>`
      select name from organizations where id = ${auth.orgId}`;
    // reviveClaimInvite's insert carries no WHERE/conflict clause of its own,
    // so a successful call always returns exactly one row — same invariant
    // createSystemClaimInvite's own `if (!created) return null` guard below
    // treats as needing a runtime check only because THAT function's
    // contract is "never throws"; this one's is not.
    const created = (await reviveClaimInvite(tx, auth.orgId, personId, email, auth.userId, secrets))!;
    return { ...created, person_name: person.full_name, org_name: org?.name ?? "" };
  });
  return { ...row, ...secrets };
}

/**
 * RS008 — system-minted claim invite: no session, called ONLY from
 * server-side registration flows immediately after a person's OWN consent
 * was recorded (never speculatively) — the person's roster row just became
 * `granted`/`guardian`, a real `persons.id` is on hand, and there is no
 * linked account yet. Mirrors `createClaimInvite`'s body exactly (revoke any
 * prior OPEN invite, insert, secret returned once) but skips
 * `requireSessionEditor` entirely, and `invited_by` is null — nobody on
 * staff triggered this one.
 *
 * Returns `null`, never throws, for the two "nothing to do" cases
 * (`personId` doesn't resolve under this org, or the person is already
 * claimed) — a caller wiring this into a registration flow must never let a
 * mail-invite outcome affect the write that triggered it. Callers are
 * responsible for their OWN "is there already an open invite" guard before
 * calling this (`registrations.ts`'s `maybeInviteClaim`) — repeated calls
 * for the same person across unrelated registrations would otherwise
 * silently revoke-and-replace a still-pending invite (or yank a
 * partially-completed claim flow) every time.
 */
export async function createSystemClaimInvite(
  db: AnySql,
  orgId: string,
  personId: string,
  email: string,
): Promise<(ClaimSecrets & { person_name: string; org_name: string }) | null> {
  const secrets = mintClaimSecrets();
  const [person] = await db<{ id: string; full_name: string; user_id: string | null }[]>`
    select id, full_name, user_id from persons
     where id = ${personId} and org_id = ${orgId} and merged_into is null`;
  if (!person || person.user_id) return null;
  const [org] = await db<{ name: string }[]>`
    select name from organizations where id = ${orgId}`;
  // Code-review fix (2026-08-30, item 3): revoke-then-insert now shares
  // reviveClaimInvite's one transactional core with createClaimInvite — see
  // that function's own doc comment for the race it closes. `db` is the
  // pooled `sql` at every real call site today (this function's own doc
  // comment above), so it opens ITS OWN transaction here; a caller that
  // instead passes an already-open `Tx` runs the pair directly on it,
  // already atomic with the rest of that transaction.
  const created = isPooledSql(db)
    ? await db.begin((tx) => reviveClaimInvite(tx, orgId, personId, email, null, secrets))
    : await reviveClaimInvite(db, orgId, personId, email, null, secrets);
  if (!created) return null;
  // No organiser console ever shows this invite, so only `emailSecret` is ever
  // used (the registration mail); `secret` is minted for the row's NOT NULL
  // column and never leaves the server.
  return { ...secrets, person_name: person.full_name, org_name: org?.name ?? "" };
}

/** Revoke the person's open invite, if any (idempotent). */
export async function revokeClaimInvite(auth: AuthCtx, personId: string): Promise<ClaimRow | null> {
  requireSessionEditor(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<ClaimRow[]>`
      update person_claims set revoked_at = now()
      where person_id = ${personId} and claimed_at is null and revoked_at is null
      returning ${tx(COLS)}`;
    return row ?? null;
  });
}

/** The person's open invite (organiser console; no secret — it showed once). */
export async function getOpenClaim(auth: AuthCtx, personId: string): Promise<ClaimRow | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<ClaimRow[]>`
      select ${tx(COLS)} from person_claims
      where person_id = ${personId} and claimed_at is null and revoked_at is null
      order by created_at desc limit 1`;
    return row ?? null;
  });
}

export interface ResolvedClaim {
  id: string;
  org_id: string;
  org_name: string;
  person_id: string;
  person_name: string;
  email: string;
  /** The person is on the officials roster (v11) — the claim page swaps to
   *  officiating copy; the claim mechanics are identical. */
  is_official: boolean;
}

/** What the link that opened the claim may DO right now: `email` is the secret
 *  that only ever went into the invite email AND is still inside its sign-in
 *  window (CLAIM_EMAIL_SIGNIN_MS from when it was minted); `console` is the
 *  organiser's copyable link, or an emailed link whose window has passed — both
 *  prove nothing about their holder, so a signed-out visitor must sign in. */
export type ClaimVia = "email" | "console";

/** A claim resolved from a pc_ token — the claim plus which secret it was. */
export interface ResolvedTokenClaim extends ResolvedClaim {
  via: ClaimVia;
}

type ClaimLookupRow = ResolvedClaim & {
  expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
  user_id: string | null;
};

/** `via_email`: the token is the email secret. `minted_at`: when that secret was minted — it is born with
 *  its claim row (a re-invite inserts a new row), so the row's created_at is its clock. */
type TokenLookupRow = ClaimLookupRow & { via_email: boolean; minted_at: Date };

/** Distinct error codes so a dead-end renders its own copy, whichever way the
 *  claim was looked up: CLAIM_INVALID / CLAIM_REVOKED / CLAIM_EXPIRED /
 *  CLAIM_CLAIMED. Shared by resolveClaimToken and resolveClaimById. */
function settleClaimRow(claim: ClaimLookupRow | undefined): ResolvedClaim {
  if (!claim) throw new HttpError(401, "This claim link is not valid", "CLAIM_INVALID");
  if (claim.claimed_at || claim.user_id) {
    throw new HttpError(409, "This profile has already been claimed", "CLAIM_CLAIMED");
  }
  if (claim.revoked_at) {
    throw new HttpError(401, "This invite was withdrawn — ask the organiser for a new one", "CLAIM_REVOKED");
  }
  if (new Date(claim.expires_at).getTime() <= Date.now()) {
    throw new HttpError(401, "This invite has expired — ask the organiser for a new one", "CLAIM_EXPIRED");
  }
  return {
    id: claim.id,
    org_id: claim.org_id,
    org_name: claim.org_name,
    person_id: claim.person_id,
    person_name: claim.person_name,
    email: claim.email,
    is_official: claim.is_official,
  };
}

/** The claim a pc_ token opens — by EITHER secret — with no state check. The
 *  one lookup behind resolveClaimToken and claimByEmailLink, so the two can
 *  never disagree about which secret is which. `forUpdate` locks the claim row
 *  (inside a transaction) so a racing revoke or second tap queues behind it. */
async function lookupClaimByToken(
  db: AnySql,
  token: string,
  forUpdate = false,
): Promise<TokenLookupRow | undefined> {
  const hash = hashClaimToken(token);
  const [claim] = await db<TokenLookupRow[]>`
    select pc.id, pc.org_id, o.name as org_name, pc.person_id,
           p.full_name as person_name, pc.email,
           exists(select 1 from officials off where off.person_id = pc.person_id)
             as is_official,
           pc.expires_at, pc.claimed_at, pc.revoked_at, p.user_id,
           coalesce(pc.email_token_hash = ${hash}, false) as via_email,
           pc.created_at as minted_at
    from person_claims pc
    join persons p on p.id = pc.person_id
    join organizations o on o.id = pc.org_id
    where pc.token_hash = ${hash} or pc.email_token_hash = ${hash}
    limit 1
    ${forUpdate ? db`for update of pc` : db``}`;
  return claim;
}

/** Resolve a pc_ token for the /claim page, reporting what the link may do (`via`). `now` is the clock the
 *  sign-in window is measured on — a parameter so the boundary is testable to the millisecond. */
export async function resolveClaimToken(token: string, now: number = Date.now()): Promise<ResolvedTokenClaim> {
  const claim = await lookupClaimByToken(sql, token);
  const settled = settleClaimRow(claim);
  return { ...settled, via: claim!.via_email && emailSigninOpen(claim!.minted_at, now) ? "email" : "console" };
}

/**
 * Resolve a claim by id AND caller email in one step (v11.1 — the /me
 * "Pending invites" card). Unlike the token flow — where holding the emailed
 * token IS the proof of ownership, so state differentiates before the email
 * check — a bare id proves nothing on its own: any authenticated user could
 * pass any id. So ownership is folded into the lookup itself: the query is
 * scoped to `ownerEmail`, and a non-owner (wrong email, or an id that
 * doesn't exist at all) gets the exact same generic 404 CLAIM_INVALID —
 * never a hint of whether the claim is pending, claimed, expired, or
 * revoked. Only once a row comes back (ownership proven) does state
 * differentiate, via the same settleClaimRow the token flow uses.
 */
export async function resolveClaimById(id: string, ownerEmail: string): Promise<ResolvedClaim> {
  const [claim] = await sql<ClaimLookupRow[]>`
    select pc.id, pc.org_id, o.name as org_name, pc.person_id,
           p.full_name as person_name, pc.email,
           exists(select 1 from officials off where off.person_id = pc.person_id)
             as is_official,
           pc.expires_at, pc.claimed_at, pc.revoked_at, p.user_id
    from person_claims pc
    join persons p on p.id = pc.person_id
    join organizations o on o.id = pc.org_id
    where pc.id = ${id} and lower(pc.email) = lower(${ownerEmail}) limit 1`;
  if (!claim) throw new HttpError(404, "This invite could not be found", "CLAIM_INVALID");
  return settleClaimRow(claim);
}

/** Strict email match (owner decision 2026-07-13): only an account signed in
 *  with the INVITED address may accept — the emailed link (or claim id)
 *  alone is not enough. Case-insensitive. Shared by every accept path. */
export function assertClaimEmail(claim: ResolvedClaim, userEmail: string): void {
  if (claim.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw new HttpError(
      403,
      `This invite was sent to ${claim.email} — sign in with that address to claim it`,
      "CLAIM_EMAIL_MISMATCH",
    );
  }
}

/** The link itself, inside a transaction the caller owns: the person row's
 *  null-user_id guard means two racing accepts can't both win; the loser gets
 *  CLAIM_CLAIMED. Locks `persons` before `person_claims` — the same order
 *  every writer here takes (unlinkPerson, the signed-in accept), so two of
 *  them cannot deadlock. */
async function linkPerson(tx: Tx, claim: ResolvedClaim, userId: string): Promise<void> {
  const [updated] = await tx<{ id: string }[]>`
    update persons set user_id = ${userId}
    where id = ${claim.person_id} and user_id is null
    returning id`;
  if (!updated) {
    throw new HttpError(409, "This profile has already been claimed", "CLAIM_CLAIMED");
  }
  await tx`
    update person_claims set claimed_at = now()
    where id = ${claim.id} and claimed_at is null`;
}

/** A thrown link failure, as the caller should see it. #402 —
 *  persons_org_user_lane_uq, which is scoped to `lane = 'player'`. So the only
 *  collision reachable here is two PLAYER persons for one human in one org:
 *  exactly the duplicate #402 exists to eliminate, and exactly what the
 *  message says. Route it to the merge tool (#404), never a 500.
 *
 *  Do NOT widen that index to cover every lane. `inviteOfficial` mints a
 *  fresh official-lane person per officials row and cannot dedupe (the
 *  person is unclaimed at invite time), so a human on one org's officials
 *  roster twice holds two official-lane persons by design — widening it
 *  makes their second officiating claim fail with this 409 and the wrong
 *  message. Covered by the second-officiating-claim test in
 *  __tests__/person-claims.test.ts. */
function linkFailure(e: unknown): unknown {
  if (isUniqueViolation(e, "persons_org_user_lane_uq")) {
    return new HttpError(
      409,
      "You already have a player profile in this organisation",
      "PERSON_ALREADY_LINKED",
    );
  }
  return e;
}

/**
 * The shared accept core (v11.1 extraction): link the person to the logged-in
 * user. Transactional — the person row's null-user_id guard means two racing
 * accepts can't both win; the loser gets CLAIM_CLAIMED. Both the token flow
 * (claimPerson) and the by-id flow (acceptMyOfficiatingClaim in
 * me-officiating.ts) call this — one acceptance mechanism, two ways in.
 */
export async function acceptResolvedClaim(claim: ResolvedClaim, userId: string): Promise<ResolvedClaim> {
  try {
    await sql.begin((tx) => linkPerson(tx, claim, userId));
  } catch (e) {
    throw linkFailure(e);
  }
  return claim;
}

/** postgres.js names the tripped index on `constraint_name`; other drivers use
 *  `constraint`. Match on the NAME, never on the bare 23505 — this transaction
 *  can also trip the one-open-claim index, which is a different failure. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { code?: string }).code !== "23505") return false;
  const named =
    (e as { constraint_name?: string }).constraint_name ??
    (e as { constraint?: string }).constraint ??
    "";
  return String(named) === constraint;
}

/**
 * Link the person to the logged-in user via the pc_ token (the /claim page).
 * Strict email match, then the shared accept core. Either secret works here:
 * a signed-in account whose address matches the invite proves itself.
 */
export async function claimPerson(
  token: string,
  userId: string,
  userEmail: string,
): Promise<ResolvedClaim> {
  const claim = await resolveClaimToken(token);
  assertClaimEmail(claim, userEmail);
  return acceptResolvedClaim(claim, userId);
}

/**
 * Sign the invitee in AND claim, from the secret that only ever went into the
 * invite email. The caller has NO session. Opening the emailed link proves
 * control of the invited inbox — the same basis a magic link relies on — so
 * this mirrors `consumeLoginLink` + the magic-link route: find or create the
 * account for the invited address (`resolveOrCreateUser`), mark the address
 * verified, and hand back the user id for the caller to mint a session. What
 * consume does NOT do is mirrored too: an existing account's password_hash and
 * google_sub are left exactly as they were, whatever its verified state.
 *
 * Refuses, as 401 "not authenticated" (what the route always answered to a
 * sessionless accept), anything that is not the EMAIL secret — the console
 * link is shown to the organiser and proves nothing about its holder. An
 * emailed link older than CLAIM_EMAIL_SIGNIN_MS has stopped being a sign-in
 * credential too, but it is told apart: 401 CLAIM_SIGNIN_EXPIRED, so a page
 * that was loaded INSIDE the window and tapped after it can switch to the
 * normal sign-in card instead of showing a raw refusal. A dead email link
 * (revoked / expired / claimed) answers with its own CLAIM_* code first.
 *
 * One transaction: re-validates under a row lock (a racing revoke or second tap
 * queues behind it), finds or creates the account, marks it verified and links
 * the person. A failure anywhere rolls the whole thing back, so a refused claim
 * leaves no new account and no half-verified one. Two taps: one wins, the other
 * is CLAIM_CLAIMED.
 */
export async function claimByEmailLink(
  token: string,
  now: number = Date.now(),
): Promise<{ userId: string; claim: ResolvedClaim }> {
  const found = await lookupClaimByToken(sql, token);
  // Not the email secret: a console link (or no claim at all) proves nothing about its holder.
  if (!found || !found.via_email) throw new AuthError("Not authenticated");
  // A dead claim says why it is dead, whatever the clock: the same answer the page gives for it.
  settleClaimRow(found);
  // An email secret past its sign-in window (CLAIM_EMAIL_SIGNIN_MS) is a console link in everything but name.
  // Enforced HERE, not on the page, and with its own code so a client holding a card from inside the window
  // can tell it from a console link's generic 401. The mint time is immutable, so the locked re-read below
  // need not repeat it.
  if (!emailSigninOpen(found.minted_at, now)) {
    throw new HttpError(401, "This link no longer signs you in — sign in to claim", "CLAIM_SIGNIN_EXPIRED");
  }

  try {
    return await sql.begin(async (tx) => {
      // persons before person_claims — see linkPerson.
      await tx`select 1 from persons where id = ${found.person_id} for update`;
      // Under both locks the state may have moved since the first read (a racing
      // tap claimed it, the organiser revoked it, it just expired). Which secret
      // this is cannot move — it is a column of the row the token's hash names —
      // so only the state is settled again. Claim rows are never deleted; a row
      // that has vanished is CLAIM_INVALID, not an expectation.
      const claim = settleClaimRow(await lookupClaimByToken(tx, token, true));

      const userId = await accountForInvitedAddress(tx, claim.email);
      await verifyByInbox(tx, userId);
      // The button sits under the "By continuing, you agree…" notice, so the tap is the acceptance (GDPR spec
      // 2026-07-14; first acceptance wins). Inside the transaction: a failure here undoes the claim, the new
      // account and the verification, instead of leaving a consumed link and an error on screen.
      await stampTermsAcceptance(userId, tx);
      await linkPerson(tx, claim, userId);
      return { userId, claim };
    });
  } catch (e) {
    throw linkFailure(e);
  }
}

/** Opening the emailed link proves the inbox, so the account that holds the address is marked verified — what
 *  magic-link consume does — with one rule consume does not have (PR #991 review I3, "pre-hijack"). An
 *  account that was UNVERIFIED has never shown its password belongs to the inbox owner: a stranger can sign
 *  up with someone else's address (signup, and registration's captain email, take any address) and wait.
 *  Login refuses an unverified account, but verifying it here would switch that password on, for the
 *  squatter, on an account now linked to the claimed profile. So the password and any pending reset tokens
 *  are cleared; the invitee is signed in by this tap and can set a fresh password through the usual reset.
 *  A verified account is left exactly as it is, and so is a Google-linked one (its sign-in is Google's). */
async function verifyByInbox(tx: Tx, userId: string): Promise<void> {
  const [acct] = await tx<{ email_verified: boolean; google_sub: string | null }[]>`
    select email_verified, google_sub from users where id = ${userId} for update`;
  if (!acct || acct.email_verified) return;
  if (acct.google_sub === null) {
    await tx`update users set email_verified = true, password_hash = null where id = ${userId}`;
    await tx`delete from password_resets where user_id = ${userId} and used = false`;
  } else {
    await tx`update users set email_verified = true where id = ${userId}`;
  }
}

/** The account the invited address belongs to, or a new one. The address on a claim is whatever the organiser
 *  typed, while an account's is exactly-cased, unique and case-SENSITIVE (signup and magic-link do not
 *  lower-case), so "VICTIM@x.com" and "victim@x.com" can be two different accounts. Rules, in order:
 *    1. an EXACT match always wins, whatever its state;
 *    2. else a case-insensitive match binds ONLY to a VERIFIED account — an unverified look-alike is somebody
 *       else's registration, never "the player's account" — and when more than one verified variant matches,
 *       the claim is refused (409 CLAIM_EMAIL_AMBIGUOUS) rather than guessing;
 *    3. else a new account is created, lower-cased.
 *  Soft-deleted accounts never count. The case-insensitive lookup rides users_email_lower_idx (V464). */
async function accountForInvitedAddress(tx: Tx, email: string): Promise<string> {
  const [exact] = await tx<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  if (exact) return exact.id;

  const variants = await tx<{ id: string }[]>`
    select id from users
    where lower(email) = lower(${email}) and deleted_at is null and email_verified
    limit 2`;
  if (variants.length > 1) {
    throw new HttpError(
      409,
      "More than one account matches this address — contact the organiser or support",
      "CLAIM_EMAIL_AMBIGUOUS",
    );
  }
  if (variants[0]) return variants[0].id;

  const created = await resolveOrCreateUser(email.toLowerCase(), tx);
  if (!created) {
    // The address is held by a soft-deleted account (resolveOrCreateUser re-reads
    // with deleted_at is null and finds nothing): there is no account to sign in.
    throw new HttpError(
      409,
      "This address can't be signed in right now — contact the organiser or support",
      "CLAIM_SIGNIN_UNAVAILABLE",
    );
  }
  return created;
}

/**
 * Staff unlink: detach the login and close every live claim row. The claimed
 * row keeps claimed_at AND gains revoked_at — that pair is the unlink audit.
 */
export async function unlinkPerson(auth: AuthCtx, personId: string): Promise<void> {
  requireSessionEditor(auth);
  await withTenant(auth.orgId, async (tx) => {
    const [person] = await tx<{ id: string }[]>`
      select id from persons where id = ${personId} and merged_into is null`;
    if (!person) throw new HttpError(404, "person not found");
    await tx`update persons set user_id = null where id = ${personId}`;
    await tx`
      update person_claims set revoked_at = now()
      where person_id = ${personId} and revoked_at is null`;
  });
}
