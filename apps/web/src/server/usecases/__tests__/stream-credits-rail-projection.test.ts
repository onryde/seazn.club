// The Settings rail's "Streaming credits: N" (settings-nav.tsx navContext → projectedStreamCreditsTotal) must ALWAYS equal
// what the Streaming tab shows, including the first visit of a month, WITHOUT writing the ledger. Real Postgres; skipped
// without DATABASE_URL. Expected numbers come from calling the REAL tab read, never a literal.
//
// Mutant table:
//   P1 offer guard   drop the `!== "on"` early return in projectedStreamCreditsTotal   → "a plan that does not stream"
//   P3 top-up        project `rate` instead of `rate - granted` (planMonthlyRoll topUp)  → "a mid-month upgrade"
//   P2 expiry        project `plan.grant` instead of `grant - expire`                  → "last month's unused free credits expire"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { streamMonthlyGrantKey, streamMonthlyPeriod, streamMonthlyRate } from "@/server/usecases/stream-credits";

const { relayOfferMock } = vi.hoisted(() => ({
  relayOfferMock: vi.fn<(orgId: string) => Promise<{ entitled: boolean; relayEntitled: boolean; relayDisabled: boolean; composedAvailable: boolean }>>(),
}));
vi.mock("@/server/stream-panel-context", () => ({ relayOffer: (orgId: string) => relayOfferMock(orgId) }));

import { getStreamCreditsTab, projectedStreamCreditsTotal } from "../stream-credits-tab";

const HAS_DB = !!process.env.DATABASE_URL;
const auth = (orgId: string): AuthCtx => ({ orgId, via: "session", userId: null, role: "viewer", keyId: null });
const ON = { entitled: true, relayEntitled: true, relayDisabled: false, composedAvailable: true };
const OFF = { entitled: true, relayEntitled: false, relayDisabled: false, composedAvailable: false };
const ledgerRows = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from org_stream_credits where org_id = ${orgId}`)[0]!.n);

beforeEach(() => {
  relayOfferMock.mockReset();
  relayOfferMock.mockResolvedValue(ON);
});

describe.skipIf(!HAS_DB)("rail projection equals the Streaming tab", () => {
  it("(a,d) new month, grant not run: the projection equals the tab's total afterwards, and the projection wrote zero rows", async () => {
    const r = await streamRig();
    const before = await ledgerRows(r.orgId);
    const projected = await projectedStreamCreditsTotal(r.orgId);
    expect(await ledgerRows(r.orgId), "the rail read writes nothing").toBe(before);
    expect(projected, "a fresh org's month is not granted yet, so the projection is not the bare ledger").toBeGreaterThan(0);
    const tab = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(projected).toBe(tab.total);
  });

  it("(b) after the grant: still equal, no double count — and a second projection is stable", async () => {
    const r = await streamRig();
    const tab = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    const rows = await ledgerRows(r.orgId);
    expect(await projectedStreamCreditsTotal(r.orgId)).toBe(tab.total);
    expect(await projectedStreamCreditsTotal(r.orgId)).toBe(tab.total);
    expect(await ledgerRows(r.orgId)).toBe(rows);
  });

  it("(c) a plan that does not stream: no projection (bare ledger), and the tab grants nothing either", async () => {
    relayOfferMock.mockResolvedValue(OFF);
    const r = await streamRig();
    const projected = await projectedStreamCreditsTotal(r.orgId);
    const tab = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(tab.offer).toBe("notIncluded");
    expect(projected).toBe(0);
    expect(projected).toBe(tab.total);
  });

  it("(e) last month's unused free credits expire: the projection is grant minus the leftover, equal to the tab after it rolls", async () => {
    const r = await streamRig();
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const leftover = 5;
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, idempotency_key, created_at)
      values (${r.orgId}, ${leftover}, 'grant', 'monthly', ${leftover}, ${streamMonthlyGrantKey(r.orgId, streamMonthlyPeriod(prev))}, ${prev})`;
    const before = await ledgerRows(r.orgId);
    const projected = await projectedStreamCreditsTotal(r.orgId);
    expect(await ledgerRows(r.orgId)).toBe(before);
    const tab = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(projected).toBe(tab.total);
    expect(tab.total, "the leftover really expired: the total is this month's grant alone").toBe(tab.freeAllowance);
    expect(projected).not.toBe(tab.freeAllowance + leftover);
  });

  it("(f) a mid-month upgrade: the base grant is below the plan's rate, the projection is the top-up (rate - granted), equal to the tab after", async () => {
    const r = await streamRig();
    await setOrgPlan(r.orgId, "pro");   // the upgrade: community's rate is 1, so a base grant below it cannot exist
    const rate = await streamMonthlyRate(r.orgId);
    expect(rate, "a top-up needs a rate of at least 2 (a base grant below it)").toBeGreaterThanOrEqual(2);
    const granted = rate - 1;
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, idempotency_key)
      values (${r.orgId}, ${granted}, 'grant', 'monthly', ${granted}, ${streamMonthlyGrantKey(r.orgId, streamMonthlyPeriod(new Date()))})`;
    const before = await ledgerRows(r.orgId);
    const projected = await projectedStreamCreditsTotal(r.orgId);
    expect(await ledgerRows(r.orgId)).toBe(before);
    expect(projected, "the top-up is owed, so the projection is above the bare ledger").toBe(granted + 1);
    const tab = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(projected).toBe(tab.total);
    expect(tab.total).toBe(rate);
  });

  it("(g) a negative ledger: the rail answers the plain total instead of throwing", async () => {
    const r = await streamRig();
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after)
      values (${r.orgId}, -1, 'consume', 'monthly', 0)`;
    expect(await projectedStreamCreditsTotal(r.orgId)).toBe(-1);
  });
});
