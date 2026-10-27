// The kind sweep (phase 3 wave 1, T7): every kind in OUTBOX_KINDS is driven through its REAL producer, and the rows it leaves behind are
// judged against the SPEC's table of what each kind is, not against the code's own declaration (`OUTBOX_KIND_FACTS` is checked against
// the same table by enqueue-once.test.ts; this file is the producer-level half). The harness is `_kind-harness.ts`; this file holds the
// scenarios (one per kind that has moved to the outbox), the spec's lists, and the harness's own tests.
//
//   - magic_link: the route POST of app/api/auth/magic-link/route.ts (the real token minter, the real enqueue, the real `dispatchNow`).
//   - chess_invite: the real `openRound` on a `seedOnlineChessRound` whose player's account is `es` (the real invite renderer, the
//     real account-kind enqueue, the real dispatch). Only `transport.deliver` is replaced: it is the network.
//   - registration_confirmation: the route POST of app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts with an `es`
//     locale cookie (the real submit, `notifySubmitted`, the real enqueue, the dispatch after the response).
//   - registration_promoted: the real `withdrawRegistrationPublic` of the holder of a division's only spot, with an `nl` registrant waiting
//     behind them: the real promotion, `notifyPromoted`, the real once-keyed enqueue, the dispatch after the response.
//   - payment_reminder: the real `sweepRegistrations` (pass 1a) over a stripe cart due for its T-24h reminder, in an `fr` group: the real
//     claim, mint (Stripe is the one mocked network), once-keyed enqueue and stamp. The sweep leaves the first attempt to the worker.
//   - solo_signup_assigned: the real `assignSoloSignUp` of a pooled `fr` solo sign-up onto a team entry: the email is queued in the
//     assignment's own transaction and the request that did it makes the first attempt.
//   - refund_issued: the real `refundRegistration` of a paid `es` registrant (Stripe's refund is mocked): the receipt is queued in the transaction
//     that records the refund, with the refund id as its ref and once-key, and the request that did it makes the first attempt.
//   - registration_dispute_alert: the real `handleRegistrationDispute` (`created`) on a paid card cart whose org owner's account is `fr`: the
//     alert is queued to the owner's account in the transaction that records the dispute, and the worker makes the first attempt.
//   - registration_dispute_lost: the real `handleRegistrationDispute` (`closed`, lost) on a paid card cart whose owner's account has no
//     language, in an `es` org. The dispute names no charge, so the balance recovery is skipped and Stripe is not called; the notice is
//     queued to the owner's account and the worker makes the first attempt.
//   - sponsor_invoice: the real `startSponsorCheckout` of a package in an `fr` org (the Checkout session is the Stripe mock's): the invoice
//     is queued to the sponsor contact after the session is minted, and the request that did it makes the first attempt.
//   - sponsor_receipt: the real `handleSponsorPaymentSucceeded` on a pending order in an `nl` org: the receipt is queued to the sponsor
//     contact in the transaction that activates the placement, and the worker makes the first attempt.
//   - sponsor_refund: the real `refundSponsorOrder` of a paid order in an `es` org (Stripe's refund is mocked): the notice is queued in
//     the transaction that records the refund, at its own savepoint, and the request that did it makes the first attempt.
//   - sponsor_dispute_alert: the real `handleSponsorDispute` (`created`) on a paid sponsor order whose org owner's account is `fr`: the
//     alert is queued to the owner's account in the transaction that flags the order, and the worker makes the first attempt.
//   - sponsor_dispute_won: the real `handleSponsorDispute` (`closed`, won) on a flagged sponsor order whose owner's account has no
//     language, in an `es` org: the notice is queued to the owner's account in the transaction that clears the flag, and the worker
//     makes the first attempt.
//   - sponsor_dispute_lost: the real `handleSponsorDispute` (`closed`, lost) on a paid sponsor order whose owner's account is `nl`. The
//     dispute names no charge, so the balance recovery is skipped and Stripe is not called; the notice is queued to the owner's account
//     after the write-off and the worker makes the first attempt.
//   - pass_revoked: the real `processStripeEvent` (`charge.refunded`, a full refund) on an Event Pass in an org whose owner's account is
//     `nl`: the notice is queued to the owner's account in the transaction that deletes the pass, and the worker makes the first attempt.
//   - trial_ending: the real `processStripeEvent` (`customer.subscription.trial_will_end`) on a no-card trialing billing group whose
//     payer's account is `fr`: the warning is queued to the payer's account, TRANSACTIONAL (the only wave-2 kind that is), with no
//     organisation, and the worker makes the first attempt.
//   - email_verification: the route POST of app/api/admin/users/[id]/resend-verification/route.ts, a staff press for an unverified `fr`
//     account: the token and its row are one transaction on the pool, no organisation, and the request's own deferred attempt sends it.
//     The staff member is signed in through the session stand-in below; `requireStaff` itself is real.
//   - funnel_claim: the route POST of app/api/funnel/start/route.ts, a visitor's start (no account, no organisation, so `en`): the
//     draft and its row are one transaction on the pool, and the request makes the first attempt after commit.
//   - email_change_confirmation: the route POST of app/api/auth/change-email/route.ts by an `es` account (signed in through the session
//     stand-in): the confirmation to the NEW address is queued in the request's transaction, and the request makes the first attempt.
//   - email_change_notice: the same route by another `es` account: the notice to the OLD address, once per request, is queued in the
//     same transaction, and the request makes the first attempt.
//   - account_deletion: the route DELETE of app/api/users/me/route.ts by an `nl` account (signed in through the session stand-in): the
//     notice to the address the account had is queued in the deletion's own transaction, once per account, and the request's own
//     deferred attempt sends it. The harness finds the row by that address before any tick runs, and judges it by id afterwards, so
//     the worker's scrub of an ended notice's address (step 7a) does not hide it.
//   - org_invite: the route POST of app/api/orgs/[id]/invites/route.ts, an email invite by the owner of an `fr` organisation (signed in
//     through the session stand-in): the invite and its row are one transaction on the pool, in the organisation's language, and the
//     request makes the first attempt.
//   - claim_invite: the route POST of app/api/v1/persons/[id]/claim-invites/route.ts, the organiser of an `es` organisation (signed in
//     through the session stand-in) inviting an unclaimed person: the claim and its row are one tenant transaction, in the organisation's
//     language, and the request makes the first attempt. (The registration paths reach the same helper; claim-invite-outbox.test.ts
//     drives two of them.)
//   - official_invite: the route POST of app/api/v1/officials/[id]/invite/route.ts, the organiser of an `nl` organisation (signed in
//     through the session stand-in) inviting an official to claim their profile: the same rail as the claim invite, with the officiating
//     copy, in the organisation's language, and the request makes the first attempt.
//   - official_assigned: the real `patchFixtureOfficials` of an `es` organisation's organiser setting an official (an address, no
//     account) on a fixture by hand: the notice is queued in the assignment's own tenant transaction, in the organisation's language
//     (the official has no account to follow), and the request makes the first attempt.
//   - official_assignment_changed: the real `moveFixture` of a fixture an official (an address, no account) has accepted, in an `nl`
//     organisation: the change notice is queued in the move's own tenant transaction, in the organisation's language, and the request
//     makes the first attempt.
//   - suspension_confirmed: the real `decideSuspension` (confirm) of a pending ban on a player whose claimed account is `es`: the notice
//     is queued to the account in the decision's own tenant transaction, once per confirmation, and the request makes the first attempt.
//   - suspension_served: the real `refreshDiscipline` (the score write's fold) on a decided fixture that serves a confirmed one-match ban,
//     in an `nl` organisation whose player's claimed account has no language: the notice is queued to the account in the transaction
//     that flips the ban, and the worker makes the first attempt (a serving pass may be a read with no request to send from).
//   - match_report_submitted: the real `submitMyReport` of a claimed official's draft, in an organisation whose owner's account is `fr`:
//     the notice is queued to the owner's account in the submit's own transaction, once per member, and the request makes the first
//     attempt.
//   - group_transfer_offer: the real `offerGroupTransfer` of a live billing group to the owner of one of its orgs, whose account is `es`
//     (the SetupIntent is the Stripe mock's): the notice is queued to the recipient's account in the transaction that makes the offer
//     live, with no organisation, and the request makes the first attempt.
//   - group_transfer_complete: the real `offerGroupTransfer` of a community billing group (no live subscription: the immediate path) to
//     the owner of its org, whose account has no language, in an `fr` org: the notice is queued to the recipient's account in the
//     handover's own transaction, with no organisation, and the request makes the first attempt.
//   - group_org_removed: the real `detachOrgFromGroup` by the payer of a paying group, pushing out an org whose owner's account is `fr`
//     (ride-out): the notice is queued to the owner's account in the detach's own transaction, in the detached org, and the request
//     makes the first attempt.
//   - group_org_left: the real `detachOrgFromGroup` by the owner of an org in a paying group (release), whose payer's account has no
//     language and whose remaining org is `nl`: the notice is queued to the payer's account in the detach's own transaction, in the
//     detached org, and the request makes the first attempt.
//
// Each kind task (T8-T12) added its scenario and deleted its entry from NOT_YET_MOVED (in _kind-senders.ts, with its `send*` in
// SENDER_ALLOWLIST and its KIND_DIRECT_SENDER entry); T12 emptied the list. Wave 2's T1 registered its ten kinds before their producers
// moved, each kind task (wave 2, T2-T9) added the scenario and deleted the entry, and T10 closed the list again. Wave 3's T1 registered
// its eight kinds the same way, each kind task (wave 3, T2-T4) added the scenario and deleted the entry, and T4c closed the list again.
// Wave 4's T1 registered its nine kinds the same way: they are in NOT_YET_MOVED until each kind task (wave 4, T2-T4) adds the scenario
// and deletes the entry, and the last move closes the list again. The sweep covers every kind the list does not name. A kind that is
// neither moved nor listed fails by name, and so does a kind that is listed while it has a scenario (a stale entry would skip the
// sweep), and so do the three lists when they disagree.
//
// Sport: not applicable. These emails do not vary by sport (spec, Test strategy 4).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Stripe from "stripe";
import { sql } from "@/lib/db";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.78" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
// Wave 3's account mail comes from signed-in routes (a staff press, an email change). Their scenario sets who is signed in for its own
// `run` only (`signedInAs`); every other producer here runs with nobody signed in, as before (the real `requireUser`, no session).
// `requireOrgRole` reaches the session through the module's own `requireUser`, which this mock cannot replace, so it is stood in for the
// same way: the signed-in account's role in the org is the REAL one (`getOrgRole`), and the route's editor check is applied to it.
const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  type User = Awaited<ReturnType<typeof real.requireUser>>;
  return {
    ...real,
    requireUser: vi.fn(async (): Promise<User> => (session.user as User | null) ?? real.requireUser()),
    requireOrgRole: vi.fn(async (orgId: string, roles: Parameters<typeof real.requireOrgRole>[1]) => {
      if (session.user === null) return real.requireOrgRole(orgId, roles);
      const role = await real.getOrgRole(orgId, session.user.id);
      if (role === null || !roles.includes(role)) throw new Error("sweep: the signed-in account is not an editor of the organisation");
      return { user: session.user as User, role };
    }),
  };
});
// The one network seam. The harness reads this same mock back (it imports `deliver` from the same module).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
// The payment reminder's sweep mints a Checkout session and the refund receipt's refund is a Stripe refund: Stripe is the second network seam.
// The billing-group transfer offer mints a SetupIntent before it queues its notice.
const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const refundCreate = vi.fn();
  const setupIntentCreate = vi.fn();
  return {
    checkoutCreate,
    refundCreate,
    setupIntentCreate,
    stripe: { checkout: { sessions: { create: checkoutCreate } }, refunds: { create: refundCreate }, setupIntents: { create: setupIntentCreate } },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { POST as magicLinkPost } from "@/app/api/auth/magic-link/route";
import { POST as resendVerificationPost } from "@/app/api/admin/users/[id]/resend-verification/route";
import { POST as funnelStartPost } from "@/app/api/funnel/start/route";
import { POST as changeEmailPost } from "@/app/api/auth/change-email/route";
import { DELETE as deleteAccount } from "@/app/api/users/me/route";
import { POST as orgInvitePost } from "@/app/api/orgs/[id]/invites/route";
import { POST as claimInvitePost } from "@/app/api/v1/persons/[id]/claim-invites/route";
import { POST as officialInvitePost } from "@/app/api/v1/officials/[id]/invite/route";
import { createOfficial, patchFixtureOfficials } from "@/server/usecases/officials";
import { moveFixture } from "@/server/usecases/schedule";
import { createPerson } from "@/server/usecases/persons";
import { POST as registerPost } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route";
import { openRound } from "@/server/usecases/external-play/open-round";
import { assignSoloSignUp } from "@/server/usecases/registration-assign";
import {
  handleRegistrationCheckoutCompleted,
  handleRegistrationDispute,
  putRegistrationSettings,
  refundRegistration,
  sweepRegistrations,
  withdrawRegistrationPublic,
} from "@/server/usecases/registrations";
import { handleSponsorDispute, handleSponsorPaymentSucceeded, refundSponsorOrder, startSponsorCheckout } from "@/server/usecases/sponsors";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { seedOnlineChessRound } from "@/server/usecases/__tests__/_external-play-seed";
import { claimPerson, makeAssignment, makeClaimedOfficial, makeFixture, seedFootballDivision, seedFutureDivision } from "@/server/usecases/__tests__/_seed";
import { putMyReport, submitMyReport } from "@/server/usecases/match-reports";
import { refreshDiscipline } from "@/server/usecases/scoring";
import { createManualSuspension, decideSuspension } from "@/server/usecases/discipline";
import { detachOrgFromGroup, offerGroupTransfer } from "@/server/usecases/billing-groups";
import { seedCommunityGroup, seedDetachableGroup, seedLiveGroup, seedPassOrg, seedSponsorOrder, seedSponsorOrg, seedTrialingGroup } from "@/server/usecases/__tests__/_money-fixtures";
import { planLabel } from "@/lib/plan-label";
import { SETTINGS_BASE, asOwner, fakeSession, makeUser, rig, seedOrg, seedRegistration, stripeRig } from "@/server/usecases/__tests__/_registration-fixtures";
import { DISPATCH_NOW_BUDGET_MS, DISPATCH_NOW_MARGIN_MS, OUTBOX_KINDS, idempotencyKey, type OutboxKind } from "../constants";
import { dispatchNow } from "../attempt";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { REQUEST_ATTEMPT_WAIT_MS, assertNothingMoreToSend, dictionarySubject, forEachOutboxKind, type KindFacts, type KindScenario } from "./_kind-harness";
import { allowlistLengthFor, KIND_DIRECT_SENDER, NOT_YET_MOVED, SENDER_ALLOWLIST } from "./_kind-senders";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `ks-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const MIN = 60_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// Typed from the SPEC (docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md, the kind table and its legend), never read
// from constants.ts.
// ---------------------------------------------------------------------------------------------------------------------------------

const SPEC_KINDS = [
  "magic_link",
  "chess_invite",
  "registration_confirmation",
  "payment_reminder",
  "registration_promoted",
  "refund_issued",
  "solo_signup_assigned",
  // Wave 2, in the table's row order.
  "registration_dispute_alert",
  "registration_dispute_lost",
  "sponsor_invoice",
  "sponsor_receipt",
  "sponsor_refund",
  "sponsor_dispute_alert",
  "sponsor_dispute_won",
  "sponsor_dispute_lost",
  "pass_revoked",
  "trial_ending",
  // Wave 3, in the table's row order.
  "email_verification",
  "funnel_claim",
  "email_change_confirmation",
  "email_change_notice",
  "account_deletion",
  "org_invite",
  "claim_invite",
  "official_invite",
  // Wave 4, in the table's row order.
  "official_assigned",
  "official_assignment_changed",
  "suspension_confirmed",
  "suspension_served",
  "match_report_submitted",
  "group_transfer_offer",
  "group_transfer_complete",
  "group_org_removed",
  "group_org_left",
] as const satisfies readonly OutboxKind[];

/** The legend: [to, transactional]. A = an account, resolved at send; L = a literal address; S = the staff address. T = transactional. */
const SPEC_FACTS: KindFacts = {
  magic_link: ["literal", true],
  chess_invite: ["account", true],
  registration_confirmation: ["literal", false],
  payment_reminder: ["literal", false],
  registration_promoted: ["literal", false],
  refund_issued: ["literal", false],
  solo_signup_assigned: ["literal", false],
  registration_dispute_alert: ["account", false],
  registration_dispute_lost: ["account", false],
  sponsor_invoice: ["literal", false],
  sponsor_receipt: ["literal", false],
  sponsor_refund: ["literal", false],
  sponsor_dispute_alert: ["account", false],
  sponsor_dispute_won: ["account", false],
  sponsor_dispute_lost: ["account", false],
  pass_revoked: ["account", false],
  trial_ending: ["account", true],
  // Wave 3: every one is L; all T but the org invite, which is N (its sender passes no `transactional` flag).
  email_verification: ["literal", true],
  funnel_claim: ["literal", true],
  email_change_confirmation: ["literal", true],
  email_change_notice: ["literal", true],
  account_deletion: ["literal", true],
  org_invite: ["literal", false],
  claim_invite: ["literal", true],
  official_invite: ["literal", true],
  // Wave 4: the two official notices are L, the other seven A; the officials', suspensions' and report's five are T, the four
  // billing-group mails N (their senders pass no `transactional` flag).
  official_assigned: ["literal", true],
  official_assignment_changed: ["literal", true],
  suspension_confirmed: ["account", true],
  suspension_served: ["account", true],
  match_report_submitted: ["account", true],
  group_transfer_offer: ["account", false],
  group_transfer_complete: ["account", false],
  group_org_removed: ["account", false],
  group_org_left: ["account", false],
};

/** What the real producers create beyond the rows the hand-made scenarios name: the seeded round's people and organisation. (The
 *  addresses this run mails all start with RUN, so the accounts the magic-link route makes and the ones `accountAt` makes are found
 *  by address; a seeded player's address is not ours, so those are tracked by id.) */
const made = { userIds: [] as string[], orgIds: [] as string[] };

/** Everything this file wrote: outbox rows (the real producers write `ref_id` = a user id or a seat key, not RUN, so by recipient and
 *  by account too), the seeded organisation (cascades its competition, fixtures and seats), then the accounts (login links cascade). */
async function cleanUp(): Promise<void> {
  const like = `${RUN}-%`;
  await sql`
    delete from email_outbox
     where ref_id like ${like} or lower(recipient) like ${like} or recipient_user_id = any(${made.userIds}::uuid[])
        or recipient_user_id in (select id from users where email like ${like})
        or (ref_type = 'user' and ref_id = any(${made.userIds}::text[]))`;
  // A sponsor org's orders hold it (a RESTRICT foreign key, V299): they go first.
  if (made.orgIds.length > 0) await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
  // The officials' scenarios seed courts: courts.venue_id and fixtures.court_id are ON DELETE RESTRICT, so the competitions
  // (cascading their fixtures) go, then the courts, before the organisation's cascade reaches its venues (venues.test.ts's order).
  if (made.orgIds.length > 0) await sql`delete from competitions where org_id = any(${made.orgIds}::uuid[])`;
  if (made.orgIds.length > 0) await sql`delete from courts where org_id = any(${made.orgIds}::uuid[])`;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  // The seeded owner is referenced without a cascade by the plan it was given and by the round's audit trail.
  await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from online_chess_audit where actor_user_id = any(${made.userIds}::uuid[])`;
  // The staff press's audit row references its staff member without a cascade.
  await sql`delete from staff_audit_log where actor_id in (select id from users where email like ${like})`;
  await sql`delete from funnel_drafts where email like ${like}`;
  await sql`delete from users where email like ${like} or id = any(${made.userIds}::uuid[])`;
}

