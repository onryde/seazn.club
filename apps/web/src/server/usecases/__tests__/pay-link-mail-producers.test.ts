// Player payment page (plan 2026-11-11-player-payment-page, Task 5): every mail that chases an unpaid registration links OUR pages,
// never a raw Stripe Checkout URL. Each producer is driven through its REAL entry point; its queued body is opened with the outbox's
// own `openBody`, and the link inside is resolved back to the entry through `registrationIdByPayToken`.
//
//   P1 sweep pass 1a, P2 sweep pass 1b       -> `${origin}/r/pay/<token>` (card)
//   P3 notifyPromoted (card, offline)        -> `${origin}/r/pay/<token>`; a free promotion links nothing and mints nothing
//   P4 sendPaymentReminder (card, offline)   -> `${origin}/r/pay/<token>`
//   P5 notifySubmitted (card cart)           -> the cart's own token-bearing status page; no pay-page token
//
// Tokens are captured from the REAL producer (`issuePayLink` is wrapped, not replaced), never hand-inserted. Stripe is mocked and
// asserted UNCALLED: no chase mail mints a Checkout session any more. The provider answers 503 for every send here, so a row the
// request path attempted at once (P4) is still `queued` and still holds its sealed body.
//
// Sport: not applicable. The mail and its link do not vary by sport; the axes that vary are the method and the locale.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  return { checkoutCreate, stripe: { checkout: { sessions: { create: checkoutCreate, retrieve: vi.fn(), expire: vi.fn() } } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// The real `issuePayLink`, wrapped so the test learns every token a producer minted (the raw token leaves only inside its url).
const issued = vi.hoisted(() => ({ tokens: [] as string[] }));
vi.mock("@/server/usecases/registrations/pay-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/registrations/pay-token")>();
  return {
    ...actual,
    issuePayLink: (origin: string) => {
      const link = actual.issuePayLink(origin);
      issued.tokens.push(link.url.slice(link.url.lastIndexOf("/") + 1));
      return link;
    },
  };
});

// The sweep's queue write fails once AFTER its insert, armed immediately before the call under test: the whole queue transaction
// (token, row, mark) must roll back and the lease must be released.
const queueGate = vi.hoisted(() => ({ failAfterInsertOnce: false }));
vi.mock("@/server/email-outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email-outbox")>();
  return {
    ...actual,
    enqueueEmailOnce: async (...args: Parameters<typeof actual.enqueueEmailOnce>) => {
      const id = await actual.enqueueEmailOnce(...args);
      if (queueGate.failAfterInsertOnce) {
        queueGate.failAfterInsertOnce = false;
        throw new Error("the queue write failed after its insert");
      }
      return id;
    },
  };
});

import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { openBody } from "@/server/email-outbox/seal";
import {
  divisionCtx,
  notifyPromoted,
  notifySubmitted,
  promoteWaitlistedRow,
  putRegistrationSettings,
  registrationIdByPayToken,
  sendPaymentReminder,
  sweepRegistrations,
} from "../registrations";
import { stubOutboxEnv } from "./_invite-mail";
import { SETTINGS_BASE, asOwner, loadWithGroup, rig, seedOrg, seedRegistration, stripeRig } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://pay-mail.test";
const PAY_LINK = /\/r\/pay\/([A-Za-z0-9_-]{43})/g;

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
  queueGate.failAfterInsertOnce = false;
  issued.tokens.length = 0;
  deliverMock.mockReset().mockImplementation(later);
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: `cs_test_${randomUUID().slice(0, 8)}`,
    url: "https://checkout.stripe.com/c/pay/cs_test_should_never_be_minted",
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Worlds and readers
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (tag: string): string => `t5-${tag}-${randomUUID().slice(0, 8)}@test.local`;

async function stripeWorld(feeCents = 900) {
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

type World = Awaited<ReturnType<typeof stripeWorld>> | Awaited<ReturnType<typeof offlineWorld>>;

/** A waitlisted entry promoted for real (`promoteWaitlistedRow`), read back with its group. */
async function promoted(w: World, email: string, locale: string | null = null) {
  const waiting = await seedRegistration(w.competition.id, w.division.id, w.settings, { status: "waitlisted", contactEmail: email, locale });
  await sql.begin((tx) => promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, w.settings));
  return loadWithGroup(waiting.registration.id);
}

