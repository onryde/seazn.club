// W5 follow-ups round 2 (R4): the division's tab documents and their ONE public address.
//
// A tab's document lives at `{division}/tab/{tab}` (the rewrite's target, `proxy.ts` `divisionTabRewrite`), but the address a
// spectator is given - and the hub links to - is `{division}?tab={tab}`. A request that names the internal path alone is sent
// there by a permanent redirect; the rewrite's own request, `tab/{tab}?tab={tab}`, is served as it is, and so was servable at
// a second address with nothing saying which is the page. Every document now names its public address as its canonical, so
// the pair is one page to a crawler: Standings and Entrants point at `?tab=`, the bare route at the division itself.
//
// The expected addresses are the redirect's own target (a second producer of the same fact: `divisionTabCanonicalRedirect`),
// and the literal the hub links to, never the metadata's own output. Same harness as `page-robots.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { divisionTabCanonicalRedirect } from "@/proxy";
import { ROUTED_DIVISION_TABS } from "@/lib/division-tabs";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));

import { generateMetadata } from "../page";

const DIVISION = "/live/test-org/test-comp/open";

const divisionData = () => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "en" },
  competition: { id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", description: null, starts_on: null, ends_on: null, branding: {}, visibility: "public", status: "published" },
  division: { id: "d1", competition_id: "c1", name: "Open", slug: "open" },
});

const canonicalOf = async (tab?: string) => {
  getPublicDivision.mockResolvedValue(divisionData());
  const m = await generateMetadata({ params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open", ...(tab === undefined ? {} : { tab }) }) });
  return m.alternates?.canonical;
};

describe("R4 the division page's canonical", () => {
  it("a routed tab's document names the `?tab=` address - the one the redirect sends the internal path to, and the hub links to", async () => {
    let checked = 0;
    for (const tab of ROUTED_DIVISION_TABS) {
      const redirect = divisionTabCanonicalRedirect(new NextRequest(`http://localhost:3000${DIVISION}/tab/${tab}`));
      expect(redirect, `the premise: the internal path of ${tab} redirects`).not.toBeNull();
      const publicAddress = redirect!.pathname + redirect!.search;
      expect(publicAddress, `the premise: ${tab}'s public address`).toBe(`${DIVISION}?tab=${tab}`);
      expect(await canonicalOf(tab), `${tab}: the canonical is the public address`).toBe(publicAddress);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both routed tabs").toBe(2);
  });

  it("the bare route (Schedule) names the division itself; no document ever names the internal `/tab/` path", async () => {
    expect(await canonicalOf(), "the bare route").toBe(DIVISION);
    for (const tab of [undefined, ...ROUTED_DIVISION_TABS]) {
      expect(String(await canonicalOf(tab)), `tab ${tab ?? "(bare)"}`).not.toContain("/tab/");
    }
  });
});
