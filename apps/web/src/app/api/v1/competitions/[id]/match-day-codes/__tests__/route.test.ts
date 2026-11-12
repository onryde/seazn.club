// Match Day codes over HTTP (capture S4 design §3, §9 item 1; MD-1 Task 2): the desk's mint, list and withdraw doors,
// driven through their real handlers over a real session (`requireResourceAuth` / `requireOrgAuth` unmocked, the
// device-links route test's pattern). The use-case suite proves mint/resolve semantics; this file proves the ROUTES:
// an editor mints (201) and a viewer is refused (403), the list re-shows the minted URL, a withdraw is 204 and the code
// then resolves MD_WITHDRAWN. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
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
import { MatchDayCode } from "@/server/api-v1/schemas";
import { resolveMatchDayCode } from "@/server/usecases/match-day-codes";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { seedDay, type Day } from "@/server/usecases/__tests__/_match-day-seed";
import { GET as listGet, POST as mintPost } from "../route";
import { POST as revokePost } from "@/app/api/v1/match-day-codes/[id]/revoke/route";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
vi.stubEnv("OAUTH_BASE_URL", "https://md.test.seazn.club");

const HAS_DB = !!process.env.DATABASE_URL;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown): Request =>
  new Request("https://test.local/api/v1/competitions/x/match-day-codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (): Request => new Request("https://test.local/api/v1/competitions/x/match-day-codes");

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function viewerOf(day: Day): Promise<string> {
  const viewer = await makeUser("viewer");
  await sql`insert into org_members (org_id, user_id, role) values (${day.orgId}, ${viewer.id}, 'viewer')`;
  return viewer.id;
}

describe.skipIf(!HAS_DB)("Match Day code routes", () => {
  it("POST mint 201 for an editor, 403 for a viewer", async () => {
    const day = await seedDay();
    authState.userId = day.auth.userId!;
    const res = await mintPost(post({ scope: { kind: "courts", court_ids: [day.courts.c1] }, can_approve: true }), ctx(day.comp.id));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Envelope<MatchDayCode>;
    const code = MatchDayCode.parse(body.data);
    expect(code.url).toMatch(/^https:\/\/[^/]+\/day\/md_[A-Za-z0-9_-]{43}$/);
    expect(code.scope).toEqual({ kind: "courts", court_ids: [day.courts.c1] });
    expect(code.can_approve).toBe(true);

    authState.userId = await viewerOf(day);
    const refused = await mintPost(post({ scope: { kind: "competition" } }), ctx(day.comp.id));
    expect(refused.status).toBe(403);
    expect((await listGet(get(), ctx(day.comp.id))).status).toBe(403);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from match_day_codes where competition_id = ${day.comp.id}`;
    expect(n!.n).toBe(1);
  });

  it("POST refuses a body that is not a scope (400) and defaults can_approve to off", async () => {
    const day = await seedDay();
    authState.userId = day.auth.userId!;
    expect((await mintPost(post({ scope: { kind: "court" } }), ctx(day.comp.id))).status).toBe(400);
    expect((await mintPost(post({ scope: { kind: "courts", court_ids: [] } }), ctx(day.comp.id))).status).toBe(400);
    const res = await mintPost(post({ scope: { kind: "competition" } }), ctx(day.comp.id));
    expect(res.status).toBe(201);
    expect(((await res.json()) as Envelope<MatchDayCode>).data!.can_approve).toBe(false);
  });

  it("an md_ bearer cannot mint, list or withdraw (403)", async () => {
    const day = await seedDay();
    authState.userId = day.auth.userId!;
    const minted = ((await (await mintPost(post({ scope: { kind: "competition" } }), ctx(day.comp.id))).json()) as Envelope<MatchDayCode>).data!;
    // A minted code always carries its url; only the list's unopenable rows are null (final review I3).
    const token = minted.url!.slice(minted.url!.lastIndexOf("/") + 1);
    const bearer = { authorization: `Bearer ${token}` };
    const withBearer = (r: Request) => new Request(r, { headers: { ...Object.fromEntries(r.headers), ...bearer } });
    expect((await mintPost(withBearer(post({ scope: { kind: "competition" } })), ctx(day.comp.id))).status).toBe(403);
    expect((await listGet(withBearer(get()), ctx(day.comp.id))).status).toBe(403);
    expect((await revokePost(new Request("https://test.local/x", { method: "POST", headers: bearer }), ctx(minted.id))).status).toBe(403);
  });

  it("GET list shows the minted code with its url", async () => {
    const day = await seedDay();
    authState.userId = day.auth.userId!;
    const minted = await mintPost(post({ scope: { kind: "venue", venue_id: day.venues.hallA } }), ctx(day.comp.id));
    const code = ((await minted.json()) as Envelope<MatchDayCode>).data!;
    const res = await listGet(get(), ctx(day.comp.id));
    expect(res.status).toBe(200);
    const list = ((await res.json()) as Envelope<MatchDayCode[]>).data!;
    expect(list).toEqual([code]);
    expect(list[0]!.scope).toEqual({ kind: "venue", venue_id: day.venues.hallA });
  });

  it("revoke 204, then resolve is MD_WITHDRAWN", async () => {
    const day = await seedDay();
    authState.userId = day.auth.userId!;
    const code = ((await (await mintPost(post({ scope: { kind: "competition" } }), ctx(day.comp.id))).json()) as Envelope<MatchDayCode>).data!;
    const token = code.url!.slice(code.url!.lastIndexOf("/") + 1);
    const revoke = () => revokePost(new Request("https://test.local/x", { method: "POST" }), ctx(code.id));

    // A viewer may not withdraw it.
    const editor = authState.userId;
    authState.userId = await viewerOf(day);
    expect((await revoke()).status).toBe(403);
    authState.userId = editor;

    const res = await revoke();
    expect(res.status).toBe(204);
    expect(await resolveMatchDayCode(token, new Date(Date.parse(code.opens_at) + 60_000))).toEqual({ ok: false, refusal: "MD_WITHDRAWN" });
    // A second withdraw is fine; the list no longer shows it; an unknown id is 404.
    expect((await revoke()).status).toBe(204);
    expect(((await (await listGet(get(), ctx(day.comp.id))).json()) as Envelope<MatchDayCode[]>).data).toEqual([]);
    expect((await revokePost(new Request("https://test.local/x", { method: "POST" }), ctx("00000000-0000-4000-8000-000000000001"))).status).toBe(404);
  });
});
