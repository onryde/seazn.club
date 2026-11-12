// Registration polish wave P2 (walkthrough W1-W4, W7, W10, W11, W13): the lifecycle mails and the copy of the mails that already existed.
// Every mail is judged THROUGH ITS REAL PRODUCER (a usecase, a webhook handler, a sweep), its queued body opened with the outbox's own
// `openBody`. The provider answers 503 for every send, so a row the request path attempted at once is still `queued` and still holds
// its sealed body; Stripe is mocked and the only network.
//
// Sport: not applicable. The mail does not vary by sport; the axes that vary are the payment method, the approval mode and the locale.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const refundCreate = vi.fn();
  const checkoutCreate = vi.fn();
  return {
    refundCreate,
    checkoutCreate,
    stripe: { refunds: { create: refundCreate }, checkout: { sessions: { create: checkoutCreate, retrieve: vi.fn(), expire: vi.fn() } } },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// `registrationApprovedEmail` passes through to the real renderer; a test makes it fail for one recipient to prove the failure stays
// contained to that recipient's own savepoint.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, registrationApprovedEmail: vi.fn(actual.registrationApprovedEmail) };
});

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import * as emailModule from "@/lib/email";
import { openBody } from "@/server/email-outbox/seal";
import { formatDeadline } from "@/lib/email-templates/registration";
import {
  confirmRegistration,
  confirmRegistrationWaived,
  handleRegistrationCheckoutCompleted,
  markRegistrationPaidOffline,
  notifyPromoted,
  notifySubmitted,
  payDeadlineOf,
  promoteWaitlistedRow,
  putRegistrationSettings,
  refundRegistration,
  sendPaymentReminder,
  divisionCtx,
} from "../registrations";
import { queueRegistrationApprovedMails, queueRegistrationPaidMail } from "../registrations/lifecycle-mail";
import { approveRegistration } from "../registration-approval";
import { createDivision } from "../divisions";
import { stubOutboxEnv } from "./_invite-mail";
import { SETTINGS_BASE, asOwner, fakeSession, loadWithGroup, rig, seedOrg, seedRegistration, seedSecondEntry, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://lifecycle-mail.test";
const CONTACT = "Dana Captain";
const TEAM = "Riverside Rovers";

const made = { orgIds: [] as string[], userIds: [] as string[] };

afterAll(async () => {
  if (HAS_DB) {
    await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
    if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
    await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
    await sql`delete from users where id = any(${made.userIds}::uuid[])`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

const later = async () => ({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });

beforeEach(() => {
  stubOutboxEnv();
  deliverMock.mockReset().mockImplementation(later);
  stripeMock.refundCreate.mockReset().mockImplementation(async () => ({ id: `re_${randomUUID().slice(0, 10)}` }));
  stripeMock.checkoutCreate.mockReset();
  // vitest 4: mockReset puts back the implementation given to vi.fn(impl), i.e. the real renderer (the hook above is for one test only).
  vi.mocked(emailModule.registrationApprovedEmail).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Worlds and readers
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (tag: string): string => `p2-${tag}-${randomUUID().slice(0, 8)}@test.local`;

async function stripeWorld(feeCents = 1500) {
  const w = await stripeRig({ feeCents });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  return w;
}

async function offlineWorld(feeCents = 1500, approval: "auto" | "manual" = "auto") {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    fee_cents: feeCents,
    payment_method: "offline",
    payment_instructions: "Pay at the desk, quoting {{reference}}",
    approval,
  });
  return { orgId, orgSlug, ownerId, owner, competition, division, settings };
}

/** A second division in the world's competition, with its own settings. */
async function secondDivision(w: Awaited<ReturnType<typeof offlineWorld>>, name: string, over: Partial<Parameters<typeof putRegistrationSettings>[2]> = {}) {
  const division = await createDivision(w.owner, w.competition.id, {
    name,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const settings = await putRegistrationSettings(w.owner, division.id, { ...SETTINGS_BASE, fee_cents: 0, payment_method: "offline", approval: "auto", ...over });
  return { division, settings };
}

/** The newest body of (kind, ref), opened with the outbox's own reader. A row whose body is gone is a failure here. */
async function body(kind: string, refType: string, refId: string, to?: string): Promise<{ html: string; text: string; subject: string }> {
  const rows = await sql<{ body_sealed: Uint8Array | null; status: string; subject: string }[]>`
    select body_sealed, status, subject from email_outbox
     where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}
       and (${to ?? null}::text is null or lower(recipient) = lower(${to ?? ""}))
     order by created_at desc, id desc limit 1`;
  const row = rows[0];
  expect(row, `a ${kind} row for ${refType}/${refId}`).toBeDefined();
  expect(row!.body_sealed, `the ${kind} row still holds its body (status ${row!.status})`).not.toBeNull();
  return { ...(await openBody(row!.body_sealed!)), subject: row!.subject };
}

const rowCount = async (kind: string, refType: string, refId: string): Promise<number> =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from email_outbox where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}`)[0]!.n);

/** The visible words of an html part. */
const words = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// ---------------------------------------------------------------------------------------------------------------------------------
// Copy of the mails that already existed (W4, W7)
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the confirmation mail of a two-division cart (W4, W7; real notifySubmitted)", () => {
  it("names each entry's division and says what each entry is waiting on (a cart's intro has no greeting)", async () => {
    const w = await offlineWorld(1500, "auto");
    const masters = await secondDivision(w, "Masters", { fee_cents: 0, approval: "manual" });
    const first = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: "Maya Cole", contactEmail: address("cart") });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${first.registration.group_id}`;
    // The second entry rides the SAME cart, in the other division: free, but that division reviews entries by hand.
    await seedSecondEntry(first.registration.group_id, masters.division.id, 0, "Maya Cole", "pending");

    await notifySubmitted(first.registration.group_id, ORIGIN, first.access_token);
    const b = await body("registration_confirmation", "registration_group", first.registration.group_id);

    const lines = b.text.split("\n");
    const openLine = lines.find((l) => l.includes("Open"));
    const mastersLine = lines.find((l) => l.includes("Masters"));
    expect(openLine, "a line for the Open entry").toBeDefined();
    expect(mastersLine, "a line for the Masters entry").toBeDefined();
    expect(openLine).toContain("Awaiting payment");
    expect(mastersLine).toContain("Awaiting approval");
    // The two lines differ ONLY by what the entry is: not a repeated "Maya Cole - Pending".
    expect(openLine).not.toBe(mastersLine);
    expect(b.text).not.toMatch(/—\s*Pending\b/);
  });

  it("a team entry greets the captain, not the team (W4: 'Thanks Riverside Rovers')", async () => {
    const w = await offlineWorld(1500, "auto");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: address("team") });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${reg.registration.group_id}`;
    await notifySubmitted(reg.registration.group_id, ORIGIN, reg.access_token);
    const b = await body("registration_confirmation", "registration_group", reg.registration.group_id);
    const visible = words(b.html);
    expect(visible).toContain(`Thanks ${CONTACT}`);
    expect(visible).not.toContain(`Thanks ${TEAM}`);
    expect(visible.indexOf(TEAM), "the team is still named, after the person").toBeGreaterThan(visible.indexOf(CONTACT));
  });
});

describe.skipIf(!HAS_DB)("the payment reminder (W4; real sendPaymentReminder)", () => {
  it("a card reminder quotes the entry's own deadline and greets the contact", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: address("rem") });
    await sql`update registration_groups set contact_name = ${CONTACT}, expires_at = now() + interval '30 hours' where id = ${reg.registration.group_id}`;
    const fresh = await loadWithGroup(reg.registration.id);
    const out = await sendPaymentReminder(w.owner, reg.registration.id, ORIGIN);
    expect(out.sent, "premise: the provider answered 503, so the mail is queued, not sent").toBe(false);
    const b = await body("payment_reminder", "registration", reg.registration.id);
    expect(b.text).toContain(formatDeadline(fresh.expires_at!));
    expect(words(b.html)).toContain(`Hi ${CONTACT}`);
    expect(words(b.html)).not.toContain(`Hi ${TEAM}`);
  });

  it("a PROMOTED entry's reminder quotes its own window, never the cart's", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("promo-rem") });
    await sql`update registration_groups set expires_at = now() + interval '40 hours' where id = ${reg.registration.group_id}`;
    await sql`update registrations set promoted_at = now(), promotion_expires_at = now() + interval '5 hours' where id = ${reg.registration.id}`;
    const fresh = await loadWithGroup(reg.registration.id);
    await sendPaymentReminder(w.owner, reg.registration.id, ORIGIN);
    const b = await body("payment_reminder", "registration", reg.registration.id);
    expect(b.text).toContain(formatDeadline(fresh.promotion_expires_at!));
    expect(b.text, "the cart's later deadline is not the one quoted").not.toContain(formatDeadline(fresh.expires_at!));
  });

  it("a deadline that has already passed is not quoted (the sweep has not expired the entry yet)", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("past-rem") });
    await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${reg.registration.group_id}`;
    const fresh = await loadWithGroup(reg.registration.id);
    await sendPaymentReminder(w.owner, reg.registration.id, ORIGIN);
    const b = await body("payment_reminder", "registration", reg.registration.id);
    expect(b.text).not.toContain(formatDeadline(fresh.expires_at!));
    expect(b.text, "the undated wording is used").toContain("Your spot is held");
  });
});

