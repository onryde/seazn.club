// Owner decision 2026-09-27: a DRAFT competition is unlisted until published.
//
// A new competition is `status = 'draft'` (V207) with `visibility = 'public'`
// by default (V396), so before this it was listed the moment it existed. Now:
//
//   * reachable by DIRECT LINK — the hub, and registration, keep working;
//   * enumerated on NO listing surface — the org home (page and chip poll),
//     the sitemap, discovery (`public_discovery_v`, V419);
//   * `archived` is UNCHANGED — still listed, as "Finished";
//   * publishing it (draft → published) lists it, and the write path expires
//     the org home's caches so the organiser sees it straight away.
//
// Every surface is asked in BOTH directions (a draft absent, a published one
// present) plus its empty case (an org holding only drafts lists nothing and
// does not error). Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Passthrough, never memoising: every read below must hit the database. The
// revalidateTag spy is what the write-path tests read.
const nextCache = vi.hoisted(() => ({ revalidateTag: vi.fn() }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: nextCache.revalidateTag,
  revalidatePath: vi.fn(),
}));
// No Redis entry may serve a stale answer here, and none may be written. The
// cacheDel spy is what the write-path tests read.
const redis = vi.hoisted(() => ({ cacheDel: vi.fn<(...keys: string[]) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => {}),
  cacheDel: redis.cacheDel,
}));

import enPublic from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import { chipLabelKey } from "@/lib/public-site";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { publicOrgLive, discoveryList } from "@/server/usecases/public";
import { publicRegistrationInfo } from "@/server/usecases/registrations";
import { submitRegistrationGroup } from "@/server/usecases/registration-submit";
import { getDiscoveryDirectory } from "../discovery";
import { getPublicCompetition, getPublicOrg, listPublicSitemapEntries, orgTag } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

type Status = "draft" | "published" | "live" | "completed" | "archived";

interface Comp {
  id: string;
  slug: string;
  name: string;
  divisionId: string;
}

interface Scene {
  suffix: string;
  orgSlug: string;
  orgId: string;
  auth: AuthCtx;
  /** public + DRAFT, discoverable, started, a match IN PLAY — every listing
   *  would have a reason to show it except its status. */
  draft: Comp;
  /** public + published, discoverable, started. */
  published: Comp;
  /** public + ARCHIVED, discoverable, started — stays listed, as "Finished". */
  archived: Comp;
  /** unlisted + published — the existing link-only rule, for contrast. */
  unlisted: Comp;
  /** An org whose ONLY competitions are drafts (one discoverable+started). */
  draftsOnly: { orgSlug: string; auth: AuthCtx; drafts: Comp[] };
}

let scene: Scene;

async function insertOrg(label: string, suffix: string): Promise<{ id: string; slug: string; auth: AuthCtx }> {
  // The discovery quality floor needs an email-verified OWNER.
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`draft-${label}-${suffix}@test.local`}, ${`Owner ${label}`}, true)
    returning id`;
  const slug = `draft-unl-${label}-${suffix}`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${`Draft Unlisted ${label} ${suffix}`}, ${slug}, ${userId})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${id}, ${userId}, 'owner')`;
  // Several competitions exceed the community active cap.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${id}, 'competitions.max_active', null, 'test')`;
  return { id, slug, auth: { orgId: id, via: "session", userId, role: "owner", keyId: null } };
}

/** A competition with one STARTED league division (past setup, so the
 *  discovery floor is met), moved to the visibility and status under test with
 *  plain UPDATEs: `createCompetition` can degrade an over-cap public create to
 *  private, which would let a listing assertion pass for the wrong reason. */
