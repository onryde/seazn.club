import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, type OrgInfo } from "./helpers";
import { sitemapWindowOverride } from "../src/lib/sitemap-window";

// sitemap.xml at request time (fix 2026-09-27).
//
// The route used to be prerendered at `next build`, which has no database, so
// production served a sitemap with no competition in it after every deploy.
// It is now dynamic, and its competition read is cached for
// SITEMAP_REVALIDATE_SECONDS (1h shipped; server/public-site/sitemap-cache.ts).
// This walks the real seam on a production build, as an anonymous crawler:
//
//   0. the route is NOT served from Next's route cache — no `x-nextjs-cache`
//      header — while its prerendered sibling /robots.txt is (the positive
//      pair: without it a missing header could mean "this server never sends
//      one"). A 20s ISR route would pass steps 1-3 below; it fails this one;
//   1. a public, PUBLISHED competition is listed, with its division;
//   2. one created after that read is NOT listed on the very next request —
//      the READ is cached, not re-run per crawler hit;
//   3. it IS listed once the window has passed, and not before.
//
// The window must be short for this to finish, and it is parsed exactly as the
// server parses it (lib/sitemap-window.ts), so the runner and the server under
// test must both be started with it. e2e.yml sets it at job level on the
// e2e-parallel job, which covers both (pinned by e2e-ci-wiring.test.ts).
// Locally, without it, the file skips — the shipped window is an hour. In CI it
// FAILS instead: a skip there would hide the only cache-hit proof there is.

const WINDOW_S = sitemapWindowOverride(process.env.SITEMAP_REVALIDATE_SECONDS);
const POLL_MS = 1_000;
// The cache is stale-while-revalidate: the first request after the window
// serves the old list and refreshes it in the background, so a pick-up can take
// up to one window plus a couple of polls from the moment the list was read.
const pickupBudgetMs = (windowS: number) => (2 * windowS + 10) * 1_000;

const DIVISION_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Published {
  hub: string;
  division: string;
}

/** A public competition with one division, PUBLISHED — a draft is unlisted by
 *  owner decision 2026-09-27, so a listing assertion must not lean on one. */
async function publishedCompetition(request: APIRequestContext, name: string): Promise<Published> {
  const comp = await apiJson<{ id: string; slug: string; org_id: string; visibility: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    { name, visibility: "public", ends_on: "2030-12-31" },
  );
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  // Premise: not quietly degraded to private by a quota — an "absent" read
  // below would then pass for the wrong reason.
  expect(comp.data!.visibility).toBe("public");
  const div = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: DIVISION_CONFIG,
  });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const published = await apiJson<{ status: string }>(request, `/api/v1/competitions/${comp.data!.id}`, "PATCH", {
    status: "published",
  });
  expect(published.data?.status, JSON.stringify(published.error)).toBe("published");

  const { data: orgs } = await apiJson<OrgInfo[]>(request, "/api/orgs");
  const orgSlug = orgs?.find((o) => o.id === comp.data!.org_id)?.slug;
  expect(orgSlug, "the competition's org is one this context belongs to").toBeTruthy();
  // Paths, closed by `</loc>`: the XML carries the server's configured origin,
  // and the hub's own entry must not be satisfied by its division's.
  const hub = `/shared/${orgSlug}/${comp.data!.slug}`;
  return { hub: `${hub}</loc>`, division: `${hub}/${div.data!.slug}</loc>` };
}

test.describe("sitemap.xml", () => {
  test.skip(
    WINDOW_S === undefined && !process.env.CI,
    "needs SITEMAP_REVALIDATE_SECONDS on the server under test AND this runner; the shipped window is an hour",
  );

  test("is not route-cached (robots.txt is); lists a published competition; serves the cached list inside the window; picks up a new one only after it", async ({
    request,
    playwright,
    baseURL,
  }) => {
    expect(
      WINDOW_S,
      "CI must set SITEMAP_REVALIDATE_SECONDS (e2e.yml, job level) — without it this, the only cache-hit proof, would silently skip",
    ).toBeDefined();
    const windowS = WINDOW_S!;
    const budgetMs = pickupBudgetMs(windowS);
    // Budget derived from the window, never a flat literal: two full pick-ups
    // plus the setup calls.
    test.setTimeout(Math.max(90_000, 2 * budgetMs + 60_000));

    const crawler = await playwright.request.newContext({ baseURL });
    try {
      const sitemap = async () => {
        const res = await crawler.get("/sitemap.xml");
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("application/xml");
        return { xml: await res.text(), routeCache: res.headers()["x-nextjs-cache"] };
      };

      // 0. Rendered per request, not by the route cache — against a sibling
      //    metadata route that IS served from it, on this same server.
      const robots = await crawler.get("/robots.txt");
      expect(robots.status()).toBe(200);
      expect(
        robots.headers()["x-nextjs-cache"],
        "positive pair: the prerendered /robots.txt reports its route-cache state",
      ).toBeTruthy();
      expect((await sitemap()).routeCache, "/sitemap.xml must not be a prerendered/ISR route").toBeUndefined();

      // 1. Listed, with its division. Polled: another request may have filled
      //    the cache moments before this competition existed.
      const first = await publishedCompetition(request, `Sitemap First ${TAG}`);
      await expect
        .poll(
          async () => {
            const { xml } = await sitemap();
            return xml.includes(first.hub) && xml.includes(first.division);
          },
          { timeout: budgetMs, intervals: [POLL_MS] },
        )
        .toBe(true);
      // The list that shows `first` was read after `first` existed and at most
      // about one poll ago, so it is fresh for (nearly) a whole window from here.
      const seenAt = Date.now();

      // 2. Cached: a competition created now is not on the next request.
      const second = await publishedCompetition(request, `Sitemap Second ${TAG}`);
      const elapsedMs = Date.now() - seenAt;
      expect(
        elapsedMs,
        "premise: still inside the window that listed the first competition, so the next read must be the cached one",
      ).toBeLessThan(windowS * 1_000 - 2 * POLL_MS);
      const cached = await sitemap();
      expect(cached.routeCache).toBeUndefined();
      expect(cached.xml, "the cached list still carries the first competition").toContain(first.hub);
      expect(cached.xml, "a crawler hit inside the window does not re-run the query").not.toContain(second.hub);

      // 3. Picked up once the window has passed — and not before it.
      await expect
        .poll(async () => (await sitemap()).xml.includes(second.division), { timeout: budgetMs, intervals: [POLL_MS] })
        .toBe(true);
      const pickupMs = Date.now() - seenAt;
      expect(pickupMs, `picked up after ${pickupMs}ms; the window is ${windowS}s`).toBeGreaterThanOrEqual(
        windowS * 1_000 - 2 * POLL_MS,
      );
      expect((await sitemap()).xml).toContain(second.hub);
    } finally {
      await crawler.dispose();
    }
  });
});
