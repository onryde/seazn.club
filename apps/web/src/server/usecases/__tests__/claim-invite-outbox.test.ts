// The claim invite goes through the email outbox (phase 3 wave 3, kind `claim_invite`), from both of its producers:
//
//  - the organiser's console (POST /api/v1/persons/{id}/claim-invites): the claim and the row that mails its EMAIL secret are one tenant
//    transaction (`createClaimInvite`'s `withTenant`, R3: the row's org is the tenant's), and the request makes the first attempt after
//    commit, so `email_sent` is its outcome;
//  - every registration path (F9): each one converges on `inviteUnclaimedMembers`, after its own commit, and its `maybeInviteClaim`
//    mints the claim and queues the row in one transaction on the pool, then makes the first attempt. Two different entry points are
//    driven (the team submit and the organiser's approval), through the REAL sweep: its calls are `void`, so the tests poll for the row.
//
// The row's ref is the person (a re-invite to the same address supersedes the older row), the language is the organisation's default
// (the person is unclaimed, so there is no account to follow), and the mail carries the EMAIL secret, never the console one.
//
// Stand-ins: the outbox's transport (the one network seam: captured, never sent) and `next/headers` (a cookie jar, so the organiser is
// signed in through the real session). Expected values come from the dictionary on disk (`dictionarySubject`) and from the claim's own
// row (`person_claims`), never from the route's answer.
//
// Sport: not applicable (a claim invite does not vary by sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.67" }),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));
// The outbox's one network seam. The rows, the claim and the render are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { createPerson } from "@/server/usecases/persons";
import { inviteUnclaimedMembers, putRegistrationSettings } from "@/server/usecases/registrations";
import { submitRegistrationGroup } from "@/server/usecases/registration-submit";
import { approveRegistration } from "@/server/usecases/registration-approval";
import { POST as claimInvitePost } from "@/app/api/v1/persons/[id]/claim-invites/route";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { SETTINGS_BASE, asOwner, makeUser, rig, seedOrg } from "./_registration-fixtures";
import { stubOutboxEnv } from "./_invite-mail";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `ci-${randomUUID().slice(0, 8)}`;
const ORIGIN = "https://console.test";
const orgs: string[] = [];

type Delivered = { to: string; subject: string; html: string; text: string; idempotencyKey: string };
type MailRow = {
  id: string; kind: string; ref_type: string; ref_id: string; org_id: string | null; recipient: string;
  recipient_user_id: string | null; transactional: boolean; subject: string; status: string;
};

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const tokenOf = (text: string) => /\/claim\/(pc_[A-Za-z0-9_-]+)/.exec(text)![1]!;

/** An organisation whose public default language is `locale`, and its owner. */
async function org(locale: string) {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  orgs.push(orgId);
  const [o] = await sql<{ name: string }[]>`update organizations set default_locale = ${locale} where id = ${orgId} returning name`;
  return { orgId, orgSlug, ownerId, owner: asOwner(orgId, ownerId), name: o!.name };
}

