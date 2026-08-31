// RS002 W5 — approval transitions (approve/reject/withdraw/promote) + the two
// read models (groupByRef, listRegistrations cross-division filters) built on
// top of them. Design: docs/superpowers/specs/2026-08-16-registration-redesign-design.md
// §3/§4, owner ruling 6. Real Postgres required; skipped without DATABASE_URL.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Stripe mock — same shape as registrations.test.ts's own (not shared
// cross-file; each test file mocks its own module graph). Only `refunds.create`
// is exercised here (rejectRegistration's refund-on-reject path, whole-branch
// review MAJOR), but the full shape is mirrored for consistency/future reuse.
const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const refundCreate = vi.fn();
  return {
    checkoutCreate,
    refundCreate,
    stripe: {
      checkout: { sessions: { create: checkoutCreate } },
      refunds: { create: refundCreate },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// RS006 follow-up: observe the staff refund-failed alert without touching
// the rest of the email module (send() is a no-op without RESEND_API_KEY
// either way, same reasoning as registrations.test.ts's own emailMock).
const emailMock = vi.hoisted(() => ({
  registrationRefundFailedAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendRegistrationRefundFailedAlertEmail: emailMock.registrationRefundFailedAlert,
  };
});

// RS008: inviteUnclaimedMembers is a fire-and-forget, post-commit side
// effect — mocked so approveRegistration's WIRING (does it call this, with
// the right args) is deterministic and provable without racing a detached
// promise. Everything else from "../registrations" (materialise via
// registration-approval.ts, promoteWaitlistedRow imported directly below,
// etc.) stays REAL via importOriginal.
const inviteSweepMock = vi.hoisted(() => ({ fn: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../registrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registrations")>();
  return {
    ...actual,
    inviteUnclaimedMembers: (...args: Parameters<typeof actual.inviteUnclaimedMembers>) =>
      inviteSweepMock.fn(...args),
  };
});

import { sql, statementCount } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { seedRegistration } from "@/server/usecases/__tests__/_registration-fixtures";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { generateRefCode } from "@/lib/ref-code";
import { submitRegistrationGroup } from "../registration-submit";
import {
  approveRegistration,
  rejectRegistration,
  withdrawRegistration,
  promoteFromWaitlist,
  loadApprovalSettings,
} from "../registration-approval";
import {
  listRegistrations,
  groupByRef,
  promoteWaitlistedRow,
  getRegistrationSettings,
  refundRegistration,
} from "../registrations";
const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset().mockResolvedValue({
    id: "cs_test_" + randomUUID().slice(0, 8),
    url: "https://checkout.stripe.test/session",
  });
  stripeMock.refundCreate.mockReset().mockResolvedValue({ id: "re_test_1" });
  emailMock.registrationRefundFailedAlert.mockClear();
  inviteSweepMock.fn.mockClear();
});

// ---------------------------------------------------------------------------
// Fixtures — same shape as registration-submit.test.ts's own (not shared
// cross-file on purpose: importing another *.test.ts file re-runs its
// top-level `describe` blocks — see registration-submit.test.ts's own note).
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
  const orgSlug = "appr-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Approval Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  if (plan !== "community") {
    const { setOrgPlan } = await import("@/lib/__tests__/_billing-group");
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
  opts: { startsOn?: string } = {},
): Promise<{ competition: { id: string; slug: string }; division: { id: string; slug: string } }> {
  const competition = await createCompetition(owner, {
    name: "Approval Cup " + randomUUID().slice(0, 6),
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
  });
  return { competition, division };
}

