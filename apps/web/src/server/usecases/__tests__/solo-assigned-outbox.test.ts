// Phase 3 wave 1, Task 12: the solo sign-up assignment email goes through the email outbox (kind `solo_signup_assigned`, ref
// `registration/<the solo sign-up's registration id>`, no once-key). The producer under test is the real `assignSoloSignUp`: the email is
// rendered and queued inside the assignment's own tenant transaction, before its audit entry, so the placement, its audit row and its
// email commit together or not at all. The request makes the first attempt after the response (`deferred(() => dispatchNow([id]))`).
// Only the network seam is replaced (`@/server/email-outbox/transport`). Rows, claim, retry and replace rule are the real ones.
//
// "The right-hand side of the sequence": a second Assign of the same pair is `alreadyPlaced` and must queue nothing (the double-click the
// organiser's console invites), and a withdrawn solo sign-up is refused before anything is queued.
//
// Sport: football, deliberately (the roster has to be big enough to fill; `generic` fills at one player). The email does not vary by sport.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The one network seam. The kind harness reads this same mock back (it imports `deliver` from the same module).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The assignment's audit write fails once, armed immediately before the call under test.
const auditGate = vi.hoisted(() => ({ failOnce: false }));
vi.mock("@/server/usecases/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/audit")>();
  return {
    ...actual,
    audit: async (...args: Parameters<typeof actual.audit>) => {
      if (auditGate.failOnce) {
        auditGate.failOnce = false;
        throw new Error("audit is down");
      }
      return actual.audit(...args);
    },
  };
});

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { putRegistrationSettings, withdrawRegistrationOrganiser } from "../registrations";
import { assignSoloSignUp } from "../registration-assign";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { assertNothingMoreToSend, dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";
import { seedFootballCatalog, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const KIND = "solo_signup_assigned" as const;

const made = { orgIds: [] as string[], userIds: [] as string[] };

async function cleanUp(): Promise<void> {
  await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from users where id = any(${made.userIds}::uuid[])`;
}

afterAll(async () => {
  if (HAS_DB) {
    await cleanUp();
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

const ok = async () => ({ ok: true, providerId: `re_t12_${randomUUID()}` });
const later = async () => ({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });

beforeEach(() => {
  stubOutboxEnv();
  auditGate.failOnce = false;
  deliverMock.mockReset();
  deliverMock.mockImplementation(ok);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (tag: string): string => `t12-${tag}-${randomUUID().slice(0, 8)}@test.local`;

/** A football team division that takes solo sign-ups, a team entry and a pooled solo sign-up whose cart carries `locale` and `email`. */
async function world(over: { locale?: string | null; email?: string } = {}) {
  const { auth } = await seedOrg();
  made.orgIds.push(auth.orgId);
  made.userIds.push(auth.userId as string);
  await seedFootballCatalog();
  const competition = await createCompetition(auth, {
    name: "Assign Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10),
    ends_on: new Date(Date.now() + 65 * 86_400_000).toISOString().slice(0, 10),
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    sport_key: "football",
    variant_key: "default",
    config: {},
  });
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: "team",
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
    allow_free_agents: true,
  });
  const teamName = `Riverside Rovers ${randomUUID().slice(0, 6)}`;
  const team = await seedEntry(competition.id, division.id, { displayName: teamName, email: address("captain"), locale: null, freeAgent: false });
  const email = over.email ?? address("solo");
  const solo = await seedEntry(competition.id, division.id, { displayName: "Priya Raman", email, locale: over.locale ?? null, freeAgent: true });
  return { auth, competition, division, teamName, team, solo, email };
}
type World = Awaited<ReturnType<typeof world>>;

/** One confirmed `registrations` row in its own cart, with a roster row for the person (the V363/V364 shape, as registration-assign.test.ts). */
async function seedEntry(
  competitionId: string,
  divisionId: string,
  o: { displayName: string; email: string; locale: string | null; freeAgent: boolean },
): Promise<{ id: string; groupId: string }> {
  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, currency, locale)
    values (${competitionId}, 'Contact', ${o.email}, ${`tok-${randomUUID()}`}, 'gbp', ${o.locale})
    returning id`;
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, free_agent, status)
    values (${group!.id}, ${divisionId}, ${o.displayName}, ${o.freeAgent}, 'confirmed')
    returning id`;
  await sql`
    insert into registration_players (registration_id, full_name, source, consent_status)
    values (${reg!.id}, ${o.displayName}, 'captain_entered', 'pending')`;
  return { id: reg!.id, groupId: group!.id };
}

const assign = (w: World, auth: AuthCtx = w.auth) => assignSoloSignUp(auth, { registration_id: w.solo.id, target_registration_id: w.team.id });
const rosterNames = async (registrationId: string): Promise<string[]> =>
  (await sql<{ full_name: string }[]>`select full_name from registration_players where registration_id = ${registrationId} order by created_at, id`).map(
    (r) => r.full_name,
  );

type Row = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  recipient: string;
  subject: string;
  status: string;
  attempts: number;
  transactional: boolean;
  dedupe_key: string | null;
};

const rowsTo = (email: string) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, subject, status, attempts, transactional, dedupe_key
      from email_outbox
     where kind = ${KIND} and lower(recipient) = lower(${email})
     order by created_at, id`;

type Sent = { to: string; subject: string; idempotencyKey: string };
const callsTo = (email: string): Sent[] =>
  deliverMock.mock.calls.map((c) => c[0] as Sent).filter((c) => c.to.toLowerCase() === email.toLowerCase());
const callsFor = (id: string): Sent[] => deliverMock.mock.calls.map((c) => c[0] as Sent).filter((c) => c.idempotencyKey === idempotencyKey(id));

/** Wait until the address's rows have left `queued`/`sending` (the dispatch after the response runs on its own). */
async function settledTo(email: string, n: number): Promise<Row[]> {
  await vi.waitFor(
    async () => {
      const rows = await rowsTo(email);
      if (rows.length !== n) throw new Error(`${rows.length} row(s), waiting for ${n}`);
      const open = rows.filter((r) => r.status === "queued" || r.status === "sending");
      if (open.length > 0) throw new Error(`${open.length} row(s) still ${open[0]!.status}`);
    },
    { timeout: 10_000, interval: 50 },
  );
  return rowsTo(email);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The assignment email
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the solo sign-up assignment email rides the outbox (DB)", () => {
  it("an assignment queues one email in the person's locale and sends it", async () => {
    const w = await world({ locale: "fr" });

    await assign(w);

    const [row] = await settledTo(w.email, 1);
    expect(row).toMatchObject({
      kind: KIND,
      ref_type: "registration",
      ref_id: w.solo.id,
      org_id: w.auth.orgId,
      recipient: w.email,
      transactional: false,
      dedupe_key: null,
      status: "sent",
    });
    const subject = dictionarySubject("fr", "soloSignUpAssigned.subject", { teamName: w.teamName });
    expect(subject, "the French subject is not the English one").not.toBe(dictionarySubject("en", "soloSignUpAssigned.subject", { teamName: w.teamName }));
    expect(row!.subject).toBe(subject);
    expect(callsFor(row!.id), "one transport call under the row's key").toHaveLength(1);
    expect(callsFor(row!.id)[0]).toMatchObject({ to: w.email, subject });
    expect(await rosterNames(w.team.id), "and the person is on the roster").toContain("Priya Raman");

    // The second call: the request path again and a tick over a row made to look due send nothing more.
    await assertNothingMoreToSend(KIND, [row!.id]);
  });

  it("a double Assign sends one email", async () => {
    const w = await world({ locale: "fr" });

    await assign(w);
    await settledTo(w.email, 1);
    await assign(w); // the same pair again: `alreadyPlaced`, an idempotent success

    // The enqueue is part of the assignment's own transaction, so a second row would exist by the time the second call returns.
    expect(await rowsTo(w.email), "still one row after the second Assign").toHaveLength(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(callsTo(w.email), "and the transport was reached once").toHaveLength(1);
    expect((await rosterNames(w.team.id)).filter((n) => n === "Priya Raman"), "and the person is on the roster once").toHaveLength(1);
  });

  it("a registrant whose address is blank is placed and nothing is queued (the guard; the column is NOT NULL, so a blank is the only empty form)", async () => {
    // registration_groups.contact_email is `text not null` (V363:57) and the public submit validates a real address, so no product path
    // writes a blank. The guard (`if (source.contact_email)`) is the boundary the old sender had; this proves it still holds.
    const w = await world({ email: "" });

    await assign(w);

    expect(await rosterNames(w.team.id), "the placement itself went through").toContain("Priya Raman");
    const all = await sql<{ id: string }[]>`select id from email_outbox where kind = ${KIND} and ref_id = ${w.solo.id}`;
    expect(all).toHaveLength(0);
  });

  it("rollback: an assignment whose audit fails queues nothing", async () => {
    const w = await world({ locale: "fr" });

    auditGate.failOnce = true;
    await expect(assign(w)).rejects.toThrow(/audit is down/);

    expect(await rowsTo(w.email), "the email is part of the assignment's transaction: it did not outlive the rollback").toHaveLength(0);
    expect(await rosterNames(w.team.id), "and neither did the placement").not.toContain("Priya Raman");
    expect(callsTo(w.email)).toHaveLength(0);
  });

  it("after a withdrawal: assigning a withdrawn solo sign-up is refused and queues nothing", async () => {
    const w = await world({ locale: "fr" });
    await withdrawRegistrationOrganiser(w.auth, w.solo.id);

    await expect(assign(w)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/withdrawn/) });

    expect(await rowsTo(w.email)).toHaveLength(0);
    expect(await rosterNames(w.team.id)).not.toContain("Priya Raman");
    expect(callsTo(w.email)).toHaveLength(0);
  });

  it("a provider failure leaves the placement standing and the email queued for a retry", async () => {
    const w = await world({ locale: "fr" });
    deliverMock.mockReset().mockImplementation(later);

    await assign(w);

    expect(await rosterNames(w.team.id), "the placement stands whatever the mail does").toContain("Priya Raman");
    await vi.waitFor(async () => {
      const [r] = await rowsTo(w.email);
      if (!r || r.attempts < 1) throw new Error("the request's attempt has not been made yet");
      // `attempts` is counted when the row is claimed into `sending`, before the provider's answer returns it to `queued`.
      if (r.status === "sending") throw new Error("the request's attempt is still in flight");
    }, { timeout: 10_000, interval: 50 });
    const [retrying] = await rowsTo(w.email);
    expect(retrying).toMatchObject({ status: "queued", attempts: 1 });

    // A later tick, the provider back: sent, under the SAME key.
    deliverMock.mockReset().mockImplementation(ok);
    await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = ${retrying!.id}`;
    await runOutboxTick({ onlyIds: [retrying!.id], sleep: async () => undefined });
    const [after] = await rowsTo(w.email);
    expect(after).toMatchObject({ status: "sent", attempts: 2 });
    expect(callsFor(retrying!.id)).toHaveLength(1);
  });
});
