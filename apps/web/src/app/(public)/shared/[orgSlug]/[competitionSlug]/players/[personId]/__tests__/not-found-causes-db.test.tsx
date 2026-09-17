// The player card's not-found page must not reveal whether a person exists
// (owner ruling 2026-09-17, finding D2). Three causes refuse a card:
//   * NEVER CONSENTED — the person is rostered but has no public-name consent;
//   * DENIED — the org is not granted player pages;
//   * NON-EXISTENT — no such person.
// Each must end in the page's `notFound()` digest — not a redirect, not an
// error, not a partial card — with no person in its metadata. What a visitor
// then SEES is composed here BY HAND: the card's `layout.tsx` rendered around
// its `not-found.tsx`, and that composition must read the same for all three,
// in the org's language, taking no input from the person. This file does NOT
// prove Next picks that boundary for the digest — that selection is Next's
// runtime, covered only by a browser on a real build (owed to Task 17).
//
// Real Postgres, real `getPublicPlayer`, real `notFound()`: the refusal lives
// in `public_players_v` and `hasFeature`, and a doubled reader would prove the
// double. Skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useParams: () => route.params,
}));

import es from "@/dictionaries/es/public.json";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import PlayerCardPage, { generateMetadata } from "../page";
import PlayerCardLayout from "../layout";
import PlayerNotFound from "../not-found";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Scene {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  /** Consent public_name: TRUE. Shown while player pages are granted. */
  consentedId: string;
  consentedName: string;
  /** Consent public_name: FALSE, rostered in the same entrant. */
  neverConsentedId: string;
  neverConsentedName: string;
}

let scene: Scene;

async function seed(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `card-404-${suffix}`;
  // A Spanish org: the refusal must read in the org's language.
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, default_locale)
    values (${"Card 404 " + suffix}, ${orgSlug}, 'es') returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test')`;

  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Card Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: DIVISION_CONFIG,
  });
  const person = async (fullName: string, publicName: boolean) =>
    (await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, ${fullName}, ${sql.json({ public_name: publicName })}) returning id`)[0]!.id;
  const consentedName = "Sam Carter " + suffix;
  const neverConsentedName = "Olly Brown " + suffix;
  const consentedId = await person(consentedName, true);
  const neverConsentedId = await person(neverConsentedName, false);
  await createEntrants(auth, division.id, [
    {
      kind: "team",
      display_name: "Alpha",
      seed: 1,
      members: [
        { person_id: consentedId, squad_number: 7, default_position_key: null, is_captain: true, roles: [] },
        { person_id: neverConsentedId, squad_number: 8, default_position_key: null, is_captain: false, roles: [] },
      ],
    },
  ]);
  await setPlayerPages(orgId, true);
  return {
    orgId,
    orgSlug,
    compSlug: competition.slug,
    consentedId,
    consentedName,
    neverConsentedId,
    neverConsentedName,
  };
}

async function setPlayerPages(orgId: string, value: boolean): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, 'dashboard.player_profiles', ${value}, 'test')
    on conflict (org_id, feature_key) do update set bool_value = excluded.bool_value`;
  await invalidateOrgEntitlements(orgId);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const paramsFor = (personId: string) => ({ orgSlug: scene.orgSlug, competitionSlug: scene.compSlug, personId });

/** The page if it renders; else, when the page throws `notFound()`, the card's
 *  layout wrapped around its not-found page, composed by hand — the boundary
 *  Next is EXPECTED to select for that digest, not proof that it does. */
async function visit(personId: string) {
  const params = paramsFor(personId);
  const metadata = await generateMetadata({ params: Promise.resolve(params) });
  let page: unknown;
  let digest: string | null = null;
  try {
    page = await PlayerCardPage({ params: Promise.resolve(params) });
  } catch (err) {
    digest = (err as { digest?: string }).digest ?? `not a Next digest: ${String(err)}`;
  }
  route.params = params;
  const shown = digest
    ? await PlayerCardLayout({ params: Promise.resolve(params), children: <PlayerNotFound /> })
    : page;
  const html = renderToStaticMarkup(shown as React.ReactElement);
  return { metadata, digest, html };
}

const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

describe.skipIf(!HAS_DB)("player card — never consented, denied and non-existent read the same", () => {
  it("POSITIVE pair first: a consented person on a granted org gets their card, not the refusal", async () => {
    const { digest, html, metadata } = await visit(scene.consentedId);
    expect(digest).toBeNull();
    expect(html).toContain(scene.consentedName);
    expect(html).not.toContain('data-testid="player-not-found"');
    expect(String(metadata.title)).toContain(scene.consentedName);
  });

  it("each cause ends in the page's notFound(), names nobody in its metadata, and the hand-composed layout + not-found page reads the SAME for all three, in the org's language", async () => {
    const neverConsented = await visit(scene.neverConsentedId);
    const nonExistent = await visit(randomUUID());
    await setPlayerPages(scene.orgId, false);
    let denied: Awaited<ReturnType<typeof visit>>;
    try {
      denied = await visit(scene.consentedId);
    } finally {
      await setPlayerPages(scene.orgId, true);
    }

    const causes = { neverConsented, denied, nonExistent };
    for (const [cause, v] of Object.entries(causes)) {
      expect(v.digest, cause).toBe(NOT_FOUND);
      expect(v.metadata, cause).toEqual({});
      expect(v.html, cause).toContain('data-testid="player-not-found"');
      expect(v.html, cause).toContain(`href="/shared/${scene.orgSlug}"`);
      expect(v.html, cause).not.toContain(scene.consentedName);
      expect(v.html, cause).not.toContain(scene.neverConsentedName);
      expect(v.html, cause).not.toContain(scene.consentedId);
      expect(v.html, cause).not.toContain(scene.neverConsentedId);
    }
    // One page for all three, byte for byte.
    expect(denied.html).toBe(neverConsented.html);
    expect(nonExistent.html).toBe(neverConsented.html);
    // …and it is the Spanish org's copy.
    const text = neverConsented.html.replace(/<[^>]+>/g, "");
    for (const key of ["player.notFound.heading", "player.notFound.body", "player.notFound.cta"] as const) {
      expect(text).toContain((es as Record<string, string>)[key]!);
    }
  });
});
