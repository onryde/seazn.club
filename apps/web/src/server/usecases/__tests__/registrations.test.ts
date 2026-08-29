// PROMPT-20a acceptance (doc 16 §1.1): fee math asserted, full paid
// registration flow (Stripe mocked — the checkout/webhook contract is
// exercised, the network is not), capacity → waitlist → auto-promotion on
// withdrawal, idempotent entrant materialisation, auto/manual refund policy,
// eligibility + guardian-consent validation, Community fee gate (402).
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const checkoutRetrieve = vi.fn();
  const refundCreate = vi.fn();
  const chargeRetrieve = vi.fn();
  const reversalCreate = vi.fn();
  const reversalList = vi.fn();
  return {
    checkoutCreate,
    checkoutRetrieve,
    refundCreate,
    chargeRetrieve,
    reversalCreate,
    reversalList,
    stripe: {
      checkout: {
        sessions: { create: checkoutCreate, retrieve: checkoutRetrieve },
      },
      refunds: { create: refundCreate },
      charges: { retrieve: chargeRetrieve },
      transfers: {
        createReversal: reversalCreate,
        listReversals: reversalList,
      },
    },
  };
});

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// Observe the dispute-lost organiser email without touching the rest of the
// email module (send() is a no-op without RESEND_API_KEY either way).
//
// `registration` (RS005 F1) additionally wraps sendRegistrationEmail: every
// call still forwards to the REAL implementation (so its actual rendered
// subject/html/text — via the real registrationTemplate — stays observable
// through the captured `RegistrationEmail` opts), but `forceResult`/
// `forceError` let a single test override just the provider outcome
// deterministically, without depending on whether RESEND_API_KEY happens to
// be set in this environment.
const emailMock = vi.hoisted(() => ({
  disputeLost: vi.fn().mockResolvedValue(true),
  registration: vi.fn(),
  forceRegistrationResult: null as boolean | null,
  forceRegistrationError: null as Error | null,
  // RS006 follow-up: staff alert for a registration refund that FAILS.
  // Observed the same way as disputeLost above — a bare vi.fn(), asserted
  // on directly — rather than forwarded to the real implementation, since
  // these tests only need to prove the call sites TRIGGER it, not exercise
  // its own template rendering (that lives in registration-refund-alert.test.ts).
  registrationRefundFailedAlert: vi.fn().mockResolvedValue(true),
  // RS007 sweep-reminder CAS race test: observed directly (bare vi.fn, not
  // forwarded to the real implementation — this is a no-op without
  // RESEND_API_KEY anyway, same as every other email in this file's own
  // convention), so a race test can count sends without depending on the
  // provider being configured. Every OTHER sweep test in this file only
  // ever asserted via stripeMock.checkoutCreate as a proxy for "one send" —
  // that proxy breaks once a race can mint twice but send once (or vice
  // versa), which is exactly what this fix separates.
  paymentReminder: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendDisputeLostEmail: emailMock.disputeLost,
    sendRegistrationEmail: async (opts: Parameters<typeof actual.sendRegistrationEmail>[0]) => {
      emailMock.registration(opts);
      if (emailMock.forceRegistrationError) throw emailMock.forceRegistrationError;
      if (emailMock.forceRegistrationResult !== null) return emailMock.forceRegistrationResult;
      return actual.sendRegistrationEmail(opts);
    },
    sendRegistrationRefundFailedAlertEmail: emailMock.registrationRefundFailedAlert,
    sendPaymentReminderEmail: emailMock.paymentReminder,
  };
});

// #267 T3 (SPEC-5 §2): a targeted, org-id-scoped walletIdFor failure, so the
// referral best-effort test can force the referrer grant to throw without
// touching any other org's credit resolution (everything else passes through
// to the real implementation).
const creditsMock = vi.hoisted(() => ({ failWalletFor: new Set<string>() }));
vi.mock("@/lib/credits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/credits")>();
  return {
    ...actual,
    walletIdFor: async (orgId: string) => {
      if (creditsMock.failWalletFor.has(orgId)) throw new Error("forced test failure");
      return actual.walletIdFor(orgId);
    },
  };
});

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { HANDLED_EVENT_TYPES, processStripeEvent } from "../billing-events";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import {
  ageAt,
  applicationFeeCents,
  isMinor,
  validateAnswers,
  putRegistrationSettings,
  getRegistrationSettings,
  publicRegistrationInfo,
  publicRegistrationStatus,
  publicRegistrationStatusByRef,
  withdrawRegistrationByRef,
  handleRegistrationCheckoutCompleted,
  // handleRegistrationCheckoutAsyncPaymentFailed is deliberately NOT imported:
  // its test drives `processStripeEvent` with a real
  // `checkout.session.async_payment_failed` event instead of calling the
  // handler directly, which also proves the dispatch wiring and the
  // HANDLED_EVENT_TYPES entry — a direct call would prove neither.
  handleRegistrationDispute,
  syncRegistrationRefund,
  reconcileRegistration,
  reconcileRegistrationBySession,
  sweepRegistrations,
  withdrawRegistrationPublic,
  withdrawRegistrationOrganiser,
  confirmRegistration,
  confirmRegistrationWaived,
  markRegistrationPaidOffline,
  waitlistRegistration,
  refundRegistration,
  listRegistrations,
  exportRegistrationsCsv,
  registrationIcs,
  resumeRegistrationCheckout,
  mintGroupCheckout,
  promoteOldestWaitlisted,
  promoteWaitlistedRow,
  buildDisputeEvidence,
  resendRegistrationConfirmation,
  notifySubmitted,
  resolveRefundPolicy,
  groupById,
  reconcileRegistrationGroupBySession,
  type GroupStatusView,
} from "../registrations";
// RS005 F1: rendering the REAL production template off captured
// `RegistrationEmail` args (see emailMock.registration above) — this file's
// own convention for "assert the rendered text, not just that it sent",
// same email-builders.test.ts fixture (emailsEn) other suites already use.
import { registrationTemplate } from "@/lib/email-templates";
import emailsEn from "@/dictionaries/en/emails.json";
import type { Dict } from "@/lib/i18n";
// The legacy `eligibilityIssues` string[] wrapper these pure tests used to
// call was deleted at its source (RS002 W5 whole-branch review — zero
// production callers repo-wide). Re-plumbed through the surviving evaluator
// below rather than deleted: same rules, same inputs, same pass/fail intent,
// just via `divisionEligibilityIssues` (EligibilityIssue[]) instead of a
// string[] shortcut — exactly what the deleted wrapper did internally.
import { divisionEligibilityIssues } from "../registration-eligibility";
import { isValidRefCode, generateRefCode } from "@/lib/ref-code";
import { REGISTRATION_CURRENCIES, type Currency } from "@/lib/currency";
import { LEGAL_VERSION } from "@/lib/legal";
import { resolveNameDisplay } from "@/lib/name-display";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import {
  makeUser,
  seedOrg,
  asOwner,
  rig,
  loadWithGroup,
  seedSecondEntry,
  seedRegistration,
  fakeSession,
  SETTINGS_BASE,
  stripeRig,
  currencyRig,
} from "./_registration-fixtures";
import { FIRST_PAID_EARN, LIFETIME_EARN_CAP, REFERRAL_EARN, balance, walletIdFor } from "@/lib/credits";
const HAS_DB = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Pure: fee math & eligibility (no DB)
// ---------------------------------------------------------------------------

describe("fee math (pure)", () => {
  it("takes the platform % of the fee, rounded to the cent", () => {
    expect(applicationFeeCents(2000, 5)).toBe(100); // £20 → £1.00
    expect(applicationFeeCents(999, 5)).toBe(50); // 49.95 → 50
    expect(applicationFeeCents(101, 5)).toBe(5); // 5.05 → 5
    expect(applicationFeeCents(0, 5)).toBe(0);
  });

  it("never exceeds the fee itself", () => {
    expect(applicationFeeCents(100, 100)).toBe(100);
    expect(applicationFeeCents(1, 100)).toBe(1);
  });
});

describe("age & eligibility (pure, doc 06 §2)", () => {
  it("ageAt counts whole years against the exact date", () => {
    expect(ageAt("2010-06-05", new Date("2026-06-04T00:00:00Z"))).toBe(15);
    expect(ageAt("2010-06-05", new Date("2026-06-05T00:00:00Z"))).toBe(16);
  });

  it("isMinor flips at 18", () => {
    const now = new Date("2026-07-06T00:00:00Z");
    expect(isMinor("2008-07-07", now)).toBe(true); // 17
    expect(isMinor("2008-07-06", now)).toBe(false); // 18 today
  });

  // RS007/V380: age_cutoff_month/age_cutoff_day replace the old jsonb rule's
  // `cutoff: {month, day, yearOf: "season_start"}` — same U16-on-1-Sept
  // scenario, now expressed on the first-class columns.
  const U16 = { age_max: 15, age_cutoff_month: 9, age_cutoff_day: 1 };

  const noCategoryOrAgeBand = {
    category: null,
    age_min: null,
    age_max: null,
    age_cutoff_month: null,
    age_cutoff_day: null,
  };

  it("U16 cutoff rule: 15-or-younger on Sep 1 of the season-start year", () => {
    // Season starts 2026 → cutoff 2026-09-01.
    const division = { ...noCategoryOrAgeBand, ...U16 };
    expect(divisionEligibilityIssues(division, { dob: "2011-08-31" }, 2026)).toEqual([]); // 15 on cutoff
    expect(divisionEligibilityIssues(division, { dob: "2010-09-01" }, 2026)).not.toEqual([]); // 16 on cutoff
  });

  it("age rule without a DOB is an issue (form must collect it)", () => {
    const division = { ...noCategoryOrAgeBand, ...U16 };
    expect(divisionEligibilityIssues(division, { dob: null }, 2026)).not.toEqual([]);
  });

  it("gender rule checks the allowed list", () => {
    // RS007/V380: jsonb `allowed: ["f", "x"]` maps onto category "womens" —
    // categoryEligibilityIssues' own "x never blocks" rule means x always
    // passes any category, so `womens` admits exactly {f, x} and rejects m,
    // the identical allow-set the old jsonb rule expressed.
    const division = { ...noCategoryOrAgeBand, category: "womens" };
    expect(divisionEligibilityIssues(division, { dob: null, gender: "f" }, 2026)).toEqual([]);
    expect(divisionEligibilityIssues(division, { dob: null, gender: "m" }, 2026)).not.toEqual([]);
    expect(divisionEligibilityIssues(division, { dob: null, gender: null }, 2026)).not.toEqual([]);
  });
});

describe("validateAnswers (pure)", () => {
  const fields = [
    {
      key: "size",
      label: "Shirt size",
      kind: "select" as const,
      options: ["S", "M"],
      required: true,
    },
    { key: "notes", label: "Notes", kind: "text" as const, required: false },
    {
      key: "photo_ok",
      label: "Photo consent",
      kind: "checkbox" as const,
      required: false,
    },
  ];

  it("keeps declared fields, drops unknown keys", () => {
    expect(
      validateAnswers(fields, {
        size: "M",
        notes: "hi",
        photo_ok: true,
        evil: "x",
      }),
    ).toEqual({ size: "M", notes: "hi", photo_ok: true });
  });

  it("rejects a missing required field and an off-list select value", () => {
    expect(() => validateAnswers(fields, {})).toThrow(HttpError);
    expect(() => validateAnswers(fields, { size: "XXL" })).toThrow(HttpError);
  });
});

