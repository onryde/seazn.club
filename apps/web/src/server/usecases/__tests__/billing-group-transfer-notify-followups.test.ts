// Follow-ups to the billing-group transfer notifications (PR #227):
//
//  1. The offer notice's link must target an org the RECIPIENT can actually reach —
//     an org IN THE GROUP they are a member of — not the group's oldest org,
//     which they may not be able to open.
//  2. The COMMUNITY (immediate) handover path must also email the recipient, with
//     a DIFFERENT, informational message ("you now pay for this group"). It must
//     be best-effort: a throw cannot fail the transfer.
//
// The offer notice is queued on the email outbox (phase 3 wave 4, kind `group_transfer_offer`); its builder `transferOfferEmail` is
// WRAPPED, never replaced, so the spy reads the link the real render was given. Only the outbox transport is a double.
//
// Own fixture port (12119) so it never contends with the other transfer suites.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";
process.env.STRIPE_MOCK_PORT = "12119";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The offer's builder, wrapped; the complete notice's direct sender, steered.
const { mail, sendTransferCompleteEmail } = vi.hoisted(() => ({
  mail: { offer: vi.fn<typeof import("@/lib/email").transferOfferEmail>() },
  sendTransferCompleteEmail: vi.fn<
    (to: string, payerName: string, groupName: string, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  mail.offer.mockImplementation(actual.transferOfferEmail);
  return { ...actual, transferOfferEmail: mail.offer, sendTransferCompleteEmail };
});
// The outbox's one network seam: captured, never sent.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { offerGroupTransfer } from "@/server/usecases/billing-groups";
import {
  startStripeFixtureServer,
  type StripeFixtureServer,
} from "../../../../e2e/stripe-fixture-server";
import { stubOutboxEnv } from "./_invite-mail";
import { seedCommunityGroup, seedLiveGroupTwoOrgs as seedLiveGroupTwoOrgsRows } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
let fixture: StripeFixtureServer;

/** A live pro group with TWO orgs: the OLDEST (primary) org owned by the payer,
 *  and a NEWER org the recipient is a member of. The recipient-reachable link
 *  must pick the newer, recipient-owned org — proving it is not just "oldest". */
async function seedLiveGroupTwoOrgs() {
  const g = await seedLiveGroupTwoOrgsRows();
  fixture.setSetupIntentCustomer(g.customer);
  return g;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer(12119);
});
afterAll(async () => {
  await fixture?.close();
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});
beforeEach(() => {
  stubOutboxEnv();
  mail.offer.mockClear();
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_fnu_${crypto.randomUUID()}` }));
  sendTransferCompleteEmail.mockReset();
  sendTransferCompleteEmail.mockResolvedValue(true);
});

describe.skipIf(!HAS_DB)("Follow-up 1: offer email link targets a recipient-reachable org", () => {
  it("uses the slug of an org the recipient is a member of, not the group's oldest org", async () => {
    const { payer, heir, groupId, primarySlug, recipSlug } = await seedLiveGroupTwoOrgs();

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("pending_card");

    expect(mail.offer).toHaveBeenCalledTimes(1);
    const [{ link }] = mail.offer.mock.calls[0]!;
    expect(link).toContain(`/o/${recipSlug}/settings/billing`);
    expect(link).not.toContain(primarySlug);
    // ...and the notice carrying it is the recipient's.
    const [row] = await sql<{ recipient_user_id: string | null }[]>`
      select recipient_user_id from email_outbox where kind = 'group_transfer_offer' and ref_type = 'subscription' and ref_id = ${groupId}`;
    expect(row?.recipient_user_id).toBe(heir.id);
  });
});

describe.skipIf(!HAS_DB)("Follow-up 2: community handover emails the recipient", () => {
  it("sends the transfer-complete email to the recipient after an immediate handover", async () => {
    const { payer, heir, groupId, slug } = await seedCommunityGroup();

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("transferred");
    expect(res.owner_user_id).toBe(heir.id);

    // Informational email, not the offer email.
    expect(mail.offer).not.toHaveBeenCalled();
    expect(sendTransferCompleteEmail).toHaveBeenCalledTimes(1);
    const [to, payerName, , link] = sendTransferCompleteEmail.mock.calls[0];
    expect(to).toBe(heir.email);
    expect(payerName).toBe("Dana Payer");
    expect(link).toContain(`/o/${slug}/settings/billing`);
  });

  it("is best-effort: an email that throws does not roll back the completed transfer", async () => {
    const { payer, heir, groupId } = await seedCommunityGroup();
    sendTransferCompleteEmail.mockRejectedValueOnce(new Error("resend down"));

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("transferred");

    // Ownership actually moved despite the email failure.
    const [group] = await sql<{ owner_user_id: string }[]>`
      select owner_user_id from subscriptions where id = ${groupId}`;
    expect(group.owner_user_id).toBe(heir.id);
  });
});
