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

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import { openBody } from "@/server/email-outbox/seal";
import { formatDeadline } from "@/lib/email-templates/registration";
import {
  handleRegistrationCheckoutCompleted,
  notifyPromoted,
  notifySubmitted,
  payDeadlineOf,
  promoteWaitlistedRow,
  putRegistrationSettings,
  refundRegistration,
  sendPaymentReminder,
  divisionCtx,
} from "../registrations";
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
