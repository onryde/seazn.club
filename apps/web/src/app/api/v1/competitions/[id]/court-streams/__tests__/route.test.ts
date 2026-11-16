// Court streams over HTTP (court stream spec 2026-11-14 §5; plan Task 3): the desk's link, list and withdraw doors,
// driven through their real handlers over a real session. The use-case suite proves the rules; this file proves the ROUTES:
// the wire shape (snake_case, v1 envelope), the status codes, and that the live QR is never cacheable.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    expect(((await refused.json()) as Envelope<unknown>).error!.code).toBe("court_destination_not_youtube");
  });
});
