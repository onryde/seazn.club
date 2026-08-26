// RS005 W1b — regression coverage for the division registration CSV export
// route. Was: `exportRegistrationsCsv(auth, id)`, the pre-RS005-W1a 2-arg
// call — RS005 W1a widened the usecase to `exportRegistrationsCsv(auth,
// opts)` and this route did not compile. Fixed to
// `exportRegistrationsCsv(auth, { divisionId: id })`.
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

import {
  asOwner,
  rig,
  seedOrg,
  seedRegistration,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { GET } from "@/app/api/v1/divisions/[id]/registrations/export/route";

const SETTINGS = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function signedInOwner() {
  const { orgId, ownerId } = await seedOrg("pro"); // exports entitlement
  authState.userId = ownerId;
  return { orgId, owner: asOwner(orgId, ownerId) };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("GET /divisions/:id/registrations/export", () => {
  it("compiles the new opts-object call and returns real CSV bytes, not the JSON envelope", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "pending",
      displayName: "Csv Export Case",
    });

    const res = await GET(
      new Request(`https://test.local/api/v1/divisions/${division.id}/registrations/export`),
      ctx(division.id),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="registrations-${division.id}.csv"`,
    );

    const body = await res.text();
    // Real CSV, not `{"ok":true,...}` — the route returns NextResponse(csv, …)
    // directly on success, bypassing the v1() JSON envelope entirely.
    expect(body.startsWith("{")).toBe(false);
    // `id` leads, and `registration_id` follows it. This route's header is a
    // PUBLISHED contract — it is key-reachable at scope `read` and openapi.ts
    // declares no response schema, so no drift gate can see a change here. The
    // per-player rewrite renamed `id` to `registration_id`; `id` is restored
    // alongside it so an integration keyed on the original column keeps
    // working, and this assertion is what pins that promise.
    const header = body.split("\n")[0]!;
    expect(header).toBe(
      "id,registration_id,ref_code,division,status,kind,display_name,contact_name,contact_email," +
        "amount_cents,currency,refunded_cents,payment_method,waitlist_position,created_at," +
        "player_name,player_dob,player_gender,player_consent_status,squad_number,is_captain",
    );
    expect(header.startsWith("id,"), "the pre-rewrite column must stay first").toBe(true);
    expect(body).toContain("Csv Export Case");
    expect(body).not.toContain("access_token_hash");
  });

  it("still routes errors (402 no `exports` entitlement) through the standard v1() envelope", async () => {
    const { owner } = await signedInOwner();
    // Downgrade the org's plan out of the community grant path: community
    // does not carry `exports` (see reference_exports_feature_granted_every_plan_since_v310
    // — deny is via org_entitlement_overrides, not the plan alone).
    const { sql } = await import("@/lib/db");
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${owner.orgId}, 'exports', false, 'test')
      on conflict (org_id, feature_key) do update set bool_value = false`;
    const { invalidateOrgEntitlements } = await import("@/lib/entitlements");
    await invalidateOrgEntitlements(owner.orgId);
    const { division } = await rig(owner);

    const res = await GET(
      new Request(`https://test.local/api/v1/divisions/${division.id}/registrations/export`),
      ctx(division.id),
    );
    expect(res.status).toBe(402);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("PAYMENT_REQUIRED");
  });
});