describe("resolveRefundPolicy (pure, V379/RS007)", () => {
  const FUTURE = "2099-01-01";
  const PAST = "2000-01-01";

  it("an explicit refund_lock_at wins over the starts_on fallback, in either direction", () => {
    // Explicit lock in the past beats a starts_on that is still ahead.
    expect(resolveRefundPolicy(new Date(PAST), FUTURE, "UTC", "pi_1", 1000, 0).refundable).toBe(false);
    // Explicit lock in the future beats a starts_on that has already passed.
    expect(resolveRefundPolicy(new Date(FUTURE), PAST, "UTC", "pi_1", 1000, 0).refundable).toBe(true);
  });

  it("NULL refund_lock_at falls back to the competition's starts_on — refundable while it is still ahead", () => {
    const policy = resolveRefundPolicy(null, FUTURE, "UTC", "pi_1", 1000, 0);
    expect(policy.refundable).toBe(true);
    expect(policy.deadline).toBe(new Date(`${FUTURE}T00:00:00.000Z`).toISOString());
    expect(policy.reason).toBeNull();
  });

  it("NULL refund_lock_at falls back to the competition's starts_on — NOT refundable once it has passed", () => {
    // The exact defect this wave fixes: NULL used to mean refundable
    // forever, including the night before (and after) kickoff.
    const policy = resolveRefundPolicy(null, PAST, "UTC", "pi_1", 1000, 0);
    expect(policy.refundable).toBe(false);
    expect(policy.deadline).toBe(new Date(`${PAST}T00:00:00.000Z`).toISOString());
    expect(policy.reason).toBeNull(); // a known-but-passed deadline, not an unknown one
  });

  it("both null (no lock, no starts_on) has NO derivable deadline and is NOT refundable — owner ruling: an org that never configured either is fail-CLOSED, never auto-refundable forever", () => {
    // This is the exact defect this wave fixes: null used to read as "no
    // deadline, so still open" — refundable forever, the precise failure
    // 445b137c1 claimed it had already removed.
    const policy = resolveRefundPolicy(null, null, "UTC", "pi_1", 1000, 0);
    expect(policy.deadline).toBeNull();
    expect(policy.refundable).toBe(false);
    expect(policy.reason).toBe("no_deadline");
  });

  it("amount_cents is the remaining unrefunded balance, not the original fee", () => {
    expect(resolveRefundPolicy(null, FUTURE, "UTC", "pi_1", 1000, 400).amount_cents).toBe(600);
  });

  it("not refundable with no payment_intent_id, or with nothing left to refund, even before the deadline", () => {
    expect(resolveRefundPolicy(null, FUTURE, "UTC", null, 1000, 0).refundable).toBe(false);
    expect(resolveRefundPolicy(null, FUTURE, "UTC", "pi_1", 1000, 1000).refundable).toBe(false);
  });

  // The second bug this wave fixes: `starts_on` is a bare DATE column with no
  // zone of its own. `new Date("YYYY-MM-DD")` parses it as UTC midnight
  // regardless of where the org actually runs — an Asia/Kolkata (UTC+5:30)
  // org's window used to stay open until 05:30 LOCAL on the morning of play,
  // 5.5h past the local midnight an organiser setting no explicit lock would
  // reasonably expect.
  it("the starts_on fallback resolves in the ORG's zone, not as UTC midnight — Asia/Kolkata closes at local midnight, not 05:30 local", () => {
    vi.useFakeTimers();
    try {
      // 2026-01-10 local midnight IST = 2026-01-09T18:30:00Z. Pinned "now"
      // sits AFTER that real deadline but BEFORE the buggy UTC-midnight
      // parse (2026-01-10T00:00:00Z) — the two disagree by exactly the
      // scenario above, so this instant can only read "refundable" under
      // the pre-fix UTC-midnight bug.
      vi.setSystemTime(new Date("2026-01-09T20:00:00.000Z"));
      const policy = resolveRefundPolicy(null, "2026-01-10", "Asia/Kolkata", "pi_1", 1000, 0);
      expect(policy.deadline).toBe("2026-01-09T18:30:00.000Z");
      expect(policy.refundable).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// DB-backed flows
// ---------------------------------------------------------------------------

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: "cs_test_" + randomUUID().slice(0, 8),
    url: "https://checkout.stripe.test/session",
  }));
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_test_1" });
  stripeMock.checkoutRetrieve.mockReset();
  stripeMock.chargeRetrieve.mockReset();
  stripeMock.reversalCreate.mockReset().mockResolvedValue({ id: "trr_test_1" });
  stripeMock.reversalList.mockReset().mockResolvedValue({ data: [] });
  emailMock.disputeLost.mockClear();
  emailMock.registration.mockClear();
  emailMock.forceRegistrationResult = null;
  emailMock.forceRegistrationError = null;
  emailMock.registrationRefundFailedAlert.mockClear();
  // .mockReset() (not .mockClear()): a race test installs its own
  // mockImplementation on this one — reset the implementation back to its
  // default too, or it leaks into every later test in this file.
  emailMock.paymentReminder.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  creditsMock.failWalletFor.clear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("registration flows (doc 16 §1.1, PROMPT-20a)", () => {
  it("free flow: seed → pending → organiser confirm → entrant materialised once", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });

    const res = await seedRegistration(competition.id, division.id, settings, {
      players: [{ name: "Alex Test", dob: "1995-04-01" }],
    });
    expect(res.registration.status).toBe("pending");
    expect(res.checkout_url).toBeNull();
    expect(res.access_token.startsWith("rg_")).toBe(true);

    // GDPR (spec 2026-07-14): consent is demonstrable — timestamp + version
    // stored (now on the cart, V364).
    expect(res.registration.privacy_consent_at).toBeInstanceOf(Date);
    expect(res.registration.privacy_consent_version).toBe(LEGAL_VERSION);

    const confirmed = await confirmRegistration(owner, res.registration.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.entrant_id).not.toBeNull();

    // Idempotent: a second confirm returns the same entrant.
    const again = await confirmRegistration(owner, res.registration.id);
    expect(again.entrant_id).toBe(confirmed.entrant_id);

    // Individual materialisation created a person carrying the DOB.
    const [person] = await sql<{ dob: string }[]>`
      select p.dob from persons p
      join entrant_members em on em.person_id = p.id
      where em.entrant_id = ${confirmed.entrant_id as string}`;
    expect(person.dob).toBe("1995-04-01");
  });

  it("team flow: roster supplied at registration materialises into squad members on confirm", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "team",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });

    const res = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Riverside FC",
      players: [
        { name: "Jordan Blake", dob: "2005-04-12", squadNumber: 7 },
        { name: "Sam Ortiz", squadNumber: 10 },
        { name: "Alex Kim" },
      ],
    });
    expect(res.registration.status).toBe("pending");

    const confirmed = await confirmRegistration(owner, res.registration.id);
    expect(confirmed.entrant_id).not.toBeNull();

    const members = await sql<
      { full_name: string; dob: string | null; squad_number: number | null }[]
    >`
      select p.full_name, p.dob, em.squad_number
      from entrant_members em join persons p on p.id = em.person_id
      where em.entrant_id = ${confirmed.entrant_id as string}
      order by p.full_name`;
    expect(members.map((m) => m.full_name)).toEqual(["Alex Kim", "Jordan Blake", "Sam Ortiz"]);
    const jordan = members.find((m) => m.full_name === "Jordan Blake")!;
    expect(jordan.dob).toBe("2005-04-12");
    expect(jordan.squad_number).toBe(7);

    // Re-confirm is idempotent — no duplicate members.
    await confirmRegistration(owner, res.registration.id);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(n).toBe(3);
  });

  it("paid flow (offline): no Stripe checkout; bank/cash instructions surfaced; dormant webhook still confirms", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    // Stripe Connect is disabled — entry fees are collected offline. The org's
    // payment_instructions carry the bank/cash details shown to registrants.
    const instructions = "Bank transfer to Riverside FC · sort 00-00-00 · acc 12345678";
    await sql`update organizations
              set payment_instructions = ${instructions}
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 2000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });

    const res = await seedRegistration(competition.id, division.id, settings);
    // Paid entry is accepted immediately as pending — no online checkout.
    expect(res.registration.status).toBe("pending");
    expect(res.checkout_url).toBeNull();
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();

    // The status page (registrant's receipt) exposes the offline instructions.
    const status = await publicRegistrationStatus(res.registration.id, res.access_token);
    expect(status.payment_due).toBe(true);
    expect(status.payment_instructions).toBe(instructions);

    // The Stripe webhook path stays wired (dormant) — if a payment ever lands,
    // it still confirms + materialises the entrant idempotently.
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 2000));
    let row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed");
    expect(row.payment_intent_id).toContain("pi_test_");
    expect(row.entrant_id).not.toBeNull();
    const entrantId = row.entrant_id;

    // Webhook replay (billing_events would normally dedupe; the handler is
    // ALSO idempotent on its own).
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 2000));
    row = await loadWithGroup(res.registration.id);
    expect(row.entrant_id).toBe(entrantId);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${division.id}`;
    expect(n).toBe(1);
  });

  it("SPEC-5 §2: the org's FIRST confirmed paid registration earns the organiser +10, once per org", async () => {
    // The growth grant lands on the ORGANISER (the competition's org), not the
    // registrant, and fires only on a genuine first-time paid CONFIRMATION.
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const walletId = await walletIdFor(orgId);
    const before = await balance(walletId);

    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 2000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const first = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(first.registration.id, 2000));
    // The organiser's wallet gained exactly the first_paid earn.
    expect(await balance(walletId)).toBe(before + FIRST_PAID_EARN);

    // A SECOND competition for the SAME org, also taking a paid registration:
    // the once-per-ORG key (earn:first_paid:${orgId}) makes it a no-op — no
    // additional grant.
    const { competition: comp2, division: div2 } = await rig(owner);
    const settings2 = await putRegistrationSettings(owner, div2.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 2000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const second = await seedRegistration(comp2.id, div2.id, settings2, {
      contactEmail: "second@test.local",
    });
    await handleRegistrationCheckoutCompleted(fakeSession(second.registration.id, 2000));
    expect(await balance(walletId)).toBe(before + FIRST_PAID_EARN);
  });

  it("#267 T3: a referred org's first confirmed paid registration grants the REFERRER +20, once per referred org", async () => {
    const { orgId: referrerOrgId } = await seedOrg("pro");
    const referrerWallet = await walletIdFor(referrerOrgId);
    // seedOrg("pro") gives the referrer its own group-of-one subscription, so
    // the grant lands in that group's wallet, not the bare org id.
    expect(referrerWallet).not.toBe(referrerOrgId);
    const referrerBefore = await balance(referrerWallet);

    const { orgId, ownerId } = await seedOrg("pro");
    await sql`update organizations set referred_by_org_id = ${referrerOrgId} where id = ${orgId}`;
    const owner = asOwner(orgId, ownerId);

    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 2000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const first = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(first.registration.id, 2000));
    expect(await balance(referrerWallet)).toBe(referrerBefore + REFERRAL_EARN);

    // A SECOND paid competition for the SAME referred org: keyed on the
    // referred org (earn:referral:${orgId}), so it no-ops — no extra grant.
    const { competition: comp2, division: div2 } = await rig(owner);
    const settings2 = await putRegistrationSettings(owner, div2.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 2000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const second = await seedRegistration(comp2.id, div2.id, settings2, {
      contactEmail: "second@test.local",
    });
    await handleRegistrationCheckoutCompleted(fakeSession(second.registration.id, 2000));
    expect(await balance(referrerWallet)).toBe(referrerBefore + REFERRAL_EARN);
  });

  it("#267 T3: a non-referred org's first paid registration grants no referral credit to anyone", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const walletId = await walletIdFor(orgId);

    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 2000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 2000));

    // Only the org's own first_paid earn landed — no referral row for it.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_credit_ledger
       where idempotency_key = ${`earn:referral:${orgId}`}`;
    expect(n).toBe(0);
    expect(await balance(walletId)).toBe(FIRST_PAID_EARN);
  });

  it("#267 T3: the referrer's lifetime cap floors the +20, never overshoots", async () => {
    const { orgId: referrerOrgId } = await seedOrg("pro");
    const referrerWallet = await walletIdFor(referrerOrgId);
    // Put the referrer 5 credits below the cap via a raw seed row (same
    // recipe as credits-earn.test.ts's seedEarned helper).
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
      values (${referrerWallet}, ${LIFETIME_EARN_CAP - 5}, 'earn_grant', 'pack', ${LIFETIME_EARN_CAP - 5}, ${`seed-${randomUUID()}`})`;

    const { orgId, ownerId } = await seedOrg("pro");
    await sql`update organizations set referred_by_org_id = ${referrerOrgId} where id = ${orgId}`;
    const owner = asOwner(orgId, ownerId);

    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 2000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 2000));

    // Only the remaining 5 of headroom granted — capped, never over.
    expect(await balance(referrerWallet)).toBe(LIFETIME_EARN_CAP);
  });

  it("#267 T3: best-effort — a referrer wallet-resolution failure never blocks the webhook confirmation", async () => {
    const { orgId: referrerOrgId } = await seedOrg("pro");
    const { orgId, ownerId } = await seedOrg("pro");
    await sql`update organizations set referred_by_org_id = ${referrerOrgId} where id = ${orgId}`;
    const owner = asOwner(orgId, ownerId);
    creditsMock.failWalletFor.add(referrerOrgId);
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});

    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 2000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 2000));

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed"); // webhook still confirmed despite the grant failure
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("capacity: withdrawal auto-promotes the oldest waitlisted; auto-refund pre-lock", async () => {
    // Overflow-at-submission (waitlisting a full division) was
    // `submitRegistration`'s own capacity decision — deleted with it (RS001
    // demolition; RS002/RS003 own re-testing it against the new submit
    // flow). What this test actually pins is auto-promotion + auto-refund on
    // withdrawal — both still-live behaviour of `withdrawCore` — so the
    // waitlisted row is seeded directly in that state.
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 1000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: 1,
      refund_lock_at: null,
    });

    const first = await seedRegistration(competition.id, division.id, settings, {
      displayName: "First In",
    });
    expect(first.registration.status).toBe("pending");

    const second = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Wait Lister",
      contactEmail: "wait@test.local",
      status: "waitlisted",
    });
    expect(second.registration.status).toBe("waitlisted");
    expect(second.checkout_url).toBeNull(); // no money taken on the waitlist

    // First pays, then withdraws → refund (pre-lock) + promotion.
    await handleRegistrationCheckoutCompleted(fakeSession(first.registration.id, 1000));
    const view = await withdrawRegistrationPublic(first.registration.id, first.access_token);
    expect(view.status).toBe("withdrawn");
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: expect.stringContaining("pi_test_"),
        reverse_transfer: true,
        refund_application_fee: true,
      }),
    );
    const firstRow = await loadWithGroup(first.registration.id);
    expect(firstRow.refunded_cents).toBe(firstRow.amount_cents);
    // The materialised entrant is marked withdrawn, not deleted.
    const [entrant] = await sql<{ status: string }[]>`
      select status from entrants where id = ${firstRow.entrant_id as string}`;
    expect(entrant.status).toBe("withdrawn");

    const promoted = await loadWithGroup(second.registration.id);
    expect(promoted.status).toBe("pending");
    expect(promoted.promoted_at).not.toBeNull();
  });

  it("RS006: withdrawCore alerts staff when the pre-lock auto-refund FAILS, but the withdrawal still succeeds", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500)); // paid + payment_intent_id set
    stripeMock.refundCreate.mockClear();
    stripeMock.refundCreate.mockRejectedValueOnce(new Error("insufficient funds on connected account"));
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    try {
      const view = await withdrawRegistrationPublic(res.registration.id, res.access_token); // pre-lock auto-refund attempt
      // Fail-open contract (withdrawCore's own comment above the catch):
      // the refund failure must not undo the withdrawal.
      expect(view.status).toBe("withdrawn");

      expect(emailMock.registrationRefundFailedAlert).toHaveBeenCalledTimes(1);
      const args = emailMock.registrationRefundFailedAlert.mock.calls[0]![0];
      expect(args.to).toBe("ops@seazn.test");
      expect(args.registrationId).toBe(res.registration.id);
      expect(args.orgId).toBe(orgId);
      expect(args.competitionId).toBe(competition.id);
      expect(args.amountCents).toBe(500);
      expect(args.currency).toBe(settings.currency);
      expect(args.paymentIntentId).toContain("pi_test_");
      expect(args.reason).toBe("insufficient funds on connected account");

      // The refund really never landed — the alert is reporting a REAL gap,
      // not a false positive.
      const row = await loadWithGroup(res.registration.id);
      expect(row.refunded_cents).toBe(0);
    } finally {
      delete process.env.STAFF_ALERT_EMAIL;
    }
  });

  it("post-lock withdrawal does NOT auto-refund; manual partial refund works and over-refund 422s", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 1000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: "2020-01-01T00:00:00Z", // lock long past
    });

    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 1000));
    stripeMock.refundCreate.mockClear();

    await withdrawRegistrationPublic(res.registration.id, res.access_token);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled(); // organiser discretion now

    const refunded = await refundRegistration(owner, res.registration.id, 400);
    expect(refunded.refunded_cents).toBe(400);
    await expect(refundRegistration(owner, res.registration.id, 700)).rejects.toThrow(HttpError);
    const fullRest = await refundRegistration(owner, res.registration.id, undefined);
    expect(fullRest.refunded_cents).toBe(1000);
  });

  // Finding #18 (CRITICAL, money-matrix S4): a paid, CONFIRMED entry that is
  // later withdrawn past refund_lock_at must stay unrefunded — same policy
  // as "post-lock withdrawal does NOT auto-refund" directly above — even
  // when the status page's own reconcile-on-return path re-runs against the
  // SAME Stripe session after the withdrawal.
  //
  // Mechanism: the status page (register/status/page.tsx) calls
  // reconcileRegistrationGroupBySession unconditionally whenever
  // ?checkout=success&session_id=... is present, with NO gate on the
  // registration's current status (deliberate — see that function's own doc
  // comment; a multi-entry cart can have a representative sibling already
  // settled). cancel-entry.tsx calls router.refresh() right after a
  // successful withdrawal, which re-renders that SAME URL — query string
  // intact — so the reconcile call fires again with the identical
  // session_id. Stripe still reports that session as paid forever (a refund
  // does not change payment_status), so confirmPaidRegistration re-enters
  // with the row now 'withdrawn' and takes its withdrawn/expired/
  // rejected/waitlisted branch — built for a payment landing on a spot the
  // entrant no longer holds, not for the ordinary post-lock cancellation
  // this scenario actually is — and refunds in full, audited as
  // "late_payment", bypassing refund_lock_at entirely.
  it("F18 CRITICAL: a reconcile replay of the SAME session after a post-lock withdrawal must not refund as 'late'", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      payment_method: "stripe",
      fee_cents: 4000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: "2020-01-01T00:00:00Z", // lock long past — organiser discretion only
    });

    const res = await seedRegistration(competition.id, division.id, settings);
    const session = fakeSession(res.registration.id, 4000);
    // The binding reconcileRegistrationGroupBySession checks BEFORE ever
    // calling Stripe — the same stamp createRegistrationCheckout leaves.
    await sql`update registration_groups set checkout_session_id = ${session.id}
              where id = ${res.registration.group_id}`;
    stripeMock.checkoutRetrieve.mockResolvedValue(session);

    // Reconcile-on-return, first visit: the status page's own render right
    // after Stripe's redirect back. Confirms the entry.
    expect(
      await reconcileRegistrationGroupBySession(res.registration.group_id, res.access_token, session.id),
    ).toBe(true);
    expect((await loadWithGroup(res.registration.id)).status).toBe("confirmed");

    // Registrant cancels from the status page. refund_lock_at is long past,
    // so this is organiser-discretion only — withdrawCore must issue no
    // refund (asserted the same way the sibling test above does).
    await withdrawRegistrationPublic(res.registration.id, res.access_token);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();

    // cancel-entry.tsx's router.refresh() re-renders the SAME URL — the
    // query string (rid/token/checkout=success/session_id) is untouched —
    // so the page calls reconcileRegistrationGroupBySession again with the
    // identical session id. Stripe has no idea the entrant withdrew; the
    // session it hands back is unchanged.
    const reconciledAgain = await reconcileRegistrationGroupBySession(
      res.registration.group_id,
      res.access_token,
      session.id,
    );

    // The replay still reaches fulfilment (proving the assertions below are
    // not vacuous from an early return elsewhere, e.g. a token/binding miss).
    expect(reconciledAgain).toBe(true);
    // The lock said organiser discretion, and a page refresh must not move
    // money the first read of that same policy correctly withheld.
    expect(stripeMock.refundCreate, "the replay must not touch Stripe's refund API at all").not.toHaveBeenCalled();
    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("withdrawn");
    expect(row.refunded_cents).toBe(0);
  });

  // V379/RS007 — NULL refund_lock_at no longer means refundable forever; it
  // falls back to the competition's own starts_on (resolveRefundPolicy).
  // Wired end-to-end through withdrawCore here — the pure rule itself has
  // its own fast coverage above ("resolveRefundPolicy (pure, V379/RS007)").
  it("RS007: NULL refund_lock_at + competition ALREADY STARTED — withdrawal does NOT auto-refund", async () => {
    const { competition, division, settings } = await stripeRig(); // refund_lock_at: null (SETTINGS_BASE)
    await sql`update competitions set starts_on = (now() - interval '1 day')::date where id = ${competition.id}`;
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    stripeMock.refundCreate.mockClear();

    await withdrawRegistrationPublic(res.registration.id, res.access_token);
    // Reverting the starts_on fallback makes this fail: NULL would read as
    // "before the lock" forever and auto-refund here regardless.
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
    const row = await loadWithGroup(res.registration.id);
    expect(row.refunded_cents).toBe(0);
  });

  // The other bug this wave fixes (bug (a) — `competitions.starts_on` is
  // nullable, see usecases/competitions.ts:206): a null lock AND a null
  // starts_on together leave NO derivable deadline at all. Owner ruling:
  // that is fail-CLOSED, not "refundable forever" — reverting the
  // resolveRefundPolicy fix above makes this fail exactly the same way the
  // ALREADY STARTED test above does.
  it("RS007: NULL refund_lock_at + NULL starts_on — no derivable deadline, withdrawal does NOT auto-refund", async () => {
    const { competition, division, settings } = await stripeRig(); // refund_lock_at: null (SETTINGS_BASE)
    await sql`update competitions set starts_on = null where id = ${competition.id}`;
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    stripeMock.refundCreate.mockClear();

    await withdrawRegistrationPublic(res.registration.id, res.access_token);
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
    const row = await loadWithGroup(res.registration.id);
    expect(row.refunded_cents).toBe(0);
  });

  it("RS007: NULL refund_lock_at + competition still UPCOMING — withdrawal still auto-refunds", async () => {
    const { competition, division, settings } = await stripeRig();
    await sql`update competitions set starts_on = (now() + interval '30 days')::date where id = ${competition.id}`;
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    stripeMock.refundCreate.mockClear();

    await withdrawRegistrationPublic(res.registration.id, res.access_token);
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    const row = await loadWithGroup(res.registration.id);
    expect(row.refunded_cents).toBe(row.amount_cents);
  });

  it("RS007: an explicit refund_lock_at wins over the starts_on fallback even when the competition is still upcoming", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
              where id = ${orgId}`;
    const { competition, division } = await rig(owner, { startsOn: "2026-12-25" }); // far future
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 1000,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: "2020-01-01T00:00:00Z", // explicit lock, long past
    });
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 1000));
    stripeMock.refundCreate.mockClear();

    await withdrawRegistrationPublic(res.registration.id, res.access_token);
    // Reverting resolveRefundPolicy's `refundLockAt ?? fallback` order (or
    // falling back even when an explicit lock exists) would refund here,
    // since the competition itself has not started — the explicit lock must
    // still win.
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
  });

  // REVIEW FIX (money-path defect #1) — buildGroupStatusView fed the CART's
  // shared payment_intent_id into a PER-ENTRY resolveRefundPolicy, so a
  // sibling that was never itself charged (a fresh waitlist promotion, still
  // 'pending') rode a PAID sibling's payment_intent_id and read as
  // refundable. withdrawCore had the identical confusion on the WRITE side —
  // cancelling the never-charged entry would call a REAL stripeRefund against
  // the paid sibling's own intent. Repro matches the dispatch's own: cart
  // holds paid entry A (confirmed via a real Stripe session, stamping the
  // group's payment_intent_id) and a promoted-but-never-charged entry B
  // sharing that same cart.
  it("REVIEW FIX: a promoted, never-charged cart sibling is not shown or refunded off the PAID sibling's payment_intent_id", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 2500 });
    const a = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(a.registration.id, 2500));
    const aRow = await loadWithGroup(a.registration.id);
    expect(aRow.status).toBe("confirmed"); // sanity: A really did pay
    expect(aRow.payment_intent_id).toContain("pi_test_"); // sanity: the group's PI is live

    // B: a waitlist promotion into the SAME cart — its own fee is owed, but
    // no Stripe session has ever been minted or paid for it. seedSecondEntry
    // reproduces exactly the row shape promoteWaitlistedRow leaves behind.
    const b = await seedSecondEntry(a.registration.group_id, division.id, 2500, "Promoted B", "pending");

    // READ SIDE: the status page must never tell B's registrant "you'll get
    // a refund" for money that was never taken from them.
    const view = await groupById(a.registration.group_id, a.access_token);
    const bEntry = view.entries.find((e) => e.id === b.id);
    expect(bEntry, "sanity: B is in the cart view").toBeDefined();
    expect(bEntry!.refund_policy.refundable, "B was never charged — must not read refundable").toBe(false);
    // A (genuinely paid, lock still open) is correctly still refundable —
    // proves the fix narrows the READ, it does not blanket-disable it.
    const aEntry = view.entries.find((e) => e.id === a.registration.id);
    expect(aEntry!.refund_policy.refundable, "A really did pay — still refundable").toBe(true);

    // WRITE SIDE: cancelling B must never move A's money.
    stripeMock.refundCreate.mockClear();
    await withdrawRegistrationPublic(b.id, a.access_token);
    expect(stripeMock.refundCreate, "no Stripe call for an entry that was never charged").not.toHaveBeenCalled();
    const bRow = await loadWithGroup(b.id);
    expect(bRow.status).toBe("withdrawn");
    expect(bRow.refunded_cents).toBe(0);
    const [groupRow] = await sql<{ refunded_cents: number }[]>`
      select refunded_cents from registration_groups where id = ${a.registration.group_id}`;
    expect(groupRow!.refunded_cents, "A's real payment must be untouched").toBe(0);
  });

  // "eligibility gate: U16 rejects an adult; a minor needs guardian consent"
  // DELETED (RS001 demolition): the whole test drove
  // `submitRegistration`'s own eligibility-gate enforcement at submit time —
  // no surviving usecase performs that check. The pure rule function it
  // called keeps its own coverage above, unchanged ("age & eligibility
  // (pure, doc 06 §2)") — now via `divisionEligibilityIssues` directly
  // (RS002 W5: the legacy `eligibilityIssues` string[] wrapper it used to go
  // through was deleted, zero production callers). RS002/RS003 own
  // re-testing the gate against the new submit flow.

  // "rejects submissions without privacy consent (GDPR, spec 2026-07-14)"
  // DELETED (RS001 demolition): submitRegistration's own consent gate;
  // no surviving usecase enforces it. RS002/RS003 own it.

  it("team-kind confirm materialises an entrant WITHOUT a person when the roster is empty", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "team",
      fee_cents: 0,
      form_fields: [
        {
          key: "size",
          label: "Shirt size",
          kind: "select",
          options: ["S", "M"],
          required: true,
        },
      ],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    // The bounded-answers VALIDATION itself (required field, off-list value
    // rejected) was submitRegistration's own integration of `validateAnswers`
    // — deleted with it; `validateAnswers` keeps its own pure coverage
    // above, unchanged. What survives here is that confirmRegistration
    // materialises a team WITHOUT a person when the roster is empty — seeded
    // directly, kept answers already validated/trimmed.
    const ok = await seedRegistration(competition.id, division.id, settings, {
      answers: { size: "M" },
    });
    expect(ok.registration.answers).toEqual({ size: "M" });
    // Team kind: entrant materialises WITHOUT a person.
    const confirmed = await confirmRegistration(owner, ok.registration.id);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrant_members
      where entrant_id = ${confirmed.entrant_id as string}`;
    expect(n).toBe(0);
  });

  it("organiser tools: waitlist/list/export/ics/info; the window itself still gates open/closed", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // The closed-window → submission-REJECTED enforcement lived inside
    // `submitRegistration` — deleted with it (RS001 demolition).
    // `publicRegistrationInfo`'s own window computation is independent of
    // submit and still enforced below (closed_reason/open).
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: "2020-01-01T00:00:00Z",
      capacity: null,
      refund_lock_at: null,
    });
    const closedInfo = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(closedInfo.divisions[0].open).toBe(false);
    expect(closedInfo.divisions[0].closed_reason).toBe("window");

    // Reopen; the public info panel reflects it.
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: 8,
      refund_lock_at: null,
    });
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions).toHaveLength(1);
    expect(info.divisions[0].open).toBe(true);
    expect(info.divisions[0].remaining).toBe(8);

    const reg = await seedRegistration(competition.id, division.id, settings);
    const waitlisted = await waitlistRegistration(owner, reg.registration.id);
    expect(waitlisted.status).toBe("waitlisted");

    const listed = await listRegistrations(owner, division.id, "waitlisted");
    expect(listed.map((r) => r.id)).toContain(reg.registration.id);

    const csv = await exportRegistrationsCsv(owner, { divisionId: division.id });
    expect(csv.split("\n")[0]).toContain("display_name");
    expect(csv).toContain("Alex Test");

    const ics = await registrationIcs(reg.registration.id, reg.access_token);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260915");

    // Settings read-back includes charges_enabled for the console banner.
    const settingsReadback = await getRegistrationSettings(owner, division.id);
    expect(settingsReadback.charges_enabled).toBe(false);
    expect(settingsReadback.capacity).toBe(8);
  });

  it("Community org: offline AND card entry fees are both allowed (V310)", async () => {
    const { orgId, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    // Offline (no Stripe Connect) — a fee saves fine on Community.
    const saved = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 500,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    expect(saved.fee_cents).toBe(500);

    // Free registration still works.
    const freeSettings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const res = await seedRegistration(competition.id, division.id, freeSettings);
    expect(res.registration.status).toBe("pending");

    // An offline fee stays allowed even with charges enabled (the org may take
    // cards elsewhere but run this division in cash)…
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const offlineStill = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 500,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    expect(offlineStill.fee_cents).toBe(500);

    // …and since V310 (D19) the card method needs only live Connect, not a
    // plan. Community pays for it in the rate instead — 8% vs Pro's 2%
    // (registration.fee_percent, see entitlements-v2.test.ts).
    const card = await putRegistrationSettings(owner, division.id, {
      enabled: true, entrant_kind: "individual", fee_cents: 500,
      form_fields: [], opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      payment_method: "stripe",
    });
    expect(card.payment_method).toBe("stripe");
  });

  it("capacity above the plan's entrant quota is rejected at save", async () => {
    // community entrants.per_division.max = 64 (V319, was 32); the capacity
    // below is 128 — over the community cap, and deliberately equal to the
    // EVENT PASS value so a pass leaking into an unpassed org would show up
    // here as a missing rejection rather than a silently larger allowance.
    const { orgId, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    await expect(
      putRegistrationSettings(owner, division.id, {
        enabled: true,
        entrant_kind: "individual",
        fee_cents: 0,
        form_fields: [],
        opens_at: null,
        closes_at: null,
        capacity: 128,
        refund_lock_at: null,
      }),
    ).rejects.toThrow(/entrant limit/);
  });

  // ── Reference numbers + /r/[ref] (v3/05 §3, PROMPT-34) ──

  it("/r/[ref] resolves a checksummed SZ ref, dashes/case optional; a typo 404s on checksum", async () => {
    // Ref MINTING was submitRegistration's own call to `generateRefCode()`
    // (RS001 demolition) — the generator itself is a still-live shared
    // primitive (@/lib/ref-code, reused verbatim by RS002/RS003), so it mints
    // the seed's ref here too. What this test actually pins is regByRef's
    // RESOLUTION (checksum, dash/case-insensitivity, typo → 404) — unchanged.
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      refCode: generateRefCode(),
    });

    expect(registration.ref_code).toMatch(/^SZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(isValidRefCode(registration.ref_code!)).toBe(true);

    const view = await publicRegistrationStatusByRef(registration.ref_code!);
    expect(view.status).toBe("pending");
    expect(view.display_name).toBe("Alex Test");
    expect(view.division_slug).toBe(division.slug);
    expect(view.can_withdraw).toBe(false); // no token presented

    // Quoted over the phone: lowercase, no dashes — still resolves.
    const sloppy = registration.ref_code!.toLowerCase().replace(/-/g, "");
    const view2 = await publicRegistrationStatusByRef(sloppy);
    expect(view2.ref_code).toBe(registration.ref_code);

    // A typo'd ref fails the checksum → 404, before touching the table.
    const chars = registration.ref_code!.replace("SZ-", "").replace(/-/g, "").split("");
    chars[0] = chars[0] === "A" ? "B" : "A";
    await expect(
      publicRegistrationStatusByRef(`SZ-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`),
    ).rejects.toThrow(/not found/);
  });

  it("self-withdraw by ref requires the email token — the ref alone is a lookup, not auth", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration, access_token } = await seedRegistration(competition.id, division.id, settings, {
      refCode: generateRefCode(),
    });
    const ref = registration.ref_code!;

    await expect(
      withdrawRegistrationByRef(ref, registration.id, "rg_wrong-token"),
    ).rejects.toThrow(/not found/);
    const still = await loadWithGroup(registration.id);
    expect(still.status).toBe("pending");

    const view = await withdrawRegistrationByRef(ref, registration.id, access_token);
    expect(view.entries.find((e) => e.id === registration.id)?.status).toBe("withdrawn");
  });

  // RS006 follow-up (data-integrity fix): /r/[ref] shows the WHOLE cart, but
  // withdraw used to always resolve+act on the OLDEST entry regardless of
  // which one the caller meant — a multi-entry cart had one undifferentiated
  // Withdraw control that silently withdrew the wrong row. Withdraw is now
  // per-entry: the caller names the target id, and it's verified to belong
  // to the ref's own group before withdrawCore ever runs.
  it("withdrawing entry 2 of a 3-entry cart withdraws EXACTLY entry 2, leaving 1 and 3 untouched", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration: entry1, access_token } = await seedRegistration(
      competition.id,
      division.id,
      settings,
      { refCode: generateRefCode(), displayName: "Singles" },
    );
    const entry2 = await seedSecondEntry(entry1.group_id, division.id, 0, "Doubles");
    const entry3 = await seedSecondEntry(entry1.group_id, division.id, 0, "Mixed");
    const ref = entry1.ref_code!;

    await withdrawRegistrationByRef(ref, entry2.id, access_token);

    const [after1, after2, after3] = await Promise.all([
      loadWithGroup(entry1.id),
      loadWithGroup(entry2.id),
      loadWithGroup(entry3.id),
    ]);
    expect(after2.status).toBe("withdrawn");
    expect(after1.status).toBe("pending");
    expect(after3.status).toBe("pending");
  });

  it("a valid token paired with a registration id from ANOTHER group withdraws nothing (SECURITY)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    // Two INDEPENDENT carts (own group, own ref, own token) — the realistic
    // shape of the attack: the caller legitimately holds their OWN ref+token
    // (myRef/myToken, the page they're actually on) and swaps in an entry id
    // harvested off a DIFFERENT cart's public /r/[ref] page (entries[].id is
    // unconditionally public — see publicCartByRef).
    const { registration: mine, access_token: myToken } = await seedRegistration(
      competition.id,
      division.id,
      settings,
      { refCode: generateRefCode(), displayName: "Mine" },
    );
    const { registration: theirs } = await seedRegistration(
      competition.id,
      division.id,
      settings,
      { refCode: generateRefCode(), displayName: "Theirs" },
    );
    const myRef = mine.ref_code!;

    await expect(withdrawRegistrationByRef(myRef, theirs.id, myToken)).rejects.toThrow(/not found/);

    const stillTheirs = await loadWithGroup(theirs.id);
    expect(stillTheirs.status).toBe("pending");
    const stillMine = await loadWithGroup(mine.id);
    expect(stillMine.status).toBe("pending");
  });

  it("no token still withdraws nothing", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      refCode: generateRefCode(),
    });
    const ref = registration.ref_code!;

    await expect(withdrawRegistrationByRef(ref, registration.id, "")).rejects.toThrow(/not found/);

    const still = await loadWithGroup(registration.id);
    expect(still.status).toBe("pending");
  });

  // ── Youth privacy (v3/11 gap 8, PROMPT-34) ──

  it("U16 age band auto-sets divisions.youth; /r/[ref] masks the name to first-initial", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division: created } = await rig(owner);
    // RS007/V380: age band (and the youth flag it derives) is PATCH-only —
    // createDivision no longer accepts a jsonb rule to set it at create
    // time; rig() itself can no longer take one either (its own `eligibility`
    // opt is gone). age_max: 15 < 18 re-derives youth=true (divisions.ts's
    // deriveYouth) — the property this test actually exercises.
    const division = await patchDivision(owner, created.id, {
      age_max: 15,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
    });
    expect(division.youth).toBe(true);
    expect(resolveNameDisplay(division.player_name_display, division.youth)).toBe("first_initial");

    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    // The eligibility GATE (age/guardian-consent enforcement at submit) was
    // submitRegistration's own job — deleted with it. This test's
    // subject is the name-masking on /r/[ref], independent of that gate, so
    // an eligible player is seeded directly with its dob/guardian on record.
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Arun Kumar",
      refCode: generateRefCode(),
      players: [{ name: "Arun Kumar", dob: "2012-05-01" }],
    });

    const view = await publicRegistrationStatusByRef(registration.ref_code!);
    expect(view.display_name).toBe("Arun K.");

    // Organiser-side stays full-fidelity (exports/check-in need real names).
    const rows = await listRegistrations(owner, division.id, null);
    expect(rows.find((r) => r.id === registration.id)?.display_name).toBe("Arun Kumar");
    expect(rows.find((r) => r.id === registration.id)?.ref_code).toBe(registration.ref_code);
  });

  it("open (non-youth) divisions default to full names and no auto guardian gate", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    expect(division.youth).toBe(false);
    expect(resolveNameDisplay(division.player_name_display, division.youth)).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// Payment method settings (spec 2026-07-12 §3)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("payment method settings (spec §3)", () => {
  it("stripe method requires charges_enabled and a viable minimum fee", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    // No Connect account yet → card method rejected outright.
    await expect(
      putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE,
        payment_method: "stripe",
        fee_cents: 500,
      }),
    ).rejects.toMatchObject({ status: 422 });

    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;

    // Below Stripe's minimum charge (100 minor units) — rejected.
    await expect(
      putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE,
        payment_method: "stripe",
        fee_cents: 50,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const ok = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "stripe",
      fee_cents: 500,
    });
    expect(ok.payment_method).toBe("stripe");
    expect(ok.charges_enabled).toBe(true);
  });

  // V310 (D19) inverted this: a community org CAN pick the card method. The
  // registration.paid gate itself is unchanged and still fires — the only thing
  // that can deny the key now is a staff override, which is the second half.
  it("community org can pick the card method, but a registration.paid deny still blocks it", async () => {
    const { orgId, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const ok = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "stripe",
      fee_cents: 500,
    });
    expect(ok.payment_method).toBe("stripe");

    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value)
              values (${orgId}, 'registration.paid', false)
              on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(orgId);
    await expect(
      putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE,
        payment_method: "stripe",
        fee_cents: 500,
      }),
    ).rejects.toThrow(PaymentRequiredError);
  });

  it("offline fees stay plan-free and store a per-division instructions override", async () => {
    const { orgId, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    const s = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 1500,
      payment_instructions: "Cash to the front desk before round 1",
    });
    expect(s.payment_method).toBe("offline");
    expect(s.payment_instructions).toBe("Cash to the front desk before round 1");

    // GET returns the org fallback + default method for the settings UI.
    await sql`update organizations
              set payment_instructions = 'Org-wide bank details',
                  default_payment_method = 'stripe'
              where id = ${orgId}`;
    const got = await getRegistrationSettings(owner, division.id);
    expect(got.org_payment_instructions).toBe("Org-wide bank details");
    expect(got.org_default_payment_method).toBe("stripe");
    expect(got.payment_instructions).toBe("Cash to the front desk before round 1");
  });
});

