// RS005 W1b — regression coverage for the division registration list route.
// Was: a hand-copied 5-value STATUSES array missing `expired`/`rejected`, so
// `?status=rejected` 400d even though the DB CHECK (V364) allows it. Fixed to
// derive from schemas.ts's `RegistrationStatus` — the ONE source, shared with
// the OpenAPI query enum — and the response is now the widened
// `RegistrationListEntry` shape (RS005 W1a's `listRegistrations`).
import { afterAll, describe, expect, it, vi } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;

// Session door faked one layer down, same as persons/__tests__/merge-route.test.ts
// — `requireUser` says who is signed in; the real getUserOrgs/getOrgRole/
// resolveActiveOrg resolve the org from the database.
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

import { RegistrationStatus } from "@/server/api-v1/schemas";
import { ROUTES } from "@/server/api-v1/openapi";
import {
  asOwner,
  rig,
  seedOrg,
  seedRegistration,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { GET } from "@/app/api/v1/divisions/[id]/registrations/route";

const SETTINGS = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

/** Seeds a fresh org and signs its owner in (authState drives the mocked
 *  requireUser above). */
async function signedInOwner() {
  const { orgId, ownerId } = await seedOrg();
  authState.userId = ownerId;
  return { orgId, owner: asOwner(orgId, ownerId) };
}

function req(id: string, status?: string): Request {
  const qs = status !== undefined ? `?status=${encodeURIComponent(status)}` : "";
  return new Request(`https://test.local/api/v1/divisions/${id}/registrations${qs}`);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>[];
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("GET /divisions/:id/registrations", () => {
  it("RegistrationStatus carries all seven DB-allowed values, expired and rejected included", () => {
    expect([...RegistrationStatus.options].sort()).toEqual(
      ["confirmed", "expired", "paid", "pending", "rejected", "waitlisted", "withdrawn"].sort(),
    );
  });

  it("the OpenAPI query enum for this route equals RegistrationStatus.options — no fourth hand-copy", () => {
    const route = ROUTES.find((r) => r.path === "/divisions/{id}/registrations" && r.method === "get");
    expect(route).toBeDefined();
    const enumValues = (route!.query as Record<string, { schema: { enum?: readonly string[] } }>).status.schema
      .enum;
    expect(enumValues).toEqual(RegistrationStatus.options);
  });

  it("accepts every RegistrationStatus.options value — ?status=rejected and ?status=expired no longer 400", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);

    const seeded = new Map<string, string>(); // status -> registration id
    for (const status of RegistrationStatus.options) {
      const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, { status });
      seeded.set(status, registration.id);
    }

    for (const status of RegistrationStatus.options) {
      const { status: httpStatus, body } = await read(await GET(req(division.id, status), ctx(division.id)));
      expect(httpStatus, status).toBe(200);
      expect(body.ok, status).toBe(true);
      expect(body.data!.every((r) => r.status === status), status).toBe(true);
      expect(body.data!.map((r) => r.id)).toContain(seeded.get(status));
    }
  });

  it("rejects an unknown status with 400, still deriving its message from the same list", async () => {
    const { owner } = await signedInOwner();
    const { division } = await rig(owner);

    const { status, body } = await read(await GET(req(division.id, "bogus"), ctx(division.id)));
    expect(status).toBe(400);
    for (const opt of RegistrationStatus.options) {
      expect(body.error?.message).toContain(opt);
    }
  });

  it("rows carry the RS005 W1a widened fields and never access_token_hash", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });

    const { status, body } = await read(await GET(req(division.id), ctx(division.id)));
    expect(status).toBe(200);
    expect(body.data!.length).toBeGreaterThan(0);
    for (const row of body.data!) {
      expect(row).not.toHaveProperty("access_token_hash");
      expect(row).toHaveProperty("division_name");
      expect(row).toHaveProperty("division_slug");
      expect(row).toHaveProperty("entrant_kind");
      expect(row).toHaveProperty("roster_count");
      expect(row).toHaveProperty("roster_cap");
      expect(row).toHaveProperty("consent_pending_count");
      expect(row).toHaveProperty("waitlist_position");
      expect(row).toHaveProperty("contact_name");
      expect(row).toHaveProperty("group_id");
    }
  });
});