async function competition(
  auth: AuthCtx,
  suffix: string,
  label: string,
  opts: { visibility: "public" | "unlisted"; status: Status; discoverable?: boolean; inPlay?: boolean },
): Promise<Comp> {
  const name = `${label} Cup ${suffix}`;
  const row = await createCompetition(auth, {
    name,
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
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C"].map((n, i) => ({ kind: "team" as const, display_name: `${label} ${n}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  if (opts.inPlay) await sql`update fixtures set status = 'in_play' where id = ${fixtures[0]!.id}`;
  await sql`
    update competitions
       set visibility = ${opts.visibility}, status = ${opts.status},
           discoverable = ${opts.discoverable ?? false}
     where id = ${row.id}`;
  return { id: row.id, slug: row.slug, name, divisionId: division.id };
}

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

  const org = await insertOrg("main", suffix);
  const draft = await competition(org.auth, suffix, "Draft", {
    visibility: "public",
    status: "draft",
    discoverable: true,
    inPlay: true,
  });
  const published = await competition(org.auth, suffix, "Published", {
    visibility: "public",
    status: "published",
    discoverable: true,
  });
  const archived = await competition(org.auth, suffix, "Archived", {
    visibility: "public",
    status: "archived",
    discoverable: true,
  });
  const unlisted = await competition(org.auth, suffix, "Unlisted", { visibility: "unlisted", status: "published" });

  const only = await insertOrg("only", suffix);
  const drafts = [
    await competition(only.auth, suffix, "OnlyA", { visibility: "public", status: "draft", discoverable: true }),
    await competition(only.auth, suffix, "OnlyB", { visibility: "public", status: "draft", inPlay: true }),
  ];

  return {
    suffix,
    orgSlug: org.slug,
    orgId: org.id,
    auth: org.auth,
    draft,
    published,
    archived,
    unlisted,
    draftsOnly: { orgSlug: only.slug, auth: only.auth, drafts },
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 180_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** Premise for every "absent" assertion: the row is exactly the draft this
 *  file is about — public, draft, discoverable — so its absence is about its
 *  STATUS and nothing else. */
async function premiseDraft(c: Comp) {
  const [row] = await sql<{ visibility: string; status: string }[]>`
    select visibility, status from competitions where id = ${c.id}`;
  expect(row, "premise: the draft exists").toBeDefined();
  expect(row).toEqual({ visibility: "public", status: "draft" });
}

describe.skipIf(!HAS_DB)("org home (getPublicOrg + the chip poll) — a draft is not listed", () => {
  it("EMPTY first: an org holding ONLY drafts lists nothing — an empty list, not a 404 and not an error — on the page and in the poll", async () => {
    for (const d of scene.draftsOnly.drafts) await premiseDraft(d);
    const data = await getPublicOrg(scene.draftsOnly.orgSlug);
    expect(data, "the org itself still resolves").not.toBeNull();
    expect(data!.competitions).toEqual([]);
    expect(await publicOrgLive(scene.draftsOnly.orgSlug)).toEqual({ competitions: [] });
  });

  it("lists exactly the PUBLISHED and the ARCHIVED competitions; the public DRAFT (with a match in play) and the unlisted one are absent", async () => {
    await premiseDraft(scene.draft);
    const ids = (await getPublicOrg(scene.orgSlug))!.competitions.map((c) => c.id);
    expect(ids).not.toContain(scene.draft.id);
    expect(ids).not.toContain(scene.unlisted.id);
    // Positive pair: the list is not empty for some other reason.
    expect(ids.sort()).toEqual([scene.published.id, scene.archived.id].sort());
  });

  it("the chip poll names the same competitions as the page — never the draft, even though it has a match in play", async () => {
    const poll = (await publicOrgLive(scene.orgSlug)).competitions.map((c) => c.id);
    const page = (await getPublicOrg(scene.orgSlug))!.competitions.map((c) => c.id);
    expect(poll).not.toContain(scene.draft.id);
    expect(poll).toEqual(page);
  });

  it("an ARCHIVED competition is still listed, and its chip reads \"Finished\" (the help's \"nothing is lost\")", async () => {
    const row = (await getPublicOrg(scene.orgSlug))!.competitions.find((c) => c.id === scene.archived.id);
    expect(row, "archived is listed").toBeDefined();
    expect(row!.status).toBe("archived");
    const key = chipLabelKey(row!.status, row!.in_play);
    expect(key).toBe("chip.finished");
    expect(enPublic[key]).toBe("Finished");
  });
});

describe.skipIf(!HAS_DB)("sitemap (listPublicSitemapEntries) — a draft is not listed", () => {
  const mine = async (orgSlug: string) =>
    (await listPublicSitemapEntries()).filter((e) => e.orgSlug === orgSlug);

  it("EMPTY first: an org holding ONLY drafts contributes no sitemap entry", async () => {
    expect(await mine(scene.draftsOnly.orgSlug)).toEqual([]);
  });

  it("carries the published and the archived competitions (with their divisions), never the draft or the unlisted one", async () => {
    await premiseDraft(scene.draft);
    const slugs = (await mine(scene.orgSlug)).map((e) => e.compSlug).sort();
    expect(slugs).toEqual([scene.published.slug, scene.archived.slug].sort());
    const published = (await mine(scene.orgSlug)).find((e) => e.compSlug === scene.published.slug)!;
    expect(published.divisionSlugs).toEqual(["published-open"]);
  });
});

describe.skipIf(!HAS_DB)("discovery (public_discovery_v, V419) — a draft is not showcased", () => {
  it("EMPTY first: an org whose only discoverable, started competition is a draft is not in the directory at all", async () => {
    await premiseDraft(scene.draftsOnly.drafts[0]!);
    const rows = await getDiscoveryDirectory({ q: `OnlyA Cup ${scene.suffix}` });
    expect(rows).toEqual([]);
  });

  it("the directory lists the discoverable PUBLISHED and ARCHIVED competitions and not the discoverable DRAFT — through the page reader and the API reader", async () => {
    await premiseDraft(scene.draft);
    const [{ discoverable }] = await sql<{ discoverable: boolean }[]>`
      select discoverable from competitions where id = ${scene.draft.id}`;
    expect(discoverable, "premise: the draft opted in to discovery").toBe(true);
    const q = scene.suffix;
    const page = (await getDiscoveryDirectory({ q })).map((r) => r.id).sort();
    const api = (await discoveryList({ q })).items.map((r) => r.id).sort();
    const expected = [scene.published.id, scene.archived.id].sort();
    expect(page).toEqual(expected);
    expect(api).toEqual(expected);
  });
});

describe.skipIf(!HAS_DB)("direct link — a draft is still READABLE (the positive pair of every absence above)", () => {
  it("the hub's shell resolves a draft by its slug, status and all", async () => {
    const data = await getPublicCompetition(scene.orgSlug, scene.draft.slug);
    expect(data?.competition.id).toBe(scene.draft.id);
    expect(data?.competition.status).toBe("draft");
    expect(data?.divisions.map((d) => d.id)).toEqual([scene.draft.divisionId]);
  });

  it("registration on a draft still works: the register panel reads it, and a free entry is accepted", async () => {
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method, approval, allow_free_agents)
      values (${scene.draft.divisionId}, true, 'individual', 0, null, 'offline', 'auto', false)
      on conflict (division_id) do nothing`;
    const info = await publicRegistrationInfo(scene.orgSlug, scene.draft.slug);
    expect(info.divisions.map((d) => d.division_id)).toContain(scene.draft.divisionId);
    const submitted = await submitRegistrationGroup(
      { orgSlug: scene.orgSlug, compSlug: scene.draft.slug },
      {
        contact: { name: "Draft Entrant", email: `draft-entrant-${scene.suffix}@test.local` },
        privacy_consent: true,
        entries: [
          {
            division_id: scene.draft.divisionId,
            entrant_kind: "individual",
            players: [{ full_name: "Draft Entrant" }],
            answers: {},
          },
        ],
      },
    );
    expect(submitted.entries).toHaveLength(1);
    await premiseDraft(scene.draft);
  });
});

describe.skipIf(!HAS_DB)("publishing and un-publishing — the listing follows the status, and the write expires the org home", () => {
  it("draft → published lists it on the org home, the poll and the sitemap; published → draft unlists it again", async () => {
    const { draftsOnly } = scene;
    const flip = draftsOnly.drafts[1]!;
    const { auth } = draftsOnly;
    await premiseDraft(flip);

    await patchCompetition(auth, flip.id, { status: "published" });
    expect((await getPublicOrg(draftsOnly.orgSlug))!.competitions.map((c) => c.id)).toEqual([flip.id]);
    expect((await publicOrgLive(draftsOnly.orgSlug)).competitions.map((c) => c.id)).toEqual([flip.id]);
    expect((await listPublicSitemapEntries()).some((e) => e.compSlug === flip.slug)).toBe(true);

    await patchCompetition(auth, flip.id, { status: "draft" });
    expect((await getPublicOrg(draftsOnly.orgSlug))!.competitions).toEqual([]);
    expect((await listPublicSitemapEntries()).some((e) => e.compSlug === flip.slug)).toBe(false);
  });

  it("crossing the draft line expires the org home's page tag and deletes its poll document; an unrelated edit does neither", async () => {
    const { draftsOnly } = scene;
    const target = draftsOnly.drafts[0]!;
    const { auth } = draftsOnly;
    const pageTag = orgTag(draftsOnly.orgSlug);
    const pollKey = `pub:v1:org-live:${auth.orgId}`;
    const tagged = () => nextCache.revalidateTag.mock.calls.filter(([tag]) => tag === pageTag).length;
    const dropped = () => redis.cacheDel.mock.calls.filter((keys) => keys.includes(pollKey)).length;

    // Negative pair first: an edit that changes nothing the listing reads.
    nextCache.revalidateTag.mockClear();
    redis.cacheDel.mockClear();
    await patchCompetition(auth, target.id, { description: "still a draft" });
    expect(tagged(), "a description edit on a draft does not touch the org home").toBe(0);
    expect(dropped()).toBe(0);

    await patchCompetition(auth, target.id, { status: "published" });
    expect(tagged(), "publishing expires the org home").toBeGreaterThan(0);
    expect(dropped(), "publishing drops the chip poll's document").toBeGreaterThan(0);

    nextCache.revalidateTag.mockClear();
    redis.cacheDel.mockClear();
    await patchCompetition(auth, target.id, { status: "draft" });
    expect(tagged(), "un-publishing expires the org home").toBeGreaterThan(0);
    expect(dropped()).toBeGreaterThan(0);
  });
});