/** The newest body of (kind, ref), opened with the outbox's own reader. A row whose body is gone is a failure here. */
async function body(kind: string, refType: string, refId: string): Promise<{ html: string; text: string }> {
  const [row] = await sql<{ body_sealed: Uint8Array | null; status: string }[]>`
    select body_sealed, status from email_outbox
     where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}
     order by created_at desc, id desc limit 1`;
  expect(row, `a ${kind} row for ${refType}/${refId}`).toBeDefined();
  expect(row!.body_sealed, `the ${kind} row still holds its body (status ${row!.status})`).not.toBeNull();
  return openBody(row!.body_sealed!);
}

const tokensFor = async (regId: string): Promise<number> =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from registration_pay_tokens where registration_id = ${regId}`)[0]!.n);

const rowsOf = async (kind: string, regId: string): Promise<number> =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from email_outbox where kind = ${kind} and ref_type = 'registration' and ref_id = ${regId}`)[0]!.n);

function noCheckout(label: string, b: { html: string; text: string }): void {
  for (const [part, s] of Object.entries(b)) {
    expect(s, `${label} ${part}: no Stripe Checkout host`).not.toContain("checkout.stripe.com");
    expect(s, `${label} ${part}: no Checkout session id`).not.toContain("cs_test_");
  }
}