afterAll(async () => {
  if (HAS_DB) {
    await cleanUp();
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

beforeEach(() => {
  vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
  vi.stubEnv("RESEND_API_KEY", "re_test_sweep");
  deliverMock.mockReset();
  deliverMock.mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({ id: `cs_${RUN}_${randomUUID().slice(0, 8)}`, url: "https://checkout.stripe.test/session" }));
  stripeMock.refundCreate.mockReset().mockImplementation(async () => ({ id: `re_${RUN}_${randomUUID().slice(0, 8)}` }));
  stripeMock.setupIntentCreate.mockReset().mockImplementation(async () => {
    const id = `seti_${RUN}_${randomUUID().slice(0, 8)}`;
    return { id, client_secret: `${id}_secret` };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the spec's lists (no database)", () => {
  it("the spec lists thirty-four kinds and the code's registry is exactly them, in the spec's order", () => {
    expect([...OUTBOX_KINDS]).toEqual([...SPEC_KINDS]);
    expect(SPEC_KINDS).toHaveLength(34);
  });

  it("the legend has NINETEEN literal kinds, FIFTEEN account kinds and no staff kind", () => {
    const by = (to: string): string[] => SPEC_KINDS.filter((k) => SPEC_FACTS[k][0] === to);
    expect(by("literal")).toEqual([
      "magic_link",
      "registration_confirmation",
      "payment_reminder",
      "registration_promoted",
      "refund_issued",
      "solo_signup_assigned",
      "sponsor_invoice",
      "sponsor_receipt",
      "sponsor_refund",
      // Wave 3: all eight are literal addresses.
      "email_verification",
      "funnel_claim",
      "email_change_confirmation",
      "email_change_notice",
      "account_deletion",
      "org_invite",
      "claim_invite",
      "official_invite",
      // Wave 4: the two official notices are literal addresses.
      "official_assigned",
      "official_assignment_changed",
    ]);
    expect(by("account")).toEqual([
      "chess_invite",
      "registration_dispute_alert",
      "registration_dispute_lost",
      "sponsor_dispute_alert",
      "sponsor_dispute_won",
      "sponsor_dispute_lost",
      "pass_revoked",
      "trial_ending",
      // Wave 4: the suspension, report and billing-group mails are an account's.
      "suspension_confirmed",
      "suspension_served",
      "match_report_submitted",
      "group_transfer_offer",
      "group_transfer_complete",
      "group_org_removed",
      "group_org_left",
    ]);
    expect(by("staff"), "waves 1 to 4 have no staff kind").toEqual([]);
    // Each kind keeps its sender's flag: the two phase-1 kinds, the trial-ending notice, seven of wave 3's eight and five of wave 4's
    // nine are transactional; the registration, refund, dispute, sponsor and pass mails, the org invite and the four billing-group
    // mails are not.
    expect(SPEC_KINDS.filter((k) => SPEC_FACTS[k][1])).toEqual([
      "magic_link",
      "chess_invite",
      "trial_ending",
      "email_verification",
      "funnel_claim",
      "email_change_confirmation",
      "email_change_notice",
      "account_deletion",
      "claim_invite",
      "official_invite",
      // Wave 4: the officials', suspensions' and report's five.
      "official_assigned",
      "official_assignment_changed",
      "suspension_confirmed",
      "suspension_served",
      "match_report_submitted",
    ]);
  });

  it("the not-yet-moved list names only spec kinds, once each, in the registry's order, none of waves 1 to 3, and leaves at least one kind to sweep", () => {
    expect(new Set(NOT_YET_MOVED).size).toBe(NOT_YET_MOVED.length);
    for (const k of NOT_YET_MOVED) expect(SPEC_KINDS as readonly string[]).toContain(k);
    expect(SPEC_KINDS.length - NOT_YET_MOVED.length).toBeGreaterThan(0);
    // Waves 1 to 3 are closed (wave 1 T12, wave 2 T10, wave 3 T4c): none of their kinds may be listed again. They are the spec's first
    // twenty-five (2 + 5 + 10 + 8), everything before wave 4's first kind in the spec's own list.
    const closed = SPEC_KINDS.slice(0, SPEC_KINDS.indexOf("official_assigned"));
    expect(closed, "waves 1 to 3 hold the spec's first twenty-five kinds").toHaveLength(25);
    let closedChecked = 0;
    for (const k of closed) {
      expect(NOT_YET_MOVED, `${k} belongs to a closed wave, so it cannot be unmoved`).not.toContain(k);
      closedChecked += 1;
    }
    expect(closedChecked, "anti-vacuity: every kind of waves 1 to 3 was judged").toBe(25);
    // In the registry's order, so a kind task deletes its own line and nothing else moves.
    expect([...NOT_YET_MOVED], "the unmoved kinds are a subsequence of OUTBOX_KINDS, in its order").toEqual(
      OUTBOX_KINDS.filter((k) => NOT_YET_MOVED.includes(k)),
    );
  });

  it("the three lists agree: a kind is unmoved exactly when its direct sender is still in the allowlist of lib/email's senders", () => {
    expect(Object.keys(KIND_DIRECT_SENDER).sort(), "the map names every kind, once").toEqual([...SPEC_KINDS].sort());
    let checked = 0;
    for (const k of SPEC_KINDS) {
      const sender = KIND_DIRECT_SENDER[k];
      const unmoved = NOT_YET_MOVED.includes(k);
      const stillExported = sender !== null && SENDER_ALLOWLIST.includes(sender);
      expect(
        unmoved,
        `${k}: ${unmoved ? "listed as not yet moved" : "not listed as unmoved"}, but its direct sender ${sender ?? "(none: moved)"} is ${stillExported ? "still" : "no longer"} in SENDER_ALLOWLIST`,
      ).toBe(stillExported);
      // The map says the same thing in its own words: a kind with a sender has not moved.
      expect(unmoved, `${k}: ${sender === null ? "no direct sender in the map, so it has moved" : `the map names ${sender}, so it has not moved`}`).toBe(sender !== null);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every kind was judged").toBe(SPEC_KINDS.length);
    // Which kinds are unmoved is NOT_YET_MOVED's alone (the test above holds its shape); the loop holds it to the map and the allowlist
    // kind by kind. When the last wave-4 move empties it, put back `expect(NOT_YET_MOVED).toEqual([])` and "none still names a direct
    // sender", as wave 3's T4c left them.
    expect(SPEC_KINDS.length - NOT_YET_MOVED.length).toBeGreaterThan(0);
    const senders = Object.values(KIND_DIRECT_SENDER).filter((x): x is string => x !== null);
    expect(new Set(senders).size, "no two kinds share a direct sender").toBe(senders.length);
    // The map and NOT_YET_MOVED can be edited together and still leave the moved kind's `send*` in lib/email.ts and the allowlist: with
    // the entry nulled, no list names that sender any more. What catches it is the count, which the spec fixes: 49 senders at the start
    // of wave 1, one fewer for every kind that has moved. (The allowlist is held to lib/email.ts by name in no-second-path.test.ts.)
    expect(
      SENDER_ALLOWLIST.length,
      `${NOT_YET_MOVED.length} kinds are still unmoved, so the allowlist holds ${allowlistLengthFor(NOT_YET_MOVED.length)} senders: a moved kind's send* was left behind (or a sender was dropped for a kind that has not moved)`,
    ).toBe(allowlistLengthFor(NOT_YET_MOVED.length));
  });

  it("the harness waits for a request's own attempt longer than the longest a correct dispatchNow can still be working", () => {
    // dispatchNow's budget, plus the one request in flight and the write transaction before it (constants.ts); the harness's wait
    // must be strictly past that or a slow but correct producer is called broken. Derived from the declarations, not typed here.
    expect(REQUEST_ATTEMPT_WAIT_MS).toBeGreaterThan(DISPATCH_NOW_BUDGET_MS + DISPATCH_NOW_MARGIN_MS);
  });
});

describe("dictionarySubject reads the dictionary on disk (no database)", () => {
  it("fills the tokens from the dictionary of the locale it is given, and the locales differ", () => {
    const vars = { roundNo: "3", opponentName: "Ana Opponent" };
    const en = dictionarySubject("en", "externalPlayInvite.subject", vars);
    const es = dictionarySubject("es", "externalPlayInvite.subject", vars);
    for (const subject of [en, es]) {
      expect(subject).toContain("Ana Opponent");
      expect(subject).toContain("3");
      expect(subject, "no token left").not.toMatch(/\{\w+\}/);
    }
    expect(es, "a Spanish subject is not the English one").not.toBe(en);
    expect(dictionarySubject("en", "magicLink.subject", {}), "a subject with no tokens needs none").toBe(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries/en/emails.json"), "utf8"))["magicLink.subject"]);
  });

  it("refuses an unknown key and a token nobody gave a value for (a sentence must not go out with a brace in it)", () => {
    expect(() => dictionarySubject("en", "externalPlayInvite.noSuchKey", {})).toThrow(/no key/);
    expect(() => dictionarySubject("en", "externalPlayInvite.subject", { roundNo: "3" })).toThrow(/still has \{opponentName\}/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The scenarios: one per moved kind, each through its real producer.
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;

function magicLinkScenario(): KindScenario {
  const recipient = address();
  return {
    // The link follows the account's language (D4), and the route creates the account here: a brand-new account has none, so `en`.
    locale: "en",
    subjectKey: "magicLink.subject",
    subjectVars: {},
    recipient,
    firstAttempt: "request",
    run: async () => {
      const res = await magicLinkPost(
        new Request("https://sweep.test/api/auth/magic-link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: recipient }),
        }),
      );
      expect(res.status, "premise: the real route answered 200").toBe(200);
    },
  };
}

/** The real open of a one-board online round whose WHITE-or-BLACK player (the seed's `home`) has an `es` account. The other player is
 *  mailed too, but this scenario judges only `home`'s rows (the scenario names one recipient). */
async function chessInviteScenario(): Promise<KindScenario> {
  const r = await seedOnlineChessRound({ fixtures: 1 });
  const board = r.boards[0]!;
  made.orgIds.push(r.orgId);
  made.userIds.push(r.ownerUserId, board.home.userId, board.away.userId);
  await sql`update users set locale = 'es' where id = ${board.home.userId}`;
  // The opponent's name as the seed made it: the person row, read back (not the invite's own view of it).
  const [opponent] = await sql<{ full_name: string }[]>`select full_name from persons where id = ${board.away.personId}`;
  return {
    locale: "es",
    subjectKey: "externalPlayInvite.subject",
    subjectVars: { roundNo: String(r.roundNo), opponentName: opponent!.full_name },
    recipient: board.home.email,
    firstAttempt: "request",
    run: async () => {
      const out = await openRound({ stageId: r.stageId, roundNo: r.roundNo, actorUserId: r.ownerUserId });
      expect(out, "premise: the real open stamped the round and invited it").toMatchObject({ opened: true });
    },
  };
}

/** The real public register route: a free, open division, a registrant with an `es` locale cookie (the footer switcher's). The cart is
 *  committed by the real submit and its confirmation is queued by `notifySubmitted`; the dispatch after the response makes the attempt. */
async function registrationConfirmationScenario(): Promise<KindScenario> {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: 0, payment_method: "offline" });
  const recipient = address();
  return {
    locale: "es",
    subjectKey: "registration.subject",
    subjectVars: { competitionName: competition.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const res = await registerPost(
        new Request(`https://sweep.test/api/v1/public/orgs/${orgSlug}/competitions/${competition.slug}/register`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: "seazn_locale=es" },
          body: JSON.stringify({
            contact: { name: "Sweep Rep", email: recipient },
            privacy_consent: true,
            entries: [{ division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Sweep Player" }], answers: {} }],
          }),
        }),
        { params: Promise.resolve({ orgSlug, slug: competition.slug }) },
      );
      expect(res.status, "premise: the real route accepted the cart").toBe(201);
    },
  };
}

/** The real withdrawal that frees the division's only spot: the holder withdraws and the `nl` registrant behind them is promoted. The
 *  promotion email is queued after the promotion committed, and the request that did it makes the first attempt. */
async function registrationPromotedScenario(): Promise<KindScenario> {
  const { orgId, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: 1500, payment_method: "offline", capacity: 1 });
  const holder = await seedRegistration(competition.id, division.id, settings, { contactEmail: address() });
  const recipient = address();
  await seedRegistration(competition.id, division.id, settings, { contactEmail: recipient, status: "waitlisted", locale: "nl" });
  return {
    locale: "nl",
    subjectKey: "registrationPromoted.subject",
    subjectVars: { competitionName: competition.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const view = await withdrawRegistrationPublic(holder.registration.id, holder.access_token);
      expect(view.status, "premise: the real withdrawal went through").toBe("withdrawn");
      // The promotion email is queued after the withdrawal's own commit, off the response (`void notifyPromoted`): the producer has not
      // finished when the withdrawal returns. Wait for its row, or a busy machine reads "no row" before the enqueue has run.
      await vi.waitFor(
        async () => {
          const [queued] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where kind = 'registration_promoted' and lower(recipient) = lower(${recipient})`;
          if (queued!.n === 0) throw new Error("the promotion email has not been queued yet");
        },
        { timeout: 10_000, interval: 50 },
      );
    },
  };
}

/** The real sweep: a stripe cart in an `fr` group whose deadline is inside the reminder window. The sweep claims it, mints a Checkout
 *  session, and queues the reminder with its once-key; the first attempt is the worker's, so the harness sees the row wait. */
async function paymentReminderScenario(): Promise<KindScenario> {
  const w = await stripeRig({ feeCents: 500 });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  const recipient = address();
  const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: recipient, locale: "fr" });
  return {
    locale: "fr",
    subjectKey: "paymentReminder.subject",
    subjectVars: { competitionName: w.competition.name },
    recipient,
    firstAttempt: "worker",
    run: async () => {
      // The cart is made due HERE, immediately before the sweep, and not when the scenario is built: the sweep is global to the database and
      // other test files run their own beside this one. A cart that sat due while the other scenarios ran was claimed by one of THEIR sweeps
      // (in a process with no outbox key, so the row it queued had no body and ended dead).
      await sql`update registration_groups set expires_at = now() + interval '10 hours' where id = ${registration.group_id}`;
      await sweepRegistrations("https://sweep.test");
      // Even so, a sweep elsewhere may win the claim in the instant between: this call's own `reminded` count is not the evidence. The
      // evidence is the queued row, which the harness requires next.
      await vi.waitFor(
        async () => {
          const [queued] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where kind = 'payment_reminder' and lower(recipient) = lower(${recipient})`;
          if (queued!.n === 0) throw new Error("the reminder has not been queued yet");
        },
        { timeout: 10_000, interval: 50 },
      );
    },
  };
}

/** The real organiser refund: an `es` registrant has paid (the real webhook confirmed the entry) and the organiser refunds them in full. The
 *  receipt is queued in the transaction that records the refund, and the request that did it makes the first attempt. */
async function refundIssuedScenario(): Promise<KindScenario> {
  const w = await stripeRig({ feeCents: 700 });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  const recipient = address();
  const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: recipient, locale: "es" });
  await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 700));
  return {
    locale: "es",
    subjectKey: "refundIssued.subject",
    subjectVars: { competitionName: w.competition.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const after = await refundRegistration(w.owner, registration.id, undefined);
      expect(after.refunded_cents, "premise: the real refund went through").toBe(700);
    },
  };
}

/** The real organiser assignment: a pooled `fr` solo sign-up is placed on a team entry (the `generic` sport's roster cap of one is room enough
 *  for the one player). The email is queued in the assignment's own transaction; the request that did it makes the first attempt. */
async function soloSignupAssignedScenario(): Promise<KindScenario> {
  const { orgId, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    entrant_kind: "team",
    allow_free_agents: true,
    fee_cents: 0,
    payment_method: "offline",
  });
  const teamName = `Sweep Team ${randomUUID().slice(0, 6)}`;
  const team = await seedRegistration(competition.id, division.id, settings, { contactEmail: address(), displayName: teamName, status: "confirmed" });
  const recipient = address();
  const solo = await seedRegistration(competition.id, division.id, settings, {
    contactEmail: recipient,
    displayName: "Sweep Solo",
    status: "confirmed",
    locale: "fr",
    players: [{ name: "Sweep Solo" }],
  });
  await sql`update registrations set free_agent = true where id = ${solo.registration.id}`;
  return {
    locale: "fr",
    subjectKey: "soloSignUpAssigned.subject",
    subjectVars: { teamName },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const placed = await assignSoloSignUp(owner, { registration_id: solo.registration.id, target_registration_id: team.registration.id });
      expect(placed.target_display_name, "premise: the real assignment placed the person on the team").toBe(teamName);
    },
  };
}

/** A card-paid entry (the real webhook confirmed it) in a fresh org whose one owner's account is mailed at a run-unique address, in the given
 *  language, under the given org default. Returns the address and the payment intent its cart carries (read back, not rebuilt). */
async function disputableEntry(o: { ownerLocale: string | null; orgDefault: string; feeCents: number }) {
  const w = await stripeRig({ feeCents: o.feeCents });
  made.orgIds.push(w.orgId);
  made.userIds.push(w.ownerId);
  const recipient = address();
  await sql`update users set email = ${recipient}, locale = ${o.ownerLocale} where id = ${w.ownerId}`;
  await sql`update organizations set default_locale = ${o.orgDefault} where id = ${w.orgId}`;
  const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address() });
  await handleRegistrationCheckoutCompleted(fakeSession(registration.id, o.feeCents));
  const [cart] = await sql<{ payment_intent_id: string | null }[]>`select payment_intent_id from registration_groups where id = ${registration.group_id}`;
  expect(cart!.payment_intent_id, "premise: the paid cart carries its payment intent").toBeTruthy();
  return { w, recipient, intent: cart!.payment_intent_id! };
}

