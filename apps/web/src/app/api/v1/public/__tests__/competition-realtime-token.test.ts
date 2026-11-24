// Realtime push nudges (spec 2026-11-24 §4.1; plan Task 12 / T3.2): `GET /api/v1/public/competitions/{id}/realtime-token`, the
// subscriber token for a competition's private `division:{id}` topics (V556 reads the token's `division_ids` array), through
// the REAL route, the real Postgres reads and a real HS256 mint whose output is verified with jose. Skipped without
// DATABASE_URL.
//
// What is pinned, each against the plan's decisions, never the code under test:
//   - the spectator path: a public (or unlisted) competition whose org holds `realtime` answers 200 with EVERY division of it
//     (a division not yet live included), read back from `public_divisions_v` as the oracle; an ARCHIVED division (the
//     product's withdrawal) is absent on both paths and never counts toward a cap; `private, no-store`; `expiresAt` in
//     epoch SECONDS = the token's own `exp` = now + 3600; the token's `division_ids` = the reply's `divisionIds`;
//   - refusals: not entitled 403; a private competition 404 (anonymous, and a signed-in stranger); an unknown or slug id 404;
//     0 divisions 403 `no_divisions`; 101 divisions 403 `too_many_divisions` (100 is served); none of them mints;
//   - the official path (pin 17): any org role, or an ACCEPTED official on a fixture of the competition, gets every division
//     of a private or non-entitled competition; a declined, pending or withdrawn official does not;
//   - the sequence: a second call mints a FRESH token; a division deleted after a mint is absent from the next; an uppercase
//     id resolves through the competition's own row (lowercase ids in the token);
//   - the server's own refusals (no Supabase, a refused url, a failed mint) answer 503 REALTIME_UNAVAILABLE, once to Sentry;
//   - the hub document Redis holds for the same competition carries no token and no `token` key.
// The rate-limit bucket is pinned in poll-rate-limit.test.ts; the log lines in server/__tests__/logger-redact.test.ts.
// Applies to another sport: N/A (no sport rules): the door reads no sport.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { decodeJwt, jwtVerify } from "jose";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
  withScope: (cb: (scope: object) => void) => cb({ setUser() {}, setTag() {}, setExtras() {} }),
}));
// The signed-in user: the cookie session is doubled at its reader, everything after it (org roles, officials) is real.
const who = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: async () => (who.userId === null ? null : { id: who.userId, email: `${who.userId}@test.local`, display_name: "T" }),
}));
// Every mint is counted (and still made, by the real signer): a refusal must never reach it.
const mints = vi.hoisted(() => ({ calls: [] as Array<{ competitionId: string; divisionIds: string[] }> }));
vi.mock("@/lib/realtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/realtime")>();
  return {
    ...real,
    mintDivisionToken: (competitionId: string, divisionIds: readonly string[], expiresAt: Date) => {
      mints.calls.push({ competitionId, divisionIds: [...divisionIds] });
      return real.mintDivisionToken(competitionId, divisionIds, expiresAt);
    },
  };
});
// The hub's Redis is the in-memory lease fake, so the document the hub route caches can be read back.
vi.mock("@/lib/cache", async (importOriginal) => {
  const { fakeLeaseCache } = await import("@/lib/__tests__/_fake-lease-cache");
  return { ...(await importOriginal<typeof import("@/lib/cache")>()), ...fakeLeaseCache.module() };
});

import { sql } from "@/lib/db";
import * as Sentry from "@sentry/nextjs";
import { fakeLeaseCache } from "@/lib/__tests__/_fake-lease-cache";
import { publicHubCacheKey } from "@/server/public-site/hub-doc-cache-keys";
import { CompetitionRealtimeToken } from "@/server/api-v1/schemas";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { log } from "@/server/logger";
import { competitionRealtimeFor, type DivisionRealtimePort } from "@/server/public-site/division-realtime";
import { GET } from "../competitions/[id]/realtime-token/route";
import { GET as HUB } from "../orgs/[orgSlug]/competitions/[slug]/hub/route";

