// Detach notifications: the party that did NOT initiate the removal is emailed.
//  - the payer pushes an org out  -> the departing org's OWNER is told (what
//    happened to the plan, and that they now own its billing);
//  - the org's own owner leaves    -> the PAYER is told their bill changed.
// When the actor owns both the org and the group there is no one else to tell.
// Both sends are best-effort: a throw cannot roll back a completed detach.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the detach senders so nothing sends and we can spy on every path; the rest of the module is the real one (importOriginal).
const { sendGroupOrgRemovedEmail, sendGroupOrgLeftEmail } = vi.hoisted(() => ({
  sendGroupOrgRemovedEmail: vi.fn<
    (to: string, payerName: string, orgName: string, ridesOutUntil: string | null, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
  sendGroupOrgLeftEmail: vi.fn<
    (to: string, orgName: string, seatFreed: boolean, link: string, locale?: string) => Promise<boolean>
  >(async () => true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendGroupOrgRemovedEmail,
  sendGroupOrgLeftEmail,
}));

import { sql } from "@/lib/db";
import { detachOrgFromGroup } from "@/server/usecases/billing-groups";
import { seedDetachableGroup as seedLiveGroup } from "./_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  for (const m of [sendGroupOrgRemovedEmail, sendGroupOrgLeftEmail]) {
    m.mockReset();
    m.mockResolvedValue(true);
  }
});
afterAll(async () => {
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("detach notifies the non-acting party", () => {
  it("payer pushes an org out -> the departing org owner is emailed", async () => {
    const { payer, owner, orgId, orgName } = await seedLiveGroup();

    await detachOrgFromGroup({ actorUserId: payer.id, orgId, mode: "ride_out" });

    expect(sendGroupOrgRemovedEmail).toHaveBeenCalledTimes(1);
    const [to, payerName, on, ridesOutUntil] = sendGroupOrgRemovedEmail.mock.calls[0];
    expect(to).toBe(owner.email);
    expect(payerName).toBe("Dana Payer");
    expect(on).toBe(orgName);
    // ride_out on a paying group -> it keeps its plan to the period end.
    expect(ridesOutUntil).toBeTruthy();
    expect(sendGroupOrgLeftEmail).not.toHaveBeenCalled();
  });

  it("the org owner leaves -> the payer is emailed, not the owner", async () => {
    const { payer, owner, orgId } = await seedLiveGroup();

    await detachOrgFromGroup({ actorUserId: owner.id, orgId, mode: "ride_out" });

    expect(sendGroupOrgLeftEmail).toHaveBeenCalledTimes(1);
    const [to] = sendGroupOrgLeftEmail.mock.calls[0];
    expect(to).toBe(payer.email);
    expect(sendGroupOrgRemovedEmail).not.toHaveBeenCalled();
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
    await detachOrgFromGroup({ actorUserId: payer.id, orgId: primaryId });

    expect(sendGroupOrgRemovedEmail).not.toHaveBeenCalled();
    expect(sendGroupOrgLeftEmail).not.toHaveBeenCalled();
  });

  it("best-effort: a notification throw does not roll back the detach", async () => {
    const { payer, orgId } = await seedLiveGroup();
    sendGroupOrgRemovedEmail.mockRejectedValueOnce(new Error("resend down"));

    const res = await detachOrgFromGroup({ actorUserId: payer.id, orgId });

    // The org still moved to a new group of its own.
    expect(res.subscription_id).toBeTruthy();
    const [o] = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations where id = ${orgId}`;
    expect(o.subscription_id).toBe(res.subscription_id);
  });
});
