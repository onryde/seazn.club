// Public hub perf T2 — the polled readers' slug lookups are cached in Redis,
// and every write path that can change one drops it.
//
// `publicCompetitionHub` (and `publicPlayerMatches`, `publicOrgLive`) used to
// ask Postgres "is this competition publicly readable under these slugs?" on
// EVERY poll, before Redis was consulted. The answer is now cached
// (`pub:v1:comp-ref:{org}:{comp}`, `pub:v1:org-ref:{org}`), which is only
// safe if a competition that goes private, is renamed or deleted, or whose
// org is renamed, stops being served as soon as that write returns — the
// bound the uncached lookup gave. That is structurally invisible without a
// REAL Redis (with REDIS_URL unset every lookup misses and reads Postgres
// fresh), so this suite needs both. The write paths are the real usecases
// and the real org route; only the hub DOCUMENT is doubled, because the gate
// in front of it is the subject here, not its assembly.
//
// The first test is the positive control the others lean on: a visibility
// flip made BEHIND the app's back (raw SQL, no drop) is still served, so the
// lookup really is cached — without it, every "refused after the write" below
// would pass just as well against a lookup that never cached anything.
//
// Skipped without DATABASE_URL or REDIS_URL. CI runs it in the Redis-gated
// step (ci.yml), which owns REDIS_URL for itself alone.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";

const loadCompetitionHub = vi.hoisted(() => vi.fn());
vi.mock("@/server/public-site/competition-hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/competition-hub")>()),
  loadCompetitionHub,
}));
vi.mock("@/server/usecases/player-stats-refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/player-stats-refresh")>()),
  reconcilePlayerStatsOnRead: vi.fn(),
}));
const fakeUser = vi.hoisted(() => ({
  id: "00000000-0000-4000-8000-00000000f00d",
  display_name: "Ref Cache",
  email: "ref-cache@test.local",
  avatar_url: null,
  timezone: null,
  locale: null,
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireOrgRole: vi.fn(async () => ({ user: fakeUser, role: "owner" as const })),
}));
// The real slug-cache bust, which one test makes throw ONCE: it runs after the
// org rename's commit, beside the lookup drop.
const invalidateSlugCache = vi.hoisted(() => vi.fn());
vi.mock("@/server/slug-resolve", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/slug-resolve")>();
  invalidateSlugCache.mockImplementation(orig.invalidateSlugCache);
  return { ...orig, invalidateSlugCache };
});

import { sql, statementCount } from "@/lib/db";
import { incrWindow } from "@/lib/cache";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, deleteCompetition, patchCompetition } from "@/server/usecases/competitions";
import { publicCompetitionHub, publicOrgLive } from "@/server/usecases/public";
import { publicCompetitionRefKey, publicOrgRefKey } from "@/server/public-site/public-ref-cache";
import { validHubDoc } from "@/server/public-site/__tests__/_hub-doc";
import { PATCH as patchOrg } from "@/app/api/orgs/[id]/route";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_REDIS = !!process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Scene {
  auth: AuthCtx;
  orgSlug: string;
  comp: { id: string; slug: string };
}

async function seed(visibility: "public" | "private" = "public"): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `ref-cache-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ref Cache " + suffix}, ${orgSlug}) returning id`;
  await setOrgPlan(orgId, "pro", "active");
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, {
    name: `Ref Cup ${suffix}`,
    ends_on: "2030-12-31",
    visibility,
    branding: {},
  });
  expect(comp.visibility, "premise: the competition has the visibility asked for").toBe(visibility);
  return { auth, orgSlug, comp: { id: comp.id, slug: comp.slug } };
}

const hub = (orgSlug: string, compSlug: string) => publicCompetitionHub(orgSlug, compSlug);
const refused = { status: 404 };