/** The one pay-page link in a body: present in html AND text, issued by the producer under test, and it opens THIS entry. */
async function linksThisEntry(label: string, b: { html: string; text: string }, regId: string): Promise<string> {
  const inText = [...b.text.matchAll(PAY_LINK)].map((m) => m[1]!);
  const inHtml = [...b.html.matchAll(PAY_LINK)].map((m) => m[1]!);
  expect(new Set(inText).size, `${label}: exactly one pay-page token in the text`).toBe(1);
  expect(new Set(inHtml), `${label}: the html links the same one token`).toEqual(new Set(inText));
  const token = inText[0]!;
  expect(b.text, `${label}: the link is under the producer's origin`).toContain(`${ORIGIN}/r/pay/${token}`);
  expect(b.html).toContain(`${ORIGIN}/r/pay/${token}`);
  expect(issued.tokens, `${label}: the token came from the real producer`).toContain(token);
  expect(await registrationIdByPayToken(token), `${label}: the token opens this entry`).toBe(regId);
  return token;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The producer sweep
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("every chase mail links our pages, never a Checkout URL (DB)", () => {
  it("sweeps the seven producers: P1-P4 link /r/pay/<token> for this entry, P5 links the cart's status page; Stripe is never called", async () => {
    let checked = 0;

    // P1 - sweep pass 1a: a stripe cart due within 24 hours.
    {
      const w = await stripeWorld();
      const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("p1") });
      await sql`update registration_groups set expires_at = now() + interval '10 hours' where id = ${registration.group_id}`;
      await sweepRegistrations(ORIGIN);
      const b = await body("payment_reminder", "registration", registration.id);
      noCheckout("P1", b);
      await linksThisEntry("P1", b, registration.id);
      checked += 1;
    }

    // P2 - sweep pass 1b: a promoted entry due within 24 hours of its OWN deadline.
    {
      const w = await stripeWorld();
      const reg = await promoted(w, address("p2"));
      await sql`update registrations set promotion_expires_at = now() + interval '10 hours' where id = ${reg.id}`;
      await sweepRegistrations(ORIGIN);
      const b = await body("payment_reminder", "registration", reg.id);
      noCheckout("P2", b);
      await linksThisEntry("P2", b, reg.id);
      checked += 1;
    }

    // P3 - the promotion notice, card and offline.
    for (const kind of ["card", "offline"] as const) {
      const w = kind === "card" ? await stripeWorld() : await offlineWorld();
      const reg = await promoted(w, address(`p3-${kind}`));
      expect(reg.amount_cents, `P3 ${kind}: premise, the promoted entry owes a fee`).toBeGreaterThan(0);
      await notifyPromoted(reg, await divisionCtx(sql, w.division.id), w.settings, ORIGIN, { firstAttempt: "worker" });
      const b = await body("registration_promoted", "registration", reg.id);
      noCheckout(`P3 ${kind}`, b);
      await linksThisEntry(`P3 ${kind}`, b, reg.id);
      if (kind === "offline") expect(b.text, "P3 offline keeps its instructions").toContain("Pay at the desk");
      checked += 1;
    }

    // P4 - the organiser's reminder, card and offline.
    for (const kind of ["card", "offline"] as const) {
      const w = kind === "card" ? await stripeWorld() : await offlineWorld();
      const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address(`p4-${kind}`) });
      await sendPaymentReminder(w.owner, registration.id, ORIGIN);
      const b = await body("payment_reminder", "registration", registration.id);
      noCheckout(`P4 ${kind}`, b);
      await linksThisEntry(`P4 ${kind}`, b, registration.id);
      if (kind === "offline") expect(b.text, "P4 offline keeps its instructions").toContain("Pay at the desk");
      checked += 1;
    }

    // P5 - the cart confirmation of a card cart: the cart's own status page, and no pay-page token.
    {
      const w = await stripeWorld();
      const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("p5") });
      const before = issued.tokens.length;
      await notifySubmitted(seeded.registration.group_id, ORIGIN, seeded.access_token);
      const b = await body("registration_confirmation", "registration_group", seeded.registration.group_id);
      noCheckout("P5", b);
      const statusUrl =
        `${ORIGIN}${routes.publicRegisterStatus(w.orgSlug, w.competition.slug)}` +
        `?rid=${seeded.registration.group_id}&token=${encodeURIComponent(seeded.access_token)}`;
      expect(b.text, "P5 text links the cart's status page").toContain(statusUrl);
      expect(b.html, "P5 html links the cart's status page").toContain(statusUrl.replace(/&/g, "&amp;"));
      expect(b.text.match(PAY_LINK), "P5 carries no pay-page link").toBeNull();
      expect(issued.tokens.length, "P5 mints no pay-page token").toBe(before);
      expect(await tokensFor(seeded.registration.id)).toBe(0);
      checked += 1;
    }

    expect(stripeMock.checkoutCreate, "no chase mail mints a Checkout session").toHaveBeenCalledTimes(0);
    expect(checked, "anti-vacuity: all seven producers were driven").toBe(7);
  });

  it("empty case: a free promotion links nothing and mints no token", async () => {
    // Manual approval: a free AUTO promotion seats at once (and needs the seat gate); a manual one stays pending and is mailed.
    const w = await offlineWorld(0, "manual");
    const reg = await promoted(w, address("free"));
    expect(reg.amount_cents, "premise: the promotion is free").toBe(0);
    await notifyPromoted(reg, await divisionCtx(sql, w.division.id), w.settings, ORIGIN, { firstAttempt: "worker" });
    const b = await body("registration_promoted", "registration", reg.id);
    expect(b.text.match(PAY_LINK)).toBeNull();
    expect(b.html.match(PAY_LINK)).toBeNull();
    expect(issued.tokens).toHaveLength(0);
    expect(await tokensFor(reg.id)).toBe(0);

    // The positive pair: the same division with a fee links the page.
    const settings = await putRegistrationSettings(w.owner, w.division.id, { ...SETTINGS_BASE, fee_cents: 700, payment_method: "offline", approval: "manual" });
    const paid = await promoted({ ...w, settings }, address("free-pair"));
    await notifyPromoted(paid, await divisionCtx(sql, w.division.id), settings, ORIGIN, { firstAttempt: "worker" });
    await linksThisEntry("fee pair", await body("registration_promoted", "registration", paid.id), paid.id);
  });

  it("a card cart with nothing left to pay gets no Pay button; the status link is still there", async () => {
    const w = await stripeWorld();
    const seeded = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("p5-paid"), status: "confirmed" });
    await notifySubmitted(seeded.registration.group_id, ORIGIN, seeded.access_token);
    const b = await body("registration_confirmation", "registration_group", seeded.registration.group_id);
    const payNow = JSON.parse(readFileSync(fileURLToPath(new URL("../../../dictionaries/en/emails.json", import.meta.url)), "utf8"))[
      "registration.payNow"
    ] as string;
    const label = payNow.split("{")[0]!.trim();
    expect(label.length, "premise: the en Pay-now label is non-empty").toBeGreaterThan(0);
    expect(b.html, "no Pay button on a cart with nothing owed").not.toContain(label);
    expect(b.text).toContain(`rid=${seeded.registration.group_id}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The sequence: a second sweep, a failure inside the queue transaction
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the sweep's pay-page reminder, called twice and failing mid-transaction (DB)", () => {
  it("sweep 1a twice: one mail, one token (the once-key and the mark hold)", async () => {
    const w = await stripeWorld();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("twice") });
    await sql`update registration_groups set expires_at = now() + interval '10 hours' where id = ${registration.group_id}`;
    await sweepRegistrations(ORIGIN);
    await sweepRegistrations(ORIGIN);
    expect(await rowsOf("payment_reminder", registration.id)).toBe(1);
    expect(await tokensFor(registration.id)).toBe(1);
  });

  it("a throw inside the queue transaction releases the lease and leaves zero tokens and zero mails; the next sweep sends", async () => {
    const w = await stripeWorld();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("throw") });
    // The earliest deadline in the sweep's order (`order by g.expires_at`), so ours is the first row the armed gate meets.
    await sql`update registration_groups set expires_at = now() + interval '2 minutes' where id = ${registration.group_id}`;
    queueGate.failAfterInsertOnce = true;
    await sweepRegistrations(ORIGIN);
    expect(queueGate.failAfterInsertOnce, "premise: the queue write was reached and failed").toBe(false);
    const [m] = await sql<{ submit_reminded_at: Date | null; submit_reminder_claimed_at: Date | null }[]>`
      select submit_reminded_at, submit_reminder_claimed_at from registrations where id = ${registration.id}`;
    expect(m!.submit_reminded_at, "not marked").toBeNull();
    expect(m!.submit_reminder_claimed_at, "the lease was released").toBeNull();
    expect(await rowsOf("payment_reminder", registration.id), "the row rolled back").toBe(0);
    expect(await tokensFor(registration.id), "the token rolled back with the row").toBe(0);
    // The positive pair: the next sweep sends it, once.
    await sweepRegistrations(ORIGIN);
    expect(await rowsOf("payment_reminder", registration.id)).toBe(1);
    expect(await tokensFor(registration.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Locale, and the source guard
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the link's copy is in the registrant's language (DB)", () => {
  it("an nl entry's offline reminder carries the nl paymentReminder.viewDetails copy", async () => {
    const nl = JSON.parse(readFileSync(fileURLToPath(new URL("../../../dictionaries/nl/emails.json", import.meta.url)), "utf8")) as Record<string, string>;
    const en = JSON.parse(readFileSync(fileURLToPath(new URL("../../../dictionaries/en/emails.json", import.meta.url)), "utf8")) as Record<string, string>;
    const expected = nl["paymentReminder.viewDetails"];
    expect(expected, "the nl key exists").toBeTruthy();
    expect(expected, "the nl copy is not the en copy").not.toBe(en["paymentReminder.viewDetails"]);
    const w = await offlineWorld();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("nl"), locale: "nl" });
    await sendPaymentReminder(w.owner, registration.id, ORIGIN);
    const b = await body("payment_reminder", "registration", registration.id);
    expect(b.html).toContain(expected!);
    expect(b.text).toContain(nl["paymentReminder.textViewDetails"]!);
  });
});

describe("the mail's source has no raw-link field left", () => {
  it("checkoutUrl and payUrl occur 0 times in the three templates and mail.ts", () => {
    const files = [
      "../../../lib/email-templates/payment-reminder.ts",
      "../../../lib/email-templates/registration-promoted.ts",
      "../../../lib/email-templates/registration.ts",
      "../registrations/mail.ts",
    ];
    let checked = 0;
    for (const f of files) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(src.length, `${f} was read`).toBeGreaterThan(0);
      expect(src.match(/checkoutUrl/g) ?? [], `${f}: checkoutUrl`).toHaveLength(0);
      expect(src.match(/payUrl/g) ?? [], `${f}: payUrl`).toHaveLength(0);
      checked += 1;
    }
    expect(checked).toBe(files.length);
  });
});