/** The real `created` webhook handler on a paid card cart: the org's owner (account `fr`, org default `en`) is alerted on the outbox in the
 *  transaction that records the dispute, and the first attempt is the worker's. */
async function registrationDisputeAlertScenario(): Promise<KindScenario> {
  const { w, recipient, intent } = await disputableEntry({ ownerLocale: "fr", orgDefault: "en", feeCents: 900 });
  return {
    locale: "fr",
    subjectKey: "disputeAlert.subject",
    subjectVars: { competitionName: w.competition.name },
    recipient,
    firstAttempt: "worker",
    run: async () => {
      const dispute = { id: `dp_${RUN}_alert`, payment_intent: intent, amount: 900, status: "needs_response" } as unknown as Stripe.Dispute;
      expect(await handleRegistrationDispute(dispute, "created"), "premise: the real handler matched the entry-fee charge").toBe(true);
    },
  };
}

/** The real `closed` webhook handler on a lost dispute: the org's owner (an account with no language, in an `es` org) is told on the
 *  outbox, and the first attempt is the worker's. The dispute names no charge, so the recovery is skipped and Stripe is never called. */
async function registrationDisputeLostScenario(): Promise<KindScenario> {
  const { w, recipient, intent } = await disputableEntry({ ownerLocale: null, orgDefault: "es", feeCents: 900 });
  return {
    locale: "es",
    subjectKey: "disputeLost.subject",
    subjectVars: { competitionName: w.competition.name },
    recipient,
    firstAttempt: "worker",
    run: async () => {
      const dispute = { id: `dp_${RUN}_lost`, payment_intent: intent, amount: 900, status: "lost" } as unknown as Stripe.Dispute;
      expect(await handleRegistrationDispute(dispute, "closed"), "premise: the real handler matched the entry-fee charge").toBe(true);
    },
  };
}

