import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, type OrgInfo } from "./helpers";

// sitemap.xml at request time (fix 2026-09-27).
//
// The route used to be prerendered at `next build`, which has no database, so
// production served a sitemap with no competition in it after every deploy.
// It is now dynamic, and its competition read is cached for
// SITEMAP_REVALIDATE_SECONDS (1h shipped; server/public-site/sitemap-cache.ts).
// This walks the real seam on a production build, as an anonymous crawler:
//
//   1. a public, PUBLISHED competition is listed, with its division;
//   2. one created after that read is NOT listed on the very next request —
//      the read is cached, not re-run per crawler hit;
//   3. it IS listed once the window has passed, and not before.
//
// The window must be short for this to finish, and it is read from the same
// variable the server reads, so the runner and the server under test must both
// be started with it (e2e.yml sets it on the job, which covers both). Without it
// the server holds the shipped hour and step 3 cannot complete, so the file
// skips rather than wait an hour or pass on a guess.

const WINDOW_S = Number(process.env.SITEMAP_REVALIDATE_SECONDS);
const HAS_WINDOW = Number.isInteger(WINDOW_S) && WINDOW_S > 0;
const POLL_MS = 1_000;
// The cache is stale-while-revalidate: the first request after the window
// serves the old list and refreshes it in the background, so a pick-up can take
// up to one window plus a couple of polls from the moment the list was read.
const PICKUP_BUDGET_MS = (2 * WINDOW_S + 10) * 1_000;

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

test.describe("sitemap.xml at request time", () => {
  test.skip(
    !HAS_WINDOW,
    "needs SITEMAP_REVALIDATE_SECONDS on the server under test AND this runner (e2e.yml sets it); the shipped window is an hour",
  );

  test("lists a published public competition, caches the read, and picks up a new one once the window passes", async ({
    request,
    playwright,
    baseURL,
  }) => {
    // Budget derived from the window, never a flat literal: two full pick-ups
    // plus the setup calls.
    test.setTimeout(Math.max(90_000, 2 * PICKUP_BUDGET_MS + 60_000));
    const crawler = await playwright.request.newContext({ baseURL });
    const sitemap = async () => {
      const res = await crawler.get("/sitemap.xml");
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/xml");
      return res.text();
    };

    // 1. Listed, with its division. Polled: another request may have filled
    //    the cache moments before this competition existed.
    const first = await publishedCompetition(request, `Sitemap First ${TAG}`);
    await expect
      .poll(async () => {
        const xml = await sitemap();
        return xml.includes(first.hub) && xml.includes(first.division);
      }, { timeout: PICKUP_BUDGET_MS, intervals: [POLL_MS] })
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
    ).toBeLessThan(WINDOW_S * 1_000 - 2 * POLL_MS);
    const cached = await sitemap();
    expect(cached, "the cached list still carries the first competition").toContain(first.hub);
    expect(cached, "a crawler hit inside the window does not re-run the query").not.toContain(second.hub);

    // 3. Picked up once the window has passed — and not before it.
    await expect
      .poll(async () => (await sitemap()).includes(second.division), { timeout: PICKUP_BUDGET_MS, intervals: [POLL_MS] })
      .toBe(true);
    const pickupMs = Date.now() - seenAt;
    expect(pickupMs, `picked up after ${pickupMs}ms; the window is ${WINDOW_S}s`).toBeGreaterThanOrEqual(
      WINDOW_S * 1_000 - 2 * POLL_MS,
    );
    expect(await sitemap()).toContain(second.hub);

    await crawler.dispose();
  });
});