describe("payDeadlineOf (no database)", () => {
  const NOW = new Date("2026-11-12T10:00:00Z");
  const H = 3_600_000;
  const cart = new Date(NOW.getTime() + 30 * H);
  const own = new Date(NOW.getTime() + 5 * H);
  it("a never-promoted entry quotes the cart's deadline; a promoted one its own", () => {
    expect(payDeadlineOf({ promoted_at: null, promotion_expires_at: null, expires_at: cart }, NOW)).toEqual(cart);
    expect(payDeadlineOf({ promoted_at: NOW, promotion_expires_at: own, expires_at: cart }, NOW)).toEqual(own);
  });
  it("no deadline, or one in the past, is null", () => {
    expect(payDeadlineOf({ promoted_at: null, promotion_expires_at: null, expires_at: null }, NOW)).toBeNull();
    expect(payDeadlineOf({ promoted_at: null, promotion_expires_at: null, expires_at: new Date(NOW.getTime() - H) }, NOW)).toBeNull();
    expect(payDeadlineOf({ promoted_at: NOW, promotion_expires_at: null, expires_at: cart }, NOW), "a promoted entry never falls back to the cart's clock").toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the promotion and refund mails greet the contact (W4; real notifyPromoted, real refundRegistration)", () => {
  it("the promotion mail", async () => {
    const w = await offlineWorld(1500, "auto");
    const waiting = await seedRegistration(w.competition.id, w.division.id, w.settings, { status: "waitlisted", displayName: TEAM, contactEmail: address("promo") });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${waiting.registration.group_id}`;
    await sql.begin((tx) => promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, w.settings));
    const promoted = await loadWithGroup(waiting.registration.id);
    const ctx = await divisionCtx(sql, w.division.id);
    await notifyPromoted(promoted, ctx, w.settings, ORIGIN, { firstAttempt: "worker" });
    const b = await body("registration_promoted", "registration", waiting.registration.id);
    const visible = words(b.html);
    expect(visible).toContain(`Good news, ${CONTACT}`);
    expect(visible).not.toContain(`Good news, ${TEAM}`);
  });

  it("the refund receipt", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: address("refund") });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${reg.registration.group_id}`;
    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    await refundRegistration(w.owner, reg.registration.id, undefined);
    const [refund] = await sql<{ ref_id: string }[]>`select ref_id from email_outbox where kind = 'refund_issued' and org_id = ${w.orgId}`;
    expect(refund, "premise: the real refund queued its receipt").toBeDefined();
    const b = await body("refund_issued", "refund", refund!.ref_id);
    const visible = words(b.html);
    expect(visible).toContain(`Hi ${CONTACT}`);
    expect(visible).not.toContain(`Hi ${TEAM}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// registration_paid (W1, W3)
// ---------------------------------------------------------------------------------------------------------------------------------

const paidRows = async (regId: string) =>
  sql<{ id: string; status: string; recipient: string; dedupe_key: string | null }[]>`
    select id, status, recipient, dedupe_key from email_outbox where kind = 'registration_paid' and ref_type = 'registration' and ref_id = ${regId} order by created_at, id`;

async function manualStripeWorld(feeCents = 1500) {
  const w = await stripeWorld(feeCents);
  const settings = await putRegistrationSettings(w.owner, w.division.id, { ...SETTINGS_BASE, payment_method: "stripe", fee_cents: feeCents, approval: "manual" });
  return { ...w, settings };
}

describe.skipIf(!HAS_DB)("payment received: the card webhook (real handleRegistrationCheckoutCompleted)", () => {
  it("auto approval: one mail, THIS entry's amount, the division, 'you're confirmed', addressed to the contact in their language", async () => {
    const w = await stripeWorld(1500);
    const contact = address("paid");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: contact, locale: "es", refCode: `P2-${randomUUID().slice(0, 6)}` });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${reg.registration.group_id}`;

    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));

    expect((await loadWithGroup(reg.registration.id)).status, "premise: the real handler confirmed the entry").toBe("confirmed");
    const rows = await paidRows(reg.registration.id);
    expect(rows.map((r) => [r.status, r.recipient.toLowerCase()]), "exactly one row, to the contact, still queued (a webhook leaves the attempt to the worker)").toEqual([["queued", contact]]);
    const b = await body("registration_paid", "registration", reg.registration.id, contact);
    expect(b.subject).toContain("Pago recibido");
    expect(b.text).toContain("15.00");
    expect(b.text).toContain("Open");
    expect(b.text, "the es confirmed wording").toContain("Tu plaza está confirmada");
    expect(words(b.html)).toContain(`Hola ${CONTACT}`);
    expect(words(b.html)).not.toContain(`Hola ${TEAM}`);
    expect(reg.registration.ref_code, "premise: the entry has a reference").not.toBeNull();
    expect(b.text, "the token-less status page of the entry (a webhook has no request origin: the configured one)").toContain(`/r/${reg.registration.ref_code}`);
  });

  it("MANUAL approval: the entry is paid and waiting, so the mail says awaiting approval and never 'confirmed'", async () => {
    const w = await manualStripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("paid-manual") });

    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));

    expect((await loadWithGroup(reg.registration.id)).status, "premise: manual approval leaves the entry at paid").toBe("paid");
    const b = await body("registration_paid", "registration", reg.registration.id);
    expect(b.text).toContain("Awaiting organiser approval");
    expect(b.text).not.toContain("You're confirmed");
    expect(b.text).toContain("15.00");
  });

  it("a replayed webhook, and a different payment for the SAME entry, queue nothing more (the second call and the duplicate)", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("paid-twice") });
    const session = fakeSession(reg.registration.id, 1500);
    await handleRegistrationCheckoutCompleted(session);
    await handleRegistrationCheckoutCompleted(session);
    expect(await paidRows(reg.registration.id), "the replay of the same session").toHaveLength(1);

    // A second tab pays with ANOTHER intent: the duplicate branch refunds it; the entry was paid once, so it is mailed once.
    await handleRegistrationCheckoutCompleted({ ...session, id: "cs_test_dup", payment_intent: "pi_test_dup" } as typeof session);
    expect(stripeMock.refundCreate, "premise: the duplicate was refunded").toHaveBeenCalledTimes(1);
    expect(await paidRows(reg.registration.id), "a duplicate payment is not a second 'payment received'").toHaveLength(1);
  });

  it("a payment that lands on a withdrawn entry is refunded, not reported as received", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("paid-late"), status: "withdrawn" });
    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    expect(await paidRows(reg.registration.id)).toHaveLength(0);
  });

  it("a mail that cannot be queued never undoes the payment (contained at its own savepoint)", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("paid-fail") });
    // An empty recipient is refused by the outbox's own CHECK: the INSERT throws inside the producer's savepoint.
    await sql`update registration_groups set contact_email = '' where id = ${reg.registration.group_id}`;
    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    expect((await loadWithGroup(reg.registration.id)).status, "the payment stands").toBe("confirmed");
    expect(await paidRows(reg.registration.id), "and no half-written mail is left").toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("payment received: the organiser marks an offline payment (real markRegistrationPaidOffline)", () => {
  it("one mail, in the transaction of the mark, with this entry's amount; marking twice is refused and mails nothing more", async () => {
    const w = await offlineWorld(1500, "auto");
    const contact = address("offline");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: contact });
    const row = await markRegistrationPaidOffline(w.owner, reg.registration.id);
    expect(row.status).toBe("confirmed");
    const rows = await paidRows(reg.registration.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupe_key, "keyed by the registration and the mark's own timestamp").toMatch(new RegExp(`^${reg.registration.id}:offline:`));
    const b = await body("registration_paid", "registration", reg.registration.id, contact);
    expect(b.text).toContain("15.00");
    expect(b.text).toContain("You're confirmed");

    await expect(markRegistrationPaidOffline(w.owner, reg.registration.id)).rejects.toThrow(/Only pending/);
    expect(await paidRows(reg.registration.id), "the refused second mark queued nothing").toHaveLength(1);
  });

  it("a cart of two entries: marking one paid mails ITS amount, not the cart's total", async () => {
    const w = await offlineWorld(1500, "auto");
    const second = await secondDivision(w, "Masters", { fee_cents: 900 });
    const first = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("cart-paid") });
    const sibling = await seedSecondEntry(first.registration.group_id, second.division.id, 900, "Maya Cole", "pending");
    await markRegistrationPaidOffline(w.owner, sibling.id);
    const b = await body("registration_paid", "registration", sibling.id);
    expect(b.text).toContain("9.00");
    expect(b.text, "not the whole cart's 24.00, not the other entry's 15.00").not.toMatch(/24\.00|15\.00/);
    expect(await paidRows(first.registration.id), "the unpaid sibling is not mailed").toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("queueRegistrationPaidMail's own guards", () => {
  it("an entry with no fee has no payment to report (the empty case): nothing is queued", async () => {
    const w = await offlineWorld(0, "auto");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("free") });
    expect(reg.registration.amount_cents, "premise: a free entry").toBe(0);
    const id = await sql.begin((tx) => queueRegistrationPaidMail(tx, { reg: reg.registration, confirmed: true, paymentRef: "pi_free" }));
    expect(id).toBeNull();
    expect(await paidRows(reg.registration.id)).toHaveLength(0);
  });

  it("once per payment ref: the same ref queues nothing; a LATER payment of the same entry replaces the unsent first", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("keyed") });
    const queue = (ref: string) => sql.begin((tx) => queueRegistrationPaidMail(tx, { reg: reg.registration, confirmed: true, paymentRef: ref, origin: ORIGIN }));
    const first = await queue("pi_a");
    expect(first).not.toBeNull();
    expect(await queue("pi_a"), "the same payment").toBeNull();
    expect(await paidRows(reg.registration.id)).toHaveLength(1);
    const second = await queue("pi_b");
    expect(second, "a different payment").not.toBeNull();
    const rows = await paidRows(reg.registration.id);
    expect(rows.map((r) => r.status), "the unsent first is superseded, the newer is queued").toEqual(["replaced", "queued"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// registration_approved (W2, W13)
// ---------------------------------------------------------------------------------------------------------------------------------

const approvedRows = async (regId: string) =>
  sql<{ id: string; recipient: string; status: string }[]>`
    select id, recipient, status from email_outbox where kind = 'registration_approved' and ref_type = 'registration' and ref_id = ${regId} order by recipient`;

/** A teammate row on an entry: joined (consented) or merely typed in by the captain. */
async function addMate(regId: string, orgId: string, over: { name: string; email: string | null; consent?: "granted" | "guardian" | "pending"; source?: string }) {
  await sql`
    insert into registration_players (registration_id, org_id, full_name, email, source, consent_status)
    values (${regId}, ${orgId}, ${over.name}, ${over.email}, ${over.source ?? "self_joined"}, ${over.consent ?? "granted"})`;
}

describe.skipIf(!HAS_DB)("approved: the organiser approves (real approveRegistration)", () => {
  it("a manual-approval entry that has PAID: the contact is told, in their language, by name; a second Approve mails nothing more", async () => {
    const w = await manualStripeWorld(1500);
    const contact = address("appr");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: contact, locale: "fr", refCode: `P2-${randomUUID().slice(0, 6)}` });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${reg.registration.group_id}`;
    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    expect((await loadWithGroup(reg.registration.id)).status, "premise: paid and waiting for the organiser").toBe("paid");
    expect(await approvedRows(reg.registration.id), "nothing is approved yet").toHaveLength(0);

    const row = await approveRegistration(w.owner, reg.registration.id);
    expect(row.status).toBe("confirmed");

    const rows = await approvedRows(reg.registration.id);
    expect(rows.map((r) => r.recipient.toLowerCase())).toEqual([contact]);
    const b = await body("registration_approved", "registration", reg.registration.id, contact);
    expect(b.subject, "the contact's fr language").toContain("Votre place est confirmée");
    expect(words(b.html)).toContain(`Bonjour ${CONTACT}`);
    expect(b.text).toContain("Open");
    expect(b.text).toContain(`${reg.registration.ref_code}`);

    // The second call: idempotent success, and no second mail.
    await approveRegistration(w.owner, reg.registration.id);
    expect(await approvedRows(reg.registration.id)).toHaveLength(1);
  });

  it("every teammate who has JOINED and left an address is told too, in the club's language, greeted by their own name - the contact once, the unconsented and the address-less not at all", async () => {
    const w = await offlineWorld(0, "manual");
    await sql`update organizations set default_locale = 'nl' where id = ${w.orgId}`;
    const contact = address("appr-c");
    const joiner = address("appr-j");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: contact, locale: "es", refCode: `P2-${randomUUID().slice(0, 6)}` });
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner", email: joiner });
    await addMate(reg.registration.id, w.orgId, { name: "Dana Captain Again", email: contact.toUpperCase() });
    await addMate(reg.registration.id, w.orgId, { name: "Typed In", email: address("appr-t"), consent: "pending", source: "captain_entered" });
    await addMate(reg.registration.id, w.orgId, { name: "No Address", email: null });
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner Twice", email: joiner.toUpperCase() });

    await approveRegistration(w.owner, reg.registration.id);

    const rows = await approvedRows(reg.registration.id);
    expect(rows.map((r) => r.recipient.toLowerCase()).sort(), "the contact once and the one joiner once").toEqual([contact, joiner].sort());
    const toContact = await body("registration_approved", "registration", reg.registration.id, contact);
    const toJoiner = await body("registration_approved", "registration", reg.registration.id, joiner);
    expect(toContact.subject, "the contact's own es pick").toContain("Tu plaza está confirmada");
    expect(toJoiner.subject, "a teammate follows the club's default (nl), never the contact's pick").toContain("Je bent bevestigd");
    expect(words(toJoiner.html)).toContain("Joe Joiner");
    expect(toJoiner.text, "a teammate is not given the contact's reference").not.toContain(reg.registration.ref_code!);
    expect(toContact.text).toContain(reg.registration.ref_code!);
  });

  it("one teammate's mail failing to render never costs the contact theirs, or the approval", async () => {
    const w = await offlineWorld(0, "manual");
    const contact = address("appr-iso-c");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: contact });
    await addMate(reg.registration.id, w.orgId, { name: "Boom Player", email: address("appr-iso-j") });
    const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
    vi.mocked(emailModule.registrationApprovedEmail).mockImplementation(async (args, locale) => {
      if (args.recipientName === "Boom Player") throw new Error("render fault");
      return actual.registrationApprovedEmail(args, locale);
    });

    const row = await approveRegistration(w.owner, reg.registration.id);

    expect(row.status, "the approval stands").toBe("confirmed");
    expect((await approvedRows(reg.registration.id)).map((r) => r.recipient.toLowerCase()), "the contact still has theirs").toEqual([contact]);
  });
});

describe.skipIf(!HAS_DB)("approved: the other two organiser doors (real confirmRegistration, real confirmRegistrationWaived)", () => {
  it("Confirm on a waitlisted entry (the capacity override) tells the registrant", async () => {
    const w = await offlineWorld(0, "auto");
    const contact = address("conf");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: contact, status: "waitlisted" });
    const row = await confirmRegistration(w.owner, reg.registration.id);
    expect(row.status).toBe("confirmed");
    expect((await approvedRows(reg.registration.id)).map((r) => r.recipient.toLowerCase())).toEqual([contact]);
    await confirmRegistration(w.owner, reg.registration.id);
    expect(await approvedRows(reg.registration.id), "a second Confirm is a no-op").toHaveLength(1);
  });

  it("Confirm-and-waive on an unpaid fee-bearing entry tells the registrant", async () => {
    const w = await offlineWorld(1500, "auto");
    const contact = address("waive");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: contact });
    const row = await confirmRegistrationWaived(w.owner, reg.registration.id);
    expect(row.status).toBe("confirmed");
    expect((await approvedRows(reg.registration.id)).map((r) => r.recipient.toLowerCase())).toEqual([contact]);
    await confirmRegistrationWaived(w.owner, reg.registration.id);
    expect(await approvedRows(reg.registration.id), "a second waive is a no-op").toHaveLength(1);
  });

  it("an Approve that is refused (the entry is rejected, or never paid) mails nothing", async () => {
    const w = await offlineWorld(1500, "manual");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("refused") });
    await expect(approveRegistration(w.owner, reg.registration.id), "an unpaid entry cannot be approved").rejects.toThrow(/Awaiting payment/);
    expect(await approvedRows(reg.registration.id)).toHaveLength(0);
  });

  it("mark-paid on a cart sends the PAYMENT mail only, not an approval as well (one fact, one mail)", async () => {
    const w = await offlineWorld(1500, "auto");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("one-fact") });
    await markRegistrationPaidOffline(w.owner, reg.registration.id);
    expect(await paidRows(reg.registration.id)).toHaveLength(1);
    expect(await approvedRows(reg.registration.id)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("queueRegistrationApprovedMails' own guard", () => {
  it("an entry that is NOT confirmed after the write is not told it is (the day Approve and Mark paid are split)", async () => {
    const w = await offlineWorld(1500, "manual");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("not-confirmed"), status: "paid" });
    expect(reg.registration.status, "premise: a paid entry the organiser has not approved").toBe("paid");
    const ids = await sql.begin((tx) => queueRegistrationApprovedMails(tx, { reg: reg.registration }));
    expect(ids).toEqual([]);
    expect(await approvedRows(reg.registration.id)).toHaveLength(0);
  });
});