const HAS_DB = !!process.env.DATABASE_URL;

const SUPABASE_URL = "https://divrealtime.supabase.co";
const ANON_KEY = "sb_publishable_divrealtime_anon";
const JWT_SECRET = `div-realtime-test-${randomBytes(24).toString("hex")}`;
const SECRET_KEY = new TextEncoder().encode(JWT_SECRET);
/** Plan Task 12: "TTL 3600". */
const TTL_S = 3600;
/** Plan Task 12: "More than 100 → 403 too_many_divisions". */
const CAP = 100;
const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET", "SUPABASE_JWT_ALG",
  "SUPABASE_JWT_PRIVATE_KEY", "SUPABASE_JWT_SIGNING_KEY_B64", "SUPABASE_JWT_KID",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.SUPABASE_JWT_ALG = "HS256";
}
beforeEach(() => {
  baseEnv();
  who.userId = null;
  mints.calls.length = 0;
  fakeLeaseCache.reset();
  vi.mocked(Sentry.captureException).mockClear();
});
afterEach(() => { vi.useRealTimers(); });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
interface Comp { orgId: string; orgSlug: string; compId: string; compSlug: string; fixtureId: string | null }

/** A community org whose `realtime` is set by override, one competition of `visibility` and `divisions` divisions: the first
 *  `active` with a stage and one fixture (an official's assignment and the hub need one), every other in `setup` (not live). */
async function seed(opts: { realtime: boolean; visibility: "public" | "unlisted" | "private"; divisions: number }): Promise<Comp> {
  const s = randomUUID().slice(0, 8);
  const orgSlug = `rt-div-${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"RT Div " + s}, ${orgSlug}) returning id`;
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${orgId}, 'realtime', ${opts.realtime}, 'rt division door unit')`;
  const compSlug = `rt-div-cup-${s}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${orgId}, ${"RT Div Cup " + s}, ${compSlug}, ${opts.visibility}, 'live') returning id`;
  if (opts.divisions > 0) {
    await sql`
      insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
      select ${orgId}, ${compId}, 'Div ' || n, 'div-' || n || '-' || ${s}, 'generic', 'score',
             case when n = 1 then 'active' else 'setup' end, ${sql.json(DIVISION_CONFIG)}, '1.0.0'
      from generate_series(1, ${opts.divisions}) n`;
  }
  let fixtureId: string | null = null;
  if (opts.divisions > 0) {
    const [{ id: divId }] = await sql<{ id: string }[]>`select id from divisions where competition_id = ${compId} and status = 'active'`;
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (org_id, division_id, kind, name, seq) values (${orgId}, ${divId}, 'league', 'League', 1) returning id`;
    [{ id: fixtureId }] = await sql<{ id: string }[]>`
      insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
      values (${orgId}, ${divId}, ${stageId}, 1, 1, 1) returning id`;
  }
  return { orgId, orgSlug, compId, compSlug, fixtureId };
}

/** The officials' oracle: every division of the competition the product still holds (an archived one is withdrawn:
 *  `archiveDivision` sets `archived_at`). */
async function divisionsOf(compId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from divisions where competition_id = ${compId} and archived_at is null`;
  return rows.map((r) => r.id).sort();
}
/** The spectators' oracle: the competition's divisions as the PUBLIC view lists them. */
async function publicDivisionsOf(compId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from public_divisions_v where competition_id = ${compId}`;
  return rows.map((r) => r.id).sort();
}
/** Withdraw a division the way the product does (`archiveDivision`: archived_at, the row kept). */
async function archive(divisionId: string): Promise<void> {
  await sql`update divisions set archived_at = now() where id = ${divisionId}`;
}

/** A signed-in user holding `role` in the org. */
async function member(orgId: string, role: "owner" | "admin" | "viewer"): Promise<string> {
  const u = await makeUser(`rt-${role}`);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}

