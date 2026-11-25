// Seazn-hosted video, Phase 4 Task 38: GET/PUT /api/v1/orgs/{id}/stream-defaults — the club's default Score style and timing (V558),
// over the REAL handler, the REAL session door and the REAL tables. Only `requireUser` (who is signed in) is faked, exactly as the
// seazn-hosted route's suite does; `requireOrgAuth`'s role lookup runs against real `org_members` rows.
//
// What this file owns is the WIRING and the ENVELOPES: who may read and who may write (the granted AND the denied pair, and the paused
// admin seat's 402 — the T33e rule), the door before the body, the 400 for a body the schema refuses and for a template the registry
// does not serve, another org's 401, the key ban, and that what the PUT writes is what the GET and the usecase read back. The chain
// a session copies is stream-club-style.test.ts's.
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): the route reads no sport; the chain over every sport is the other file's.
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
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { frozenMemberIds } from "@/server/usecases/entitlement-freeze";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { NEVER_KEY_ROUTES } from "@/server/api-v1/key-scopes";
import { createApiKey } from "@/server/usecases/api-keys";
import { orgStreamDefaultsOf } from "@/server/usecases/org-stream-defaults";
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
const url = (orgId: string) => `http://localhost/api/v1/orgs/${orgId}/stream-defaults`;
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
const NONE = { overlayTemplate: null, overlayDelayMs: null, revision: null };

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
/** Over-quota seats (doc 10 §2.4): `members.max` overridden to 1, which the owner's own seat fills, so an added ADMIN's seat is read-only.
 *  Checked with the engine's own `frozenMemberIds`, so a changed freeze rule fails here instead of freezing nobody. */