async function addDivision(owner: AuthCtx, competitionId: string, name: string): Promise<{ id: string; slug: string }> {
  return createDivision(owner, competitionId, {
    name,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
}

/** `registration_settings` needs `approval`/`allow_free_agents` (V364) that
 *  `putRegistrationSettings` does not yet write — same established fixture
 *  pattern as registration-submit.test.ts's `seedSettings`. */
async function seedSettings(
  divisionId: string,
  over: Partial<{
    enabled: boolean;
    entrant_kind: "team" | "individual" | "pair";
    fee_cents: number;
    capacity: number | null;
    payment_method: "offline" | "stripe";
    approval: "auto" | "manual";
    allow_free_agents: boolean;
  }> = {},
): Promise<void> {
  await sql`
    insert into registration_settings
      (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method,
       approval, allow_free_agents)
    values (
      ${divisionId}, ${over.enabled ?? true}, ${over.entrant_kind ?? "individual"},
      ${over.fee_cents ?? 0}, ${over.capacity ?? null}, ${over.payment_method ?? "offline"},
      ${over.approval ?? "auto"}, ${over.allow_free_agents ?? false}
    )
    on conflict (division_id) do update set
      enabled = excluded.enabled, entrant_kind = excluded.entrant_kind,
      fee_cents = excluded.fee_cents, capacity = excluded.capacity,
      payment_method = excluded.payment_method, approval = excluded.approval,
      allow_free_agents = excluded.allow_free_agents`;
}

function baseContact(over: Partial<{ name: string; email: string }> = {}) {
  return { name: "Alex Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local`, ...over };
}

async function auditCount(type: string, regId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from competition_events
    where type = ${type} and payload->>'registration_id' = ${regId}`;
  return rows[0]!.n;
}

// ---------------------------------------------------------------------------
// loadApprovalSettings (finding 5)
// ---------------------------------------------------------------------------

// ApprovalSettingsRow is a bare alias of RegistrationSettingsRow, which
// REQUIRES allow_free_agents — but loadApprovalSettings's own hand-written
// SELECT omitted the column, so the field was typed `boolean` and was
// actually `undefined` at runtime, silently reaching
// promoteOldestWaitlisted/promoteWaitlistedRow that way.
describe.skipIf(!HAS_DB)("loadApprovalSettings", () => {
  it("the loaded row carries allow_free_agents, not undefined", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", allow_free_agents: true });

    const row = await sql.begin((tx) => loadApprovalSettings(tx, division.id));
    expect(row?.allow_free_agents).toBe(true);
  });

  it("also carries allow_free_agents: false accurately (not just truthy coverage)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", allow_free_agents: false });

    const row = await sql.begin((tx) => loadApprovalSettings(tx, division.id));
    expect(row?.allow_free_agents).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// approveRegistration / rejectRegistration
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("approveRegistration", () => {
  it("manual division holds pending even when free+capacity ok; approve confirms, materialises, and is idempotent", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "manual" });

    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Waits For Review" }], answers: {} },
        ],
      },
    );
    const regId = submitted.entries[0]!.registration_id;
    expect(submitted.entries[0]!.status).toBe("pending"); // manual mode: no submit-time shortcut

    const approved = await approveRegistration(owner, regId);
    expect(approved.status).toBe("confirmed");
    expect(approved.entrant_id).not.toBeNull();
    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${approved.entrant_id}`;
    expect(members.length).toBe(1);

    // Idempotent: calling twice is a no-op, not a second materialise/audit.
    const approvedAgain = await approveRegistration(owner, regId);
    expect(approvedAgain.entrant_id).toBe(approved.entrant_id);
    expect(await auditCount("registration.approved", regId)).toBe(1);
  });

  // RS008 — materialise() convergence point, via approveRegistration: fires
  // the post-commit claim-invite sweep for the entrant it just materialised.
  it("RS008: fires the claim-invite sweep after materialising, post-commit", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "manual" });
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Approval Sweep" }], answers: {} },
        ],
      },
    );
    const regId = submitted.entries[0]!.registration_id;

    const approved = await approveRegistration(owner, regId);

    expect(inviteSweepMock.fn).toHaveBeenCalledTimes(1);
    expect(inviteSweepMock.fn).toHaveBeenCalledWith(orgId, approved.entrant_id);
  });

  it("rejected is terminal: approve after reject fails; reject-after-reject is idempotent, not a second transition", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "manual" });
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "To Reject" }], answers: {} }],
      },
    );
    const regId = submitted.entries[0]!.registration_id;

    const rejected = await rejectRegistration(owner, regId);
    expect(rejected.status).toBe("rejected");

    await expect(approveRegistration(owner, regId)).rejects.toMatchObject({ status: 422 });

    const rejectedAgain = await rejectRegistration(owner, regId);
    expect(rejectedAgain.status).toBe("rejected");
    expect(await auditCount("registration.rejected", regId)).toBe(1); // not a second transition
  });

  it("approve/reject on an auto-approval division is refused", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // This test is about APPROVE/REJECT being refused on an auto division; it
    // just needs some row sitting at 'pending' there. It used a free_agent
    // entry as the cheapest vehicle, because "a free_agent entry never
    // auto-materialises regardless of approval mode" meant it reached
    // 'pending' under 'auto' with no live Stripe/Connect fixture.
    //
    // RS009 removed that vehicle: a solo sign-up now auto-confirms like any
    // other free entry (the old exclusion stranded them at 'pending'
    // forever and hid the Assign control from them). The vehicle changes,
    // the test's subject does not — an UNPAID entry on an offline division
    // reaches 'pending' under 'auto' just as cheaply, since the inline
    // auto-confirm requires `feeCents === 0`.
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 500, approval: "auto" });
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "individual",
            players: [{ full_name: "Owes A Fee" }],
            answers: {},
          },
        ],
      },
    );
    const regId = submitted.entries[0]!.registration_id;
    expect(submitted.entries[0]!.status).toBe("pending");

    await expect(approveRegistration(owner, regId)).rejects.toMatchObject({ status: 422 });
    await expect(rejectRegistration(owner, regId)).rejects.toMatchObject({ status: 422 });
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${regId}`;
    expect(row!.status).toBe("pending"); // neither call mutated anything
  });

  it("rejecting a pending entry frees the spot and promotes the oldest waitlisted one", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "manual", capacity: 1 });

    const first = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Takes The Slot" }], answers: {} }],
      },
    );
    const second = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Waits Behind" }], answers: {} }],
      },
    );
    expect(first.entries[0]!.status).toBe("pending");
    expect(second.entries[0]!.status).toBe("waitlisted");

    await rejectRegistration(owner, first.entries[0]!.registration_id);
    const [promoted] = await sql<{ status: string }[]>`
      select status from registrations where id = ${second.entries[0]!.registration_id}`;
    expect(promoted!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// RS002 W5 whole-branch review MAJOR: ruling B (registrations.ts,
// confirmPaidRegistration) can leave a Stripe-paid manual-approval entry at
// exactly 'paid' awaiting review. Before this, that state could be approved
// but never declined.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("reject/approve on a paid-awaiting-approval entry", () => {
  it("rejectRegistration accepts a paid manual-approval entry and refunds it in the process", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, {
      entrant_kind: "individual", fee_cents: 1000, payment_method: "stripe", approval: "manual",
    });
    // Connect must be live or submitRegistrationGroup 503s on a stripe-fee
    // division (W4 guard) — this fixture is about the paid-awaiting-approval
    // state, not about Connect readiness.
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Paid Reviewee" }], answers: {} }],
      },
    );
    const regId = submitted.entries[0]!.registration_id;
    // Simulate the payment having landed (ruling B: manual mode leaves this
    // at 'paid' via confirmPaidRegistration's own manual-mode gate) without
    // re-deriving the whole webhook path here.
    await sql`update registrations set status = 'paid' where id = ${regId}`;
    await sql`update registration_groups set payment_intent_id = 'pi_test_fake' where id = ${submitted.group_id}`;

    const rejected = await rejectRegistration(owner, regId);
    expect(rejected.status).toBe("rejected");
    // Reverting rejectRegistration's status check back to 'pending'-only
    // makes this fail: 422, no refund attempted.
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    const [row] = await sql<{ refunded_cents: number }[]>`
      select refunded_cents from registrations where id = ${regId}`;
    expect(row!.refunded_cents).toBe(1000);
  });

  it("RS006: rejectRegistration alerts staff when the refund FAILS, but the reject still succeeds", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, {
      entrant_kind: "individual", fee_cents: 1000, payment_method: "stripe", approval: "manual",
    });
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Paid Reviewee" }], answers: {} }],
      },
    );
    const regId = submitted.entries[0]!.registration_id;
    await sql`update registrations set status = 'paid' where id = ${regId}`;
    await sql`update registration_groups set payment_intent_id = 'pi_test_fake' where id = ${submitted.group_id}`;
    const [groupRow] = await sql<{ currency: string }[]>`
      select currency from registration_groups where id = ${submitted.group_id}`;

    stripeMock.refundCreate.mockRejectedValueOnce(new Error("connected account restricted"));
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    try {
      const rejected = await rejectRegistration(owner, regId);
      // Same fail-open contract as withdrawCore (rejectRegistration's own
      // comment above the catch): the refund failure must not undo reject.
      expect(rejected.status).toBe("rejected");

      expect(emailMock.registrationRefundFailedAlert).toHaveBeenCalledTimes(1);
      const args = emailMock.registrationRefundFailedAlert.mock.calls[0]![0];
      expect(args.to).toBe("ops@seazn.test");
      expect(args.registrationId).toBe(regId);
      expect(args.orgId).toBe(orgId);
      expect(args.competitionId).toBe(competition.id);
      expect(args.amountCents).toBe(1000);
      expect(args.currency).toBe(groupRow!.currency);
      expect(args.paymentIntentId).toBe("pi_test_fake");
      expect(args.reason).toBe("connected account restricted");

      const [row] = await sql<{ refunded_cents: number }[]>`
        select refunded_cents from registrations where id = ${regId}`;
      expect(row!.refunded_cents).toBe(0); // the refund really never landed
    } finally {
      delete process.env.STAFF_ALERT_EMAIL;
    }
  });

  it("approveRegistration refuses an already-refunded registration", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, {
      entrant_kind: "individual", fee_cents: 1000, payment_method: "stripe", approval: "manual",
    });
    // Connect must be live or submitRegistrationGroup 503s on a stripe-fee
    // division (W4 guard) — this fixture is about the paid-awaiting-approval
    // state, not about Connect readiness.
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Refunded Then Approved?" }], answers: {} }],
      },
    );
    const regId = submitted.entries[0]!.registration_id;
    await sql`update registrations set status = 'paid' where id = ${regId}`;
    await sql`update registration_groups set payment_intent_id = 'pi_test_fake2' where id = ${submitted.group_id}`;

    // An organiser refunds it via the normal refund flow — which does NOT
    // itself change `status` (registrations.ts's refundRegistration).
    await refundRegistration(owner, regId, undefined);
    const [refunded] = await sql<{ status: string; refunded_cents: number }[]>`
      select status, refunded_cents from registrations where id = ${regId}`;
    expect(refunded!.status).toBe("paid"); // unchanged by refundRegistration itself
    expect(refunded!.refunded_cents).toBe(1000);

    let err: HttpError | undefined;
    try {
      await approveRegistration(owner, regId);
    } catch (e) {
      err = e as HttpError;
    }
    // Reverting approveRegistration's refunded_cents guard makes this fail:
    // the already-refunded row would approve and materialise a free
    // entrant for money that had already gone back.
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(422);
    const [row] = await sql<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where id = ${regId}`;
    expect(row!.status).toBe("paid");
    expect(row!.entrant_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withdrawRegistration (RS002 W5 wiring over the existing withdraw core)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("withdrawRegistration", () => {
  it("withdraws via the approval-transitions module and is idempotent", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "auto" });
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Leaving Soon" }], answers: {} }],
      },
    );
    const regId = submitted.entries[0]!.registration_id;

    const withdrawn = await withdrawRegistration(owner, regId);
    expect(withdrawn.status).toBe("withdrawn");
    const again = await withdrawRegistration(owner, regId);
    expect(again.status).toBe("withdrawn"); // no throw, no double write
  });
});