// ---------------------------------------------------------------------------
// Organiser payment actions (spec T7): mark paid (offline) + waive
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("organiser payment actions (spec T7)", () => {
  async function offlinePaidRig() {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 1500,
    });
    const res = await seedRegistration(competition.id, division.id, settings);
    return { owner, ownerId, division, reg: res.registration };
  }

  it("mark-paid confirms an offline registrant and records the actor", async () => {
    const { owner, ownerId, reg } = await offlinePaidRig();
    // Plain confirm still refuses while unpaid…
    await expect(confirmRegistration(owner, reg.id)).rejects.toMatchObject({
      status: 422,
    });
    // …mark-paid is the money-received path.
    const row = await markRegistrationPaidOffline(owner, reg.id);
    expect(row.status).toBe("confirmed");
    expect(row.entrant_id).not.toBeNull();
    expect(row.offline_marked_paid_at).not.toBeNull();
    const [audited] = await sql<{ actor_id: string }[]>`
      select actor_id from competition_events
      where type = 'registration.offline_paid'
        and payload->>'registration_id' = ${reg.id}`;
    expect(audited.actor_id).toBe(ownerId);
    // Idempotence guard: a second mark-paid 422s (no longer pending).
    await expect(markRegistrationPaidOffline(owner, reg.id)).rejects.toMatchObject({ status: 422 });
  });

  it("mark-paid rejects card-paid and free registrations", async () => {
    const { competition, division, owner, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    await expect(markRegistrationPaidOffline(owner, res.registration.id)).rejects.toMatchObject({
      status: 422,
    });
  });

  it("waive confirms without payment and audits the waiver", async () => {
    const { owner, reg } = await offlinePaidRig();
    const row = await confirmRegistrationWaived(owner, reg.id);
    expect(row.status).toBe("confirmed");
    expect(row.offline_marked_paid_at).toBeNull();
    const [audited] = await sql<{ id: string }[]>`
      select id from competition_events
      where type = 'registration.fee_waived'
        and payload->>'registration_id' = ${reg.id}`;
    expect(audited).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Card submit path (spec §3): checkout at submit + 48h pay window
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("card submit path (spec §3)", () => {
  it("snapshots the method, opens a 48h window, returns a checkout URL", async () => {
    const { competition, division, settings } = await stripeRig();
    // submitRegistration used to mint the checkout session immediately at
    // submit (RS001 demolition: deleted, no surviving "submit" call).
    // `createRegistrationCheckout` itself is unchanged and still reachable
    // through the surviving `resumeRegistrationCheckout` — seed the pending
    // stripe entry, then resume it to mint the SAME session.
    const res = await seedRegistration(competition.id, division.id, settings);
    expect(res.registration.payment_method).toBe("stripe");
    expect(res.registration.expires_at).not.toBeNull();
    expect(res.registration.amount_cents).toBe(500);

    const { checkout_url } = await resumeRegistrationCheckout(
      res.registration.id,
      res.access_token,
      "http://test.local",
    );
    expect(checkout_url).toBe("https://checkout.stripe.test/session");
    // The line item charges the snapshot, and the fee rides the chain (pro 2%).
    const args = stripeMock.checkoutCreate.mock.calls[0][0];
    expect(args.line_items[0].price_data.unit_amount).toBe(500);
    expect(args.payment_intent_data.application_fee_amount).toBe(10);
  });

  // V312: the fee rate locks at the FIRST paid entry, so a plan change or a
  // group detach mid-competition cannot re-rate entrants who have already
  // committed. This is the gap billing groups opened — a third party (the group
  // payer) can now move an org's plan out from under its in-flight competitions.
  it("locks the competition fee rate at the first paid entry, immune to a later plan change", async () => {
    const { orgId, competition, division, settings } = await stripeRig();

    // First entrant pays while the org is Pro (2%): £5 → 10p fee.
    const first = await seedRegistration(competition.id, division.id, settings);
    await resumeRegistrationCheckout(first.registration.id, first.access_token, "http://test.local");
    expect(stripeMock.checkoutCreate.mock.calls[0][0].payment_intent_data.application_fee_amount).toBe(10);
    await handleRegistrationCheckoutCompleted(fakeSession(first.registration.id, 500));

    const [locked] = await sql<{ fee_percent: number | null }[]>`
      select fee_percent from competitions where id = ${competition.id}`;
    expect(locked.fee_percent).toBe(2);

    // The org drops to Community (8%) — exactly what a detach from a paid group
    // leaves behind once the comp lapses.
    await setOrgPlan(orgId, "community");
    stripeMock.checkoutCreate.mockClear();

    // A LATER entrant is still charged 2%, not 8%: 10p, not 40p.
    const second = await seedRegistration(competition.id, division.id, settings, {
      contactEmail: "second@test.local",
    });
    await resumeRegistrationCheckout(second.registration.id, second.access_token, "http://test.local");
    expect(stripeMock.checkoutCreate.mock.calls[0][0].payment_intent_data.application_fee_amount).toBe(10);
    // And the second registration froze the SAME rate it was charged at. Read
    // from the DB, not the returned row: createRegistrationCheckout stamps the
    // cart AFTER the row was seeded/read (V364: fee_percent lives on the cart).
    const secondGroup = await loadWithGroup(second.registration.id);
    expect(secondGroup.fee_percent).toBe(2);
  });

  it("keeps the rate live until the first entrant pays, so a pre-sales plan fix applies", async () => {
    const { orgId, competition, division, settings } = await stripeRig();

    // An unpaid entry does NOT lock the rate.
    await seedRegistration(competition.id, division.id, settings);
    const [before] = await sql<{ fee_percent: number | null }[]>`
      select fee_percent from competitions where id = ${competition.id}`;
    expect(before.fee_percent).toBeNull();

    // Organiser corrects the plan up to Pro Plus (1%) before anyone pays.
    await setOrgPlan(orgId, "pro_plus");
    stripeMock.checkoutCreate.mockClear();

    const paid = await seedRegistration(competition.id, division.id, settings, {
      contactEmail: "payer@test.local",
    });
    await resumeRegistrationCheckout(paid.registration.id, paid.access_token, "http://test.local");
    // £5 at 1% → 5p, the corrected rate, not the old 2%.
    expect(stripeMock.checkoutCreate.mock.calls[0][0].payment_intent_data.application_fee_amount).toBe(5);
    await handleRegistrationCheckoutCompleted(fakeSession(paid.registration.id, 500));
    const [after] = await sql<{ fee_percent: number | null }[]>`
      select fee_percent from competitions where id = ${competition.id}`;
    expect(after.fee_percent).toBe(1);
  });

  it("locks the rate the PAID session was billed at, not a rate a re-mint overwrote", async () => {
    // The stale-session hole: a checkout minted at 2% while the comp was on
    // Pro, then the org drops to Community (8%) and the reg is re-minted (resume
    // / reminder), overwriting reg.fee_percent to 8. The entrant completes the
    // still-open ORIGINAL 2% session. The competition must lock at what that
    // session charged (2%), not the overwritten reg.fee_percent (8%).
    const { orgId, competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    // Simulate the plan drop + re-mint overwriting the reg's frozen rate
    // (fee_percent lives on the cart now, V364).
    await setOrgPlan(orgId, "community");
    await sql`update registration_groups set fee_percent = 8 where id = ${res.registration.group_id}`;

    // Pay the ORIGINAL 2% session (its metadata still says 2).
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500, 2));

    const [c] = await sql<{ fee_percent: number | null }[]>`
      select fee_percent from competitions where id = ${competition.id}`;
    expect(c.fee_percent).toBe(2);
  });

  it("an offline paid entry does not lock the rate — no platform fee flowed", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 500,
    });
    const res = await seedRegistration(competition.id, division.id, settings);
    await markRegistrationPaidOffline(owner, res.registration.id);
    const [c] = await sql<{ fee_percent: number | null }[]>`
      select fee_percent from competitions where id = ${competition.id}`;
    expect(c.fee_percent).toBeNull();
  });

  // "a failed checkout mint keeps the registration (pay from status page)"
  // was deleted in the RS001 sweep on the theory that it had no equivalent —
  // `resumeRegistrationCheckout` propagates a mint failure instead of
  // swallowing it the way submitRegistration used to. That's true, but it
  // doesn't remove the invariant: the registration and its cart must still
  // survive the failed attempt untouched (createRegistrationCheckout only
  // writes checkout_session_id/fee_percent to registration_groups AFTER
  // checkout.sessions.create resolves), so nothing is deleted or moved to a
  // terminal status. Assert around the throw instead of a swallowed return.
  // RS007 review fix: the thrown error is now `mintOrTranslate`'s sanitized
  // 502, never the raw Stripe message — see the dedicated "sanitizes" test
  // below for that assertion. This test's own concern (row survives
  // untouched) is unaffected by that change.
  it("a failed checkout mint leaves the registration and its cart untouched", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    stripeMock.checkoutCreate.mockRejectedValueOnce(new Error("stripe down"));

    await expect(
      resumeRegistrationCheckout(res.registration.id, res.access_token, "http://test.local"),
    ).rejects.toMatchObject({ status: 502 });

    const after = await loadWithGroup(res.registration.id);
    expect(after).toBeTruthy(); // row not deleted
    expect(after.status).toBe("pending"); // not flipped to a terminal status
    expect(after.checkout_session_id).toBeNull(); // no half-written mint
    expect(after.amount_cents).toBe(res.registration.amount_cents);
  });

  // RS007 review fix (FIX 2) — mintOrTranslate used to rethrow every
  // non-amount_too_small Stripe failure untouched, and v1()'s catch-all
  // (http.ts) forwards a non-HttpError's `.message` to the client verbatim:
  // a Stripe-authored message can name the connected account, a session id,
  // or another identifier that must never reach a public pay page. Shaped
  // exactly like the live leak the review found: a disconnected/restricted
  // Connect account makes transfer_data.destination invalid, and Stripe's
  // own invalid-request message echoes the account id.
  it("sanitizes any OTHER Stripe checkout failure into a generic 502 — never forwards Stripe's own message (account id, etc.)", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    const [org] = await sql<{ stripe_account_id: string }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    const acctId = org.stripe_account_id;
    const res = await seedRegistration(competition.id, division.id, settings);
    stripeMock.checkoutCreate.mockRejectedValueOnce(
      Object.assign(new Error(`No such destination: '${acctId}'`), {
        code: "resource_missing",
        type: "StripeInvalidRequestError",
      }),
    );

    let caught: unknown;
    try {
      await resumeRegistrationCheckout(res.registration.id, res.access_token, "http://test.local");
      throw new Error("expected resumeRegistrationCheckout to reject");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const httpErr = caught as HttpError;
    expect(httpErr.status).toBe(502);
    expect(httpErr.message).not.toContain(acctId);
    expect(httpErr.message).not.toContain("acct_");
    expect(httpErr.message).not.toContain("No such destination");
  });

  // RS007 review fix (FIX 2) — the ONE deliberate translation must survive
  // unchanged: amount_too_small still becomes the stable 422, not the new
  // generic 502 every OTHER Stripe failure now gets.
  it("still translates Stripe's amount_too_small into the stable 422 — unaffected by the new sanitization", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    stripeMock.checkoutCreate.mockRejectedValueOnce(
      Object.assign(new Error("The Checkout Session's total amount must convert to at least 30 pence."), {
        code: "amount_too_small",
      }),
    );

    await expect(
      resumeRegistrationCheckout(res.registration.id, res.access_token, "http://test.local"),
    ).rejects.toMatchObject({ status: 422, code: "REGISTRATION_AMOUNT_TOO_SMALL" });
  });

  it("offline submits keep no expiry and no checkout", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 500,
    });
    const res = await seedRegistration(competition.id, division.id, settings);
    expect(res.checkout_url).toBeNull();
    expect(res.registration.expires_at).toBeNull();
    expect(res.registration.payment_method).toBe("offline");
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("blocks card submits when Connect breaks, and the public panel says why", async () => {
    const { orgId, orgSlug, competition, division, settings } = await stripeRig();
    await sql`update organizations set stripe_charges_enabled = false where id = ${orgId}`;
    // submitRegistration's own pre-flight charges_enabled check is gone
    //, but the surviving resumeRegistrationCheckout carries the SAME
    // guard (registrations.ts: "Payments are not set up for this organiser
    // yet") — seed the pending stripe entry and resume it to exercise it.
    const res = await seedRegistration(competition.id, division.id, settings);
    await expect(
      resumeRegistrationCheckout(res.registration.id, res.access_token, "http://test.local"),
    ).rejects.toMatchObject({ status: 503 });
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const div = info.divisions.find((d) => d.division_id === division.id)!;
    expect(div.open).toBe(false);
    expect(div.closed_reason).toBe("payments_unavailable");
    expect(div.payment_method).toBe("stripe");
  });

  // V380 dropped the jsonb gender rules, so a free-text `eligibility_note` is
  // the only surviving channel for a restriction the category enum cannot
  // express, and `requiresGender` now treats a non-empty note as "collect
  // gender" (collection only — nothing programmatically evaluates note text).
  // The join-page preview wired that immediately; publicRegistrationInfo did
  // not, because the two live in different files and only one lane touched it.
  // Without the note passed through here, the SAME division collects gender on
  // the join page and silently skips it on the main register flow — the split
  // that makes a half-applied fix read as a working one.
  it("collects gender on the register page when a note is the only restriction left", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    await sql`
      update divisions
      set category = null, eligibility_note = 'Under-19 girls only'
      where id = ${division.id}`;
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const div = info.divisions.find((d) => d.division_id === division.id)!;
    expect(div.requires_gender, "a note-only division must still collect gender").toBe(true);
  });

  it("does not collect gender for a division with no category and no note", async () => {
    const { orgSlug, competition, division } = await stripeRig();
    await sql`
      update divisions set category = null, eligibility_note = null where id = ${division.id}`;
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const div = info.divisions.find((d) => d.division_id === division.id)!;
    expect(div.requires_gender, "an unrestricted division must not ask for gender").toBe(false);
  });

  // RS003 W3a owner ruling 4: the group's currency snapshot must be
  // validated BEFORE any Stripe call — both that it is still an allowlisted
  // registration currency, AND that it still matches the org's CURRENT
  // currency (the same-currency lock pins that to the connected account's
  // settlement currency; a stale snapshot must never surface as a Stripe
  // error on a registrant's pay page). Both branches seed the mismatch
  // directly via `seedRegistration`'s raw `currency` param — bypassing
  // `putRegistrationSettings`, which always sources currency live from the
  // org and so could never reproduce a STALE snapshot.
  it("422s with a stable code when the group's currency has gone stale (not an allowlisted currency), and never calls Stripe", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    // "jpy" is not in REGISTRATION_CURRENCIES (usd/eur/gbp/inr/aud) — a
    // snapshot minted before a delisting, or simply corrupt data.
    const res = await seedRegistration(competition.id, division.id, {
      fee_cents: 500,
      currency: "jpy",
      payment_method: "stripe",
    });
    await expect(
      resumeRegistrationCheckout(res.registration.id, res.access_token, "http://test.local"),
    ).rejects.toMatchObject({ status: 422, code: "REGISTRATION_CURRENCY_UNAVAILABLE" });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("422s with the same stable code when the group's snapshot no longer matches the org's CURRENT currency, and never calls Stripe", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    // organizations.currency defaults to 'gbp' (V365) and is left untouched
    // here — the group below snapshots 'usd', a DIFFERENT but individually
    // valid currency, reproducing an org that changed its preferred currency
    // after this cart was submitted.
    const { competition, division } = await rig(owner);
    const res = await seedRegistration(competition.id, division.id, {
      fee_cents: 500,
      currency: "usd",
      payment_method: "stripe",
    });
    await expect(
      resumeRegistrationCheckout(res.registration.id, res.access_token, "http://test.local"),
    ).rejects.toMatchObject({ status: 422, code: "REGISTRATION_CURRENCY_UNAVAILABLE" });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("late payment on a withdrawn registration is auto-refunded", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await withdrawRegistrationPublic(res.registration.id, res.access_token);

    // The abandoned checkout completes AFTER the withdrawal.
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("withdrawn");
    expect(row.entrant_id).toBeNull();
    expect(row.refunded_cents).toBe(500);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_test_" + res.registration.id.slice(0, 8),
        reverse_transfer: true,
        refund_application_fee: true,
      }),
    );
  });

  // REVIEW FIX (money-path defect #2) — confirmPaidRegistration's late-
  // payment branch matched only withdrawn/expired/rejected, but a PROMOTED
  // entry that misses its own 48h window lapses to 'waitlisted' instead
  // (V378/RS007 — see the sweep's lapse pass). A webhook landing after that
  // lapse fell through to the ordinary confirm branch: 'paid', then
  // materialised — an entrant seated in a slot the sweep had already handed
  // to the next waitlist candidate, with no refund for the late payer.
  it("REVIEW FIX: a late payment against a promotion that already LAPSED to waitlisted is refunded, never silently confirmed", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const waiting = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    const promotedX = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    expect(promotedX!.status).toBe("pending");

    // A bystander elsewhere in the division, waiting far longer — outranks
    // X's fresh waitlisted_at on the sweep's re-offer (see
    // reference_waitlist_reoffer_self_selects_if_only_candidate in this
    // task's own agent memory), so this test isolates the late-payment
    // guard from the re-offer/self-selection behaviour covered elsewhere.
    const filler = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", contactEmail: "filler-late-pay@test.local",
    });
    await sql`update registrations set created_at = now() - interval '1 day' where id = ${filler.registration.id}`;

    // X's checkout is in flight when its OWN clock lapses — driven directly,
    // never by mocking server time (same convention as the sibling lapse
    // tests above).
    await sql`update registrations set promotion_expires_at = now() - interval '1 minute'
              where id = ${promotedX!.id}`;
    await sweepRegistrations("https://test.local");
    const lapsedRow = await loadWithGroup(promotedX!.id);
    expect(lapsedRow.status, "sanity: X really did lapse to waitlisted").toBe("waitlisted");

    // The abandoned checkout completes AFTER the lapse.
    await handleRegistrationCheckoutCompleted(fakeSession(promotedX!.id, 500));

    const row = await loadWithGroup(promotedX!.id);
    // Reverting the terminal-status list to omit 'waitlisted' makes this
    // fail: the entry silently flips to 'paid' then 'confirmed' (auto-
    // approval materialises it) even though its slot was already re-offered.
    expect(row.status).toBe("waitlisted");
    expect(row.entrant_id).toBeNull();
    expect(row.refunded_cents).toBe(500);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_test_" + promotedX!.id.slice(0, 8),
        reverse_transfer: true,
        refund_application_fee: true,
      }),
    );
  });

  it("a second completed session refunds the duplicate intent, state untouched", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);

    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    const confirmed = await loadWithGroup(res.registration.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.expires_at).toBeNull(); // pay window cleared on confirm

    // Second tab pays with a DIFFERENT intent → refund the duplicate.
    const dup = {
      ...fakeSession(res.registration.id, 500),
      payment_intent: "pi_dup_1",
    } as unknown as Stripe.Checkout.Session;
    await handleRegistrationCheckoutCompleted(dup);
    const after = await loadWithGroup(res.registration.id);
    expect(after.status).toBe("confirmed");
    expect(after.payment_intent_id).toBe(confirmed.payment_intent_id); // original kept
    expect(after.refunded_cents).toBe(0); // the CONFIRMED payment is untouched
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_dup_1" }),
    );

    // Pure replay of the SAME session refunds nothing.
    stripeMock.refundCreate.mockClear();
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    expect(stripeMock.refundCreate).not.toHaveBeenCalled();
  });

  it("promotion snapshots the current fee and opens a 48h window for card divisions", async () => {
    const { owner, competition, division, settings } = await stripeRig({
      capacity: 1,
    });
    const a = await seedRegistration(competition.id, division.id, settings);
    // Overflow-at-submission was submitRegistration's own capacity decision
    // — B is seeded directly waitlisted; promotion is the SURVIVING
    // behaviour this test actually pins.
    const b = await seedRegistration(competition.id, division.id, settings, {
      contactEmail: "b@test.local",
      status: "waitlisted",
    });
    expect(b.registration.status).toBe("waitlisted");
    expect(b.registration.amount_cents).toBe(0);

    // Organiser raises the fee while B waits — promotion charges the NEW fee.
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "stripe",
      fee_cents: 700,
      capacity: 1,
    });
    await withdrawRegistrationPublic(a.registration.id, a.access_token);

    const bRow = await loadWithGroup(b.registration.id);
    expect(bRow.status).toBe("pending");
    expect(bRow.amount_cents).toBe(700);
    expect(bRow.payment_method).toBe("stripe");
    expect(bRow.expires_at).not.toBeNull();
  });

  // sweepRegistrations() is the hourly PLATFORM cron (POST /api/cron/registrations,
  // authenticated by the global CRON_SECRET — there is no org in scope at that call
  // site). It is global by design, so its returned {reminded, expired, promoted}
  // tallies also count rows this test never created: every other org living in the
  // shared dev database, including registrations left by earlier runs that have
  // since aged into the T-24h reminder window. Asserting on those tallies made this
  // test fail with shapes like "expected 36 to be 1".
  //
  // The fix is identity, not arithmetic: every assertion below is pinned to THIS
  // run's own registration ids (`a`/`b`, fresh UUIDs), so the sweep's behaviour is
  // checked exactly — reminded once and only once, expired once, promoted once —
  // regardless of what else the sweep legitimately picks up.
  it("sweep reminds once inside the last 24h, then expires and promotes", async () => {
    const { competition, division, settings } = await stripeRig({ capacity: 1 });
    const a = await seedRegistration(competition.id, division.id, settings);
    // Overflow-at-submission was submitRegistration's own capacity decision
    // — B is seeded directly waitlisted; the sweep's expire+promote
    // behaviour is the SURVIVING logic this test actually pins.
    const b = await seedRegistration(competition.id, division.id, settings, {
      contactEmail: "b@test.local",
      status: "waitlisted",
    });
    expect(b.registration.status).toBe("waitlisted");

    // Checkout sessions minted for OUR registration only — the sweep mints one per
    // due row platform-wide, and each carries a comma-joined
    // metadata.registration_ids (RS003 W3a: group-scoped, one id per call site
    // here since each due row is reminded/promoted individually).
    const checkoutsFor = (id: string) =>
      stripeMock.checkoutCreate.mock.calls.filter(([args]) =>
        (args as { metadata?: { registration_ids?: string } })
          ?.metadata?.registration_ids
          ?.split(",")
          .includes(id),
      ).length;
    const regRow = (id: string) => loadWithGroup(id);
    // REVIEW FIX (money-path defect #7): pass (1a)'s sent mark moved off the
    // GROUP (registration_groups.reminded_at) onto the ENTRY
    // (registrations.submit_reminded_at, V383) — see that migration's own
    // doc comment. loadWithGroup's `.reminded_at` now reads the group's
    // column, which this pass no longer writes at all.
    const submitRemindedAt = async (id: string) => {
      const [row] = await sql<{ submit_reminded_at: Date | null }[]>`
        select submit_reminded_at from registrations where id = ${id}`;
      return row!.submit_reminded_at;
    };
    const auditCount = async (type: string, id: string) => {
      const [row] = await sql<{ n: string }[]>`
        select count(*)::text as n from competition_events
        where type = ${type} and payload->>'registration_id' = ${id}`;
      return Number(row.n);
    };

    // Inside the last 24h → one reminder for A, exactly once. expires_at
    // lives on the cart now (V364).
    await sql`update registration_groups set expires_at = now() + interval '10 hours'
              where id = ${a.registration.group_id}`;
    expect(await submitRemindedAt(a.registration.id)).toBeNull();
    stripeMock.checkoutCreate.mockClear();
    const first = await sweepRegistrations("http://test.local");
    expect(first.reminded).toBeGreaterThanOrEqual(1); // A is among the reminded
    const remindedAt = await submitRemindedAt(a.registration.id);
    expect(remindedAt).not.toBeNull();
    expect(checkoutsFor(a.registration.id)).toBe(1); // fresh session for the email

    // submit_reminded_at guard: a second sweep must not re-remind A.
    await sweepRegistrations("http://test.local");
    expect(await submitRemindedAt(a.registration.id)).toEqual(remindedAt);
    expect(checkoutsFor(a.registration.id)).toBe(1); // still exactly one, no re-send

    // Past the deadline → A expired + B promoted with a fresh window.
    // expires_at lives on the cart now (V364).
    await sql`update registration_groups set expires_at = now() - interval '1 hour'
              where id = ${a.registration.group_id}`;
    const res = await sweepRegistrations("http://test.local");
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect(res.promoted).toBeGreaterThanOrEqual(1);
    const aRow = await regRow(a.registration.id);
    expect(aRow.status).toBe("expired");
    const bRow = await regRow(b.registration.id);
    expect(bRow.status).toBe("pending");
    expect(bRow.amount_cents).toBe(500);
    expect(bRow.expires_at).not.toBeNull();
    // Expired once, and the expiry audit names B as the row it promoted.
    expect(await auditCount("registration.expired", a.registration.id)).toBe(1);
    expect(await auditCount("registration.promoted", b.registration.id)).toBe(1);
    const [expiredEvent] = await sql<{ promoted_registration_id: string }[]>`
      select payload->>'promoted_registration_id' as promoted_registration_id
      from competition_events
      where type = 'registration.expired'
        and payload->>'registration_id' = ${a.registration.id}`;
    expect(expiredEvent.promoted_registration_id).toBe(b.registration.id);
    expect(checkoutsFor(b.registration.id)).toBe(1); // promotion mints B's pay link

    // A further sweep is a no-op for OUR rows: nothing re-expires, nothing
    // re-promotes, and B (a fresh 48h window) is not yet reminder-due.
    await sweepRegistrations("http://test.local");
    expect(await regRow(a.registration.id)).toEqual(aRow);
    expect(await regRow(b.registration.id)).toEqual(bRow);
    expect(await auditCount("registration.expired", a.registration.id)).toBe(1);
    expect(await auditCount("registration.promoted", b.registration.id)).toBe(1);
    expect(checkoutsFor(a.registration.id)).toBe(1); // A stays reminded exactly once
    expect(checkoutsFor(b.registration.id)).toBe(1); // B not re-linked
  });

  // RS007 follow-up (this wave): the reminder mark was a RECEIPT (written
  // after send), never a CLAIM — nothing re-checked it at write time. The
  // live vector is registrations-sweep.yml's own curl --retry: up to 200
  // rows x (checkout mint + email) serially makes a >60s sweep ordinary, so
  // the client times out and re-POSTs while the FIRST invocation is still
  // running server-side — two genuinely concurrent sweepRegistrations()
  // calls, not two workflow runs (the workflow itself has a concurrency:
  // gate).
  //
  // Staged as a genuine STAGGER, deliberately not a tight simultaneous
  // mint collision: the racing sweep is kicked off from inside the FIRST
  // invocation's OWN email-send call (never any other due row's — filtered
  // by contact email) and fully AWAITED there before the first invocation
  // takes its own next step. This is not a guessed delay: by the time any
  // invocation reaches its send, its own mint+stamp has ALREADY committed
  // unconditionally (send is strictly sequenced after them in both the pre-
  // and post-fix code), so the racing sweep's own checkout read always
  // observes an ALREADY-STAMPED session — never a collision on
  // createRegistrationCheckout's OWN, unrelated checkout_session_id CAS
  // (confirmed live: an earlier version of this test that raced the mint
  // itself tripped exactly that unrelated CAS and passed for the wrong
  // reason, 409-ing the loser before it could ever send). And because the
  // racing sweep's own due-select runs while still inside the first
  // invocation's send call, it reads whatever the reminder mark ACTUALLY is
  // at that exact point — still null pre-fix (mark comes after send, so the
  // race sweep sees the row as due and sends again), already claimed
  // post-fix (mark/claim comes before send, so the race sweep's own
  // due-select excludes the row outright) — which is exactly the fix this
  // test exists to prove.
  it("RS007: two sweeps racing the SAME due reminder — exactly one email goes out, never two", async () => {
    const { competition, division, settings } = await stripeRig();
    const contactEmail = `remind-race-${randomUUID().slice(0, 8)}@test.local`;
    const a = await seedRegistration(competition.id, division.id, settings, { contactEmail });
    await sql`update registration_groups set expires_at = now() + interval '1 hour'
              where id = ${a.registration.group_id}`;

    let bPromise: Promise<unknown> | null = null;
    emailMock.paymentReminder.mockImplementation(async (opts: unknown) => {
      if ((opts as { to?: string } | undefined)?.to === contactEmail && !bPromise) {
        bPromise = sweepRegistrations("http://test.local");
        await bPromise;
      }
      return true;
    });

    await sweepRegistrations("http://test.local");
    // Sanity: the race actually happened — otherwise this test would pass
    // vacuously regardless of the fix.
    expect(bPromise, "the racing sweep must have been triggered").not.toBeNull();

    const oursCalls = emailMock.paymentReminder.mock.calls.filter(
      ([opts]) => (opts as { to?: string })?.to === contactEmail,
    );
    expect(oursCalls).toHaveLength(1);
    // REVIEW FIX (money-path defect #7): the winner's claim/mark now lives on
    // the ENTRY (registrations.submit_reminded_at, V383), not the group.
    const [row] = await sql<{ submit_reminded_at: Date | null }[]>`
      select submit_reminded_at from registrations where id = ${a.registration.id}`;
    expect(row!.submit_reminded_at, "the winner's claim stuck").not.toBeNull();
  });

  // REVIEW FIX (money-path defect #7) — pass (1a) iterates PER ENTRY but used
  // to claim and mark a GROUP column (registration_groups.reminded_at /
  // reminder_claimed_at). A cart with two still-pending, never-promoted
  // entries produces TWO rows in the "due" select sharing one group_id:
  // whichever wins the group's claim silences the OTHER's own attempt (same
  // filter, now non-null) for every future sweep — its fee is never
  // presented to anyone, since each reminder mints a checkout for `[reg.id]`
  // alone, not the whole cart. V383 moves the claim/mark onto the entry
  // (mirroring pass (1b)'s promotion_reminded_at) so cart siblings can never
  // silence each other.
  it("REVIEW FIX: both never-promoted entries in the SAME cart are reminded independently, never silenced by a sibling's claim", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const a = await seedRegistration(competition.id, division.id, settings, {
      contactEmail: "cart-sibling-a@test.local",
    });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 500, "Cart Sibling B", "pending");
    await sql`update registration_groups set expires_at = now() + interval '10 hours'
              where id = ${a.registration.group_id}`;

    const checkoutsFor = (id: string) =>
      stripeMock.checkoutCreate.mock.calls.filter(([args]) =>
        (args as { metadata?: { registration_ids?: string } })
          ?.metadata?.registration_ids
          ?.split(",")
          .includes(id),
      ).length;
    stripeMock.checkoutCreate.mockClear();

    const res = await sweepRegistrations("https://test.local");
    expect(res.reminded).toBeGreaterThanOrEqual(2);

    // Reverting to a group-level claim/mark makes this fail: A wins the
    // shared claim and B's own attempt finds it already non-null — B is
    // silently excluded from every future sweep.
    expect(checkoutsFor(a.registration.id), "A reminded").toBe(1);
    expect(checkoutsFor(b.id), "B reminded independently, not silenced by A's claim").toBe(1);

    const submitRemindedAt = async (id: string) => {
      const [row] = await sql<{ submit_reminded_at: Date | null }[]>`
        select submit_reminded_at from registrations where id = ${id}`;
      return row!.submit_reminded_at;
    };
    expect(await submitRemindedAt(a.registration.id)).not.toBeNull();
    expect(await submitRemindedAt(b.id)).not.toBeNull();

    // A second sweep must not re-remind either.
    await sweepRegistrations("https://test.local");
    expect(checkoutsFor(a.registration.id)).toBe(1);
    expect(checkoutsFor(b.id)).toBe(1);
  });

  // REVIEW FIX (money-path defect #9) — a losing claim used to mint a real
  // Stripe checkout session BEFORE checking whether it actually won the
  // claim, unconditionally stamping registration_groups.checkout_session_id
  // with a session nobody would ever hold (the loser never sends, so nobody
  // is ever given that URL). Repro mirrors the racing-sweeps test above:
  // trigger a genuinely concurrent second sweepRegistrations() call from
  // inside the FIRST invocation's own send call, at which point the first
  // invocation's claim has ALREADY committed but its send has not — so the
  // racing invocation's own "due" select still finds the row (submit_reminded_at
  // is still null) and, pre-fix, still minted before its own claim attempt
  // failed. Fixed by moving the mint to AFTER a successful claim, so a
  // losing invocation never reaches createRegistrationCheckout at all.
  it("REVIEW FIX: a losing claim never mints a checkout — the group's session pointer is never clobbered by a session nobody holds", async () => {
    const { competition, division, settings } = await stripeRig();
    const contactEmail = `mint-race-${randomUUID().slice(0, 8)}@test.local`;
    const a = await seedRegistration(competition.id, division.id, settings, { contactEmail });
    await sql`update registration_groups set expires_at = now() + interval '1 hour'
              where id = ${a.registration.group_id}`;

    let bPromise: Promise<unknown> | null = null;
    emailMock.paymentReminder.mockImplementation(async (opts: unknown) => {
      if ((opts as { to?: string } | undefined)?.to === contactEmail && !bPromise) {
        bPromise = sweepRegistrations("http://test.local");
        await bPromise;
      }
      return true;
    });
    stripeMock.checkoutCreate.mockClear();

    await sweepRegistrations("http://test.local");
    expect(bPromise, "the racing sweep must have been triggered").not.toBeNull();

    const mintsForOurs = stripeMock.checkoutCreate.mock.calls.filter(([args]) =>
      (args as { metadata?: { registration_ids?: string } })
        ?.metadata?.registration_ids
        ?.split(",")
        .includes(a.registration.id),
    ).length;
    // Reverting the fix (mint before claim) makes this fail: the racing
    // invocation still mints a real session before its own claim attempt
    // loses — TWO mints for one reminder that was only ever sent once.
    expect(mintsForOurs, "exactly one mint — the loser's claim failed before it ever minted").toBe(1);

    const [groupRow] = await sql<{ checkout_session_id: string | null }[]>`
      select checkout_session_id from registration_groups where id = ${a.registration.group_id}`;
    expect(groupRow!.checkout_session_id, "the winner's own session is what got stamped").not.toBeNull();
  });

  // V381/RS007: the claim above is now a LEASE, not a permanent mark — see
  // the migration's own doc comment for why a permanent claim loses a
  // reminder forever on an ungraceful death (deploy, OOM, SIGKILL) between
  // the claim committing and the send completing. Simulated here by writing
  // the lease column directly via SQL — exactly what a crashed sweep would
  // leave behind — rather than trying to kill a real process mid-test.
  // Asserted via the email mock, not stripeMock.checkoutCreate: this pass's
  // own claim/mark now lives on registrations.submit_reminded_at /
  // submit_reminder_claimed_at (V383, money-path defect #7's fix), which
  // this test also drives directly below.
  it("V381: a fresh lease blocks a concurrent claim; a stale one is retried and the reminder still goes out", async () => {
    const { competition, division, settings } = await stripeRig();
    const contactEmail = `lease-fresh-${randomUUID().slice(0, 8)}@test.local`;
    const a = await seedRegistration(competition.id, division.id, settings, { contactEmail });
    await sql`update registration_groups set expires_at = now() + interval '10 hours'
              where id = ${a.registration.group_id}`;

    const sentCallsForOurs = () =>
      emailMock.paymentReminder.mock.calls.filter(
        ([opts]) => (opts as { to?: string })?.to === contactEmail,
      );
    const sentMark = async () => {
      const [row] = await sql<{ submit_reminded_at: Date | null }[]>`
        select submit_reminded_at from registrations where id = ${a.registration.id}`;
      return row!.submit_reminded_at;
    };

    // Simulate a crash: an earlier invocation claimed the lease and died
    // before the send completed — submit_reminded_at (sent) is still null.
    // This is exactly the state 648c56503's permanent claim would have left
    // forever.
    await sql`update registrations set submit_reminder_claimed_at = now()
              where id = ${a.registration.id}`;

    // The lease is still fresh — this sweep must not double-claim or send.
    await sweepRegistrations("http://test.local");
    expect(await sentMark(), "still unsent while the lease is fresh").toBeNull();
    expect(sentCallsForOurs(), "blocked — no send while the lease holds").toHaveLength(0);

    // Age the lease out of its window (well beyond any reasonable lease
    // duration, so this does not depend on the exact minutes chosen) — a
    // later sweep must treat this row as claimable again and actually send.
    await sql`update registrations set submit_reminder_claimed_at = now() - interval '1 day'
              where id = ${a.registration.id}`;
    const res = await sweepRegistrations("http://test.local");
    expect(res.reminded).toBeGreaterThanOrEqual(1);
    expect(await sentMark(), "the stale lease was retried and the reminder sent").not.toBeNull();
    expect(sentCallsForOurs(), "exactly one send once the lease actually goes through").toHaveLength(1);
  });

  // RS007 review fix (FIX 1, found after V381 landed) — sendPaymentReminderEmail
  // NEVER throws on a provider-level failure: lib/email.ts's send() catches
  // every failure mode itself (missing key, suppressed, non-2xx, fetch throw)
  // and RETURNS false. V381's fix above only reverted the LEASE inside a
  // `catch`, so a `false` return fell through to the unconditional "sent"
  // write and permanently marked reminded_at for an email that was never
  // delivered — worse than the crash V381 targeted, since an ordinary Resend
  // 4xx/5xx is far commoner than a process death. The mock only misbehaves
  // for THIS test's own contact email (same trick the racing-sweeps test
  // above uses), so a platform row from another test/org can never be the
  // one that "consumes" the forced failure.
  it("a delivered-but-failed send (false return, not a throw) clears the lease instead of marking sent, and the next sweep retries", async () => {
    const { competition, division, settings } = await stripeRig();
    const contactEmail = `remind-false-${randomUUID().slice(0, 8)}@test.local`;
    const a = await seedRegistration(competition.id, division.id, settings, { contactEmail });
    await sql`update registration_groups set expires_at = now() + interval '10 hours'
              where id = ${a.registration.group_id}`;

    const sentCallsForOurs = () =>
      emailMock.paymentReminder.mock.calls.filter(
        ([opts]) => (opts as { to?: string })?.to === contactEmail,
      );
    // REVIEW FIX (money-path defect #7): this pass's claim/mark columns now
    // live on the entry (registrations.submit_reminded_at /
    // submit_reminder_claimed_at, V383), not the group.
    const cols = async () => {
      const [row] = await sql<{ submit_reminded_at: Date | null; submit_reminder_claimed_at: Date | null }[]>`
        select submit_reminded_at, submit_reminder_claimed_at from registrations
        where id = ${a.registration.id}`;
      return row!;
    };

    emailMock.paymentReminder.mockImplementation(async (opts: unknown) => {
      if ((opts as { to?: string } | undefined)?.to === contactEmail) return false;
      return true;
    });
    await sweepRegistrations("http://test.local");
    const afterFailure = await cols();
    expect(afterFailure.submit_reminded_at, "never delivered — the permanent mark must stay null").toBeNull();
    expect(afterFailure.submit_reminder_claimed_at, "the lease is released, not left stuck").toBeNull();
    expect(sentCallsForOurs()).toHaveLength(1);

    // Next sweep: let the send succeed and confirm the row is picked back up.
    // `.mockImplementation` only (never `.mockReset` here) — reset also
    // wipes `.mock.calls`, which would erase the failed attempt recorded
    // above and make the length-2 assertion below vacuous.
    emailMock.paymentReminder.mockImplementation(async () => true);
    const res2 = await sweepRegistrations("http://test.local");
    expect(res2.reminded).toBeGreaterThanOrEqual(1);
    const afterRetry = await cols();
    expect(afterRetry.submit_reminded_at, "the retried send is now marked sent").not.toBeNull();
    expect(sentCallsForOurs()).toHaveLength(2); // the failed attempt + the retry
  });

  it("reconciles by session from /r/[ref] (token-free return)", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings, {
      refCode: generateRefCode(),
    });
    const ref = res.registration.ref_code as string;
    const session = fakeSession(res.registration.id, 500);
    // The cart's OWN stored session — reconcileRegistrationBySession only
    // ever retrieves the session THIS cart minted (security fix, RS006): a
    // sessionId that doesn't match this stored value is rejected before any
    // Stripe call, so the test must stamp it to exercise the retrieve path
    // at all.
    await sql`update registration_groups set checkout_session_id = ${session.id}
              where id = ${res.registration.group_id}`;

    // Mismatched session (different registration, none of it this ref's) →
    // no-op.
    stripeMock.checkoutRetrieve.mockResolvedValueOnce({
      ...session,
      metadata: { kind: "registration_group", registration_ids: randomUUID() },
    });
    expect(await reconcileRegistrationBySession(ref, session.id)).toBe(false);

    stripeMock.checkoutRetrieve.mockResolvedValueOnce(session);
    expect(await reconcileRegistrationBySession(ref, session.id)).toBe(true);
    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed");
  });

  it("reconciles by token: membership in registration_ids, not equality on the old singular key", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await sql`update registration_groups set checkout_session_id = 'cs_test_placeholder'
              where id = ${res.registration.group_id}`;
    const session = fakeSession(res.registration.id, 500);

    // Session names a DIFFERENT registration only → no-op.
    stripeMock.checkoutRetrieve.mockResolvedValueOnce({
      ...session,
      metadata: { kind: "registration_group", registration_ids: randomUUID() },
    });
    expect(await reconcileRegistration(res.registration.id, res.access_token)).toBe(false);

    stripeMock.checkoutRetrieve.mockResolvedValueOnce(session);
    expect(await reconcileRegistration(res.registration.id, res.access_token)).toBe(true);
    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed");
  });

  it("status view drives the pay CTA: card pendings can pay, offline sees instructions", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    let view = await publicRegistrationStatus(res.registration.id, res.access_token);
    expect(view.can_pay_online).toBe(true);
    expect(view.payment_method).toBe("stripe");
    expect(view.expires_at).not.toBeNull();
    expect(view.payment_instructions).toBeNull(); // card entries never show bank details

    // Connect breaks → CTA hides (resume would 503 anyway).
    await sql`update organizations set stripe_charges_enabled = false where id = ${orgId}`;
    view = await publicRegistrationStatus(res.registration.id, res.access_token);
    expect(view.can_pay_online).toBe(false);
  });

  it("dispute lifecycle: created flags + audits, lost writes the money off", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    const intent = "pi_test_" + res.registration.id.slice(0, 8);

    await handleRegistrationDispute(
      {
        id: "dp_1",
        payment_intent: intent,
        amount: 500,
        status: "needs_response",
      } as unknown as Stripe.Dispute,
      "created",
    );
    let row = await loadWithGroup(res.registration.id);
    expect(row.disputed_at).not.toBeNull();
    expect(row.dispute_id).toBe("dp_1");

    // Won → flag clears, id stays for the audit trail.
    await handleRegistrationDispute(
      {
        id: "dp_1",
        payment_intent: intent,
        amount: 500,
        status: "won",
      } as unknown as Stripe.Dispute,
      "closed",
    );
    row = await loadWithGroup(res.registration.id);
    expect(row.disputed_at).toBeNull();
    expect(row.dispute_id).toBe("dp_1");

    // Lost → money is gone: refunded_cents mirrors the full amount.
    await handleRegistrationDispute(
      {
        id: "dp_1",
        payment_intent: intent,
        amount: 500,
        status: "needs_response",
      } as unknown as Stripe.Dispute,
      "created",
    );
    await handleRegistrationDispute(
      {
        id: "dp_1",
        payment_intent: intent,
        amount: 500,
        status: "lost",
      } as unknown as Stripe.Dispute,
      "closed",
    );
    row = await loadWithGroup(res.registration.id);
    // Cart-scoped write-off (block comment above RegistrationWithGroupRow in
    // registrations.ts) — group_refunded_cents, not the entry's own column.
    expect(row.group_refunded_cents).toBe(500);
  });

  it("charge.refunded from the Stripe dashboard syncs refunded_cents", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));
    const intent = "pi_test_" + res.registration.id.slice(0, 8);

    await syncRegistrationRefund({
      payment_intent: intent,
      amount_refunded: 300,
    } as unknown as Stripe.Charge);
    let row = await loadWithGroup(res.registration.id);
    // Cart-scoped mirror (block comment above RegistrationWithGroupRow in
    // registrations.ts) — group_refunded_cents, not the entry's own column.
    expect(row.group_refunded_cents).toBe(300);

    // Never regresses below what we already recorded.
    await syncRegistrationRefund({
      payment_intent: intent,
      amount_refunded: 100,
    } as unknown as Stripe.Charge);
    row = await loadWithGroup(res.registration.id);
    expect(row.group_refunded_cents).toBe(300);
  });

  // "waitlisted card submits take no window and no payment" DELETED (RS001
  // demolition): purely pinned submitRegistration's own
  // capacity-overflow → waitlisted decision at submit time (no checkout
  // minted for the overflow entry). No surviving usecase makes that
  // decision — seeding a row directly as "waitlisted" and asserting no
  // checkout call would be vacuous (nothing would ever have tried to mint
  // one). `seedRegistration`'s own waitlisted-status invariant (amount 0, no
  // window, no method) is exercised structurally by every other test that
  // seeds a waitlisted row (e.g. "promotion snapshots the current fee…").
  // RS002/RS003 own re-testing the overflow decision against the new flow.
});

