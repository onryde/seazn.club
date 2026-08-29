// RS007 code-review follow-up — findings #8, #10, #13 (docs/superpowers/specs/
// 2026-08-16-registration-redesign-prompts/_INDEX.md, "### The rest, in the
// reviewer's own terms"). All three land on the public status page's money
// state, sourced from registrations.ts:
//
//  #8  — resumeRegistrationCheckout never re-checked whether the deadline it
//        was about to mint a Stripe session against had already passed. The
//        sweep that expires an overdue pending entry (and auto-refunds a
//        Stripe one) is hourly (cron "37 * * * *"), so a stale tab or a
//        direct POST between the deadline and the next sweep could still pay
//        into a cart the very next sweep auto-refunds — money in, straight
//        back out. The CLIENT-side half (resolveMoneyState returning
//        window_closed) is covered in view-model.test.ts; this file covers
//        the SERVER-side re-check, the load-bearing half.
//
//  #10 — the per-entry money state (buildGroupStatusView → resolveMoneyState)
//        and notifyPromoted's own pay-link/instructions choice were both
//        decided from registration_groups.payment_method (the CART's shared
//        envelope column). promoteWaitlistedRow only overwrites that column
//        when no OTHER entry in the cart is still 'pending' (see its own doc
//        comment) — so a cart of {free/manual-approval → pending} + {paid
//        stripe → waitlisted} can commit with payment_method null, and stay
//        null forever past a promotion whose own DIVISION genuinely charges.
//        Both read sites now resolve the entry's own division method
//        (registration_settings.payment_method) instead — never the cart's.
//
//  #13 — (a) the deadline the status page renders ignored the org's own
//        timezone entirely (hardcoded UTC, entry-card.tsx — covered in that
//        component's own test coverage); buildGroupStatusView now threads
//        the org's already-resolved timezone (refundTz) onto GroupStatusView
//        as org_timezone, proven here at the data layer. (b) notifyPromoted's
//        own promoted-email sent the GROUP's shared expires_at as
//        payDeadline, while the lapse sweep enforces the ENTRY's own
//        promotion_expires_at (see sweepRegistrations pass 1b) — an entrant
//        paying by the emailed date could still be lapsed. Fixed to send the
//        entry's own clock.
//
// The buildGroupStatusView-backed suite needs real Postgres; skipped without
// DATABASE_URL (matches every sibling usecase suite in this directory). The
// notifyPromoted suite needs no DB at all for its deadline/offline-branch
// assertions — see its own header below.
import { beforeEach, describe, expect, it, vi } from "vitest";

const emailMock = vi.hoisted(() => ({ promoted: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendRegistrationPromotedEmail: emailMock.promoted };
});

// vi.mock is hoisted per-module and does not travel through an import (same
// note as every sibling registration suite's own header) — declared here,
// not in _registration-fixtures.ts.
const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  return {
    checkoutCreate,
    stripe: { checkout: { sessions: { create: checkoutCreate } } },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import {
  resumeRegistrationCheckout,
  promoteWaitlistedRow,
  groupById,
  notifyPromoted,
  divisionCtx,
  putRegistrationSettings,
  type DivisionCtx,
  type RegistrationSettingsRow,
  type RegistrationWithGroupRow,
} from "../registrations";
import { stripeRig, seedRegistration, loadWithGroup, rig, seedOrg, asOwner, SETTINGS_BASE } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  let n = 0;
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: "cs_test_review_" + ++n + "_" + Math.random().toString(36).slice(2, 8),
    url: "https://checkout.stripe.test/session",
  }));
  emailMock.promoted.mockClear();
});