/** A signed-in user who is NOT a member, listed as an official on the competition's fixture with `response`. */
async function official(c: Comp, response: "accepted" | "declined" | "pending"): Promise<{ userId: string; officialId: string }> {
  const u = await makeUser(`rt-official-${response}`);
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id) values (${c.orgId}, 'Ref', ${u.id}) returning id`;
  const [off] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${c.orgId}, ${person!.id}, 'Ref', ${sql.json(["referee"])}) returning id`;
  await sql`
    insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
    values (${c.orgId}, ${c.fixtureId}, ${off!.id}, 'referee', ${response})`;
  return { userId: u.id, officialId: off!.id };
}

const IP = "203.0.113.70";
const door = (id: string): Promise<Response> =>
  GET(new Request(`https://test.local/api/v1/public/competitions/${encodeURIComponent(id)}/realtime-token`, { headers: { "x-forwarded-for": IP } }),
    { params: Promise.resolve({ id }) });
type Body = { ok: boolean; data?: unknown; error?: { code: string; message: string } };
const bodyOf = async (res: Response): Promise<Body> => (await res.json()) as Body;
async function served(res: Response): Promise<CompetitionRealtimeToken> {
  const b = await bodyOf(res);
  expect(res.status, JSON.stringify(b.error)).toBe(200);
  expect(b.ok).toBe(true);
  expect(res.headers.get("cache-control"), "the token is a secret: never cached anywhere").toBe("private, no-store");
  const data = CompetitionRealtimeToken.parse(b.data);
  for (const [name, value] of res.headers) expect(value, `header ${name}`).not.toContain(data.token);
  return data;
}
async function refused(res: Response, status: number, code?: string): Promise<void> {
  const b = await bodyOf(res);
  expect(res.status, JSON.stringify(b)).toBe(status);
  expect(b.ok).toBe(false);
  if (code !== undefined) expect(b.error?.code).toBe(code);
  expect(JSON.stringify(b), "a refusal carries no token").not.toMatch(/eyJ/);
}
/** The token's claims, verified with the deployment's own key. */
async function claimsOf(token: string) {
  const { payload } = await jwtVerify(token, SECRET_KEY, { audience: "authenticated" });
  return payload as { division_ids: string[]; exp: number; sub: string; role: string };
}