async function frozenAdmin(orgId: string): Promise<string> {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, int_value, reason) values (${orgId}, 'members.max', 1, 'frozen seat')
            on conflict (org_id, feature_key) do update set int_value = 1`;
  await invalidateOrgEntitlements(orgId);
  const admin = await memberOf(orgId, "admin");
  expect((await frozenMemberIds(orgId)).has(admin), "PREMISE: the admin's seat is frozen").toBe(true);
  return admin;
}
/** The documented error statuses of PUT /orgs/{id}/stream-defaults. */
const putResponses = () =>
  Object.keys((buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> })
    .paths["/api/v1/orgs/{id}/stream-defaults"]!.put!.responses);
const rowsOf = async (orgId: string) => (await sql`select 1 from org_stream_defaults where org_id = ${orgId}`).length;

describe.skipIf(!HAS_DB)("GET/PUT /orgs/{id}/stream-defaults — the route", () => {
  it("the owner: GET reads nothing set; each PUT answers the stored defaults and the GET and the usecase read them back; a field the body leaves out is left alone; null clears (sequence)", async () => {
    const o = await organiser();
    const first = await get(o.orgId);
    expect(first.status).toBe(200);
    expect(await dataOf(first)).toEqual(NONE);
    expect(await rowsOf(o.orgId), "reading makes no row").toBe(0);
    const steps: [string, unknown, { overlayTemplate: string | null; overlayDelayMs: number | null }][] = [
      ["style only", { overlayTemplate: "bar" }, { overlayTemplate: "bar", overlayDelayMs: null }],
      ["timing only keeps the style", { overlayDelayMs: 4500 }, { overlayTemplate: "bar", overlayDelayMs: 4500 }],
      ["the same body again", { overlayDelayMs: 4500 }, { overlayTemplate: "bar", overlayDelayMs: 4500 }],
      ["a real 0", { overlayDelayMs: 0 }, { overlayTemplate: "bar", overlayDelayMs: 0 }],
      ["both at once", { overlayTemplate: "bug", overlayDelayMs: 2500 }, { overlayTemplate: "bug", overlayDelayMs: 2500 }],
      ["null clears the style alone", { overlayTemplate: null }, { overlayTemplate: null, overlayDelayMs: 2500 }],
      ["null clears both", { overlayTemplate: null, overlayDelayMs: null }, { overlayTemplate: null, overlayDelayMs: null }],
    ];
    let lastRevision = 0;
    for (const [name, body, want] of steps) {
      const res = await put(o.orgId, body);
      expect(res.status, name).toBe(200);
      const answer = (await dataOf(res)) as { overlayTemplate: string | null; overlayDelayMs: number | null; revision: number };
      expect(answer, name).toMatchObject(want);
      expect(answer.revision, `${name}: every save bumps the revision`).toBeGreaterThan(lastRevision);
      lastRevision = answer.revision;
      expect(await dataOf(await get(o.orgId)), `GET after ${name}`).toEqual(answer);
      expect(await orgStreamDefaultsOf(o.orgId), `the usecase after ${name}`).toEqual(answer);
    }
    expect(lastRevision, "seven saves, seven revisions").toBe(steps.length);
    expect(await rowsOf(o.orgId), "one row per org").toBe(1);
  });

  it("the granted AND the denied pair: an owner and an admin write; a viewer reads (200) but its PUT is 403 and writes nothing", async () => {
    const o = await organiser();
    const adminId = await memberOf(o.orgId, "admin");
    const viewerId = await memberOf(o.orgId, "viewer");

    authState.userId = viewerId;
    expect(await dataOf(await get(o.orgId)), "a viewer reads the defaults").toEqual(NONE);
    const denied = await put(o.orgId, { overlayTemplate: "bar" });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as Envelope).error?.message).toBe("Insufficient permissions");
    expect(await rowsOf(o.orgId), "the viewer wrote nothing").toBe(0);

    let granted = 0;
    for (const [who, userId, template] of [["admin", adminId, "bar"], ["owner", o.ownerId, "bug"]] as const) {
      authState.userId = userId;
      const res = await put(o.orgId, { overlayTemplate: template });
      expect(res.status, who).toBe(200);
      expect((await orgStreamDefaultsOf(o.orgId)).overlayTemplate, who).toBe(template);
      granted++;
    }
    expect(granted).toBe(2);
  });

  it("T33e: a PAUSED (frozen) admin seat is read-only — its PUT is 402 members.max (documented) and writes nothing, while its GET still reads; the owner of the same org then writes", async () => {
    const o = await organiser();
    authState.userId = await frozenAdmin(o.orgId);
    expect(await dataOf(await get(o.orgId)), "a frozen admin still reads").toEqual(NONE);
    const refused = await put(o.orgId, { overlayDelayMs: 4500 });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as Envelope).error?.message).toBe("Plan upgrade required: members.max");
    expect(putResponses(), "the 402 is documented").toContain("402");
    expect(await rowsOf(o.orgId), "nothing written").toBe(0);
    authState.userId = o.ownerId;
    expect((await put(o.orgId, { overlayDelayMs: 4500 })).status, "the owner (never frozen)").toBe(200);
    expect((await orgStreamDefaultsOf(o.orgId)).overlayDelayMs).toBe(4500);
  });

  it("a body the schema refuses is 400 and writes nothing; so is a template the registry does not serve — counted, each against the owner's own 200 for a good one", async () => {
    const o = await organiser();
    const bad: unknown[] = [{}, { overlayDelayMs: 30001 }, { overlayDelayMs: -1 }, { overlayDelayMs: 2.5 }, { overlayTemplate: "" }, { overlayTemplate: 7 },
      { streamMode: "composed" }, { overlayTemplate: "bar", extra: 1 }, "{not json", { overlayTemplate: "no-such-template" }, { overlayTemplate: "toString" }];
    let checked = 0;
    for (const body of bad) {
      expect((await put(o.orgId, body)).status, JSON.stringify(body)).toBe(400);
      checked++;
    }
    expect(checked).toBe(bad.length);
    expect(await rowsOf(o.orgId), "nothing written by any of them").toBe(0);
    expect((await put(o.orgId, { overlayTemplate: "bar", overlayDelayMs: 30000 })).status, "the positive pair: the bound itself").toBe(200);
  });

  it("the door before the body: a viewer's MALFORMED body is 403, a non-member's 401 — never the 400 the owner gets for it (counted)", async () => {
    const o = await organiser();
    const viewerId = await memberOf(o.orgId, "viewer");
    const bad: unknown[] = [{}, { overlayDelayMs: "no" }, { overlayTemplate: "bar", extra: 1 }, "{not json"];
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
    expect(await rowsOf(o.orgId), "nobody wrote").toBe(0);
  });

  it("another org: a non-member is refused at the door (401) for the read and the write and writes nothing, and the foreign owner's own save never reaches this org; a malformed org id is 404", async () => {
    const o = await organiser();
    const foreign = await organiser();               // signs in as ANOTHER org's owner
    expect(foreign.orgId).not.toBe(o.orgId);
    expect((await get(o.orgId)).status).toBe(401);
    expect((await put(o.orgId, { overlayTemplate: "bar" })).status).toBe(401);
    expect(await rowsOf(o.orgId)).toBe(0);
    expect((await put(foreign.orgId, { overlayTemplate: "bar" })).status, "the foreign owner writes ITS OWN org").toBe(200);
    expect(await orgStreamDefaultsOf(o.orgId), "…and this org's defaults are untouched").toEqual(NONE);
    expect((await get("not-a-uuid")).status).toBe(404);
    expect((await put("not-a-uuid", { overlayTemplate: "bar" })).status).toBe(404);
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
    for (const res of [await get(o.orgId, auth), await put(o.orgId, { overlayTemplate: "bar" }, auth)]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as Envelope).error?.message).toMatch(/^API keys cannot access this endpoint/);
    }
    expect(await rowsOf(o.orgId)).toBe(0);
  });
});

describe("the route is documented and never key-reachable (no DB)", () => {
  it("GET and PUT /orgs/{id}/stream-defaults are in the OpenAPI document with { overlayTemplate, overlayDelayMs } and in NEVER_KEY_ROUTES", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, {
        requestBody?: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } };
        responses: Record<string, unknown>;
      }>>;
    };
    const path = doc.paths["/api/v1/orgs/{id}/stream-defaults"];
    expect(path?.get, "GET documented").toBeDefined();
    expect(path?.put, "PUT documented").toBeDefined();
    const props = path!.put!.requestBody!.content["application/json"].schema.properties;
    expect(Object.keys(props).sort()).toEqual(["overlayDelayMs", "overlayTemplate"]);
    expect(Object.keys(path!.put!.responses)).toEqual(expect.arrayContaining(["200", "400", "402", "403"]));
    expect(NEVER_KEY_ROUTES).toEqual(expect.arrayContaining(["GET /orgs/:id/stream-defaults", "PUT /orgs/:id/stream-defaults"]));
  });
});
