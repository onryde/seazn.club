// sitemap.xml (app/sitemap.ts) — request-time, with a cached data read.
//
// The defect this file exists for (2026-09-27): the route was PRERENDERED at
// `next build`, and neither the Dockerfile nor CI's build has a database. The
// build-time copy therefore held the static routes and no competition at all,
// and production served that copy after every deploy until the first
// revalidation replaced it. The fix makes the route dynamic (nothing runs at
// build) and caches the competition read instead, so a crawler request costs
// no query inside the window and a DB error is never baked into a file.
//
// Pinned here, each against the thing that decides it rather than a retyped
// literal: the route's `dynamic` export, the read's cache window (the exported
// shipped default, and its env override for e2e/smoke), that sitemap() really
// reads THROUGH the cache, the static fallback on a DB error, and — against a
// real database — that a public published competition and its division are
// listed while an unlisted one is not.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// unstable_cache double: records every construction (key + options) and every
// invocation of the wrapper it returns, never memoises, and round-trips the
// value through JSON the way the real data cache does — a passthrough double
// would let a Map or a Date shape survive here and die in production.
const cache = vi.hoisted(() => ({
  made: [] as { key: string[]; options: { revalidate?: number | false; tags?: string[] } | undefined }[],
  invoked: [] as string[],
}));
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>, key: string[] = [], options?: { revalidate?: number | false }) => {
      cache.made.push({ key, options });
      return async (...args: unknown[]) => {
        cache.invoked.push(key.join("|"));
        const value = await fn(...args);
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      };
    },
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

// The two reads sitemap() makes, wrapped so a test can make one throw. Each
// stays the REAL function unless a test says otherwise.
vi.mock("@/server/public-site/data", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/data")>();
  return { ...real, listPublicSitemapEntries: vi.fn(real.listPublicSitemapEntries) };
});
vi.mock("@/server/public-site/discovery", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/discovery")>();
  return { ...real, listDiscoverySports: vi.fn(real.listDiscoverySports) };
});

import sitemap, * as route from "../sitemap";
import { listPublicSitemapEntries } from "@/server/public-site/data";
import { listDiscoverySports } from "@/server/public-site/discovery";
import {
  SITEMAP_ENTRIES_CACHE_KEY,
  SITEMAP_REVALIDATE_SECONDS,
  sitemapRevalidateSeconds,
} from "@/server/public-site/sitemap-cache";
import { siteOrigin } from "@/lib/site-origin";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";

const HAS_DB = !!process.env.DATABASE_URL;
const BASE = siteOrigin();
const urls = (entries: { url: string }[]) => entries.map((e) => e.url);

beforeEach(() => {
  cache.invoked.length = 0;
});

