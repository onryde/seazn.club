// The A-kind body guard (phase 3 wave 1, T4).
//
// An email addressed to an ACCOUNT (`OUTBOX_KIND_FACTS[kind].to === "account"`) has its recipient decided when it is SENT
// (recipient.ts), and the body is sealed when it is QUEUED. If the sealed body named the address it was queued for, then a player who
// changed address in between would receive a mail that quotes the OLD address (or, worse, mail the old address's owner's details to
// the new one). So the body of an account kind must not carry the recipient's address at all: not in the subject, the html or the text.
//
// What is checked, and how:
//  - WHICH kinds are account kinds is the engine's own declaration (`OUTBOX_KIND_FACTS`), compared with a list typed here from the
//    spec (`chess_invite`, wave 2's seven and wave 4's seven). A new account kind is then a failure that asks for a decision here, not a
//    quiet pass.
//  - Every account kind that has moved is swept through its real producer. Wave 2's T1 registered its kinds before their producers moved,
//    each kind task (T2-T9) added its producer here, and T10 deleted the list of the pending ones. Wave 4's T1 registered its seven
//    account kinds the same way, with no pending list here: the kinds not swept yet are the ones NOT_YET_MOVED names (_kind-senders.ts,
//    the one authority for "not moved yet"), and each kind task adds its producer here in the commit that deletes the kind from that list.
//  - The bodies are the REAL producer's: `openRound` renders the invite with the real `externalPlayInviteEmail` (NOT replaced, unlike the
//    sibling suites: their stand-in puts the address in the body on purpose so the transport double can read it) and queues it. Only
//    the transport is replaced, and it answers 503 so every row stays `queued` with its sealed body. A row that had been sent has no
//    body left to open, and a guard over no bodies is the vacuous pass this file exists to avoid.
//  - The bodies are opened with the outbox's own `openBody` and the recipient's address (lower-cased, as the row stores it) must be
//    absent. A positive pair shows the bodies really were opened and are the kind's own mail (the invite carries the match link; a
//    registration dispute notice names the competition; a sponsor dispute notice names the package; a pass notice names the competition;
//    a trial warning links to the billing page).
//  - The registration dispute notices are driven through the real `handleRegistrationDispute` on a card cart the real webhook confirmed.
//    Neither touches Stripe: the alert never does, and the lost notice's dispute names no charge, so the balance recovery is skipped.
//  - The sponsor dispute notices are driven through the real `handleSponsorDispute` on a paid sponsor order. None touches Stripe: the
//    alert and the won notice never do, and the lost notice's dispute names no charge, so the balance recovery is skipped.
//  - The pass notice is driven through the real `processStripeEvent` (`charge.refunded`, a full refund) on an Event Pass. The revoke and
//    the notice read the database only; the other refund handlers no-op on a pass charge (their one Stripe lookup needs a Stripe key).
//  - The trial warning is driven through the real `processStripeEvent` (`customer.subscription.trial_will_end`) on a trialing billing
//    group. Nothing reaches Stripe: the group is found by the subscription id it stores.
//  - The suspension notices are driven through the real discipline producers on a football division with a unique name (the positive
//    pair) whose player is claimed by a fresh account: the confirmed notice through `decideSuspension` (confirm). Its request makes the
//    first attempt, which the transport refuses (503), so the row is judged once that attempt is over and it is queued again. The
//    served notice through `refreshDiscipline` on a decided fixture that serves the ban; it waits for the worker, queued.
//  - The report notice is driven through the real `submitMyReport` of a claimed official (a unique name, the positive pair) on a football
//    division: one row per owner and admin, judged once the request's refused (503) first attempt is over.
//  - The billing-group transfer offer is driven through the real `offerGroupTransfer` of a live group to the owner of one of its orgs.
//    It mints a SetupIntent before it queues its notice: while that producer runs, and only then, Stripe is a stub that answers that one
//    call (every other producer meets the real `getStripe`, as before). Judged once the request's refused (503) first attempt is over.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { OUTBOX_KIND_FACTS, OUTBOX_KINDS, type OutboxKind } from "../constants";
import { openBody } from "../seal";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { seedOnlineChessRound } from "@/server/usecases/__tests__/_external-play-seed";
import { NOT_YET_MOVED } from "./_kind-senders";

