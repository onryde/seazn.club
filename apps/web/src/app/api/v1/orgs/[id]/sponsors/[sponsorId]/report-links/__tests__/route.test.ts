// R4 sponsors on stream, S13 - the two report-link routes, over the REAL handlers, the REAL session door and the REAL tables:
//   POST   /api/v1/orgs/{id}/sponsors/{sponsorId}/report-links   (create; the url is answered ONCE)
//   DELETE /api/v1/orgs/{id}/sponsor-report-links/{linkId}       (revoke)
// Only `requireUser` (who is signed in) is faked, as the S12 settings route's suite does; `requireOrgAuth`'s role lookup runs
// against real `org_members` rows.
//
// What this file owns is the WIRING and the ENVELOPES: who may call (R19's granted AND denied pair: owner/admin vs viewer, and a
// non-member at the door), the 400 for a body the schema refuses, the cross-org 404, the key ban, that the url's token hashes to
// the stored row, and that neither the route nor anything under it logs the token. The usecase's own rules are
// server/sponsors/__tests__/report-links.test.ts's. Sport-agnostic (a link reads no sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

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
import { log } from "@/server/logger";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { NEVER_KEY_ROUTES } from "@/server/api-v1/key-scopes";
import { ENDS_BEFORE_STARTS } from "@/server/api-v1/schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { POST } from "../route";
import { DELETE } from "../../../../sponsor-report-links/[linkId]/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  for (const level of LEVELS) vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
});
afterEach(() => vi.restoreAllMocks());

type Envelope<T = unknown> = { ok: boolean; data?: T; error?: { code: string; message: string; issues?: { path: unknown[]; message: string }[] } };

const create = (orgId: string, sponsorId: string, body: unknown, headers: HeadersInit = {}) =>
  POST(
    new Request(`http://localhost/api/v1/orgs/${orgId}/sponsors/${sponsorId}/report-links`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: orgId, sponsorId }) },
  );
const revoke = (orgId: string, linkId: string, headers: HeadersInit = {}) =>
  DELETE(
    new Request(`http://localhost/api/v1/orgs/${orgId}/sponsor-report-links/${linkId}`, { method: "DELETE", headers }),
    { params: Promise.resolve({ id: orgId, linkId }) },
  );

const BODY = { competitionId: null, from: "2026-01-01", to: "2026-12-31" };

/** A signed-in OWNER of a fresh org (real users + org_members rows) with one sponsor. */
async function organiser() {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  const [sp] = await sql<{ id: string }[]>`insert into sponsors (org_id, name) values (${auth.orgId}, 'Harbour Bank') returning id`;
  return { auth, orgId: auth.orgId, sponsorId: sp!.id, ownerId: auth.userId! };
}
async function memberOf(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}
const linksOf = (orgId: string) => sql<{ id: string; token_hash: Buffer; revoked_at: Date | null }[]>`
  select id, token_hash, revoked_at from sponsor_report_links where org_id = ${orgId} order by created_at`;