describe("sitemap.xml: route config", () => {
  it("is dynamic: never prerendered at build, where there is no database", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("the competition read is cached for SITEMAP_REVALIDATE_SECONDS, shipped at about an hour", () => {
    // The shipped default, pinned on the DEFAULT — the env override below is
    // for test servers and must never move this.
    expect(SITEMAP_REVALIDATE_SECONDS).toBe(3600);
    const made = cache.made.filter((m) => m.key.join("|") === SITEMAP_ENTRIES_CACHE_KEY.join("|"));
    expect(made, "exactly one cached read under the sitemap key").toHaveLength(1);
    // No override in this process, so the cache got the shipped constant.
    expect(process.env.SITEMAP_REVALIDATE_SECONDS ?? "").toBe("");
    expect(made[0]!.options?.revalidate).toBe(SITEMAP_REVALIDATE_SECONDS);
  });

  it.each([
    ["5", 5],
    ["60", 60],
    [undefined, 3600],
    ["", 3600],
    ["0", 3600],
    ["-5", 3600],
    ["1.5", 3600],
    ["soon", 3600],
  ] as const)("SITEMAP_REVALIDATE_SECONDS=%j resolves to %i seconds (only a positive integer overrides)", (raw, want) => {
    expect(sitemapRevalidateSeconds(raw)).toBe(want === 3600 ? SITEMAP_REVALIDATE_SECONDS : want);
  });
});

describe("sitemap.xml: reads and fallback", () => {
  it("reads competitions THROUGH the cached read, not the raw query", async () => {
    vi.mocked(listPublicSitemapEntries).mockResolvedValueOnce([
      { orgSlug: "acme-club", compSlug: "summer-cup", divisionSlugs: ["open"], updated: "2026-09-27T00:00:00.000Z" },
    ]);
    vi.mocked(listDiscoverySports).mockResolvedValueOnce([]);
    const out = urls(await sitemap());
    expect(cache.invoked).toContain(SITEMAP_ENTRIES_CACHE_KEY.join("|"));
    expect(out).toContain(`${BASE}/shared/acme-club/summer-cup`);
    expect(out).toContain(`${BASE}/shared/acme-club/summer-cup/open`);
  });

  it("a database error at request time serves the static routes, not a 500", async () => {
    vi.mocked(listPublicSitemapEntries).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    vi.mocked(listDiscoverySports).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const out = urls(await sitemap());
    expect(out).toContain(BASE);
    expect(out).toContain(`${BASE}/pricing`);
    expect(out.filter((u) => u.includes("/shared/") || u.includes("/discover/"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Against a real database: the rows the query really returns reach the XML.

const DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Scene {
  orgSlug: string;
  listed: { slug: string; divisionSlug: string };
  unlisted: { slug: string };
}
let scene: Scene;

async function seed(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`sitemap-${suffix}@test.local`}, 'Sitemap Owner', true)
    returning id`;
  const orgSlug = `sitemap-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${`Sitemap Club ${suffix}`}, ${orgSlug}, ${userId})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  // Two competitions exceed the community active cap.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test')`;
  const auth: AuthCtx = { orgId, via: "session", userId, role: "owner", keyId: null };

  // Created private, then moved to the visibility and status under test with a
  // plain UPDATE: createCompetition can degrade an over-cap public create to
  // private, which would let the "absent" assertion pass for the wrong reason.
  // PUBLISHED, not a draft: a draft is unlisted by owner decision 2026-09-27.
  const make = async (label: string, visibility: "public" | "unlisted") => {
    const row = await createCompetition(auth, {
      name: `Sitemap ${label} ${suffix}`,
      visibility: "private",
      branding: {},
      starts_on: "2030-06-01",
      ends_on: "2030-12-31",
    });
    const division = await createDivision(auth, row.id, {
      name: `${label} open`,
      slug: `${label.toLowerCase()}-open`,
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    await sql`update competitions set visibility = ${visibility}, status = 'published' where id = ${row.id}`;
    return { slug: row.slug, divisionSlug: division.slug };
  };
  const listed = await make("Listed", "public");
  const unlisted = await make("Unlisted", "unlisted");
  return { orgSlug, listed, unlisted };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("sitemap.xml: a seeded database", () => {
  it("lists a public published competition and its division, and not an unlisted one", async () => {
    const [listedRow] = await sql<{ visibility: string; status: string }[]>`
      select c.visibility, c.status from competitions c join organizations o on o.id = c.org_id
       where o.slug = ${scene.orgSlug} and c.slug = ${scene.listed.slug}`;
    expect(listedRow, "premise: the listed competition is public and published").toEqual({
      visibility: "public",
      status: "published",
    });

    const out = urls(await sitemap());
    expect(out).toContain(`${BASE}/shared/${scene.orgSlug}/${scene.listed.slug}`);
    expect(out).toContain(`${BASE}/shared/${scene.orgSlug}/${scene.listed.slug}/${scene.listed.divisionSlug}`);
    expect(out.filter((u) => u.includes(`/shared/${scene.orgSlug}/${scene.unlisted.slug}`))).toEqual([]);
  });
});