/** The real checkout of a package in an `fr` org: the invoice is queued to the sponsor contact once the Checkout session (the Stripe
 *  mock's) is minted, and the request that did it makes the first attempt. The org's owner is mailed at a RUN address, so it is found. */
async function sponsorInvoiceScenario(): Promise<KindScenario> {
  const s = await seedSponsorOrg({ defaultLocale: "fr", prefix: RUN });
  made.orgIds.push(s.orgId);
  made.userIds.push(s.ownerId);
  const recipient = address();
  return {
    locale: "fr",
    subjectKey: "sponsorInvoice.subject",
    subjectVars: { orgName: s.orgName },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const out = await startSponsorCheckout(s.auth, { package_id: s.packageId, sponsor_name: "Sweep Sponsor", sponsor_email: recipient }, "https://sweep.test");
      expect(out.order.status, "premise: the real checkout opened a pending order").toBe("pending");
    },
  };
}

/** The real payment webhook on a pending order in an `nl` org: the receipt is queued to the sponsor contact in the transaction that
 *  activates the placement, and the first attempt is the worker's. The fixture's addresses start with RUN, so they are found. */
async function sponsorReceiptScenario(): Promise<KindScenario> {
  const o = await seedSponsorOrder({ status: "pending", defaultLocale: "nl", prefix: RUN });
  made.orgIds.push(o.orgId);
  made.userIds.push(o.ownerId);
  return {
    locale: "nl",
    subjectKey: "sponsorReceipt.subject",
    subjectVars: { orgName: o.orgName },
    recipient: o.sponsorEmail,
    firstAttempt: "worker",
    run: async () => {
      await handleSponsorPaymentSucceeded({ id: o.intent, metadata: { kind: "sponsor", order_id: o.orderId } } as unknown as Stripe.PaymentIntent);
      const [order] = await sql<{ status: string }[]>`select status from sponsor_orders where id = ${o.orderId}`;
      expect(order!.status, "premise: the real handler activated the order").toBe("paid");
    },
  };
}

/** The real console refund of a paid order in an `es` org: the notice is queued in the transaction that records the refund, at its own
 *  savepoint, and the request that did it makes the first attempt. */
async function sponsorRefundScenario(): Promise<KindScenario> {
  const o = await seedSponsorOrder({ status: "paid", defaultLocale: "es", prefix: RUN });
  made.orgIds.push(o.orgId);
  made.userIds.push(o.ownerId);
  const auth = { orgId: o.orgId, via: "session", userId: o.ownerId, role: "owner", keyId: null } as const;
  return {
    locale: "es",
    subjectKey: "sponsorRefund.subject",
    subjectVars: { orgName: o.orgName },
    recipient: o.sponsorEmail,
    firstAttempt: "request",
    run: async () => {
      const after = await refundSponsorOrder(auth, o.orderId);
      expect(after.status, "premise: the real refund went through").toBe("refunded");
    },
  };
}

/** A paid sponsor order whose org's one owner (an account at a RUN address, so it is found) has the given language, under the given org
 *  default. */
async function disputableSponsorOrder(o: { ownerLocale: string | null; defaultLocale: "en" | "es" | "fr" | "nl" }) {
  const order = await seedSponsorOrder({ status: "paid", ownerLocale: o.ownerLocale, defaultLocale: o.defaultLocale, prefix: RUN });
  made.orgIds.push(order.orgId);
  made.userIds.push(order.ownerId);
  return order;
}

/** The real `created` webhook handler on a paid sponsor order: the org's owner (account `fr`, org default `en`) is alerted on the outbox
 *  in the transaction that flags the order, and the first attempt is the worker's. */
async function sponsorDisputeAlertScenario(): Promise<KindScenario> {
  const o = await disputableSponsorOrder({ ownerLocale: "fr", defaultLocale: "en" });
  return {
    locale: "fr",
    subjectKey: "sponsorDisputeAlert.subject",
    subjectVars: { orgName: o.orgName },
    recipient: o.ownerEmail,
    firstAttempt: "worker",
    run: async () => {
      const dispute = { id: `dp_${RUN}_sp_alert`, payment_intent: o.intent, amount: 25000, status: "needs_response" } as unknown as Stripe.Dispute;
      expect(await handleSponsorDispute(dispute, "created"), "premise: the real handler matched the sponsor's charge").toBe(true);
    },
  };
}

/** The real `closed` webhook handler on a dispute that closed won, on an order its `created` flagged: the org's owner (an account with no
 *  language, in an `es` org) is told on the outbox in the transaction that clears the flag, and the first attempt is the worker's. */
async function sponsorDisputeWonScenario(): Promise<KindScenario> {
  const o = await disputableSponsorOrder({ ownerLocale: null, defaultLocale: "es" });
  const id = `dp_${RUN}_sp_won`;
  const dispute = (status: string) => ({ id, payment_intent: o.intent, amount: 25000, status }) as unknown as Stripe.Dispute;
  // The dispute opened first (it queues the owner's alert, a kind this scenario does not judge).
  expect(await handleSponsorDispute(dispute("needs_response"), "created"), "premise: the real handler flagged the sponsor's order").toBe(true);
  return {
    locale: "es",
    subjectKey: "sponsorDisputeWon.subject",
    subjectVars: { orgName: o.orgName },
    recipient: o.ownerEmail,
    firstAttempt: "worker",
    run: async () => {
      expect(await handleSponsorDispute(dispute("won"), "closed"), "premise: the real handler matched the sponsor's charge").toBe(true);
    },
  };
}

/** The real `closed` webhook handler on a dispute that closed lost: the org's owner (account `nl`, org default `en`) is told on the outbox
 *  after the write-off, and the first attempt is the worker's. The dispute names no charge, so the recovery is skipped and Stripe is
 *  never called. */
async function sponsorDisputeLostScenario(): Promise<KindScenario> {
  const o = await disputableSponsorOrder({ ownerLocale: "nl", defaultLocale: "en" });
  return {
    locale: "nl",
    subjectKey: "sponsorDisputeLost.subject",
    subjectVars: { orgName: o.orgName },
    recipient: o.ownerEmail,
    firstAttempt: "worker",
    run: async () => {
      const dispute = { id: `dp_${RUN}_sp_lost`, payment_intent: o.intent, amount: 25000, status: "lost" } as unknown as Stripe.Dispute;
      expect(await handleSponsorDispute(dispute, "closed"), "premise: the real handler matched the sponsor's charge").toBe(true);
    },
  };
}