// ---------------------------------------------------------------------------
// promoteFromWaitlist
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("promoteFromWaitlist", () => {
  it("oldest-first by default; an explicit id overrides the pick and is itself idempotent", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // manual approval: "slot" stays 'pending' rather than auto-confirming, so
    // the capacity math below is unambiguous about why it still counts.
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, capacity: 1, approval: "manual" });

    const slot = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Fills Slot" }], answers: {} }] },
    );
    const older = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Older Waiter" }], answers: {} }] },
    );
    const newer = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Newer Waiter" }], answers: {} }] },
    );
    expect(slot.entries[0]!.status).toBe("pending");
    expect(older.entries[0]!.status).toBe("waitlisted");
    expect(newer.entries[0]!.status).toBe("waitlisted");

    // Explicit-id override picks the NEWER one, skipping the oldest-first pick.
    const promotedNewer = await promoteFromWaitlist(owner, division.id, {
      registrationId: newer.entries[0]!.registration_id,
    });
    expect(promotedNewer!.id).toBe(newer.entries[0]!.registration_id);
    const [olderStillWaiting] = await sql<{ status: string }[]>`
      select status from registrations where id = ${older.entries[0]!.registration_id}`;
    expect(olderStillWaiting!.status).toBe("waitlisted"); // untouched by the override

    // Idempotent: promoting the SAME (already-promoted) id again is a no-op,
    // not an error and not a second promotion event.
    const replay = await promoteFromWaitlist(owner, division.id, {
      registrationId: newer.entries[0]!.registration_id,
    });
    expect(replay!.status).toBe("pending");
    expect(await auditCount("registration.promoted", newer.entries[0]!.registration_id)).toBe(1);

    // Oldest-first (no explicit id) now promotes the one entry still waiting.
    const promotedOldest = await promoteFromWaitlist(owner, division.id);
    expect(promotedOldest!.id).toBe(older.entries[0]!.registration_id);

    // Nothing left waitlisted: oldest-first is a safe no-op, not an error.
    expect(await promoteFromWaitlist(owner, division.id)).toBeNull();
  });

  it("promoting into a paid stripe division sets a fresh pay-by expires_at and snapshots the fee", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, {
      entrant_kind: "individual", fee_cents: 1500, payment_method: "stripe", capacity: 1,
    });

    await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Fills Slot" }], answers: {} }] },
    );
    const waiting = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Waiting Payer" }], answers: {} }] },
    );
    expect(waiting.entries[0]!.status).toBe("waitlisted");
    expect(waiting.entries[0]!.amount_cents).toBe(0); // never charged while waitlisted

    const promoted = await promoteFromWaitlist(owner, division.id, {
      registrationId: waiting.entries[0]!.registration_id,
    });
    expect(promoted!.status).toBe("pending");
    expect(promoted!.amount_cents).toBe(1500); // fee snapshot applied on promotion
    const [group] = await sql<{ payment_method: string | null; expires_at: Date | null }[]>`
      select payment_method, expires_at from registration_groups where id = ${promoted!.group_id}`;
    expect(group!.payment_method).toBe("stripe");
    expect(group!.expires_at).not.toBeNull();
  });

  it("ROUTED MAJOR (wave 4 -> wave 5): promoting a waitlisted entry must not clobber a pending sibling's payment_method/expires_at", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const { competition, division: divA } = await rig(owner);
    const divB = await addDivision(owner, competition.id, "Side Division");
    await seedSettings(divA.id, { entrant_kind: "individual", fee_cents: 1000, payment_method: "stripe", capacity: null });
    await seedSettings(divB.id, { entrant_kind: "individual", fee_cents: 0, payment_method: "offline", capacity: 1 });

    // Fill divB's one slot from a DIFFERENT cart so this test's own divB
    // entry, in the SAME cart as divA's, is born waitlisted.
    await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: divB.id, entrant_kind: "individual", players: [{ full_name: "Filler" }], answers: {} }] },
    );

    const cart = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: divA.id, entrant_kind: "individual", players: [{ full_name: "Card Payer" }], answers: {} },
          { division_id: divB.id, entrant_kind: "individual", players: [{ full_name: "Waitlisted Sibling" }], answers: {} },
        ],
      },
    );
    const entryA = cart.entries.find((e) => e.division_id === divA.id)!;
    const entryB = cart.entries.find((e) => e.division_id === divB.id)!;
    expect(entryA.status).toBe("pending");
    expect(entryB.status).toBe("waitlisted");

    const [before] = await sql<{ payment_method: string | null; expires_at: Date | null }[]>`
      select payment_method, expires_at from registration_groups where id = ${cart.group_id}`;
    expect(before!.payment_method).toBe("stripe");
    expect(before!.expires_at).not.toBeNull();

    await promoteFromWaitlist(owner, divB.id, { registrationId: entryB.registration_id });

    const [after] = await sql<{ payment_method: string | null; expires_at: Date | null }[]>`
      select payment_method, expires_at from registration_groups where id = ${cart.group_id}`;
    // The clobber this wave fixed: the OLD code would set payment_method to
    // divB's own 'offline' and null out expires_at entirely (divB's fee is 0,
    // so stripeWindow was false) — wiping divA's live Stripe deadline.
    expect(after!.payment_method).toBe("stripe");
    expect(after!.expires_at).not.toBeNull();
    expect(new Date(after!.expires_at!).getTime()).toBe(new Date(before!.expires_at!).getTime());

    const [entryARow] = await sql<{ status: string; amount_cents: number }[]>`
      select status, amount_cents from registrations where id = ${entryA.registration_id}`;
    expect(entryARow!.status).toBe("pending");
    expect(entryARow!.amount_cents).toBe(1000); // divA's own entry fee, untouched

    const [entryBRow] = await sql<{ status: string }[]>`
      select status from registrations where id = ${entryB.registration_id}`;
    expect(entryBRow!.status).toBe("pending"); // divB's own promotion DID take effect
  });

  it("MAJOR (review): a card-fee promotion into a cart whose envelope is offline still gets a real, monotonic expires_at — never inherits null", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division: divA } = await rig(owner);
    const divB = await addDivision(owner, competition.id, "Later Priced Division");
    await seedSettings(divA.id, { entrant_kind: "individual", fee_cents: 500, payment_method: "offline", capacity: null });
    await seedSettings(divB.id, { entrant_kind: "individual", fee_cents: 0, payment_method: "offline", capacity: 1 });

    // Fill divB's one slot from a DIFFERENT cart so this cart's own divB
    // entry is born waitlisted.
    await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: divB.id, entrant_kind: "individual", players: [{ full_name: "Filler" }], answers: {} }] },
    );

    const cart = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: divA.id, entrant_kind: "individual", players: [{ full_name: "Offline Payer" }], answers: {} },
          { division_id: divB.id, entrant_kind: "individual", players: [{ full_name: "Future Card Payer" }], answers: {} },
        ],
      },
    );
    const entryA = cart.entries.find((e) => e.division_id === divA.id)!;
    const entryB = cart.entries.find((e) => e.division_id === divB.id)!;
    expect(entryA.status).toBe("pending");
    expect(entryB.status).toBe("waitlisted");

    const [beforeGroup] = await sql<{ payment_method: string | null; expires_at: Date | null }[]>`
      select payment_method, expires_at from registration_groups where id = ${cart.group_id}`;
    expect(beforeGroup!.payment_method).toBe("offline");
    expect(beforeGroup!.expires_at).toBeNull();

    // The organiser raises divB's price and switches it to card AFTER this
    // cart was submitted — wave 4's uniform-at-submit invariant only binds
    // at submit time; this is the residual gap it does not close.
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    await sql`update registration_settings set fee_cents = 1000, payment_method = 'stripe' where division_id = ${divB.id}`;

    const promoted = await promoteFromWaitlist(owner, divB.id, { registrationId: entryB.registration_id });
    expect(promoted!.status).toBe("pending");
    expect(promoted!.amount_cents).toBe(1000);

    const [afterGroup] = await sql<{ payment_method: string | null; expires_at: Date | null }[]>`
      select payment_method, expires_at from registration_groups where id = ${cart.group_id}`;
    // payment_method: the not-exists guard still protects entryA (still
    // 'pending') — stays 'offline'. Not this fix's concern.
    expect(afterGroup!.payment_method).toBe("offline");
    // expires_at: MUST be real now — this IS the fix. The pre-review
    // conditional write left this null forever whenever the group's
    // existing envelope belonged to a still-pending offline sibling, and
    // sweepRegistrations' `expires_at is not null` overdue filter would
    // never find it — a permanently unpayable, permanently un-expirable
    // promotion.
    expect(afterGroup!.expires_at).not.toBeNull();
    expect(new Date(afterGroup!.expires_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it("MAJOR (review): the group-envelope guard and write are ONE atomic statement, not a separate SELECT-then-UPDATE", async () => {
    // Deterministic proof (not a timing-dependent race): the old code issued
    // a SEPARATE `select count(*) as pendingSiblings ...` before its
    // conditional `update registration_groups` — a real window where two
    // concurrent promotions could each read "no pending sibling" before
    // either committed. Counting statements via statementCount() (lib/db.ts
    // — every query the postgres client sends increments it) proves the
    // fixed code issues no such separate SELECT: promoteWaitlistedRow's own
    // work is exactly THREE statements — the registrations UPDATE, the
    // registration_groups UPDATE (guard folded into its CASE/not-exists,
    // never a preceding SELECT), and the final re-select. A reverted guard
    // (back to SELECT-then-conditionally-UPDATE) makes this fail: FOUR.
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 1000, payment_method: "stripe", capacity: 1 });

    await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Fills Slot" }], answers: {} }] },
    );
    const waiting = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Waits" }], answers: {} }] },
    );
    const entry = waiting.entries[0]!;
    expect(entry.status).toBe("waitlisted");

    const settings = await getRegistrationSettings(owner, division.id);

    // Baseline: an UNGUARDED update to the exact same row, inside the exact
    // same sql.begin wrapper, measures ONLY the framework's own BEGIN/COMMIT
    // overhead — whatever it is, it cancels out of the comparison below.
    const baselineBefore = statementCount();
    await sql.begin(async (tx) => {
      await tx`update registration_groups set updated_at = now() where id = ${waiting.group_id}`;
    });
    const frameworkOverhead = statementCount() - baselineBefore - 1; // the 1 update itself

    const before = statementCount();
    await sql.begin(async (tx) => {
      await promoteWaitlistedRow(tx, entry.registration_id, waiting.group_id, settings);
    });
    const issued = statementCount() - before - frameworkOverhead;

    // promoteWaitlistedRow's OWN work, with the framework's constant
    // BEGIN/COMMIT overhead subtracted out: the registrations UPDATE, the
    // registration_groups UPDATE (guard folded into its CASE/not-exists —
    // never a preceding SELECT), and the final re-select. A reverted guard
    // (back to a separate `select count(*) as pendingSiblings ...` before a
    // conditional UPDATE) makes this fail: 4, not 3.
    expect(issued).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// groupByRef
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("groupByRef", () => {
  it("returns entries + players + per-entry status; a wrong token is refused identically to a nonexistent ref", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });
    const cart = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact({ name: "Cart Owner" }),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Solo Player" }], answers: {} }],
      },
    );
    expect(cart.ref_code).not.toBeNull();

    const view = await groupByRef(cart.ref_code!, cart.access_token);
    expect(view.ref_code).toBe(cart.ref_code);
    expect(view.contact_name).toBe("Cart Owner");
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]!.status).toBe(cart.entries[0]!.status);
    expect(view.entries[0]!.division_id).toBe(division.id);
    expect(view.entries[0]!.players.map((p) => p.full_name)).toEqual(["Solo Player"]);
    expect(view.entries[0]!.players[0]!.consent_status).toBe("pending");

    // Wrong token on a REAL ref, and a syntactically-valid ref that does not
    // exist, must be indistinguishable: same status, same message.
    let wrongTokenErr: HttpError | undefined;
    try {
      await groupByRef(cart.ref_code!, "rg_" + randomUUID().replace(/-/g, ""));
    } catch (e) {
      wrongTokenErr = e as HttpError;
    }
    let noRefErr: HttpError | undefined;
    try {
      await groupByRef(generateRefCode(), cart.access_token);
    } catch (e) {
      noRefErr = e as HttpError;
    }
    expect(wrongTokenErr).toBeInstanceOf(HttpError);
    expect(noRefErr).toBeInstanceOf(HttpError);
    expect(wrongTokenErr!.status).toBe(404);
    expect(noRefErr!.status).toBe(404);
    expect(wrongTokenErr!.message).toBe(noRefErr!.message);
  });

  it("shows every entry in a multi-entry cart, each with its own players", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division: divA } = await rig(owner);
    const divB = await addDivision(owner, competition.id, "Second Division");
    await seedSettings(divA.id, { entrant_kind: "individual", fee_cents: 0 });
    await seedSettings(divB.id, { entrant_kind: "individual", fee_cents: 0 });
    const cart = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: divA.id, entrant_kind: "individual", players: [{ full_name: "Player A" }], answers: {} },
          { division_id: divB.id, entrant_kind: "individual", players: [{ full_name: "Player B" }], answers: {} },
        ],
      },
    );
    const view = await groupByRef(cart.ref_code!, cart.access_token);
    expect(view.entries).toHaveLength(2);
    expect(view.entries.map((e) => e.division_id).sort()).toEqual([divA.id, divB.id].sort());
    const names = view.entries.flatMap((e) => e.players.map((p) => p.full_name));
    expect(names.sort()).toEqual(["Player A", "Player B"]);
  });
});

