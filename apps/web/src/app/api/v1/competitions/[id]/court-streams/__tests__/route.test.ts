// Court streams over HTTP (court stream spec 2026-11-14 §5; plan Task 3): the desk's link, list and withdraw doors,
// driven through their real handlers over a real session. The use-case suite proves the rules; this file proves the ROUTES:
// the wire shape (snake_case, v1 envelope), the status codes, and that the live QR is never cacheable.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

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
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { frozenMemberIds } from "@/server/usecases/entitlement-freeze";
import { CourtStream } from "@/server/api-v1/schemas";
import { rigApiTarget, rigTarget } from "@/server/relay/__tests__/_session-rig";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { seedDay, type Day } from "@/server/usecases/__tests__/_match-day-seed";
import { GET as listGet, POST as linkPost } from "../route";
import { POST as withdrawPost } from "@/app/api/v1/court-streams/[id]/withdraw/route";

const HAS_DB = !!process.env.DATABASE_URL;
const saved = { kek: process.env.RELAY_KEK, min: process.env.COURT_MIN_APP_VERSION };
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.COURT_MIN_APP_VERSION = "1.0.14-1200";
});
afterAll(async () => {
  if (saved.kek === undefined) delete process.env.RELAY_KEK; else process.env.RELAY_KEK = saved.kek;
  if (saved.min === undefined) delete process.env.COURT_MIN_APP_VERSION; else process.env.COURT_MIN_APP_VERSION = saved.min;
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

afterEach(() => vi.unstubAllEnvs());

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message: string } }
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown): Request =>
  new Request("https://test.local/api/v1/competitions/x/court-streams", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const get = (): Request => new Request("https://test.local/api/v1/competitions/x/court-streams");
const withdraw = (): Request => new Request("https://test.local/api/v1/court-streams/x/withdraw", { method: "POST" });

async function viewerOf(day: Day): Promise<string> {
  const viewer = await makeUser("viewer");
  await sql`insert into org_members (org_id, user_id, role) values (${day.orgId}, ${viewer.id}, 'viewer')`;
  return viewer.id;
}

describe.skipIf(!HAS_DB)("court stream routes", () => {
  it("POST 201 with the wire shape and a no-store QR; GET lists it, no-store; withdraw 204, then the list is empty", async () => {
    const day = await seedDay();
    const api = await rigApiTarget(day.orgId, "Club channel");
    authState.userId = day.auth.userId!;
    const res = await linkPost(post({ court_id: day.courts.c2, target_id: api.targetId }), ctx(day.comp.id));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const link = CourtStream.parse(((await res.json()) as Envelope<unknown>).data);
    expect(link).toMatchObject({ court_id: day.courts.c2, court_name: "Court 2", target: { id: api.targetId, label: "Club channel" } });
    expect(link.qr).toMatchObject({ v: 2, slot: 0 });
    expect(link.qr!.exp).toBe(Math.floor(Date.parse(link.expires_at) / 1000));

    const listed = await listGet(get(), ctx(day.comp.id));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    expect(((await listed.json()) as Envelope<unknown[]>).data).toEqual([link]);

    const gone = await withdrawPost(withdraw(), ctx(link.id));
    expect(gone.status).toBe(204);
    expect((await withdrawPost(withdraw(), ctx(link.id))).status).toBe(204);
    expect(((await (await listGet(get(), ctx(day.comp.id))).json()) as Envelope<unknown[]>).data).toEqual([]);
  });

  it("refuses a viewer (403), a body that is not a court and a target (400), another org's withdraw (refused at the door) and a pasted key (422)", async () => {
    const day = await seedDay();
    const api = await rigApiTarget(day.orgId, "Club channel");
    authState.userId = day.auth.userId!;
    const link = CourtStream.parse(((await (await linkPost(post({ court_id: day.courts.c1, target_id: api.targetId }), ctx(day.comp.id))).json()) as Envelope<unknown>).data);
    expect((await linkPost(post({ court_id: "nope" }), ctx(day.comp.id))).status).toBe(400);

    authState.userId = await viewerOf(day);
    expect((await linkPost(post({ court_id: day.courts.c2, target_id: api.targetId }), ctx(day.comp.id))).status).toBe(403);
    expect((await listGet(get(), ctx(day.comp.id))).status).toBe(403);
    expect((await withdrawPost(withdraw(), ctx(link.id))).status).toBe(403);

    const other = await seedDay();
    authState.userId = other.auth.userId!;
    expect([401, 403, 404]).toContain((await withdrawPost(withdraw(), ctx(link.id))).status);
    const [row] = await sql<{ withdrawn_at: Date | null }[]>`select withdrawn_at from court_stream_links where id = ${link.id}`;
    expect(row!.withdrawn_at).toBeNull();

    authState.userId = day.auth.userId!;
    const pasted = await rigTarget(day.orgId, "Pasted");
    const refused = await linkPost(post({ court_id: day.courts.c2, target_id: pasted }), ctx(day.comp.id));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Envelope<unknown>).error!.code).toBe("court_destination_unsupported");
  });
  // Task 37: a court may stream to the org's Seazn destination. The wire answers are the use case's, through the real door.
  it("Task 37: POST on the org's Seazn destination is 201 with a no-store QR while LIVE is on; LIVE off is 422 seazn_unavailable and writes nothing; a pasted key is 422 court_destination_unsupported — and the operation documents all three", async () => {
    const day = await seedDay();
    authState.userId = day.auth.userId!;
    const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${day.orgId} and kind = 'seazn'`;
    expect(seazn, "PREMISE: the org has its Seazn row").toBeDefined();
    vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
    const ok = await linkPost(post({ court_id: day.courts.c2, target_id: seazn!.id }), ctx(day.comp.id));
    expect(ok.status).toBe(201);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(CourtStream.parse(((await ok.json()) as Envelope<unknown>).data)).toMatchObject({ target: { id: seazn!.id } });

    vi.stubEnv("SEAZN_HOSTED_LIVE", "false");
    const closed = await linkPost(post({ court_id: day.courts.c1, target_id: seazn!.id }), ctx(day.comp.id));
    expect([closed.status, ((await closed.json()) as Envelope<unknown>).error!.code]).toEqual([422, "seazn_unavailable"]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from court_stream_links where org_id = ${day.orgId}`;
    expect(n, "only the first link was written").toBe(1);

    const op = (buildOpenApiDocument() as { paths: Record<string, Record<string, { summary: string }>> }).paths["/api/v1/competitions/{id}/court-streams"]!.post!;
    for (const code of ["court_destination_unsupported", "seazn_unavailable"]) expect(op.summary, code).toContain(code);
    expect(op.summary, "the retired code is gone from the summary").not.toContain("court_destination_not_youtube");
  });

  // Task 37 (T33e): a court start by a paused admin. The Match Day card reads the 402's `feature_key` to say so (`linkFailureKey`), so
  // THIS is the wire shape it reads — the door's write scope, which the use case's own role check does not see.
  it("Task 37: a FROZEN admin seat (members.max, doc 10 §2.4) is 402 PAYMENT_REQUIRED with feature_key members.max on the link door, nothing written; the owner of the same org links", async () => {
    const day = await seedDay();
    const api = await rigApiTarget(day.orgId, "Club channel");
    await sql`insert into org_entitlement_overrides (org_id, feature_key, int_value, reason) values (${day.orgId}, 'members.max', 1, 'frozen seat')
              on conflict (org_id, feature_key) do update set int_value = 1`;
    await invalidateOrgEntitlements(day.orgId);
    const admin = await makeUser("admin");
    await sql`insert into org_members (org_id, user_id, role) values (${day.orgId}, ${admin.id}, 'admin')`;
    expect((await frozenMemberIds(day.orgId)).has(admin.id), "PREMISE: the admin's seat is frozen").toBe(true);
    authState.userId = admin.id;
    const refused = await linkPost(post({ court_id: day.courts.c2, target_id: api.targetId }), ctx(day.comp.id));
    expect(refused.status).toBe(402);
    const body = (await refused.json()) as { error: { code: string; feature_key?: string } };
    expect(body.error.code).toBe("PAYMENT_REQUIRED");
    expect(body.error.feature_key, "the paused seat's 402 names members.max").toBe("members.max");
    expect((await sql`select 1 from court_stream_links where org_id = ${day.orgId}`).length, "nothing written").toBe(0);
    authState.userId = day.auth.userId!;
    expect((await linkPost(post({ court_id: day.courts.c2, target_id: api.targetId }), ctx(day.comp.id))).status, "the owner is never frozen").toBe(201);
  });
});
