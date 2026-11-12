// Registration polish wave P2 (walkthrough W1-W4, W7, W10, W11, W13): the lifecycle mails and the copy of the mails that already existed.
// Every mail is judged THROUGH ITS REAL PRODUCER (a usecase, a webhook handler, a sweep), its queued body opened with the outbox's own
// `openBody`. The provider answers 503 for every send, so a row the request path attempted at once is still `queued` and still holds
// its sealed body; Stripe is mocked and the only network.
//
// Sport: not applicable. The mail does not vary by sport; the axes that vary are the payment method, the approval mode and the locale.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { formatMoneyExact } from "@/lib/currency";

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

// `registrationApprovedEmail`, `registrationWithdrawnEmail`, `registrationExpiredEmail` and `registrationJoinedEmail` pass through to the real renderer; a test makes one fail to prove the
// failure stays contained to that mail's own savepoint (the approval / the withdrawal stands).
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, registrationApprovedEmail: vi.fn(actual.registrationApprovedEmail), registrationWithdrawnEmail: vi.fn(actual.registrationWithdrawnEmail), registrationExpiredEmail: vi.fn(actual.registrationExpiredEmail), registrationJoinedEmail: vi.fn(actual.registrationJoinedEmail) };
});

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { log } from "@/server/logger";
import * as emailModule from "@/lib/email";
import { generateRefCode } from "@/lib/ref-code";
import type { AuthCtx } from "@/server/api-v1/auth";
import { openBody } from "@/server/email-outbox/seal";
import { formatDeadline } from "@/lib/email-templates/registration";
import { entryWaitingOn } from "@/lib/registration-status";
import {
  confirmRegistration,
  confirmRegistrationWaived,
  groupById,
  handleRegistrationCheckoutCompleted,
  markRegistrationPaidOffline,
  notifyPromoted,
  notifySubmitted,
  payDeadlineOf,
  promoteWaitlistedRow,
  putRegistrationSettings,
  refundRegistration,
  sendPaymentReminder,
  sweepRegistrations,
  divisionCtx,
  withdrawRegistrationByRef,
  withdrawRegistrationOrganiser,
  withdrawRegistrationPublic,
} from "../registrations";
import {
  queueRegistrationApprovedMails,
  queueRegistrationExpiredMails,
  queueRegistrationJoinedMail,
  queueRegistrationPaidMail,
  queueRegistrationPromotionLapsedMails,
  queueRegistrationRejectedMails,
  queueRegistrationWithdrawnMails,
} from "../registrations/lifecycle-mail";
import { joinTeamEntry } from "../registration-submit";
import type { RegistrationRow } from "../registrations";
import { approveRegistration, rejectRegistration } from "../registration-approval";
import { createDivision } from "../divisions";
import { stubOutboxEnv } from "./_invite-mail";
import { SETTINGS_BASE, asOwner, fakeSession, loadWithGroup, makeUser, rig, seedOrg, seedRegistration, seedSecondEntry, stripeRig } from "./_registration-fixtures";

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
  vi.mocked(emailModule.registrationWithdrawnEmail).mockReset();
  vi.mocked(emailModule.registrationExpiredEmail).mockReset();
  vi.mocked(emailModule.registrationJoinedEmail).mockReset();
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
    // The contact's mail is Spanish, so the amount is written as the Spanish page writes it ("15,00 £"): P4 moved mail money off a fixed
    // en-GB spelling onto the recipient's language. Expected from the page's own formatter, not from the mail under test.
    expect(b.text).toContain(formatMoneyExact(1500, "gbp", "es"));
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

/** A STRIPE cart of two entries in two divisions: "Open" (1500, auto approval) and "Masters" (900, manual approval), one contact. */
async function stripeCart(over: { secondStatus?: RegistrationRow["status"]; locale?: string | null } = {}) {
  const w = await stripeWorld(1500);
  const masters = await secondDivision(w as unknown as Parameters<typeof secondDivision>[0], "Masters", { fee_cents: 900, payment_method: "stripe", approval: "manual" });
  const to = address("cart");
  const first = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: to, locale: over.locale ?? null, refCode: generateRefCode() });
  await sql`update registration_groups set contact_name = ${CONTACT} where id = ${first.registration.group_id}`;
  const second = await seedSecondEntry(first.registration.group_id, masters.division.id, 900, "Maya Cole", over.secondStatus ?? "pending");
  const session = fakeSession([first.registration.id, second.id], 2400);
  const cartRows = () =>
    sql<{ id: string; recipient: string; ref_id: string; status: string }[]>`
      select id, recipient, ref_id, status from email_outbox where kind = 'registration_paid' and org_id = ${w.orgId} order by created_at, id`;
  return { w, to, first: first.registration, secondId: second.id, session, cartRows };
}

describe.skipIf(!HAS_DB)("payment received: ONE cart-shaped mail when one card payment covers several entries (fix round 1, real webhook)", () => {
  it("a two-entry cart paid in one session sends ONE mail listing each entry with its own amount and standing, and a replay sends none", async () => {
    const c = await stripeCart();
    await handleRegistrationCheckoutCompleted(c.session);
    expect((await loadWithGroup(c.first.id)).status, "premise: the auto-approval entry is confirmed").toBe("confirmed");
    expect(await statusOf(c.secondId), "premise: the manual-approval entry is paid and waiting").toBe("paid");

    const rows = await c.cartRows();
    expect(rows.map((r) => [r.recipient.toLowerCase(), r.status]), "ONE mail for the cart, to the contact").toEqual([[c.to, "queued"]]);
    expect(rows[0]!.ref_id, "referenced by the cart's first entry").toBe(c.first.id);
    const b = await body("registration_paid", "registration", c.first.id);
    expect(words(b.html)).toContain(`Hi ${CONTACT}`);
    const lines = b.text.split("\n");
    const openLine = lines.find((l) => l.includes(TEAM))!;
    const mastersLine = lines.find((l) => l.includes("Maya Cole"))!;
    expect(openLine, "a line for the Open entry").toBeDefined();
    expect(mastersLine, "a line for the Masters entry").toBeDefined();
    expect(openLine).toContain("Open");
    expect(openLine).toContain("15.00");
    expect(openLine, "its own standing").toContain("confirmed");
    expect(mastersLine).toContain("Masters");
    expect(mastersLine).toContain("9.00");
    expect(mastersLine, "its own standing, never 'confirmed'").toContain("awaiting organiser approval");
    expect(mastersLine).not.toContain("confirmed");
    expect(b.text, "the total of the payment").toContain("24.00");
    expect(b.text, "the mixed cart claims neither all-confirmed nor all-waiting").not.toContain("Your places are confirmed");

    await handleRegistrationCheckoutCompleted(c.session);
    expect(await c.cartRows(), "the replay of the same session").toHaveLength(1);
  });

  it("only what THIS payment paid is listed: a withdrawn sibling is refunded and left off, and one paid entry reads as the single-entry mail", async () => {
    const c = await stripeCart({ secondStatus: "withdrawn" });
    await handleRegistrationCheckoutCompleted(c.session);
    expect(stripeMock.refundCreate, "premise: the late payment for the withdrawn sibling was refunded").toHaveBeenCalledTimes(1);
    const rows = await c.cartRows();
    expect(rows).toHaveLength(1);
    const b = await body("registration_paid", "registration", c.first.id);
    expect(b.text).toContain("15.00");
    expect(b.text).not.toContain("Maya Cole");
    expect(b.text).not.toContain("Total paid");
  });

  it("a duplicate payment of the cart (another tab, another intent) is refunded and mails nothing more", async () => {
    const c = await stripeCart();
    await handleRegistrationCheckoutCompleted(c.session);
    await handleRegistrationCheckoutCompleted({ ...c.session, id: "cs_test_dupcart", payment_intent: "pi_test_dupcart" } as typeof c.session);
    expect(stripeMock.refundCreate, "premise: both duplicates were refunded").toHaveBeenCalledTimes(2);
    expect(await c.cartRows()).toHaveLength(1);
  });

  it("a replay after a crash between the last entry's commit and the mail heals the gap (the mail step re-derives from the books)", async () => {
    const c = await stripeCart();
    await handleRegistrationCheckoutCompleted(c.session);
    const [row] = await c.cartRows();
    // The crash: every entry committed, the mail did not. (Simulated by removing the row; Stripe then re-delivers the event.)
    await sql`delete from email_outbox where id = ${row!.id}`;
    expect(await c.cartRows(), "premise: the mail is gone").toHaveLength(0);
    await handleRegistrationCheckoutCompleted(c.session);
    expect(await c.cartRows(), "the re-delivered event queued it").toHaveLength(1);
  });

  it("the cart mail is in the contact's language", async () => {
    const c = await stripeCart({ locale: "nl" });
    await handleRegistrationCheckoutCompleted(c.session);
    const b = await body("registration_paid", "registration", c.first.id);
    expect(b.subject).toContain("Betaling ontvangen");
    expect(b.text).toContain("Totaal betaald");
  });
});