describe.skipIf(!HAS_DB || !HAS_REDIS)("the polled readers' cached slug lookups (Postgres + real Redis)", () => {
  let probe: Redis;

  beforeAll(async () => {
    probe = new Redis(process.env.REDIS_URL!);
    for (let i = 0; i < 50; i++) {
      if ((await incrWindow(`warmup:${randomUUID()}`, 5)) !== null) return;
      await sleep(100);
    }
    throw new Error("Redis did not become ready");
  });

  beforeEach(() => {
    loadCompetitionHub.mockReset();
    loadCompetitionHub.mockImplementation(async () => validHubDoc());
  });

  afterAll(async () => {
    await probe?.quit().catch(() => {});
    const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
    const dbClient = globalForDb._sql;
    globalForDb._sql = undefined;
    await dbClient?.end();
    const g = globalThis as unknown as { _redis?: { quit?: () => Promise<unknown> } };
    await g._redis?.quit?.().catch(() => {});
  });

  it("control: a warm poll sends NO statement to Postgres, and a flip made behind the app's back is still served", async () => {
    const s = await seed();
    await hub(s.orgSlug, s.comp.slug);
    expect(await probe.get(publicCompetitionRefKey(s.orgSlug, s.comp.slug))).not.toBeNull();

    const before = statementCount();
    await hub(s.orgSlug, s.comp.slug);
    expect(statementCount() - before, "statements sent by a warm poll").toBe(0);

    // Raw SQL: no app write path, so nothing drops the lookup.
    await sql`update competitions set visibility = 'private' where id = ${s.comp.id}`;
    await expect(hub(s.orgSlug, s.comp.slug)).resolves.toBeDefined();
  });

  it("public -> private through patchCompetition: the next poll is refused", async () => {
    const s = await seed();
    await expect(hub(s.orgSlug, s.comp.slug)).resolves.toBeDefined();

    await patchCompetition(s.auth, s.comp.id, { visibility: "private" });

    await expect(hub(s.orgSlug, s.comp.slug)).rejects.toMatchObject(refused);
  });

  it("private -> public through patchCompetition: refused before, served the next poll after", async () => {
    const s = await seed("private");
    await expect(hub(s.orgSlug, s.comp.slug)).rejects.toMatchObject(refused);

    await patchCompetition(s.auth, s.comp.id, { visibility: "public" });

    await expect(hub(s.orgSlug, s.comp.slug)).resolves.toBeDefined();
  });

  it("public -> unlisted keeps it readable (the view admits unlisted), and back to private refuses it", async () => {
    const s = await seed();
    await hub(s.orgSlug, s.comp.slug);

    await patchCompetition(s.auth, s.comp.id, { visibility: "unlisted" });
    await expect(hub(s.orgSlug, s.comp.slug)).resolves.toBeDefined();

    await patchCompetition(s.auth, s.comp.id, { visibility: "private" });
    await expect(hub(s.orgSlug, s.comp.slug)).rejects.toMatchObject(refused);
  });

  it("a slug rename: the OLD slug is refused on the next poll, the new one served", async () => {
    const s = await seed();
    await hub(s.orgSlug, s.comp.slug);
    const renamed = `${s.comp.slug}-renamed`;

    const row = await patchCompetition(s.auth, s.comp.id, { slug: renamed });
    expect(row.slug).toBe(renamed);

    await expect(hub(s.orgSlug, s.comp.slug)).rejects.toMatchObject(refused);
    await expect(hub(s.orgSlug, renamed)).resolves.toBeDefined();
  });

  it("a NAME change that regenerates the slug: the old slug is refused on the next poll", async () => {
    const s = await seed();
    await hub(s.orgSlug, s.comp.slug);

    const row = await patchCompetition(s.auth, s.comp.id, { name: `Brand New Name ${randomUUID().slice(0, 6)}` });
    expect(row.slug, "premise: the rename regenerated the slug").not.toBe(s.comp.slug);

    await expect(hub(s.orgSlug, s.comp.slug)).rejects.toMatchObject(refused);
    await expect(hub(s.orgSlug, row.slug)).resolves.toBeDefined();
  });

  it("deleteCompetition: the next poll is refused", async () => {
    const s = await seed();
    await hub(s.orgSlug, s.comp.slug);

    await deleteCompetition(s.auth, s.comp.id);

    await expect(hub(s.orgSlug, s.comp.slug)).rejects.toMatchObject(refused);
  });

  it("an org rename (PATCH /api/orgs/[id]): the old org slug is refused by the hub AND the org-live poll; the new slug serves both", async () => {
    const s = await seed();
    await hub(s.orgSlug, s.comp.slug);
    await publicOrgLive(s.orgSlug);
    expect(await probe.get(publicOrgRefKey(s.orgSlug)), "premise: the org lookup is cached").not.toBeNull();

    const res = await patchOrg(
      new Request("http://localhost/api/orgs/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Renamed Club ${randomUUID().slice(0, 8)}` }),
      }),
      { params: Promise.resolve({ id: s.auth.orgId }) },
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { slug: string } };
    expect(data.slug, "premise: the rename moved the slug").not.toBe(s.orgSlug);

    await expect(hub(s.orgSlug, s.comp.slug)).rejects.toMatchObject(refused);
    await expect(publicOrgLive(s.orgSlug)).rejects.toMatchObject(refused);
    await expect(hub(data.slug, s.comp.slug)).resolves.toBeDefined();
    await expect(publicOrgLive(data.slug)).resolves.toBeDefined();
  });

  it("an org rename whose later cache busting THROWS still refuses the old slug — the drop runs straight after the commit", async () => {
    const s = await seed();
    await hub(s.orgSlug, s.comp.slug);
    await publicOrgLive(s.orgSlug);
    expect(await probe.get(publicOrgRefKey(s.orgSlug)), "premise: the org lookup is cached").not.toBeNull();
    invalidateSlugCache.mockRejectedValueOnce(new Error("slug cache unreachable"));

    const res = await patchOrg(
      new Request("http://localhost/api/orgs/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Renamed Club ${randomUUID().slice(0, 8)}` }),
      }),
      { params: Promise.resolve({ id: s.auth.orgId }) },
    );
    expect(res.status, "premise: a step after the commit threw").toBe(500);
    expect(invalidateSlugCache).toHaveBeenCalled();
    const [{ slug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${s.auth.orgId}`;
    expect(slug, "premise: the rename committed anyway").not.toBe(s.orgSlug);

    await expect(hub(s.orgSlug, s.comp.slug)).rejects.toMatchObject(refused);
    await expect(publicOrgLive(s.orgSlug)).rejects.toMatchObject(refused);
  });

  it("a patch that changes neither visibility nor slug leaves the competition served", async () => {
    const s = await seed();
    await hub(s.orgSlug, s.comp.slug);

    await patchCompetition(s.auth, s.comp.id, { description: "Now with a description" });

    await expect(hub(s.orgSlug, s.comp.slug)).resolves.toBeDefined();
  });
});