vi.mock("@/server/email-outbox/transport", () => ({
  deliver: async () => ({ ok: false as const, reason: "http" as const, status: 503, errorName: "service_unavailable", detail: "later" }),
}));
const stripeSeam = vi.hoisted(() => ({ offering: false }));
vi.mock("@/lib/stripe", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/stripe")>();
  const offerStub = {
    setupIntents: {
      create: async () => {
        const id = `seti_akb_${crypto.randomUUID().slice(0, 8)}`;
        return { id, client_secret: `${id}_secret` };
      },
    },
  } as unknown as ReturnType<typeof real.getStripe>;
  return { ...real, getStripe: () => (stripeSeam.offering ? offerStub : real.getStripe()) };
});

import { openRound } from "@/server/usecases/external-play/open-round";
import { handleRegistrationCheckoutCompleted, handleRegistrationDispute } from "@/server/usecases/registrations";
import { handleSponsorDispute } from "@/server/usecases/sponsors";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { seedLiveGroup, seedPassOrg, seedSponsorOrder, seedTrialingGroup } from "@/server/usecases/__tests__/_money-fixtures";
import { offerGroupTransfer } from "@/server/usecases/billing-groups";
import { fakeSession, seedRegistration, stripeRig } from "@/server/usecases/__tests__/_registration-fixtures";
import { claimPerson, makeAssignment, makeClaimedOfficial, makeFixture, seedFootballDivision } from "@/server/usecases/__tests__/_seed";
import { putMyReport, submitMyReport } from "@/server/usecases/match-reports";
import { refreshDiscipline } from "@/server/usecases/scoring";
import { createManualSuspension, decideSuspension } from "@/server/usecases/discipline";

const HAS_DB = !!process.env.DATABASE_URL;

/** Typed from the spec (phase 3, the kind table's "To" column, A): the kinds whose recipient is an account, in the table's order. */
const SPEC_ACCOUNT_KINDS: readonly OutboxKind[] = [
  "chess_invite",
  "registration_dispute_alert",
  "registration_dispute_lost",
  "sponsor_dispute_alert",
  "sponsor_dispute_won",
  "sponsor_dispute_lost",
  "pass_revoked",
  "trial_ending",
  // Wave 4, in the table's order.
  "suspension_confirmed",
  "suspension_served",
  "match_report_submitted",
  "group_transfer_offer",
  "group_transfer_complete",
  "group_org_removed",
  "group_org_left",
];