describe.skipIf(!HAS_DB)("GET /api/v1/public/competitions/{id}/realtime-token — spectators", () => {
  it("anonymous, entitled, public: 200 with EVERY division (one not yet live among them), no-store, exp = expiresAt = now + 3600", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 3 });
    const expected = await publicDivisionsOf(c.compId);
    expect(expected, "PREMISE: three divisions").toHaveLength(3);
    const [{ n: notLive }] = await sql<{ n: number }[]>`select count(*)::int as n from divisions where competition_id = ${c.compId} and status = 'setup'`;
    expect(notLive, "PREMISE: two of them are not live yet").toBe(2);
    const before = Math.floor(Date.now() / 1000);
    const data = await served(await door(c.compId));
    const after = Math.floor(Date.now() / 1000);
    expect([...data.divisionIds].sort()).toEqual(expected);
    expect(data.url).toBe(SUPABASE_URL);
    expect(data.apikey).toBe(ANON_KEY);
    const claims = await claimsOf(data.token);
    expect([...claims.division_ids].sort(), "the token reads exactly the reply's divisions").toEqual([...data.divisionIds].sort());
    expect(claims.exp, "expiresAt is the token's own exp, in seconds").toBe(data.expiresAt);
    expect(data.expiresAt).toBeGreaterThanOrEqual(before + TTL_S);
    expect(data.expiresAt).toBeLessThanOrEqual(after + TTL_S);
    expect(claims.role).toBe("authenticated");
    expect(claims.sub).toBe(`public-competition:${c.compId}`);
    expect(mints.calls).toHaveLength(1);
  });

  it("an unlisted competition is readable by anyone with the link: 200 too", async () => {
    const c = await seed({ realtime: true, visibility: "unlisted", divisions: 2 });
    expect([...(await served(await door(c.compId))).divisionIds].sort()).toEqual(await publicDivisionsOf(c.compId));
  });

  it("anonymous, NOT entitled: 403, and nothing is minted", async () => {
    const c = await seed({ realtime: false, visibility: "public", divisions: 2 });
    await refused(await door(c.compId), 403);
    expect(mints.calls).toEqual([]);
  });

  it("a private competition: 404 to an anonymous caller and to a signed-in stranger; nothing is minted", async () => {
    const c = await seed({ realtime: true, visibility: "private", divisions: 2 });
    await refused(await door(c.compId), 404);
    who.userId = (await makeUser("rt-stranger")).id;
    await refused(await door(c.compId), 404);
    expect(mints.calls).toEqual([]);
  });

  it("an unknown id and a slug: 404 (never a 500 from a uuid cast), nothing minted", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 1 });
    await refused(await door(randomUUID()), 404);
    await refused(await door(c.compSlug), 404);
    await refused(await door("not-a-uuid-at-all-but-36-chars-long!"), 404);
    who.userId = (await makeUser("rt-slug")).id;
    await refused(await door(c.compSlug), 404);
    expect(mints.calls).toEqual([]);
  });

  it("an UPPERCASE id resolves through the competition's own row: lowercase division ids, the row's id in sub", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 2 });
    const data = await served(await door(c.compId.toUpperCase()));
    expect([...data.divisionIds].sort()).toEqual(await publicDivisionsOf(c.compId));
    for (const id of data.divisionIds) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await claimsOf(data.token)).sub).toBe(`public-competition:${c.compId}`);
  });

  it("0 divisions: 403 no_divisions, not a token with []", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 0 });
    await refused(await door(c.compId), 403, "no_divisions");
    expect(mints.calls).toEqual([]);
  });

  it("101 divisions: 403 too_many_divisions; exactly 100 is served with all 100", async () => {
    const big = await seed({ realtime: true, visibility: "public", divisions: CAP + 1 });
    await refused(await door(big.compId), 403, "too_many_divisions");
    expect(mints.calls).toEqual([]);
    const full = await seed({ realtime: true, visibility: "public", divisions: CAP });
    const data = await served(await door(full.compId));
    expect(data.divisionIds).toHaveLength(CAP);
    expect([...data.divisionIds].sort()).toEqual(await publicDivisionsOf(full.compId));
  });

  it("a second call mints a FRESH token for the same divisions", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 2 });
    const t0 = new Date();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const first = await served(await door(c.compId));
    vi.setSystemTime(new Date(t0.getTime() + 2_000));
    const second = await served(await door(c.compId));
    expect(second.token).not.toBe(first.token);
    expect(second.expiresAt).toBe(first.expiresAt + 2);
    expect([...second.divisionIds].sort()).toEqual([...first.divisionIds].sort());
    expect(mints.calls).toHaveLength(2);
  });

  it("a division deleted after a mint is absent from the next; the others stay", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 3 });
    const first = await served(await door(c.compId));
    const [gone] = await sql<{ id: string }[]>`select id from divisions where competition_id = ${c.compId} and status = 'setup' limit 1`;
    await sql`delete from divisions where id = ${gone!.id}`;
    const second = await served(await door(c.compId));
    expect(first.divisionIds).toContain(gone!.id);
    expect(second.divisionIds).not.toContain(gone!.id);
    expect((await claimsOf(second.token)).division_ids).not.toContain(gone!.id);
    expect([...second.divisionIds].sort()).toEqual(await publicDivisionsOf(c.compId));
    expect(second.divisionIds).toHaveLength(2);
  });
});