// ---------------------------------------------------------------------------
// Dispute loss recovery (PROMPT-55): lost card disputes reverse the club's
// transfer so the platform only eats Stripe's dispute fee.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("dispute loss recovery (PROMPT-55)", () => {
  /** Paid card registration + the Stripe objects a lost dispute resolves. */
  async function disputedRig(feeCents = 2000) {
    const rigged = await stripeRig({ feeCents });
    const res = await seedRegistration(rigged.competition.id, rigged.division.id, rigged.settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, feeCents));
    const intent = "pi_test_" + res.registration.id.slice(0, 8);
    const chargeId = "ch_" + res.registration.id.slice(0, 8);
    const transferId = "tr_" + res.registration.id.slice(0, 8);
    // Verified against the live API in test mode (2026-07-14): destination
    // charges transfer the FULL amount; the application fee is collected from
    // the connected account separately — so the club's net is
    // transfer.amount − application_fee_amount.
    stripeMock.chargeRetrieve.mockResolvedValue({
      id: chargeId,
      amount: feeCents,
      application_fee_amount: 100,
      transfer: { id: transferId, amount: feeCents, amount_reversed: 0 },
    });
    return {
      ...rigged,
      regId: res.registration.id,
      intent,
      chargeId,
      transferId,
    };
  }

  const disputeObj = (over: Record<string, unknown>) =>
    ({ status: "lost", ...over }) as unknown as Stripe.Dispute;

  async function auditRows(type: string, regId: string) {
    return sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = ${type} and payload->>'registration_id' = ${regId}`;
  }

  it("lost dispute reverses the club's net share with a dispute-scoped idempotency key", async () => {
    const { regId, orgId, intent, chargeId, transferId } = await disputedRig();
    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r1",
        payment_intent: intent,
        charge: chargeId,
        amount: 2000,
        status: "needs_response",
      }),
      "created",
    );
    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r1",
        payment_intent: intent,
        charge: chargeId,
        amount: 2000,
      }),
      "closed",
    );

    const row = await loadWithGroup(regId);
    expect(row.group_refunded_cents).toBe(2000);

    expect(stripeMock.chargeRetrieve).toHaveBeenCalledWith(chargeId, {
      expand: ["transfer"],
    });
    expect(stripeMock.reversalCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.reversalCreate).toHaveBeenCalledWith(
      transferId,
      {
        amount: 1900, // 2000 transfer − 100 app fee: the net the club received
        metadata: { dispute_id: "dp_r1", registration_id: regId },
      },
      { idempotencyKey: "dispute-reversal-dp_r1" },
    );

    const recovered = await auditRows("registration.dispute_recovered", regId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].payload).toMatchObject({
      dispute_id: "dp_r1",
      transfer_id: transferId,
      reversed_cents: 1900,
    });

    // Organiser hears about the loss + recovery — addressed to the current
    // owner (org_members), not organizations.created_by.
    const [owner] = await sql<{ email: string }[]>`
      select u.email from org_members m join users u on u.id = m.user_id
      where m.org_id = ${orgId} and m.role = 'owner'`;
    expect(emailMock.disputeLost).toHaveBeenCalledTimes(1);
    expect(emailMock.disputeLost).toHaveBeenCalledWith(
      expect.objectContaining({
        to: owner.email,
        amountCents: 2000,
        recoveredCents: 1900,
      }),
    );
  });

  it("write-off lands even when the reversal throws (recovery_failed audited)", async () => {
    const { regId, intent, chargeId } = await disputedRig();
    stripeMock.reversalCreate.mockRejectedValue(new Error("stripe down"));
    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r2",
        payment_intent: intent,
        charge: chargeId,
        amount: 2000,
      }),
      "closed",
    );

    const row = await loadWithGroup(regId);
    expect(row.group_refunded_cents).toBe(2000); // the write-off never depends on Stripe

    expect(await auditRows("registration.dispute_recovered", regId)).toHaveLength(0);
    const failed = await auditRows("registration.dispute_recovery_failed", regId);
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.error).toContain("stripe down");
    expect(emailMock.disputeLost).toHaveBeenCalledWith(
      expect.objectContaining({ recoveredCents: 0 }),
    );
  });

  it("replayed lost event short-circuits on the metadata guard — one reversal, one email", async () => {
    const { regId, intent, chargeId, transferId } = await disputedRig();
    stripeMock.reversalList.mockResolvedValueOnce({ data: [] }).mockResolvedValue({
      data: [{ id: "trr_prior", amount: 1900, metadata: { dispute_id: "dp_r3" } }],
    });
    const lost = disputeObj({
      id: "dp_r3",
      payment_intent: intent,
      charge: chargeId,
      amount: 2000,
    });
    await handleRegistrationDispute(lost, "closed");
    await handleRegistrationDispute(lost, "closed"); // /admin/billing-events replay

    expect(stripeMock.reversalCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.reversalList).toHaveBeenCalledWith(transferId, {
      limit: 100,
    });
    expect(await auditRows("registration.dispute_recovered", regId)).toHaveLength(1);
    expect(emailMock.disputeLost).toHaveBeenCalledTimes(1);
  });

  it("partial dispute reverses the proportional net share, capped by the unreversed remainder", async () => {
    const a = await disputedRig();
    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r4",
        payment_intent: a.intent,
        charge: a.chargeId,
        amount: 500,
      }),
      "closed",
    );
    // 500 of 2000 disputed → club's net share = 500 × 1900/2000 = 475.
    expect(stripeMock.reversalCreate).toHaveBeenCalledWith(
      a.transferId,
      expect.objectContaining({ amount: 475 }),
      expect.anything(),
    );

    // Mostly-reversed transfer: never exceed what's left.
    const b = await disputedRig();
    stripeMock.chargeRetrieve.mockResolvedValue({
      id: b.chargeId,
      amount: 2000,
      application_fee_amount: 100,
      transfer: { id: b.transferId, amount: 2000, amount_reversed: 1800 },
    });
    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r5",
        payment_intent: b.intent,
        charge: b.chargeId,
        amount: 500,
      }),
      "closed",
    );
    expect(stripeMock.reversalCreate).toHaveBeenLastCalledWith(
      b.transferId,
      expect.objectContaining({ amount: 200 }),
      expect.anything(),
    );
  });

  it("no transfer on the charge → skip with an audit note, no reversal call", async () => {
    const { regId, intent, chargeId } = await disputedRig();
    stripeMock.chargeRetrieve.mockResolvedValue({
      id: chargeId,
      amount: 2000,
      application_fee_amount: null,
      transfer: null,
    });
    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r6",
        payment_intent: intent,
        charge: chargeId,
        amount: 2000,
      }),
      "closed",
    );

    expect(stripeMock.reversalCreate).not.toHaveBeenCalled();
    const skipped = await auditRows("registration.dispute_recovery_skipped", regId);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload.reason).toBe("no_transfer");
    const row = await loadWithGroup(regId);
    expect(row.group_refunded_cents).toBe(2000);
  });

  it("won dispute never touches transfers", async () => {
    const { regId, intent, chargeId } = await disputedRig();
    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r7",
        payment_intent: intent,
        charge: chargeId,
        amount: 2000,
        status: "needs_response",
      }),
      "created",
    );
    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r7",
        payment_intent: intent,
        charge: chargeId,
        amount: 2000,
        status: "won",
      }),
      "closed",
    );

    expect(stripeMock.chargeRetrieve).not.toHaveBeenCalled();
    expect(stripeMock.reversalCreate).not.toHaveBeenCalled();
    expect(emailMock.disputeLost).not.toHaveBeenCalled();
    const row = await loadWithGroup(regId);
    expect(row.group_refunded_cents).toBe(0);
    expect(row.disputed_at).toBeNull();
  });

  it("dispute-lost email goes to the CURRENT owner after a transfer-owner flip", async () => {
    const { regId, orgId, intent, chargeId } = await disputedRig();
    const newOwnerId = await makeUser("newowner");
    await sql`update org_members set role = 'admin'
              where org_id = ${orgId} and role = 'owner'`;
    await sql`insert into org_members (org_id, user_id, role)
              values (${orgId}, ${newOwnerId}, 'owner')`;
    const [{ email: newOwnerEmail }] = await sql<{ email: string }[]>`
      select email from users where id = ${newOwnerId}`;

    await handleRegistrationDispute(
      disputeObj({
        id: "dp_r8",
        payment_intent: intent,
        charge: chargeId,
        amount: 2000,
      }),
      "closed",
    );

    expect(emailMock.disputeLost).toHaveBeenCalledTimes(1);
    expect(emailMock.disputeLost).toHaveBeenCalledWith(
      expect.objectContaining({ to: newOwnerEmail }),
    );
    expect(await auditRows("registration.dispute_recovered", regId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RS002 (V368): entry-level refunds — the three cart-level-money hazards
// flagged in the block comment above RegistrationWithGroupRow
// (registrations.ts), now fixed. No multi-entry submit flow exists yet
// (RS002/RS003 own building group-submit), so `seedSecondEntry` attaches a
// second entry directly to an existing cart, the same way `seedRegistration`
// reproduces submitRegistration's single-entry write.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("RS002: entry-level refunds (multi-entry cart hazards)", () => {
  /** A confirmed two-entry cart sharing ONE payment intent — A and B each
   *  carry their own fee. Reproduces what group-submit will write once it
   *  ships (design §3: one payment per cart). */
  async function twoEntryCart(feeA: number, feeB: number) {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "stripe",
      fee_cents: feeA,
    });
    const a = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Entry A",
      amountCents: feeA,
    });
    const b = await seedSecondEntry(a.registration.group_id, division.id, feeB, "Entry B");
    const intent = "pi_cart_" + a.registration.id.slice(0, 8);
    await sql`
      update registration_groups
      set payment_intent_id = ${intent}, amount_cents = ${feeA + feeB}, updated_at = now()
      where id = ${a.registration.group_id}`;
    await sql`update registrations set status = 'confirmed', updated_at = now()
              where id in (${a.registration.id}, ${b.id})`;
    return {
      owner, division, competition, intent,
      accessToken: a.access_token,
      a: await loadWithGroup(a.registration.id),
      b: await loadWithGroup(b.id),
    };
  }

  it("hazard 1 (late-payment webhook): refunds only the late entry's own amount, sibling untouched", async () => {
    const { a, b, intent } = await twoEntryCart(1000, 700);
    // A goes stale/withdrawn, then its OWN abandoned checkout completes late.
    await sql`update registrations set status = 'withdrawn', withdrawn_at = now() where id = ${a.id}`;
    stripeMock.refundCreate.mockClear();

    await handleRegistrationCheckoutCompleted(fakeSession(a.id, a.amount_cents));

    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: intent, amount: a.amount_cents }),
    );
    const bAfter = await loadWithGroup(b.id);
    expect(bAfter.refunded_cents).toBe(0); // B's own money never moved
    expect(bAfter.status).toBe("confirmed"); // B never touched
  });

  it("hazard 1 (withdraw auto-refund): refunds only the withdrawn entry's own amount, sibling untouched", async () => {
    const { a, b, intent, accessToken } = await twoEntryCart(1000, 700);
    stripeMock.refundCreate.mockClear();

    await withdrawRegistrationPublic(a.id, accessToken);

    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: intent, amount: a.amount_cents }),
    );
    const aAfter = await loadWithGroup(a.id);
    const bAfter = await loadWithGroup(b.id);
    expect(aAfter.status).toBe("withdrawn");
    expect(aAfter.refunded_cents).toBe(a.amount_cents);
    expect(bAfter.refunded_cents).toBe(0); // B's own money never moved
    expect(bAfter.status).toBe("confirmed"); // B never touched
    expect(bAfter.amount_cents).toBe(700);
  });

  it("hazard 2: successive withdrawals accumulate the cart total instead of overwriting it", async () => {
    const { a, b, owner, accessToken } = await twoEntryCart(1000, 700);

    await withdrawRegistrationPublic(a.id, accessToken);
    const afterA = await loadWithGroup(a.id);
    expect(afterA.group_refunded_cents).toBe(1000);

    // B was seeded directly (no public token of its own) — withdraw via the
    // organiser path instead of minting a second one.
    await withdrawRegistrationOrganiser(owner, b.id);
    const afterB = await loadWithGroup(b.id);
    // Accumulated (1000 + 700), NOT overwritten to just B's own 700 — that
    // overwrite would silently erase A's earlier refund from the cart total.
    expect(afterB.group_refunded_cents).toBe(1700);
  });

  it("hazard 3 (+ entry-level write): refunding A fully does not block B's own manual refund", async () => {
    const { owner, a, b, intent } = await twoEntryCart(1000, 700);
    stripeMock.refundCreate.mockClear();

    const aRefunded = await refundRegistration(owner, a.id, undefined);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: intent, amount: a.amount_cents }),
    );
    // refundRegistration writes the ENTRY's own refunded_cents (V368), not
    // just the group's accumulated total.
    expect(aRefunded.refunded_cents).toBe(a.amount_cents);

    // B's own remaining is computed from B's own numbers — must NOT throw
    // "Already fully refunded" for an entry nobody has touched yet.
    const bRefunded = await refundRegistration(owner, b.id, undefined);
    expect(stripeMock.refundCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ payment_intent: intent, amount: b.amount_cents }),
    );
    expect(bRefunded.refunded_cents).toBe(b.amount_cents);
  });

  // -------------------------------------------------------------------------
  // Wave-1 review findings: two non-transactional refund write pairs, an
  // unlisted fourth hazard-2 site (dispute-lost write-off), and a missing
  // webhook-redelivery guard. Single-entry carts suffice for all four —
  // none of these are multi-entry-cart hazards.
  // -------------------------------------------------------------------------

  it("review (blocker): late-payment refund writes entry and cart atomically, not as two commits", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await withdrawRegistrationPublic(res.registration.id, res.access_token); // never paid — no auto-refund fires here
    // Force the CART write to fail (int4 overflow) while the ENTRY write
    // alone would succeed — proves the pair is one transaction, not two
    // independent autocommits that can diverge if the second one fails.
    await sql`update registration_groups set refunded_cents = 2147483647
              where id = ${res.registration.group_id}`;

    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500));

    const row = await loadWithGroup(res.registration.id);
    // Reverting the sql.begin wrap (registrations.ts ~confirmPaidRegistration
    // "late" branch) makes this fail: the entry write would commit alone
    // and read back 500.
    expect(row.refunded_cents).toBe(0);
  });

  it("review (blocker): withdraw auto-refund writes entry and cart atomically, not as two commits", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await handleRegistrationCheckoutCompleted(fakeSession(res.registration.id, 500)); // paid + has payment_intent_id
    await sql`update registration_groups set refunded_cents = 2147483647
              where id = ${res.registration.group_id}`;

    await withdrawRegistrationPublic(res.registration.id, res.access_token); // pre-lock auto-refund attempt

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("withdrawn"); // the status flip is its own, separate, unaffected tx
    // Reverting the sql.begin wrap (registrations.ts ~withdrawCore
    // auto-refund block) makes this fail: the entry write would commit
    // alone and read back 500.
    expect(row.refunded_cents).toBe(0);
  });

  it("review (minor): a redelivered late-payment webhook refunds only once", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await withdrawRegistrationPublic(res.registration.id, res.access_token);
    stripeMock.refundCreate.mockClear();

    const session = fakeSession(res.registration.id, 500);
    await handleRegistrationCheckoutCompleted(session);
    await handleRegistrationCheckoutCompleted(session); // Stripe's "at least once" redelivery

    // Reverting the already-refunded guard (registrations.ts
    // ~confirmPaidRegistration, right before the "late" stripeRefund call)
    // makes this fail: a second real refund fires and the totals double.
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    const row = await loadWithGroup(res.registration.id);
    expect(row.refunded_cents).toBe(500);
    expect(row.group_refunded_cents).toBe(500);
  });

  it("RS006: confirmPaidRegistration alerts staff when a late-payment refund FAILS", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    await withdrawRegistrationPublic(res.registration.id, res.access_token); // pending -> withdrawn, never paid, no refund fires here
    stripeMock.refundCreate.mockClear();
    stripeMock.refundCreate.mockRejectedValueOnce(new Error("card declined"));
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    try {
      const session = fakeSession(res.registration.id, 500);
      await handleRegistrationCheckoutCompleted(session); // late payment on an already-withdrawn reg -> refund attempted -> fails

      expect(emailMock.registrationRefundFailedAlert).toHaveBeenCalledTimes(1);
      const args = emailMock.registrationRefundFailedAlert.mock.calls[0]![0];
      expect(args.to).toBe("ops@seazn.test");
      expect(args.registrationId).toBe(res.registration.id);
      expect(args.orgId).toBe(orgId);
      expect(args.competitionId).toBe(competition.id);
      expect(args.amountCents).toBe(500);
      expect(args.currency).toBe(settings.currency);
      expect(args.paymentIntentId).toBe(session.payment_intent);
      expect(args.reason).toBe("card declined");

      const row = await loadWithGroup(res.registration.id);
      expect(row.refunded_cents).toBe(0); // the refund really never landed
    } finally {
      delete process.env.STAFF_ALERT_EMAIL;
    }
  });

  it("review (major): a lost dispute accumulates via dispute.amount and never regresses the cart total", async () => {
    const { owner, a, b, intent } = await twoEntryCart(1000, 700);
    await refundRegistration(owner, a.id, undefined); // group_refunded_cents -> 1000
    await refundRegistration(owner, b.id, undefined); // group_refunded_cents -> 1700

    // A SMALLER, later dispute.amount (500) on the same intent must neither
    // regress the 1700 two entry-level refunds already accumulated, nor be
    // sourced from one entry's own amount_cents (1000 or 700, whichever the
    // earliest-entry lookup picks — both are wrong either way).
    await handleRegistrationDispute(
      { id: "dp_major", payment_intent: intent, amount: 500, status: "needs_response" } as unknown as Stripe.Dispute,
      "created",
    );
    await handleRegistrationDispute(
      { id: "dp_major", payment_intent: intent, amount: 500, status: "lost" } as unknown as Stripe.Dispute,
      "closed",
    );

    const after = await loadWithGroup(a.id);
    // Reverting the greatest(refunded_cents, dispute.amount) fix
    // (registrations.ts ~handleRegistrationDispute, "lost" branch) makes
    // this fail: it would read back 1000 or 700, never 1700.
    expect(after.group_refunded_cents).toBe(1700);
  });
});

// ---------------------------------------------------------------------------
// RS003 W3b: the webhook re-keyed from a single registration_id to the
// GROUP's registration_ids (comma-joined, W3a's createRegistrationCheckout),
// plus the payment_status gate + async event pair the same wave closed
// (owner's no-new-issues rule — every OTHER kind in billing-events.ts's
// dispatch already gated on payment_status; the registration branch didn't).
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("RS003 W3b: group checkout webhook", () => {
  it("confirms every entry named in registration_ids; a pending sibling outside the list and a waitlisted sibling are both untouched, and no entry's amount_cents is smeared by the cart total", async () => {
    const { competition, division, settings } = await stripeRig();
    const a = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Entry A",
      amountCents: 1000,
    });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 700, "Entry B");
    // A sibling THIS session does not cover, and the ordinary waitlisted
    // sibling — neither is named in registration_ids below.
    const d = await seedSecondEntry(a.registration.group_id, division.id, 300, "Entry D");
    const w = await seedSecondEntry(
      a.registration.group_id, division.id, 0, "Entry W", "waitlisted",
    );

    // The cart TOTAL (1700) must never land on either listed entry's own
    // amount_cents — that would be the multi-entry smear this wave closes.
    await handleRegistrationCheckoutCompleted(fakeSession([a.registration.id, b.id], 1700));

    const aAfter = await loadWithGroup(a.registration.id);
    const bAfter = await loadWithGroup(b.id);
    const dAfter = await loadWithGroup(d.id);
    const wAfter = await loadWithGroup(w.id);
    expect(aAfter.status).toBe("confirmed");
    expect(aAfter.amount_cents).toBe(1000); // NOT the 1700 cart total
    expect(bAfter.status).toBe("confirmed");
    expect(bAfter.amount_cents).toBe(700); // NOT the 1700 cart total
    expect(dAfter.status).toBe("pending"); // untouched — not named in this session
    expect(wAfter.status).toBe("waitlisted"); // untouched
  });

  it("RULING A holds through the group path: a rejected entry in the list is refunded its own amount and never confirmed; its sibling still confirms", async () => {
    const { competition, division, settings } = await stripeRig();
    const a = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Entry A",
      amountCents: 1000,
    });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 700, "Entry B");
    await sql`update registrations set status = 'rejected' where id = ${a.registration.id}`;
    stripeMock.refundCreate.mockClear();

    await handleRegistrationCheckoutCompleted(fakeSession([a.registration.id, b.id], 1700));

    const aAfter = await loadWithGroup(a.registration.id);
    const bAfter = await loadWithGroup(b.id);
    expect(aAfter.status).toBe("rejected"); // never confirmed
    expect(aAfter.entrant_id).toBeNull();
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1000 }), // A's own amount, not the 1700 cart total
    );
    expect(bAfter.status).toBe("confirmed"); // sibling unaffected
  });

  it("RULING B holds through the group path: a manual-approval division leaves every listed entry paid-awaiting-approval, none confirmed", async () => {
    const { competition, division, settings } = await stripeRig();
    await sql`update registration_settings set approval = 'manual' where division_id = ${division.id}`;
    const a = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Entry A",
      amountCents: 1000,
    });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 700, "Entry B");

    await handleRegistrationCheckoutCompleted(fakeSession([a.registration.id, b.id], 1700));

    const aAfter = await loadWithGroup(a.registration.id);
    const bAfter = await loadWithGroup(b.id);
    expect(aAfter.status).toBe("paid");
    expect(aAfter.entrant_id).toBeNull();
    expect(aAfter.amount_cents).toBe(1000);
    expect(bAfter.status).toBe("paid");
    expect(bAfter.entrant_id).toBeNull();
    expect(bAfter.amount_cents).toBe(700);
  });

  it("a PAID checkout.session.completed confirms when dispatched through billing-events (proves the dispatch branch's kind check, re-keyed to registration_group)", async () => {
    // Unlike the unpaid case below, this one distinguishes "the dispatch
    // routed correctly" from "nothing happened for the wrong reason": the old
    // kind === "registration" check has no producer left, so if it were
    // never re-keyed this session would fall through billing-events' OTHER
    // branches (size_pack/credit_pack/event-pass, then the bare org_id gate)
    // and also confirm nothing — a false green for the unpaid test alone.
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    const session = fakeSession(res.registration.id, 500); // payment_status: "paid"

    await processStripeEvent({
      id: "evt_" + randomUUID().slice(0, 8),
      type: "checkout.session.completed",
      data: { object: session },
    } as unknown as Stripe.Event);

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed");
    expect(row.entrant_id).not.toBeNull();
  });

  it("payment_status: unpaid on checkout.session.completed confirms and materialises nothing", async () => {
    // Delayed-notification methods fire checkout.session.completed while the
    // session is still unpaid (Stripe skill, "Webhooks and fulfillment").
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    const session = {
      ...fakeSession(res.registration.id, 500),
      payment_status: "unpaid",
    } as unknown as Stripe.Checkout.Session;

    await processStripeEvent({
      id: "evt_" + randomUUID().slice(0, 8),
      type: "checkout.session.completed",
      data: { object: session },
    } as unknown as Stripe.Event);

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("pending");
    expect(row.entrant_id).toBeNull();
  });

  it("checkout.session.async_payment_succeeded runs the same fulfilment as a paid completion", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    const session = fakeSession(res.registration.id, 500); // payment_status: "paid"

    await processStripeEvent({
      id: "evt_" + randomUUID().slice(0, 8),
      type: "checkout.session.async_payment_succeeded",
      data: { object: session },
    } as unknown as Stripe.Event);

    const row = await loadWithGroup(res.registration.id);
    expect(row.status).toBe("confirmed");
    expect(row.entrant_id).not.toBeNull();
  });

  it("checkout.session.async_payment_failed never confirms, records a payment_failed audit entry per named registration, and leaves every entry payable", async () => {
    const { competition, division, settings } = await stripeRig();
    const a = await seedRegistration(competition.id, division.id, settings, { displayName: "Entry A" });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 500, "Entry B");
    const session = {
      ...fakeSession([a.registration.id, b.id], 1000),
      payment_status: "unpaid",
    } as unknown as Stripe.Checkout.Session;

    await processStripeEvent({
      id: "evt_" + randomUUID().slice(0, 8),
      type: "checkout.session.async_payment_failed",
      data: { object: session },
    } as unknown as Stripe.Event);

    const aAfter = await loadWithGroup(a.registration.id);
    const bAfter = await loadWithGroup(b.id);
    expect(aAfter.status).toBe("pending"); // untouched — still payable
    expect(aAfter.entrant_id).toBeNull();
    expect(bAfter.status).toBe("pending");

    const auditCount = async (id: string) => {
      const [row] = await sql<{ n: string }[]>`
        select count(*)::text as n from competition_events
        where type = 'registration.payment_failed' and payload->>'registration_id' = ${id}`;
      return Number(row.n);
    };
    expect(await auditCount(a.registration.id)).toBe(1);
    expect(await auditCount(b.id)).toBe(1);
  });

  it("a redelivered async_payment_succeeded for a multi-entry cart confirms once, not twice", async () => {
    const { competition, division, settings } = await stripeRig();
    const a = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Entry A",
      amountCents: 1000,
    });
    const b = await seedSecondEntry(a.registration.group_id, division.id, 700, "Entry B");
    const session = fakeSession([a.registration.id, b.id], 1700);

    await handleRegistrationCheckoutCompleted(session);
    const aEntrant = (await loadWithGroup(a.registration.id)).entrant_id;
    const bEntrant = (await loadWithGroup(b.id)).entrant_id;

    // Stripe's "at least once" redelivery of the SAME session.
    await handleRegistrationCheckoutCompleted(session);
    const aAfter = await loadWithGroup(a.registration.id);
    const bAfter = await loadWithGroup(b.id);
    expect(aAfter.entrant_id).toBe(aEntrant); // idempotent, not a second entrant
    expect(bAfter.entrant_id).toBe(bEntrant);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${division.id}`;
    expect(n).toBe(2); // exactly A and B, no duplicates
  });
});