/** The real refund webhook (`charge.refunded`, a full refund) on an Event Pass: the org's owner (account `nl`, org default `en`; the
 *  org's `created_by` is another account) is told on the outbox in the transaction that deletes the pass, and the first attempt is the
 *  worker's. Both accounts are at RUN addresses, so they are found. */
async function passRevokedScenario(): Promise<KindScenario> {
  const intent = `pi_${RUN}_pass`;
  const o = await seedPassOrg({ intent, ownerLocale: "nl", defaultLocale: "en", prefix: RUN });
  made.orgIds.push(o.orgId);
  made.userIds.push(o.ownerId, o.trapId);
  return {
    locale: "nl",
    subjectKey: "passRevoked.subject",
    subjectVars: { rung: dictionarySubject("nl", "passRevoked.rung.m", {}) },
    recipient: o.ownerEmail,
    firstAttempt: "worker",
    run: async () => {
      const charge = { id: `ch_${RUN}_pass`, payment_intent: intent, refunded: true, amount_refunded: 2900 };
      await processStripeEvent({ id: `evt_${RUN}_pass`, type: "charge.refunded", data: { object: charge } } as unknown as Stripe.Event);
      const [pass] = await sql`select 1 from competition_passes where stripe_payment_intent = ${intent}`;
      expect(pass, "premise: the real handler revoked the pass").toBeUndefined();
    },
  };
}

/** The real `trial_will_end` webhook on a no-card trialing billing group: its payer (account `fr`, the org's default `en`, at a RUN
 *  address, so it is found) is warned on the outbox, transactionally, in the `card` variant (add a card or the trial stops), and the first
 *  attempt is the worker's. */
async function trialEndingScenario(): Promise<KindScenario> {
  const g = await seedTrialingGroup({ hasPaymentMethod: false, ownerLocale: "fr", orgDefaultLocale: "en", prefix: RUN });
  made.orgIds.push(g.orgId);
  made.userIds.push(g.ownerId);
  const trialEnd = new Date(Math.floor((Date.now() + 3 * 24 * 60 * MIN) / 1000) * 1000);
  return {
    locale: "fr",
    subjectKey: "trialEnding.subject.card",
    subjectVars: {
      planName: planLabel("pro"),
      date: new Intl.DateTimeFormat("fr", { dateStyle: "long", timeZone: "UTC" }).format(trialEnd),
    },
    recipient: g.ownerEmail,
    firstAttempt: "worker",
    run: async () => {
      const sub = { id: g.stripeSubId, object: "subscription", status: "trialing", trial_end: trialEnd.getTime() / 1000, metadata: {} };
      const event = { id: `evt_${RUN}_trial`, type: "customer.subscription.trial_will_end", data: { object: sub } };
      await processStripeEvent(event as unknown as Stripe.Event);
    },
  };
}

/** Run `fn` with `userId` signed in (the session stand-in above), and nobody after it. */
async function signedInAs<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const [user] = await sql<{ id: string }[]>`select id, display_name, email, avatar_url, timezone, locale from users where id = ${userId}`;
  session.user = user!;
  try {
    return await fn();
  } finally {
    session.user = null;
  }
}

/** An account at a RUN address (`makeUser`'s), so the harness and the clean-up find it. */
async function runUser(set: { locale?: string; verified?: boolean; staff?: boolean }): Promise<{ id: string; email: string }> {
  const id = await makeUser(RUN);
  const [u] = await sql<{ email: string }[]>`
    update users set locale = ${set.locale ?? null}, email_verified = ${set.verified ?? true},
                     is_staff = ${set.staff === true}, staff_role = ${set.staff ? "support" : null}
     where id = ${id} returning email`;
  return { id, email: u!.email };
}

/** The real staff resend for an unverified account whose language is `fr`: the token and its row are one transaction on the pool, and
 *  the request's own (deferred) attempt sends it. */
async function emailVerificationScenario(): Promise<KindScenario> {
  const staff = await runUser({ staff: true });
  const target = await runUser({ locale: "fr", verified: false });
  return {
    locale: "fr",
    subjectKey: "verification.subject",
    subjectVars: {},
    recipient: target.email,
    firstAttempt: "request",
    run: async () => {
      const res = await signedInAs(staff.id, () =>
        resendVerificationPost(new Request(`https://sweep.test/api/admin/users/${target.id}/resend-verification`, { method: "POST" }), {
          params: Promise.resolve({ id: target.id }),
        }),
      );
      expect(res.status, "premise: the real staff action answered 200").toBe(200);
    },
  };
}

/** The real start of the funnel by a visitor: no account and no organisation, so the claim is rendered in `en` (D4's last step); the
 *  request makes the first attempt. */
function funnelClaimScenario(): KindScenario {
  const recipient = address();
  const competitionName = `Sweep Open ${RUN}`;
  return {
    locale: "en",
    subjectKey: "funnelClaim.subject",
    subjectVars: { competitionName },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const res = await funnelStartPost(
        new Request("https://sweep.test/api/funnel/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: recipient, name: competitionName, sport: "Badminton", entrants: 8 }),
        }),
      );
      expect(res.status, "premise: the real route answered 200").toBe(200);
    },
  };
}

/** The real email-change request by an `es` account: the confirmation goes to the NEW address, in the account's language, and the
 *  request makes the first attempt. */
async function emailChangeConfirmationScenario(): Promise<KindScenario> {
  const user = await runUser({ locale: "es" });
  const recipient = address();
  return {
    locale: "es",
    subjectKey: "emailChangeConfirm.subject",
    subjectVars: {},
    recipient,
    firstAttempt: "request",
    run: () => requestEmailChange(user.id, recipient),
  };
}

/** The real email-change request by another `es` account: the notice goes to the OLD address, naming the new one. */
async function emailChangeNoticeScenario(): Promise<KindScenario> {
  const user = await runUser({ locale: "es" });
  return {
    locale: "es",
    subjectKey: "emailChangeNotice.subject",
    subjectVars: {},
    recipient: user.email,
    firstAttempt: "request",
    run: () => requestEmailChange(user.id, address()),
  };
}

/** The real deletion of an `nl` account by itself: the notice goes to the address the account had, in its language, and the request's
 *  own (deferred) attempt sends it. The deletion replaces the account's address, so the clean-up finds the account (and the notice, once
 *  a tick has scrubbed its address) by id. */
async function accountDeletionScenario(): Promise<KindScenario> {
  const user = await runUser({ locale: "nl" });
  made.userIds.push(user.id);
  return {
    locale: "nl",
    subjectKey: "accountDeletion.subject",
    subjectVars: {},
    recipient: user.email,
    firstAttempt: "request",
    run: async () => {
      const res = await signedInAs(user.id, () =>
        deleteAccount(new Request("https://sweep.test/api/users/me", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) })),
      );
      expect(res.status, "premise: the real route answered 200").toBe(200);
    },
  };
}

/** The real email invite by the owner of an organisation whose default language is `fr`: the invitee has no account the org may follow,
 *  so the invite is in the org's language, and the request makes the first attempt. */
async function orgInviteScenario(): Promise<KindScenario> {
  const { orgId, ownerId } = await seedOrg("community");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const [org] = await sql<{ name: string }[]>`update organizations set default_locale = 'fr' where id = ${orgId} returning name`;
  const recipient = address();
  return {
    locale: "fr",
    subjectKey: "invite.subject",
    subjectVars: { orgName: org!.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const res = await signedInAs(ownerId, () =>
        orgInvitePost(
          new Request(`https://sweep.test/api/orgs/${orgId}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "viewer", email: recipient }),
          }),
          { params: Promise.resolve({ id: orgId }) },
        ),
      );
      expect(res.status, "premise: the real route answered 200").toBe(200);
    },
  };
}

/** The organiser of an organisation whose default language is `es` invites an unclaimed person to claim their profile: the person has no
 *  account to follow, so the invite is in the org's language, and the request makes the first attempt. */
async function claimInviteScenario(): Promise<KindScenario> {
  const { orgId, ownerId } = await seedOrg("community");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const [org] = await sql<{ name: string }[]>`update organizations set default_locale = 'es' where id = ${orgId} returning name`;
  const person = await createPerson(asOwner(orgId, ownerId), { full_name: "Sweep Claimant", consent: {} } as never);
  const recipient = address();
  return {
    locale: "es",
    subjectKey: "claimInvite.subject",
    subjectVars: { orgName: org!.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const res = await signedInAs(ownerId, () =>
        claimInvitePost(
          new Request(`https://sweep.test/api/v1/persons/${person.id}/claim-invites`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: recipient }),
          }),
          { params: Promise.resolve({ id: person.id }) },
        ),
      );
      expect(res.status, "premise: the real route answered 201").toBe(201);
    },
  };
}

/** The organiser of an organisation whose default language is `nl` invites an official to claim their profile: the official's person
 *  has no account to follow, so the invite is in the org's language, and the request makes the first attempt. */
async function officialInviteScenario(): Promise<KindScenario> {
  const { orgId, ownerId } = await seedOrg("community");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const [org] = await sql<{ name: string }[]>`update organizations set default_locale = 'nl' where id = ${orgId} returning name`;
  const official = await createOfficial(asOwner(orgId, ownerId), { display_name: "Sweep Referee", role_keys: ["referee"] });
  const recipient = address();
  return {
    locale: "nl",
    subjectKey: "officialInvite.subject",
    subjectVars: { orgName: org!.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const res = await signedInAs(ownerId, () =>
        officialInvitePost(
          new Request(`https://sweep.test/api/v1/officials/${official.id}/invite`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: recipient }),
          }),
          { params: Promise.resolve({ id: official.id }) },
        ),
      );
      expect(res.status, "premise: the real route answered 201").toBe(201);
    },
  };
}

/** The organiser of an organisation whose default language is `es` sets an official on a fixture by hand. The official has an address
 *  and no account, so the notice is in the org's language; it is queued in the assignment's transaction and the request makes the first
 *  attempt after commit. */
