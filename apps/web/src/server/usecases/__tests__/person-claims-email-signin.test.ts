// Claiming from the INVITE EMAIL signs the player in, in one tap (owner-approved
// 2026-10-19, "go with the split design"). A claim row carries TWO secrets:
//   - the CONSOLE secret (token_hash) — shown to the organiser as a copyable link
//     + QR; whoever holds it must still sign in before claiming;
//   - the EMAIL secret (email_token_hash) — sent only in the invite email, never
//     returned by any API; opening it proves the inbox, so it can sign in.
// Real Postgres required; skipped without DATABASE_URL (CI unit shards have none,
// so nothing below touches `sql` at module level).
//
// Expected hashes are computed HERE with node:crypto, never through the code under
// test (TEST-STRATEGY rule 3). Every sweep reports how many cases it ran and a
// zero count is a failure (rule 2).
import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { AuthError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  claimByEmailLink,
  claimPerson,
  createClaimInvite,
  createSystemClaimInvite,
  resolveClaimToken,
  revokeClaimInvite,
  unlinkPerson,
} from "../person-claims";
import { createPerson } from "../persons";

const HAS_DB = !!process.env.DATABASE_URL;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(): Promise<{ orgId: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Email Claim Org " + suffix}, ${"email-claim-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  return { orgId, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

/** A fresh org, owner and one unclaimed person, plus an invite to a unique address. */
async function rig(emailOverride?: string) {
  const { orgId, ownerId } = await seedOrg();
  const owner = asOwner(orgId, ownerId);
  const person = await createPerson(owner, { full_name: "Sam Player", consent: {} } as never);
  const email = emailOverride ?? `sam-${randomUUID().slice(0, 8)}@test.local`;
  const invite = await createClaimInvite(owner, person.id, email);
  return { orgId, ownerId, owner, person, email, invite };
}

const usersWithEmail = async (email: string) =>
  sql<{ id: string; email: string; email_verified: boolean; password_hash: string | null; google_sub: string | null }[]>`
    select id, email, email_verified, password_hash, google_sub from users
    where lower(email) = lower(${email}) and deleted_at is null`;

const claimRow = async (id: string) =>
  (
    await sql<{ claimed_at: string | null; revoked_at: string | null; token_hash: string; email_token_hash: string | null }[]>`
      select claimed_at, revoked_at, token_hash, email_token_hash from person_claims where id = ${id}`
  )[0]!;

const personUser = async (personId: string) =>
  (await sql<{ user_id: string | null }[]>`select user_id from persons where id = ${personId}`)[0]!.user_id;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("two secrets per claim: minting", () => {
  it("createClaimInvite mints a console secret AND a different email secret, both hashed at rest", async () => {
    const { invite } = await rig();
    expect(invite.secret.startsWith("pc_")).toBe(true);
    expect(invite.emailSecret.startsWith("pc_")).toBe(true);
    expect(invite.emailSecret).not.toBe(invite.secret);

    const row = await claimRow(invite.id);
    expect(row.token_hash).toBe(sha256(invite.secret));
    expect(row.email_token_hash).toBe(sha256(invite.emailSecret));
    expect(row.email_token_hash).not.toBe(row.token_hash);
    // Only a hash is stored — never the plaintext of either.
    const [dump] = await sql<{ j: string }[]>`select to_jsonb(pc)::text as j from person_claims pc where id = ${invite.id}`;
    expect(dump!.j).not.toContain(invite.secret);
    expect(dump!.j).not.toContain(invite.emailSecret);
  });

  it("the returned claim row never carries the email secret or its hash", async () => {
    const { invite } = await rig();
    const wire = JSON.stringify({ ...invite, secret: undefined, emailSecret: undefined });
    expect(wire).not.toContain(invite.emailSecret);
    expect(wire).not.toContain(sha256(invite.emailSecret));
    expect(Object.keys(invite)).not.toContain("email_token_hash");
  });

  it("createSystemClaimInvite (the registration path) mints an email secret that resolves as email", async () => {
    const { orgId, person } = await rig();
    // rig() already invited this person; a system invite revokes-and-replaces it.
    const sys = await createSystemClaimInvite(sql, orgId, person.id, "sys@test.local");
    expect(sys).not.toBeNull();
    expect(sys!.emailSecret.startsWith("pc_")).toBe(true);
    const resolved = await resolveClaimToken(sys!.emailSecret);
    expect(resolved.via).toBe("email");
    expect(resolved.email).toBe("sys@test.local");
    const [row] = await sql<{ email_token_hash: string | null }[]>`
      select email_token_hash from person_claims where id = ${resolved.id}`;
    expect(row!.email_token_hash).toBe(sha256(sys!.emailSecret));
  });
});

describe.skipIf(!HAS_DB)("resolveClaimToken reports which secret opened the claim", () => {
  it("the console secret resolves as via=console and the email secret as via=email — same claim", async () => {
    const { invite } = await rig();
    const viaConsole = await resolveClaimToken(invite.secret);
    const viaEmail = await resolveClaimToken(invite.emailSecret);
    expect(viaConsole.via).toBe("console");
    expect(viaEmail.via).toBe("email");
    expect(viaEmail.id).toBe(viaConsole.id);
    expect(viaEmail.person_id).toBe(viaConsole.person_id);
  });

  it("a pre-migration row (no email secret) still resolves, as console", async () => {
    const { invite } = await rig();
    await sql`update person_claims set email_token_hash = null where id = ${invite.id}`;
    expect((await resolveClaimToken(invite.secret)).via).toBe("console");
    await expect(resolveClaimToken(invite.emailSecret)).rejects.toMatchObject({ code: "CLAIM_INVALID" });
  });

  it("both secrets obey the same expired / revoked / claimed rules", async () => {
    // expired
    const a = await rig();
    await sql`update person_claims set expires_at = now() - interval '1 minute' where id = ${a.invite.id}`;
    for (const s of [a.invite.secret, a.invite.emailSecret]) {
      await expect(resolveClaimToken(s)).rejects.toMatchObject({ status: 401, code: "CLAIM_EXPIRED" });
    }
    // revoked
    const b = await rig();
    await revokeClaimInvite(b.owner, b.person.id);
    for (const s of [b.invite.secret, b.invite.emailSecret]) {
      await expect(resolveClaimToken(s)).rejects.toMatchObject({ status: 401, code: "CLAIM_REVOKED" });
    }
    // claimed
    const c = await rig();
    await claimPerson(c.invite.secret, await makeUser("c"), c.email);
    for (const s of [c.invite.secret, c.invite.emailSecret]) {
      await expect(resolveClaimToken(s)).rejects.toMatchObject({ status: 409, code: "CLAIM_CLAIMED" });
    }
  });

  it("a signed-in claim still works with EITHER secret, and email mismatch refuses either (unchanged)", async () => {
    const one = await rig();
    await claimPerson(one.invite.emailSecret, await makeUser("p1"), one.email);
    expect(await personUser(one.person.id)).not.toBeNull();

    const two = await rig();
    await claimPerson(two.invite.secret, await makeUser("p2"), two.email);
    expect(await personUser(two.person.id)).not.toBeNull();

    for (const kind of ["secret", "emailSecret"] as const) {
      const r = await rig();
      await expect(claimPerson(r.invite[kind], await makeUser("wrong"), "someone-else@test.local")).rejects.toMatchObject({
        status: 403,
        code: "CLAIM_EMAIL_MISMATCH",
      });
      expect(await personUser(r.person.id)).toBeNull();
    }
  });
});

describe.skipIf(!HAS_DB)("claimByEmailLink: the emailed secret signs the invitee in", () => {
  it("a NEW address: creates the account (verified), links the person, consumes the claim", async () => {
    const { invite, person, email } = await rig();
    expect(await usersWithEmail(email)).toHaveLength(0);

    const out = await claimByEmailLink(invite.emailSecret);

    const users = await usersWithEmail(email);
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(out.userId);
    // Marked verified the way magic-link consume does (opening the emailed link IS the proof).
    expect(users[0]!.email_verified).toBe(true);
    expect(users[0]!.password_hash).toBeNull();
    expect(await personUser(person.id)).toBe(out.userId);
    expect(out.claim.person_id).toBe(person.id);
    expect((await claimRow(invite.id)).claimed_at).not.toBeNull();
  });

  // Mirror magic-link consume: the account that already holds the address is the
  // one signed in, verified or not, whatever credentials it carries. What consume
  // does NOT do — and neither does this — is touch password_hash / google_sub.
  const EXISTING = [
    { name: "password, verified", verified: true, password: true, google: false },
    { name: "password, NOT yet verified", verified: false, password: true, google: false },
    { name: "Google (no password)", verified: true, password: false, google: true },
  ] as const;

  it.each(EXISTING)("an EXISTING account ($name) is signed in; no second account; credentials untouched", async (acct) => {
    const { invite, person, email } = await rig();
    const [existing] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, password_hash, google_sub)
      values (${email}, 'Existing', ${acct.verified},
              ${acct.password ? "$2a$10$somebodys.own.bcrypt.hash.placeholder" : null},
              ${acct.google ? `g-${randomUUID()}` : null})
      returning id`;
    const before = (await usersWithEmail(email))[0]!;

    const out = await claimByEmailLink(invite.emailSecret);

    expect(out.userId).toBe(existing!.id);
    const after = await usersWithEmail(email);
    expect(after).toHaveLength(1);
    expect(after[0]!.email_verified).toBe(true);
    expect(after[0]!.password_hash).toBe(before.password_hash);
    expect(after[0]!.google_sub).toBe(before.google_sub);
    expect(await personUser(person.id)).toBe(existing!.id);
  });

  it("the invite's address in a different CASE finds the existing account instead of minting a twin", async () => {
    const local = `case-${randomUUID().slice(0, 8)}`;
    const { invite, person } = await rig(`${local.toUpperCase()}@Test.Local`);
    const [existing] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`${local}@test.local`}, 'Lower', true) returning id`;

    const out = await claimByEmailLink(invite.emailSecret);

    expect(out.userId).toBe(existing!.id);
    expect(await usersWithEmail(`${local}@test.local`)).toHaveLength(1);
    expect(await personUser(person.id)).toBe(existing!.id);
  });

  it("a mixed-case address with no account creates ONE lower-cased account", async () => {
    const local = `fresh-${randomUUID().slice(0, 8)}`;
    const { invite } = await rig(`${local.toUpperCase()}@Test.Local`);
    const out = await claimByEmailLink(invite.emailSecret);
    const users = await usersWithEmail(`${local}@test.local`);
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(out.userId);
    expect(users[0]!.email).toBe(`${local}@test.local`);
  });

  it("a CONSOLE secret without a session is refused as 'not authenticated' and changes nothing", async () => {
    const { invite, person, email } = await rig();
    await expect(claimByEmailLink(invite.secret)).rejects.toBeInstanceOf(AuthError);
    // No account minted, nothing linked, the claim is still open.
    expect(await usersWithEmail(email)).toHaveLength(0);
    expect(await personUser(person.id)).toBeNull();
    expect((await claimRow(invite.id)).claimed_at).toBeNull();
    // The positive pair: the SAME claim's email secret does sign in.
    await expect(claimByEmailLink(invite.emailSecret)).resolves.toMatchObject({ claim: { person_id: person.id } });
  });

  it("a garbage token is refused as 'not authenticated' (the route's old answer) and mints nothing", async () => {
    const before = await sql<{ n: number }[]>`select count(*)::int as n from users`;
    await expect(claimByEmailLink("pc_definitely-not-a-token")).rejects.toBeInstanceOf(AuthError);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from users`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("expired, revoked and already-claimed email secrets are refused with their own codes, minting nothing", async () => {
    const cases: { code: string; status: number; arrange: (r: Awaited<ReturnType<typeof rig>>) => Promise<void> }[] = [
      {
        code: "CLAIM_EXPIRED",
        status: 401,
        arrange: async (r) => {
          await sql`update person_claims set expires_at = now() - interval '1 minute' where id = ${r.invite.id}`;
        },
      },
      {
        code: "CLAIM_REVOKED",
        status: 401,
        arrange: async (r) => {
          await revokeClaimInvite(r.owner, r.person.id);
        },
      },
      {
        code: "CLAIM_CLAIMED",
        status: 409,
        arrange: async (r) => {
          await claimPerson(r.invite.secret, await makeUser("early"), r.email);
        },
      },
    ];
    let checked = 0;
    for (const c of cases) {
      const r = await rig();
      await c.arrange(r);
      const usersBefore = (await usersWithEmail(r.email)).length;
      await expect(claimByEmailLink(r.invite.emailSecret)).rejects.toMatchObject({ code: c.code, status: c.status });
      // No account was created for the address by the refused attempt.
      expect((await usersWithEmail(r.email)).length).toBe(usersBefore);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a second call is CLAIM_CLAIMED, and the first account is the only one", async () => {
    const { invite, email } = await rig();
    const first = await claimByEmailLink(invite.emailSecret);
    await expect(claimByEmailLink(invite.emailSecret)).rejects.toMatchObject({ status: 409, code: "CLAIM_CLAIMED" });
    const users = await usersWithEmail(email);
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(first.userId);
  });

  it("a double tap (concurrent): exactly one wins, the other is CLAIM_CLAIMED, one account, one link", async () => {
    let wins = 0;
    let losses = 0;
    const ROUNDS = 6;
    for (let i = 0; i < ROUNDS; i++) {
      const { invite, person, email } = await rig();
      const settled = await Promise.allSettled([
        claimByEmailLink(invite.emailSecret),
        claimByEmailLink(invite.emailSecret),
        claimByEmailLink(invite.emailSecret),
      ]);
      const ok = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof claimByEmailLink>>> => s.status === "fulfilled");
      const bad = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(2);
      for (const b of bad) expect(b.reason).toMatchObject({ status: 409, code: "CLAIM_CLAIMED" });
      const users = await usersWithEmail(email);
      expect(users).toHaveLength(1);
      expect(await personUser(person.id)).toBe(ok[0]!.value.userId);
      wins += ok.length;
      losses += bad.length;
    }
    // Anti-vacuity: every round really raced three taps.
    expect(wins).toBe(ROUNDS);
    expect(losses).toBe(ROUNDS * 2);
  });

  it("an account that holds a different player profile in the org: PERSON_ALREADY_LINKED, and the WHOLE attempt rolls back", async () => {
    const { orgId, invite, email, person } = await rig();
    // The invitee already has an UNVERIFIED account and is linked to another player-lane person here.
    const [acct] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, 'Twice', false) returning id`;
    await sql`insert into persons (org_id, full_name, lane, user_id) values (${orgId}, 'Other Me', 'player', ${acct!.id})`;

    await expect(claimByEmailLink(invite.emailSecret)).rejects.toMatchObject({ status: 409, code: "PERSON_ALREADY_LINKED" });

    // Rolled back: not verified by the failed attempt, person not linked, claim still open.
    const [after] = await usersWithEmail(email);
    expect(after!.email_verified).toBe(false);
    expect(await personUser(person.id)).toBeNull();
    expect((await claimRow(invite.id)).claimed_at).toBeNull();
  });

  it("an address held by a soft-deleted account is refused by name and leaves the claim open", async () => {
    const { invite, email, person } = await rig();
    await sql`
      insert into users (email, display_name, email_verified, deleted_at)
      values (${email}, 'Gone', true, now())`;
    await expect(claimByEmailLink(invite.emailSecret)).rejects.toMatchObject({ status: 409, code: "CLAIM_SIGNIN_UNAVAILABLE" });
    expect(await personUser(person.id)).toBeNull();
    expect((await claimRow(invite.id)).claimed_at).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("rotation and revoke kill BOTH secrets", () => {
  it("re-inviting rotates the email secret: the old emailed link is dead, the new one signs in", async () => {
    const { owner, person, email, invite: first } = await rig();
    const second = await createClaimInvite(owner, person.id, email);
    expect(second.emailSecret).not.toBe(first.emailSecret);
    expect(second.secret).not.toBe(first.secret);

    // The OLD email link: revoked, refuses to sign anybody in, mints no account.
    await expect(claimByEmailLink(first.emailSecret)).rejects.toMatchObject({ status: 401, code: "CLAIM_REVOKED" });
    await expect(resolveClaimToken(first.emailSecret)).rejects.toMatchObject({ code: "CLAIM_REVOKED" });
    await expect(resolveClaimToken(first.secret)).rejects.toMatchObject({ code: "CLAIM_REVOKED" });
    expect(await usersWithEmail(email)).toHaveLength(0);
    // The NEW one works.
    await expect(claimByEmailLink(second.emailSecret)).resolves.toMatchObject({ claim: { person_id: person.id } });
  });

  it("revoking withdraws both links", async () => {
    const { owner, person, email, invite } = await rig();
    await revokeClaimInvite(owner, person.id);
    await expect(claimByEmailLink(invite.emailSecret)).rejects.toMatchObject({ code: "CLAIM_REVOKED" });
    await expect(resolveClaimToken(invite.secret)).rejects.toMatchObject({ code: "CLAIM_REVOKED" });
    expect(await usersWithEmail(email)).toHaveLength(0);
  });

  it("after a claim, staff unlink closes the row; the emailed link stays dead (and a fresh invite mints fresh secrets)", async () => {
    const { owner, person, email, invite } = await rig();
    await claimByEmailLink(invite.emailSecret);
    await unlinkPerson(owner, person.id);
    await expect(claimByEmailLink(invite.emailSecret)).rejects.toMatchObject({ status: 409, code: "CLAIM_CLAIMED" });
    const again = await createClaimInvite(owner, person.id, email);
    expect(again.emailSecret).not.toBe(invite.emailSecret);
    await expect(claimByEmailLink(again.emailSecret)).resolves.toMatchObject({ claim: { person_id: person.id } });
  });
});

// The locks claimByEmailLink takes are guards, so each is pinned by making it MATTER, deterministically:
// a transaction that holds the row it needs is parked, the claim is started against it, and the test waits
// (in pg_stat_activity, not by sleeping) until the claim is actually blocked on that lock.
describe.skipIf(!HAS_DB)("claimByEmailLink under lock", () => {
  /** Resolves once some backend is waiting on a heavyweight lock in a statement containing `fragment`. */
  async function blockedOn(fragment: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike ${"%" + fragment + "%"}`;
      if (n > 0) return;
      if (Date.now() > deadline) throw new Error(`no backend ever blocked on a lock in: ${fragment}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  /** Park a transaction that has run `hold` and keeps its locks until `release()`. */
  function parked(hold: (tx: typeof sql) => Promise<unknown>) {
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const heldP = new Promise<void>((r) => (held = r));
    const done = sql.begin(async (tx) => {
      await hold(tx as unknown as typeof sql);
      held();
      await gate;
    });
    return { held: heldP, release, done };
  }

  it("a revoke that lands between the first read and the lock is honoured: CLAIM_REVOKED, nothing created", async () => {
    const { invite, person, email } = await rig();
    // The organiser's revoke is in flight (uncommitted) when the invitee's tap arrives.
    const revoke = parked((tx) => tx`update person_claims set revoked_at = now() where id = ${invite.id}`);
    await revoke.held;

    const tap = claimByEmailLink(invite.emailSecret);
    const outcome = tap.then(
      () => "claimed",
      (e: { code?: string }) => e.code,
    );
    await blockedOn("person_claims"); // the tap read the row as still open, and now waits on the revoke's lock
    revoke.release();
    await revoke.done;

    expect(await outcome).toBe("CLAIM_REVOKED");
    expect(await usersWithEmail(email)).toHaveLength(0);
    expect(await personUser(person.id)).toBeNull();
  });

  it("takes the person lock BEFORE the claim row's (the order every other writer takes): the claim row stays free while the person is held", async () => {
    const { invite, person } = await rig();
    const holder = parked((tx) => tx`select 1 from persons where id = ${person.id} for update`);
    await holder.held;

    const tap = claimByEmailLink(invite.emailSecret);
    await blockedOn("from persons"); // parked on the person row, as the order requires
    // Had it taken the claim row first, this would fail with 55P03 while the tap waits on the person.
    await expect(
      sql.begin((tx) => tx`select id from person_claims where id = ${invite.id} for update nowait`),
    ).resolves.toHaveLength(1);

    holder.release();
    await holder.done;
    await expect(tap).resolves.toMatchObject({ claim: { person_id: person.id } });
  });

  it("the console link's signed-in accept and the emailed link racing: one wins, the other is CLAIM_CLAIMED, never a deadlock", async () => {
    let claimedByEmail = 0;
    let claimedBySession = 0;
    const ROUNDS = 8;
    for (let i = 0; i < ROUNDS; i++) {
      const { invite, email, person } = await rig();
      const [u] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified) values (${email}, 'Racer', true) returning id`;
      const settled = await Promise.allSettled([
        claimPerson(invite.secret, u!.id, email),
        claimByEmailLink(invite.emailSecret),
      ]);
      const ok = settled.filter((x) => x.status === "fulfilled");
      const bad = settled.filter((x): x is PromiseRejectedResult => x.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(bad[0]!.reason).toMatchObject({ status: 409, code: "CLAIM_CLAIMED" }); // not a raw 40P01 deadlock
      expect(await personUser(person.id)).toBe(u!.id);
      if (settled[0]!.status === "fulfilled") claimedBySession++;
      else claimedByEmail++;
    }
    expect(claimedByEmail + claimedBySession).toBe(ROUNDS); // anti-vacuity: every round had a winner
  });
});
