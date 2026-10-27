// The transfer offer's notice (phase 3 wave 4, kind `group_transfer_offer`). offerGroupTransfer on a live-sub group mints a SetupIntent
// (the Stripe fixture server's) and makes the offer live by storing its id on the claim; the notice to the recipient is queued on the
// email outbox in THAT transaction (committed <=> queued), addressed to the recipient's account (`recipient_user_id`, the address is
// resolved at send), in the recipient's language (D4: the account's, then the default of the org the link points at), NOT
// transactional (the sender never was), ref `subscription / <group id>`, no organisation (a group can span several), and the request
// makes the first attempt after commit. A refused enqueue fails the offer (D1); there is no best-effort path left to test.
//
// Changed while queued: the payer may withdraw the offer, or it may lapse, while the row waits. The link lands on the billing page, which
// shows the offer's live state, so nothing refreshes the row (rare: the request itself makes the first attempt) — recorded.
//
// The builder `transferOfferEmail` is WRAPPED, never replaced: the real render runs, and the spy records what the notice was built from.
// Only the outbox transport is a double.
//
// STRIPE_MOCK_PORT is set from the fixture's own ephemeral bound port in beforeAll below, not hard-coded — see stripe-fixture-server.ts
// (#313). Sport: not applicable (a billing notice does not vary by sport).
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mail = vi.hoisted(() => ({ offer: vi.fn<typeof import("@/lib/email").transferOfferEmail>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  mail.offer.mockImplementation(actual.transferOfferEmail);
  return { ...actual, transferOfferEmail: mail.offer };
});
// The outbox's one network seam: captured, never sent.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { offerGroupTransfer } from "@/server/usecases/billing-groups";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { startStripeFixtureServer, type StripeFixtureServer } from "../../../../e2e/stripe-fixture-server";
import { stubOutboxEnv } from "./_invite-mail";
import { seedLiveGroup as seedLiveGroupRows } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
let fixture: StripeFixtureServer;

/** A live pro group the payer owns, one org in it that the heir owns, and no standing pending offer; the fixture's SetupIntents carry
 *  the group's customer. */
async function seedLiveGroup(opts: { heirLocale?: string | null } = {}) {
  const g = await seedLiveGroupRows(opts);
  fixture.setSetupIntentCustomer(g.customer);
  return g;
}

type OfferRow = {
  id: string;
  org_id: string | null;
  recipient: string;
  recipient_user_id: string | null;
  subject: string;
  transactional: boolean;
  status: string;
};
const offerRows = (groupId: string) =>
  sql<OfferRow[]>`
    select id, org_id, recipient, recipient_user_id, subject, transactional, status
      from email_outbox
     where kind = 'group_transfer_offer' and ref_type = 'subscription' and ref_id = ${groupId}
     order by created_at, id`;

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer();
  process.env.STRIPE_MOCK_PORT = String(fixture.port);
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
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_bgo_${crypto.randomUUID()}` }));
});

describe.skipIf(!HAS_DB)("offerGroupTransfer queues the offer notice on the outbox", () => {
  it("an offer queues one notice to the recipient, in their language", async () => {
    const { payer, heir, groupId, orgName } = await seedLiveGroup({ heirLocale: "es" });

    const res = await offerGroupTransfer({ actorUserId: payer.id, subscriptionId: groupId, newOwnerUserId: heir.id });
    expect(res.status).toBe("pending_card");

    const rows = await offerRows(groupId);
    expect(rows, "one notice for the one offer").toHaveLength(1);
    const row = rows[0]!;
    expect(row.org_id, "a group spans orgs: the notice names none").toBeNull();
    expect(row.recipient_user_id, "addressed to the recipient's account").toBe(heir.id);
    expect(row.recipient).toBe(heir.email);
    expect(row.transactional, "the suppression list applies, as it did to the sender").toBe(false);
    // The Spanish subject is not the English one, so a notice that dropped the recipient's language is seen.
    const es = dictionarySubject("es", "transferOffer.subject", {});
    expect(es).not.toBe(dictionarySubject("en", "transferOffer.subject", {}));
    expect(row.subject).toBe(es);

    // What the notice says: the payer, the group (named by the org the recipient can reach) and that org's billing page.
    expect(mail.offer).toHaveBeenCalledTimes(1);
    const [args, locale] = mail.offer.mock.calls[0]!;
    expect(locale).toBe("es");
    expect(args.payerName).toBe("Dana Payer");
    expect(args.groupName).toBe(orgName);
    expect(args.link).toMatch(/\/o\/riverside-[a-z0-9]+\/settings\/billing$/);

    // The request makes the first attempt after commit: the row is sent, once, to the recipient, with the Spanish subject.
    await vi.waitFor(async () => expect((await offerRows(groupId))[0]!.status).toBe("sent"), { timeout: 15_000, interval: 50 });
    const sent = transport.deliver.mock.calls.map((c) => c[0] as { to: string; subject: string });
    expect(sent.filter((m) => m.to === heir.email)).toEqual([expect.objectContaining({ to: heir.email, subject: es })]);
  });

  it("a second offer while one is pending is refused (409) and queues nothing", async () => {
    const { payer, heir, groupId } = await seedLiveGroup();
    await offerGroupTransfer({ actorUserId: payer.id, subscriptionId: groupId, newOwnerUserId: heir.id });
    expect(await offerRows(groupId), "premise: the first offer queued its notice").toHaveLength(1);

    await expect(offerGroupTransfer({ actorUserId: payer.id, subscriptionId: groupId, newOwnerUserId: heir.id })).rejects.toMatchObject({
      status: 409,
    });

    expect(await offerRows(groupId), "the refused offer queued nothing").toHaveLength(1);
    expect(mail.offer, "and rendered nothing").toHaveBeenCalledTimes(1);
  });
});