async function officialAssignedScenario(): Promise<KindScenario> {
  const { orgId, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const [org] = await sql<{ name: string }[]>`update organizations set default_locale = 'es' where id = ${orgId} returning name`;
  const owner = asOwner(orgId, ownerId);
  const { fixtures } = await seedFutureDivision(owner);
  const recipient = address();
  const official = await createOfficial(owner, { display_name: "Sweep Assigned Ref", role_keys: ["referee"], email: recipient });
  return {
    locale: "es",
    subjectKey: "officialAssigned.subject",
    subjectVars: { orgName: org!.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const out = await patchFixtureOfficials(owner, fixtures[0]!.id, {
        set: [{ official_id: official.id, role_key: "referee", locked: false }],
      });
      expect(out.officials, "premise: the real set wrote the assignment").toHaveLength(1);
    },
  };
}

/** The organiser of an organisation whose default language is `nl` moves a fixture an official has accepted. The official has an address
 *  and no account, so the notice is in the org's language; it is queued in the move's transaction and the request makes the first attempt
 *  after commit. The fixture moves a day earlier, clear of every other slot on its court. */
async function officialAssignmentChangedScenario(): Promise<KindScenario> {
  const { orgId, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const [org] = await sql<{ name: string }[]>`update organizations set default_locale = 'nl' where id = ${orgId} returning name`;
  const owner = asOwner(orgId, ownerId);
  const { fixtures } = await seedFutureDivision(owner);
  const recipient = address();
  const official = await createOfficial(owner, { display_name: "Sweep Moved Ref", role_keys: ["referee"], email: recipient });
  // Appointed directly (accepted), not through the manual set: that would queue an assignment notice to the same address.
  await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
            values (${orgId}, ${fixtures[0]!.id}, ${official.id}, 'referee', 'accepted')`;
  const [before] = await sql<{ scheduled_at: Date }[]>`select scheduled_at from fixtures where id = ${fixtures[0]!.id}`;
  const next = new Date(before!.scheduled_at.getTime() - 24 * 60 * MIN).toISOString();
  return {
    locale: "nl",
    subjectKey: "officialChanged.subject",
    subjectVars: { orgName: org!.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      await moveFixture(owner, fixtures[0]!.id, { scheduled_at: next });
      const [after] = await sql<{ scheduled_at: Date }[]>`select scheduled_at from fixtures where id = ${fixtures[0]!.id}`;
      expect(after!.scheduled_at.toISOString(), "premise: the real move wrote the new time").toBe(next);
    },
  };
}

/** The organiser confirms a pending ban on a player whose claimed account's language is `es` (the org's default is `en`): the notice is
 *  queued to that account in the decision's transaction, once, and the request makes the first attempt after commit. */
async function suspensionConfirmedScenario(): Promise<KindScenario> {
  const ctx = await seedFootballDivision();
  made.orgIds.push(ctx.orgId);
  made.userIds.push(ctx.userId);
  const recipient = address();
  const userId = await claimPerson(ctx.personX, recipient);
  await sql`update users set locale = 'es' where id = ${userId}`;
  const [division] = await sql<{ name: string }[]>`select name from divisions where id = ${ctx.divisionId}`;
  const ban = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 2, reason: "violent conduct" });
  return {
    locale: "es",
    subjectKey: "suspensionConfirmed.subject",
    subjectVars: { division: division!.name },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const out = await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
      expect(out.status, "premise: the real confirm made the ban live").toBe("active");
    },
  };
}

/** A score write's fold serves a confirmed one-match ban: the decided fixture of the banned team is stamped after the ban, and the real
 *  `refreshDiscipline` flips it. The player's claimed account has no language, so the notice is in the organisation's (`nl`); it is
 *  queued in the flip's transaction and waits for the worker. */
async function suspensionServedScenario(): Promise<KindScenario> {
  const ctx = await seedFootballDivision();
  made.orgIds.push(ctx.orgId);
  made.userIds.push(ctx.userId);
  await sql`update organizations set default_locale = 'nl' where id = ${ctx.orgId}`;
  const recipient = address();
  await claimPerson(ctx.personX, recipient);
  const [division] = await sql<{ name: string }[]>`select name from divisions where id = ${ctx.divisionId}`;
  const ban = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 1, reason: "violent conduct" });
  await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
  const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
  await sql`
    insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
    values (${fx}, ${ctx.orgId}, 1, 'core.note', ${sql.json({ text: "d" })}, now() + interval '1 hour')`;
  return {
    locale: "nl",
    subjectKey: "suspensionServed.subject",
    subjectVars: { division: division!.name },
    recipient,
    firstAttempt: "worker",
    run: async () => {
      await refreshDiscipline(ctx.auth, fx);
      const [row] = await sql<{ status: string }[]>`select status from suspensions where id = ${ban.id}`;
      expect(row!.status, "premise: the real fold served the ban").toBe("served");
    },
  };
}

/** A claimed official submits their draft report on a decided fixture. The organisation's one owner (its only owner or admin) has an `fr`
 *  account at a RUN address; the notice is queued to that account in the submit's transaction, and the request makes the first attempt. */
async function matchReportSubmittedScenario(): Promise<KindScenario> {
  const ctx = await seedFootballDivision();
  made.orgIds.push(ctx.orgId);
  made.userIds.push(ctx.userId);
  const recipient = address();
  await sql`update users set email = ${recipient}, locale = 'fr' where id = ${ctx.userId}`;
  const ref = await makeClaimedOfficial(ctx);
  made.userIds.push(ref.userId);
  const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
  await putMyReport(ref.userId, fixtureOfficialId, { body: "Sweep report", incidents: [] });
  const [home, away] = await sql<{ display_name: string }[]>`
    select display_name from entrants where id in (${ctx.entrantA}, ${ctx.entrantB}) order by seed`;
  return {
    locale: "fr",
    subjectKey: "reportSubmitted.subject",
    subjectVars: { fixture: `${home!.display_name} vs ${away!.display_name}` },
    recipient,
    firstAttempt: "request",
    run: async () => {
      const out = await submitMyReport(ref.userId, fixtureOfficialId);
      expect(out.status, "premise: the real submit filed the report").toBe("submitted");
    },
  };
}

/** The payer of a live billing group offers it to the owner of one of its orgs, whose account is `es` (the org's default is `en`): the
 *  real offer mints a SetupIntent (the Stripe mock's) and makes the offer live, the notice is queued to the recipient's account in that
 *  transaction, and the request makes the first attempt after commit. Both accounts are at RUN addresses, so they are found. */
async function groupTransferOfferScenario(): Promise<KindScenario> {
  const g = await seedLiveGroup({ heirLocale: "es", orgDefaultLocale: "en", prefix: RUN });
  made.orgIds.push(g.orgId);
  made.userIds.push(g.payer.id, g.heir.id);
  return {
    locale: "es",
    subjectKey: "transferOffer.subject",
    subjectVars: {},
    recipient: g.heir.email,
    firstAttempt: "request",
    run: async () => {
      const out = await offerGroupTransfer({ actorUserId: g.payer.id, subscriptionId: g.groupId, newOwnerUserId: g.heir.id });
      expect(out.status, "premise: the real offer went live").toBe("pending_card");
    },
  };
}

/** The payer of a community billing group (no live subscription) hands it to the owner of its org: the immediate path, no card asked
 *  for. The recipient's account has no language, so the notice is in the org's (`fr`); it is queued to the recipient's account in the
 *  handover's transaction, and the request makes the first attempt after the tidy-up. */
async function groupTransferCompleteScenario(): Promise<KindScenario> {
  const g = await seedCommunityGroup({ orgDefaultLocale: "fr", prefix: RUN });
  made.orgIds.push(g.orgId);
  made.userIds.push(g.payer.id, g.heir.id);
  return {
    locale: "fr",
    subjectKey: "transferComplete.subject",
    subjectVars: {},
    recipient: g.heir.email,
    firstAttempt: "request",
    run: async () => {
      const out = await offerGroupTransfer({ actorUserId: g.payer.id, subscriptionId: g.groupId, newOwnerUserId: g.heir.id });
      expect(out, "premise: the real handover moved the group").toMatchObject({ status: "transferred", owner_user_id: g.heir.id });
    },
  };
}

/** The payer of a paying billing group pushes out an org someone else owns (ride-out: the org keeps the plan to the period end). The
 *  owner's account is `fr`, so the notice is in French; it is queued to that account in the detach's transaction, and the request makes
 *  the first attempt after commit. */
async function groupOrgRemovedScenario(): Promise<KindScenario> {
  const g = await seedDetachableGroup({ ownerLocale: "fr", prefix: RUN });
  made.orgIds.push(g.orgId, g.primaryId);
  made.userIds.push(g.payer.id, g.owner.id);
  return {
    locale: "fr",
    subjectKey: "groupOrgRemoved.subject",
    subjectVars: { orgName: g.orgName },
    recipient: g.owner.email,
    firstAttempt: "request",
    run: async () => {
      const out = await detachOrgFromGroup({ actorUserId: g.payer.id, orgId: g.orgId, mode: "ride_out" });
      const [org] = await sql<{ subscription_id: string }[]>`select subscription_id from organizations where id = ${g.orgId}`;
      expect(org!.subscription_id, "premise: the real detach gave the org a group of its own").toBe(out.subscription_id);
    },
  };
}

/** The owner of an org in a paying billing group takes it out (release: the payer keeps the seat as a reusable slot). The payer's
 *  account has no language, so the notice follows the default of the group's remaining org (`nl`), the one its link points at; it is
 *  queued to the payer's account in the detach's transaction, and the request makes the first attempt after commit. */
async function groupOrgLeftScenario(): Promise<KindScenario> {
  const g = await seedDetachableGroup({ remainingDefaultLocale: "nl", prefix: RUN });
  made.orgIds.push(g.orgId, g.primaryId);
  made.userIds.push(g.payer.id, g.owner.id);
  return {
    locale: "nl",
    subjectKey: "groupOrgLeft.subject",
    subjectVars: { orgName: g.orgName },
    recipient: g.payer.email,
    firstAttempt: "request",
    run: async () => {
      const out = await detachOrgFromGroup({ actorUserId: g.owner.id, orgId: g.orgId, mode: "release" });
      const [org] = await sql<{ subscription_id: string }[]>`select subscription_id from organizations where id = ${g.orgId}`;
      expect(org!.subscription_id, "premise: the real detach gave the org a group of its own").toBe(out.subscription_id);
    },
  };
}

/** The account `userId`, signed in, asks to move to `newEmail` through the real route. */
async function requestEmailChange(userId: string, newEmail: string): Promise<void> {
  const res = await signedInAs(userId, () =>
    changeEmailPost(
      new Request("https://sweep.test/api/auth/change-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_email: newEmail }),
      }),
    ),
  );
  expect(res.status, "premise: the real route answered 200").toBe(200);
}

describe.skipIf(!HAS_DB)("every outbox kind is swept through its real producer (DB)", () => {
  it("every outbox kind is swept through its real producer", async () => {
    // The Spanish subject differs from the English one, so a producer that dropped the locale would be seen (the right answer is not
    // the wrong one's constant).
    const chess = await chessInviteScenario();
    expect(dictionarySubject("es", chess.subjectKey, chess.subjectVars)).not.toBe(dictionarySubject("en", chess.subjectKey, chess.subjectVars));

    const registration = await registrationConfirmationScenario();
    expect(dictionarySubject("es", registration.subjectKey, registration.subjectVars)).not.toBe(
      dictionarySubject("en", registration.subjectKey, registration.subjectVars),
    );

    const promoted = await registrationPromotedScenario();
    expect(dictionarySubject("nl", promoted.subjectKey, promoted.subjectVars)).not.toBe(dictionarySubject("en", promoted.subjectKey, promoted.subjectVars));

    const reminder = await paymentReminderScenario();
    expect(dictionarySubject("fr", reminder.subjectKey, reminder.subjectVars)).not.toBe(dictionarySubject("en", reminder.subjectKey, reminder.subjectVars));

    const refund = await refundIssuedScenario();
    expect(dictionarySubject("es", refund.subjectKey, refund.subjectVars)).not.toBe(dictionarySubject("en", refund.subjectKey, refund.subjectVars));

    const solo = await soloSignupAssignedScenario();
    expect(dictionarySubject("fr", solo.subjectKey, solo.subjectVars)).not.toBe(dictionarySubject("en", solo.subjectKey, solo.subjectVars));

    const disputeAlert = await registrationDisputeAlertScenario();
    expect(dictionarySubject("fr", disputeAlert.subjectKey, disputeAlert.subjectVars)).not.toBe(
      dictionarySubject("en", disputeAlert.subjectKey, disputeAlert.subjectVars),
    );

    const disputeLost = await registrationDisputeLostScenario();
    expect(dictionarySubject("es", disputeLost.subjectKey, disputeLost.subjectVars)).not.toBe(
      dictionarySubject("en", disputeLost.subjectKey, disputeLost.subjectVars),
    );

    const invoice = await sponsorInvoiceScenario();
    expect(dictionarySubject("fr", invoice.subjectKey, invoice.subjectVars)).not.toBe(dictionarySubject("en", invoice.subjectKey, invoice.subjectVars));

    const receipt = await sponsorReceiptScenario();
    expect(dictionarySubject("nl", receipt.subjectKey, receipt.subjectVars)).not.toBe(dictionarySubject("en", receipt.subjectKey, receipt.subjectVars));

    const sponsorRefund = await sponsorRefundScenario();
    expect(dictionarySubject("es", sponsorRefund.subjectKey, sponsorRefund.subjectVars)).not.toBe(
      dictionarySubject("en", sponsorRefund.subjectKey, sponsorRefund.subjectVars),
    );

    const sponsorDisputeAlert = await sponsorDisputeAlertScenario();
    expect(dictionarySubject("fr", sponsorDisputeAlert.subjectKey, sponsorDisputeAlert.subjectVars)).not.toBe(
      dictionarySubject("en", sponsorDisputeAlert.subjectKey, sponsorDisputeAlert.subjectVars),
    );

    const sponsorDisputeWon = await sponsorDisputeWonScenario();
    expect(dictionarySubject("es", sponsorDisputeWon.subjectKey, sponsorDisputeWon.subjectVars)).not.toBe(
      dictionarySubject("en", sponsorDisputeWon.subjectKey, sponsorDisputeWon.subjectVars),
    );

    const sponsorDisputeLost = await sponsorDisputeLostScenario();
    expect(dictionarySubject("nl", sponsorDisputeLost.subjectKey, sponsorDisputeLost.subjectVars)).not.toBe(
      dictionarySubject("en", sponsorDisputeLost.subjectKey, sponsorDisputeLost.subjectVars),
    );

    const passRevoked = await passRevokedScenario();
    expect(dictionarySubject("nl", passRevoked.subjectKey, passRevoked.subjectVars)).not.toBe(
      dictionarySubject("en", passRevoked.subjectKey, { rung: dictionarySubject("en", "passRevoked.rung.m", {}) }),
    );

    const trialEnding = await trialEndingScenario();
    expect(dictionarySubject("fr", trialEnding.subjectKey, trialEnding.subjectVars)).not.toBe(
      dictionarySubject("en", trialEnding.subjectKey, trialEnding.subjectVars),
    );

    const verification = await emailVerificationScenario();
    expect(dictionarySubject("fr", verification.subjectKey, verification.subjectVars)).not.toBe(
      dictionarySubject("en", verification.subjectKey, verification.subjectVars),
    );

    const confirmation = await emailChangeConfirmationScenario();
    expect(dictionarySubject("es", confirmation.subjectKey, confirmation.subjectVars)).not.toBe(
      dictionarySubject("en", confirmation.subjectKey, confirmation.subjectVars),
    );

    const notice = await emailChangeNoticeScenario();
    expect(dictionarySubject("es", notice.subjectKey, notice.subjectVars)).not.toBe(dictionarySubject("en", notice.subjectKey, notice.subjectVars));

    const deletion = await accountDeletionScenario();
    expect(dictionarySubject("nl", deletion.subjectKey, deletion.subjectVars)).not.toBe(
      dictionarySubject("en", deletion.subjectKey, deletion.subjectVars),
    );

    const orgInvite = await orgInviteScenario();
    expect(dictionarySubject("fr", orgInvite.subjectKey, orgInvite.subjectVars)).not.toBe(
      dictionarySubject("en", orgInvite.subjectKey, orgInvite.subjectVars),
    );

    const claimInvite = await claimInviteScenario();
    expect(dictionarySubject("es", claimInvite.subjectKey, claimInvite.subjectVars)).not.toBe(
      dictionarySubject("en", claimInvite.subjectKey, claimInvite.subjectVars),
    );

    const officialInvite = await officialInviteScenario();
    expect(dictionarySubject("nl", officialInvite.subjectKey, officialInvite.subjectVars)).not.toBe(
      dictionarySubject("en", officialInvite.subjectKey, officialInvite.subjectVars),
    );

    const officialAssigned = await officialAssignedScenario();
    expect(dictionarySubject("es", officialAssigned.subjectKey, officialAssigned.subjectVars)).not.toBe(
      dictionarySubject("en", officialAssigned.subjectKey, officialAssigned.subjectVars),
    );

    const officialChanged = await officialAssignmentChangedScenario();
    expect(dictionarySubject("nl", officialChanged.subjectKey, officialChanged.subjectVars)).not.toBe(
      dictionarySubject("en", officialChanged.subjectKey, officialChanged.subjectVars),
    );

    const suspensionConfirmed = await suspensionConfirmedScenario();
    expect(dictionarySubject("es", suspensionConfirmed.subjectKey, suspensionConfirmed.subjectVars)).not.toBe(
      dictionarySubject("en", suspensionConfirmed.subjectKey, suspensionConfirmed.subjectVars),
    );

    const suspensionServed = await suspensionServedScenario();
    expect(dictionarySubject("nl", suspensionServed.subjectKey, suspensionServed.subjectVars)).not.toBe(
      dictionarySubject("en", suspensionServed.subjectKey, suspensionServed.subjectVars),
    );

    const matchReport = await matchReportSubmittedScenario();
    expect(dictionarySubject("fr", matchReport.subjectKey, matchReport.subjectVars)).not.toBe(
      dictionarySubject("en", matchReport.subjectKey, matchReport.subjectVars),
    );

    const transferOffer = await groupTransferOfferScenario();
    expect(dictionarySubject("es", transferOffer.subjectKey, transferOffer.subjectVars)).not.toBe(
      dictionarySubject("en", transferOffer.subjectKey, transferOffer.subjectVars),
    );

    const transferComplete = await groupTransferCompleteScenario();
    expect(dictionarySubject("fr", transferComplete.subjectKey, transferComplete.subjectVars)).not.toBe(
      dictionarySubject("en", transferComplete.subjectKey, transferComplete.subjectVars),
    );

    const orgRemoved = await groupOrgRemovedScenario();
    expect(dictionarySubject("fr", orgRemoved.subjectKey, orgRemoved.subjectVars)).not.toBe(
      dictionarySubject("en", orgRemoved.subjectKey, orgRemoved.subjectVars),
    );

    const orgLeft = await groupOrgLeftScenario();
    expect(dictionarySubject("nl", orgLeft.subjectKey, orgLeft.subjectVars)).not.toBe(dictionarySubject("en", orgLeft.subjectKey, orgLeft.subjectVars));

    const out = await forEachOutboxKind(
      {
        magic_link: magicLinkScenario(),
        chess_invite: chess,
        registration_confirmation: registration,
        payment_reminder: reminder,
        registration_promoted: promoted,
        refund_issued: refund,
        solo_signup_assigned: solo,
        registration_dispute_alert: disputeAlert,
        registration_dispute_lost: disputeLost,
        sponsor_invoice: invoice,
        sponsor_receipt: receipt,
        sponsor_refund: sponsorRefund,
        sponsor_dispute_alert: sponsorDisputeAlert,
        sponsor_dispute_won: sponsorDisputeWon,
        sponsor_dispute_lost: sponsorDisputeLost,
        pass_revoked: passRevoked,
        trial_ending: trialEnding,
        email_verification: verification,
        funnel_claim: funnelClaimScenario(),
        email_change_confirmation: confirmation,
        email_change_notice: notice,
        account_deletion: deletion,
        org_invite: orgInvite,
        claim_invite: claimInvite,
        official_invite: officialInvite,
        official_assigned: officialAssigned,
        official_assignment_changed: officialChanged,
        suspension_confirmed: suspensionConfirmed,
        suspension_served: suspensionServed,
        match_report_submitted: matchReport,
        group_transfer_offer: transferOffer,
        group_transfer_complete: transferComplete,
        group_org_removed: orgRemoved,
        group_org_left: orgLeft,
      },
      { notYetMoved: NOT_YET_MOVED, specFacts: SPEC_FACTS },
    );

    const moved = SPEC_KINDS.filter((k) => !NOT_YET_MOVED.includes(k));
    expect(out.checked, "anti-vacuity: every kind the spec lists that has moved was swept").toBe(SPEC_KINDS.length - NOT_YET_MOVED.length);
    expect(out.checked).toBeGreaterThan(0);
    expect(out.kinds, "and they are exactly the spec's moved kinds, in the spec's order").toEqual(moved);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The harness's own tests: every guard in it has a case that reaches it. A scenario here is hand-made on purpose (it is the harness
// that is under test, not a producer); `notYetMoved` is everything else so only the kind under test is judged.
// ---------------------------------------------------------------------------------------------------------------------------------

const except = (...kept: OutboxKind[]): OutboxKind[] => OUTBOX_KINDS.filter((k) => !kept.includes(k));

function row(over: Partial<OutboxMessage> & { to: string }): OutboxMessage {
  return {
    kind: "magic_link",
    refType: "login",
    refId: `${RUN}-${randomUUID()}`,
    orgId: null,
    subject: dictionarySubject("en", "magicLink.subject", {}),
    html: "<p>hi</p>",
    text: "hi",
    transactional: true,
    expiresAt: new Date(Date.now() + 15 * MIN),
    ...over,
  };
}

/** A magic_link scenario whose `run` is the given producer; everything else is the right answer. */
function handMade(over: Omit<Partial<KindScenario>, "run"> & { run: (to: string) => Promise<void> }): KindScenario {
  const recipient = over.recipient ?? address();
  const { run, ...rest } = over;
  return { locale: "en", subjectKey: "magicLink.subject", subjectVars: {}, recipient, firstAttempt: "request", ...rest, run: () => run(recipient) };
}

/** An account at exactly this address (an account kind's row is addressed to its account at send, so they must agree). Returns its id. */
async function accountAt(email: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'Sweep probe', true) returning id`;
  return u!.id;
}

/** A producer that writes the row and sends it in the request, as the real routes do. */
const sendsInRequest =
  (over: Partial<OutboxMessage> = {}) =>
  async (to: string): Promise<void> => {
    const id = await enqueueEmail(sql, row({ ...over, to }));
    await dispatchNow([id]);
  };

const swept = (scenarios: Partial<Record<OutboxKind, KindScenario>>, facts: KindFacts = SPEC_FACTS, notYetMoved?: readonly OutboxKind[]) =>
  forEachOutboxKind(scenarios, { notYetMoved: notYetMoved ?? except(...(Object.keys(scenarios) as OutboxKind[])), specFacts: facts });

describe.skipIf(!HAS_DB)("the harness judges what it says it judges (DB)", () => {
  afterEach(async () => {
    await cleanUp();
  });

  it("a kind with no scenario fails by name", async () => {
    await expect(forEachOutboxKind({}, { notYetMoved: [], specFacts: SPEC_FACTS })).rejects.toThrow(/no scenario for outbox kind magic_link/);
    // The name is the FIRST kind without one: give it a scenario and the next kind is named.
    await expect(forEachOutboxKind({ magic_link: handMade({ run: sendsInRequest() }) }, { notYetMoved: [], specFacts: SPEC_FACTS })).rejects.toThrow(
      /no scenario for outbox kind chess_invite/,
    );
  });

  it("a row whose transactional flag disagrees with the spec fails", async () => {
    const wrong = handMade({ run: sendsInRequest({ transactional: false }) });
    await expect(swept({ magic_link: wrong })).rejects.toThrow(/magic_link[\s\S]*transactional/);
    // The other direction: a kind the spec calls NOT transactional, written as transactional.
    const facts: KindFacts = { ...SPEC_FACTS, magic_link: ["literal", false] };
    await expect(swept({ magic_link: handMade({ run: sendsInRequest({ transactional: true }) }) }, facts)).rejects.toThrow(/magic_link[\s\S]*transactional/);
  });

  it("an account kind whose row names no account fails, and a literal kind whose row names one fails (both directions)", async () => {
    const chess = { kind: "chess_invite", refType: "fixture_seat" } as const;
    // Account kind, no id (the phase-1 shape the writer's own guard lets through on purpose).
    await expect(swept({ chess_invite: handMade({ run: sendsInRequest(chess) }) })).rejects.toThrow(/chess_invite[\s\S]*recipient_user_id/);
    // Literal in the spec's table, but the producer wrote an account id (the writer allows that for an account kind).
    const a = address();
    const withId = handMade({ recipient: a, run: sendsInRequest({ ...chess, recipientUserId: await accountAt(a) }) });
    await expect(swept({ chess_invite: withId }, { ...SPEC_FACTS, chess_invite: ["literal", true] })).rejects.toThrow(/chess_invite[\s\S]*recipient_user_id/);
    // The positive pair: the account kind WITH an id, the spec's own table, passes.
    const b = address();
    const good = handMade({ recipient: b, run: sendsInRequest({ ...chess, recipientUserId: await accountAt(b) }) });
    await expect(swept({ chess_invite: good })).resolves.toMatchObject({ checked: 1, kinds: ["chess_invite"] });
  });

  it("a staff kind is judged like a literal one: no account id (T2 m1; the first real staff kind arrives with wave 5)", async () => {
    const staff: KindFacts = { ...SPEC_FACTS, magic_link: ["staff", true], chess_invite: ["staff", true] };
    await expect(swept({ magic_link: handMade({ run: sendsInRequest() }) }, staff)).resolves.toMatchObject({ checked: 1 });
    const a = address();
    const named = handMade({ recipient: a, run: sendsInRequest({ kind: "chess_invite", refType: "fixture_seat", recipientUserId: await accountAt(a) }) });
    await expect(swept({ chess_invite: named }, staff)).rejects.toThrow(/chess_invite[\s\S]*recipient_user_id/);
  });

  it("a scenario that writes no row fails (at least one row is required)", async () => {
    await expect(swept({ magic_link: handMade({ run: async () => undefined }) })).rejects.toThrow(/magic_link[\s\S]*no outbox row/);
  });

  it("the recipient is matched case-insensitively (an address is the same mailbox in any case)", async () => {
    // The scenario names the lower-case address; the row is written to the upper-case one.
    const scenario = handMade({ recipient: address(), run: (to) => sendsInRequest()(to.toUpperCase()) });
    await expect(swept({ magic_link: scenario })).resolves.toMatchObject({ checked: 1 });
  });

  it("the subject must be the dictionary's, in the scenario's locale", async () => {
    const wrongKey = handMade({ subjectKey: "magicLink.title", run: sendsInRequest() });
    await expect(swept({ magic_link: wrongKey })).rejects.toThrow(/magic_link[\s\S]*subject/);
    // The right key in the wrong locale: the English row is not the Spanish dictionary's.
    const wrongLocale = handMade({ locale: "es", run: sendsInRequest() });
    await expect(swept({ magic_link: wrongLocale })).rejects.toThrow(/magic_link[\s\S]*subject/);
  });

  it("the mail is addressed to the scenario's recipient: an account that moved after the write and before the send is seen", async () => {
    const recipient = address();
    const userId = await accountAt(recipient);
    const moved = handMade({
      firstAttempt: "worker",
      recipient,
      run: async (to) => {
        await enqueueEmail(sql, row({ kind: "chess_invite", refType: "fixture_seat", recipientUserId: userId, to }));
        // The account's address changes before the worker sends: an account kind follows it (phase-3 spec section 6).
        await sql`update users set email = ${address()} where id = ${userId}`;
      },
    });
    await expect(swept({ chess_invite: moved })).rejects.toThrow(/chess_invite[\s\S]*another address/);
  });

  it("the stored subject and the sent subject are each judged (a producer that edits one after the other is seen both ways)", async () => {
    const right = dictionarySubject("en", "magicLink.subject", {});
    // The row says one thing and the mail said another: the row is rewritten after the send.
    const storedWrong = handMade({
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        await dispatchNow([id]);
        await sql`update email_outbox set subject = 'rewritten after the send' where id = ${id}`;
      },
    });
    await expect(swept({ magic_link: storedWrong })).rejects.toThrow(/magic_link[\s\S]*queued with subject/);
    // The mail said one thing and the row says another: the row is edited for the send and restored after it.
    const sentWrong = handMade({
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        await sql`update email_outbox set subject = 'edited for the send' where id = ${id}`;
        await dispatchNow([id]);
        await sql`update email_outbox set subject = ${right} where id = ${id}`;
      },
    });
    await expect(swept({ magic_link: sentWrong })).rejects.toThrow(/magic_link[\s\S]*was sent with subject/);
  });

  it("the transport is called exactly once per row: a second send of one row (a second path) fails", async () => {
    const twice = handMade({
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        await dispatchNow([id]);
        // The bypass shape: something else mails the same row's key again.
        await (await import("@/server/email-outbox/transport")).deliver(
          { to, subject: "again", html: "<p>x</p>", text: "x", transactional: true, idempotencyKey: idempotencyKey(id), tags: { outbox: id } },
          "re_x",
        );
      },
    });
    // Two calls, not "not exactly one": a row that never reached the transport says "0 times" in the same sentence.
    await expect(swept({ magic_link: twice })).rejects.toThrow(/outbox kind magic_link: row \S+ reached the transport 2 times, expected exactly once/);
  });

  it("a request-path kind is waited for: a producer that does not await its own dispatch still passes once the row is sent", async () => {
    deliverMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, providerId: `re_${RUN}_${randomUUID()}` };
    });
    const background = handMade({
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        void dispatchNow([id]); // the request returned; the send is still in flight
      },
    });
    const t0 = Date.now();
    await expect(swept({ magic_link: background })).resolves.toMatchObject({ checked: 1 });
    expect(Date.now() - t0, "premise: the producer really returned before the send finished").toBeGreaterThanOrEqual(300);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("a worker-path kind: the row waits queued with no attempt, then one tick sends it", async () => {
    const worker = handMade({
      firstAttempt: "worker",
      run: async (to) => {
        await enqueueEmail(sql, row({ to }));
      },
    });
    await expect(swept({ magic_link: worker })).resolves.toMatchObject({ checked: 1 });
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("a worker-path kind whose producer already sent the row fails (it said the worker sends first)", async () => {
    const eager = handMade({ firstAttempt: "worker", run: sendsInRequest() });
    await expect(swept({ magic_link: eager })).rejects.toThrow(/magic_link[\s\S]*queued/);
  });

  it("a worker-path kind whose row already had an attempt fails, even if the worker would take it (a first attempt is the worker's, once)", async () => {
    const retried = handMade({
      firstAttempt: "worker",
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        // The shape of a request that tried and was told 503: one attempt, due again now. The worker WOULD send it.
        await sql`update email_outbox set attempts = 1, next_attempt_at = now() - interval '1 second' where id = ${id}`;
      },
    });
    await expect(swept({ magic_link: retried })).rejects.toThrow(/magic_link[\s\S]*1 attempt/);
  });

  it("a request-path kind whose row is never attempted fails once the wait is up, naming the request's own attempt", async () => {
    // The producer wrote the row and returned; nothing ever sends it in the request (and the worker is not run for a request kind).
    const neverSent = handMade({ run: async (to) => void (await enqueueEmail(sql, row({ to }))) });
    const t0 = Date.now();
    await expect(
      forEachOutboxKind({ magic_link: neverSent }, { notYetMoved: except("magic_link"), specFacts: SPEC_FACTS, requestWaitMs: 400 }),
    ).rejects.toThrow(/outbox kind magic_link: the request's own attempt did not finish: 1 row\(s\) still queued or sending/);
    expect(Date.now() - t0, "it waited the wait it was given, not forever").toBeLessThan(10_000);
    expect(deliverMock, "and nothing was sent").not.toHaveBeenCalled();
  });

  it("the second call: a sent row stays untouched by dispatchNow again and by a tick that finds it due; a row that IS sendable is seen", async () => {
    const id = await enqueueEmail(sql, row({ to: address() }));
    await dispatchNow([id]);
    const [sent] = await sql<{ status: string }[]>`select status from email_outbox where id = ${id}`;
    expect(sent!.status, "premise: the first attempt sent it").toBe("sent");
    await expect(assertNothingMoreToSend("magic_link", [id])).resolves.toBeUndefined();
    expect(deliverMock, "the first send is the only one").toHaveBeenCalledTimes(1);

    // The same check over a row that has not been sent: the second call IS its first, and the check says so.
    const queued = await enqueueEmail(sql, row({ to: address() }));
    await expect(assertNothingMoreToSend("magic_link", [queued])).rejects.toThrow(/outbox kind magic_link: a second call sent 1 more time/);

    // A second call that sends nothing but ends a row (it expired between the calls) still changed it.
    const expiring = await enqueueEmail(sql, row({ to: address() }));
    await sql`update email_outbox set expires_at = now() - interval '1 minute' where id = ${expiring}`;
    await expect(assertNothingMoreToSend("magic_link", [expiring])).rejects.toThrow(/outbox kind magic_link: a second call changed the rows/);
  });

  it("a row that ended dead fails, though the transport was called once with the right subject (the provider's refusal is not a send)", async () => {
    deliverMock.mockImplementation(async () => ({ ok: false, reason: "http", status: 422, errorName: "validation_error", detail: "refused" }));
    await expect(swept({ magic_link: handMade({ run: sendsInRequest() }) })).rejects.toThrow(/magic_link[\s\S]*ended dead/);
  });

  it("a scenario given for something that is not a kind fails by name (a typo would otherwise be a sweep that never ran)", async () => {
    const typo = { magic_link: handMade({ run: sendsInRequest() }), "magic-link": handMade({ run: sendsInRequest() }) } as unknown as Partial<Record<OutboxKind, KindScenario>>;
    await expect(forEachOutboxKind(typo, { notYetMoved: except("magic_link"), specFacts: SPEC_FACTS })).rejects.toThrow(/magic-link/);
  });

  it("a scenario for a kind that is also listed as not yet moved fails (a stale entry would skip the sweep)", async () => {
    await expect(
      forEachOutboxKind({ magic_link: handMade({ run: sendsInRequest() }) }, { notYetMoved: OUTBOX_KINDS, specFacts: SPEC_FACTS }),
    ).rejects.toThrow(/magic_link[\s\S]*notYetMoved/);
  });

  it("a not-yet-moved entry that is not a kind fails, and so does a legend that omits a kind", async () => {
    await expect(forEachOutboxKind({}, { notYetMoved: ["magic-link" as OutboxKind, ...OUTBOX_KINDS], specFacts: SPEC_FACTS })).rejects.toThrow(/magic-link/);
    const { magic_link: _dropped, ...rest } = SPEC_FACTS;
    void _dropped;
    await expect(
      forEachOutboxKind({ magic_link: handMade({ run: sendsInRequest() }) }, { notYetMoved: except("magic_link"), specFacts: rest as unknown as KindFacts }),
    ).rejects.toThrow(/no spec fact for outbox kind magic_link/);
  });

  it("with every kind unmoved nothing is swept, and the count says so (zero is the caller's failure to refuse)", async () => {
    await expect(forEachOutboxKind({}, { notYetMoved: OUTBOX_KINDS, specFacts: SPEC_FACTS })).resolves.toEqual({ checked: 0, kinds: [] });
  });
});
