// Sponsor deals, Task 6 (plan 2026-11-07-sponsor-deals D16, D21; F11) — the deal routes, over the REAL handlers, the REAL
// session door and the REAL tables:
//   POST /api/v1/orgs/{id}/sponsors/{sponsorId}/deals                         create → 201 { deal, checkout_url }
//   GET  /api/v1/orgs/{id}/sponsor-deals[?sponsor_id=]                        list
//   GET  /api/v1/orgs/{id}/sponsor-deals/{dealId}                             get
//   POST /api/v1/orgs/{id}/sponsor-deals/{dealId}/{mark-paid|approve|end|refund}  → 200 SponsorDeal
// Only `requireUser` (who is signed in) is faked, as the report-link routes' suite does; `requireOrgAuth`'s role lookup runs
// against real `org_members` rows.
//
// What this file owns is the WIRING and the ENVELOPES: who may call (D21: every write is an editor's, a viewer reads — the
// granted AND denied pair), the 400 for a body the strict schema refuses, the cross-org 404, the key ban, and the create's
// `{ deal, checkout_url: null }` for a deal that is not online (F11). The usecase's own rules are
// server/usecases/__tests__/sponsor-deals.test.ts's. Sport-agnostic (a deal reads no sport).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { NEVER_KEY_ROUTES } from "@/server/api-v1/key-scopes";
import { SponsorDeal, SponsorDealCreated } from "@/server/api-v1/schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { POST as CREATE } from "../../sponsors/[sponsorId]/deals/route";
import { GET as LIST } from "../route";
import { GET as READ } from "../[dealId]/route";
import { POST as MARK_PAID } from "../[dealId]/mark-paid/route";
import { POST as APPROVE } from "../[dealId]/approve/route";
import { POST as END } from "../[dealId]/end/route";
import { POST as REFUND } from "../[dealId]/refund/route";

const HAS_DB = !!process.env.DATABASE_URL;
const made: string[] = [];

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.length > 0) {
    await sql`delete from sponsor_orders where org_id = any(${made}::uuid[])`;
    await sql`delete from organizations where id = any(${made}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Envelope<T = unknown> = { ok: boolean; data?: T; error?: { code: string; message: string } };
type Deal = { id: string; deal_status: string; payment_status: string; sponsor_id: string };

const json = (body: unknown, headers: HeadersInit = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const create = (orgId: string, sponsorId: string, body: unknown, headers: HeadersInit = {}) =>
  CREATE(new Request(`http://localhost/api/v1/orgs/${orgId}/sponsors/${sponsorId}/deals`, json(body, headers)), {
    params: Promise.resolve({ id: orgId, sponsorId }),
  });
const list = (orgId: string, query = "", headers: HeadersInit = {}) =>
  LIST(new Request(`http://localhost/api/v1/orgs/${orgId}/sponsor-deals${query}`, { headers }), { params: Promise.resolve({ id: orgId }) });
const read = (orgId: string, dealId: string) =>
  READ(new Request(`http://localhost/api/v1/orgs/${orgId}/sponsor-deals/${dealId}`), { params: Promise.resolve({ id: orgId, dealId }) });
const ACTIONS = { "mark-paid": MARK_PAID, approve: APPROVE, end: END, refund: REFUND } as const;
type ActionName = keyof typeof ACTIONS;
const act = (action: ActionName, orgId: string, dealId: string, headers: HeadersInit = {}) =>
  ACTIONS[action](new Request(`http://localhost/api/v1/orgs/${orgId}/sponsor-deals/${dealId}/${action}`, { method: "POST", headers }), {
    params: Promise.resolve({ id: orgId, dealId }),
  });

