// Phase 3 wave 1, Task 10: the waitlist promotion email goes through the email outbox (kind `registration_promoted`, ref
// `registration/<promoted id>`, once-key `<promoted id>:<promoted_at>`). Producers under test, each driven through its REAL entry point:
//   - a withdrawal that frees a spot (`withdrawRegistrationPublic` -> `withdrawCore` -> `notifyPromoted`, first attempt after the response),
//   - the sweep's expiry pass (`sweepRegistrations` -> `notifyPromoted`, first attempt left to the worker),
//   - `notifyPromoted` itself, for the replay and the "cannot happen" guard.
// Only the network seams are replaced (Stripe, and `@/server/email-outbox/transport`). Rows, claim, retry and the once-key are the real ones.
//
// The promotion has committed before the email is queued, and a promotion email must never undo it (P4): the enqueue is on the pool,
// after the commit, and a refusal is logged.
//
// Sport: not applicable. The email does not vary by sport (spec, Test strategy 4); the locale is the axis that varies.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const refundCreate = vi.fn();
  return { checkoutCreate, refundCreate, stripe: { checkout: { sessions: { create: checkoutCreate } }, refunds: { create: refundCreate } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// The one network seam. The kind harness reads this same mock back (it imports `deliver` from the same module).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import {
  divisionCtx,
  handleRegistrationCheckoutCompleted,
  notifyPromoted,
  promoteWaitlistedRow,
  putRegistrationSettings,
  sweepRegistrations,
  withdrawRegistrationPublic,
} from "../registrations";
import { promoteFromWaitlist, rejectRegistration } from "../registration-approval";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { assertNothingMoreToSend, bornAgo, dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";
import { SETTINGS_BASE, asOwner, fakeSession, loadWithGroup, rig, seedOrg, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://test.local";
const KIND = "registration_promoted" as const;
const GUARD = "notifyPromoted: a promoted registration has no promoted_at";

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

const ok = async () => ({ ok: true, providerId: `re_t10_${randomUUID()}` });

beforeEach(() => {
  stubOutboxEnv();
  deliverMock.mockReset();
  deliverMock.mockImplementation(ok);
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: `cs_t10_${randomUUID().slice(0, 8)}`,
    url: "https://checkout.stripe.test/session",
  }));
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: `re_t10_${randomUUID().slice(0, 8)}` });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (tag: string): string => `t10-${tag}-${randomUUID().slice(0, 8)}@test.local`;

/** A one-spot division with a fee: `offline` (instructions, no Checkout session) or `stripe` (a pay link is minted on promotion). */
async function fullDivision(method: "offline" | "stripe", fee = 1500, approval: "auto" | "manual" = "auto") {
  if (method === "stripe") {
    const w = await stripeRig({ capacity: 1, feeCents: fee });
    made.orgIds.push(w.orgId);
    made.userIds.push(w.ownerId);
    return w;
  }
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    fee_cents: fee,
    payment_method: "offline",
    payment_instructions: "Pay at the desk",
    capacity: 1,
    approval,
  });
  return { orgId, orgSlug, ownerId, owner, competition, division, settings };
}
type Division = Awaited<ReturnType<typeof fullDivision>>;

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
  expires_at: Date;
};