describe.skipIf(!HAS_DB)("queueRegistrationPaidMail's own guards", () => {
  it("an entry with no fee has no payment to report (the empty case): nothing is queued", async () => {
    const w = await offlineWorld(0, "auto");
    // A CONFIRMED free entry: the status would qualify, so only the amount keeps it out.
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("free"), status: "confirmed" });
    expect(reg.registration.amount_cents, "premise: a free entry").toBe(0);
    expect(reg.registration.status, "premise: in a status a payment mail would accept").toBe("confirmed");
    const ids = await sql.begin((tx) => queueRegistrationPaidMail(tx, { regIds: [reg.registration.id], paymentIntentId: null, paymentRef: "pi_free" }));
    expect(ids).toEqual([]);
    expect(await paidRows(reg.registration.id)).toHaveLength(0);
  });

  it("an entry that has not paid (pending, waitlisted) has no payment to report, whatever it owes", async () => {
    const w = await offlineWorld(1500, "auto");
    let checked = 0;
    for (const status of ["pending", "waitlisted", "withdrawn", "expired"] as const) {
      const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address(`np-${status}`), status, amountCents: 1500 });
      const ids = await sql.begin((tx) => queueRegistrationPaidMail(tx, { regIds: [reg.registration.id], paymentIntentId: null, paymentRef: `pi_${status}` }));
      expect(ids, status).toEqual([]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every unpaid status was driven").toBe(4);
  });

  it("once per payment ref: the same ref queues nothing; a LATER payment of the same entry replaces the unsent first", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("keyed"), status: "confirmed" });
    const queue = (ref: string) => sql.begin((tx) => queueRegistrationPaidMail(tx, { regIds: [reg.registration.id], paymentIntentId: null, paymentRef: ref, origin: ORIGIN }));
    const first = await queue("pi_a");
    expect(first).toHaveLength(1);
    expect(await queue("pi_a"), "the same payment").toEqual([]);
    expect(await paidRows(reg.registration.id)).toHaveLength(1);
    const second = await queue("pi_b");
    expect(second, "a different payment").toHaveLength(1);
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

  // Polish wave sign-off V8, through the real producer: the contact who entered themself is greeted by name and told about "your entry"
  // in its division - never their own name back as the entry. The pair: an entry for someone else, from the same contact, names it.
  it("the contact's own entry is 'your entry' in its division; an entry for someone else is named (V8)", async () => {
    const w = await offlineWorld(0, "manual");
    const contact = address("appr-own");
    const own = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: CONTACT, contactEmail: contact, locale: "en" });
    const other = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: "Sam Other", contactEmail: contact, locale: "en" });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = any(${[own.registration.group_id, other.registration.group_id]}::uuid[])`;

    await approveRegistration(w.owner, own.registration.id);
    await approveRegistration(w.owner, other.registration.id);

    const mine = await body("registration_approved", "registration", own.registration.id, contact);
    expect(words(mine.html).split(CONTACT).length - 1, "the greeting is the only place the contact's name appears").toBe(1);
    expect(words(mine.html)).toContain(`Hi ${CONTACT} — the organiser has approved your entry in ${w.division.name}`);
    expect(mine.text).not.toContain(CONTACT);
    expect(mine.text).toContain(`The organiser has approved your entry in ${w.division.name}.`);

    const theirs = await body("registration_approved", "registration", other.registration.id, contact);
    expect(words(theirs.html)).toContain(`the organiser has approved Sam Other in ${w.division.name}`);
    expect(theirs.text).toContain("Sam Other");
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

  it("an Approve that is refused (the entry was rejected) mails nothing", async () => {
    // W12 (polish wave P5): an unpaid entry is no longer refused - it is approved with its fee still due (the W12 block below).
    const w = await offlineWorld(1500, "manual");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("refused") });
    await rejectRegistration(w.owner, reg.registration.id);
    await expect(approveRegistration(w.owner, reg.registration.id), "a rejected entry cannot be approved").rejects.toThrow(/rejected/);
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

  it("the empty case of W12's payment-due mail: a PENDING entry nobody approved is told nothing (approved_at is null)", async () => {
    const w = await offlineWorld(1500, "manual");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pending-unapproved") });
    expect(reg.registration.approved_at, "premise: never approved").toBeNull();
    const ids = await sql.begin((tx) => queueRegistrationApprovedMails(tx, { reg: reg.registration }));
    expect(ids).toEqual([]);
    expect(await approvedRows(reg.registration.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// W12 (polish wave P5): Approve and the payment are two decisions on a manual-approval division
// ---------------------------------------------------------------------------------------------------------------------------------
// Before: Approve on an unpaid entry was refused ("mark it paid first") and Mark paid confirmed the entry outright, so on a manual
// division the money WAS the approval. Now: Approve on an unpaid entry approves it (`approved_at`, V511) and leaves it pending with the
// fee due; Mark paid records the money and, on a manual division, leaves an unapproved entry `paid` awaiting approval. Whichever comes
// second confirms the entry. Every step runs through its real producer (approveRegistration, markRegistrationPaidOffline, the card
// webhook core); the expected copy is read from the dictionaries' own words and the amount from the money formatter, never from the code.

const entrantOf = async (regId: string): Promise<string | null> =>
  (await sql<{ entrant_id: string | null }[]>`select entrant_id from registrations where id = ${regId}`)[0]!.entrant_id;

describe.skipIf(!HAS_DB)("W12: Approve before payment, then the payment confirms (offline, manual)", () => {
  it("Approve leaves the unpaid entry pending and approved, seats nobody and mails 'approved - payment still due' with the amount, once; Mark paid then confirms it", async () => {
    const w = await offlineWorld(1500, "manual");
    const contact = address("w12-appr");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: contact, locale: "fr" });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${reg.registration.group_id}`;

    const approved = await approveRegistration(w.owner, reg.registration.id);
    expect(approved.status, "the fee is still due: approved, not confirmed").toBe("pending");
    expect(approved.approved_at, "the approval is recorded").not.toBeNull();
    expect(await entrantOf(reg.registration.id), "nobody is seated before the money").toBeNull();

    const rows = await approvedRows(reg.registration.id);
    expect(rows.map((r) => r.recipient.toLowerCase())).toEqual([contact]);
    const b = await body("registration_approved", "registration", reg.registration.id, contact);
    expect(b.subject, "the fr payment-due subject").toContain("paiement en attente");
    expect(b.subject, "never the plain 'your place is confirmed' subject").not.toContain("Votre place est confirmée");
    expect(b.text, "the amount owed, in the recipient's language").toContain(formatMoneyExact(1500, w.settings.currency, "fr"));
    expect(words(b.html)).toContain(`Bonjour ${CONTACT}`);

    // The status page reads the approval: the entry waits on its payment alone.
    const view = await groupById(reg.registration.group_id, reg.access_token);
    const entry = view.entries[0]!;
    expect(entry.approved).toBe(true);
    expect(entryWaitingOn(entry.status, entry.amount_cents, entry.approval, entry.approved)).toBe("payment");

    // Sequence: a second Approve is the same approval - no second mail, no new stamp.
    const again = await approveRegistration(w.owner, reg.registration.id);
    expect(again.status).toBe("pending");
    expect(again.approved_at?.toISOString()).toBe(approved.approved_at?.toISOString());
    expect(await approvedRows(reg.registration.id)).toHaveLength(1);

    // The money arrives: Mark paid confirms the approved entry and seats it; the paid mail says confirmed.
    const marked = await markRegistrationPaidOffline(w.owner, reg.registration.id);
    expect(marked.status).toBe("confirmed");
    expect(await entrantOf(reg.registration.id), "seated by the payment").not.toBeNull();
    const paid = await body("registration_paid", "registration", reg.registration.id, contact);
    expect(paid.text).toContain("Votre place est confirmée");
    expect(paid.text).not.toContain("En attente de l'approbation");
    expect(await approvedRows(reg.registration.id), "the payment sends the paid mail, not a second approved mail").toHaveLength(1);
  });

  it("Mark paid FIRST on an unapproved entry records the money and leaves it paid, awaiting approval (the paid mail says so); Approve then confirms it", async () => {
    const w = await offlineWorld(1500, "manual");
    const contact = address("w12-paid-first");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: contact });

    const marked = await markRegistrationPaidOffline(w.owner, reg.registration.id);
    expect(marked.status, "the payment is not the approval").toBe("paid");
    expect(await entrantOf(reg.registration.id), "nobody is seated before the organiser's yes").toBeNull();
    const paid = await body("registration_paid", "registration", reg.registration.id, contact);
    expect(paid.text).toContain("Awaiting organiser approval");
    expect(paid.text).not.toContain("You're confirmed");

    const approved = await approveRegistration(w.owner, reg.registration.id);
    expect(approved.status).toBe("confirmed");
    expect(await entrantOf(reg.registration.id)).not.toBeNull();
    const b = await body("registration_approved", "registration", reg.registration.id, contact);
    expect(b.subject, "the plain approval: the place is confirmed").not.toMatch(/payment still due/);
    expect(b.text).not.toContain(formatMoneyExact(1500, w.settings.currency, "en"));
  });

  it("the other approval mode: on an AUTO division Mark paid still confirms at once (nothing to approve)", async () => {
    const w = await offlineWorld(1500, "auto");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("w12-auto") });
    const marked = await markRegistrationPaidOffline(w.owner, reg.registration.id);
    expect(marked.status).toBe("confirmed");
    expect(marked.approved_at, "auto approval never stamps approved_at").toBeNull();
  });
});

