// Final review m3 (walk-fix A r1 m2) - an entitlement change that flips whether card divisions take entries expires the org's public
// pages. Real Postgres; skipped without DATABASE_URL.
//
// `cardPaymentsBroken` closes a card division when Connect cannot charge OR when `registration.paid` resolves false
// (registrations/settings.ts `publicRegistrationInfo`). The Connect leg busts the org's public tag (stripe-connect.ts); the entitlement
// leg did not, so the hub's Register slot and its card-payments sentence (cached under `orgTag`, frozen under a Fly suspend) lagged.
// The review named a PLAN change as the flip. That premise is false: every plan grants `registration.paid` (V310), so a plan change
// cannot flip it - the first test pins that, so a future plan that denies it reds here and points at the missing bust. The one writer
// that can flip it is this staff override route, which now expires the org's public tag on every write and every real removal.
import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag, revalidatePath: vi.fn() }));
vi.mock("@/lib/peer-revalidate", () => ({ broadcastRevalidate: vi.fn(async () => {}) }));
vi.mock("@/lib/cdn-purge", () => ({ purgeCdn: vi.fn(async () => {}) }));
// The staff gate and its audit row are not what this tests: a fixed superadmin, and the log swallowed.
vi.mock("@/lib/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin")>()),
  requireSuperadmin: vi.fn(async () => ({ id: "00000000-0000-0000-0000-000000000000", email: "staff@test.local" })),
  logStaffAction: vi.fn(async () => {}),
}));

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { orgTag } from "@/server/public-site/cache-tags";
import { seedOrg } from "@/server/usecases/__tests__/_registration-fixtures";
import { DELETE, POST } from "./route";

const HAS_DB = !!process.env.DATABASE_URL;

const call = (method: typeof POST, orgId: string, body: unknown) =>
  method(new Request("http://test.local", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: orgId }) });

beforeEach(() => revalidateTag.mockClear());

describe.skipIf(!HAS_DB)("an entitlement override expires the org's public pages (final review m3)", () => {
  it("premise, as a guard: every plan grants registration.paid, so no plan change can flip card payments", async () => {
    const rows = await sql<{ plan_key: string; granted: boolean }[]>`
      select plan_key, coalesce(bool_value, false) as granted from plan_entitlements where feature_key = 'registration.paid'`;
    const plans = await sql<{ plan_key: string }[]>`select distinct plan_key from plan_entitlements`;
    expect(plans.length, "anti-vacuity: the catalog has plans").toBeGreaterThan(0);
    expect(rows.map((r) => r.plan_key).sort(), "every plan has a registration.paid row").toEqual(plans.map((p) => p.plan_key).sort());
    for (const r of rows) expect(r.granted, `${r.plan_key} grants registration.paid`).toBe(true);
  });

  it("the SEQUENCE: a deny busts and closes paid entries, its removal busts and reopens them, a second removal busts nothing", async () => {
    const { orgId, orgSlug } = await seedOrg("pro");
    const busts = () => revalidateTag.mock.calls.filter(([tag]) => tag === orgTag(orgSlug));
    expect(await hasFeature(orgId, "registration.paid"), "premise: the plan grants it").toBe(true);

    const steps: { label: string; run: () => Promise<Response>; paid: boolean; busts: number }[] = [
      { label: "staff deny", run: () => call(POST, orgId, { feature_key: "registration.paid", bool_value: false, reason: "chargebacks" }), paid: false, busts: 1 },
      { label: "staff deny again (second call)", run: () => call(POST, orgId, { feature_key: "registration.paid", bool_value: false, reason: "still" }), paid: false, busts: 1 },
      { label: "override removed", run: () => call(DELETE, orgId, { feature_key: "registration.paid" }), paid: true, busts: 1 },
      { label: "removed again: nothing to remove", run: () => call(DELETE, orgId, { feature_key: "registration.paid" }), paid: true, busts: 0 },
    ];
    let checked = 0;
    for (const s of steps) {
      revalidateTag.mockClear();
      const res = await s.run();
      expect(res.status, s.label).toBe(200);
      expect(await hasFeature(orgId, "registration.paid"), `${s.label}: what card divisions now read`).toBe(s.paid);
      expect(busts().length, s.label).toBe(s.busts);
      // Expired, not stale-while-revalidate: the next visitor reads the new state (fireOrgRevalidate's profile).
      for (const c of busts()) expect(c[1], s.label).toEqual({ expire: 0 });
      checked++;
    }
    expect(checked).toBe(steps.length);
  });

  it("an org that does not exist: 404 on a write, and nothing is expired", async () => {
    const res = await call(POST, randomUUID(), { feature_key: "registration.paid", bool_value: false, reason: "x" });
    expect(res.status).toBe(404);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