describe("RS003 W3b: HANDLED_EVENT_TYPES (pure)", () => {
  it("includes both delayed-notification checkout events (registered, not silently ACKed)", () => {
    expect(HANDLED_EVENT_TYPES).toContain("checkout.session.async_payment_succeeded");
    expect(HANDLED_EVENT_TYPES).toContain("checkout.session.async_payment_failed");
  });
});

// describe("per-registrant email locale (cycle 47)") DELETED (RS001
// demolition): both tests pinned submitRegistration's own
// locale-resolution branch — an explicit registrant pick vs falling back to
// the org's default_locale — a decision made INSIDE the deleted function
// with no surviving equivalent to seed against (a seed would just assert
// back whatever locale it was told to insert, which is vacuous). RS002/RS003
// own re-testing locale resolution against the new group-shaped submit flow.

// ---------------------------------------------------------------------------
// RS002 W5 review — RULING A: rejected is terminal from every writer, no
// exceptions. RULING B: manual mode blocks the AUTOMATIC confirmer
// (confirmPaidRegistration on a Stripe webhook), not an organiser's explicit
// confirm/mark-paid/waive.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("RS002 W5 review: rejected is terminal from every writer", () => {
  it("confirmRegistration refuses a rejected registration (BLOCKER)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });
    await sql`update registrations set status = 'rejected' where id = ${registration.id}`;

    let err: HttpError | undefined;
    try {
      await confirmRegistration(owner, registration.id);
    } catch (e) {
      err = e as HttpError;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(422);
    const [row] = await sql<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("rejected"); // untouched
    expect(row!.entrant_id).toBeNull(); // never materialised
  });

  it("a Stripe payment landing on a REJECTED registration is refunded, never confirmed (BLOCKER, worst finding of the session)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`
      update organizations
      set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
      where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 1000,
      payment_method: "stripe",
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });
    await sql`update registrations set status = 'rejected' where id = ${registration.id}`;

    // A late/replayed webhook for the checkout session minted before the
    // organiser rejected the entry.
    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 1000));

    const [row] = await sql<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where id = ${registration.id}`;
    // Reverting the rejected branch (registrations.ts confirmPaidRegistration)
    // makes this fail: status would become 'confirmed' and entrant_id would
    // be set — money taken AND an entrant created for a rejected registration.
    expect(row!.status).toBe("rejected");
    expect(row!.entrant_id).toBeNull();
    expect(stripeMock.refundCreate).toHaveBeenCalled();
  });

  it("markRegistrationPaidOffline and confirmRegistrationWaived both refuse a rejected registration with a specific message (BLOCKER)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 500,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });
    await sql`update registrations set status = 'rejected' where id = ${registration.id}`;

    let paidOfflineErr: HttpError | undefined;
    try {
      await markRegistrationPaidOffline(owner, registration.id);
    } catch (e) {
      paidOfflineErr = e as HttpError;
    }
    // The pre-existing `!== "pending"` guard would ALSO 422 here (rejected is
    // never pending), so asserting the STATUS alone cannot fail on a revert
    // of the new explicit check — the specific message is what a revert
    // actually changes (falls back to the generic "Only pending
    // registrations..." text).
    expect(paidOfflineErr?.status).toBe(422);
    expect(paidOfflineErr?.message).toBe("This registration was rejected and cannot be marked paid");

    let waivedErr: HttpError | undefined;
    try {
      await confirmRegistrationWaived(owner, registration.id);
    } catch (e) {
      waivedErr = e as HttpError;
    }
    expect(waivedErr?.status).toBe(422);
    expect(waivedErr?.message).toBe("This registration was rejected and cannot be confirmed");

    const [row] = await sql<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("rejected");
    expect(row!.entrant_id).toBeNull();
  });

  it("withdrawRegistrationOrganiser and withdrawRegistrationByRef both refuse a rejected registration (MAJOR)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration, access_token } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
      refCode: generateRefCode(),
    });
    await sql`update registrations set status = 'rejected' where id = ${registration.id}`;

    let orgErr: HttpError | undefined;
    try {
      await withdrawRegistrationOrganiser(owner, registration.id);
    } catch (e) {
      orgErr = e as HttpError;
    }
    expect(orgErr?.status).toBe(422);
    const [afterOrg] = await sql<{ status: string }[]>`
      select status from registrations where id = ${registration.id}`;
    // Reverting withdrawCore's rejected guard makes this fail: status would
    // silently flip to 'withdrawn' instead of staying 'rejected'.
    expect(afterOrg!.status).toBe("rejected");

    let byRefErr: HttpError | undefined;
    try {
      await withdrawRegistrationByRef(registration.ref_code!, registration.id, access_token);
    } catch (e) {
      byRefErr = e as HttpError;
    }
    expect(byRefErr?.status).toBe(422);
    const [afterRef] = await sql<{ status: string }[]>`
      select status from registrations where id = ${registration.id}`;
    expect(afterRef!.status).toBe("rejected");
  });
});

describe.skipIf(!HAS_DB)("RS002 W5 review: RULING B — manual mode blocks the machine, not the organiser", () => {
  it("a Stripe payment on a MANUAL-approval division lands 'paid' and waits for a human", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`
      update organizations
      set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
      where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 1000,
      payment_method: "stripe",
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    await sql`update registration_settings set approval = 'manual' where division_id = ${division.id}`;
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });

    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 1000));

    const [row] = await sql<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where id = ${registration.id}`;
    // Reverting the manual-mode check makes this fail: the webhook would
    // auto-materialise straight to 'confirmed', bypassing the human review
    // manual approval exists for.
    expect(row!.status).toBe("paid");
    expect(row!.entrant_id).toBeNull();
  });

  it("an AUTO-approval division still auto-confirms on payment, unchanged", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`
      update organizations
      set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
      where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 1000,
      payment_method: "stripe",
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    // registration_settings.approval defaults to 'auto' — no override needed.
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });

    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 1000));

    const [row] = await sql<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("confirmed");
    expect(row!.entrant_id).not.toBeNull();
  });

  it("markRegistrationPaidOffline and confirmRegistrationWaived still confirm on a MANUAL division — an organiser's explicit action IS the approval", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 500,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    await sql`update registration_settings set approval = 'manual' where division_id = ${division.id}`;
    const { registration: offlineReg } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });

    // markRegistrationPaidOffline confirms in the SAME call (payment =
    // approval, its own doc comment) — an organiser marking an offline fee
    // paid on a manual division IS the human decision ruling B carves out,
    // so this materialises straight to 'confirmed', same as on an auto
    // division. Only the AUTOMATIC Stripe-webhook path
    // (confirmPaidRegistration) stops short at 'paid' on manual — see the
    // sibling describe block above.
    const paid = await markRegistrationPaidOffline(owner, offlineReg.id);
    expect(paid.status).toBe("confirmed");
    expect(paid.entrant_id).not.toBeNull();

    const waivedSettings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 500,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    await sql`update registration_settings set approval = 'manual' where division_id = ${division.id}`;
    const { registration: waivedReg } = await seedRegistration(competition.id, division.id, waivedSettings, {
      status: "pending",
    });
    const waived = await confirmRegistrationWaived(owner, waivedReg.id);
    expect(waived.status).toBe("confirmed");
    expect(waived.entrant_id).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RS002 W5 review — MAJOR: materialise() used to clear the WHOLE cart's
