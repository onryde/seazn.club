// The public ACCENT COLOUR, after V396 (entitlements v18 W2 T17, owner ruling
// 2026-09-03): its own key, `dashboard.theme`, Pro and above.
//
// `dashboard.branding` used to gate two unrelated things — removing the
// "Powered by seazn.club" badge AND the accent colour on every public surface.
// V395 made badge removal enterprise-only, and took a paying Pro customer's
// brand colour off their public pages with it. This suite is the witness that
// the two are now independent, so the next ruling that moves ONE of them
// cannot silently move the other.
//
// Written against the REAL producers and consumers, never a fixture on both
// ends: `getPublicOrg` / `getPublicCompetition` (which read `loadOrg`'s query
// and the `public_competitions_v` view) and `orgBoardChrome` (the slideshow
// masthead). Those are the three code paths the four red smoke checks drive —
// "pro public page carries the org accent theme", "pro slideshow carries the
// org accent theme", "pro org landing carries the org color" and "competition
// color overrides the org color".
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// unstable_cache is a Next server-runtime API with no incrementalCache outside
// a real request — passthrough under vitest, the same double
// public-site/__tests__/consent.test.ts already uses for the identical reason.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getPublicCompetition, getPublicOrg } from "@/server/public-site/data";
import { orgBoardChrome } from "@/server/slideshow-data";

const HAS_DB = !!process.env.DATABASE_URL;

/** The colour under test. A single literal, so a partial fix is visible. */
const ACCENT = "#0f766e";
const COMPETITION_ACCENT = "#1d4ed8";

interface Scene {
  auth: AuthCtx;
  orgId: string;
  orgSlug: string;
  compId: string;
  compSlug: string;
}

async function seedScene(plan: string): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`theme-${suffix}@test.local`}, 'Theme', true) returning id`;
  const orgSlug = `theme-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, branding)
    values (${"Theme " + suffix}, ${orgSlug}, ${userId},
            ${sql.json({ colors: { primary: ACCENT } })})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  const compSlug = `cup-${suffix}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, branding)
    values (${orgId}, ${"Cup " + suffix}, ${compSlug}, 'public',
            ${sql.json({ colors: { primary: COMPETITION_ACCENT } })})
    returning id`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    orgId,
    orgSlug,
    compId,
    compSlug,
  };
}

