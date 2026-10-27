// Follow-ups to the billing-group transfer notifications (PR #227):
//
//  1. The offer notice's link must target an org the RECIPIENT can actually reach —
//     an org IN THE GROUP they are a member of — not the group's oldest org,
//     which they may not be able to open.
//  2. The COMMUNITY (immediate) handover path must also email the recipient, with
//     a DIFFERENT, informational message ("you now pay for this group"), queued
//     WITH the handover (phase 3 wave 4, kind `group_transfer_complete`): in the
//     transaction that swaps the payer, so a Stripe tidy-up that fails after it
//     cannot lose the notice. Addressed to the recipient's account, in their
//     language (D4: the account's, then the default of the org the link points
//     at), ref `subscription / <group id>`, no organisation, not transactional.
//     Changed while queued: nothing — a hand-back is a new event with its own row.
//
// Both notices are queued on the email outbox (phase 3 wave 4); their builders (`transferOfferEmail`, `transferCompleteEmail`) are
// WRAPPED, never replaced, so the spies read what the real render was given. Only the outbox transport is a double (and, in one test,
// Stripe's `customers.update`, spied on the real client to fail once).
//
// Own fixture port (12119) so it never contends with the other transfer suites.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";
process.env.STRIPE_MOCK_PORT = "12119";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Both builders, wrapped: the real render runs.
const mail = vi.hoisted(() => ({
  offer: vi.fn<typeof import("@/lib/email").transferOfferEmail>(),
  complete: vi.fn<typeof import("@/lib/email").transferCompleteEmail>(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  mail.offer.mockImplementation(actual.transferOfferEmail);
  mail.complete.mockImplementation(actual.transferCompleteEmail);
  return { ...actual, transferOfferEmail: mail.offer, transferCompleteEmail: mail.complete };
});
// The outbox's one network seam: captured, never sent.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { offerGroupTransfer } from "@/server/usecases/billing-groups";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
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
  mail.complete.mockClear();
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_fnu_${crypto.randomUUID()}` }));
});

type CompleteRow = { id: string; org_id: string | null; recipient_user_id: string | null; subject: string; transactional: boolean; status: string };
const completeRows = (groupId: string) =>
  sql<CompleteRow[]>`
    select id, org_id, recipient_user_id, subject, transactional, status
      from email_outbox
     where kind = 'group_transfer_complete' and ref_type = 'subscription' and ref_id = ${groupId}
     order by created_at, id`;

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

describe.skipIf(!HAS_DB)("Follow-up 2: community handover queues the transfer-complete notice", () => {
  it("an immediate handover queues one transfer-complete notice to the recipient, in their language, not the offer notice", async () => {
    // The recipient's account has no language, so the notice follows the default of the org the link points at (D4).
    const { payer, heir, groupId, slug, orgName } = await seedCommunityGroup({ orgDefaultLocale: "fr" });

    const res = await offerGroupTransfer({
      actorUserId: payer.id,
      subscriptionId: groupId,
      newOwnerUserId: heir.id,
    });
    expect(res.status).toBe("transferred");
    expect(res.owner_user_id).toBe(heir.id);

    // Informational notice, not the offer notice.
    expect(mail.offer).not.toHaveBeenCalled();
    const rows = await completeRows(groupId);
    expect(rows, "one notice for the one handover").toHaveLength(1);
    expect(rows[0]!.recipient_user_id, "addressed to the recipient's account").toBe(heir.id);
    expect(rows[0]!.org_id, "a group spans orgs: the notice names none").toBeNull();
    expect(rows[0]!.transactional).toBe(false);
    const fr = dictionarySubject("fr", "transferComplete.subject", {});
    expect(fr).not.toBe(dictionarySubject("en", "transferComplete.subject", {}));
    expect(rows[0]!.subject).toBe(fr);
    expect(mail.complete).toHaveBeenCalledTimes(1);
    const [args, locale] = mail.complete.mock.calls[0]!;
    expect(locale).toBe("fr");
    expect(args.payerName).toBe("Dana Payer");
    expect(args.groupName).toBe(orgName);
    expect(args.link).toContain(`/o/${slug}/settings/billing`);
    // The request makes the first attempt.
    await vi.waitFor(async () => expect((await completeRows(groupId))[0]!.status).toBe("sent"), { timeout: 15_000, interval: 50 });
  });

  it("the handover's notice is queued with it, so a failing Stripe tidy-up afterwards does not lose it", async () => {
    // A community group that kept its Stripe customer: the tidy-up after the handover repoints the invoice contact at Stripe.
    const { payer, heir, groupId } = await seedCommunityGroup({ customer: `cus_fnu_${crypto.randomUUID().slice(0, 8)}` });
    const update = vi.spyOn(getStripe().customers, "update").mockRejectedValueOnce(new Error("stripe down"));
    try {
      await expect(
        offerGroupTransfer({ actorUserId: payer.id, subscriptionId: groupId, newOwnerUserId: heir.id }),
      ).rejects.toThrow("stripe down");
      expect(update, "premise: the tidy-up reached Stripe and failed there").toHaveBeenCalledTimes(1);
    } finally {
      update.mockRestore();
    }

    // The handover committed before the tidy-up, and its notice with it.
    const [group] = await sql<{ owner_user_id: string }[]>`select owner_user_id from subscriptions where id = ${groupId}`;
    expect(group!.owner_user_id).toBe(heir.id);
    const rows = await completeRows(groupId);
    expect(rows, "the notice is queued for the worker").toHaveLength(1);
    expect(rows[0]!.recipient_user_id).toBe(heir.id);
  });

  it("empty: a second handover by the old payer is refused and queues nothing", async () => {
    const { payer, heir, groupId } = await seedCommunityGroup();
    await offerGroupTransfer({ actorUserId: payer.id, subscriptionId: groupId, newOwnerUserId: heir.id });
    expect(await completeRows(groupId), "premise: the first handover queued its notice").toHaveLength(1);

    // The old payer no longer pays for the group, so the second press is refused before anything is written.
    await expect(offerGroupTransfer({ actorUserId: payer.id, subscriptionId: groupId, newOwnerUserId: heir.id })).rejects.toMatchObject({
      status: 403,
    });

    expect(await completeRows(groupId), "the refused handover queued nothing").toHaveLength(1);
    expect(mail.complete, "and rendered nothing").toHaveBeenCalledTimes(1);
  });
});
