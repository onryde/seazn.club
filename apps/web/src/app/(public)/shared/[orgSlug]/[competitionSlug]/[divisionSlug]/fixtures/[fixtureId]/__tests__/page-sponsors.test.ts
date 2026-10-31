// R4 S10 — the match page's sponsor board counts a click for THAT match (owner rulings D15 + R8; spec 2026-10-27 §3.7).
//
// The seam, driven for real (TEST-STRATEGY, failure class 1): rows in `sponsors` → the REAL `getPublicFixture` →
// the REAL `hasFeature` and `resolveSponsors` → the REAL `FixturePage` and board → the href read out of the HTML →
// the REAL `/s/[key]` route → the `sponsor_clicks` row read back. Nothing between the table and the row is replaced;
// a fixture on either end would prove the fixture. Only the Next runtime pieces a node test cannot run are stood in
// for: unstable_cache is a passthrough, and `useSearchParams` answers an empty query.
//
// The empty case first (a competition with no active sponsor of its own draws no board), then the positive pair.
// Single-sport on purpose: the board reads no sport. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useSearchParams: () => new URLSearchParams() };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { GET } from "@/app/s/[key]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const GENERIC_DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Seeded { orgId: string; orgSlug: string; compId: string; compSlug: string; divSlug: string; fixtureId: string; otherCompId: string }
const orgs: string[] = [];

async function seed(o: { plan?: "pro" | "community" } = {}): Promise<Seeded> {
  const s = uniq();
  await sql`insert into sports (key, name, module_version, position_catalog) values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = `s10p-org-${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, default_locale) values (${`S10 Org ${s}`}, ${orgSlug}, 'en') returning id`;
  orgs.push(orgId);
  if (o.plan === "pro") await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const compSlug = `s10p-comp-${s}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status) values (${orgId}, ${`S10 Comp ${s}`}, ${compSlug}, 'public', 'live') returning id`;
  const [{ id: otherCompId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status) values (${orgId}, ${`S10 Other ${s}`}, ${`s10p-other-${s}`}, 'public', 'live') returning id`;
  const divSlug = `open-${s}`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', 'active', ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq) values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round) values (${orgId}, ${divisionId}, ${stageId}, 1, 1, 1) returning id`;
  return { orgId, orgSlug, compId, compSlug, divSlug, fixtureId, otherCompId };
}

async function sponsor(
  s: Seeded,
  name: string,
  o: { tier?: string; status?: string; competitionId?: string | null; url?: string | null } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, url, tier, status)
    values (${s.orgId}, ${o.competitionId === undefined ? s.compId : o.competitionId}, ${name},
            ${o.url === undefined ? `https://${name.toLowerCase().replace(/\W+/g, "-")}.example/` : o.url},
            ${o.tier ?? "partner"}, ${o.status ?? "active"})
    returning id`;
  return row!.id;
}

/** The page the way a visitor's request builds it: the real loader, the real component, the HTML. */
async function pageHtml(s: Seeded): Promise<string> {
  const { default: FixturePage } = await import("../page");
  return renderToStaticMarkup(
    await FixturePage({ params: Promise.resolve({ orgSlug: s.orgSlug, competitionSlug: s.compSlug, divisionSlug: s.divSlug, fixtureId: s.fixtureId }) }),
  );
}
/** Every tracked sponsor href on the page, un-escaped the way a browser reads the attribute. */
const sponsorHrefs = (html: string) => [...html.matchAll(/href="(\/s\/[^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

/** Follows an href through the real route, as the visitor's tap does. */
async function tap(href: string): Promise<Response> {
  const url = new URL(href, "https://seazn.club");
  const key = url.pathname.slice("/s/".length);
  return GET(new Request(url), { params: Promise.resolve({ key }) });
}

const clicksOf = (sponsorId: string) => sql<{ fixture_id: string | null; source: string }[]>`
  select fixture_id, source from sponsor_clicks where sponsor_id = ${sponsorId} order by at, id`;

describe.skipIf(!HAS_DB)("the public match page's sponsor board (R4 S10, through the real loader and route)", () => {
  it("EMPTY CASE FIRST: no active sponsor of this competition — no board; one activated, the board appears", async () => {
    const s = await seed();
    const inactive = await sponsor(s, "Dormant Dairy", { status: "inactive" });
    await sponsor(s, "Elsewhere Electric", { competitionId: s.otherCompId });
    const html = await pageHtml(s);
    expect(html).not.toContain('data-testid="mh-sponsors"');
    expect(html).not.toContain('href="/s/');
    expect(html, "positive control: the page itself rendered").toContain('data-testid="mc-root"');
    // The pair: the same page, once the sponsor is active, does draw the board (so the silence above is a fact).
    await sql`update sponsors set status = 'active' where id = ${inactive}`;
    const after = await pageHtml(s);
    expect(after).toContain('data-testid="mh-sponsors"');
    expect(sponsorHrefs(after)).toEqual([`/s/${inactive}?f=${s.fixtureId}&src=match`]);
    // The other competition's sponsor never reaches this competition's match page.
    expect(after).not.toContain("Elsewhere Electric");
  });

  it("SEAM: every sponsor link on the page is this match's; a tap redirects and records {this fixture, `match`} (count reported)", async () => {
    const s = await seed({ plan: "pro" });
    const title = await sponsor(s, "Northbank Bank", { tier: "title" });
    const gold = await sponsor(s, "Harbour Motors", { tier: "gold" });
    const orgWide = await sponsor(s, "Vale Physio", { tier: "partner", competitionId: null });
    await sponsor(s, "No Link Ltd", { tier: "silver", url: null });

    const html = await pageHtml(s);
    // R8: the title tier is on the match page — at the head of the board, as its sentence.
    expect(html).toContain('data-testid="mh-sponsors-title"');
    expect(html).toContain("Presented by Northbank Bank");
    const hrefs = sponsorHrefs(html);
    const expected = [title, gold, orgWide].map((id) => `/s/${id}?f=${s.fixtureId}&src=match`);
    expect([...hrefs].sort()).toEqual([...expected].sort());

    let tapped = 0;
    for (const href of hrefs) {
      const res = await tap(href);
      expect(res.status, href).toBe(302);
      tapped++;
    }
    expect(tapped, "links tapped").toBe(3);
    // The click write is tail work (real `deferred`, inline outside a request scope): poll for it.
    for (const id of [title, gold, orgWide]) {
      await vi.waitFor(async () => {
        expect(await clicksOf(id), id).toEqual([{ fixture_id: s.fixtureId, source: "match" }]);
      });
    }
  });

  it("a free org's match page: the flat strip, with no title line, still counting for this match", async () => {
    const s = await seed({ plan: "community" });
    const id = await sponsor(s, "Corner Shop", { tier: "partner" });
    const html = await pageHtml(s);
    expect(html).toContain('data-testid="mh-sponsors-flat"');
    expect(html).not.toContain('data-testid="mh-sponsors-title"');
    expect(sponsorHrefs(html)).toEqual([`/s/${id}?f=${s.fixtureId}&src=match`]);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const orgId of orgs) await sql`delete from organizations where id = ${orgId}`;
});