// ---------------------------------------------------------------------------
// listRegistrations cross-division filters
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("listRegistrations cross-division filters", () => {
  it("filters by division: competition-wide includes both, division-scoped excludes the other", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division: divA } = await rig(owner);
    const divB = await addDivision(owner, competition.id, "Div B");
    await seedSettings(divA.id, { entrant_kind: "individual", fee_cents: 0 });
    await seedSettings(divB.id, { entrant_kind: "individual", fee_cents: 0 });
    const a = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: divA.id, entrant_kind: "individual", players: [{ full_name: "In A" }], answers: {} }] },
    );
    const b = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: divB.id, entrant_kind: "individual", players: [{ full_name: "In B" }], answers: {} }] },
    );

    const wide = await listRegistrations(owner, null, null, { competition_id: competition.id });
    const wideIds = wide.map((r) => r.id);
    expect(wideIds).toContain(a.entries[0]!.registration_id);
    expect(wideIds).toContain(b.entries[0]!.registration_id);

    const scoped = await listRegistrations(owner, divA.id, null);
    const scopedIds = scoped.map((r) => r.id);
    expect(scopedIds).toContain(a.entries[0]!.registration_id);
    expect(scopedIds).not.toContain(b.entries[0]!.registration_id);
  });

  it("filters by status", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "auto", capacity: 1 });
    const confirmed = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Confirmed One" }], answers: {} }] },
    );
    const waitlisted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Waitlisted One" }], answers: {} }] },
    );
    expect(confirmed.entries[0]!.status).toBe("confirmed");
    expect(waitlisted.entries[0]!.status).toBe("waitlisted");

    const rows = await listRegistrations(owner, division.id, "waitlisted");
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(waitlisted.entries[0]!.registration_id);
    expect(ids).not.toContain(confirmed.entries[0]!.registration_id);
  });

  it("filters by kind (entrant_kind) — meaningful once a call spans more than one division", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division: individualDiv } = await rig(owner);
    const teamDiv = await addDivision(owner, competition.id, "Teams Division");
    await seedSettings(individualDiv.id, { entrant_kind: "individual", fee_cents: 0 });
    await seedSettings(teamDiv.id, { entrant_kind: "team", fee_cents: 0 });
    const solo = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: individualDiv.id, entrant_kind: "individual", players: [{ full_name: "Solo" }], answers: {} }] },
    );
    const team = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: teamDiv.id, entrant_kind: "team", team_name: "The Team", players: [{ full_name: "Teammate" }], answers: {} }] },
    );

    const teams = await listRegistrations(owner, null, null, { competition_id: competition.id, kind: "team" });
    const teamIds = teams.map((r) => r.id);
    expect(teamIds).toContain(team.entries[0]!.registration_id);
    expect(teamIds).not.toContain(solo.entries[0]!.registration_id);
  });

  it("filters by free_agent", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0, allow_free_agents: true });
    const freeAgent = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "team", free_agent: true, players: [], answers: {} }] },
    );
    const normalTeam = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "team", team_name: "Full Team", players: [{ full_name: "Member" }], answers: {} }] },
    );

    const rows = await listRegistrations(owner, division.id, null, { free_agent: true });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(freeAgent.entries[0]!.registration_id);
    expect(ids).not.toContain(normalTeam.entries[0]!.registration_id);
  });

  it("filters by consent_pending", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });
    // Self-registering: the sole player row is the CONTACT and gets
    // consent_status='granted' immediately, not 'pending'.
    const grantedEntry = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact({ name: "Self Registrant" }),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "individual",
            registering_self: true,
            players: [{ full_name: "Self Registrant" }],
            answers: {},
          },
        ],
      },
    );
    // Captain-entered, nobody self-registering: consent_status stays 'pending'.
    const pendingEntry = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Entered By Rep" }], answers: {} }],
      },
    );

    const rows = await listRegistrations(owner, division.id, null, { consent_pending: true });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(pendingEntry.entries[0]!.registration_id);
    expect(ids).not.toContain(grantedEntry.entries[0]!.registration_id);
  });

  it("filters by text search across entry display name and contact", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0 });
    const falcons = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "team", team_name: "The Falcons", players: [{ full_name: "Falcon Player" }], answers: {} }] },
    );
    const comets = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [{ division_id: division.id, entrant_kind: "team", team_name: "The Comets", players: [{ full_name: "Comet Player" }], answers: {} }] },
    );

    const rows = await listRegistrations(owner, division.id, null, { text: "Falcon" });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(falcons.entries[0]!.registration_id);
    expect(ids).not.toContain(comets.entries[0]!.registration_id);
  });
});