/** The primary colour a visitor's page actually receives, or null. */
function accentOf(branding: unknown): string | null {
  const colors = (branding as { colors?: { primary?: string } } | null)?.colors;
  return colors?.primary ?? null;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the public accent colour (V396: dashboard.theme)", () => {
  it("reaches a PRO org's landing page, while the badge stays on", async () => {
    // The exact regression T17 exists to repair: these two facts were one key
    // until V396, so a Pro org lost its palette the day the badge came back.
    // Asserting them TOGETHER is what makes the split falsifiable — either
    // half alone passes with the keys re-welded.
    const scene = await seedScene("pro");
    const page = await getPublicOrg(scene.orgSlug);
    expect(accentOf(page!.org.branding)).toBe(ACCENT);
    expect(page!.org.branded).toBe(false); // badge SHOWN: dashboard.branding
    expect(await hasFeature(scene.orgId, "dashboard.theme")).toBe(true);
    expect(await hasFeature(scene.orgId, "dashboard.branding")).toBe(false);
  });

  it("is withheld from a FREE org's landing page", async () => {
    const scene = await seedScene("community");
    const page = await getPublicOrg(scene.orgSlug);
    expect(accentOf(page!.org.branding)).toBeNull();
    expect(page!.org.branded).toBe(false);
    expect(await hasFeature(scene.orgId, "dashboard.theme")).toBe(false);
  });

  it("reaches an ENTERPRISE org, which also removes the badge", async () => {
    const scene = await seedScene("enterprise");
    const page = await getPublicOrg(scene.orgSlug);
    expect(accentOf(page!.org.branding)).toBe(ACCENT);
    expect(page!.org.branded).toBe(true);
  });

  it("carries a PRO competition's own colour through public_competitions_v", async () => {
    // "competition color overrides the org color": the competition blob is
    // emptied by the VIEW, not by loadOrg, so this is a second gate that has
    // to move with the first. A fix that only touched data.ts leaves this red.
    const scene = await seedScene("pro");
    const page = await getPublicCompetition(scene.orgSlug, scene.compSlug);
    expect(accentOf(page!.competition.branding)).toBe(COMPETITION_ACCENT);
  });

  it("empties a FREE competition's colour in the same view", async () => {
    const scene = await seedScene("community");
    const page = await getPublicCompetition(scene.orgSlug, scene.compSlug);
    expect(accentOf(page!.competition.branding)).toBeNull();
  });

  it("tints a PRO org's slideshow masthead", async () => {
    // "pro slideshow carries the org accent theme" — orgBoardChrome is the
    // third gate, and `themed` is what the board's callers use to decide
    // whether the competition link of the theme chain may apply too.
    const scene = await seedScene("pro");
    const chrome = await orgBoardChrome(scene.auth);
    expect(chrome.themed).toBe(true);
    expect(accentOf(chrome.branding)).toBe(ACCENT);
  });

  it("leaves a FREE org's slideshow on the default violet", async () => {
    const scene = await seedScene("community");
    const chrome = await orgBoardChrome(scene.auth);
    expect(chrome.themed).toBe(false);
    expect(chrome.branding).toBeNull();
  });

  it("is never lifted by an Event Pass — org-level, so there are no pass rows", async () => {
    // The ruling's stated reason for writing no pass rows. A competition-scoped
    // resolve is the call that WOULD pick a pass row up; it must still answer
    // false, and the table must hold no row for either rung, or the key reads
    // as pass-lifted to `pass-scoping-guard.test.ts` and sends it hunting for
    // enforcement sites that cannot exist.
    const scene = await seedScene("community");
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${scene.compId}, ${scene.orgId}, 'event_pass')`;
    await invalidateOrgEntitlements(scene.orgId);
    expect(await hasFeature(scene.orgId, "dashboard.theme", scene.compId)).toBe(false);
    const passRows = await sql<{ plan_key: string }[]>`
      select plan_key from plan_entitlements
      where feature_key = 'dashboard.theme' and plan_key in ('event_pass', 'event_pass_l')`;
    expect(passRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gate SITES, scanned in source.
//
// The suite above drives the three READ paths through real Postgres. The two
// colour PICKERS — settings → organisation, and the competition settings
// "Branding" tab — are async server components whose gate is one `hasFeature`
// argument each, and `apps/web` vitest is environment: "node", so there is no
// cheap way to render the competition page here (the org one is covered by
// app/o/[orgSlug]/settings/__tests__/brand-gate-split.test.tsx, which does
// prerender it).
//
// So this scans the source instead, and it is a real guard rather than
// decoration: re-weld the colour onto the badge key at ANY of these four sites
// and a case below fails. It is deliberately an exact-file list — a regex sweep
// of the whole tree would grow a suppression list the first time a legitimate
// badge read appeared.
describe("the colour gate reads dashboard.theme, and the badge key stays out", () => {
  const WEB_SRC = fileURLToPath(new URL("../..", import.meta.url));

  /** Colour gates: must ask for the theme key, must NOT ask for the badge. */
  const COLOUR_ONLY = [
    "server/slideshow-data.ts",
    "app/o/[orgSlug]/settings/page.tsx",
    "app/o/[orgSlug]/c/[compSlug]/settings/page.tsx",
  ];

  for (const rel of COLOUR_ONLY) {
    it(`${rel} gates the colour on dashboard.theme alone`, () => {
      const src = readFileSync(join(WEB_SRC, rel), "utf8");
      // Anti-vacuity: a path typo would read as a clean pass on an empty
      // string if the read were wrapped, and a truncated file would too.
      expect(src.length).toBeGreaterThan(500);
      expect(src).toContain('"dashboard.theme"');
      expect(src).not.toContain('"dashboard.branding"');
    });
  }

  it("public-site/data.ts keeps dashboard.branding for the BADGE and nothing else", () => {
    // The one file that legitimately reads both keys: `branded` is the badge
    // flag a visitor's footer keys off, the branding blob is the colour.
    const src = readFileSync(join(WEB_SRC, "server/public-site/data.ts"), "utf8");
    expect(src.length).toBeGreaterThan(500);
    const branding = src.match(/org_has_feature\(o\.id, 'dashboard\.branding'\)/g) ?? [];
    expect(branding).toHaveLength(1);
    expect(src).toContain("org_has_feature(o.id, 'dashboard.branding') as branded");
    expect(src).toContain("org_has_feature(o.id, 'dashboard.theme')");
  });
});