describe.skipIf(!HAS_DB)("POST /orgs/{id}/sponsors/{sponsorId}/report-links and DELETE /orgs/{id}/sponsor-report-links/{linkId}", () => {
  it("create 201 answers {id, url} once - the url's token hashes to the stored row - then revoke 200, and a second revoke 404; nothing logs the token", async () => {
    const o = await organiser();
    const res = await create(o.orgId, o.sponsorId, BODY);
    expect(res.status).toBe(201);
    const data = ((await res.json()) as Envelope<{ id: string; url: string }>).data!;
    expect(Object.keys(data).sort()).toEqual(["id", "url"]);
    const token = /^\/r\/sponsor\/([A-Za-z0-9_-]{43})$/.exec(data.url)?.[1];
    expect(token, "a /r/sponsor/<43-char base64url> url").toBeDefined();
    const [row] = await linksOf(o.orgId);
    expect(row!.id).toBe(data.id);
    expect(row!.token_hash.equals(createHash("sha256").update(token!, "utf8").digest())).toBe(true);

    const first = await revoke(o.orgId, data.id);
    expect(first.status).toBe(200);
    expect(((await first.json()) as Envelope).data).toEqual({ revoked: true });
    expect((await linksOf(o.orgId))[0]!.revoked_at).toBeInstanceOf(Date);
    const second = await revoke(o.orgId, data.id);
    expect(second.status).toBe(404);
    expect(((await second.json()) as Envelope).error?.message).toBe("report link not found");

    log.info({ probe: true }, "spy probe");
    expect(logged.length, "the spies observe the logger").toBeGreaterThan(0);
    for (const args of logged) expect(JSON.stringify(args).includes(token!)).toBe(false);
  });

  it("R19, the granted AND the denied pair: a viewer is 403 on both routes and nothing changes; an admin and the owner pass", async () => {
    const o = await organiser();
    const adminId = await memberOf(o.orgId, "admin");
    const viewerId = await memberOf(o.orgId, "viewer");

    authState.userId = viewerId;
    const denied = await create(o.orgId, o.sponsorId, BODY);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as Envelope).error?.message).toBe("Insufficient permissions");
    expect(await linksOf(o.orgId), "the viewer wrote nothing").toEqual([]);

    const ids: string[] = [];
    for (const userId of [adminId, o.ownerId]) {
      authState.userId = userId;
      const res = await create(o.orgId, o.sponsorId, BODY);
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as Envelope<{ id: string }>).data!.id);
    }
    expect(ids).toHaveLength(2);

    authState.userId = viewerId;
    const deniedRevoke = await revoke(o.orgId, ids[0]!);
    expect(deniedRevoke.status).toBe(403);
    expect((await linksOf(o.orgId)).map((l) => l.revoked_at), "both still live").toEqual([null, null]);
    // A viewer's malformed body is still a 403, not a 400: the door is asked first.
    expect((await create(o.orgId, o.sponsorId, "not json")).status).toBe(403);

    authState.userId = adminId;
    expect((await revoke(o.orgId, ids[0]!)).status).toBe(200);
  });

  it("another org: a non-member is 401 at the door; a foreign owner revoking through their OWN org is 404 and the link stays live; another org's sponsor is 404", async () => {
    const a = await organiser();
    const link = ((await (await create(a.orgId, a.sponsorId, BODY)).json()) as Envelope<{ id: string }>).data!;
    const b = await organiser();                     // signs in as ANOTHER org's owner

    expect((await create(a.orgId, a.sponsorId, BODY)).status, "not a member of A").toBe(401);
    expect((await revoke(a.orgId, link.id)).status, "not a member of A").toBe(401);
    const cross = await revoke(b.orgId, link.id);
    expect(cross.status).toBe(404);
    expect(((await cross.json()) as Envelope).error?.message).toBe("report link not found");
    expect((await linksOf(a.orgId))[0]!.revoked_at, "A's link is still live").toBeNull();

    const foreignSponsor = await create(b.orgId, a.sponsorId, BODY);
    expect(foreignSponsor.status).toBe(404);
    expect(((await foreignSponsor.json()) as Envelope).error?.message).toBe("sponsor not found");
    expect(await linksOf(b.orgId)).toEqual([]);
    expect((await create("not-a-uuid", a.sponsorId, BODY)).status).toBe(404);
    expect((await create(b.orgId, "not-a-uuid", BODY)).status).toBe(404);
    expect((await revoke(b.orgId, "not-a-uuid")).status).toBe(404);
  });

  it("a malformed body is 400 VALIDATION and writes nothing (counted); to before from names the field with the shared sentence", async () => {
    const o = await organiser();
    const bad: unknown[] = [
      { ...BODY, from: "2026-02-30" },
      { ...BODY, from: "2026/01/01" },
      { ...BODY, to: "" },
      { ...BODY, competitionId: "not-a-uuid" },
      { from: "2026-01-01", to: "2026-12-31" },
      { competitionId: null, to: "2026-12-31" },
      "not json at all",
    ];
    let checked = 0;
    for (const body of bad) {
      const res = await create(o.orgId, o.sponsorId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as Envelope).error?.code, JSON.stringify(body)).toBe("VALIDATION");
      checked++;
    }
    expect(checked).toBe(bad.length);
    const inverted = await create(o.orgId, o.sponsorId, { ...BODY, from: "2026-06-02", to: "2026-06-01" });
    expect(inverted.status).toBe(400);
    const issues = ((await inverted.json()) as Envelope).error!.issues!;
    expect(issues.map((i) => [i.path, i.message])).toEqual([[["to"], ENDS_BEFORE_STARTS]]);
    expect(await linksOf(o.orgId), "nothing was written").toEqual([]);
    // The positive pair: one day is a valid period.
    expect((await create(o.orgId, o.sponsorId, { ...BODY, from: "2026-06-01", to: "2026-06-01" })).status).toBe(201);
  });

  it("an API key - even a manage-scoped one - is refused on both routes (403, the route ban) and changes nothing", async () => {
    const o = await organiser();
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${o.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const link = ((await (await create(o.orgId, o.sponsorId, BODY)).json()) as Envelope<{ id: string }>).data!;
    const { secret } = await createApiKey(o.auth, { name: "integration", scopes: ["manage"] });
    const bearer = { authorization: `Bearer ${secret}` };
    const viaKey = await create(o.orgId, o.sponsorId, BODY, bearer);
    expect(viaKey.status).toBe(403);
    expect(((await viaKey.json()) as Envelope).error?.message).toMatch(/^API keys cannot access this endpoint/);
    const revokeViaKey = await revoke(o.orgId, link.id, bearer);
    expect(revokeViaKey.status).toBe(403);
    expect((await linksOf(o.orgId)).map((l) => l.revoked_at)).toEqual([null]);
  });
});

describe("the routes are documented and never key-reachable (no DB)", () => {
  it("both operations are in the OpenAPI document with the create body's three fields", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { requestBody?: { content: { "application/json": { schema: { properties: Record<string, unknown> } } } } }>>;
    };
    const post = doc.paths["/api/v1/orgs/{id}/sponsors/{sponsorId}/report-links"]?.post;
    const del = doc.paths["/api/v1/orgs/{id}/sponsor-report-links/{linkId}"]?.delete;
    expect(post, "POST is documented").toBeDefined();
    expect(del, "DELETE is documented").toBeDefined();
    expect(Object.keys(post!.requestBody!.content["application/json"].schema.properties).sort()).toEqual(["competitionId", "from", "to"]);
  });

  it("both are NEVER_KEY_ROUTES (a bearer link to a sponsor's numbers is minted from the console only)", () => {
    expect(NEVER_KEY_ROUTES).toContain("POST /orgs/:id/sponsors/:sponsorId/report-links");
    expect(NEVER_KEY_ROUTES).toContain("DELETE /orgs/:id/sponsor-report-links/:linkId");
  });
});
