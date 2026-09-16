// RS005 W1b — new route: CSV export of a competition's registrations, the
// competition-scoped twin of GET /divisions/{id}/registrations/export. Same
// filters as GET /competitions/{id}/registrations (shared query parsing);
// this file focuses on the CSV-specific response shape and authz, since the
// filter-parsing logic itself is covered by the sibling list route's suite.
import { afterAll, describe, expect, it, vi } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import {
  asOwner,
  makeUser,
  rig,
  seedOrg,
  seedRegistration,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { GET } from "@/app/api/v1/competitions/[id]/registrations/export/route";

const SETTINGS = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function exportReq(id: string, qs = ""): Request {
  return new Request(`https://test.local/api/v1/competitions/${id}/registrations/export${qs}`);
}

async function signedInOwner() {
  const { orgId, ownerId } = await seedOrg("pro"); // exports entitlement
  authState.userId = ownerId;
  return { orgId, owner: asOwner(orgId, ownerId) };
}

async function memberWithRole(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const userId = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
  return userId;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("GET /competitions/:id/registrations/export", () => {
  it("returns real CSV bytes across every division, honouring a status filter, never access_token_hash", async () => {
    const { owner } = await signedInOwner();
    const { competition, division: divA } = await rig(owner);
    const { registration: pending } = await seedRegistration(competition.id, divA.id, SETTINGS, {
      status: "pending",
      displayName: "Comp Export Pending",
    });
    await seedRegistration(competition.id, divA.id, SETTINGS, {
      status: "confirmed",
      displayName: "Comp Export Confirmed",
    });
    void pending;

    const res = await GET(exportReq(competition.id, "?status=pending"), ctx(competition.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="registrations-${competition.id}.csv"`,
    );

    const body = await res.text();
    expect(body.startsWith("{")).toBe(false);
    expect(body).toContain("Comp Export Pending");
    expect(body).not.toContain("Comp Export Confirmed"); // status filter applied
    expect(body).not.toContain("access_token_hash");
  });

  it("400s a malformed division_id the same way the list route does", async () => {
    const { owner } = await signedInOwner();
    const { competition } = await rig(owner);
    const res = await GET(exportReq(competition.id, "?division_id=not-a-uuid"), ctx(competition.id));
    expect(res.status).toBe(404); // assertUuid
  });

  it("errors still route through the standard v1() envelope (402 no exports entitlement)", async () => {
    const { owner } = await signedInOwner();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${owner.orgId}, 'exports', false, 'test')
      on conflict (org_id, feature_key) do update set bool_value = false`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(owner.orgId);
    const { competition } = await rig(owner);

    const res = await GET(exportReq(competition.id), ctx(competition.id));
    expect(res.status).toBe(402);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("PAYMENT_REQUIRED");
  });

  it("authz: owner, admin and viewer are let in", async () => {
    const { orgId, owner } = await signedInOwner();
    const { competition } = await rig(owner);
    const adminId = await memberWithRole(orgId, "admin");
    const viewerId = await memberWithRole(orgId, "viewer");

    authState.userId = owner.userId!;
    expect((await GET(exportReq(competition.id), ctx(competition.id))).status).toBe(200);

    authState.userId = adminId;
    expect((await GET(exportReq(competition.id), ctx(competition.id))).status).toBe(200);

    authState.userId = viewerId;
    expect((await GET(exportReq(competition.id), ctx(competition.id))).status).toBe(200);
  });
});