describe.skipIf(!HAS_DB)("#8 — resumeRegistrationCheckout re-checks the deadline it is about to mint against", () => {
  it("refuses once the CART's shared deadline has passed — never mints a session the very next sweep would expire and auto-refund", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    // The hourly sweep has not run yet — the row is still 'pending' even
    // though its own window closed a minute ago (the exact stale-tab /
    // direct-POST window the finding describes).
    await sql`update registration_groups set expires_at = now() - interval '1 minute'
              where id = ${res.registration.group_id}`;

    await expect(
      resumeRegistrationCheckout(res.registration.id, res.access_token, "http://test.local"),
    ).rejects.toMatchObject({ status: 422 });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("refuses once the ENTRY's own promotion deadline has passed, even while the cart's shared (possibly later) deadline has not — same precedence effectivePayDeadline documents client-side", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const waiting = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    // The entry's OWN clock (freshly opened by the promotion above) lapsed;
    // the cart's shared clock has not.
    await sql`update registrations set promotion_expires_at = now() - interval '1 minute'
              where id = ${waiting.registration.id}`;
    const [group] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${waiting.registration.group_id}`;
    expect(group!.expires_at!.getTime(), "sanity: the cart's own clock is still ahead").toBeGreaterThan(Date.now());

    await expect(
      resumeRegistrationCheckout(waiting.registration.id, waiting.access_token, "http://test.local"),
    ).rejects.toMatchObject({ status: 422 });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("still mints normally while the deadline is in the future (sanity — not simply refusing every pending stripe entry)", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    const { checkout_url } = await resumeRegistrationCheckout(
      res.registration.id,
      res.access_token,
      "http://test.local",
    );
    expect(checkout_url).toBe("https://checkout.stripe.test/session");
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!HAS_DB)("#10/#13a — buildGroupStatusView resolves per-entry facts off the DIVISION, and threads the org timezone", () => {
  it("a promoted entry's payment_method comes from its OWN division, even though the cart's shared column stayed null (the promoteWaitlistedRow suppressed-write precondition)", async () => {
    const { orgId, competition, division, settings } = await stripeRig({ feeCents: 500 });
    await sql`update organizations set timezone = 'Asia/Kolkata' where id = ${orgId}`;
    const waiting = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    // Force the exact suppressed-write precondition finding #10 describes —
    // promoteWaitlistedRow only overwrites this column when no OTHER entry
    // in the cart is still 'pending'; simulating that guard firing directly
    // isolates this test to what buildGroupStatusView must get right,
    // without needing to also construct a second division/entry.
    await sql`update registration_groups set payment_method = null where id = ${waiting.registration.group_id}`;

    const view = await groupById(waiting.registration.group_id, waiting.access_token);
    expect(view.payment_method, "sanity: the cart column really is the suppressed/stale null").toBeNull();
    const entry = view.entries.find((e) => e.id === waiting.registration.id)!;
    // Reverting the fix (reading the cart's null payment_method instead of
    // the division's) makes this null/undefined instead of 'stripe' — the
    // status page would then render offline_due with no PayButton, exactly
    // finding #10's own reproduction.
    expect(entry.payment_method).toBe("stripe");
    // #13(a): the org's own timezone, threaded through unchanged from the
    // SAME refundTz buildGroupStatusView already resolves for refund policy.
    expect(view.org_timezone).toBe("Asia/Kolkata");
  });

  it("payment instructions resolve off the representative entry's own division method too — not just resolveMoneyState's half of the same bug", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 1000,
      payment_instructions: "Bank: Test Bank, quoting {{reference}}",
    });
    const res = await seedRegistration(competition.id, division.id, settings, { status: "pending" });
    // Same suppressed-write precondition as above.
    await sql`update registration_groups set payment_method = null where id = ${res.registration.group_id}`;

    const view = await groupById(res.registration.group_id, res.access_token);
    expect(view.payment_method).toBeNull(); // sanity
    expect(view.payment_instructions).toContain("Test Bank");
  });

  it("org_timezone falls back to UTC when the org has none set — same fallback resolveVenueTz already documents", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    await sql`update organizations set timezone = null where id = ${orgId}`;
    const res = await seedRegistration(competition.id, division.id, settings);

    const view = await groupById(res.registration.group_id, res.access_token);
    expect(view.org_timezone).toBe("UTC");
  });
});

describe.skipIf(!HAS_DB)("#10 — notifyPromoted mints a real pay link off the DIVISION's method (DB-backed: exercises the real Stripe-mint branch)", () => {
  it("mints a checkout URL even though the cart's shared payment_method write was suppressed by a still-pending sibling", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const waiting = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    await sql`update registration_groups set payment_method = null where id = ${waiting.registration.group_id}`;

    const promoted = await loadWithGroup(waiting.registration.id);
    expect(promoted.payment_method).toBeNull(); // sanity: reproduces the bug's precondition
    const ctx = await divisionCtx(sql, division.id);

    await notifyPromoted(promoted, ctx, settings, "http://test.local");

    // Reverting the fix (reading promoted.payment_method, the null cart
    // column) never even tries Stripe here — this is the "no way to pay"
    // half of finding #10's own name.
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(emailMock.promoted).toHaveBeenCalledTimes(1);
    expect(emailMock.promoted.mock.calls[0]![0].payUrl).toBe("https://checkout.stripe.test/session");
  });
});

// Pure-function coverage for notifyPromoted's other two fixed inputs — no DB,
// no Stripe call (both fixtures below use an OFFLINE division so the
// payUrl-minting branch, which needs a real DB row, is never entered; the
// STRIPE half of the division-vs-cart method fix is proven DB-backed above).
describe("#10/#13b — notifyPromoted (pure function, offline branch — no DB)", () => {
  function fakeCtx(over: Partial<DivisionCtx> = {}): DivisionCtx {
    return {
      id: "div-1",
      competition_id: "comp-1",
      org_id: "org-1",
      comp_name: "Summer Smash",
      comp_slug: "summer-smash",
      comp_visibility: "public",
      starts_on: "2026-09-15",
      ends_on: "2026-09-20",
      div_slug: "open",
      org_slug: "riverside",
      org_name: "Riverside CC",
      default_locale: null,
      payment_instructions: "org fallback instructions",
      charges_enabled: true,
      org_timezone: null,
      currency: "gbp",
      ...over,
    };
  }

  function fakeSettings(over: Partial<RegistrationSettingsRow> = {}): RegistrationSettingsRow {
    return {
      division_id: "div-1",
      enabled: true,
      entrant_kind: "individual",
      opens_at: null,
      closes_at: null,
      capacity: null,
      fee_cents: 500,
      refund_lock_at: null,
      form_fields: [],
      payment_method: "offline",
      payment_instructions: null,
      approval: "auto",
      allow_free_agents: false,
      updated_at: null,
      ...over,
    };
  }

  function fakePromoted(over: Partial<RegistrationWithGroupRow> = {}): RegistrationWithGroupRow {
    const now = new Date();
    return {
      id: "reg-1",
      division_id: "div-1",
      org_id: "org-1",
      status: "pending",
      display_name: "Team Alpha",
      answers: {},
      amount_cents: 500,
      refunded_cents: 0,
      entrant_id: null,
      promoted_at: now,
      promotion_expires_at: null,
      waitlisted_at: null,
      withdrawn_at: null,
      group_id: "grp-1",
      join_code: null,
      free_agent: false,
      created_at: now,
      updated_at: now,
      contact_name: "Alex Test",
      contact_email: "alex@test.local",
      user_id: null,
      locale: null,
      ref_code: "SZ-TEST-01",
      access_token_hash: "hash",
      currency: "gbp",
      // The CART's own column — deliberately null in every fixture below,
      // reproducing finding #10's own suppressed-write precondition.
      payment_method: null,
      checkout_session_id: null,
      payment_intent_id: null,
      expires_at: null,
      reminded_at: null,
      refunded_at: null,
      disputed_at: null,
      dispute_id: null,
      offline_marked_paid_at: null,
      offline_marked_paid_by: null,
      fee_percent: null,
      privacy_consent_at: now,
      privacy_consent_version: "1",
      media_consent_at: null,
      media_consent_version: null,
      group_refunded_cents: 0,
      ...over,
    };
  }

  it("resolves the instructions branch from the DIVISION's payment method, never the cart's null column", async () => {
    const promoted = fakePromoted({ amount_cents: 500 });
    const settings = fakeSettings({ payment_method: "offline", payment_instructions: "Pay at the desk" });

    await notifyPromoted(promoted, fakeCtx(), settings, "http://test.local");

    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled(); // never even tries Stripe for an offline division
    expect(emailMock.promoted).toHaveBeenCalledTimes(1);
    const args = emailMock.promoted.mock.calls[0]![0];
    expect(args.payUrl).toBeNull();
    // Reverting the fix (reading promoted.payment_method, the null cart
    // column) makes this null too — no instructions AND no pay link.
    expect(args.paymentInstructions).toBe("Pay at the desk");
  });

  it("sends the ENTRY's own promotion_expires_at as payDeadline, never the cart's shared expires_at", async () => {
    // The group's shared expires_at can be LATER (a sibling's own earlier
    // promotion already extended it) than this entry's own freshly-set
    // window — the lapse sweep enforces the entry's own clock (pass 1b,
    // sweepRegistrations), so emailing the group's later date tells the
    // registrant they have longer than they actually do.
    const entryDeadline = new Date("2099-09-01T12:00:00.000Z");
    const groupDeadline = new Date("2099-09-03T12:00:00.000Z"); // later — a sibling's own window
    const promoted = fakePromoted({
      amount_cents: 500,
      promotion_expires_at: entryDeadline,
      expires_at: groupDeadline,
    });
    const settings = fakeSettings({ payment_method: "offline" });

    await notifyPromoted(promoted, fakeCtx(), settings, "http://test.local");

    const args = emailMock.promoted.mock.calls[0]![0];
    expect(args.payDeadline).toEqual(entryDeadline);
  });

  it("an offline promotion with no stripe window (promotion_expires_at null) sends no deadline — not the cart's unrelated expires_at", async () => {
    const promoted = fakePromoted({
      amount_cents: 500,
      promotion_expires_at: null,
      expires_at: new Date("2099-01-01T00:00:00.000Z"), // unrelated — must NOT leak through as payDeadline
    });
    const settings = fakeSettings({ payment_method: "offline" });

    await notifyPromoted(promoted, fakeCtx(), settings, "http://test.local");

    const args = emailMock.promoted.mock.calls[0]![0];
    expect(args.payDeadline).toBeNull();
  });
});
