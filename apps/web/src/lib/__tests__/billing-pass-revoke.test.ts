// P0-3a (payments hardening): a fully-refunded Event Pass charge — including a
// refund made straight from the Stripe dashboard — must revoke the pass so the
// competition rejoins the plan's active-competition allowance, and the org
// owner is told (phase 3 wave 2, email 9: a `pass_revoked` row on the email
// outbox, queued in the revoke's own transaction). Partial refunds and
// non-pass charges leave every pass untouched. Real Postgres required; skipped
// without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// The one network seam of the outbox (the worker never runs here: the notice
// waits for it, so nothing is delivered either way).
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

import { sql, type Tx } from "@/lib/db";
import { revokePassForRefundedCharge } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { openBody } from "@/server/email-outbox/seal";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { cleanUpSponsorOrgs, seedPassOrg } from "@/server/usecases/__tests__/_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
/** Run-unique: the once-key index is global, so a fixed charge id would meet an earlier run's row. */
const RUN = randomUUID().slice(0, 8);

const chargeFor = (intent: string, refunded: boolean) =>
  ({ payment_intent: intent, refunded }) as unknown as Stripe.Charge;

/** A charge.refunded Stripe event as the webhook/replay path sees it. The
 *  charge carries its id, as every Stripe charge does: the notice's ref and
 *  once-key. */
const chargeRefundedEvent = (intent: string, over: Partial<Stripe.Charge> = {}) =>
  ({
    type: "charge.refunded",
    data: { object: { id: `ch_${intent}`, payment_intent: intent, refunded: true, amount_refunded: 500, ...over } },
  }) as unknown as Stripe.Event;

/** Sibling-suite seeding style (billing-sync-trial): a fresh org + competition,
 *  the only two FK parents a competition_passes row needs. */
async function seedOrgWithComp(): Promise<{ orgId: string; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pass Org " + suffix}, ${"pass-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Pass Cup " + suffix}, ${"pass-cup-" + suffix}) returning id`;
  return { orgId, compId };
}

const made = { orgIds: [] as string[], userIds: [] as string[] };

/** `seedPassOrg` (the owner by membership is NOT `created_by`, which is a
 *  trap), its organisation and both accounts tracked for cleanup. */
async function passOrg(intent: string, passKey?: "event_pass" | "event_pass_l") {
  const o = await seedPassOrg({ intent, passKey });
  made.orgIds.push(o.orgId);
  made.userIds.push(o.ownerId, o.trapId);
  return o;
}

/** The pass notices queued about these charges (every status). */
const noticesFor = (chargeIds: string[]) =>
  sql<{ id: string; recipient: string; recipient_user_id: string | null; subject: string; body_sealed: Buffer | null }[]>`
    select id, recipient, recipient_user_id, subject, body_sealed from email_outbox
     where kind = 'pass_revoked' and ref_id = any(${chargeIds}::text[])`;

const passOf = async (intent: string) =>
  (await sql`select 1 from competition_passes where stripe_payment_intent = ${intent}`)[0];