beforeEach(() => stubOutboxEnv());
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe("which kinds are addressed to an account (no database)", () => {
  it("the declared account kinds are exactly the spec's list", () => {
    const declared = OUTBOX_KINDS.filter((k) => OUTBOX_KIND_FACTS[k].to === "account");
    expect([...declared].sort()).toEqual([...SPEC_ACCOUNT_KINDS].sort());
    // The sweep below covers every account kind through a real producer; this pins that each has one.
    expect(declared.length, "anti-vacuity: at least one account kind").toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("an account kind's sealed body never names its recipient (real producer, real renderer)", () => {
  /** A card-paid entry (the real webhook confirmed it) in a fresh org: its competition's name and the payment intent its cart carries. */
  async function disputableEntry(): Promise<{ competitionName: string; intent: string }> {
    const w = await stripeRig({ feeCents: 900 });
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: `akb-${randomUUID().slice(0, 8)}@test.local` });
    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 900));
    const [cart] = await sql<{ payment_intent_id: string | null }[]>`select payment_intent_id from registration_groups where id = ${registration.group_id}`;
    expect(cart!.payment_intent_id, "premise: the paid cart carries its payment intent").toBeTruthy();
    return { competitionName: w.competition.name, intent: cart!.payment_intent_id! };
  }
  const rowIdsOf = async (kind: OutboxKind, disputeId: string): Promise<string[]> =>
    (await sql<{ id: string }[]>`select id from email_outbox where kind = ${kind} and ref_id = ${disputeId}`).map((x) => x.id);
  /** The rows of `kind` about `refType / refId` once the request's own first attempt (a deferred `dispatchNow`, answered 503 here)
   *  is over: every row attempted and back to `queued` with its sealed body, so the guard below judges a body that is still there. */
  const attemptedRowIdsOf = async (kind: OutboxKind, refType: string, refId: string): Promise<string[]> => {
    let ids: string[] = [];
    await vi.waitFor(
      async () => {
        const rows = await sql<{ id: string; status: string; attempts: number }[]>`
          select id, status, attempts from email_outbox where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}`;
        expect(rows.length, `premise: the ${kind} producer wrote a row`).toBeGreaterThan(0);
        expect(rows.filter((r) => r.status !== "queued" || r.attempts < 1), `the ${kind} request's first attempt is over`).toEqual([]);
        ids = rows.map((r) => r.id);
      },
      { timeout: 15_000, interval: 100 },
    );
    return ids;
  };
  /** A football division with a unique name (the suspension notices' positive pair) and its player X claimed by a fresh account. */
  const claimedFootballDivision = async () => {
    const ctx = await seedFootballDivision();
    const divisionName = `Division ${randomUUID().slice(0, 8)}`;
    await sql`update divisions set name = ${divisionName} where id = ${ctx.divisionId}`;
    await claimPerson(ctx.personX, `akb-${randomUUID().slice(0, 8)}@test.local`);
    return { ctx, divisionName };
  };
  /** A pattern that matches `text` literally. */
  const literal = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  // One producer per account kind: the real code path that writes the kind's rows. It returns the ids of the rows it wrote
  // and a pattern the kind's own body must carry (the positive pair: an empty or unreadable body would pass every absence check).
  const PRODUCERS: Readonly<Partial<Record<OutboxKind, () => Promise<{ rowIds: string[]; positive: RegExp }>>>> = {
    chess_invite: async () => {
      const r = await seedOnlineChessRound({ fixtures: 2 });
      const out = await openRound({ stageId: r.stageId, roundNo: r.roundNo, actorUserId: r.ownerUserId });
      expect(out, "premise: the real open invited the round").toMatchObject({ opened: true });
      const fixtureIds = r.boards.map((b) => b.fixtureId);
      const rows = await sql<{ id: string }[]>`
        select id from email_outbox where kind = 'chess_invite' and split_part(ref_id, ':', 1) = any(${fixtureIds}::text[])`;
      expect(rows.length, "anti-vacuity: the chess_invite producer wrote a row per seat").toBeGreaterThanOrEqual(2);
      // The invite carries the match link.
      return { rowIds: rows.map((x) => x.id), positive: /href="https?:\/\// };
    },
    registration_dispute_alert: async () => {
      const { competitionName, intent } = await disputableEntry();
      const disputeId = `dp_akb_${randomUUID().slice(0, 12)}`;
      const dispute = { id: disputeId, payment_intent: intent, amount: 900, status: "needs_response" } as unknown as Stripe.Dispute;
      expect(await handleRegistrationDispute(dispute, "created"), "premise: the real handler matched the entry-fee charge").toBe(true);
      // The alert names the competition the disputed entry belongs to.
      return { rowIds: await rowIdsOf("registration_dispute_alert", disputeId), positive: literal(competitionName) };
    },
    registration_dispute_lost: async () => {
      const { competitionName, intent } = await disputableEntry();
      const disputeId = `dp_akb_${randomUUID().slice(0, 12)}`;
      // No `charge`: the balance recovery is skipped, so nothing reaches Stripe.
      const dispute = { id: disputeId, payment_intent: intent, amount: 900, status: "lost" } as unknown as Stripe.Dispute;
      expect(await handleRegistrationDispute(dispute, "closed"), "premise: the real handler matched the entry-fee charge").toBe(true);
      // The notice names the competition the written-off entry belongs to.
      return { rowIds: await rowIdsOf("registration_dispute_lost", disputeId), positive: literal(competitionName) };
    },
    sponsor_dispute_alert: async () => {
      const o = await seedSponsorOrder({ status: "paid" });
      const disputeId = `dp_akb_${randomUUID().slice(0, 12)}`;
      const dispute = { id: disputeId, payment_intent: o.intent, amount: 25000, status: "needs_response" } as unknown as Stripe.Dispute;
      expect(await handleSponsorDispute(dispute, "created"), "premise: the real handler matched the sponsor's charge").toBe(true);
      // The alert names the package the disputed payment bought.
      return { rowIds: await rowIdsOf("sponsor_dispute_alert", disputeId), positive: literal(o.packageName) };
    },
    sponsor_dispute_won: async () => {
      const o = await seedSponsorOrder({ status: "paid" });
      const disputeId = `dp_akb_${randomUUID().slice(0, 12)}`;
      const dispute = (status: string) => ({ id: disputeId, payment_intent: o.intent, amount: 25000, status }) as unknown as Stripe.Dispute;
      expect(await handleSponsorDispute(dispute("needs_response"), "created"), "premise: the real handler flagged the sponsor's order").toBe(true);
      expect(await handleSponsorDispute(dispute("won"), "closed"), "premise: the real handler matched the sponsor's charge").toBe(true);
      // The notice names the package the disputed payment bought.
      return { rowIds: await rowIdsOf("sponsor_dispute_won", disputeId), positive: literal(o.packageName) };
    },
    sponsor_dispute_lost: async () => {
      const o = await seedSponsorOrder({ status: "paid" });
      const disputeId = `dp_akb_${randomUUID().slice(0, 12)}`;
      // No `charge`: the balance recovery is skipped, so nothing reaches Stripe.
      const dispute = { id: disputeId, payment_intent: o.intent, amount: 25000, status: "lost" } as unknown as Stripe.Dispute;
      expect(await handleSponsorDispute(dispute, "closed"), "premise: the real handler matched the sponsor's charge").toBe(true);
      // The notice names the package the written-off payment bought.
      return { rowIds: await rowIdsOf("sponsor_dispute_lost", disputeId), positive: literal(o.packageName) };
    },
    pass_revoked: async () => {
      const intent = `pi_akb_${randomUUID().slice(0, 12)}`;
      const chargeId = `ch_akb_${randomUUID().slice(0, 12)}`;
      const o = await seedPassOrg({ intent });
      const charge = { id: chargeId, payment_intent: intent, refunded: true, amount_refunded: 2900 };
      const event = { id: `evt_akb_${randomUUID().slice(0, 12)}`, type: "charge.refunded", data: { object: charge } };
      await processStripeEvent(event as unknown as Stripe.Event);
      // The notice names the competition the refunded pass was for.
      return { rowIds: await rowIdsOf("pass_revoked", chargeId), positive: literal(o.compName) };
    },
    trial_ending: async () => {
      const g = await seedTrialingGroup({ hasPaymentMethod: false });
      const trialEnd = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
      const sub = { id: g.stripeSubId, object: "subscription", status: "trialing", trial_end: trialEnd, metadata: {} };
      const event = { id: `evt_akb_${randomUUID().slice(0, 12)}`, type: "customer.subscription.trial_will_end", data: { object: sub } };
      await processStripeEvent(event as unknown as Stripe.Event);
      // The warning links to the billing page, where the payer adds a card or cancels.
      return { rowIds: await rowIdsOf("trial_ending", g.groupId), positive: /\/settings\/billing/ };
    },
    suspension_confirmed: async () => {
      const { ctx, divisionName } = await claimedFootballDivision();
      const ban = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 2, reason: "violent conduct" });
      expect((await decideSuspension(ctx.auth, ban.id, { kind: "confirm" })).status, "premise: the real confirm made the ban live").toBe("active");
      // The notice names the division the ban is in.
      return { rowIds: await attemptedRowIdsOf("suspension_confirmed", "suspension", ban.id), positive: literal(divisionName) };
    },
    suspension_served: async () => {
      const { ctx, divisionName } = await claimedFootballDivision();
      const ban = await createManualSuspension(ctx.auth, ctx.divisionId, { personId: ctx.personX, matchesTotal: 1, reason: "violent conduct" });
      await decideSuspension(ctx.auth, ban.id, { kind: "confirm" });
      // A decided fixture of the banned team, after the ban: the score write's fold serves it.
      const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
      await sql`
        insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
        values (${fx}, ${ctx.orgId}, 1, 'core.note', ${sql.json({ text: "d" })}, now() + interval '1 hour')`;
      await refreshDiscipline(ctx.auth, fx);
      const rows = await sql<{ id: string }[]>`
        select id from email_outbox where kind = 'suspension_served' and ref_type = 'suspension' and ref_id = ${ban.id}`;
      // The notice names the division the ban was served in.
      return { rowIds: rows.map((x) => x.id), positive: literal(divisionName) };
    },
    match_report_submitted: async () => {
      const ctx = await seedFootballDivision();
      const ref = await makeClaimedOfficial(ctx);
      const officialName = `Official ${randomUUID().slice(0, 8)}`;
      await sql`update officials set display_name = ${officialName} where id = ${ref.officialId}`;
      const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
      await putMyReport(ref.userId, fixtureOfficialId, { body: "a quiet game", incidents: [] });
      const report = await submitMyReport(ref.userId, fixtureOfficialId);
      // The notice names the official who filed the report.
      return { rowIds: await attemptedRowIdsOf("match_report_submitted", "match_report", report.id), positive: literal(officialName) };
    },
    group_transfer_offer: async () => {
      const g = await seedLiveGroup({ prefix: "akb" });
      stripeSeam.offering = true;
      try {
        const out = await offerGroupTransfer({ actorUserId: g.payer.id, subscriptionId: g.groupId, newOwnerUserId: g.heir.id });
        expect(out.status, "premise: the real offer went live").toBe("pending_card");
      } finally {
        stripeSeam.offering = false;
      }
      // The notice names the group by the org the recipient can reach.
      return { rowIds: await attemptedRowIdsOf("group_transfer_offer", "subscription", g.groupId), positive: literal(g.orgName) };
    },
  };

  it("every account kind that has moved: the recipient's address is absent from the subject, the html and the text", async () => {
    // A kind still on its direct sender writes no row to judge yet; NOT_YET_MOVED says which, so a kind task that moves one and forgets
    // its producer here (or adds a producer while the kind is still listed) fails the comparison below.
    const moved = SPEC_ACCOUNT_KINDS.filter((k) => !NOT_YET_MOVED.includes(k));
    expect(Object.keys(PRODUCERS).sort(), "a producer for exactly the account kinds that have moved").toEqual([...moved].sort());
    let kindsChecked = 0;
    let rowsChecked = 0;
    for (const kind of moved) {
      const { rowIds, positive } = await PRODUCERS[kind]!();
      const rows = await sql<{ id: string; recipient: string; recipient_user_id: string | null; subject: string; status: string; body_sealed: Buffer | null }[]>`
        select id, recipient, recipient_user_id, subject, status, body_sealed
          from email_outbox
         where kind = ${kind} and id = any(${rowIds}::uuid[])`;
      expect(rows.length, `anti-vacuity: the ${kind} producer's rows were found`).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.status, `premise: ${kind} row still holds its sealed body`).toBe("queued");
        expect(row.body_sealed, `premise: ${kind} row has a body to open`).not.toBeNull();
        expect(row.recipient_user_id, `premise: the row is an account's`).not.toBeNull();
        const body = openBody(row.body_sealed!);
        const address = row.recipient.toLowerCase();
        expect(address, "premise: the address is a real one").toMatch(/@/);
        expect(row.subject.toLowerCase(), `${kind}: subject`).not.toContain(address);
        expect(body.html.toLowerCase(), `${kind}: html`).not.toContain(address);
        expect(body.text.toLowerCase(), `${kind}: text`).not.toContain(address);
        // The positive pair: this is the kind's own mail, opened. An empty or unreadable body would pass the three checks above.
        expect(body.text.length, `${kind}: the text really was opened`).toBeGreaterThan(20);
        expect(positive.test(body.text) || positive.test(body.html), `${kind}: the body carries ${positive}`).toBe(true);
        rowsChecked += 1;
      }
      kindsChecked += 1;
    }
    expect(kindsChecked, "every account kind that has moved was checked").toBe(moved.length);
    expect(kindsChecked, "anti-vacuity: at least one account kind was swept").toBeGreaterThan(0);
    expect(rowsChecked, "anti-vacuity: bodies were opened, at least one per kind").toBeGreaterThanOrEqual(kindsChecked);
  });
});
