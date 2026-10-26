// Phase 3 wave 1, Task 9: the payment reminder goes through the email outbox (kind `payment_reminder`, ref `registration/<reg id>`).
// Producers under test, each driven through its REAL entry point:
//   - `sweepRegistrations` pass 1a (a stripe cart's reminder, once-key `<reg id>:submit`) and pass 1b (a promoted entry's reminder, once-key
//     `<reg id>:promotion:<promoted_at>`): the sweep claims, mints ONE Checkout session, then queues the row and stamps the entry's
//     `*_reminded_at` in one transaction. The first attempt is the worker's, not the sweep's.
//   - the organiser's manual reminder (`sendPaymentReminder`): row and audit entry in one tenant transaction, then the first attempt at once.
// Only the network seams are replaced (Stripe, and `@/server/email-outbox/transport`). Rows, claim, retry and replace rule are the real ones.
//
// F8 is the defect this kind exists to close: a reminder whose send failed released its lease and the next sweep minted a NEW Checkout
// session for the same entry, once per sweep. Now a send failure is the outbox's retry, and the sweep mints once.
//
// Sport: not applicable. The reminder does not vary by sport (spec, Test strategy 4); the locale is the axis that varies.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  return { checkoutCreate, stripe: { checkout: { sessions: { create: checkoutCreate } } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// The one network seam. The kind harness reads this same mock back (it imports `deliver` from the same module).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The manual reminder's audit write fails once, armed immediately before the call under test.
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
import type { Locale } from "@/lib/i18n-constants";
import { HttpError } from "@/lib/errors";
import {
  promoteWaitlistedRow,
  putRegistrationSettings,
  sendPaymentReminder,
  sweepRegistrations,
  withdrawRegistrationOrganiser,
} from "../registrations";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { assertNothingMoreToSend, bornAgo, dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";
import { SETTINGS_BASE, asOwner, rig, seedOrg, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://test.local";
const KIND = "payment_reminder" as const;

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

const ok = async () => ({ ok: true, providerId: `re_t9_${randomUUID()}` });
const later = async () => ({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });

beforeEach(() => {
  stubOutboxEnv();
  auditGate.failOnce = false;
  deliverMock.mockReset();
  deliverMock.mockImplementation(ok);
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: `cs_t9_${randomUUID().slice(0, 8)}`,
    url: "https://checkout.stripe.test/session",
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (tag: string): string => `t9-${tag}-${randomUUID().slice(0, 8)}@test.local`;

/** A stripe-paid division (the sweep's reminders are for stripe carts). Tracks its org for cleanup. */
async function stripeWorld(feeCents = 500) {
  const w = await stripeRig({ feeCents });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  return w;
}

/** An offline-paid division with a fee (the manual reminder's case: it nudges an unpaid offline registrant). */
async function offlineWorld(fee = 1500) {
  const { orgId, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: fee, payment_method: "offline", payment_instructions: "Pay at the desk" });
  return { orgId, owner, competition, division, settings };
}

/** Pull a stripe cart's deadline into the reminder sweep's T-24h window. */
const dueSoon = (groupId: string) => sql`update registration_groups set expires_at = now() + interval '10 hours' where id = ${groupId}`;

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
  last_error: string | null;
  transactional: boolean;
  dedupe_key: string | null;
  expires_at: Date;
};

/** The reminder rows addressed to one address, oldest first. */
const rowsTo = (email: string) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, subject, status, attempts, last_error, transactional, dedupe_key, expires_at
      from email_outbox
     where kind = ${KIND} and lower(recipient) = lower(${email})
     order by created_at, id`;

/** Every outbox row of any kind addressed to this address (the proof that nothing was queued at all). */
const anyRowTo = (email: string) => sql<{ id: string }[]>`select id from email_outbox where lower(recipient) = lower(${email})`;

type Sent = { to: string; subject: string; html: string; text: string; idempotencyKey: string };
const callsTo = (email: string): Sent[] =>
  deliverMock.mock.calls.map((c) => c[0] as Sent).filter((c) => c.to.toLowerCase() === email.toLowerCase());
const callsFor = (id: string): Sent[] => deliverMock.mock.calls.map((c) => c[0] as Sent).filter((c) => c.idempotencyKey === idempotencyKey(id));

/** How many Checkout sessions were minted for this entry (the session's metadata names its entries). */
const mintsFor = (regId: string): number =>
  stripeMock.checkoutCreate.mock.calls.filter(([args]) =>
    (args as { metadata?: { registration_ids?: string } })?.metadata?.registration_ids?.split(",").includes(regId),
  ).length;

const marks = async (regId: string) => {
  const [r] = await sql<{ submit_reminded_at: Date | null; submit_reminder_claimed_at: Date | null; promotion_reminded_at: Date | null; promotion_reminder_claimed_at: Date | null }[]>`
    select submit_reminded_at, submit_reminder_claimed_at, promotion_reminded_at, promotion_reminder_claimed_at from registrations where id = ${regId}`;
  return r!;
};

/** Make the retry due and run the worker over these rows, as the next tick would. */
async function tickNow(ids: string[]): Promise<void> {
  await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = any(${ids}::uuid[])`;
  await runOutboxTick({ onlyIds: ids, sleep: async () => undefined });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The sweep's reminders (F8)
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the sweep's payment reminders ride the outbox (DB)", () => {
  it("F8: a due reminder gives one row and one Checkout session; nothing is released", async () => {
    const w = await stripeWorld();
    const email = address("f8");
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email, locale: "fr" });
    await dueSoon(registration.group_id);

    const first = await sweepRegistrations(ORIGIN);
    expect(first.reminded, "the sweep counted a reminder").toBeGreaterThanOrEqual(1);
    const [row] = await rowsTo(email);
    expect(await rowsTo(email)).toHaveLength(1);
    expect(row).toMatchObject({
      kind: KIND,
      ref_type: "registration",
      ref_id: registration.id,
      org_id: w.orgId,
      recipient: email,
      transactional: false,
      dedupe_key: `${registration.id}:submit`,
      status: "queued",
      attempts: 0,
    });
    expect(row!.subject).toBe(dictionarySubject("fr", "paymentReminder.subject", { competitionName: w.competition.name }));
    expect(callsTo(email), "the sweep leaves the first attempt to the worker: the transport was not called").toHaveLength(0);
    expect(mintsFor(registration.id), "one Checkout session").toBe(1);
    const m1 = await marks(registration.id);
    expect(m1.submit_reminded_at, "the entry's mark was stamped in the same commit as the row").not.toBeNull();

    // A second sweep: nothing more is queued and nothing more is minted.
    await sweepRegistrations(ORIGIN);
    expect(await rowsTo(email)).toHaveLength(1);
    expect(mintsFor(registration.id)).toBe(1);

    // The worker owns the first attempt once the request window is past. The provider answers 503: the row stays queued, attempt 1.
    deliverMock.mockReset().mockImplementation(later);
    await bornAgo([row!.id]);
    await runOutboxTick({ onlyIds: [row!.id], sleep: async () => undefined });
    const [retrying] = await rowsTo(email);
    expect(retrying).toMatchObject({ status: "queued", attempts: 1 });
    expect(retrying!.last_error).toMatch(/503/);
    expect(callsFor(row!.id)).toHaveLength(1);
    expect(mintsFor(registration.id), "a failed send mints nothing more").toBe(1);
    expect((await marks(registration.id)).submit_reminded_at, "and the mark stays set").not.toBeNull();

    // A later tick, the provider back: sent, under the SAME key.
    deliverMock.mockReset().mockImplementation(ok);
    await tickNow([row!.id]);
    const [after] = await rowsTo(email);
    expect(after).toMatchObject({ status: "sent", attempts: 2 });
    expect(callsFor(row!.id)).toHaveLength(1);
    expect(callsFor(row!.id)[0]!.subject).toBe(row!.subject);

    // The second call: a sweep, the request path and a tick over a sent row change nothing.
    await sweepRegistrations(ORIGIN);
    expect(await rowsTo(email)).toHaveLength(1);
    expect(mintsFor(registration.id)).toBe(1);
    await assertNothingMoreToSend(KIND, [row!.id]);
  });

  it("a promoted entry's reminder is queued by pass 1b under its own once-key, and a re-promoted entry gets its second-cycle reminder", async () => {
    // Review Focus 2: the once-key embeds the promotion's own `promoted_at`, so a second promotion of the same entry is a new key
    // (the right answer is not the first cycle's constant).
    const w = await stripeWorld();
    const email = address("repromo");
    const waiting = await seedRegistration(w.competition.id, w.division.id, w.settings, { status: "waitlisted", contactEmail: email, locale: "es" });
    const regId = waiting.registration.id;
    const promoteAndDue = async () => {
      const promoted = await sql.begin((tx) => promoteWaitlistedRow(tx, regId, waiting.registration.group_id, w.settings));
      expect(promoted!.promoted_at, "premise: the promotion stamped promoted_at").not.toBeNull();
      await sql`update registrations set promotion_expires_at = now() + interval '10 hours' where id = ${regId}`;
      return promoted!.promoted_at!;
    };

    const firstAt = await promoteAndDue();
    await sweepRegistrations(ORIGIN);
    const afterFirst = await rowsTo(email);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ ref_type: "registration", ref_id: regId, status: "queued", attempts: 0, dedupe_key: `${regId}:promotion:${firstAt.toISOString()}` });
    expect(afterFirst[0]!.subject).toBe(dictionarySubject("es", "paymentReminder.subject", { competitionName: w.competition.name }));
    expect(mintsFor(regId)).toBe(1);

    // The entry lapses back to the waitlist and is promoted again: a new window, a new promoted_at.
    await sql`update registrations set status = 'waitlisted' where id = ${regId}`;
    const secondAt = await promoteAndDue();
    expect(secondAt.getTime(), "premise: a second promotion is a later instant").toBeGreaterThan(firstAt.getTime());
    await sweepRegistrations(ORIGIN);

    const rows = await rowsTo(email);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`${regId}:promotion:${firstAt.toISOString()}`, `${regId}:promotion:${secondAt.toISOString()}`]);
    expect(new Set(rows.map((r) => r.dedupe_key)).size, "two distinct once-keys").toBe(2);
    expect(rows.map((r) => r.status), "the newer reminder carries the newer Checkout link, so it supersedes the unsent older one").toEqual(["replaced", "queued"]);
    expect(mintsFor(regId), "one Checkout session per cycle").toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. The organiser's manual reminder
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the organiser's manual payment reminder rides the outbox (DB)", () => {
  it("reports sent and records its audit entry in the same transaction; a second press is a second mail that supersedes the first", async () => {
    const w = await offlineWorld();
    const email = address("manual");
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email, locale: "nl" });
    const audited = () =>
      sql`select 1 from competition_events where type = 'registration.payment_reminded' and org_id = ${w.orgId} and payload->>'registration_id' = ${registration.id}`;

    expect(await sendPaymentReminder(w.owner, registration.id)).toEqual({ sent: true });
    const [row] = await rowsTo(email);
    expect(await rowsTo(email)).toHaveLength(1);
    expect(row).toMatchObject({
      kind: KIND,
      ref_type: "registration",
      ref_id: registration.id,
      org_id: w.orgId,
      recipient: email,
      transactional: false,
      dedupe_key: null,
      status: "sent",
    });
    expect(row!.subject).toBe(dictionarySubject("nl", "paymentReminder.subject", { competitionName: w.competition.name }));
    expect(callsFor(row!.id)).toHaveLength(1);
    expect(await audited(), "the audit entry was written with the row").toHaveLength(1);

    // The second press: a deliberate second mail. The first has been sent, so the trigger marks it replaced and both went out.
    expect(await sendPaymentReminder(w.owner, registration.id)).toEqual({ sent: true });
    const rows = await rowsTo(email);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["replaced", "sent"]);
    expect(callsTo(email), "each press is one mail").toHaveLength(2);
    expect(await audited()).toHaveLength(2);
    await assertNothingMoreToSend(KIND, rows.map((r) => r.id));
  });

  it("reports sent:false while the outbox retries, and the worker sends it later", async () => {
    const w = await offlineWorld();
    const email = address("manual503");
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email });
    deliverMock.mockReset().mockImplementation(later);

    expect(await sendPaymentReminder(w.owner, registration.id)).toEqual({ sent: false });
    const [row] = await rowsTo(email);
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row!.last_error).toMatch(/503/);

    deliverMock.mockReset().mockImplementation(ok);
    await tickNow([row!.id]);
    expect((await rowsTo(email))[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("rollback: a reminder whose audit fails queues nothing", async () => {
    const w = await offlineWorld();
    const email = address("rb");
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email });
    auditGate.failOnce = true;

    await expect(sendPaymentReminder(w.owner, registration.id)).rejects.toThrow(/audit is down/);
    expect(auditGate.failOnce, "premise: the audit write was reached and refused").toBe(false);
    expect(await rowsTo(email), "the enqueue rolled back with the audit").toHaveLength(0);
    expect(callsTo(email)).toHaveLength(0);

    // The positive pair: the next press (audit healthy) queues and sends.
    expect(await sendPaymentReminder(w.owner, registration.id)).toEqual({ sent: true });
    expect(await rowsTo(email)).toHaveLength(1);
  });

  it("empty input: a division with no fee is refused with a 422 and queues nothing", async () => {
    const w = await offlineWorld(0);
    const email = address("nofee");
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email });

    const err = await sendPaymentReminder(w.owner, registration.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect(await anyRowTo(email)).toHaveLength(0);
    expect(callsTo(email)).toHaveLength(0);

    // The positive pair: the same entry, once the division has a fee, is reminded (so the zero above is the refusal).
    await putRegistrationSettings(w.owner, w.division.id, { ...SETTINGS_BASE, fee_cents: 1500, payment_method: "offline" });
    expect(await sendPaymentReminder(w.owner, registration.id)).toEqual({ sent: true });
    expect(await rowsTo(email)).toHaveLength(1);
  });

  it("after withdrawal: a withdrawn entry is refused and queues nothing", async () => {
    const w = await offlineWorld();
    const gone = address("gone");
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: gone });
    await withdrawRegistrationOrganiser(w.owner, registration.id);

    const err = await sendPaymentReminder(w.owner, registration.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect(await rowsTo(gone)).toHaveLength(0);
    expect(callsTo(gone)).toHaveLength(0);

    // The positive pair: a live entry of the same division is reminded.
    const live = address("live");
    const other = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: live });
    expect(await sendPaymentReminder(w.owner, other.registration.id)).toEqual({ sent: true });
    expect(await rowsTo(live)).toHaveLength(1);
  });

  it("the reminder is in the registrant's locale: the pick, then the organisation's default", async () => {
    const w = await offlineWorld();
    await sql`update organizations set default_locale = 'nl' where id = ${w.orgId}`;
    let checked = 0;
    const cases: { tag: string; pick: Locale | null; expected: Locale }[] = [
      { tag: "fr", pick: "fr", expected: "fr" },
      { tag: "default", pick: null, expected: "nl" },
    ];
    for (const c of cases) {
      const email = address(`loc-${c.tag}`);
      const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: email, locale: c.pick });
      await sendPaymentReminder(w.owner, registration.id);
      const [row] = await rowsTo(email);
      const subject = dictionarySubject(c.expected, "paymentReminder.subject", { competitionName: w.competition.name });
      expect(subject, `${c.tag}: the expected subject is not the English one`).not.toBe(dictionarySubject("en", "paymentReminder.subject", { competitionName: w.competition.name }));
      expect(row!.subject, c.tag).toBe(subject);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both cases were driven").toBe(cases.length);
  });
});