describe.skipIf(!HAS_DB)("RS005 review: frozen entitlements block reject and promote, not just approve", () => {
  /** Drive `competitions.max_active` to 0 so every active competition the org
   *  holds is frozen by the downgrade selector (entitlement-freeze.ts) — the
   *  same fixture competition-schedule-ai-route.test.ts uses. */
  async function freezeCompetitions(orgId: string): Promise<void> {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${orgId}, 'competitions.max_active', 0)
      on conflict (org_id, feature_key) do update set int_value = 0`;
    await invalidateOrgEntitlements(orgId);
  }

  async function manualPendingEntry(status: "pending" | "waitlisted") {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "manual" });
    const [reg] = await sql<{ id: string }[]>`
      insert into registrations (org_id, division_id, group_id, display_name, status, amount_cents, answers)
      values (
        ${orgId}, ${division.id},
        (insert_group_placeholder := null),
        'Frozen Case', ${status}, 0, '{}'::jsonb
      ) returning id`;
    return { owner, orgId, division, reg };
  }

  // Only approveRegistration carried the guard. Reject is not the harmless
  // half of the pair — it REFUNDS a paid entry through Stripe and
  // auto-promotes the waitlist — so on a frozen org Approve 402'd while Reject
  // on the same row moved real money. RS005 is what first put both behind HTTP
  // routes and UI buttons, which is what made the gap reachable.
  it("refuses reject on a frozen competition, leaving the entry untouched", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "manual" });
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 0, currency: "gbp", payment_method: "offline" },
      { status: "pending", displayName: "Frozen Reject" },
    );
    await freezeCompetitions(orgId);

    await expect(rejectRegistration(owner, registration.id)).rejects.toMatchObject({ status: 402 });

    const [after] = await sql<{ status: string }[]>`
      select status from registrations where id = ${registration.id}`;
    expect(after!.status, "a refused transition must not have half-run").toBe("pending");
  });

  it("refuses promote on a frozen competition", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "manual" });
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 0, currency: "gbp", payment_method: "offline" },
      { status: "waitlisted", displayName: "Frozen Promote" },
    );
    await freezeCompetitions(orgId);

    await expect(promoteFromWaitlist(owner, division.id, {})).rejects.toMatchObject({ status: 402 });

    const [after] = await sql<{ status: string }[]>`
      select status from registrations where id = ${registration.id}`;
    expect(after!.status).toBe("waitlisted");
  });
});