const rowsTo = (email: string) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, subject, status, attempts, transactional, dedupe_key, expires_at
      from email_outbox
     where kind = ${KIND} and lower(recipient) = lower(${email})
     order by created_at, id`;
const rowsOfOrg = (orgId: string) => sql<{ id: string }[]>`select id from email_outbox where kind = ${KIND} and org_id = ${orgId}`;

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

/** A full division whose one spot is held by `holder`, with a waitlisted registrant behind it in `locale`. */
async function seedQueue(d: Division, locale: "nl" | "es" | null = "nl") {
  const holderEmail = address("holder");
  const waitEmail = address("wait");
  const holder = await seedRegistration(d.competition.id, d.division.id, d.settings, { contactEmail: holderEmail, displayName: "Holder" });
  const waiting = await seedRegistration(d.competition.id, d.division.id, d.settings, {
    contactEmail: waitEmail,
    displayName: "Wait Lister",
    status: "waitlisted",
    locale,
  });
  return { holder, waiting, holderEmail, waitEmail };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The promotion email
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the waitlist promotion email rides the outbox (DB)", () => {
  it("a promotion from a withdrawal queues one email in the registrant's locale and sends it", async () => {
    const d = await fullDivision("offline");
    const q = await seedQueue(d, "nl");

    await withdrawRegistrationPublic(q.holder.registration.id, q.holder.access_token);

    const [row] = await settledTo(q.waitEmail, 1);
    const promotedAt = (await loadWithGroup(q.waiting.registration.id)).promoted_at!;
    expect(row).toMatchObject({
      kind: KIND,
      ref_type: "registration",
      ref_id: q.waiting.registration.id,
      org_id: d.orgId,
      recipient: q.waitEmail,
      transactional: false,
      dedupe_key: `${q.waiting.registration.id}:${promotedAt.toISOString()}`,
      status: "sent",
    });
    const subject = dictionarySubject("nl", "registrationPromoted.subject", { competitionName: d.competition.name });
    expect(subject, "the Dutch subject is not the English one").not.toBe(
      dictionarySubject("en", "registrationPromoted.subject", { competitionName: d.competition.name }),
    );
    expect(row!.subject).toBe(subject);
    expect(callsFor(row!.id), "one transport call under the row's key").toHaveLength(1);
    expect(callsFor(row!.id)[0]).toMatchObject({ to: q.waitEmail, subject });
    expect(await rowsTo(q.holderEmail), "the withdrawn registrant is not mailed the promotion").toHaveLength(0);

    // The second call: the request path again and a tick over a row made to look due send nothing more.
    await assertNothingMoreToSend(KIND, [row!.id]);
  });

  it("the organiser's reject and the organiser's manual promotion reach the same queue, and send", async () => {
    // The two approval-side callers of notifyPromoted, each through its real entry point.
    const d = await fullDivision("offline", 1500, "manual");
    const q = await seedQueue(d, "es");
    await rejectRegistration(d.owner, q.holder.registration.id);
    const [afterReject] = await settledTo(q.waitEmail, 1);
    expect(afterReject).toMatchObject({ kind: KIND, status: "sent", ref_id: q.waiting.registration.id });
    expect(afterReject!.subject).toBe(dictionarySubject("es", "registrationPromoted.subject", { competitionName: d.competition.name }));

    const d2 = await fullDivision("offline", 1500, "manual");
    const q2 = await seedQueue(d2, "nl");
    await sql`update registration_settings set capacity = 2 where division_id = ${d2.division.id}`;
    const promoted = await promoteFromWaitlist(d2.owner, d2.division.id, { registrationId: q2.waiting.registration.id });
    expect(promoted?.status, "premise: the organiser promoted the waitlisted registrant").toBe("pending");
    const [afterPromote] = await settledTo(q2.waitEmail, 1);
    expect(afterPromote).toMatchObject({ kind: KIND, status: "sent", ref_id: q2.waiting.registration.id });
    expect(afterPromote!.subject).toBe(dictionarySubject("nl", "registrationPromoted.subject", { competitionName: d2.competition.name }));
  });

  it("a withdrawal with nobody waiting queues no promotion email", async () => {
    const d = await fullDivision("offline");
    const holderEmail = address("alone");
    const holder = await seedRegistration(d.competition.id, d.division.id, d.settings, { contactEmail: holderEmail });

    await withdrawRegistrationPublic(holder.registration.id, holder.access_token);

    expect(await rowsOfOrg(d.orgId), "no one was promoted, so nothing was queued").toHaveLength(0);
    expect(callsTo(holderEmail)).toHaveLength(0);

    // The positive pair: with someone waiting, the same withdrawal queues the promotion (the zero above is the empty queue).
    const d2 = await fullDivision("offline");
    const q = await seedQueue(d2);
    await withdrawRegistrationPublic(q.holder.registration.id, q.holder.access_token);
    await settledTo(q.waitEmail, 1);
    expect(await rowsOfOrg(d2.orgId)).toHaveLength(1);
  });

  it("a replayed notifyPromoted for the same promotion queues one row", async () => {
    const d = await fullDivision("offline");
    const q = await seedQueue(d);
    const promoted = await sql.begin((tx) => promoteWaitlistedRow(tx, q.waiting.registration.id, q.waiting.registration.group_id, d.settings));
    const row = await loadWithGroup(promoted!.id);
    const ctx = await divisionCtx(sql, d.division.id);

    await notifyPromoted(row, ctx, d.settings, ORIGIN, { firstAttempt: "worker" });
    await notifyPromoted(row, ctx, d.settings, ORIGIN, { firstAttempt: "worker" });

    expect(await rowsTo(q.waitEmail)).toHaveLength(1);
  });

  it("the sweep's promotion is left to the worker", async () => {
    // The overdue holder expires and the waitlisted registrant is promoted by the sweep: no request is waiting on it, so the first
    // attempt is the worker's.
    const d = await fullDivision("stripe", 700);
    const q = await seedQueue(d, "es");
    await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${q.holder.registration.group_id}`;

    const out = await sweepRegistrations(ORIGIN);
    expect(out.promoted, "premise: the sweep promoted someone").toBeGreaterThanOrEqual(1);
    expect((await loadWithGroup(q.waiting.registration.id)).status, "premise: it was the waitlisted registrant").toBe("pending");

    const [row] = await rowsTo(q.waitEmail);
    expect(await rowsTo(q.waitEmail)).toHaveLength(1);
    expect(row).toMatchObject({ status: "queued", attempts: 0, ref_id: q.waiting.registration.id });
    expect(row!.subject).toBe(dictionarySubject("es", "registrationPromoted.subject", { competitionName: d.competition.name }));
    expect(callsTo(q.waitEmail), "the sweep did not call the transport").toHaveLength(0);

    await bornAgo([row!.id]);
    await runOutboxTick({ onlyIds: [row!.id], sleep: async () => undefined });
    expect((await rowsTo(q.waitEmail))[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect(callsFor(row!.id)).toHaveLength(1);
  });

  it("a promoted row with no promoted_at is refused by name, before anything is minted", async () => {
    // Guards a "cannot happen": a promotion always stamps promoted_at, and the once-key is built from it.
    const d = await fullDivision("stripe", 700);
    const q = await seedQueue(d);
    const promoted = await sql.begin((tx) => promoteWaitlistedRow(tx, q.waiting.registration.id, q.waiting.registration.group_id, d.settings));
    const row = await loadWithGroup(promoted!.id);
    const ctx = await divisionCtx(sql, d.division.id);
    const spy = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    stripeMock.checkoutCreate.mockClear();

    await notifyPromoted({ ...row, promoted_at: null }, ctx, d.settings, ORIGIN, { firstAttempt: "worker" });

    expect(await rowsTo(q.waitEmail)).toHaveLength(0);
    expect(stripeMock.checkoutCreate, "refused before the pay link is minted").not.toHaveBeenCalled();
    const logged = spy.mock.calls.map((c) => c[0] as { err?: Error; registrationId?: string });
    expect(logged.some((a) => a.registrationId === row.id && a.err instanceof Error && a.err.message === GUARD), "the refusal is named in the log").toBe(true);

    // The positive pair: the same row with its promoted_at is queued (the zero above is the guard).
    await notifyPromoted(row, ctx, d.settings, ORIGIN, { firstAttempt: "worker" });
    expect(await rowsTo(q.waitEmail)).toHaveLength(1);
  });

  it("after a refund-bearing withdrawal the promotion still queues", async () => {
    // A paid entry withdraws before the refund lock: the registrant is refunded AND the next in line is promoted, each down its own path.
    const d = await fullDivision("stripe", 1000);
    const q = await seedQueue(d, "nl");
    await handleRegistrationCheckoutCompleted(fakeSession(q.holder.registration.id, 1000));

    await withdrawRegistrationPublic(q.holder.registration.id, q.holder.access_token);

    expect(stripeMock.refundCreate, "premise: the withdrawal refunded the holder").toHaveBeenCalledTimes(1);
    const [row] = await settledTo(q.waitEmail, 1);
    expect(row).toMatchObject({ kind: KIND, status: "sent", ref_id: q.waiting.registration.id });
    expect(row!.subject).toBe(dictionarySubject("nl", "registrationPromoted.subject", { competitionName: d.competition.name }));
  });
});