beforeEach(() => {
  stubOutboxEnv();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await cleanUpSponsorOrgs(made.orgIds, made.userIds);
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("revokePassForRefundedCharge", () => {
  it("deletes the pass when its charge is fully refunded", async () => {
    const { orgId, compId } = await seedOrgWithComp(); // sibling-suite seeding style
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_pass_r1')`;
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r1", true))).toBe(true);
    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeUndefined();
  });

  it("ignores partial refunds and non-pass charges", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_pass_r2')`;
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r2", false))).toBe(false);
    expect(await revokePassForRefundedCharge(chargeFor("pi_other", true))).toBe(false);
    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeTruthy();
  });

  it("is idempotent — a replayed full refund revokes nothing the second time", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_pass_r3')`;
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r3", true))).toBe(true);
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r3", true))).toBe(false);
  });

  it("inRevoke runs inside the delete's transaction, and only when a pass was deleted", async () => {
    // Email 9's seam (P-W2-7): the caller's notice is written by `inRevoke` on
    // the transaction that deletes the pass, so the notice exists exactly when
    // the revoke does (R1). lib/billing.ts knows nothing of the outbox.
    const { orgId, compId } = await seedOrgWithComp();
    const intent = `pi_pass_seam_${RUN}`;
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, ${intent})`;

    // A callback that throws takes the delete down with it: the pass is still there.
    await expect(
      revokePassForRefundedCharge(chargeFor(intent, true), {
        inRevoke: async () => {
          throw new Error("the caller refused");
        },
      }),
    ).rejects.toThrow("the caller refused");
    expect(await passOf(intent), "a refused inRevoke leaves the pass").toBeTruthy();

    // Called once, with the row the delete returned, while the delete is not yet committed: the
    // transaction it is handed no longer sees the pass, and the pool still does.
    const calls: { revoked: { org_id: string; competition_id: string }; onTx: unknown; onPool: unknown }[] = [];
    const inRevoke = async (tx: Tx, revoked: { org_id: string; competition_id: string }) => {
      const [onTx] = await tx`select 1 from competition_passes where stripe_payment_intent = ${intent}`;
      const [onPool] = await sql`select 1 from competition_passes where stripe_payment_intent = ${intent}`;
      calls.push({ revoked, onTx, onPool });
    };
    expect(await revokePassForRefundedCharge(chargeFor(intent, true), { inRevoke })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.revoked).toEqual({ org_id: orgId, competition_id: compId });
    expect(calls[0]!.onTx, "the callback runs after the delete, on its transaction").toBeUndefined();
    expect(calls[0]!.onPool, "and before the commit").toBeTruthy();
    expect(await passOf(intent), "committed: the pass is gone").toBeUndefined();

    // Nothing deleted, nothing called: the same charge again, a partial refund, a charge that bought no pass.
    expect(await revokePassForRefundedCharge(chargeFor(intent, true), { inRevoke })).toBe(false);
    expect(await revokePassForRefundedCharge(chargeFor(intent, false), { inRevoke })).toBe(false);
    expect(await revokePassForRefundedCharge(chargeFor(`pi_pass_none_${RUN}`, true), { inRevoke })).toBe(false);
    expect(calls, "never called without a deleted pass").toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("charge.refunded dispatch → revoke + owner notice", () => {
  it("revokes the pass and queues the notice to the org owner (via org_members, not created_by)", async () => {
    const intent = `pi_pass_int1_${RUN}`;
    const { compId, compName, ownerId, ownerEmail, trapId } = await passOrg(intent);

    await processStripeEvent(chargeRefundedEvent(intent));

    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeUndefined();
    const notices = await noticesFor([`ch_${intent}`]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.recipient).toBe(ownerEmail);
    expect(notices[0]!.recipient_user_id, "the owner by membership").toBe(ownerId);
    expect(notices[0]!.recipient_user_id, "never created_by").not.toBe(trapId);
    // The owner's account has no language and the org's default is en.
    const rungM = dictionarySubject("en", "passRevoked.rung.m", {});
    expect(notices[0]!.subject).toBe(dictionarySubject("en", "passRevoked.subject", { rung: rungM }));
    expect(openBody(notices[0]!.body_sealed!).text, "the notice names the competition").toContain(compName);
  });

  it("tells an L buyer which pass was refunded, not the product family", async () => {
    // v17 #294, and the last surface still telling the CUSTOMER the wrong
    // thing: `revokePassForRefundedChargeAndNotify` selected the org and the
    // competition but never `pass_key`, so an org refunded on a $59 Event Pass
    // L was emailed about the $29 product. The row is read BEFORE the revoke
    // deletes it, which is the only moment the rung is still available.
    const intent = `pi_pass_l1_${RUN}`;
    await passOrg(intent, "event_pass_l");

    await processStripeEvent(chargeRefundedEvent(intent));

    const notices = await noticesFor([`ch_${intent}`]);
    expect(notices).toHaveLength(1);
    const rungL = dictionarySubject("en", "passRevoked.rung.l", {});
    expect(rungL, "premise: the two rungs read differently").not.toBe(dictionarySubject("en", "passRevoked.rung.m", {}));
    expect(notices[0]!.subject).toBe(dictionarySubject("en", "passRevoked.subject", { rung: rungL }));
  });

  it("a partial refund through the dispatch leaves the pass and queues no notice", async () => {
    const intent = `pi_pass_int2_${RUN}`;
    const { compId } = await passOrg(intent);

    await processStripeEvent(chargeRefundedEvent(intent, { refunded: false }));

    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeTruthy();
    expect(await noticesFor([`ch_${intent}`])).toHaveLength(0);
  });
});
