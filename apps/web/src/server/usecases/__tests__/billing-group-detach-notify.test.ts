// Detach notifications: the party that did NOT initiate the removal is told.
//  - the payer pushes an org out  -> the departing org's OWNER is told (what
//    happened to the plan, and that they now own its billing);
//  - the org's own owner leaves    -> the PAYER is told their bill changed.
// When the actor owns both the org and the group there is no one else to tell.
//
// Both notices are queued on the email outbox (phase 3 wave 4, kinds `group_org_removed` and `group_org_left`) in the detach's own
// transaction, right after the org is repointed (committed <=> queued; a refused enqueue fails the detach, D1): addressed to the told
// party's account, in their language (D4: the account's, then the default of the org the notice is about — the detached org for the
// owner, the group's remaining org the link points at for the payer), ref `group_detach / <the org's new subscription>` (unique per
// detach), the detached org, NOT transactional, and the request makes the first attempt after commit. The builders
// (`groupOrgRemovedEmail`, `groupOrgLeftEmail`) are WRAPPED, never replaced; only the outbox transport is a double. Changed while
// queued: a re-attach in the window (rare, recorded); the ride-out date and the seat outcome are fixed at the detach.
//
// The rollback twin (a failing statement after the enqueue leaves no notice) is not written: the planted-failure helper it needs does not
// exist (wave 2 dropped planted-trigger rollbacks, owner rule 2026-10-26); the enqueue shares the detach's transaction by construction.
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Both builders, wrapped (the real render runs). The rest of the module is the real one (importOriginal).
const mail = vi.hoisted(() => ({
  removed: vi.fn<typeof import("@/lib/email").groupOrgRemovedEmail>(),
  left: vi.fn<typeof import("@/lib/email").groupOrgLeftEmail>(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  mail.removed.mockImplementation(actual.groupOrgRemovedEmail);
  mail.left.mockImplementation(actual.groupOrgLeftEmail);
  return { ...actual, groupOrgRemovedEmail: mail.removed, groupOrgLeftEmail: mail.left };
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
  mail.left.mockClear();
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_dnu_${crypto.randomUUID()}` }));
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
    expect(mail.left, "the payer pressed the button: no leave notice").not.toHaveBeenCalled();

    // The request makes the first attempt after commit.
    await vi.waitFor(async () => expect((await detachRows(res.subscription_id))[0]!.status).toBe("sent"), { timeout: 15_000, interval: 50 });
  });

  it("an owner with no account language gets the removal notice in the DETACHED org's default, not the remaining org's", async () => {
    // The mainstream path: sign-up never writes an account language (lib/users.ts), so D4's org step answers for most owners. The
    // detached org and the group's remaining org differ, and neither is English, so the wrong org and the fallback are both seen.
    const detachedOrgLocale = "fr" as const;
    const { payer, owner, orgId, orgName } = await seedLiveGroup({
      ownerLocale: null,
      orgDefaultLocale: detachedOrgLocale,
      remainingDefaultLocale: "nl",
    });
    const [account] = await sql<{ locale: string | null }[]>`select locale from users where id = ${owner.id}`;
    expect(account!.locale, "no account language: the org step must answer").toBeNull();

    const res = await detachOrgFromGroup({ actorUserId: payer.id, orgId, mode: "ride_out" });

    const rows = await detachRows(res.subscription_id);
    expect(rows.map((r) => [r.kind, r.recipient_user_id]), "one removal notice, to the owner").toEqual([["group_org_removed", owner.id]]);
    const expected = dictionarySubject(detachedOrgLocale, "groupOrgRemoved.subject", { orgName });
    for (const wrong of ["nl", "en"] as const)
      expect(dictionarySubject(wrong, "groupOrgRemoved.subject", { orgName }), `the ${wrong} subject is distinguishable`).not.toBe(expected);
    expect(rows[0]!.subject).toBe(expected);
    expect(mail.removed).toHaveBeenCalledTimes(1);
    expect(mail.removed.mock.calls[0]![1]).toBe(detachedOrgLocale);

    await vi.waitFor(async () => expect((await detachRows(res.subscription_id))[0]!.status).toBe("sent"), { timeout: 15_000, interval: 50 });
  });

  it("the owner leaving queues one notice to the payer, saying whether the seat was kept", async () => {
    // release: the payer keeps the seat as a reusable freed slot. The payer's account has no language, so the notice follows the
    // default of the group's remaining org, the one the link points at (D4).
    const kept = await seedLiveGroup({ remainingDefaultLocale: "nl" });
    const released = await detachOrgFromGroup({ actorUserId: kept.owner.id, orgId: kept.orgId, mode: "release" });
    const rows = await detachRows(released.subscription_id);
    expect(rows, "one notice for the one detach").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "group_org_left",
      org_id: kept.orgId,
      recipient: kept.payer.email,
      recipient_user_id: kept.payer.id,
      transactional: false,
    });
    const nl = dictionarySubject("nl", "groupOrgLeft.subject", { orgName: kept.orgName });
    expect(nl).not.toBe(dictionarySubject("en", "groupOrgLeft.subject", { orgName: kept.orgName }));
    expect(rows[0]!.subject).toBe(nl);
    expect(mail.left).toHaveBeenCalledTimes(1);
    const [freed, locale] = mail.left.mock.calls[0]!;
    expect(locale).toBe("nl");
    expect(freed).toEqual({ orgName: kept.orgName, seatFreed: true, link: expect.stringContaining(`/o/${kept.primarySlug}/settings/billing`) });
    expect(mail.removed, "the owner pressed the button: no removal notice").not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await detachRows(released.subscription_id))[0]!.status).toBe("sent"), { timeout: 15_000, interval: 50 });

    // ride_out on a paying group: the seat left with the org, so the next invoice is one smaller.
    const spent = await seedLiveGroup();
    const rodeOut = await detachOrgFromGroup({ actorUserId: spent.owner.id, orgId: spent.orgId, mode: "ride_out" });
    expect((await detachRows(rodeOut.subscription_id)).map((r) => [r.kind, r.recipient_user_id])).toEqual([["group_org_left", spent.payer.id]]);
    expect(mail.left).toHaveBeenCalledTimes(2);
    expect(mail.left.mock.calls[1]![0].seatFreed).toBe(false);
  });

  it("empty: the actor owns both the org and the group — no row", async () => {
    const { payer, primaryId } = await seedLiveGroup();

    // Payer removes their OWN primary org; the group still has the other org, so
    // this is a valid detach and the actor is both parties — nobody to tell.
    const res = await detachOrgFromGroup({ actorUserId: payer.id, orgId: primaryId });

    expect(await detachRows(res.subscription_id), "no notice for this detach").toEqual([]);
    expect(mail.removed).not.toHaveBeenCalled();
    expect(mail.left).not.toHaveBeenCalled();
  });
});
