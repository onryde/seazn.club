// Player payment page, Task 2 (plan 2026-11-11-player-payment-page): `payPageDocByToken`, the server reader that decides what
// `/r/pay/<token>` shows. One `it` per state of the ordered rule table in `registrations/pay-page.ts`; a final sweep proves every
// `PayPageState` was reached by the cases above it (zero reached fails).
//
// Tokens come from the REAL producer (`issuePayLink` + `recordPayToken`, as the chase mails will mint them), never a hand-inserted
// hash. The amount's source of truth is the Checkout params `createRegistrationCheckout` actually sends Stripe (captured from the
// mocked client), not `amount_cents` read separately.
//
// E2E / smoke: no surface yet (no route, no UI). Traced forward to T4's page spec `registration-pay-page.spec.ts` and T7's smoke
// `registrationPayPage`.
//
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const checkoutRetrieve = vi.fn();
  const checkoutExpire = vi.fn();
  return {
    checkoutCreate,
    stripe: { checkout: { sessions: { create: checkoutCreate, retrieve: checkoutRetrieve, expire: checkoutExpire } } },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import {
  issuePayLink,
  recordPayToken,
  payPageDocByToken,
  payPageState,
  putRegistrationSettings,
  PAY_PAGE_STATES,
  type PayPageState,
} from "../registrations";
import { createRegistrationCheckout } from "../registrations/checkout";
import { divisionCtx } from "../registrations/lookups";
import {
  stripeRig,
  seedRegistration,
  makeUser,
  SETTINGS_BASE,
  type StripeRigResult,
} from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: "cs_test_pp_" + randomUUID().slice(0, 8),
    url: "https://checkout.stripe.test/session",
  }));
});

/** Every state a case below reached; the final sweep counts it. */
const reached = new Set<PayPageState>();

/** A link exactly as a producer mints it: the real `issuePayLink`, its hash recorded against the entry's OWN org. Returns the raw
 *  token (the url's last path segment). */
async function linkFor(reg: { id: string; org_id: string }): Promise<string> {
  const { url, tokenHash } = issuePayLink("https://h");
  await recordPayToken(sql, { tokenHash, registrationId: reg.id, orgId: reg.org_id });
  const token = new URL(url).pathname.split("/").pop();
  if (!token) throw new Error(`no token in ${url}`);
  return token;
}

async function docOf(reg: { id: string; org_id: string }) {
  const doc = await payPageDocByToken(await linkFor(reg), new Date());
  if (doc) reached.add(doc.state);
  return doc;
}

async function cardEntry(over: Parameters<typeof seedRegistration>[3] = {}, rig?: StripeRigResult) {
  const r = rig ?? (await stripeRig({ feeCents: 1234 }));
  const seeded = await seedRegistration(r.competition.id, r.division.id, r.settings, over);
  return { rig: r, reg: seeded.registration };
}

const refCode = () => "PP" + randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