describe.skipIf(!HAS_DB)("W12: Approve before payment, then the CARD payment confirms (stripe, manual)", () => {
  it("an entry approved while unpaid is confirmed by its card payment - no second Approve - and the paid mail says confirmed", async () => {
    const w = await manualStripeWorld(1500);
    const contact = address("w12-card");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: contact });
    const approved = await approveRegistration(w.owner, reg.registration.id);
    expect(approved.status).toBe("pending");

    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    expect((await loadWithGroup(reg.registration.id)).status, "the approval was given; the payment confirms").toBe("confirmed");
    expect(await entrantOf(reg.registration.id)).not.toBeNull();
    const paid = await body("registration_paid", "registration", reg.registration.id, contact);
    expect(paid.text).toContain("You're confirmed");
  });

  it("the positive pair: an entry NOT approved before its card payment still waits for the organiser (paid)", async () => {
    const w = await manualStripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("w12-card-unappr") });
    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    expect((await loadWithGroup(reg.registration.id)).status).toBe("paid");
    expect(await entrantOf(reg.registration.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// registration_expired (W10)
// ---------------------------------------------------------------------------------------------------------------------------------

const expiredRows = async (regId: string) =>
  sql<{ id: string; recipient: string; status: string; attempts: number }[]>`
    select id, recipient, status, attempts from email_outbox where kind = 'registration_expired' and ref_type = 'registration' and ref_id = ${regId} order by created_at`;

/** The sweep is GLOBAL to the database and other files run their own: every case is seeded first and made overdue in ONE statement
 *  immediately before ONE sweep, and the oldest deadline sorts first so the sweep's batch reaches these rows before any older one. */
const overdue = (groupIds: string[]) => sql`update registration_groups set expires_at = timestamptz '2000-01-01' where id = any(${groupIds}::uuid[])`;

describe.skipIf(!HAS_DB)("expired: the sweep releases unpaid places (real sweepRegistrations)", () => {
  const W: {
    held: { to: string; regId: string; groupId: string };
    team: { to: string; joiner: string; regId: string; ref: string };
    sibling: { regId: string };
    paid: { regId: string };
    contained: { regId: string };
    priv: { to: string; regId: string };
    cap: { holderTo: string; holderId: string; waitingId: string; waitingTo: string };
    division: { name: string };
  } = {} as never;

  beforeAll(async () => {
    if (!HAS_DB) return;
    stubOutboxEnv();
    // 1. A stripe cart of two entries: one unpaid and overdue (nl contact), one FREE in the same cart (never subject to the deadline).
    const a = await stripeWorld(1500);
    await sql`update divisions set name = 'Open Singles' where id = ${a.division.id}`;
    const heldTo = address("exp");
    const held = await seedRegistration(a.competition.id, a.division.id, a.settings, { displayName: TEAM, contactEmail: heldTo, locale: "nl", refCode: `P2-${randomUUID().slice(0, 6)}` });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${held.registration.group_id}`;
    const free = await secondDivision(a as unknown as Parameters<typeof secondDivision>[0], "Free Social", { fee_cents: 0 });
    const sibling = await seedSecondEntry(held.registration.group_id, free.division.id, 0, "Maya Free", "pending");
    // 2. A PAID entry whose cart deadline has passed (a webhook won): not expired, not mailed.
    const paid = await seedRegistration(a.competition.id, a.division.id, a.settings, { contactEmail: address("exp-paid"), status: "paid" });
    // 3. A mail that cannot be queued (empty address) must not stop the entry being released.
    const bad = await seedRegistration(a.competition.id, a.division.id, a.settings, { contactEmail: address("exp-bad") });
    await sql`update registration_groups set contact_email = '' where id = ${bad.registration.group_id}`;
    // 4. A PRIVATE competition: the mail goes, but names no page it cannot link.
    const p = await stripeWorld(1500);
    await sql`update competitions set visibility = 'private' where id = ${p.competition.id}`;
    const privTo = address("exp-priv");
    const priv = await seedRegistration(p.competition.id, p.division.id, p.settings, { contactEmail: privTo });
    // 6. A team entry with teammates (fix round 1): one joined with an address, the contact's own address typed again, one merely typed in
    //    (not consented), one without an address. The club's default language is es, the contact's own pick is nl.
    await sql`update organizations set default_locale = 'es' where id = ${a.orgId}`;
    const teamTo = address("exp-team");
    const teamJoiner = address("exp-team-j");
    const teamRef = `P2-${randomUUID().slice(0, 6)}`;
    const team = await seedRegistration(a.competition.id, a.division.id, a.settings, { displayName: "Fox Team", contactEmail: teamTo, locale: "nl", refCode: teamRef });
    await addMate(team.registration.id, a.orgId, { name: "Joe Joiner", email: teamJoiner });
    await addMate(team.registration.id, a.orgId, { name: "Dana Captain Again", email: teamTo.toUpperCase() });
    await addMate(team.registration.id, a.orgId, { name: "Typed In", email: address("exp-team-t"), consent: "pending", source: "captain_entered" });
    await addMate(team.registration.id, a.orgId, { name: "No Address", email: null });
    // 5. A full division: the holder lapses and the waitlisted entry behind them is promoted in the same transaction.
    const c = await stripeWorld(1500);
    await sql`update registration_settings set capacity = 1 where division_id = ${c.division.id}`;
    const holderTo = address("exp-cap-h");
    const waitingTo = address("exp-cap-w");
    const holder = await seedRegistration(c.competition.id, c.division.id, c.settings, { contactEmail: holderTo });
    const waiting = await seedRegistration(c.competition.id, c.division.id, c.settings, { contactEmail: waitingTo, status: "waitlisted", locale: "es" });

    Object.assign(W, {
      held: { to: heldTo, regId: held.registration.id, groupId: held.registration.group_id },
      team: { to: teamTo, joiner: teamJoiner, regId: team.registration.id, ref: teamRef },
      sibling: { regId: sibling.id },
      paid: { regId: paid.registration.id },
      contained: { regId: bad.registration.id },
      priv: { to: privTo, regId: priv.registration.id },
      cap: { holderTo, holderId: holder.registration.id, waitingId: waiting.registration.id, waitingTo },
      division: { name: "Open Singles" },
    });
    await overdue([held.registration.group_id, team.registration.group_id, paid.registration.group_id, bad.registration.group_id, priv.registration.group_id, holder.registration.group_id]);
    await sweepRegistrations(ORIGIN);
  }, 60_000);

  it("the unpaid entry is released AND its contact is told: their language, their name, the entry, its division, and how to register again", async () => {
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${W.held.regId}`;
    expect(row!.status, "premise: the real sweep expired it").toBe("expired");
    const rows = await expiredRows(W.held.regId);
    expect(rows.map((r) => r.recipient.toLowerCase())).toEqual([W.held.to]);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.attempts, "the sweep leaves the first attempt to the worker").toBe(0);
    const b = await body("registration_expired", "registration", W.held.regId, W.held.to);
    expect(b.subject, "the contact's nl pick").toContain("Je plek is vrijgegeven");
    expect(words(b.html)).toContain(`Hoi ${CONTACT}`);
    expect(b.text).toContain(TEAM);
    expect(b.text).toContain("Open Singles");
    expect(b.text, "where to register again: the competition's public register page, on the sweep's origin").toContain(`${ORIGIN}/live/`);
    expect(b.text).toContain("/register");
  });

  it("the free sibling in the same cart is not released and not mailed; the paid entry is neither (the empty case)", async () => {
    const [free] = await sql<{ status: string }[]>`select status from registrations where id = ${W.sibling.regId}`;
    const [paid] = await sql<{ status: string }[]>`select status from registrations where id = ${W.paid.regId}`;
    expect(free!.status, "premise: nothing was due for it").toBe("pending");
    expect(paid!.status).toBe("paid");
    expect(await expiredRows(W.sibling.regId)).toHaveLength(0);
    expect(await expiredRows(W.paid.regId)).toHaveLength(0);
  });

  it("every teammate who has JOINED and left an address is told the place was released too: the club's language, their own name, no reference; the contact once; the unconsented and the address-less not at all", async () => {
    expect(await statusOf(W.team.regId), "premise: the real sweep expired it").toBe("expired");
    const rows = await expiredRows(W.team.regId);
    expect(rows.map((r) => r.recipient.toLowerCase()).sort(), "the contact once and the one joiner once").toEqual([W.team.to, W.team.joiner].sort());
    expect(rows.map((r) => r.attempts), "the sweep leaves the first attempt to the worker, for every recipient").toEqual([0, 0]);
    const toContact = await body("registration_expired", "registration", W.team.regId, W.team.to);
    const toJoiner = await body("registration_expired", "registration", W.team.regId, W.team.joiner);
    expect(toContact.subject, "the contact's own nl pick").toContain("Je plek is vrijgegeven");
    expect(toJoiner.subject, "a teammate follows the club's default (es), never the contact's pick").toContain("Tu plaza se ha liberado");
    expect(words(toJoiner.html)).toContain("Joe Joiner");
    expect(toJoiner.text, "a teammate is not given the contact's reference").not.toContain(W.team.ref);
    expect(toContact.text).toContain(W.team.ref);
  });

  it("a second sweep releases and mails nothing more", async () => {
    const before = [await expiredRows(W.held.regId), await expiredRows(W.team.regId)];
    expect(before[1], "premise: the team entry has its mails to compare").toHaveLength(2);
    await sweepRegistrations(ORIGIN);
    expect([await expiredRows(W.held.regId), await expiredRows(W.team.regId)]).toEqual(before);
  });

  it("a mail that cannot be queued does not stop the place being released", async () => {
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${W.contained.regId}`;
    expect(row!.status).toBe("expired");
    expect(await expiredRows(W.contained.regId)).toHaveLength(0);
  });

  it("a private competition: still told, with no register link to a page that does not exist", async () => {
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${W.priv.regId}`;
    expect(row!.status).toBe("expired");
    const b = await body("registration_expired", "registration", W.priv.regId, W.priv.to);
    expect(b.text).not.toContain("/register");
    expect(b.text).not.toContain("http");
  });

  it("the release that frees a seat still promotes the waitlisted entry behind it: the holder is told AND the next entrant is promoted", async () => {
    const [h] = await sql<{ status: string }[]>`select status from registrations where id = ${W.cap.holderId}`;
    const [n] = await sql<{ status: string; promoted_at: Date | null }[]>`select status, promoted_at from registrations where id = ${W.cap.waitingId}`;
    expect(h!.status).toBe("expired");
    expect(n!.promoted_at, "premise: the real sweep promoted the next entrant").not.toBeNull();
    expect((await expiredRows(W.cap.holderId)).map((r) => r.recipient.toLowerCase())).toEqual([W.cap.holderTo]);
    const promoted = await sql<{ recipient: string }[]>`select recipient from email_outbox where kind = 'registration_promoted' and ref_id = ${W.cap.waitingId}`;
    expect(promoted.map((r) => r.recipient.toLowerCase()), "the promotion mail is unaffected").toEqual([W.cap.waitingTo]);
    expect(await expiredRows(W.cap.waitingId), "the promoted entrant is not told their place was released").toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("queueRegistrationExpiredMails' own guard", () => {
  it("once per entry and address: a second call queues nothing, however many teammates the entry has", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("exp-once") });
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner", email: address("exp-once-j") });
    const queue = () => sql.begin((tx) => queueRegistrationExpiredMails(tx, { reg: reg.registration, origin: ORIGIN }));
    expect(await queue(), "the contact and the joiner").toHaveLength(2);
    expect(await queue()).toEqual([]);
    expect(await expiredRows(reg.registration.id)).toHaveLength(2);
  });

  it("one teammate's mail failing to render never costs the contact theirs", async () => {
    const w = await stripeWorld(1500);
    const to = address("exp-iso-c");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: to });
    await addMate(reg.registration.id, w.orgId, { name: "Boom Player", email: address("exp-iso-j") });
    const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
    const spy = vi.mocked(emailModule.registrationExpiredEmail).mockImplementation(async (args, locale) => {
      if (args.contactName === "Boom Player") throw new Error("render fault");
      return actual.registrationExpiredEmail(args, locale);
    });
    const ids = await sql.begin((tx) => queueRegistrationExpiredMails(tx, { reg: reg.registration, origin: ORIGIN }));
    expect(spy, "premise: both recipients reached the renderer").toHaveBeenCalledTimes(2);
    expect(ids).toHaveLength(1);
    expect((await expiredRows(reg.registration.id)).map((r) => r.recipient.toLowerCase())).toEqual([to]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// registration_withdrawn (W11): the ORGANISER withdrew the entry
// ---------------------------------------------------------------------------------------------------------------------------------

const withdrawnRows = async (regId: string) =>
  sql<{ id: string; recipient: string; status: string; attempts: number }[]>`
    select id, recipient, status, attempts from email_outbox where kind = 'registration_withdrawn' and ref_type = 'registration' and ref_id = ${regId} order by created_at`;
/** Who the withdrawal's audit row says withdrew the entry, and the actor it records (null for an API key and for a registrant). */
const withdrawAudit = async (regId: string) =>
  sql<{ by: string; actor_id: string | null }[]>`
    select payload->>'by' as by, actor_id from competition_events where type = 'registration.withdrawn' and payload->>'registration_id' = ${regId}`;
const statusOf = async (regId: string): Promise<string> => (await sql<{ status: string }[]>`select status from registrations where id = ${regId}`)[0]!.status;

describe.skipIf(!HAS_DB)("withdrawn: the organiser withdraws an entry (real withdrawRegistrationOrganiser)", () => {
  it("the contact is told in their language: who, which entry, which division; the first attempt is made after the response", async () => {
    const w = await offlineWorld(1500, "auto");
    const to = address("wd");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: to, locale: "es", refCode: `P2-${randomUUID().slice(0, 6)}` });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${reg.registration.group_id}`;
    await withdrawRegistrationOrganiser(w.owner, reg.registration.id);
    expect(await statusOf(reg.registration.id), "premise: the real usecase withdrew it").toBe("withdrawn");
    await vi.waitFor(async () => {
      const [r] = await withdrawnRows(reg.registration.id);
      if (!r || r.attempts < 1) throw new Error("the request's attempt has not been made yet");
    });
    const rows = await withdrawnRows(reg.registration.id);
    expect(rows.map((r) => r.recipient.toLowerCase())).toEqual([to]);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.attempts, "a request path: one attempt, made after the response").toBe(1);
    const b = await body("registration_withdrawn", "registration", reg.registration.id);
    expect(b.subject).toContain("Tu inscripción ha sido retirada");
    const visible = words(b.html);
    expect(visible).toContain(CONTACT);
    // The hidden preheader (the inbox preview line) may name the entry first; the BODY names the person, then the entry.
    expect(visible.indexOf(TEAM, visible.indexOf(CONTACT)), "the entry is named after the greeting").toBeGreaterThan(visible.indexOf(CONTACT));
    expect(b.text).toContain(TEAM);
    expect(b.text, "the division's own name").toContain("Open");
    expect(b.text).toContain(reg.registration.ref_code!);
  });

  it("every teammate who has JOINED and left an address is told too, in the club's language, greeted by their own name - the contact once, the unconsented and the address-less not at all", async () => {
    const w = await offlineWorld(1500, "auto");
    await sql`update organizations set default_locale = 'nl' where id = ${w.orgId}`;
    const contact = address("wd-m-c");
    const joiner = address("wd-m-j");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: contact, locale: "es", refCode: `P2-${randomUUID().slice(0, 6)}` });
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner", email: joiner });
    await addMate(reg.registration.id, w.orgId, { name: "Dana Captain Again", email: contact.toUpperCase() });
    await addMate(reg.registration.id, w.orgId, { name: "Typed In", email: address("wd-m-t"), consent: "pending", source: "captain_entered" });
    await addMate(reg.registration.id, w.orgId, { name: "No Address", email: null });
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner Twice", email: joiner.toUpperCase() });

    await withdrawRegistrationOrganiser(w.owner, reg.registration.id);

    expect(await statusOf(reg.registration.id), "premise: the real usecase withdrew it").toBe("withdrawn");
    await vi.waitFor(async () => {
      const rs = await withdrawnRows(reg.registration.id);
      if (rs.length !== 2 || rs.some((r) => r.attempts < 1)) throw new Error("every recipient's first attempt has not been made yet");
    });
    const rows = await withdrawnRows(reg.registration.id);
    expect(rows.map((r) => r.recipient.toLowerCase()).sort(), "the contact once and the one joiner once").toEqual([contact, joiner].sort());
    const toContact = await body("registration_withdrawn", "registration", reg.registration.id, contact);
    const toJoiner = await body("registration_withdrawn", "registration", reg.registration.id, joiner);
    expect(toContact.subject, "the contact's own es pick").toContain("Tu inscripción ha sido retirada");
    expect(toJoiner.subject, "a teammate follows the club's default (nl), never the contact's pick").toContain("Je inschrijving is ingetrokken");
    expect(words(toJoiner.html)).toContain("Joe Joiner");
    expect(toJoiner.text, "a teammate is not given the contact's reference").not.toContain(reg.registration.ref_code!);
    expect(toContact.text).toContain(reg.registration.ref_code!);

    // The second call is the idempotent no-op it always was: nobody is told again.
    await withdrawRegistrationOrganiser(w.owner, reg.registration.id);
    expect(await withdrawnRows(reg.registration.id)).toHaveLength(2);
  });

  it("one teammate's mail failing to render never costs the contact theirs, or the withdrawal", async () => {
    const w = await offlineWorld(1500, "auto");
    const contact = address("wd-iso-c");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: contact });
    await addMate(reg.registration.id, w.orgId, { name: "Boom Player", email: address("wd-iso-j") });
    const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
    vi.mocked(emailModule.registrationWithdrawnEmail).mockImplementation(async (args, locale) => {
      if (args.contactName === "Boom Player") throw new Error("render fault");
      return actual.registrationWithdrawnEmail(args, locale);
    });

    await withdrawRegistrationOrganiser(w.owner, reg.registration.id);

    expect(vi.mocked(emailModule.registrationWithdrawnEmail), "premise: both recipients reached the renderer").toHaveBeenCalledTimes(2);
    expect(await statusOf(reg.registration.id), "the withdrawal stands").toBe("withdrawn");
    expect((await withdrawnRows(reg.registration.id)).map((r) => r.recipient.toLowerCase()), "the contact still has theirs").toEqual([contact]);
  });

  it("every live status is told (pending, paid, confirmed, waitlisted); an EXPIRED entry already was, by the sweep's mail (the table, not a sample)", async () => {
    const w = await offlineWorld(1500, "auto");
    // Ruling: the organiser withdrawing an entry the person has already been told lost its place adds nothing but a second, contradictory mail.
    const table: Array<[RegistrationRow["status"], number]> = [["pending", 1], ["paid", 1], ["confirmed", 1], ["waitlisted", 1], ["expired", 0]];
    let checked = 0;
    for (const [status, expected] of table) {
      const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address(`wd-${status}`), status });
      await withdrawRegistrationOrganiser(w.owner, reg.registration.id);
      expect(await statusOf(reg.registration.id), `premise: ${status} was withdrawn`).toBe("withdrawn");
      expect(await withdrawnRows(reg.registration.id), status).toHaveLength(expected);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every status of the table was driven").toBe(5);
  });

  it("a REJECTED entry cannot be withdrawn, so nothing is mailed; a second withdraw of a withdrawn entry mails nothing more", async () => {
    const w = await offlineWorld(1500, "auto");
    const rejected = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("wd-rej"), status: "rejected" });
    await expect(withdrawRegistrationOrganiser(w.owner, rejected.registration.id)).rejects.toThrow(/rejected/);
    expect(await withdrawnRows(rejected.registration.id)).toHaveLength(0);

    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("wd-twice") });
    await withdrawRegistrationOrganiser(w.owner, reg.registration.id);
    await withdrawRegistrationOrganiser(w.owner, reg.registration.id);
    expect(await withdrawnRows(reg.registration.id), "the second call is the idempotent no-op it always was").toHaveLength(1);
  });

  it("an organiser withdrawing through an API KEY (no user id) is still the organiser: mailed, and audited as the organiser (fix round 1)", async () => {
    const w = await offlineWorld(1500, "auto");
    const to = address("wd-key");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: to });
    const viaKey: AuthCtx = { orgId: w.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    expect(viaKey.userId, "premise: an API key carries no user id").toBeNull();
    await withdrawRegistrationOrganiser(viaKey, reg.registration.id);
    expect(await statusOf(reg.registration.id), "premise: the withdrawal ran").toBe("withdrawn");
    expect((await withdrawnRows(reg.registration.id)).map((r) => r.recipient.toLowerCase())).toEqual([to]);
    expect(await withdrawAudit(reg.registration.id)).toEqual([{ by: "organiser", actor_id: null }]);
  });

  it("a registrant's OWN withdrawal mails nothing (they know), by the status page and by the reference page alike", async () => {
    const w = await offlineWorld(1500, "auto");
    const viaStatus = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("wd-self") });
    await withdrawRegistrationPublic(viaStatus.registration.id, viaStatus.access_token);
    const ref = generateRefCode();
    const viaRef = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("wd-self-ref"), refCode: ref });
    await withdrawRegistrationByRef(ref, viaRef.registration.id, viaRef.access_token);
    let checked = 0;
    for (const r of [viaStatus, viaRef]) {
      expect(await statusOf(r.registration.id), "premise: the registrant withdrew it").toBe("withdrawn");
      expect(await withdrawnRows(r.registration.id)).toHaveLength(0);
      expect(await withdrawAudit(r.registration.id), "and the audit still says the registrant").toEqual([{ by: "registrant", actor_id: null }]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a paid entry withdrawn before the refund lock: the refund receipt and the withdrawal mail are two mails, both to the contact", async () => {
    const w = await stripeWorld(1500);
    const to = address("wd-paid");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: to });
    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    await withdrawRegistrationOrganiser(w.owner, reg.registration.id);
    expect(stripeMock.refundCreate, "premise: the automatic refund ran").toHaveBeenCalledTimes(1);
    const receipts = await sql<{ recipient: string }[]>`select recipient from email_outbox where kind = 'refund_issued' and org_id = ${w.orgId}`;
    expect(receipts.map((r) => r.recipient.toLowerCase())).toEqual([to]);
    expect((await withdrawnRows(reg.registration.id)).map((r) => r.recipient.toLowerCase())).toEqual([to]);
  });

  it("a mail that cannot be queued never undoes the withdrawal (contained at its own savepoint)", async () => {
    const w = await offlineWorld(1500, "auto");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("wd-contained") });
    vi.mocked(emailModule.registrationWithdrawnEmail).mockImplementation(async () => {
      throw new Error("render fault");
    });
    await withdrawRegistrationOrganiser(w.owner, reg.registration.id);
    expect(vi.mocked(emailModule.registrationWithdrawnEmail), "premise: the producer reached the renderer").toHaveBeenCalled();
    expect(await statusOf(reg.registration.id)).toBe("withdrawn");
    expect(await withdrawnRows(reg.registration.id)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("queueRegistrationWithdrawnMails' own guards", () => {
  it("once per entry and address: a second call queues nothing, with or without teammates", async () => {
    const w = await offlineWorld(1500, "auto");
    const alone = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("wd-once") });
    const aloneQueue = () => sql.begin((tx) => queueRegistrationWithdrawnMails(tx, { reg: alone.registration }));
    expect(await aloneQueue()).toHaveLength(1);
    expect(await aloneQueue()).toEqual([]);
    expect(await withdrawnRows(alone.registration.id)).toHaveLength(1);

    const team = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("wd-once-t") });
    await addMate(team.registration.id, w.orgId, { name: "Joe Joiner", email: address("wd-once-j") });
    const teamQueue = () => sql.begin((tx) => queueRegistrationWithdrawnMails(tx, { reg: team.registration }));
    expect(await teamQueue(), "the contact and the joiner").toHaveLength(2);
    expect(await teamQueue()).toEqual([]);
    expect(await withdrawnRows(team.registration.id)).toHaveLength(2);
  });

  it("an entry the person was already told is gone (expired, rejected, withdrawn) is not told again", async () => {
    const w = await offlineWorld(1500, "auto");
    let checked = 0;
    for (const status of ["expired", "rejected", "withdrawn"] as const) {
      const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address(`wd-g-${status}`), status });
      await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner", email: address(`wd-g-${status}-j`) });
      expect(await sql.begin((tx) => queueRegistrationWithdrawnMails(tx, { reg: reg.registration })), status).toEqual([]);
      expect(await withdrawnRows(reg.registration.id), status).toHaveLength(0);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// registration_joined (W13): a teammate claimed a slot (or took one) through the join link
// ---------------------------------------------------------------------------------------------------------------------------------

const joinedRows = async (regId: string) =>
  sql<{ id: string; recipient: string; status: string; attempts: number; dedupe_key: string | null }[]>`
    select id, recipient, status, attempts, dedupe_key from email_outbox where kind = 'registration_joined' and ref_type = 'registration' and ref_id = ${regId} order by created_at, id`;

/** A TEAM entry with a join link, in a world whose fee, payment method and approval mode the case chooses. Seeded by the row (not by a
 *  submit) so each case names the exact status the entry rests in; the join itself is the real `joinTeamEntry`. */
async function teamEntry(a: {
  fee?: number;
  approval?: "auto" | "manual";
  status?: RegistrationRow["status"];
  players?: string[];
  visibility?: "public" | "private";
  locale?: string | null;
}) {
  const { orgId, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  if (a.visibility) await sql`update competitions set visibility = ${a.visibility} where id = ${competition.id}`;
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    entrant_kind: "team",
    fee_cents: a.fee ?? 0,
    payment_method: "offline",
    payment_instructions: "Pay at the desk, quoting {{reference}}",
    approval: a.approval ?? "auto",
  });
  const refCode = generateRefCode();
  const reg = await seedRegistration(competition.id, division.id, settings, {
    displayName: TEAM,
    contactEmail: address("captain"),
    status: a.status ?? "confirmed",
    players: (a.players ?? []).map((name) => ({ name })),
    locale: a.locale ?? null,
    refCode,
  });
  const joinCode = `JN${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  await sql`update registrations set join_code = ${joinCode} where id = ${reg.registration.id}`;
  const slots = await sql<{ id: string; full_name: string }[]>`select id, full_name from registration_players where registration_id = ${reg.registration.id} order by full_name`;
  return { orgId, owner, competition, division, settings, reg: reg.registration, joinCode, refCode, slots };
}

const JOINER = "Sam Joiner";
const join = (code: string, to: string | null, over: { player_id?: string; name?: string; sessionUserId?: string } = {}) =>
  joinTeamEntry(
    { sessionUserId: over.sessionUserId ?? null },
    { join_code: code, player_id: over.player_id ?? null, player: { full_name: over.name ?? JOINER, dob: "1995-05-01", email: to }, privacy_consent: true },
  );

describe.skipIf(!HAS_DB)("joined: a teammate joins an entry (real joinTeamEntry)", () => {
  it("each state the entry rests in is stated honestly: five waiting/confirmed states and the one with nothing to name (the table, not a sample)", async () => {
    const dict = await getDictionary("en", "emails");
    const T = (k: string): string => String(dict[`registrationJoined.state${k}Title`]);
    // Expected titles come from the DICTIONARY'S keys per state; what each case is waiting on is the rulebook's (a fee is owed only while the
    // entry is pending; a paid entry waits on approval alone; a free auto-approved entry has nothing to wait on).
    const table: Array<{ name: string; entry: Parameters<typeof teamEntry>[0]; title: string | null }> = [
      { name: "confirmed", entry: { status: "confirmed" }, title: T("Confirmed") },
      { name: "waitlisted", entry: { status: "waitlisted" }, title: T("Waitlisted") },
      { name: "payment", entry: { status: "pending", fee: 1500, approval: "auto" }, title: T("Payment") },
      { name: "approval", entry: { status: "pending", fee: 0, approval: "manual" }, title: T("Approval") },
      { name: "payment and approval", entry: { status: "pending", fee: 1500, approval: "manual" }, title: T("PaymentApproval") },
      { name: "paid, awaiting approval", entry: { status: "paid", fee: 1500, approval: "manual" }, title: T("Approval") },
      { name: "pending with nothing to wait on", entry: { status: "pending", fee: 0, approval: "auto" }, title: null },
    ];
    const allTitles = Object.keys(dict).filter((k) => /^registrationJoined\.state.*Title$/.test(k)).map((k) => String(dict[k]));
    expect(allTitles.length, "premise: the dictionary has five state titles").toBe(5);
    let checked = 0;
    for (const c of table) {
      const e = await teamEntry(c.entry);
      const to = address("joiner");
      await join(e.joinCode, to);
      const rows = await joinedRows(e.reg.id);
      expect(rows.map((r) => r.recipient.toLowerCase()), c.name).toEqual([to]);
      const b = await body("registration_joined", "registration", e.reg.id, to);
      if (c.title) expect(b.text, `${c.name}: names its state`).toContain(c.title);
      // ("…awaiting payment" is a prefix of "…awaiting payment and approval": a title the expected one contains is not another state's.)
      for (const other of allTitles.filter((t) => t !== c.title && !(c.title ?? "").includes(t))) expect(b.text, `${c.name}: names no OTHER state`).not.toContain(other);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every row of the table was driven").toBe(7);
  });

  it("the mail greets the joiner, names the entry and its division, links the public page, and never leaks the captain's reference; the first attempt follows the response", async () => {
    const e = await teamEntry({ status: "confirmed" });
    const to = address("joiner-copy");
    await join(e.joinCode, to);
    // The dispatch runs after the response, on its own: wait for the attempt rather than race it. The provider answers 503, so the row stays queued.
    await vi.waitFor(async () => {
      const [r] = await joinedRows(e.reg.id);
      if (!r || r.attempts < 1) throw new Error("the request's attempt has not been made yet");
    });
    const [row] = await joinedRows(e.reg.id);
    expect(row!.status).toBe("queued");
    expect(row!.attempts, "a request path: one attempt, made after the response").toBe(1);
    const b = await body("registration_joined", "registration", e.reg.id, to);
    const visible = words(b.html);
    expect(visible).toContain(JOINER);
    expect(visible.indexOf(TEAM, visible.indexOf(JOINER)), "the entry is named after the greeting").toBeGreaterThan(visible.indexOf(JOINER));
    expect(b.text).toContain("Open");
    expect(b.text, "the competition's public page").toContain("/live/");
    expect(b.text, "the captain's reference code is theirs, not the teammate's").not.toContain(e.refCode);
    expect(b.html).not.toContain(e.refCode);
  });

  it("the joiner's language is their account's; with no account it is the club's", async () => {
    // Two slots to claim: the generic sport's roster holds one player, so a second NEW joiner would be refused as "full".
    const e = await teamEntry({ status: "confirmed", players: ["Nora Account", "Elsa Anon"] });
    const dictNl = await getDictionary("nl", "emails");
    const userId = await makeUser("joiner-nl");
    made.userIds.push(userId);
    await sql`update users set locale = 'nl' where id = ${userId}`;
    const nlTo = address("joiner-nl");
    await join(e.joinCode, nlTo, { sessionUserId: userId, name: "Nora Account", player_id: e.slots.find((x) => x.full_name === "Nora Account")!.id });
    const enTo = address("joiner-en");
    await join(e.joinCode, enTo, { name: "Elsa Anon", player_id: e.slots.find((x) => x.full_name === "Elsa Anon")!.id });
    const nl = await body("registration_joined", "registration", e.reg.id, nlTo);
    const en = await body("registration_joined", "registration", e.reg.id, enTo);
    expect(nl.text, "premise: an account's nl pick reaches the mail").toContain(dictNl["registrationJoined.stateConfirmedTitle"]!);
    expect(en.subject).not.toBe(nl.subject);
    expect(en.text).not.toContain(dictNl["registrationJoined.stateConfirmedTitle"]!);
  });

  it("a CLAIMED slot mails the claimer once; a second claim of the same slot is refused and mails nothing; two joiners are two mails to their own addresses", async () => {
    const e = await teamEntry({ status: "confirmed", players: ["Slot A", "Slot B"] });
    const toA = address("claim-a");
    const toB = address("claim-b");
    await join(e.joinCode, toA, { player_id: e.slots[0]!.id, name: "Slot A" });
    await expect(join(e.joinCode, address("claim-again"), { player_id: e.slots[0]!.id, name: "Slot A" })).rejects.toMatchObject({ status: 409 });
    await join(e.joinCode, toB, { player_id: e.slots[1]!.id, name: "Slot B" });
    const rows = await joinedRows(e.reg.id);
    expect(rows.map((r) => r.recipient.toLowerCase()).sort()).toEqual([toA, toB].sort());
    expect(rows.map((r) => r.dedupe_key).sort(), "keyed by the player row, not the entry").toEqual([`${e.slots[0]!.id}:joined`, `${e.slots[1]!.id}:joined`].sort());
  });

  it("no address, no mail: a joiner who left none (or only blanks) joins all the same (the empty case)", async () => {
    const e = await teamEntry({ status: "confirmed", players: ["No Address", "Blank Address"] });
    // Declining to mail is the producer's own decision, not a failure it swallows: nothing is logged as an error (the outbox would refuse a
    // blank recipient anyway, inside the savepoint, and the contained failure would hide that this guard is gone).
    const errors = vi.spyOn(log, "error");
    const none = await join(e.joinCode, null, { name: "No Address", player_id: e.slots.find((x) => x.full_name === "No Address")!.id });
    const blank = await join(e.joinCode, "   ", { name: "Blank Address", player_id: e.slots.find((x) => x.full_name === "Blank Address")!.id });
    expect(none.player_id).not.toBe(blank.player_id);
    const joined = await sql<{ n: number }[]>`select count(*)::int as n from registration_players where registration_id = ${e.reg.id} and consent_status = 'granted'`;
    expect(joined[0]!.n, "premise: both joined (consented)").toBe(2);
    expect(await joinedRows(e.reg.id)).toHaveLength(0);
    expect(errors, "no failure was contained: the producer declined").not.toHaveBeenCalled();
  });

  it("after a withdrawal the link is refused and nothing is mailed (sequence)", async () => {
    const e = await teamEntry({ status: "confirmed" });
    await withdrawRegistrationOrganiser(e.owner, e.reg.id);
    await expect(join(e.joinCode, address("late"))).rejects.toMatchObject({ status: 422 });
    expect(await joinedRows(e.reg.id)).toHaveLength(0);
  });

  it("a private competition: the joiner is told, with no link to a page that does not exist", async () => {
    const e = await teamEntry({ status: "confirmed", visibility: "private" });
    const to = address("joiner-priv");
    await join(e.joinCode, to);
    const b = await body("registration_joined", "registration", e.reg.id, to);
    expect(b.text).not.toContain("http");
  });

  it("a mail that cannot be queued never undoes the join (contained at its own savepoint)", async () => {
    const e = await teamEntry({ status: "confirmed" });
    vi.mocked(emailModule.registrationJoinedEmail).mockImplementation(async () => {
      throw new Error("render fault");
    });
    const to = address("joiner-fault");
    const errors = vi.spyOn(log, "error");
    const res = await join(e.joinCode, to);
    expect(errors, "premise: the spy sees the producer's contained failure").toHaveBeenCalledWith(expect.objectContaining({ kind: "registration_joined" }), expect.any(String));
    expect(vi.mocked(emailModule.registrationJoinedEmail), "premise: the producer reached the renderer").toHaveBeenCalled();
    const [player] = await sql<{ email: string | null }[]>`select email from registration_players where id = ${res.player_id}`;
    expect(player!.email?.toLowerCase(), "the join stands").toBe(to);
    expect(await joinedRows(e.reg.id)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("queueRegistrationJoinedMail's own guards", () => {
  it("once per player row: a second call for the same player queues nothing", async () => {
    const e = await teamEntry({ status: "confirmed", players: ["Slot A"] });
    const call = () =>
      sql.begin((tx) => queueRegistrationJoinedMail(tx, { registrationId: e.reg.id, playerId: e.slots[0]!.id, playerName: JOINER, to: address("once"), userId: null }));
    expect(await call()).not.toBeNull();
    expect(await call()).toBeNull();
    expect(await joinedRows(e.reg.id)).toHaveLength(1);
  });

  it("an entry that ended is not described as one the joiner is in (nothing queued for a withdrawn entry)", async () => {
    const e = await teamEntry({ status: "withdrawn", players: ["Slot A"] });
    const id = await sql.begin((tx) => queueRegistrationJoinedMail(tx, { registrationId: e.reg.id, playerId: e.slots[0]!.id, playerName: JOINER, to: address("ended"), userId: null }));
    expect(id).toBeNull();
    expect(await joinedRows(e.reg.id)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("W12: a joiner of an entry approved ahead of its payment (real joinTeamEntry)", () => {
  it("the join response and the joiner's mail both say 'awaiting payment' - not 'payment and approval' - once the organiser approved", async () => {
    // The rig's roster holds one player, so the joiner claims the captain-entered slot. The unapproved row (payment_and_approval) is
    // pinned by registration-join-entry-state.test.ts's table.
    const e = await teamEntry({ fee: 1500, approval: "manual", status: "pending", players: ["Slot A"] });
    const approved = await approveRegistration(e.owner, e.reg.id);
    expect(approved.status, "premise: approved with the fee due").toBe("pending");

    const to = address("w12-join");
    const result = await join(e.joinCode, to, { player_id: e.slots[0]!.id });
    expect(result.entry_state).toBe("payment");
    const dict = await getDictionary("en", "emails");
    const b = await body("registration_joined", "registration", e.reg.id, to);
    expect(b.text).toContain(String(dict["registrationJoined.statePaymentTitle"]));
    expect(b.text).not.toContain(String(dict["registrationJoined.statePaymentApprovalTitle"]));
  });
});

describe.skipIf(!HAS_DB)("W12: the cart confirmation rebuilt after an approval (real notifySubmitted)", () => {
  it("an entry approved ahead of its payment reads 'awaiting payment' while its unapproved sibling still reads 'payment and approval'", async () => {
    const w = await offlineWorld(1500, "manual");
    const first = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: "Maya Cole", contactEmail: address("w12-cart") });
    const sibling = await seedSecondEntry(first.registration.group_id, w.division.id, 1500, "Sam Cole", "pending");
    // A contact who is neither entry, so each line carries its entry's name (sign-off V8 lists the contact's OWN entry by division).
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${first.registration.group_id}`;
    await approveRegistration(w.owner, first.registration.id);

    await notifySubmitted(first.registration.group_id, ORIGIN, first.access_token);
    const b = await body("registration_confirmation", "registration_group", first.registration.group_id);
    const dict = await getDictionary("en", "emails");
    const lineOf = (name: string) => b.text.split("\n").find((l) => l.includes(name))!;
    expect(lineOf("Maya Cole")).toContain(String(dict["registration.entryStatusAwaitingPayment"]));
    expect(lineOf("Maya Cole")).not.toContain(String(dict["registration.entryStatusAwaitingPaymentApproval"]));
    expect(lineOf("Sam Cole"), `premise: the unapproved sibling (${sibling.id})`).toContain(String(dict["registration.entryStatusAwaitingPaymentApproval"]));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// registration_rejected (polish wave P5, P2 carry): the organiser REJECTED the entry on a manual-approval division
// ---------------------------------------------------------------------------------------------------------------------------------
// Before: a rejected registrant heard nothing; a card payer received only the refund receipt, with no word of WHY the money came back.
// Now: the contact and every joined teammate are told the entry was not accepted, in their own language, in the transaction that records
// the rejection. The contact (the payer) also reads that their card payment is being returned, with the amount still owed back on THIS
// entry's own payment; a teammate never reads the contact's money. Expected copy is the dictionaries' own words, the amount the money
// formatter's, never the code under test.

const rejectedRows = async (regId: string) =>
  sql<{ id: string; recipient: string; status: string; attempts: number }[]>`
    select id, recipient, status, attempts from email_outbox where kind = 'registration_rejected' and ref_type = 'registration' and ref_id = ${regId} order by created_at, id`;

describe.skipIf(!HAS_DB)("rejected: the organiser rejects an entry (real rejectRegistration)", () => {
  it("an UNPAID entry: the contact (their language) and the joined teammate (the club's) are told it was not accepted, with no refund line; once", async () => {
    const w = await offlineWorld(1500, "manual");
    await sql`update organizations set default_locale = 'es' where id = ${w.orgId}`;
    const to = address("rej");
    const joiner = address("rej-j");
    const ref = `P5-${randomUUID().slice(0, 6)}`;
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: to, locale: "fr", refCode: ref });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${reg.registration.group_id}`;
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner", email: joiner });
    await addMate(reg.registration.id, w.orgId, { name: "Typed In", email: address("rej-t"), consent: "pending", source: "captain_entered" });

    await rejectRegistration(w.owner, reg.registration.id);
    expect(await statusOf(reg.registration.id), "premise: the real usecase rejected it").toBe("rejected");
    await vi.waitFor(async () => {
      const rows = await rejectedRows(reg.registration.id);
      if (rows.length < 2 || rows.some((r) => r.attempts < 1)) throw new Error("the request's attempts have not been made yet");
    });
    const rows = await rejectedRows(reg.registration.id);
    expect(rows.map((r) => r.recipient.toLowerCase()).sort(), "the contact and the joined teammate, never the unconsented one").toEqual([to, joiner].sort());
    expect(rows.map((r) => r.attempts), "a request path: one attempt each, made after the response").toEqual([1, 1]);

    const fr = await getDictionary("fr", "emails");
    const es = await getDictionary("es", "emails");
    const toContact = await body("registration_rejected", "registration", reg.registration.id, to);
    const toJoiner = await body("registration_rejected", "registration", reg.registration.id, joiner);
    expect(toContact.text, "the contact's own fr pick").toContain(String(fr["registrationRejected.title"]));
    expect(toJoiner.text, "a teammate follows the club's default (es)").toContain(String(es["registrationRejected.title"]));
    expect(words(toContact.html)).toContain(CONTACT);
    expect(words(toJoiner.html)).toContain("Joe Joiner");
    expect(toContact.text).toContain(TEAM);
    expect(toContact.text, "the division's own name").toContain("Open");
    expect(toContact.text).toContain(ref);
    expect(toJoiner.text, "a teammate is not given the contact's reference").not.toContain(ref);
    expect(toContact.text, "nothing was paid, so nothing is being returned").not.toContain(formatMoneyExact(1500, w.settings.currency, "fr"));

    await rejectRegistration(w.owner, reg.registration.id);
    expect(await rejectedRows(reg.registration.id), "a second Reject is a no-op: nothing more").toHaveLength(2);
  });

  it("a CARD-paid entry: the contact reads that their payment is being refunded, with the amount; the teammate does not; the receipt still follows", async () => {
    const w = await manualStripeWorld(1500);
    const to = address("rej-card");
    const joiner = address("rej-card-j");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: to, locale: "nl" });
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner", email: joiner });
    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    expect((await loadWithGroup(reg.registration.id)).status, "premise: paid and waiting for the organiser").toBe("paid");

    await rejectRegistration(w.owner, reg.registration.id);
    expect(stripeMock.refundCreate, "premise: the real reject refunded the payment").toHaveBeenCalledTimes(1);
    const nl = await getDictionary("nl", "emails");
    const amount = formatMoneyExact(1500, w.settings.currency, "nl");
    const toContact = await body("registration_rejected", "registration", reg.registration.id, to);
    expect(toContact.text).toContain(t(nl, "registrationRejected.textRefund", { amount }));
    const toJoiner = await body("registration_rejected", "registration", reg.registration.id, joiner);
    // The joiner reads the club's language (en), not the contact's: no refund line and no amount in ANY locale's spelling.
    const en = await getDictionary("en", "emails");
    expect(toJoiner.text, "premise: the joiner's mail is the club's en copy").toContain(String(en["registrationRejected.title"]));
    expect(toJoiner.text, "the contact's money is not a teammate's news").not.toContain(String(en["registrationRejected.textRefund"]).split("{amount}")[0]!);
    let spellings = 0;
    for (const locale of ["en", "fr", "es", "nl"] as const) {
      expect(toJoiner.text, `no ${locale} spelling of the amount`).not.toContain(formatMoneyExact(1500, w.settings.currency, locale));
      spellings += 1;
    }
    expect(spellings).toBe(4);
    const refundId = (await stripeMock.refundCreate.mock.results[0]!.value as { id: string }).id;
    const receipts = await sql<{ recipient: string }[]>`select recipient from email_outbox where kind = 'refund_issued' and ref_type = 'refund' and ref_id = ${refundId}`;
    expect(receipts.map((r) => r.recipient.toLowerCase()), "the refund receipt is unchanged: one, to the payer").toEqual([to]);
  });

  it("a card payment already PARTLY refunded: the line names what is still being returned (1000), never the entry fee (1500)", async () => {
    const w = await manualStripeWorld(1500);
    const to = address("rej-part");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: to });
    await handleRegistrationCheckoutCompleted(fakeSession(reg.registration.id, 1500));
    await sql`update registrations set refunded_cents = 500 where id = ${reg.registration.id}`;

    await rejectRegistration(w.owner, reg.registration.id);
    expect(stripeMock.refundCreate.mock.calls[0]?.[0], "premise: the real reject refunds the remaining 1000").toMatchObject({ amount: 1000 });
    const en = await getDictionary("en", "emails");
    const b = await body("registration_rejected", "registration", reg.registration.id, to);
    expect(b.text).toContain(t(en, "registrationRejected.textRefund", { amount: formatMoneyExact(1000, w.settings.currency, "en") }));
    expect(b.text).not.toContain(formatMoneyExact(1500, w.settings.currency, "en"));
  });

  it("an OFFLINE payment (no card to return it to): told the entry was not accepted, with no refund line", async () => {
    const w = await offlineWorld(1500, "manual");
    const to = address("rej-off");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: to });
    await markRegistrationPaidOffline(w.owner, reg.registration.id);
    expect(await statusOf(reg.registration.id), "premise: paid offline, waiting for the organiser (W12)").toBe("paid");
    await rejectRegistration(w.owner, reg.registration.id);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
    const b = await body("registration_rejected", "registration", reg.registration.id, to);
    expect(b.text).not.toContain(formatMoneyExact(1500, w.settings.currency, "en"));
  });

  it("a refused Reject (an automatic-approval division) mails nothing", async () => {
    const w = await offlineWorld(1500, "auto");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("rej-auto") });
    await expect(rejectRegistration(w.owner, reg.registration.id)).rejects.toMatchObject({ status: 422 });
    expect(await rejectedRows(reg.registration.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// registration_promotion_lapsed (polish wave P5, P2 carry): a promoted entry was not paid in its window and went back to the waitlist
// ---------------------------------------------------------------------------------------------------------------------------------
// Before: the sweep put the entry back on the waitlist in silence; the registrant last heard "a spot opened up - pay by <deadline>".
// Now: the contact and every joined teammate are told, in the sweep's own transaction (the retry worker makes the first attempt). Once
// per PROMOTION: a second sweep tells nobody again, while an entry promoted again and lapsing again is told again.

const lapsedRows = async (regId: string) =>
  sql<{ id: string; recipient: string; status: string; attempts: number }[]>`
    select id, recipient, status, attempts from email_outbox where kind = 'registration_promotion_lapsed' and ref_type = 'registration' and ref_id = ${regId} order by created_at, id`;

/** Promote a waitlisted entry through the real waitlist code, then put its pay window in the past. */
async function promoteThenLapse(w: Awaited<ReturnType<typeof stripeWorld>>, regId: string, groupId: string) {
  await sql.begin((tx) => promoteWaitlistedRow(tx, regId, groupId, w.settings));
  const [row] = await sql<{ status: string; promotion_expires_at: Date | null }[]>`select status, promotion_expires_at from registrations where id = ${regId}`;
  expect(row!.status, "premise: promoted").toBe("pending");
  expect(row!.promotion_expires_at, "premise: a card promotion opens a pay window").not.toBeNull();
  await sql`update registrations set promotion_expires_at = now() - interval '1 minute' where id = ${regId}`;
}

describe.skipIf(!HAS_DB)("promotion lapsed: the sweep returns an unpaid promotion to the waitlist (real sweepRegistrations)", () => {
  it("the contact (their language) and the joined teammate (the club's) are told the entry is back on the waitlist; the worker makes the first attempt", async () => {
    const w = await stripeWorld(1500);
    await sql`update organizations set default_locale = 'fr' where id = ${w.orgId}`;
    const to = address("lapse");
    const joiner = address("lapse-j");
    const ref = `P5-${randomUUID().slice(0, 6)}`;
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { displayName: TEAM, contactEmail: to, status: "waitlisted", locale: "es", refCode: ref });
    await sql`update registration_groups set contact_name = ${CONTACT} where id = ${reg.registration.group_id}`;
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner", email: joiner });
    await promoteThenLapse(w, reg.registration.id, reg.registration.group_id);

    await sweepRegistrations(ORIGIN);
    expect(await statusOf(reg.registration.id), "premise: the real sweep lapsed it").toBe("waitlisted");
    const rows = await lapsedRows(reg.registration.id);
    expect(rows.map((r) => r.recipient.toLowerCase()).sort()).toEqual([to, joiner].sort());
    expect(rows.map((r) => r.attempts), "the sweep leaves the first attempt to the worker").toEqual([0, 0]);
    const es = await getDictionary("es", "emails");
    const fr = await getDictionary("fr", "emails");
    const toContact = await body("registration_promotion_lapsed", "registration", reg.registration.id, to);
    const toJoiner = await body("registration_promotion_lapsed", "registration", reg.registration.id, joiner);
    expect(toContact.text, "the contact's own es pick").toContain(String(es["registrationPromotionLapsed.title"]));
    expect(toJoiner.text, "a teammate follows the club's default (fr)").toContain(String(fr["registrationPromotionLapsed.title"]));
    expect(words(toContact.html)).toContain(CONTACT);
    expect(words(toJoiner.html)).toContain("Joe Joiner");
    expect(toContact.text).toContain(TEAM);
    expect(toContact.text).toContain("Open");
    expect(toContact.text).toContain(ref);
    expect(toJoiner.text).not.toContain(ref);
    expect(toContact.text, "the competition's public page, on the sweep's origin").toContain(`${ORIGIN}/live/`);
  });

  it("a second sweep tells nobody again; promoted AGAIN and lapsing again is a new promotion, so a new mail", async () => {
    const w = await stripeWorld(1500);
    const to = address("lapse-2");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: to, status: "waitlisted" });
    await promoteThenLapse(w, reg.registration.id, reg.registration.group_id);
    await sweepRegistrations(ORIGIN);
    expect(await lapsedRows(reg.registration.id)).toHaveLength(1);
    await sweepRegistrations(ORIGIN);
    expect(await lapsedRows(reg.registration.id), "nothing lapsed again").toHaveLength(1);

    await promoteThenLapse(w, reg.registration.id, reg.registration.group_id);
    await sweepRegistrations(ORIGIN);
    expect(await statusOf(reg.registration.id)).toBe("waitlisted");
    expect((await lapsedRows(reg.registration.id)).map((r) => r.recipient.toLowerCase()), "one mail per lapse").toEqual([to, to]);
  });

  it("the empty case: a promotion whose window is still open is not lapsed and not mailed", async () => {
    const w = await stripeWorld(1500);
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("lapse-open"), status: "waitlisted" });
    await sql.begin((tx) => promoteWaitlistedRow(tx, reg.registration.id, reg.registration.group_id, w.settings));
    await sweepRegistrations(ORIGIN);
    expect(await statusOf(reg.registration.id)).toBe("pending");
    expect(await lapsedRows(reg.registration.id)).toHaveLength(0);
  });

  it("a private competition: still told, with no link to a page that does not exist", async () => {
    const w = await stripeWorld(1500);
    await sql`update competitions set visibility = 'private' where id = ${w.competition.id}`;
    const to = address("lapse-priv");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: to, status: "waitlisted" });
    await promoteThenLapse(w, reg.registration.id, reg.registration.group_id);
    await sweepRegistrations(ORIGIN);
    const b = await body("registration_promotion_lapsed", "registration", reg.registration.id, to);
    expect(b.text).not.toContain("http");
  });
});

describe.skipIf(!HAS_DB)("the reject and lapse producers' own guards", () => {
  it("reject: once per entry and address - a second call queues nothing; an entry already ended (expired, rejected, withdrawn) is not told", async () => {
    const w = await offlineWorld(1500, "manual");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("rej-once") });
    await addMate(reg.registration.id, w.orgId, { name: "Joe Joiner", email: address("rej-once-j") });
    const queue = () => sql.begin((tx) => queueRegistrationRejectedMails(tx, { reg: reg.registration, refundCents: 0 }));
    expect(await queue(), "the contact and the joiner").toHaveLength(2);
    expect(await queue()).toEqual([]);
    expect(await rejectedRows(reg.registration.id)).toHaveLength(2);

    let checked = 0;
    for (const status of ["expired", "rejected", "withdrawn"] as const) {
      const ended = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address(`rej-g-${status}`), status });
      expect(await sql.begin((tx) => queueRegistrationRejectedMails(tx, { reg: ended.registration, refundCents: 0 })), status).toEqual([]);
      expect(await rejectedRows(ended.registration.id), status).toHaveLength(0);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("reject: a refund of zero is no refund line - the empty case of the amount", async () => {
    const w = await offlineWorld(1500, "manual");
    const to = address("rej-zero");
    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: to, status: "paid" });
    await sql.begin((tx) => queueRegistrationRejectedMails(tx, { reg: reg.registration, refundCents: 0 }));
    const en = await getDictionary("en", "emails");
    const refundLead = String(en["registrationRejected.textRefund"]).split("{amount}")[0]!;
    expect(refundLead.length, "premise: the refund sentence has words before the amount").toBeGreaterThan(5);
    expect((await body("registration_rejected", "registration", reg.registration.id, to)).text).not.toContain(refundLead);
  });

  it("lapse: an entry that was never promoted cannot lapse (nothing queued); a promoted one is told once per promotion", async () => {
    const w = await stripeWorld(1500);
    const never = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("lapse-never") });
    expect(never.registration.promoted_at, "premise: never promoted").toBeNull();
    expect(await sql.begin((tx) => queueRegistrationPromotionLapsedMails(tx, { reg: never.registration, origin: ORIGIN }))).toEqual([]);
    expect(await lapsedRows(never.registration.id)).toHaveLength(0);

    const reg = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("lapse-once"), status: "waitlisted" });
    await sql.begin((tx) => promoteWaitlistedRow(tx, reg.registration.id, reg.registration.group_id, w.settings));
    const promoted = await loadWithGroup(reg.registration.id);
    const queue = () => sql.begin((tx) => queueRegistrationPromotionLapsedMails(tx, { reg: promoted, origin: ORIGIN }));
    expect(await queue()).toHaveLength(1);
    expect(await queue(), "the same promotion: nothing more").toEqual([]);
  });
});