/** A signed-in OWNER of a fresh community org (real users + org_members rows) with one sponsor and a partner package. */
async function organiser() {
  const { auth } = await seedOrg("community");
  made.push(auth.orgId);
  authState.userId = auth.userId!;
  const [sp] = await sql<{ id: string }[]>`insert into sponsors (org_id, name) values (${auth.orgId}, 'Harbour Bank') returning id`;
  const [pk] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, name, price_cents, currency, tier) values (${auth.orgId}, 'Partner', 5000, 'gbp', 'partner') returning id`;
  return { auth, orgId: auth.orgId, sponsorId: sp!.id, packageId: pk!.id, ownerId: auth.userId! };
}
async function memberOf(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}
const body = (packageId: string, over: Record<string, unknown> = {}) => ({
  package_id: packageId,
  competition_id: null,
  payment_method: "offline",
  go_live: "on_payment",
  ...over,
});
const dealsOf = (orgId: string) => sql<{ id: string }[]>`select id from sponsor_orders where org_id = ${orgId}`;

describe.skipIf(!HAS_DB)("the sponsor deal routes (DB)", () => {
  it("F11: create answers 201 { deal, checkout_url: null } for offline and complimentary, in the documented shape", async () => {
    const o = await organiser();
    let checked = 0;
    for (const over of [{}, { payment_method: "complimentary", go_live: "immediate" }]) {
      const res = await create(o.orgId, o.sponsorId, body(o.packageId, over));
      expect(res.status, JSON.stringify(over)).toBe(201);
      const data = ((await res.json()) as Envelope<{ deal: Deal; checkout_url: string | null }>).data!;
      expect(Object.keys(data).sort()).toEqual(["checkout_url", "deal"]);
      expect(data.checkout_url).toBeNull();
      expect(SponsorDealCreated.safeParse(data).success, "the documented response schema").toBe(true);
      expect(Object.keys(data.deal), "SponsorDeal stays URL-free").not.toContain("checkout_url");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the whole offline walk over HTTP: create → mark-paid → end → refund, each 200 with the documented SponsorDeal; list and get read it", async () => {
    const o = await organiser();
    const deal = ((await (await create(o.orgId, o.sponsorId, body(o.packageId))).json()) as Envelope<{ deal: Deal }>).data!.deal;
    const steps: [ActionName, string][] = [["mark-paid", "live"], ["end", "ended"], ["refund", "ended"]];
    for (const [action, status] of steps) {
      const res = await act(action, o.orgId, deal.id);
      expect(res.status, action).toBe(200);
      const after = ((await res.json()) as Envelope<Deal>).data!;
      expect(SponsorDeal.safeParse(after).success, `${action}: the documented schema`).toBe(true);
      expect(after.deal_status, action).toBe(status);
    }
    const listed = ((await (await list(o.orgId, `?sponsor_id=${o.sponsorId}`)).json()) as Envelope<Deal[]>).data!;
    expect(listed.map((d) => [d.id, d.payment_status])).toEqual([[deal.id, "refunded"]]);
    expect(((await (await read(o.orgId, deal.id)).json()) as Envelope<Deal>).data!.id).toBe(deal.id);
    const approve = await act("approve", o.orgId, deal.id);
    expect(approve.status, "an action the deal does not offer").toBe(409);
  });

  it("D21, the granted AND the denied pair: a viewer is 403 on every POST and writes nothing, 200 on the GETs; an admin passes", async () => {
    const o = await organiser();
    const deal = ((await (await create(o.orgId, o.sponsorId, body(o.packageId, { go_live: "on_approval" }))).json()) as Envelope<{ deal: Deal }>).data!.deal;
    const adminId = await memberOf(o.orgId, "admin");
    const viewerId = await memberOf(o.orgId, "viewer");

    authState.userId = viewerId;
    let denied = 0;
    const createRes = await create(o.orgId, o.sponsorId, body(o.packageId));
    expect(createRes.status, "create").toBe(403);
    denied++;
    for (const action of Object.keys(ACTIONS) as ActionName[]) {
      expect((await act(action, o.orgId, deal.id)).status, action).toBe(403);
      denied++;
    }
    expect(denied, "every POST checked").toBe(5);
    expect((await dealsOf(o.orgId)).length, "the viewer wrote nothing").toBe(1);
    expect((await list(o.orgId)).status).toBe(200);
    expect((await list(o.orgId, `?sponsor_id=${o.sponsorId}`)).status).toBe(200);
    expect((await read(o.orgId, deal.id)).status).toBe(200);
    // The door is asked first: a viewer's malformed body is still a 403.
    expect((await create(o.orgId, o.sponsorId, "not json")).status).toBe(403);

    authState.userId = adminId;
    expect((await act("mark-paid", o.orgId, deal.id)).status).toBe(200);
    expect((await act("approve", o.orgId, deal.id)).status).toBe(200);
  });

  it("another org: a non-member is 401; a foreign deal id through one's own org is 404 on every route; malformed ids 404", async () => {
    const a = await organiser();
    const deal = ((await (await create(a.orgId, a.sponsorId, body(a.packageId))).json()) as Envelope<{ deal: Deal }>).data!.deal;
    const b = await organiser(); // signs in as ANOTHER org's owner
    expect((await act("mark-paid", a.orgId, deal.id)).status, "not a member of A").toBe(401);
    expect((await list(a.orgId)).status, "not a member of A").toBe(401);
    let checked = 0;
    for (const action of Object.keys(ACTIONS) as ActionName[]) {
      expect((await act(action, b.orgId, deal.id)).status, action).toBe(404);
      checked++;
    }
    expect((await read(b.orgId, deal.id)).status).toBe(404);
    expect(((await (await list(b.orgId, `?sponsor_id=${a.sponsorId}`)).json()) as Envelope<Deal[]>).data).toEqual([]);
    expect((await create(b.orgId, a.sponsorId, body(b.packageId))).status, "A's sponsor through B").toBe(404);
    expect(checked).toBe(4);
    expect((await read(b.orgId, "not-a-uuid")).status).toBe(404);
    expect((await act("end", b.orgId, "not-a-uuid")).status).toBe(404);
    expect((await create(b.orgId, "not-a-uuid", body(b.packageId))).status).toBe(404);
    expect((await list(b.orgId, "?sponsor_id=not-a-uuid")).status).toBe(404);
    const [still] = await sql<{ deal_status: string; status: string }[]>`select deal_status, status from sponsor_orders where id = ${deal.id}`;
    expect(still, "A's deal is untouched").toEqual({ deal_status: "awaiting_payment", status: "pending" });
  });

  it("the strict body: an unknown key, a bad enum, a missing field or a non-uuid package is 400 VALIDATION and writes nothing (counted)", async () => {
    const o = await organiser();
    const bad: unknown[] = [
      body(o.packageId, { foo: 1 }),
      body(o.packageId, { checkout_url: "https://x.test" }),
      body(o.packageId, { payment_method: "cash" }),
      body(o.packageId, { go_live: "now" }),
      body(o.packageId, { sponsor_email: "not-an-email" }),
      body(o.packageId, { ends_on: "2026-02-30" }),
      { package_id: o.packageId, payment_method: "offline", go_live: "on_payment" }, // competition_id missing (nullable, not optional)
      body("not-a-uuid"),
      "not json at all",
    ];
    let checked = 0;
    for (const b of bad) {
      const res = await create(o.orgId, o.sponsorId, b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(((await res.json()) as Envelope).error?.code, JSON.stringify(b)).toBe("VALIDATION");
      checked++;
    }
    expect(checked).toBe(bad.length);
    expect(await dealsOf(o.orgId), "nothing was written").toEqual([]);
    expect((await create(o.orgId, o.sponsorId, body(o.packageId))).status, "the positive pair").toBe(201);
  });

  it("an API key — even a manage-scoped one — is refused on every deal route (403, the route ban)", async () => {
    const o = await organiser();
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${o.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const deal = ((await (await create(o.orgId, o.sponsorId, body(o.packageId))).json()) as Envelope<{ deal: Deal }>).data!.deal;
    const { secret } = await createApiKey(o.auth, { name: "integration", scopes: ["manage"] });
    const bearer = { authorization: `Bearer ${secret}` };
    let checked = 0;
    const res = [await create(o.orgId, o.sponsorId, body(o.packageId), bearer), await list(o.orgId, "", bearer)];
    for (const action of Object.keys(ACTIONS) as ActionName[]) res.push(await act(action, o.orgId, deal.id, bearer));
    for (const r of res) {
      expect(r.status).toBe(403);
      expect(((await r.json()) as Envelope).error?.message).toMatch(/^API keys cannot access this endpoint/);
      checked++;
    }
    expect(checked).toBe(6);
    expect(await dealsOf(o.orgId)).toHaveLength(1);
  });
});

/** The seven operations, as key-scopes names them (typed from the plan's D16 list, never read from the code). */
const OPERATIONS = [
  "POST /orgs/:id/sponsors/:sponsorId/deals",
  "GET /orgs/:id/sponsor-deals",
  "GET /orgs/:id/sponsor-deals/:dealId",
  "POST /orgs/:id/sponsor-deals/:dealId/mark-paid",
  "POST /orgs/:id/sponsor-deals/:dealId/approve",
  "POST /orgs/:id/sponsor-deals/:dealId/end",
  "POST /orgs/:id/sponsor-deals/:dealId/refund",
];

describe("the deal routes are documented and never key-reachable (no DB)", () => {
  it("every operation is in the OpenAPI document; the create body is the strict seven fields", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { requestBody?: { content: { "application/json": { schema: { properties: Record<string, unknown>; additionalProperties?: unknown } } } } }>>;
    };
    let checked = 0;
    for (const op of OPERATIONS) {
      const [method, path] = op.split(" ");
      const openapiPath = `/api/v1${path!.replace(/:(\w+)/g, "{$1}")}`;
      expect(doc.paths[openapiPath]?.[method!.toLowerCase()], op).toBeDefined();
      checked++;
    }
    expect(checked).toBe(7);
    const schema = doc.paths["/api/v1/orgs/{id}/sponsors/{sponsorId}/deals"]!.post!.requestBody!.content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["competition_id", "end_current", "ends_on", "go_live", "package_id", "payment_method", "sponsor_email"],
    );
  });

  it("all seven are NEVER_KEY_ROUTES (a money surface, console only)", () => {
    for (const op of OPERATIONS) expect(NEVER_KEY_ROUTES, op).toContain(op);
  });
});
