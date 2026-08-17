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
const emailMock = vi.hoisted(() => ({
  disputeLost: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendDisputeLostEmail: emailMock.disputeLost,
}));

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
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  ageAt,
  applicationFeeCents,
  eligibilityIssues,
  isMinor,
  validateAnswers,
  putRegistrationSettings,
  getRegistrationSettings,
  publicRegistrationInfo,
  publicRegistrationStatus,
  publicRegistrationStatusByRef,
  withdrawRegistrationByRef,
  handleRegistrationCheckoutCompleted,
  handleRegistrationDispute,
  syncRegistrationRefund,
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
  hashRegistrationToken,
  REGISTRATION_TOKEN_PREFIX,
  type RegistrationRow,
  type RegistrationWithGroupRow,
} from "../registrations";
import { isValidRefCode, generateRefCode } from "@/lib/ref-code";
import { LEGAL_VERSION } from "@/lib/legal";
import { resolveNameDisplay } from "@/lib/name-display";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
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

  const U16 = [
    {
      kind: "age",
      maxAgeAt: 15,
      cutoff: { month: 9, day: 1, yearOf: "season_start" },
    },
  ];

  it("U16 cutoff rule: 15-or-younger on Sep 1 of the season-start year", () => {
    // Season starts 2026 → cutoff 2026-09-01.
    expect(eligibilityIssues(U16, { dob: "2011-08-31" }, 2026)).toEqual([]); // 15 on cutoff
    expect(eligibilityIssues(U16, { dob: "2010-09-01" }, 2026)).not.toEqual([]); // 16 on cutoff
  });

  it("age rule without a DOB is an issue (form must collect it)", () => {
    expect(eligibilityIssues(U16, { dob: null }, 2026)).not.toEqual([]);
  });

  it("gender rule checks the allowed list", () => {
    const rules = [{ kind: "gender", allowed: ["f", "x"] }];
    expect(eligibilityIssues(rules, { dob: null, gender: "f" }, 2026)).toEqual([]);
    expect(eligibilityIssues(rules, { dob: null, gender: "m" }, 2026)).not.toEqual([]);
    expect(eligibilityIssues(rules, { dob: null, gender: null }, 2026)).not.toEqual([]);
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

// ---------------------------------------------------------------------------
// DB-backed flows
// ---------------------------------------------------------------------------

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{
  orgId: string;
  orgSlug: string;
  ownerId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "reg-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Reg Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return { orgId, orgSlug, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig(
  owner: AuthCtx,
  opts: { eligibility?: Record<string, unknown>[]; startsOn?: string } = {},
) {
  const competition = await createCompetition(owner, {
    name: "Reg Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: opts.startsOn ?? "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: opts.eligibility ?? [],
  });
  return { competition, division };
}

/** r.* ∪ g.* — same join `regGroupCols` builds internally (not exported).
 *  Kept in exact column-list sync with it by the schema tests in
 *  registration-schema.test.ts, which pin every column on both tables.
 *  `g.refunded_cents` is aliased to `group_refunded_cents` (V367) so it never
 *  collides with `r.refunded_cents` — see the block comment above
 *  `RegistrationWithGroupRow` in registrations.ts. */
async function loadWithGroup(regId: string): Promise<RegistrationWithGroupRow> {
  const [row] = await sql<RegistrationWithGroupRow[]>`
    select r.id, r.division_id, r.org_id, r.status, r.display_name, r.answers,
           r.amount_cents, r.refunded_cents, r.entrant_id, r.promoted_at, r.withdrawn_at,
           r.group_id, r.join_code, r.free_agent, r.created_at, r.updated_at,
           g.contact_name, g.contact_email, g.user_id, g.locale, g.ref_code,
           g.access_token_hash, g.currency, g.payment_method, g.checkout_session_id,
           g.payment_intent_id, g.expires_at, g.reminded_at,
           g.refunded_cents as group_refunded_cents,
           g.refunded_at, g.disputed_at, g.dispute_id, g.offline_marked_paid_at,
           g.offline_marked_paid_by, g.fee_percent, g.privacy_consent_at,
           g.privacy_consent_version
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId}`;
  return row;
}

/** Attaches a SECOND entry to an existing cart (group) — reproduces what a
 *  multi-entry cart will look like once RS002/RS003 ship group submit
 *  (design §3). No such flow exists yet, so this seeds directly, the same
 *  way seedRegistration reproduces submitRegistration's single-entry write. */
async function seedSecondEntry(
  groupId: string,
  divisionId: string,
  amountCents: number,
  displayName: string,
): Promise<RegistrationWithGroupRow> {
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, status, amount_cents)
    values (${groupId}, ${divisionId}, ${displayName}, 'pending', ${amountCents})
    returning id`;
  return loadWithGroup(reg.id);
}

/**
 * `submitRegistration` is deleted (RS001 registration demolition) — the
 * public submit route stays closed until RS002/RS003 ship the new
 * group-shaped cart flow (design §4). Every usecase exercised BELOW submit
 * (confirm, refund, waitlist, dispute, sweep, export, .ics…) is untouched and
 * still needs its regression coverage, so this seeds an equivalent
 * single-entry cart DIRECTLY — registration_groups → registrations →
 * registration_players, the V363/V364 shape — reproducing exactly what
 * `submitRegistration` used to write for one entry. It does NOT reproduce
 * submitRegistration's OWN decision logic (eligibility gate, form-answer
 * validation, privacy-consent gate, window/capacity checks, ref minting) —
 * those are gone with it; RS002/RS003 own re-testing them against the new
 * flow. `checkout_url` is always null here — a test that needs a live Stripe
 * session calls the surviving `resumeRegistrationCheckout` explicitly.
 */
async function seedRegistration(
  competitionId: string,
  divisionId: string,
  settings: { fee_cents: number; currency: string; payment_method: "offline" | "stripe" },
  over: {
    displayName?: string;
    contactEmail?: string;
    status?: RegistrationRow["status"];
    amountCents?: number;
    answers?: Record<string, unknown>;
    players?: {
      name: string;
      dob?: string | null;
      gender?: string | null;
      squadNumber?: number | null;
    }[];
    locale?: string | null;
    refCode?: string | null;
  } = {},
): Promise<{ registration: RegistrationWithGroupRow; access_token: string; checkout_url: null }> {
  const rawToken = REGISTRATION_TOKEN_PREFIX + randomUUID().replace(/-/g, "");
  const status = over.status ?? "pending";
  // Waitlisted rows hold amount 0 and no pay window — same invariant
  // `promoteOldestWaitlisted` relies on (registrations.ts:624).
  const waitlisted = status === "waitlisted";
  const amountCents = waitlisted ? 0 : (over.amountCents ?? settings.fee_cents);
  const method = waitlisted ? null : settings.payment_method;
  const stripeWindow = !waitlisted && method === "stripe" && amountCents > 0 && status === "pending";
  const displayName = over.displayName ?? "Alex Test";

  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups
      (competition_id, contact_name, contact_email, access_token_hash,
       amount_cents, currency, payment_method, expires_at, locale, ref_code,
       privacy_consent_at, privacy_consent_version)
    values (
      ${competitionId}, ${displayName}, ${over.contactEmail ?? "alex@test.local"},
      ${hashRegistrationToken(rawToken)},
      ${amountCents}, ${settings.currency}, ${method},
      ${stripeWindow ? sql`now() + interval '48 hours'` : null},
      ${over.locale ?? null}, ${over.refCode ?? null},
      now(), ${LEGAL_VERSION}
    )
    returning id`;

  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, status, amount_cents, answers)
    values (
      ${group.id}, ${divisionId}, ${displayName}, ${status}, ${amountCents},
      ${sql.json((over.answers ?? {}) as never)}
    )
    returning id`;

  for (const p of over.players ?? []) {
    await sql`
      insert into registration_players (registration_id, full_name, dob, gender, squad_number, source)
      values (
        ${reg.id}, ${p.name}, ${p.dob ?? null}, ${p.gender ?? null},
        ${p.squadNumber ?? null}, 'captain_entered'
      )`;
  }

  const row = await loadWithGroup(reg.id);
  return { registration: row, access_token: rawToken, checkout_url: null };
}

function fakeSession(
  regId: string,
  amount: number,
  feePercent?: number,
): Stripe.Checkout.Session {
  return {
    id: "cs_test_" + regId.slice(0, 8),
    payment_intent: "pi_test_" + regId.slice(0, 8),
    payment_status: "paid",
    amount_total: amount,
    // The session carries the rate it was billed at, exactly as
    // createRegistrationCheckout stamps it (V312).
    metadata: {
      kind: "registration",
      registration_id: regId,
      ...(feePercent === undefined ? {} : { fee_percent: String(feePercent) }),
    },
  } as unknown as Stripe.Checkout.Session;
}

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
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

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

  // "eligibility gate: U16 rejects an adult; a minor needs guardian consent"
  // DELETED (RS001 demolition): the whole test drove
  // `submitRegistration`'s own eligibility-gate enforcement at submit time —
  // no surviving usecase performs that check. `eligibilityIssues` (the pure
  // rule function it called) keeps its own coverage above, unchanged
  // ("age & eligibility (pure, doc 06 §2)"). RS002/RS003 own re-testing the
  // gate against the new submit flow.

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

    const csv = await exportRegistrationsCsv(owner, division.id);
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

    await expect(withdrawRegistrationByRef(ref, "rg_wrong-token")).rejects.toThrow(/not found/);
    const still = await loadWithGroup(registration.id);
    expect(still.status).toBe("pending");

    const view = await withdrawRegistrationByRef(ref, access_token);
    expect(view.status).toBe("withdrawn");
  });

  // ── Youth privacy (v3/11 gap 8, PROMPT-34) ──

  it("U16 eligibility auto-sets divisions.youth; /r/[ref] masks the name to first-initial", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner, {
      eligibility: [
        {
          kind: "age",
          maxAgeAt: 15,
          cutoff: { month: 9, day: 1, yearOf: "season_start" },
        },
      ],
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

const SETTINGS_BASE = {
  enabled: true,
  entrant_kind: "individual" as const,
  opens_at: null,
  closes_at: null,
  capacity: null,
  currency: "gbp",
  refund_lock_at: null,
  form_fields: [],
};

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

async function stripeRig(opts: { capacity?: number | null; feeCents?: number } = {}) {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  await sql`update organizations
            set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
            where id = ${orgId}`;
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    payment_method: "stripe",
    fee_cents: opts.feeCents ?? 500,
    capacity: opts.capacity ?? null,
  });
  return { orgId, orgSlug, ownerId, owner, competition, division, settings };
}

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
  it("a failed checkout mint leaves the registration and its cart untouched", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings);
    stripeMock.checkoutCreate.mockRejectedValueOnce(new Error("stripe down"));

    await expect(
      resumeRegistrationCheckout(res.registration.id, res.access_token, "http://test.local"),
    ).rejects.toThrow("stripe down");

    const after = await loadWithGroup(res.registration.id);
    expect(after).toBeTruthy(); // row not deleted
    expect(after.status).toBe("pending"); // not flipped to a terminal status
    expect(after.checkout_session_id).toBeNull(); // no half-written mint
    expect(after.amount_cents).toBe(res.registration.amount_cents);
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
    // due row platform-wide, and each carries metadata.registration_id.
    const checkoutsFor = (id: string) =>
      stripeMock.checkoutCreate.mock.calls.filter(
        ([args]) => (args as { metadata?: { registration_id?: string } })
          ?.metadata?.registration_id === id,
      ).length;
    const regRow = (id: string) => loadWithGroup(id);
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
    expect((await regRow(a.registration.id)).reminded_at).toBeNull();
    stripeMock.checkoutCreate.mockClear();
    const first = await sweepRegistrations("http://test.local");
    expect(first.reminded).toBeGreaterThanOrEqual(1); // A is among the reminded
    const remindedAt = (await regRow(a.registration.id)).reminded_at;
    expect(remindedAt).not.toBeNull();
    expect(checkoutsFor(a.registration.id)).toBe(1); // fresh session for the email

    // reminded_at guard: a second sweep must not re-remind A.
    await sweepRegistrations("http://test.local");
    expect((await regRow(a.registration.id)).reminded_at).toEqual(remindedAt);
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

  it("reconciles by session from /r/[ref] (token-free return)", async () => {
    const { competition, division, settings } = await stripeRig();
    const res = await seedRegistration(competition.id, division.id, settings, {
      refCode: generateRefCode(),
    });
    const ref = res.registration.ref_code as string;
    const session = fakeSession(res.registration.id, 500);

    // Mismatched session (different registration) → no-op.
    stripeMock.checkoutRetrieve.mockResolvedValueOnce({
      ...session,
      metadata: { kind: "registration", registration_id: randomUUID() },
    });
    expect(await reconcileRegistrationBySession(ref, session.id)).toBe(false);

    stripeMock.checkoutRetrieve.mockResolvedValueOnce(session);
    expect(await reconcileRegistrationBySession(ref, session.id)).toBe(true);
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
// RS002 (V367): entry-level refunds — the three cart-level-money hazards
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
    // refundRegistration writes the ENTRY's own refunded_cents (V367), not
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

// describe("per-registrant email locale (cycle 47)") DELETED (RS001
// demolition): both tests pinned submitRegistration's own
// locale-resolution branch — an explicit registrant pick vs falling back to
// the org's default_locale — a decision made INSIDE the deleted function
// with no surviving equivalent to seed against (a seed would just assert
// back whatever locale it was told to insert, which is vacuous). RS002/RS003
// own re-testing locale resolution against the new group-shaped submit flow.
