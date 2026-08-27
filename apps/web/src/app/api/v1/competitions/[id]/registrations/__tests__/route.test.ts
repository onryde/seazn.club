// RS005 W1b — new route: cross-division organiser registration list, the
// competition-scoped twin of GET /divisions/{id}/registrations. Reuses the
// SAME listRegistrations read model (RS005 W1a) — no second query.
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
import { EntrantKind, RegistrationStatus } from "@/server/api-v1/schemas";
import { ROUTES } from "@/server/api-v1/openapi";
import { createDivision } from "@/server/usecases/divisions";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import {
  asOwner,
  makeUser,
  rig,
  seedOrg,
  seedRegistration,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { GET } from "@/app/api/v1/competitions/[id]/registrations/route";

const SETTINGS = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>[];
  error?: { code: string; message: string };
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function signedInOwner() {
  const { orgId, ownerId } = await seedOrg();
  authState.userId = ownerId;
  return { orgId, owner: asOwner(orgId, ownerId) };
}

/** Adds a second org member with the given role and returns their id — NOT
 *  signed in yet; callers set `authState.userId` when they want to act as
 *  this member. */
async function memberWithRole(orgId: string, role: "owner" | "admin" | "viewer" | "scorer"): Promise<string> {
  const userId = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
  return userId;
}

function listReq(id: string, qs = ""): Request {
  return new Request(`https://test.local/api/v1/competitions/${id}/registrations${qs}`);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("GET /competitions/:id/registrations", () => {
  it("the OpenAPI query enums derive from the single sources, and list/export share one query object", () => {
    const list = ROUTES.find((r) => r.path === "/competitions/{id}/registrations" && r.method === "get");
    const exp = ROUTES.find((r) => r.path === "/competitions/{id}/registrations/export" && r.method === "get");
    expect(list).toBeDefined();
    expect(exp).toBeDefined();
    const q = list!.query as Record<string, { schema: { enum?: readonly string[] } }>;
    expect(q.status!.schema.enum).toEqual(RegistrationStatus.options);
    expect(q.kind!.schema.enum).toEqual(EntrantKind.options);
    expect(list!.query).toBe(exp!.query); // same REGISTRATION_LIST_QUERY object — cannot drift apart
  });

  it("accepts every RegistrationStatus.options value, including rejected and expired", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);

    for (const status of RegistrationStatus.options) {
      await seedRegistration(competition.id, division.id, SETTINGS, { status });
    }

    for (const status of RegistrationStatus.options) {
      const { status: httpStatus, body } = await read(
        await GET(listReq(competition.id, `?status=${status}`), ctx(competition.id)),
      );
      expect(httpStatus, status).toBe(200);
      expect(body.data!.length, status).toBeGreaterThan(0);
      expect(body.data!.every((r) => r.status === status), status).toBe(true);
    }
  });

  it("400s an unknown status/kind/sort, and 400s a malformed free_agent/consent_pending value", async () => {
    const { owner } = await signedInOwner();
    const { competition } = await rig(owner);

    expect((await GET(listReq(competition.id, "?status=bogus"), ctx(competition.id))).status).toBe(400);
    expect((await GET(listReq(competition.id, "?kind=bogus"), ctx(competition.id))).status).toBe(400);
    expect((await GET(listReq(competition.id, "?sort=bogus"), ctx(competition.id))).status).toBe(400);
    expect((await GET(listReq(competition.id, "?free_agent=yes"), ctx(competition.id))).status).toBe(400);
    expect((await GET(listReq(competition.id, "?consent_pending=yes"), ctx(competition.id))).status).toBe(400);
  });

  it("division_id narrows within the SAME competition; a malformed division_id 404s (assertUuid)", async () => {
    const { owner } = await signedInOwner();
    const { competition, division: divA } = await rig(owner);
    const divB = await createDivision(owner, competition.id, {
      name: "Second",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await seedRegistration(competition.id, divA.id, SETTINGS, { status: "pending", displayName: "In A" });
    await seedRegistration(competition.id, divB.id, SETTINGS, { status: "pending", displayName: "In B" });

    const { status, body } = await read(
      await GET(listReq(competition.id, `?division_id=${divA.id}`), ctx(competition.id)),
    );
    expect(status).toBe(200);
    expect(body.data!.every((r) => r.division_id === divA.id)).toBe(true);
    expect(body.data!.some((r) => r.display_name === "In B")).toBe(false);
    expect(body.data!.some((r) => r.display_name === "In A")).toBe(true);

    const malformed = await GET(listReq(competition.id, "?division_id=not-a-uuid"), ctx(competition.id));
    expect(malformed.status).toBe(404);
  });

  it("kind filters on the division's registration_settings.entrant_kind", async () => {
    const { owner } = await signedInOwner();
    const { competition, division: teamDiv } = await rig(owner);
    const indivDiv = await createDivision(owner, competition.id, {
      name: "Individual div",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await putRegistrationSettings(owner, teamDiv.id, {
      enabled: true,
      entrant_kind: "team",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });
    await putRegistrationSettings(owner, indivDiv.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });
    await seedRegistration(competition.id, teamDiv.id, SETTINGS, { status: "pending", displayName: "Team entry" });
    await seedRegistration(competition.id, indivDiv.id, SETTINGS, {
      status: "pending",
      displayName: "Solo entry",
    });

    const { body } = await read(await GET(listReq(competition.id, "?kind=team"), ctx(competition.id)));
    expect(body.data!.map((r) => r.display_name)).toEqual(["Team entry"]);
  });

  it("free_agent, q (text) and sort=newest all reach listRegistrations (RS005 W1a filters)", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    const { registration: older } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "pending",
      displayName: "Ann Rostered",
    });
    const { registration: newer } = await seedRegistration(competition.id, division.id, SETTINGS, {
      status: "pending",
      displayName: "Zed Free Agent",
    });
    // Deterministic order regardless of DB clock resolution / machine load.
    await sql`update registrations set created_at = now() - interval '2 hours' where id = ${older.id}`;
    await sql`update registrations set created_at = now() - interval '1 hour' where id = ${newer.id}`;
    await sql`update registrations set free_agent = true where id = ${newer.id}`;

    const byText = await read(await GET(listReq(competition.id, "?q=Rostered"), ctx(competition.id)));
    expect(byText.body.data!.map((r) => r.display_name)).toEqual(["Ann Rostered"]);

    const freeAgentsOnly = await read(await GET(listReq(competition.id, "?free_agent=1"), ctx(competition.id)));
    expect(freeAgentsOnly.body.data!.map((r) => r.display_name)).toEqual(["Zed Free Agent"]);

    const notFreeAgents = await read(await GET(listReq(competition.id, "?free_agent=0"), ctx(competition.id)));
    expect(notFreeAgents.body.data!.map((r) => r.display_name)).toEqual(["Ann Rostered"]);

    const newestFirst = await read(await GET(listReq(competition.id, "?sort=newest"), ctx(competition.id)));
    expect(newestFirst.body.data!.map((r) => r.display_name)).toEqual(["Zed Free Agent", "Ann Rostered"]);

    const oldestFirst = await read(await GET(listReq(competition.id, "?sort=oldest"), ctx(competition.id)));
    expect(oldestFirst.body.data!.map((r) => r.display_name)).toEqual(["Ann Rostered", "Zed Free Agent"]);
  });

  it("never carries access_token_hash", async () => {
    const { owner } = await signedInOwner();
    const { competition, division } = await rig(owner);
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });

    const { body } = await read(await GET(listReq(competition.id), ctx(competition.id)));
    for (const row of body.data!) expect(row).not.toHaveProperty("access_token_hash");
  });

  // Authz: `requireResourceAuth(req, "competition", id, "read")` grants
  // READ_ROLES (owner, admin, viewer) per lib/types.ts — asserted here as the
  // REAL behaviour, not assumed. See this task's final report: this is MORE
  // permissive than RS004 ruling 2 ("Hub is owner/admin only... RS005's
  // Registrants tab carries names, emails and consent state") — flagged
  // there rather than silently narrowed by this route on its own judgment.
  it("authz: owner, admin and viewer are let in; scorer is refused", async () => {
    const { orgId, owner } = await signedInOwner();
    const { competition } = await rig(owner);
    const adminId = await memberWithRole(orgId, "admin");
    const viewerId = await memberWithRole(orgId, "viewer");
    const scorerId = await memberWithRole(orgId, "scorer");

    authState.userId = owner.userId!;
    expect((await GET(listReq(competition.id), ctx(competition.id))).status).toBe(200);

    authState.userId = adminId;
    expect((await GET(listReq(competition.id), ctx(competition.id))).status).toBe(200);

    authState.userId = viewerId;
    expect((await GET(listReq(competition.id), ctx(competition.id))).status).toBe(200);

    authState.userId = scorerId;
    expect((await GET(listReq(competition.id), ctx(competition.id))).status).toBe(403);
  });

  it("authz: a non-member of the org is refused (401, not a member)", async () => {
    const { owner } = await signedInOwner();
    const { competition } = await rig(owner);
    const outsider = await makeUser("outsider");

    authState.userId = outsider;
    const res = await GET(listReq(competition.id), ctx(competition.id));
    expect(res.status).toBe(401);
  });
});