describe.skipIf(!HAS_DB)("GET /api/v1/public/competitions/{id}/realtime-token — an ARCHIVED division (the product's withdrawal)", () => {
  it("a spectator: an archived division's id is gone from the next answer, the others stay", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 3 });
    const first = await served(await door(c.compId));
    const [gone] = await sql<{ id: string }[]>`select id from divisions where competition_id = ${c.compId} and status = 'setup' limit 1`;
    await archive(gone!.id);
    const [{ n: kept }] = await sql<{ n: number }[]>`select count(*)::int as n from divisions where competition_id = ${c.compId}`;
    expect(kept, "PREMISE: the archived row is still in the base table").toBe(3);
    const second = await served(await door(c.compId));
    expect(first.divisionIds).toContain(gone!.id);
    expect(second.divisionIds).not.toContain(gone!.id);
    expect((await claimsOf(second.token)).division_ids).not.toContain(gone!.id);
    expect([...second.divisionIds].sort()).toEqual(await publicDivisionsOf(c.compId));
    expect(second.divisionIds).toHaveLength(2);
  });

  it("a spectator: archived rows never count toward the cap (101 with one archived is served 100) nor make a token of [] (all archived: no_divisions)", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: CAP + 1 });
    const [gone] = await sql<{ id: string }[]>`select id from divisions where competition_id = ${c.compId} and status = 'setup' limit 1`;
    await archive(gone!.id);
    const data = await served(await door(c.compId));
    expect(data.divisionIds).toHaveLength(CAP);
    expect(data.divisionIds).not.toContain(gone!.id);
    const one = await seed({ realtime: true, visibility: "public", divisions: 1 });
    await sql`update divisions set archived_at = now() where competition_id = ${one.compId}`;
    await refused(await door(one.compId), 403, "no_divisions");
  });

  it("an official: an archived division is absent, and archived rows neither trip too_many_divisions nor hide no_divisions", async () => {
    const c = await seed({ realtime: false, visibility: "private", divisions: CAP + 1 });
    who.userId = await member(c.orgId, "owner");
    await refused(await door(c.compId), 403, "too_many_divisions");
    const [gone] = await sql<{ id: string }[]>`select id from divisions where competition_id = ${c.compId} and status = 'setup' limit 1`;
    await archive(gone!.id);
    const data = await served(await door(c.compId));
    expect(data.divisionIds, "100 live divisions: served, not 403'd for the archived row").toHaveLength(CAP);
    expect(data.divisionIds).not.toContain(gone!.id);
    expect((await claimsOf(data.token)).division_ids).not.toContain(gone!.id);
    expect([...data.divisionIds].sort()).toEqual(await divisionsOf(c.compId));
    const one = await seed({ realtime: false, visibility: "private", divisions: 1 });
    await sql`update divisions set archived_at = now() where competition_id = ${one.compId}`;
    who.userId = await member(one.orgId, "owner");
    await refused(await door(one.compId), 403, "no_divisions");
  });
});