// expires_at unconditionally on every confirm, wiping a still-pending
// sibling's live Stripe deadline.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("RS002 W5 review: materialise no longer clobbers a pending sibling's expires_at", () => {
  it("confirming one entry in a multi-entry cart leaves a still-pending sibling's expires_at untouched", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`
      update organizations
      set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
      where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 1000,
      payment_method: "stripe",
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    // One group, two entries — reproduces a multi-entry cart directly (no
    // group-submit flow needed for THIS pure two-writer confirm scenario).
    const { registration: toConfirm } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });
    const sibling = await seedSecondEntry(toConfirm.group_id, division.id, 1000, "Still Pending Sibling");
    await sql`update registrations set status = 'pending' where id = ${sibling.id}`;

    const [before] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${toConfirm.group_id}`;
    expect(before!.expires_at).not.toBeNull();

    await confirmRegistrationWaived(owner, toConfirm.id);

    const [after] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${toConfirm.group_id}`;
    // Reverting materialise's guard (the unconditional `expires_at = null`)
    // makes this fail: the sibling's live deadline would be wiped by an
    // UNRELATED entry's confirmation.
    expect(after!.expires_at).not.toBeNull();
    expect(new Date(after!.expires_at!).getTime()).toBe(new Date(before!.expires_at!).getTime());

    const [siblingRow] = await sql<{ status: string }[]>`select status from registrations where id = ${sibling.id}`;
    expect(siblingRow!.status).toBe("pending"); // untouched
  });

  it("confirming the LAST pending entry in a cart clears expires_at — the single-entry case is unchanged", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`
      update organizations
      set stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}, stripe_charges_enabled = true
      where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 1000,
      payment_method: "stripe",
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });
    const [before] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${registration.group_id}`;
    expect(before!.expires_at).not.toBeNull();

    await confirmRegistrationWaived(owner, registration.id);

    const [after] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${registration.group_id}`;
    expect(after!.expires_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RS002 W5 whole-branch review (all five modules together): 1 blocker + 2
// majors that no per-wave reviewer could see. The migration collision
// (V367->V368) was fixed by the orchestrator directly — not this file's
// concern.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("RS002 W5 whole-branch review: sweepRegistrations expiry payment relevance", () => {
  it("does not sweep a free, manual-approval sibling sharing an overdue stripe cart's deadline (BLOCKER)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = { fee_cents: 1000, currency: "usd", payment_method: "stripe" as const };
    const { registration: stripeEntry } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });
    // Fast-forward: the cart's shared deadline is overdue.
    await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${stripeEntry.group_id}`;
    // A free sibling in the SAME cart, SAME shared deadline — never itself
    // subject to a payment deadline: manual approval holds it 'pending' for
    // review, not payment.
    const freeSibling = await seedSecondEntry(stripeEntry.group_id, division.id, 0, "Free Reviewee");

    await sweepRegistrations("https://test.local");

    const [stripeRow] = await sql<{ status: string }[]>`select status from registrations where id = ${stripeEntry.id}`;
    const [freeRow] = await sql<{ status: string }[]>`select status from registrations where id = ${freeSibling.id}`;
    expect(stripeRow!.status).toBe("expired");
    // Reverting the sweep's payment-relevance filter makes this fail: the
    // free sibling would ALSO flip to 'expired', despite never having been
    // subject to any deadline of its own — the reminder pass immediately
    // above already filters payment_method = 'stripe'; the expiry pass did
    // not, and also missed the per-entry fee check.
    expect(freeRow!.status).toBe("pending");
  });
});

describe.skipIf(!HAS_DB)("RS002 W5 whole-branch review: clearing a stale expires_at when the cart empties", () => {
  it("withdrawing the cart's LAST pending entry clears the stale expires_at (MAJOR)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = { fee_cents: 1000, currency: "usd", payment_method: "stripe" as const };
    const { registration } = await seedRegistration(competition.id, division.id, settings, { status: "pending" });
    const [before] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${registration.group_id}`;
    expect(before!.expires_at).not.toBeNull();

    await withdrawRegistrationOrganiser(owner, registration.id);

    const [after] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${registration.group_id}`;
    // Reverting withdrawCore's clearExpiresIfNoLongerNeeded call makes this
    // fail: the deadline lingers forever, and groupByRef/publicRegistrationStatus
    // keep surfacing a dead deadline for an entry that is no longer even in
    // the race.
    expect(after!.expires_at).toBeNull();
  });

  it("withdrawing ONE of two pending entries leaves the still-pending sibling's expires_at untouched", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = { fee_cents: 1000, currency: "usd", payment_method: "stripe" as const };
    const { registration: first } = await seedRegistration(competition.id, division.id, settings, {
      status: "pending",
    });
    const second = await seedSecondEntry(first.group_id, division.id, 1000, "Still Pending Sibling");

    await withdrawRegistrationOrganiser(owner, first.id);

    const [group] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${first.group_id}`;
    expect(group!.expires_at).not.toBeNull(); // second is still pending — untouched
    const [secondRow] = await sql<{ status: string }[]>`select status from registrations where id = ${second.id}`;
    expect(secondRow!.status).toBe("pending");
  });

  it("sweepRegistrations expiry clears the stale expires_at when expiring the cart's LAST pending entry (MAJOR)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = { fee_cents: 1000, currency: "usd", payment_method: "stripe" as const };
    const { registration } = await seedRegistration(competition.id, division.id, settings, { status: "pending" });
    await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${registration.group_id}`;

    await sweepRegistrations("https://test.local");

    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("expired");
    const [group] = await sql<{ expires_at: Date | null }[]>`
      select expires_at from registration_groups where id = ${registration.group_id}`;
    // Reverting the sweep's clearExpiresIfNoLongerNeeded call makes this
    // fail: same stale-deadline gap as withdrawCore, same fix.
    expect(group!.expires_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RS007 (V378) — a promoted entry gets its OWN payment deadline, and a lapse
// returns it to the waitlist TAIL instead of expiring it. See the STRUCTURAL
// finding and the "FALSE PREMISE — verify RS002 shipped the lapse" ruling in
// docs/superpowers/specs/2026-08-16-registration-redesign-prompts/_INDEX.md's
// RS007 section.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("RS007: promoteWaitlistedRow stamps the entry's own promotion_expires_at", () => {
  it("a stripe-fee promotion gets a fresh promotion_expires_at in the same window as the group's expires_at", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const waiting = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });

    const promoted = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    expect(promoted!.status).toBe("pending");
    expect(promoted!.expires_at, "sanity: the cart's shared clock still extends too").not.toBeNull();

    const [row] = await sql<{ promotion_expires_at: Date | null }[]>`
      select promotion_expires_at from registrations where id = ${promoted!.id}`;
    // Reverting the promotion write leaves this null forever — the sweep's
    // lapse branch (promoted_at is not null and promotion_expires_at < now())
    // would then never match a promoted row at all.
    expect(row!.promotion_expires_at).not.toBeNull();
    // Same 48h window as the group's own expires_at (settings do not carry a
    // separate pay-window constant to read instead).
    const deltaMs = Math.abs(
      new Date(row!.promotion_expires_at!).getTime() - new Date(promoted!.expires_at!).getTime(),
    );
    expect(deltaMs).toBeLessThan(5000);
  });

  it("an offline promotion (no stripe window) leaves promotion_expires_at null", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, fee_cents: 1000, payment_method: "offline",
    });
    const waiting = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });

    const promoted = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    expect(promoted!.status).toBe("pending");
    const [row] = await sql<{ promotion_expires_at: Date | null }[]>`
      select promotion_expires_at from registrations where id = ${promoted!.id}`;
    expect(row!.promotion_expires_at).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("RS007: promoteOldestWaitlisted orders by coalesce(waitlisted_at, created_at)", () => {
  it("a recently re-queued row sorts BEHIND one still on its original wait, even with a far older created_at", async () => {
    const { competition, division, settings } = await stripeRig();
    const longWaiter = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", displayName: "Long Waiter", contactEmail: "long@test.local",
    });
    const reQueued = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", displayName: "Re-Queued", contactEmail: "requeued@test.local",
    });
    // longWaiter has been on the list for 10 days — an ordinary first-time
    // join, waitlisted_at stays null, falls back to created_at.
    await sql`update registrations set created_at = now() - interval '10 days'
              where id = ${longWaiter.registration.id}`;
    // reQueued's ORIGINAL submission is far OLDER still (30 days) — if
    // ordering used created_at alone it would win the queue outright. But it
    // was promoted and lapsed just an hour ago, so waitlisted_at (the tail
    // marker) is recent, and THAT must decide.
    await sql`update registrations
              set created_at = now() - interval '30 days', waitlisted_at = now() - interval '1 hour'
              where id = ${reQueued.registration.id}`;

    const promoted = await sql.begin((tx) => promoteOldestWaitlisted(tx, division.id, settings));
    // Reverting the order-by to plain created_at makes this fail: reQueued's
    // 30-day-old created_at would win instead of longWaiter's 10-day one.
    expect(promoted!.id).toBe(longWaiter.registration.id);
  });
});

describe.skipIf(!HAS_DB)("RS007: sweep lapses an overdue promotion back to the waitlist tail and re-offers the slot", () => {
  it("clears promoted_at/promotion_expires_at, sets a fresh waitlisted_at, and promotes the next candidate in the SAME sweep", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    // T was promoted — its own clock is about to lapse.
    const t = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", contactEmail: "t@test.local",
    });
    const promotedT = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, t.registration.id, t.registration.group_id, settings),
    );
    expect(promotedT!.promotion_expires_at, "sanity").not.toBeNull();

    // W has been waiting since before T ever promoted — the freed slot must
    // go to W, not back to T.
    const w = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", contactEmail: "w@test.local",
    });
    await sql`update registrations set created_at = now() - interval '5 days' where id = ${w.registration.id}`;

    // Drive the lapse from the test by writing a short/past
    // promotion_expires_at directly — never by mocking server time.
    await sql`update registrations set promotion_expires_at = now() - interval '1 minute'
              where id = ${t.registration.id}`;

    const res = await sweepRegistrations("https://test.local");

    const tRow = await loadWithGroup(t.registration.id);
    expect(tRow.status).toBe("waitlisted");
    expect(tRow.promoted_at).toBeNull();
    const [tCols] = await sql<{ promotion_expires_at: Date | null; waitlisted_at: Date | null }[]>`
      select promotion_expires_at, waitlisted_at from registrations where id = ${t.registration.id}`;
    expect(tCols!.promotion_expires_at).toBeNull();
    expect(tCols!.waitlisted_at).not.toBeNull();

    // The freed slot went to W (the long-waiter), not back to T — the tail
    // ordering in practice: T's fresh waitlisted_at sorts behind W's old
    // created_at.
    const wRow = await loadWithGroup(w.registration.id);
    expect(wRow.status).toBe("pending");
    expect(wRow.promoted_at).not.toBeNull();
    expect(wRow.amount_cents).toBe(500);

    expect(res.lapsed).toBeGreaterThanOrEqual(1);
    expect(res.promoted).toBeGreaterThanOrEqual(1);

    // Audited the same way promotion/expiry already are.
    const auditCount = async (type: string, id: string) => {
      const [row] = await sql<{ n: string }[]>`
        select count(*)::text as n from competition_events
        where type = ${type} and payload->>'registration_id' = ${id}`;
      return Number(row.n);
    };
    expect(await auditCount("registration.promotion_lapsed", t.registration.id)).toBe(1);
    expect(await auditCount("registration.promoted", w.registration.id)).toBe(1);

    // A further sweep is a no-op for our own rows: T stays on the waitlist
    // tail, W stays promoted — the two branches must not both fire on the
    // same row, and a freshly re-offered row must not immediately re-lapse.
    await sweepRegistrations("https://test.local");
    expect((await loadWithGroup(t.registration.id)).status).toBe("waitlisted");
    expect((await loadWithGroup(w.registration.id)).status).toBe("pending");
  });
});

describe.skipIf(!HAS_DB)("REVIEW FIX (money-path defect #5): a lapsing promotion with NO bystander must not immediately re-promote itself", () => {
  it("the only waitlisted candidate in the division stays waitlisted after its own lapse — never self-re-promoted in the SAME sweep", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const t = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", contactEmail: "solo-lapse@test.local",
    });
    const promotedT = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, t.registration.id, t.registration.group_id, settings),
    );
    expect(promotedT!.promotion_expires_at, "sanity").not.toBeNull();
    // Deliberately NO bystander anywhere in this (fresh, per-test) division —
    // T is the ONLY waitlisted row in it when its own clock lapses.

    await sql`update registrations set promotion_expires_at = now() - interval '1 minute'
              where id = ${t.registration.id}`;

    const res = await sweepRegistrations("https://test.local");

    const tRow = await loadWithGroup(t.registration.id);
    // Reverting the fix makes this fail: `for update skip locked` does NOT
    // skip a row locked by the CURRENT transaction, so
    // promoteOldestWaitlisted — called in the SAME tx right after the lapse
    // UPDATE — re-selects T itself and immediately flips it back to
    // 'pending' with a fresh 48h window. Capacity never actually releases,
    // and a non-payer gets an endless string of "you've been promoted"
    // emails, once per sweep cycle, forever.
    expect(tRow.status).toBe("waitlisted");
    expect(tRow.promoted_at).toBeNull();
    expect(res.lapsed).toBeGreaterThanOrEqual(1); // identity checked above, not the platform-wide tally
    const [tCols] = await sql<{ promotion_expires_at: Date | null }[]>`
      select promotion_expires_at from registrations where id = ${t.registration.id}`;
    expect(tCols!.promotion_expires_at).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("RS007: sweep sibling isolation on a promotion lapse", () => {
  it("lapsing ONE promoted entry in a multi-entry cart does not touch its still-pending sibling", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const first = await seedRegistration(competition.id, division.id, settings, { status: "pending" });
    // Retroactively mark `first` as a promotion that is about to lapse.
    await sql`update registrations
              set promoted_at = now(), promotion_expires_at = now() - interval '1 minute'
              where id = ${first.registration.id}`;
    const sibling = await seedSecondEntry(first.registration.group_id, division.id, 500, "Sibling Two", "pending");
    const siblingBefore = await loadWithGroup(sibling.id);
    // A bystander waitlisted candidate elsewhere in the division, waiting
    // far longer than `first`'s about-to-be-fresh waitlisted_at — keeps the
    // re-offer from landing back on `first` itself, so this test stays
    // scoped to sibling isolation rather than re-offer ordering (covered
    // above).
    const filler = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", contactEmail: "filler@test.local",
    });
    await sql`update registrations set created_at = now() - interval '1 day' where id = ${filler.registration.id}`;

    await sweepRegistrations("https://test.local");

    const firstRow = await loadWithGroup(first.registration.id);
    expect(firstRow.status).toBe("waitlisted");

    const siblingAfter = await loadWithGroup(sibling.id);
    // Untouched: same status, same promoted_at (null throughout), same
    // updated_at — proves the lapse UPDATE is scoped by the entry's OWN id,
    // not by group_id (which both rows share).
    expect(siblingAfter.status).toBe("pending");
    expect(siblingAfter.promoted_at).toBeNull();
    expect(new Date(siblingAfter.updated_at).getTime()).toBe(new Date(siblingBefore.updated_at).getTime());
    // The shared cart clock is untouched too — the sibling is still pending,
    // so clearExpiresIfNoLongerNeeded must not have cleared it.
    expect(siblingAfter.expires_at).not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("RS007: regression — a never-promoted pending entry still expires", () => {
  it("a plain overdue pending entry (promoted_at never set) still goes to 'expired', not 'waitlisted'", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const { registration } = await seedRegistration(competition.id, division.id, settings, { status: "pending" });
    await sql`update registration_groups set expires_at = now() - interval '1 hour'
              where id = ${registration.group_id}`;

    const res = await sweepRegistrations("https://test.local");

    const row = await loadWithGroup(registration.id);
    expect(row.status).toBe("expired");
    expect(row.promoted_at).toBeNull();
    expect(res.expired).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!HAS_DB)("RS007: the entry's own clock governs even when the cart's shared clock has ALSO lapsed", () => {
  it("still lapses to 'waitlisted' (never 'expired') when both promotion_expires_at and the cart's expires_at are overdue together", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const t = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", contactEmail: "both-overdue@test.local",
    });
    const promotedT = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, t.registration.id, t.registration.group_id, settings),
    );
    expect(promotedT!.status).toBe("pending");
    // Both clocks overdue at once: the entry's own AND the shared cart's.
    await sql`update registrations set promotion_expires_at = now() - interval '1 minute'
              where id = ${t.registration.id}`;
    await sql`update registration_groups set expires_at = now() - interval '1 minute'
              where id = ${t.registration.group_id}`;
    // A bystander waitlisted candidate, waiting far longer than T's
    // about-to-be-fresh waitlisted_at — without it, T would be the ONLY
    // waitlisted row in the division and would legitimately win its own
    // re-offer, which is not what this test is isolating (that path is
    // covered by the "re-offers the slot" test above).
    const filler = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted", contactEmail: "filler-both@test.local",
    });
    await sql`update registrations set created_at = now() - interval '1 day' where id = ${filler.registration.id}`;

    await sweepRegistrations("https://test.local");

    const row = await loadWithGroup(t.registration.id);
    // Reverting the expire branch's "r.promoted_at is null" guard makes this
    // fail: the expire branch would ALSO match this row (its cart clock is
    // overdue too) and win the race, terminally expiring an entry the owner
    // ruling requires to return to the waitlist instead.
    expect(row.status).toBe("waitlisted");
    expect(row.promoted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// V379/RS007 — a promoted entry's own T-24h payment reminder. Its deadline
// is `promotion_expires_at`, not the cart's shared `expires_at` (same split
// V378 already made for expiry vs lapse). See the "remind promoted entrants
// before they lapse" task and its "Decide where the remind-once mark lives"
// instruction: it lives on the ENTRY (registrations.promotion_reminded_at),
// never the GROUP, because a group can hold a still-pending sibling whose
// own reminder must not be silenced by this one firing.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("RS007: sweep reminds a promoted entry off its OWN clock, once", () => {
  it("inside the last 24h of its own promotion_expires_at: reminded exactly once, via its OWN mark — not the group's", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const waiting = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    const promoted = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    // Single-entry cart: promoteWaitlistedRow's own `greatest(...)` write
    // (see its doc comment) lands the group's shared expires_at on the SAME
    // instant as this entry's own promotion_expires_at here, which is
    // exactly what makes this scenario able to catch a missing
    // `r.promoted_at is null` guard on the group-level reminder pass — pull
    // BOTH into the last-24h window together and confirm only ONE reminder
    // goes out, off the entry's OWN mark.
    await sql`update registrations set promotion_expires_at = now() + interval '10 hours'
              where id = ${promoted!.id}`;
    await sql`update registration_groups set expires_at = now() + interval '10 hours'
              where id = ${promoted!.group_id}`;

    const checkoutsFor = (id: string) =>
      stripeMock.checkoutCreate.mock.calls.filter(([args]) =>
        (args as { metadata?: { registration_ids?: string } })
          ?.metadata?.registration_ids
          ?.split(",")
          .includes(id),
      ).length;
    stripeMock.checkoutCreate.mockClear();

    const first = await sweepRegistrations("https://test.local");
    expect(first.reminded).toBeGreaterThanOrEqual(1);

    const [cols] = await sql<{ promotion_reminded_at: Date | null; submit_reminded_at: Date | null }[]>`
      select promotion_reminded_at, submit_reminded_at from registrations where id = ${promoted!.id}`;
    expect(cols!.promotion_reminded_at, "the entry's OWN mark is set").not.toBeNull();
    // Reverting the `r.promoted_at is null` guard on pass (1a)'s "due" query
    // makes this fail: pass (1a) would ALSO catch this row (its shared
    // expires_at is in-window and submit_reminded_at is null) and stamp this
    // too, on top of pass (1b)'s own mark checked above.
    expect(cols!.submit_reminded_at, "pass (1a)'s mark stays untouched").toBeNull();
    // Exactly one checkout link minted — two would mean two reminder emails
    // for the same entry from two passes.
    expect(checkoutsFor(promoted!.id)).toBe(1);

    // A second sweep must not re-remind.
    const remindedAt = cols!.promotion_reminded_at;
    await sweepRegistrations("https://test.local");
    const [cols2] = await sql<{ promotion_reminded_at: Date | null }[]>`
      select promotion_reminded_at from registrations where id = ${promoted!.id}`;
    expect(cols2!.promotion_reminded_at).toEqual(remindedAt);
    expect(checkoutsFor(promoted!.id)).toBe(1); // still exactly one — no re-send
  });

  // V381/RS007 — same lease fix, same semantics, on this pass's OWN column
  // (promotion_reminder_claimed_at). Mirrors the group-level lease test in
  // "card submit path (spec §3)"; kept separate because this pass
  // claims/sends off registrations.promotion_reminded_at, never the group's.
  it("V381: the promoted entry's own lease behaves the same — fresh blocks, stale retries and sends", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const contactEmail = `lease-promoted-${randomUUID().slice(0, 8)}@test.local`;
    const waiting = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted",
      contactEmail,
    });
    const promoted = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    await sql`update registrations set promotion_expires_at = now() + interval '10 hours'
              where id = ${promoted!.id}`;

    const sentCallsForOurs = () =>
      emailMock.paymentReminder.mock.calls.filter(
        ([opts]) => (opts as { to?: string })?.to === contactEmail,
      );
    const sentMark = async () => {
      const [row] = await sql<{ promotion_reminded_at: Date | null }[]>`
        select promotion_reminded_at from registrations where id = ${promoted!.id}`;
      return row!.promotion_reminded_at;
    };

    // Simulate a crash on this entry's OWN lease column.
    await sql`update registrations set promotion_reminder_claimed_at = now()
              where id = ${promoted!.id}`;

    await sweepRegistrations("https://test.local");
    expect(await sentMark(), "still unsent while the lease is fresh").toBeNull();
    expect(sentCallsForOurs(), "blocked — no send while the lease holds").toHaveLength(0);

    await sql`update registrations set promotion_reminder_claimed_at = now() - interval '1 day'
              where id = ${promoted!.id}`;
    const res = await sweepRegistrations("https://test.local");
    expect(res.reminded).toBeGreaterThanOrEqual(1);
    expect(await sentMark(), "the stale lease was retried and the reminder sent").not.toBeNull();
    expect(sentCallsForOurs(), "exactly one send once the lease actually goes through").toHaveLength(1);
  });

  // RS007 review fix (FIX 1) — same false-vs-throw gap as the group-level
  // pass above, on this pass's OWN lease/mark columns
  // (promotion_reminder_claimed_at / promotion_reminded_at).
  it("a delivered-but-failed send (false return) on the promoted pass clears its OWN lease instead of marking sent, and the next sweep retries", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const contactEmail = `remind-promoted-false-${randomUUID().slice(0, 8)}@test.local`;
    const waiting = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted",
      contactEmail,
    });
    const promoted = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    await sql`update registrations set promotion_expires_at = now() + interval '10 hours'
              where id = ${promoted!.id}`;

    const sentCallsForOurs = () =>
      emailMock.paymentReminder.mock.calls.filter(
        ([opts]) => (opts as { to?: string })?.to === contactEmail,
      );
    const cols = async () => {
      const [row] = await sql<{
        promotion_reminded_at: Date | null;
        promotion_reminder_claimed_at: Date | null;
      }[]>`
        select promotion_reminded_at, promotion_reminder_claimed_at from registrations
        where id = ${promoted!.id}`;
      return row!;
    };

    emailMock.paymentReminder.mockImplementation(async (opts: unknown) => {
      if ((opts as { to?: string } | undefined)?.to === contactEmail) return false;
      return true;
    });
    await sweepRegistrations("https://test.local");
    const afterFailure = await cols();
    expect(afterFailure.promotion_reminded_at, "never delivered — must stay null").toBeNull();
    expect(afterFailure.promotion_reminder_claimed_at, "the lease is released").toBeNull();
    expect(sentCallsForOurs()).toHaveLength(1);

    // `.mockImplementation` only — see the group-level pass's own test above
    // for why `.mockReset` here would silently erase the length-2 proof.
    emailMock.paymentReminder.mockImplementation(async () => true);
    const res2 = await sweepRegistrations("https://test.local");
    expect(res2.reminded).toBeGreaterThanOrEqual(1);
    const afterRetry = await cols();
    expect(afterRetry.promotion_reminded_at, "the retried send is now marked sent").not.toBeNull();
    expect(sentCallsForOurs()).toHaveLength(2);
  });

  // REVIEW FIX (money-path defect #12) — neither promoteWaitlistedRow nor the
  // sweep's lapse UPDATE ever cleared promotion_reminded_at, but pass (1b)
  // filters `promotion_reminded_at is null`. A re-promoted entry (lapsed once,
  // then re-offered a slot) carries its FIRST promotion's stale "already
  // reminded" mark into its SECOND window and is silently skipped forever —
  // it cannot fall back to pass (1a) either, which requires promoted_at is
  // null (this row's promoted_at is freshly set by the second promotion).
  it("REVIEW FIX: a re-promoted entry is reminded again for its NEW window, not silenced by its first promotion's stale mark", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const contactEmail = `re-promoted-remind-${randomUUID().slice(0, 8)}@test.local`;
    const waiting = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted",
      contactEmail,
    });
    const firstPromo = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    // Simulate: pass (1b) already reminded this entry once, for its FIRST
    // promotion window (a real prior sweep would have set both columns).
    await sql`update registrations
              set promotion_reminder_claimed_at = now(), promotion_reminded_at = now()
              where id = ${firstPromo!.id}`;

    // T lapses back to the waitlist and is promoted a SECOND time — same
    // write shape sweepRegistrations' lapse branch produces (waitlisted then
    // re-promoted), driven directly here to isolate this fix from the
    // re-offer/ordering behaviour covered elsewhere.
    await sql`update registrations set status = 'waitlisted' where id = ${firstPromo!.id}`;
    const secondPromo = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, firstPromo!.id, firstPromo!.group_id, settings),
    );
    expect(secondPromo!.status).toBe("pending");
    expect(secondPromo!.promotion_expires_at, "sanity: a fresh window opened").not.toBeNull();

    const [row] = await sql<{ promotion_reminded_at: Date | null }[]>`
      select promotion_reminded_at from registrations where id = ${firstPromo!.id}`;
    // Reverting the fix makes this fail: the stale mark from the FIRST
    // promotion survives the second promoteWaitlistedRow write.
    expect(row!.promotion_reminded_at).toBeNull();

    // End to end: pull the fresh window into the reminder sweep's range and
    // confirm the reminder actually fires a second time.
    await sql`update registrations set promotion_expires_at = now() + interval '10 hours'
              where id = ${firstPromo!.id}`;
    const sentCallsForOurs = () =>
      emailMock.paymentReminder.mock.calls.filter(
        ([opts]) => (opts as { to?: string })?.to === contactEmail,
      );
    const res = await sweepRegistrations("https://test.local");
    expect(res.reminded).toBeGreaterThanOrEqual(1);
    expect(sentCallsForOurs()).toHaveLength(1); // reminded again, for the NEW window
    const [row2] = await sql<{ promotion_reminded_at: Date | null }[]>`
      select promotion_reminded_at from registrations where id = ${firstPromo!.id}`;
    expect(row2!.promotion_reminded_at).not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("RS007: a promoted entry's reminder does not block a still-pending sibling's own reminder", () => {
  it("sibling's LATER reminder still fires once its own deadline is due — X's OWN mark never touches Y's", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 500 });
    const waiting = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    const promoted = await sql.begin((tx) =>
      promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, settings),
    );
    // X (promoted) is due now.
    await sql`update registrations set promotion_expires_at = now() + interval '10 hours'
              where id = ${promoted!.id}`;
    // Y — a second, never-promoted pending entry in the SAME cart — is not
    // due yet: its own (shared) deadline is safely out of the 24h window.
    const sibling = await seedSecondEntry(promoted!.group_id, division.id, 500, "Sibling Pending", "pending");
    await sql`update registration_groups set expires_at = now() + interval '40 hours'
              where id = ${promoted!.group_id}`;
    // REVIEW FIX (money-path defect #7): Y's own mark now lives on
    // registrations.submit_reminded_at (V383), not the group.
    const submitRemindedAt = async (id: string) => {
      const [row] = await sql<{ submit_reminded_at: Date | null }[]>`
        select submit_reminded_at from registrations where id = ${id}`;
      return row!.submit_reminded_at;
    };

    await sweepRegistrations("https://test.local"); // sweep #1 — only X is due

    const [xCols] = await sql<{ promotion_reminded_at: Date | null }[]>`
      select promotion_reminded_at from registrations where id = ${promoted!.id}`;
    expect(xCols!.promotion_reminded_at, "X's own reminder fired").not.toBeNull();
    expect(await submitRemindedAt(sibling.id), "Y is not due yet").toBeNull();

    // Now Y's own (shared) deadline enters the window too.
    await sql`update registration_groups set expires_at = now() + interval '10 hours'
              where id = ${promoted!.group_id}`;
    await sweepRegistrations("https://test.local"); // sweep #2

    // Reverting the per-entry mark to reuse a shared column for X's own
    // reminder makes this fail: X's sweep-1 write would already have set
    // that shared mark, and Y's own reminder would silently never fire —
    // the exact "a shared mark would silence a sibling's reminder" hazard
    // both this pass's own entry-scoping (V383) and pass (1b)'s
    // (promotion_reminded_at, V379) exist to avoid.
    expect(await submitRemindedAt(sibling.id), "Y's own reminder fires, unblocked by X's").not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RS003 W3a — group-scoped checkout minting (owner rulings 1, 2, 3, 5).
// Currency validation (ruling 4) is covered above, in "card submit path
// (spec §3)" — the check lives in createRegistrationCheckout, shared by
// every caller including mintGroupCheckout, so it is proven once.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("mintGroupCheckout — group-scoped Stripe session (RS003 W3a)", () => {
  it("mints ONE session for a multi-entry cart: N line items, amount = sum, application fee over the sum, group-keyed metadata on both session and intent", async () => {
    const { competition, division, settings } = await stripeRig();
    const first = await seedRegistration(competition.id, division.id, settings, { displayName: "Team A" });
    const second = await seedSecondEntry(first.registration.group_id, division.id, 700, "Team B");

    const url = await mintGroupCheckout(
      first.registration.group_id,
      division.id,
      "http://test.local",
      first.access_token,
    );
    expect(url).toBe("https://checkout.stripe.test/session");

    const args = stripeMock.checkoutCreate.mock.calls[0][0];
    expect(args.line_items).toHaveLength(2);
    expect(
      args.line_items
        .map((li: { price_data: { unit_amount: number } }) => li.price_data.unit_amount)
        .sort(),
    ).toEqual([500, 700]);
    // Pro plan (stripeRig seeds "pro") is 2% — over the SUM (1200), never
    // either entry alone.
    expect(args.payment_intent_data.application_fee_amount).toBe(applicationFeeCents(1200, 2));

    expect(args.metadata.kind).toBe("registration_group");
    expect(args.metadata.registration_group_id).toBe(first.registration.group_id);
    expect(args.metadata.registration_ids.split(",").sort()).toEqual(
      [first.registration.id, second.id].sort(),
    );
    expect(args.payment_intent_data.metadata.registration_group_id).toBe(first.registration.group_id);
    expect(args.payment_intent_data.metadata.registration_ids.split(",").sort()).toEqual(
      [first.registration.id, second.id].sort(),
    );
    // Greenfield conversion (owner ruling 3) — no reader should ever find
    // the old entry-scoped shape on a freshly minted session.
    expect(args.metadata.registration_id).toBeUndefined();
    expect(args.payment_intent_data.metadata.registration_id).toBeUndefined();

    // checkout_session_id/fee_percent have always lived on the GROUP
    // (V364) — the mint stamps the cart, not either entry.
    const group = await loadWithGroup(first.registration.id);
    expect(group.checkout_session_id).toMatch(/^cs_test_/);
  });

  it("a partial-waitlist cart charges only the non-waitlisted entries", async () => {
    const { competition, division, settings } = await stripeRig();
    const paid = await seedRegistration(competition.id, division.id, settings, { displayName: "Paid Entry" });
    const waitlisted = await seedSecondEntry(
      paid.registration.group_id,
      division.id,
      0,
      "Waitlisted Entry",
      "waitlisted",
    );

    const url = await mintGroupCheckout(
      paid.registration.group_id,
      division.id,
      "http://test.local",
      paid.access_token,
    );
    expect(url).not.toBeNull();

    const args = stripeMock.checkoutCreate.mock.calls[0][0];
    expect(args.line_items).toHaveLength(1);
    expect(args.line_items[0].price_data.unit_amount).toBe(500);
    expect(args.metadata.registration_ids).toBe(paid.registration.id);
    expect(args.metadata.registration_ids).not.toContain(waitlisted.id);
  });

  it("a maximal 10-entry cart keeps the joined registration_ids metadata value under Stripe's 500-char limit", async () => {
    // Must track schemas.ts's PublicRegisterGroupRequest.entries.max(10)
    // (RS003 W1) — so a future cap raise fails HERE, not in production
    // (owner ruling 2).
    const { competition, division, settings } = await stripeRig();
    const first = await seedRegistration(competition.id, division.id, settings, { displayName: "Entry 0" });
    const ids = [first.registration.id];
    for (let i = 1; i < 10; i++) {
      const entry = await seedSecondEntry(first.registration.group_id, division.id, 100, `Entry ${i}`);
      ids.push(entry.id);
    }
    expect(ids).toHaveLength(10);

    const url = await mintGroupCheckout(
      first.registration.group_id,
      division.id,
      "http://test.local",
      first.access_token,
    );
    expect(url).not.toBeNull();

    const args = stripeMock.checkoutCreate.mock.calls[0][0];
    expect(args.line_items).toHaveLength(10);
    const joined = args.metadata.registration_ids as string;
    expect(joined.split(",").sort()).toEqual([...ids].sort());
    expect(joined.length).toBeLessThan(500);
    expect((args.payment_intent_data.metadata.registration_ids as string).length).toBeLessThan(500);
  });

  it("an all-waitlisted cart mints nothing (owner ruling 5)", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    expect(res.registration.payment_method).toBeNull();

    const url = await mintGroupCheckout(
      res.registration.group_id,
      division.id,
      "http://test.local",
      res.access_token,
    );
    expect(url).toBeNull();
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("an offline payment-method cart mints nothing (owner ruling 5)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 500,
    });
    const res = await seedRegistration(competition.id, division.id, settings);
    expect(res.registration.payment_method).toBe("offline");

    const url = await mintGroupCheckout(
      res.registration.group_id,
      division.id,
      "http://test.local",
      res.access_token,
    );
    expect(url).toBeNull();
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RS003 W4 — per-currency matrix over REGISTRATION_CURRENCIES, minted through
// mintGroupCheckout (the group-scoped entry point this whole wave is about),
// against the Stripe mock. Owner ruling 10: INR settles offline/display-only
// on this GB platform in practice (a connected org's charge currency always
// equals its Connect account's settlement currency) — that does not exempt
// it from this matrix, which asserts what OUR code SENDS to Stripe for every
// allowlisted currency, not just the ones reachable end-to-end today.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("mintGroupCheckout — per-currency matrix (RS003 W4)", () => {
  // The it.each below is driven by the REGISTRATION_CURRENCIES IMPORT
  // itself, never a hand-copied literal — so an added/removed/reordered
  // currency changes what this loop iterates. But that alone doesn't make a
  // silent widening go RED: a newly-added, well-supported currency would
  // just quietly start passing, with nothing forcing anyone to notice the
  // list grew. This pin is what actually goes red on that change — a
  // `toEqual` against a frozen literal has no knowledge of the new/removed/
  // reordered entry, so any drift between the live export and this literal
  // is a deep-equality mismatch, reported as a failing assertion, before
  // anyone even looks at whether the it.each results are correct. Mutation
  // mechanism note (see task report): proved by temporarily drifting the
  // expected literal against the real export (not by editing the shared
  // production currency.ts in this shared worktree) — toEqual can't tell
  // which side moved, so this reproduces exactly the diff a real
  // currency.ts edit would leave.
  it("pins REGISTRATION_CURRENCIES to the five currencies this matrix covers", () => {
    expect(REGISTRATION_CURRENCIES).toEqual(["usd", "eur", "gbp", "inr", "aud"]);
  });

  it.each(REGISTRATION_CURRENCIES)(
    "mints a two-entry %s cart: exact per-entry + summed amounts, fee over the sum, destination charge, snapshot currency charged",
    async (currency: Currency) => {
      const { competition, division, stripeAccountId } = await currencyRig(currency);
      const first = await seedRegistration(
        competition.id,
        division.id,
        { fee_cents: 733, currency, payment_method: "stripe" },
        { displayName: "Entry One" },
      );
      const second = await seedSecondEntry(first.registration.group_id, division.id, 866, "Entry Two");

      const url = await mintGroupCheckout(
        first.registration.group_id,
        division.id,
        "http://test.local",
        first.access_token,
      );
      expect(url).toBe("https://checkout.stripe.test/session");

      const args = stripeMock.checkoutCreate.mock.calls[0][0];
      expect(args.line_items).toHaveLength(2);
      // Every line item carries the GROUP's snapshot currency (g.currency,
      // regGroupCols) — the same value ctx.currency was forced to equal by
      // createRegistrationCheckout's guard before Stripe was ever reached.
      // Under today's schema the guard makes the two indistinguishable BY
      // VALUE at this point (see
      // reference_currency_dual_check_not_independently_provable.md for the
      // same structural fact one level up, on the guard's own two
      // conditions) — so this pins observed behaviour precisely, without
      // claiming an independent proof of "sourced from the snapshot, not a
      // re-read", which isn't mutation-discriminable while the guard holds.
      const lineItems = args.line_items as { price_data: { currency: string; unit_amount: number } }[];
      for (const li of lineItems) {
        expect(li.price_data.currency).toBe(currency);
      }
      const amounts = lineItems.map((li) => li.price_data.unit_amount).sort((a: number, b: number) => a - b);
      expect(amounts).toEqual([733, 866]); // exact per-entry, no drift
      expect(amounts[0] + amounts[1]).toBe(1599); // exact summed total, no drift

      // Pro plan (currencyRig seeds "pro") is 2% — over the SUM (1599),
      // never one entry alone: applicationFeeCents(733,2)=15,
      // applicationFeeCents(866,2)=17, neither equals the correct 32 below.
      expect(args.payment_intent_data.application_fee_amount).toBe(applicationFeeCents(1599, 2));
      // Destination charge preserved: the org's connected account, not the
      // platform's own.
      expect(args.payment_intent_data.transfer_data.destination).toBe(stripeAccountId);
      expect((args.metadata.registration_ids as string).split(",").sort()).toEqual(
        [first.registration.id, second.id].sort(),
      );

      const group = await loadWithGroup(first.registration.id);
      expect(group.checkout_session_id).toMatch(/^cs_test_/);
    },
  );

  // Owner ruling 4's guard already has full coverage under "card submit path
  // (spec §3)" above, via resumeRegistrationCheckout — a DIFFERENT public
  // entry point onto the same shared createRegistrationCheckout. Re-asserted
  // here through mintGroupCheckout (the entry point this whole wave is
  // about) so the guard is proven uniform across both callers, not just the
  // older one.
  it("422s per the matrix when the group's currency isn't allowlisted, and never calls Stripe", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    const res = await seedRegistration(competition.id, division.id, {
      fee_cents: 500,
      currency: "jpy",
      payment_method: "stripe",
    });
    await expect(
      mintGroupCheckout(res.registration.group_id, division.id, "http://test.local", res.access_token),
    ).rejects.toMatchObject({ status: 422, code: "REGISTRATION_CURRENCY_UNAVAILABLE" });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("422s per the matrix when the group's snapshot no longer matches the org's CURRENT currency, and never calls Stripe", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations
              set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    // organizations.currency defaults to 'gbp' (V365) and is left untouched
    // here — the group below snapshots 'usd', individually valid but
    // mismatched, reproducing an org that changed its preferred currency
    // after this cart was submitted.
    const { competition, division } = await rig(owner);
    const res = await seedRegistration(competition.id, division.id, {
      fee_cents: 500,
      currency: "usd",
      payment_method: "stripe",
    });
    await expect(
      mintGroupCheckout(res.registration.group_id, division.id, "http://test.local", res.access_token),
    ).rejects.toMatchObject({ status: 422, code: "REGISTRATION_CURRENCY_UNAVAILABLE" });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("registrationIcs: escapes RFC 5545 TEXT values (commas, semicolons, backslashes)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);

    // Create competition and division with names containing special characters
    // that require RFC 5545 TEXT escaping (§3.3.11)
    const competition = await createCompetition(owner, {
      name: "Spring Cup, Round 2; Finals",
      visibility: "public",
      branding: {},
      starts_on: "2026-09-15",
      ends_on: "2026-09-20",
    });
    const division = await createDivision(owner, competition.id, {
      name: "Open; Quarterfinals, Round 1",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });

    // Create registration with display name containing special characters
    const settings = await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
    const reg = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Test; Entrant, Inc.",
    });

    // Get the ICS output
    const ics = await registrationIcs(reg.registration.id, reg.access_token);

    // Assert RFC 5545 TEXT escaping: commas and semicolons must be escaped
    // SUMMARY should be: "Spring Cup\, Round 2\; Finals — Open\; Quarterfinals\, Round 1"
    expect(ics).toContain("SUMMARY:Spring Cup\\, Round 2\\; Finals — Open\\; Quarterfinals\\, Round 1");
    // DESCRIPTION should have escaped text: "Registration for Test\; Entrant\, Inc. (pending)"
    expect(ics).toContain("DESCRIPTION:Registration for Test\\; Entrant\\, Inc. (pending)");
    // Ensure the raw unescaped versions are NOT in the output
    expect(ics).not.toContain("SUMMARY:Spring Cup, Round 2; Finals");
    expect(ics).not.toContain("DESCRIPTION:Registration for Test; Entrant, Inc.");
  });

  // B2 review findings: registrationIcs hand-rolled a second VCALENDAR
  // instead of reusing buildIcs. This block pins the fix without adopting
  // buildIcs directly — a naive swap is LOSSY (see the four "PRESERVED"
  // tests below) — via a local builder that reuses foldLine + icsText.
  describe("registrationIcs: CALSCALE/METHOD, localized DESCRIPTION, octet-correct folding (B2)", () => {
    it("REGRESSION: emits CALSCALE and METHOD, missing from today's hand-rolled VCALENDAR", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const settings = await putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 0, form_fields: [],
        opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      });
      const reg = await seedRegistration(competition.id, division.id, settings);
      const ics = await registrationIcs(reg.registration.id, reg.access_token);
      expect(ics).toContain("CALSCALE:GREGORIAN");
      expect(ics).toContain("METHOD:PUBLISH");
    });

    it("REGRESSION: localizes the DESCRIPTION via the registrant's OWN locale (fr) — the same signal notifyRefund/other post-signup emails already resolve via toLocale(reg.locale) — not hardcoded English", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const settings = await putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 0, form_fields: [],
        opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      });
      const reg = await seedRegistration(competition.id, division.id, settings, {
        displayName: "Alex Test",
        locale: "fr",
      });
      const ics = await registrationIcs(reg.registration.id, reg.access_token);
      // fr's reg.status.pending is "en attente" — the raw enum word "pending"
      // (what the old hardcoded English literally printed) must not survive.
      expect(ics).toMatch(/DESCRIPTION:.*Alex Test.*en attente/);
      expect(ics).not.toMatch(/DESCRIPTION:Registration for/);
      expect(ics).not.toContain("(pending)");
    });

    it("REGRESSION: folds a line crossing 75 UTF-8 octets, and never splits multi-byte text mid-character — an ASCII-only fixture (registrations.test.ts:779) cannot prove this", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      // A French competition name: long enough, in OCTETS, to force a fold —
      // its .length (UTF-16 units) stays comfortably under 74, exactly the
      // case a naive UTF-16-based fold misses (the accented chars below are
      // each 2 UTF-8 octets but 1 UTF-16 code unit).
      const longName =
        "Championnat Départemental Été Régional des Étudiants Généreux et Décorés";
      expect(
        longName.length,
        "precondition: under 74 UTF-16 units — a UTF-16-length-based fold would wrongly skip this line",
      ).toBeLessThan(74);
      expect(
        Buffer.byteLength(longName, "utf8"),
        "precondition: over 75 UTF-8 octets — the actual RFC 5545 §3.1 budget",
      ).toBeGreaterThan(75);
      const competition = await createCompetition(owner, {
        name: longName,
        visibility: "public",
        branding: {},
        starts_on: "2026-09-15",
        ends_on: "2026-09-20",
      });
      const division = await createDivision(owner, competition.id, {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
      const settings = await putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 0, form_fields: [],
        opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      });
      const reg = await seedRegistration(competition.id, division.id, settings);
      const ics = await registrationIcs(reg.registration.id, reg.access_token);

      // Folding does NOT remove the "SUMMARY:" prefix from the property's
      // first physical line — it splits the CONTENT after it — so the right
      // proof is that the first physical line stays inside the octet
      // budget, and a continuation line (a lone leading space, RFC 5545
      // §3.1) immediately follows it.
      const lines = ics.split("\r\n");
      const summaryStart = lines.findIndex((l) => l.startsWith("SUMMARY:"));
      expect(summaryStart, "a SUMMARY line must exist").toBeGreaterThanOrEqual(0);
      expect(
        Buffer.byteLength(lines[summaryStart]!, "utf8"),
        "today's code emits this whole property on one unfolded line, over the 74-octet budget",
      ).toBeLessThanOrEqual(74);
      expect(
        lines[summaryStart + 1]?.startsWith(" "),
        "no fold continuation line followed — the property was never split",
      ).toBe(true);
      // No accented character was corrupted by the fold — the escaped name
      // still appears intact (icsText only touches \ ; , and newlines, none
      // of which this name contains, so it must round-trip byte-for-byte
      // once the CRLF+space fold markers are stripped back out).
      expect(ics.replace(/\r\n /g, "")).toContain(longName);
      // Every physical line in the whole output fits the octet budget, not
      // just the ones this test happens to inspect above.
      for (const line of lines) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(74);
      }
    });
  });

  // Four behaviours a naive "swap the body for a buildIcs call" would have
  // silently broken (review finding), each pinned by its own test so a
  // future refactor trips on the right one immediately.
  describe("registrationIcs: behaviours a buildIcs swap must NOT change (B2)", () => {
    it("PRESERVED: UID stays registration-<id>@seazn.club — not double-suffixed by routing through buildIcs's own @seazn.club append", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const settings = await putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 0, form_fields: [],
        opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      });
      const reg = await seedRegistration(competition.id, division.id, settings);
      const ics = await registrationIcs(reg.registration.id, reg.access_token);
      const uidLine = ics.split("\r\n").find((l) => l.startsWith("UID:"));
      expect(uidLine).toBe(`UID:registration-${reg.registration.id}@seazn.club`);
      expect(uidLine).not.toContain("@seazn.club@seazn.club");
    });

    it("PRESERVED: the all-day span still runs starts_on..ends_on+1 (multi-day), not collapsed to buildIcs's one-day allDayOn default", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner); // starts_on 2026-09-15, ends_on 2026-09-20
      const settings = await putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 0, form_fields: [],
        opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      });
      const reg = await seedRegistration(competition.id, division.id, settings);
      const ics = await registrationIcs(reg.registration.id, reg.access_token);
      expect(ics).toContain("DTSTART;VALUE=DATE:20260915");
      // Exclusive DTEND the day AFTER ends_on (2026-09-21) — a one-day
      // collapse would instead emit 20260916 (the day after DTSTART).
      expect(ics).toContain("DTEND;VALUE=DATE:20260921");
      expect(ics).not.toContain("DTEND;VALUE=DATE:20260916");
    });

    it("PRESERVED: no STATUS line — a confirmed registration is not TENTATIVE, unlike buildIcs's all-day default", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const settings = await putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 0, form_fields: [],
        opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      });
      const reg = await seedRegistration(competition.id, division.id, settings);
      const ics = await registrationIcs(reg.registration.id, reg.access_token);
      expect(ics).not.toContain("STATUS:");
    });

    it("PRESERVED: PRODID stays the registration namespace, not buildIcs's hardcoded public-dashboard one", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const settings = await putRegistrationSettings(owner, division.id, {
        enabled: true, entrant_kind: "individual", fee_cents: 0, form_fields: [],
        opens_at: null, closes_at: null, capacity: null, refund_lock_at: null,
      });
      const reg = await seedRegistration(competition.id, division.id, settings);
      const ics = await registrationIcs(reg.registration.id, reg.access_token);
      expect(ics).toContain("PRODID:-//seazn.club//registration//EN");
      expect(ics).not.toContain("PRODID:-//seazn.club//public-dashboard//EN");
    });
  });
});

// ---------------------------------------------------------------------------
// RS005 F1 review: findings 1 & 2 — resend/promotion/dispute-evidence money
// correctness (buildCartMail + registrationTemplate's "paid" gate)
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("RS005 F1 finding 1: a settled cart's resend does not re-demand money", () => {
  it("resending confirmation for an offline-paid (now confirmed) entry omits the fee ask entirely", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, fee_cents: 5000, payment_method: "offline",
      payment_instructions: "Pay at the front desk",
    });
    const seeded = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Paid Team",
    });
    const confirmedRow = await markRegistrationPaidOffline(owner, seeded.registration.id);
    expect(confirmedRow.status, "sanity: fully settled, not merely 'paid'").toBe("confirmed");

    await resendRegistrationConfirmation(owner, seeded.registration.id, "https://test.local");
    expect(emailMock.registration).toHaveBeenCalledTimes(1);
    const sentArgs = emailMock.registration.mock.calls[0]![0] as Parameters<
      typeof registrationTemplate
    >[0] & { to: string; locale: string | null };

    // The REAL template renders the args resendRegistrationConfirmation
    // actually built — this is the "assert the rendered text, not just that
    // it sent" bar, not a mock-behaviour assertion.
    const rendered = registrationTemplate(sentArgs, emailsEn as Dict);
    expect(rendered.html).not.toContain("Entry fee");
    expect(rendered.text).not.toContain("Entry fee");
  });
});

describe.skipIf(!HAS_DB)("RS005 F1 finding 2: a promoted entry's mail/evidence carry its NEW fee", () => {
  it("resending confirmation after a waitlist promotion carries the newly-owed fee, not the stale submit-time zero", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, fee_cents: 1500, payment_method: "offline",
      payment_instructions: "Pay at the front desk",
    });
    const waiting = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted",
      displayName: "Waiting Team",
    });
    const promoted = await sql.begin((tx) => promoteOldestWaitlisted(tx, division.id, settings));
    expect(promoted!.id).toBe(waiting.registration.id);
    expect(promoted!.amount_cents, "sanity: the per-entry column IS updated by promotion").toBe(1500);

    await resendRegistrationConfirmation(owner, promoted!.id, "https://test.local");
    const sentArgs = emailMock.registration.mock.calls.at(-1)![0] as Parameters<
      typeof registrationTemplate
    >[0] & { to: string; locale: string | null };
    // Before the fix: buildCartMail read the stale registration_groups.
    // amount_cents (0 — the entry was waitlisted at submit time), so this
    // was 0 and no fee panel rendered at all.
    expect(sentArgs.totalCents).toBe(1500);
    const rendered = registrationTemplate(sentArgs, emailsEn as Dict);
    expect(rendered.html).toContain("Entry fee: £15.00");
  });

  it("the dispute-evidence pack's reconstructed receipt agrees with its own Amount row after a promotion", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE, fee_cents: 1500, payment_method: "offline",
      payment_instructions: "Pay at the front desk",
    });
    const waiting = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted",
      displayName: "Waiting Team",
    });
    const promoted = await sql.begin((tx) => promoteOldestWaitlisted(tx, division.id, settings));
    expect(promoted!.id).toBe(waiting.registration.id);

    const pack = await buildDisputeEvidence(owner, promoted!.id, "https://test.local");
    // Amount row: this entry's own fee, straight off registrations.amount_cents
    // (promoteWaitlistedRow already updates this correctly — never the bug).
    expect(pack.html).toContain("15.00 GBP");
    // The reconstructed receipt must AGREE. Before the fix it read the
    // cart's stale submit-time (waitlisted then ⇒ 0) subtotal and rendered
    // no fee panel at all — a receipt contradicting the Amount row right
    // above it in the same document, submitted to Stripe as evidence.
    expect(pack.html).toContain("Entry fee: £15.00");
  });
});

// ---------------------------------------------------------------------------
// RS005 F1 (owner, 2026-08-12 standing rule): new code ships logging. The
// three swallowed/silent paths this wave's own W4 code introduced —
// buildCartMail's two null returns, notifySubmitted's bare catch, and
// resendRegistrationConfirmation's refusal/send-failure — all left an
// organiser or a registrant getting nothing with zero trace anywhere.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("RS005 F1: swallowed registration-mail failures are now logged", () => {
  it("resendRegistrationConfirmation logs the refusal on a terminal entry, with the actor and registration id", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: 0 });
    const seeded = await seedRegistration(competition.id, division.id, settings);
    await withdrawRegistrationOrganiser(owner, seeded.registration.id);

    const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    await expect(
      resendRegistrationConfirmation(owner, seeded.registration.id, "https://test.local"),
    ).rejects.toThrow(HttpError);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      registrationId: seeded.registration.id,
      orgId,
      actorId: ownerId,
    });
    expect(spy.mock.calls[0]?.[1]).toContain("resend refused");
    spy.mockRestore();
  });

  it("resendRegistrationConfirmation logs when the provider does not accept the send", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: 0 });
    const seeded = await seedRegistration(competition.id, division.id, settings);
    emailMock.forceRegistrationResult = false;

    const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    const result = await resendRegistrationConfirmation(owner, seeded.registration.id, "https://test.local");
    expect(result.sent).toBe(false);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ registrationId: seeded.registration.id, orgId });
    expect(spy.mock.calls.at(-1)?.[1]).toContain("did not accept");
    spy.mockRestore();
  });

  it("buildCartMail (via notifySubmitted) logs when the group cannot be found", async () => {
    const missingGroupId = randomUUID();
    const spy = vi.spyOn(log, "error").mockImplementation(() => undefined as never);

    await expect(
      notifySubmitted(missingGroupId, "https://test.local", "tok_x", null),
    ).resolves.toBeUndefined(); // still fire-and-forget — never throws
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ groupId: missingGroupId });
    expect(spy.mock.calls[0]?.[1]).toContain("no group");
    spy.mockRestore();
  });

  it("buildCartMail (via notifySubmitted) logs when the group has no entries", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, amount_cents, currency)
      values (${competition.id}, 'Ghost', 'ghost@test.local', ${randomUUID()}, 0, 'gbp')
      returning id`;
    const spy = vi.spyOn(log, "error").mockImplementation(() => undefined as never);

    await notifySubmitted(groupId, "https://test.local", "tok_x", null);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ groupId });
    expect(spy.mock.calls[0]?.[1]).toContain("no entries");
    spy.mockRestore();
  });

  it("notifySubmitted logs (never throws) when the send itself throws", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: 0 });
    const seeded = await seedRegistration(competition.id, division.id, settings);
    const boom = new Error("provider exploded");
    emailMock.forceRegistrationError = boom;

    const spy = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    await expect(
      notifySubmitted(seeded.registration.group_id, "https://test.local", seeded.access_token, null),
    ).resolves.toBeUndefined(); // fire-and-forget semantics preserved
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ err: boom, groupId: seeded.registration.group_id });
    expect(spy.mock.calls[0]?.[1]).toContain("submit confirmation");
    spy.mockRestore();
  });
});

