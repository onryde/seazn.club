// The A-kind body guard (phase 3 wave 1, T4).
//
// An email addressed to an ACCOUNT (`OUTBOX_KIND_FACTS[kind].to === "account"`) has its recipient decided when it is SENT
// (recipient.ts), and the body is sealed when it is QUEUED. If the sealed body named the address it was queued for, then a player who
// changed address in between would receive a mail that quotes the OLD address (or, worse, mail the old address's owner's details to
// the new one). So the body of an account kind must not carry the recipient's address at all: not in the subject, the html or the text.
//
// What is checked, and how:
//  - WHICH kinds are account kinds is the engine's own declaration (`OUTBOX_KIND_FACTS`), compared with a list typed here from the
//    spec (`chess_invite` and wave 2's seven). A new account kind is then a failure that asks for a decision here, not a quiet pass.
//  - Every account kind is swept through its real producer, except those in PRODUCERS_PENDING: wave 2's kinds, registered (T1) before
//    their producers moved. Each kind task (T2-T9) adds its producer and deletes its entry; T10 deletes the list.
//  - The bodies are the REAL producer's: `openRound` renders the invite with the real `externalPlayInviteEmail` (NOT replaced, unlike the
//    sibling suites: their stand-in puts the address in the body on purpose so the transport double can read it) and queues it. Only
//    the transport is replaced, and it answers 503 so every row stays `queued` with its sealed body. A row that had been sent has no
//    body left to open, and a guard over no bodies is the vacuous pass this file exists to avoid.
//  - The bodies are opened with the outbox's own `openBody` and the recipient's address (lower-cased, as the row stores it) must be
//    absent. A positive pair shows the bodies really were opened and are the kind's own mail (the invite carries the match link; a
//    registration dispute notice names the competition; a sponsor dispute notice names the package).
//  - The registration dispute notices are driven through the real `handleRegistrationDispute` on a card cart the real webhook confirmed.
//    Neither touches Stripe: the alert never does, and the lost notice's dispute names no charge, so the balance recovery is skipped.
//  - The sponsor dispute notices are driven through the real `handleSponsorDispute` on a paid sponsor order. The alert never touches
//    Stripe.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { OUTBOX_KIND_FACTS, OUTBOX_KINDS, type OutboxKind } from "../constants";
import { openBody } from "../seal";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { seedOnlineChessRound } from "@/server/usecases/__tests__/_external-play-seed";

vi.mock("@/server/email-outbox/transport", () => ({
  deliver: async () => ({ ok: false as const, reason: "http" as const, status: 503, errorName: "service_unavailable", detail: "later" }),
}));

import { openRound } from "@/server/usecases/external-play/open-round";
import { handleRegistrationCheckoutCompleted, handleRegistrationDispute } from "@/server/usecases/registrations";
import { handleSponsorDispute } from "@/server/usecases/sponsors";
import { seedSponsorOrder } from "@/server/usecases/__tests__/_money-fixtures";
import { fakeSession, seedRegistration, stripeRig } from "@/server/usecases/__tests__/_registration-fixtures";

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
];

/** Account kinds whose producer has not moved to the outbox yet, so there is no real producer to drive. Each kind task deletes its own
 *  entry when it adds its producer to PRODUCERS below; T10 deletes the list. */
const PRODUCERS_PENDING: readonly OutboxKind[] = [
  "sponsor_dispute_won",
  "sponsor_dispute_lost",
  "pass_revoked",
  "trial_ending",
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
  /** A pattern that matches `text` literally. */
  const literal = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  // One producer per account kind that has moved: the real code path that writes the kind's rows. It returns the ids of the rows it wrote
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
  };

  it("every account kind with a producer: the recipient's address is absent from the subject, the html and the text", async () => {
    const swept = SPEC_ACCOUNT_KINDS.filter((k) => !PRODUCERS_PENDING.includes(k));
    expect(Object.keys(PRODUCERS).sort(), "a producer for exactly the account kinds that are not pending").toEqual([...swept].sort());
    let kindsChecked = 0;
    let rowsChecked = 0;
    for (const kind of swept) {
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
    expect(kindsChecked, "every account kind that is not pending was checked").toBe(SPEC_ACCOUNT_KINDS.length - PRODUCERS_PENDING.length);
    expect(kindsChecked, "anti-vacuity: at least one account kind was swept").toBeGreaterThan(0);
    expect(rowsChecked, "anti-vacuity: bodies were opened, at least one per kind").toBeGreaterThanOrEqual(kindsChecked);
  });
});