describe.skipIf(!HAS_DB)("GET /api/v1/public/competitions/{id}/realtime-token — officials (pin 17)", () => {
  it.each(["owner", "admin", "viewer"] as const)("an org %s on a PRIVATE competition: 200 with every division", async (role) => {
    const c = await seed({ realtime: false, visibility: "private", divisions: 3 });
    who.userId = await member(c.orgId, role);
    const data = await served(await door(c.compId));
    expect([...data.divisionIds].sort()).toEqual(await divisionsOf(c.compId));
    expect((await claimsOf(data.token)).division_ids.sort()).toEqual(await divisionsOf(c.compId));
  });

  it("an org member on a public competition whose org is NOT entitled: 200 (officials produce the data)", async () => {
    const c = await seed({ realtime: false, visibility: "public", divisions: 2 });
    who.userId = await member(c.orgId, "viewer");
    expect([...(await served(await door(c.compId))).divisionIds].sort()).toEqual(await divisionsOf(c.compId));
  });

  it("a member of ANOTHER org on a private competition: 404", async () => {
    const c = await seed({ realtime: true, visibility: "private", divisions: 1 });
    const other = await seed({ realtime: true, visibility: "private", divisions: 1 });
    who.userId = await member(other.orgId, "owner");
    await refused(await door(c.compId), 404);
    expect(mints.calls).toEqual([]);
  });

  it("an ACCEPTED official (not a member): 200 with every division, on a non-entitled public and on a private competition", async () => {
    const pub = await seed({ realtime: false, visibility: "public", divisions: 2 });
    who.userId = (await official(pub, "accepted")).userId;
    expect([...(await served(await door(pub.compId))).divisionIds].sort()).toEqual(await divisionsOf(pub.compId));
    const priv = await seed({ realtime: false, visibility: "private", divisions: 2 });
    who.userId = (await official(priv, "accepted")).userId;
    expect([...(await served(await door(priv.compId))).divisionIds].sort()).toEqual(await divisionsOf(priv.compId));
  });

  it.each(["declined", "pending"] as const)("a %s official on a non-entitled public competition: 403, nothing minted", async (response) => {
    const c = await seed({ realtime: false, visibility: "public", divisions: 2 });
    who.userId = (await official(c, response)).userId;
    await refused(await door(c.compId), 403);
    expect(mints.calls).toEqual([]);
  });

  it("a declined official on a PRIVATE competition: 404 (the competition stays hidden)", async () => {
    const c = await seed({ realtime: false, visibility: "private", divisions: 2 });
    who.userId = (await official(c, "declined")).userId;
    await refused(await door(c.compId), 404);
  });

  it("an official withdrawn after a mint (the assignment row gone): the next call is 403", async () => {
    const c = await seed({ realtime: false, visibility: "public", divisions: 2 });
    const o = await official(c, "accepted");
    who.userId = o.userId;
    await served(await door(c.compId));
    await sql`delete from fixture_officials where official_id = ${o.officialId}`;
    await refused(await door(c.compId), 403);
    expect(mints.calls).toHaveLength(1);
  });

  it("an accepted official of ANOTHER competition of the same org: 403 here", async () => {
    const c = await seed({ realtime: false, visibility: "public", divisions: 1 });
    const [{ id: otherComp }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, status)
      values (${c.orgId}, 'Other', ${"other-" + randomUUID().slice(0, 8)}, 'public', 'live') returning id`;
    const [{ id: divId }] = await sql<{ id: string }[]>`
      insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
      values (${c.orgId}, ${otherComp}, 'O', ${"o-" + randomUUID().slice(0, 8)}, 'generic', 'score', 'active', ${sql.json(DIVISION_CONFIG)}, '1.0.0')
      returning id`;
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (org_id, division_id, kind, name, seq) values (${c.orgId}, ${divId}, 'league', 'League', 1) returning id`;
    const [{ id: fixtureId }] = await sql<{ id: string }[]>`
      insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
      values (${c.orgId}, ${divId}, ${stageId}, 1, 1, 1) returning id`;
    who.userId = (await official({ ...c, compId: otherComp, fixtureId }, "accepted")).userId;
    expect((await served(await door(otherComp))).divisionIds, "PREMISE: accepted on the other competition").toEqual([divId]);
    await refused(await door(c.compId), 403);
  });

  it("the caps hold on the official path too: 0 → no_divisions, 101 → too_many_divisions", async () => {
    const empty = await seed({ realtime: false, visibility: "private", divisions: 0 });
    who.userId = await member(empty.orgId, "owner");
    await refused(await door(empty.compId), 403, "no_divisions");
    const big = await seed({ realtime: false, visibility: "private", divisions: CAP + 1 });
    who.userId = await member(big.orgId, "owner");
    await refused(await door(big.compId), 403, "too_many_divisions");
    expect(mints.calls).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("GET /api/v1/public/competitions/{id}/realtime-token — this server cannot serve one", () => {
  const unavailable = async (c: Comp): Promise<void> => {
    await refused(await door(c.compId), 503, "REALTIME_UNAVAILABLE");
  };

  it("no Supabase configured: 503 REALTIME_UNAVAILABLE, nothing minted", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 1 });
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await unavailable(c);
    baseEnv();
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    await unavailable(c);
    expect(mints.calls).toEqual([]);
  });

  it.each([
    ["an http url", "http://divrealtime.supabase.co"],
    ["a url with a query", `${SUPABASE_URL}?x=1`],
    ["a url with userinfo", "https://u:p@divrealtime.supabase.co"],
  ])("a refused url (%s): 503, nothing minted", async (_case, url) => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 1 });
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    await unavailable(c);
    expect(mints.calls).toEqual([]);
  });

  it("an oversize anon key: 503, nothing minted", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 1 });
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "k".repeat(513);
    await unavailable(c);
    expect(mints.calls).toEqual([]);
  });

  it("a failed mint (no signing key): 503, captured ONCE with the mint's error as its cause", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 1 });
    delete process.env.SUPABASE_JWT_SECRET;
    await unavailable(c);
    expect(mints.calls, "the mint was attempted").toHaveLength(1);
    const captured = vi.mocked(Sentry.captureException).mock.calls;
    expect(captured).toHaveLength(1);
    const err = captured[0]![0] as { status?: number; code?: string; cause?: unknown };
    expect(err.status).toBe(503);
    expect(err.code).toBe("REALTIME_UNAVAILABLE");
    expect(err.cause, "the mint's own error rides as the cause").toBeInstanceOf(Error);
  });
});

