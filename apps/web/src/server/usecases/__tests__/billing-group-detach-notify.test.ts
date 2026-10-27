// Detach notifications: the party that did NOT initiate the removal is told.
//  - the payer pushes an org out  -> the departing org's OWNER is told (what
//    happened to the plan, and that they now own its billing);
//  - the org's own owner leaves    -> the PAYER is told their bill changed.
// When the actor owns both the org and the group there is no one else to tell.
//
// The removal notice is queued on the email outbox (phase 3 wave 4, kind `group_org_removed`) in the detach's own transaction, right
// after the org is repointed (committed <=> queued; a refused enqueue fails the detach, D1): addressed to the owner's account, in the
// owner's language (D4: the account's, then the detached org's default), ref `group_detach / <the org's new subscription>` (unique per
// detach), the detached org, NOT transactional, and the request makes the first attempt after commit. Its builder `groupOrgRemovedEmail`
// is WRAPPED, never replaced; only the outbox transport is a double. Changed while queued: a re-attach in the window (rare, recorded);
// the ride-out date is fixed at the detach.
//
// The rollback twin (a failing statement after the enqueue leaves no notice) is not written: the planted-failure helper it needs does not
// exist (wave 2 dropped planted-trigger rollbacks, owner rule 2026-10-26); the enqueue shares the detach's transaction by construction.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The removal notice's builder, wrapped (the real render runs); the leave notice's direct sender, steered. The rest of the module is the
// real one (importOriginal).
const { mail, sendGroupOrgLeftEmail } = vi.hoisted(() => ({
  mail: { removed: vi.fn<typeof import("@/lib/email").groupOrgRemovedEmail>() },
  sendGroupOrgLeftEmail: vi.fn<
    (to: string, orgName: string, seatFreed: boolean, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  mail.removed.mockImplementation(actual.groupOrgRemovedEmail);
  return { ...actual, groupOrgRemovedEmail: mail.removed, sendGroupOrgLeftEmail };
});
// The outbox's one network seam: captured, never sent.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { detachOrgFromGroup } from "@/server/usecases/billing-groups";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";
import { seedDetachableGroup as seedLiveGroup } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

type DetachRow = {
  kind: string;
  org_id: string | null;
  recipient: string;
  recipient_user_id: string | null;
  subject: string;
  transactional: boolean;
  status: string;
};
/** The notices of one detach: its ref is the org's new subscription, unique per detach. */
const detachRows = (detachId: string) =>
  sql<DetachRow[]>`
    select kind, org_id, recipient, recipient_user_id, subject, transactional, status
      from email_outbox
     where ref_type = 'group_detach' and ref_id = ${detachId}
     order by created_at, id`;

beforeEach(() => {
  stubOutboxEnv();
  mail.removed.mockClear();
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_dnu_${crypto.randomUUID()}` }));
  sendGroupOrgLeftEmail.mockReset();
  sendGroupOrgLeftEmail.mockResolvedValue(true);
});
afterAll(async () => {
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("detach notifies the non-acting party", () => {
  it("the payer removing another owner's org queues one notice to that owner, ride-out date in the owner's language", async () => {
    const { payer, owner, groupId, orgId, orgName } = await seedLiveGroup({ ownerLocale: "fr" });
    const [group] = await sql<{ current_period_end: Date }[]>`select current_period_end from subscriptions where id = ${groupId}`;

    const res = await detachOrgFromGroup({ actorUserId: payer.id, orgId, mode: "ride_out" });

    const rows = await detachRows(res.subscription_id);
    expect(rows, "one notice for the one detach").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "group_org_removed",
      org_id: orgId,
      recipient: owner.email,
      recipient_user_id: owner.id,
      transactional: false,
    });
    // The French subject is not the English one, so a notice that dropped the owner's language is seen.
    const fr = dictionarySubject("fr", "groupOrgRemoved.subject", { orgName });
    expect(fr).not.toBe(dictionarySubject("en", "groupOrgRemoved.subject", { orgName }));
    expect(rows[0]!.subject).toBe(fr);

    // ride_out on a paying group: it keeps its plan to the period end, and the date is written the owner's way.
    expect(mail.removed).toHaveBeenCalledTimes(1);
    const [args, locale] = mail.removed.mock.calls[0]!;
    expect(locale).toBe("fr");
    expect(args.payerName).toBe("Dana Payer");
    expect(args.orgName).toBe(orgName);
    expect(args.ridesOutUntil).toBe(new Intl.DateTimeFormat("fr", { dateStyle: "long" }).format(group!.current_period_end));
    expect(args.link).toMatch(/\/o\/northside-[a-z0-9]+\/settings\/billing$/);
    expect(sendGroupOrgLeftEmail).not.toHaveBeenCalled();

    // The request makes the first attempt after commit.
    await vi.waitFor(async () => expect((await detachRows(res.subscription_id))[0]!.status).toBe("sent"), { timeout: 15_000, interval: 50 });
  });

  it("the org owner leaves -> the payer is emailed, not the owner", async () => {
    const { payer, owner, orgId } = await seedLiveGroup();

    const res = await detachOrgFromGroup({ actorUserId: owner.id, orgId, mode: "ride_out" });

    expect(sendGroupOrgLeftEmail).toHaveBeenCalledTimes(1);
    const [to] = sendGroupOrgLeftEmail.mock.calls[0];
    expect(to).toBe(payer.email);
    expect((await detachRows(res.subscription_id)).filter((r) => r.kind === "group_org_removed"), "no removal notice").toEqual([]);
    expect(mail.removed).not.toHaveBeenCalled();
  });

  it("release tells the payer the seat is freed (reusable)", async () => {
    const { owner, orgId } = await seedLiveGroup();

    await detachOrgFromGroup({ actorUserId: owner.id, orgId, mode: "release" });

    expect(sendGroupOrgLeftEmail).toHaveBeenCalledTimes(1);
    const [, , seatFreed] = sendGroupOrgLeftEmail.mock.calls[0];
    expect(seatFreed).toBe(true);
  });

  it("no email when the actor owns both the org and the group", async () => {
    const { payer, primaryId } = await seedLiveGroup();

    // Payer removes their OWN primary org; the group still has the other org, so
    // this is a valid detach and the actor is both parties — nobody to tell.
    const res = await detachOrgFromGroup({ actorUserId: payer.id, orgId: primaryId });

    expect(await detachRows(res.subscription_id), "no notice for this detach").toEqual([]);
    expect(mail.removed).not.toHaveBeenCalled();
    expect(sendGroupOrgLeftEmail).not.toHaveBeenCalled();
  });
});
