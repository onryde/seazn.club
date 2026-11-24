// Seazn-hosted video, Phase 4 Task 33: GET/PUT /api/v1/orgs/{id}/seazn-hosted — the org's Seazn switch (V553), over the REAL handler,
// the REAL session door and the REAL tables. Only `requireUser` (who is signed in) is faked, exactly as the sibling org routes' suites
// do; `requireOrgAuth`'s role lookup runs against real `org_members` rows.
//
// What this file owns is the WIRING and the ENVELOPES: who may read and who may write (the granted AND the denied pair), the door
// before the body, the 400 for a body the schema refuses, a non-member's 401, a malformed id's 404, the key ban, and that what the PUT
// writes is what the GET and the usecase read back. The switch's effect on lists, picks and starts is seazn-offered.test.ts's.
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): the switch reads no sport.
import { afterAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const { AuthError } = await import("@/lib/errors");
  const user = async () => {
    if (authState.userId === "") throw new AuthError("Unauthorized");
    return { id: authState.userId };
  };
  return { ...actual, requireUser: user, getCurrentUser: async () => (authState.userId === "" ? null : { id: authState.userId }), getActiveOrgId: async () => null };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { NEVER_KEY_ROUTES } from "@/server/api-v1/key-scopes";
import { createApiKey } from "@/server/usecases/api-keys";
import { seaznOfferOf } from "@/server/usecases/stream-targets";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { GET, PUT } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (orgId: string) => `http://localhost/api/v1/orgs/${orgId}/seazn-hosted`;
const get = (orgId: string, headers: HeadersInit = {}) => GET(new Request(url(orgId), { method: "GET", headers }), ctx(orgId));
const put = (orgId: string, body: unknown, headers: HeadersInit = {}) =>
  PUT(
    new Request(url(orgId), {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx(orgId),
  );

type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message: string } };
const dataOf = async (res: Response) => ((await res.json()) as Envelope).data;

/** A signed-in OWNER of a fresh org (real users + org_members rows). */
async function organiser() {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  return { auth, orgId: auth.orgId, ownerId: auth.userId! };
}
async function memberOf(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}

describe.skipIf(!HAS_DB)("GET/PUT /orgs/{id}/seazn-hosted — the route", () => {
  it("the owner: GET reads the default ON; PUT off is 200 { offered: false } and the GET and the usecase read it back; a SECOND PUT off is the same 200; PUT on restores it (sequence)", async () => {
    const o = await organiser();
    const first = await get(o.orgId);
    expect(first.status).toBe(200);
    expect(await dataOf(first)).toEqual({ offered: true });
    const answers: unknown[] = [];
    for (const offered of [false, false, true]) {
      const res = await put(o.orgId, { offered });
      expect(res.status, `PUT ${offered}`).toBe(200);
      answers.push(await dataOf(res));
      expect(await dataOf(await get(o.orgId)), `GET after PUT ${offered}`).toEqual({ offered });
      expect(await seaznOfferOf(o.orgId), `the usecase after PUT ${offered}`).toEqual({ offered });
    }
    expect(answers).toEqual([{ offered: false }, { offered: false }, { offered: true }]);
  });

  it("the granted AND the denied pair: an owner and an admin write; a viewer reads (200) but its PUT is 403 and writes nothing", async () => {
    const o = await organiser();
    const adminId = await memberOf(o.orgId, "admin");
    const viewerId = await memberOf(o.orgId, "viewer");

    authState.userId = viewerId;
    expect(await dataOf(await get(o.orgId)), "a viewer reads the switch").toEqual({ offered: true });
    const denied = await put(o.orgId, { offered: false });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as Envelope).error?.message).toBe("Insufficient permissions");
    expect(await seaznOfferOf(o.orgId), "the viewer wrote nothing").toEqual({ offered: true });

    let granted = 0;
    for (const [who, userId, offered] of [["admin", adminId, false], ["owner", o.ownerId, true]] as const) {
      authState.userId = userId;
      const res = await put(o.orgId, { offered });
      expect(res.status, who).toBe(200);
      expect(await seaznOfferOf(o.orgId), who).toEqual({ offered });
      granted++;
    }
    expect(granted).toBe(2);
  });

  it("the door before the body: a viewer's MALFORMED body is 403, a non-member's 401 — never the 400 the owner gets for it (counted)", async () => {
    const o = await organiser();
    const viewerId = await memberOf(o.orgId, "viewer");
    const bad: unknown[] = [{}, { offered: "no" }, { offered: false, extra: 1 }, "{not json"];
    let checked = 0;
    for (const body of bad) {
      authState.userId = viewerId;
      expect((await put(o.orgId, body)).status, `viewer ${JSON.stringify(body)}`).toBe(403);
      authState.userId = (await makeUser("stranger")).id;
      expect((await put(o.orgId, body)).status, `non-member ${JSON.stringify(body)}`).toBe(401);
      authState.userId = o.ownerId;
      expect((await put(o.orgId, body)).status, `the owner's own 400 for ${JSON.stringify(body)} (the positive pair)`).toBe(400);
      checked++;
    }
    expect(checked).toBe(bad.length);
    expect(await seaznOfferOf(o.orgId), "nobody wrote").toEqual({ offered: true });
  });

  it("another org: a non-member is refused at the door (401, like every org route) for the read and the write, and writes nothing; a malformed org id is 404", async () => {
    const o = await organiser();
    const foreign = await organiser();               // signs in as ANOTHER org's owner
    expect(foreign.orgId).not.toBe(o.orgId);
    expect((await get(o.orgId)).status).toBe(401);
    expect((await put(o.orgId, { offered: false })).status).toBe(401);
    expect(await seaznOfferOf(o.orgId)).toEqual({ offered: true });
    expect((await get("not-a-uuid")).status).toBe(404);
    expect((await put("not-a-uuid", { offered: false })).status).toBe(404);
  });

  it("an API key — even a manage-scoped one — is refused (403, the route ban) for the read and the write, and writes nothing", async () => {
    const o = await organiser();
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${o.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const { secret } = await createApiKey(o.auth, { name: "integration", scopes: ["manage"] });
    const auth = { authorization: `Bearer ${secret}` };
    for (const res of [await get(o.orgId, auth), await put(o.orgId, { offered: false }, auth)]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as Envelope).error?.message).toMatch(/^API keys cannot access this endpoint/);
    }
    expect(await seaznOfferOf(o.orgId)).toEqual({ offered: true });
  });
});

describe("the route is documented and never key-reachable (no DB)", () => {
  it("GET and PUT /orgs/{id}/seazn-hosted are in the OpenAPI document with { offered } and in NEVER_KEY_ROUTES", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, {
        requestBody?: { content: { "application/json": { schema: { properties: Record<string, { type?: string }> } } } };
        responses: Record<string, unknown>;
      }>>;
    };
    const path = doc.paths["/api/v1/orgs/{id}/seazn-hosted"];
    expect(path?.get, "GET documented").toBeDefined();
    expect(path?.put, "PUT documented").toBeDefined();
    const props = path!.put!.requestBody!.content["application/json"].schema.properties;
    expect(Object.keys(props)).toEqual(["offered"]);
    expect(props.offered!.type).toBe("boolean");
    expect(Object.keys(path!.put!.responses)).toEqual(expect.arrayContaining(["200", "403", "404"]));
    expect(NEVER_KEY_ROUTES).toEqual(expect.arrayContaining(["GET /orgs/:id/seazn-hosted", "PUT /orgs/:id/seazn-hosted"]));
  });
});