describe.skipIf(!HAS_DB)("the usecase through an injected port: the project guard runs BEFORE the mint", () => {
  const portWith = (url: string) => {
    const minted: unknown[] = [];
    const port: DivisionRealtimePort = {
      mint: async (...args) => { minted.push(args); return "x.y.z"; },
      config: () => ({ url, apikey: ANON_KEY }),
    };
    return { port, minted };
  };

  it("a project on ANOTHER host than this deployment's: 503, the mint never asked, the refusal logged by its word", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 1 });
    const warn = vi.spyOn(log, "warn");
    const { port, minted } = portWith("https://another-project.supabase.co");
    const err = await competitionRealtimeFor(c.compId, null, new Date(), port).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: "REALTIME_UNAVAILABLE" });
    expect(minted, "no token is minted for a foreign project").toEqual([]);
    expect(warn.mock.calls.some(([obj]) => (obj as { refusal?: string }).refusal === "host_not_project")).toBe(true);
    warn.mockRestore();
  });

  it("this deployment's own project through the same port: served, the mint asked once with the row's ids", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 2 });
    const { port, minted } = portWith(SUPABASE_URL);
    const answer = await competitionRealtimeFor(c.compId.toUpperCase(), null, new Date(), port);
    expect(minted).toHaveLength(1);
    const [competitionId, divisionIds] = minted[0] as [string, string[]];
    expect(competitionId, "the row's own lowercase id, never the URL's spelling").toBe(c.compId);
    expect([...divisionIds].sort()).toEqual(await publicDivisionsOf(c.compId));
    expect(answer.divisionIds).toEqual(divisionIds);
  });
});

describe.skipIf(!HAS_DB)("the hub document stays token-free", () => {
  it("after a mint, the hub document Redis holds for the same competition carries no JWT and no `token` key", async () => {
    const c = await seed({ realtime: true, visibility: "public", divisions: 2 });
    const data = await served(await door(c.compId));
    const hub = await HUB(new Request(`https://test.local/api/v1/public/orgs/${c.orgSlug}/competitions/${c.compSlug}/hub`),
      { params: Promise.resolve({ orgSlug: c.orgSlug, slug: c.compSlug }) });
    expect(hub.status, "PREMISE: the hub was built").toBe(200);
    const cached = fakeLeaseCache.peek(publicHubCacheKey(c.compId));
    expect(cached, "PREMISE: the hub document was cached").toBeDefined();
    const raw = JSON.stringify(cached);
    expect(raw).not.toContain(data.token);
    expect(raw).not.toMatch(/eyJ/);
    let keys = 0;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v !== null && typeof v === "object") {
        for (const [k, inner] of Object.entries(v)) {
          keys++;
          expect(k.toLowerCase(), "no key names a token").not.toContain("token");
          walk(inner);
        }
      }
    };
    walk(cached);
    expect(keys, "anti-vacuity: keys of the cached document were scanned").toBeGreaterThan(10);
    expect(decodeJwt(data.token).division_ids, "PREMISE: a real token was minted beside it").toBeDefined();
  });
});