describe.skipIf(!HAS_DB)("payPageDocByToken (player payment page, Task 2)", () => {
  it("unknown token → null (empty case first)", async () => {
    expect(await payPageDocByToken("x".repeat(43), new Date())).toBeNull();
    expect(await payPageDocByToken("", new Date())).toBeNull();
  });

  it("unpaid card entry → pay; totalCents is what the Checkout params charge", async () => {
    const { rig, reg } = await cardEntry();
    const doc = await docOf(reg);
    expect(doc?.state).toBe("pay");

    // Source of truth: the line items createRegistrationCheckout sends Stripe for this same entry.
    const ctx = await divisionCtx(sql, reg.division_id);
    await createRegistrationCheckout(reg.group_id, [reg.id], ctx, "http://test.local", null);
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    const params = stripeMock.checkoutCreate.mock.calls[0]![0] as Stripe.Checkout.SessionCreateParams;
    const items = params.line_items ?? [];
    expect(items.length).toBeGreaterThan(0);
    const charged = items.reduce((s, li) => s + (li.price_data?.unit_amount ?? NaN) * (li.quantity ?? NaN), 0);
    expect(charged).toBe(1234);
    expect(doc!.totalCents).toBe(charged);
    expect(doc!.lines).toEqual(
      items.map((li) => ({ label: li.price_data!.product_data!.name, amountCents: li.price_data!.unit_amount! * li.quantity! })),
    );
    expect(doc!.currency).toBe(params.line_items![0]!.price_data!.currency);

    expect(doc).toMatchObject({
      registrationId: reg.id,
      groupId: reg.group_id,
      orgId: rig.orgId,
      competitionName: rig.competition.name,
      divisionName: "Open",
      startsOn: rig.competition.starts_on,
      endsOn: rig.competition.ends_on,
      entrantName: reg.display_name,
      refundedCents: 0,
      paidAt: null,
      paySessionId: null,
      paymentInstructions: null,
    });
    expect(doc!.deadline).toBeInstanceOf(Date);
    const [org] = await sql<{ name: string }[]>`select name from organizations where id = ${rig.orgId}`;
    expect(doc!.orgName).toBe(org!.name);
  });

  // Gap wave G4 (ledger :57 Q7): the page tells the view whether the organiser can take a card RIGHT NOW, read from the org row at
  // view time. The state stays `pay` (the entry still owes the money, and the Pay route keeps its 503 as the backstop); the view
  // shows a notice in place of the button. Both sides, on the same entry, so the flag is not a constant.
  it("Connect charges off → still `pay`, cardPaymentsOn false; back on → true (read at view time)", async () => {
    const { rig, reg } = await cardEntry();
    const token = await linkFor(reg);
    const on = await payPageDocByToken(token, new Date());
    expect(on?.state).toBe("pay");
    expect(on?.cardPaymentsOn).toBe(true);

    await sql`update organizations set stripe_charges_enabled = false where id = ${rig.orgId}`;
    const off = await payPageDocByToken(token, new Date());
    expect(off?.state).toBe("pay");
    expect(off?.cardPaymentsOn).toBe(false);

    await sql`update organizations set stripe_charges_enabled = true where id = ${rig.orgId}`;
    expect((await payPageDocByToken(token, new Date()))?.cardPaymentsOn).toBe(true);
  });

  it("offline entry → offline; instructions filled with the ref_code, no pay", async () => {
    const r = await stripeRig({ feeCents: 800 });
    const settings = await putRegistrationSettings(r.owner, r.division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 800,
      payment_instructions: "Bank transfer, quote {{reference}}",
    });
    const ref = refCode();
    const seeded = await seedRegistration(r.competition.id, r.division.id, settings, { refCode: ref });
    const doc = await docOf(seeded.registration);
    expect(doc?.state).toBe("offline");
    expect(doc!.paymentInstructions).toBe(`Bank transfer, quote ${ref}`);
    expect(doc!.refCode).toBe(ref);
  });

  it("offline with no division instructions falls back to the org's", async () => {
    const r = await stripeRig({ feeCents: 800 });
    await sql`update organizations set payment_instructions = ${"Org pay: {{reference}}"} where id = ${r.orgId}`;
    const settings = await putRegistrationSettings(r.owner, r.division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 800,
    });
    const ref = refCode();
    const seeded = await seedRegistration(r.competition.id, r.division.id, settings, { refCode: ref });
    const doc = await docOf(seeded.registration);
    expect(doc?.state).toBe("offline");
    expect(doc!.paymentInstructions).toBe(`Org pay: ${ref}`);
  });

  it("division switched card→offline after the token was minted → offline (Review Focus 3)", async () => {
    const { rig, reg } = await cardEntry();
    const token = await linkFor(reg);
    expect((await payPageDocByToken(token, new Date()))?.state).toBe("pay");
    await putRegistrationSettings(rig.owner, rig.division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 1234,
      payment_instructions: "Cash on the day",
    });
    const doc = await payPageDocByToken(token, new Date());
    expect(doc?.state).toBe("offline");
    expect(doc!.paymentInstructions).toBe("Cash on the day");
  });

  // Gap wave G5 (ledger: "cart payment_method fallback (division method null) untested"). `registration_settings.payment_method` is
  // NOT NULL, so the division's method is null only when the division has no settings row: then the cart's own method decides.
  it("division with no settings row → the cart's method decides: an offline cart reads offline, a card cart reads pay", async () => {
    const outcomes: string[] = [];
    for (const cart of ["offline", "stripe"] as const) {
      const { rig, reg } = await cardEntry();
      await sql`update registration_groups set payment_method = ${cart} where id = ${reg.group_id}`;
      await sql`delete from registration_settings where division_id = ${rig.division.id}`;
      const [left] = await sql<{ n: string }[]>`select count(*)::text as n from registration_settings where division_id = ${rig.division.id}`;
      expect(left!.n, `${cart}: premise, no settings row`).toBe("0");
      outcomes.push(`${cart}:${(await docOf(reg))?.state}`);
    }
    expect(outcomes).toEqual(["offline:offline", "stripe:pay"]);
  });

  it("confirmed card entry → paid, paidAt = the registration.confirmed row's created_at", async () => {
    const { rig, reg } = await cardEntry({ status: "confirmed" });
    const at = new Date("2026-10-01T10:00:00Z");
    await sql`
      insert into competition_events (competition_id, org_id, type, payload, actor_id, created_at)
      values (${rig.competition.id}, ${rig.orgId}, 'registration.confirmed',
              ${sql.json({ registration_id: reg.id, paid: true })}, null, ${at})`;
    // A row for ANOTHER entry, earlier, must not be taken.
    await sql`
      insert into competition_events (competition_id, org_id, type, payload, actor_id, created_at)
      values (${rig.competition.id}, ${rig.orgId}, 'registration.confirmed',
              ${sql.json({ registration_id: randomUUID(), paid: true })}, null, ${new Date("2026-09-01T10:00:00Z")})`;
    const doc = await docOf(reg);
    expect(doc?.state).toBe("paid");
    expect(doc!.paidAt?.toISOString()).toBe(at.toISOString());
  });

  it("confirmed with no audit row → paid, paidAt null", async () => {
    const { reg } = await cardEntry({ status: "confirmed" });
    const doc = await docOf(reg);
    expect(doc?.state).toBe("paid");
    expect(doc!.paidAt).toBeNull();
  });

  it("confirmed entry whose pay window has passed stays paid (rule 3 outranks rule 4)", async () => {
    const { reg } = await cardEntry({ status: "paid" });
    await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${reg.group_id}`;
    await sql`update registrations set promotion_expires_at = now() - interval '1 hour' where id = ${reg.id}`;
    const doc = await docOf(reg);
    expect(doc?.state).toBe("paid");
  });

  it("refunded_cents 500 → refunded", async () => {
    const { reg } = await cardEntry({ status: "confirmed" });
    await sql`update registrations set refunded_cents = 500 where id = ${reg.id}`;
    const doc = await docOf(reg);
    expect(doc?.state).toBe("refunded");
    expect(doc!.refundedCents).toBe(500);
  });

  it("pending, expires_at in the past → deadline_passed", async () => {
    const { reg } = await cardEntry();
    await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${reg.group_id}`;
    const doc = await docOf(reg);
    expect(doc?.state).toBe("deadline_passed");
    expect(doc!.deadline!.getTime()).toBeLessThan(Date.now());
  });

  it("promoted entry whose promotion_expires_at passed while the group expires_at is in the future → deadline_passed", async () => {
    const { reg } = await cardEntry();
    const [g] = await sql<{ expires_at: Date }[]>`select expires_at from registration_groups where id = ${reg.group_id}`;
    expect(g!.expires_at.getTime()).toBeGreaterThan(Date.now()); // the wrong column would answer `pay`
    await sql`update registrations set promoted_at = now() - interval '3 hours',
                promotion_expires_at = now() - interval '1 hour' where id = ${reg.id}`;
    const doc = await docOf(reg);
    expect(doc?.state).toBe("deadline_passed");
  });

  it("expires_at null → pay, deadline null", async () => {
    const { reg } = await cardEntry();
    await sql`update registration_groups set expires_at = null where id = ${reg.group_id}`;
    const doc = await docOf(reg);
    expect(doc?.state).toBe("pay");
    expect(doc!.deadline).toBeNull();
  });

  it("status expired → deadline_passed", async () => {
    const { reg } = await cardEntry({ status: "expired" });
    expect((await docOf(reg))?.state).toBe("deadline_passed");
  });

  it("waitlisted → waitlisted", async () => {
    const { reg } = await cardEntry({ status: "waitlisted" });
    expect((await docOf(reg))?.state).toBe("waitlisted");
  });

  it("withdrawn → null, rejected → null (positive pair: the same entry pending answers)", async () => {
    for (const status of ["withdrawn", "rejected"] as const) {
      const { reg } = await cardEntry();
      const token = await linkFor(reg);
      expect(await payPageDocByToken(token, new Date())).not.toBeNull();
      await sql`update registrations set status = ${status} where id = ${reg.id}`;
      expect(await payPageDocByToken(token, new Date())).toBeNull();
    }
  });

  it("locale follows the mail: entry pick, then linked account, then org default", async () => {
    const rig = await stripeRig({ feeCents: 1234 });
    await sql`update organizations set default_locale = 'es' where id = ${rig.orgId}`;

    const picked = await cardEntry({ locale: "nl" }, rig);
    expect((await docOf(picked.reg))!.locale).toBe("nl");

    const linked = await cardEntry({ locale: null }, rig);
    const userId = await makeUser("fr-player");
    await sql`update users set locale = 'fr' where id = ${userId}`;
    await sql`update registration_groups set user_id = ${userId} where id = ${linked.reg.group_id}`;
    expect((await docOf(linked.reg))!.locale).toBe("fr");

    const neither = await cardEntry({ locale: null }, rig);
    expect((await docOf(neither.reg))!.locale).toBe("es");
  });

  it("team entry lists members in roster order; individual lists none", async () => {
    const { reg: team } = await cardEntry({ players: [{ name: "Ada First" }, { name: "Bea Second" }] });
    expect((await docOf(team))!.members).toEqual(["Ada First", "Bea Second"]);
    const { reg: solo } = await cardEntry();
    expect((await docOf(solo))!.members).toEqual([]);
  });

  it("a status no rule covers is refused by name, not mapped to a default state", () => {
    const bogus = { status: "archived" as never, refundedCents: 0, deadline: null, method: "stripe" as const };
    expect(() => payPageState(bogus, new Date())).toThrow(/no rule covers registration status "archived"/);
  });

  it("every PayPageState is reached", () => {
    expect(PAY_PAGE_STATES.length).toBeGreaterThan(0);
    expect(reached.size).toBeGreaterThan(0);
    expect([...reached].sort()).toEqual([...PAY_PAGE_STATES].sort());
    expect(reached.size).toBe(PAY_PAGE_STATES.length);
  });
});