// Review fix (RS007): buildGroupStatusView (shared by groupByRef/groupById)
// used to non-null-assert `ref_code: group.ref_code!` and GroupStatusView
// declared it `string`. The column genuinely IS nullable at this point — a
// submit whose ref-mint retries were exhausted still commits the cart with
// ref_code: null (submitRegistrationGroup), and `groupById` exists
// specifically to keep serving that exact cart by its always-present id (see
// groupById's own doc comment, and the RS007 status page's, which say so in
// those words). Every OTHER ref_code-shaped field in this file
// (PublicStatusView.ref_code, the refCode/refStatusUrl pairs elsewhere in
// registrations.ts) is already correctly typed/guarded nullable — this one
// call site was the odd one out.
//
// The trap: TypeScript's `!` is erased at compile time and never throws, so
// it changes NOTHING about runtime behaviour — `group.ref_code!` and
// `group.ref_code` evaluate identically whether the column is null or not.
// A test that asserts groupById "does not throw" or "returns null" on a
// ref-mint-exhausted cart would pass identically before and after this fix,
// which is exactly the accidentally-passing idiom to avoid here: it proves
// the runtime value flows through (worth pinning as a regression guard, see
// the first `it` below), but it can't be the FALSIFIABLE check, because
// nothing here was ever going to throw. The actual defect is a TYPE lie —
// GroupStatusView promised `string` for a value that can be `null` — so the
// falsifiable check is a type-level pin (second `it` below), whose failure
// surfaces as a `tsc --noEmit` error, not a vitest assertion. Confirmed
// pre-fix: `const pin: GroupStatusView["ref_code"] = null;` fails to
// compile with "Type 'null' is not assignable to type 'string'" until
// GroupStatusView.ref_code widens to `string | null`.
describe.skipIf(!HAS_DB)("groupById — ref_code is genuinely nullable (FIX 2 review)", () => {
  it("a cart whose ref-mint was exhausted still resolves by id, and ref_code reads back null end to end", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const settings = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: 0 });
    const { registration, access_token } = await seedRegistration(competition.id, division.id, settings, {
      refCode: null,
      players: [{ name: "No Ref Player" }],
    });
    // The seed actually landed the case under test.
    expect(registration.ref_code).toBeNull();

    const view = await groupById(registration.group_id, access_token);
    expect(view.ref_code).toBeNull();
    expect(view.entries).toHaveLength(1);
  });

  it("GroupStatusView types ref_code as nullable — a type-level pin, not a runtime one (see describe comment)", () => {
    // Only compiles if GroupStatusView['ref_code'] includes null. This is
    // the real red for this fix: pre-fix it fails `tsc --noEmit` with
    // "Type 'null' is not assignable to type 'string'"; vitest's own
    // pass/fail count cannot see it either way, because `!` has no runtime
    // effect to assert against (see the describe block's own comment).
    const pin: GroupStatusView["ref_code"] = null;
    expect(pin).toBeNull();
  });
});