/** The organiser invites `personId` to claim through the real route, signed in through the real session. */
async function invite(ownerId: string, personId: string, body: Record<string, unknown>) {
  jar.values.clear();
  await createSession(ownerId);
  const res = await claimInvitePost(
    new Request(`${ORIGIN}/api/v1/persons/${personId}/claim-invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: personId }) },
  );
  jar.values.clear();
  const wire = await res.text();
  return { status: res.status, wire, data: (JSON.parse(wire) as { data: Record<string, unknown> }).data };
}

/** The rows of `kind` about this ref, oldest first. */
const rowsOf = (kind: string, refType: string, refId: string) =>
  sql<MailRow[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, transactional, subject, status
      from email_outbox where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}
     order by created_at, id`;
/** Every claim invite an organisation queued. */
const claimInvitesOfOrg = (orgId: string) =>
  sql<MailRow[]>`select id, ref_id, recipient, status from email_outbox where kind = 'claim_invite' and org_id = ${orgId}`;
/** The person's newest claim. */
const claimOf = async (personId: string) =>
  (
    await sql<{ token_hash: string; email_token_hash: string; revoked_at: Date | null }[]>`
      select token_hash, email_token_hash, revoked_at from person_claims where person_id = ${personId} order by created_at desc limit 1`
  )[0]!;
/** What the transport was handed under this row's own key. */
const callsFor = (rowId: string): Delivered[] =>
  transport.deliver.mock.calls.map((c) => c[0] as Delivered).filter((m) => m.idempotencyKey === `email-outbox/${rowId}`);

/** A team division (free, the generic sport: a squad of one) whose entries are confirmed automatically, or wait for the organiser. */
async function teamDivision(o: Awaited<ReturnType<typeof org>>, approval: "auto" | "manual") {
  const { competition, division } = await rig(o.owner);
  await putRegistrationSettings(o.owner, division.id, {
    ...SETTINGS_BASE,
    entrant_kind: "team",
    payment_method: "offline",
    fee_cents: 0,
    approval,
  });
  return { competition, division };
}

/** The real team submit: the contact plays on the team (their own row is consented at submit) and has no account unless one is given. */
async function submitTeam(
  o: Awaited<ReturnType<typeof org>>,
  t: Awaited<ReturnType<typeof teamDivision>>,
  contact: { name: string; email: string; dob?: string },
  sessionUserId: string | null = null,
) {
  const res = await submitRegistrationGroup(
    { orgSlug: o.orgSlug, compSlug: t.competition.slug, sessionUserId },
    {
      contact,
      privacy_consent: true,
      entries: [
        {
          division_id: t.division.id,
          entrant_kind: "team",
          team_name: `Team ${RUN}`,
          registering_self: true,
          self_player_index: 0,
          players: [{ full_name: contact.name }],
          answers: {},
        },
      ],
    },
  );
  return res.entries[0]!.registration_id;
}

/** The registration's entrant and the contact's person, once the entry is confirmed. */
const entrantAndPerson = async (registrationId: string) =>
  (
    await sql<{ entrant_id: string | null; person_id: string | null; user_id: string | null }[]>`
      select r.entrant_id, rp.person_id, p.user_id
        from registrations r join registration_players rp on rp.registration_id = r.id left join persons p on p.id = rp.person_id
       where r.id = ${registrationId}`
  )[0]!;

/** Wait until the person's claim invite has been attempted and sent (the sweep that queues it is detached from the caller). */
async function sentClaimInvite(personId: string): Promise<MailRow[]> {
  let rows: MailRow[] = [];
  await vi.waitFor(
    async () => {
      rows = await rowsOf("claim_invite", "person", personId);
      if (rows.length === 0 || rows.some((r) => r.status !== "sent")) throw new Error(`claim invite rows: ${JSON.stringify(rows.map((r) => r.status))}`);
    },
    { timeout: 15_000, interval: 50 },
  );
  return rows;
}

beforeEach(() => {
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where org_id = any(${orgs}::uuid[])`;
});

describe.skipIf(!HAS_DB)("the claim invite goes through the outbox (DB)", () => {
  it("an organiser's invite queues one claim invite carrying the email secret, in the org's language, and reports email_sent", async () => {
    const o = await org("es");
    const person = await createPerson(o.owner, { full_name: "Ana Console", consent: {} } as never);
    const email = address();

    const res = await invite(o.ownerId, person.id, { email });

    expect(res.status).toBe(201);
    expect(res.data.email_sent, "the request's own attempt went out").toBe(true);
    const rows = await rowsOf("claim_invite", "person", person.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: "claim_invite",
      org_id: o.orgId,
      recipient: email,
      recipient_user_id: null,
      transactional: true,
      status: "sent",
    });
    expect(row.subject).toBe(dictionarySubject("es", "claimInvite.subject", { orgName: o.name }));
    expect(dictionarySubject("es", "claimInvite.subject", { orgName: o.name }), "es differs from en").not.toBe(
      dictionarySubject("en", "claimInvite.subject", { orgName: o.name }),
    );
    // The mail carries the EMAIL secret (the one stored as email_token_hash), and the organiser's console secret is not in it.
    const calls = callsFor(row.id);
    expect(calls, "one transport call, under the row's own key").toHaveLength(1);
    const mailed = tokenOf(calls[0]!.text);
    const claim = await claimOf(person.id);
    expect(sha256(mailed)).toBe(claim.email_token_hash);
    const consoleToken = tokenOf(res.data.claim_url as string);
    expect(sha256(consoleToken), "premise: the response carries the console secret").toBe(claim.token_hash);
    expect(calls[0]!.text).not.toContain(consoleToken);
    expect(calls[0]!.html).not.toContain(consoleToken);
    expect(res.wire, "and the response never carries the email secret").not.toContain(mailed);
  });

  it("a re-invite to the same address supersedes the first, and the first link no longer works", async () => {
    const o = await org("es");
    const person = await createPerson(o.owner, { full_name: "Ana Twice", consent: {} } as never);
    const email = address();

    expect((await invite(o.ownerId, person.id, { email })).status).toBe(201);
    const [first] = await rowsOf("claim_invite", "person", person.id);
    const firstToken = tokenOf(callsFor(first!.id)[0]!.text);
    expect((await invite(o.ownerId, person.id, { email })).status).toBe(201);

    const rows = await rowsOf("claim_invite", "person", person.id);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [first!.id, "replaced"],
      [rows[1]!.id, "sent"],
    ]);
    const [old] = await sql<{ revoked_at: Date | null }[]>`select revoked_at from person_claims where email_token_hash = ${sha256(firstToken)}`;
    expect(old!.revoked_at, "the first mail's claim is revoked").not.toBeNull();
    expect(sha256(tokenOf(callsFor(rows[1]!.id)[0]!.text)), "the second mail carries the open claim's secret").toBe((await claimOf(person.id)).email_token_hash);
  });

  it("a consented team member with no account gets one claim invite through the real submit", async () => {
    const o = await org("fr");
    const t = await teamDivision(o, "auto");
    const email = address();

    const registrationId = await submitTeam(o, t, { name: "Theo Captain", email });

    const { entrant_id: entrantId, person_id: personId } = await entrantAndPerson(registrationId);
    expect(entrantId, "premise: the free auto-approval entry was confirmed").not.toBeNull();
    expect(personId, "premise: the captain's own row resolved a person").not.toBeNull();
    const rows = await sentClaimInvite(personId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: o.orgId, recipient: email, transactional: true });
    expect(rows[0]!.subject).toBe(dictionarySubject("fr", "claimInvite.subject", { orgName: o.name }));

    // A second convergence for the same entrant (another registration path reaching the sweep): the open claim stops it (R6).
    await inviteUnclaimedMembers(o.orgId, entrantId!);
    expect(await rowsOf("claim_invite", "person", personId!), "still one").toHaveLength(1);
  });

  it("the approval path invites the same way", async () => {
    const o = await org("nl");
    const t = await teamDivision(o, "manual");
    const email = address();
    const registrationId = await submitTeam(o, t, { name: "Noor Pending", email });
    expect((await entrantAndPerson(registrationId)).entrant_id, "premise: the entry waits for the organiser").toBeNull();

    await approveRegistration(o.owner, registrationId);

    const { person_id: personId } = await entrantAndPerson(registrationId);
    const rows = await sentClaimInvite(personId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: o.orgId, recipient: email });
  });

  it("empty: a member with no email, or a person already claimed, queues nothing", async () => {
    const o = await org("es");
    // The console: no address is refused by the schema, and a claimed profile by the usecase.
    const person = await createPerson(o.owner, { full_name: "Ana Empty", consent: {} } as never);
    expect((await invite(o.ownerId, person.id, {})).status).toBe(400);
    const account = await makeUser(RUN);
    await sql`update persons set user_id = ${account} where id = ${person.id}`;
    expect((await invite(o.ownerId, person.id, { email: address() })).status).toBe(409);
    expect(await rowsOf("claim_invite", "person", person.id)).toEqual([]);

    // A registration path: the captain is a signed-in adult, so their person is already the account's and the sweep has nobody to invite.
    const t = await teamDivision(o, "auto");
    const captain = await makeUser(RUN);
    const [c] = await sql<{ email: string }[]>`select email from users where id = ${captain}`;
    const registrationId = await submitTeam(o, t, { name: "Signed In Captain", email: c!.email, dob: "1990-01-01" }, captain);
    const { entrant_id: entrantId, user_id: linked } = await entrantAndPerson(registrationId);
    expect(linked, "premise: the captain's person is their account's").toBe(captain);
    await inviteUnclaimedMembers(o.orgId, entrantId!);

    expect(await claimInvitesOfOrg(o.orgId), "no claim invite in the organisation").toEqual([]);
    expect(transport.deliver, "nothing sent").not.toHaveBeenCalled();
  });
});
