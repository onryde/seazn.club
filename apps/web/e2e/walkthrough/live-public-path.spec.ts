// LIVE1 (owner ruling 2026-11-03, option A) — the public spectator tree moved from `/shared/…` to `/live/…`.
//
// What a person meets, driven through a PROD server:
//   1. An OLD link — a printed poster's QR code, an email already sent — opens `/shared/<org>/<comp>?tab=matches`
//      and lands on `/live/<org>/<comp>?tab=matches`: one permanent 308, the query kept, the hub rendered. Then a tap
//      inside the hub moves on under `/live`, and NOTHING the page asks for afterwards goes near `/shared` (Next's
//      client-side `?_rsc` navigation included — every link is built by routes.*).
//   2. Every shape the old tree served answers that same 308 to the same path under /live, query kept: hub, division,
//      fixture, match room, posters, kiosk boards, register flow, news, player card, calendar feed.
//   3. The clash option A resolves: a bare `/live` and `/fr/live` are still the MARKETING wall (in their language),
//      while `/live/<org>/<comp>/<div>` is the spectator division page.
//   4. Screens of the hub under /live and of the marketing /live at 320, 768 and 1280, none scrolling sideways, to the
//      test's own output (never committed).
//
// Every expected URL is TYPED here from the ruling — `/shared/<x>` → `/live/<x>` — never built with routes.*, so a
// builder that drifted cannot move the expectation with it. Serial with the seed as test 1 (AGENTS.md #21: a red
// count is a floor).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { expectNoHorizontalScroll, TAG } from "../helpers";
import { closeOpenContexts } from "../spectator-public-helpers";
import {
  activeOrgSlug,
  API_CALL_MS,
  division,
  entrants,
  FLOOR_MS,
  leagueFixtures,
  publicCompetition,
  publishCompetition,
  spectator,
  STEP_MS,
} from "../spectator-w2-kit";

test.describe.configure({ mode: "serial" });
test.afterEach(closeOpenContexts);

const COMP_NAME = `Live Path Cup ${TAG}`;
const DIV_NAME = `Live Path League ${TAG}`;

let org = "";
let comp = "";
let div = "";
let fixture = "";

/** The marketing wall's own h1, read from the dictionary file (e2e cannot import a JSON-backed module). */
function marketingH1(locale: "en" | "fr"): string {
  const file = fileURLToPath(new URL(`../../src/dictionaries/${locale}/marketing.json`, import.meta.url));
  const dict = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const v = dict["live.h1"];
  if (typeof v !== "string" || v.length === 0) throw new Error(`premise: no live.h1 in ${locale}/marketing.json`);
  return v;
}

/** One hop, never followed: the status and Location the server answers `path` with. */
async function firstHop(request: APIRequestContext, path: string): Promise<{ status: number; location: string | null }> {
  const res = await request.fetch(path, { maxRedirects: 0 });
  return { status: res.status(), location: res.headers()["location"] ?? null };
}

/** A Location may come back absolute; compare the path + query only. */
function pathOf(location: string | null): string | null {
  if (location === null) return null;
  const u = new URL(location, "http://placeholder.invalid");
  return `${u.pathname}${u.search}`;
}

test("setup: a public competition with one division and a league fixture, published", async ({ request }) => {
  test.setTimeout(Math.max(FLOOR_MS, 12 * API_CALL_MS + STEP_MS));
  const o = await activeOrgSlug(request);
  org = o.slug;
  const c = await publicCompetition(request, { name: COMP_NAME, orgId: o.id });
  comp = c.slug;
  const d = await division(request, c.id, {
    name: DIV_NAME,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  div = d.slug;
  await entrants(request, d.id, [
    { kind: "individual", name: `Home ${TAG}`, members: [] },
    { kind: "individual", name: `Away ${TAG}`, members: [] },
  ]);
  const [only] = await leagueFixtures(request, d.id);
  fixture = only!.id;
  await publishCompetition(request, c.id);
  expect(org && comp && div && fixture, "premise: every slug and the fixture id were seeded").toBeTruthy();
});

test("an old printed link: /shared/<org>/<comp>?tab=matches lands on /live/… with the query, one 308, and nothing afterwards touches /shared", async ({
  browser,
}) => {
  test.setTimeout(FLOOR_MS);
  const page = await spectator(browser, { width: 390 });
  const asked: string[] = [];
  page.on("request", (r) => asked.push(r.url()));

  const res = await page.goto(`/shared/${org}/${comp}?tab=matches`);
  expect(res, "premise: the navigation answered").not.toBeNull();
  expect(res!.status(), "the landing page itself").toBe(200);
  const landed = new URL(page.url());
  expect(landed.pathname).toBe(`/live/${org}/${comp}`);
  expect(landed.search, "the query survived the redirect").toBe("?tab=matches");
  // The hop the browser took: exactly one, from the old URL, permanent.
  const hop = res!.request().redirectedFrom();
  expect(hop, "premise: the browser was redirected").not.toBeNull();
  expect(new URL(hop!.url()).pathname).toBe(`/shared/${org}/${comp}`);
  expect((await hop!.response())?.status(), "permanent").toBe(308);
  expect(hop!.redirectedFrom(), "one hop, not a chain").toBeNull();
  // And it is the spectator hub, not a 404 or the marketing wall.
  await expect(page.getByRole("heading", { name: COMP_NAME })).toBeVisible();

  // A tap inside the hub: the org breadcrumb, built by routes.publicHub. Client-side navigation stays under /live.
  const before = asked.length;
  const crumb = page.locator(`a[href="/live/${org}"]`).first();
  await expect(crumb, "premise: the hub links its org home under /live").toBeAttached();
  await crumb.click();
  await page.waitForURL((u) => u.pathname === `/live/${org}`);
  const after = asked.slice(before);
  expect(after.length, "anti-vacuity: the tap made requests").toBeGreaterThan(0);
  const toShared = asked.slice(1).filter((u) => new URL(u).pathname.startsWith("/shared"));
  expect(toShared, "nothing after the first hop asks for /shared (links, prefetches, ?_rsc)").toEqual([]);
});

test("every old shape answers a permanent 308 to the same path under /live, query kept — counted", async ({ request }) => {
  test.setTimeout(FLOOR_MS);
  const base = `${org}/${comp}`;
  const shapes: [string, string][] = [
    [`/shared/${org}`, `/live/${org}`],
    [`/shared/${base}`, `/live/${base}`],
    [`/shared/${base}/${div}?tab=standings`, `/live/${base}/${div}?tab=standings`],
    [`/shared/${base}/${div}/fixtures/${fixture}`, `/live/${base}/${div}/fixtures/${fixture}`],
    [`/shared/${base}/${div}/fixtures/${fixture}/play?t=abc.def`, `/live/${base}/${div}/fixtures/${fixture}/play?t=abc.def`],
    [`/shared/${base}/${div}/fixtures/${fixture}/poster.png`, `/live/${base}/${div}/fixtures/${fixture}/poster.png`],
    [`/shared/${base}/poster`, `/live/${base}/poster`],
    [`/shared/${base}/poster.pdf?division=${div}`, `/live/${base}/poster.pdf?division=${div}`],
    [`/shared/${base}/present`, `/live/${base}/present`],
    [`/shared/${base}/${div}/present`, `/live/${base}/${div}/present`],
    [`/shared/${base}/register?join=AB12`, `/live/${base}/register?join=AB12`],
    [`/shared/${base}/register/status?rid=g1&token=t%2Bk`, `/live/${base}/register/status?rid=g1&token=t%2Bk`],
    [`/shared/${base}/register/join?join_code=XY9`, `/live/${base}/register/join?join_code=XY9`],
    [`/shared/${base}/players/p1`, `/live/${base}/players/p1`],
    [`/shared/${base}/${div}/calendar.ics?entrant=e1`, `/live/${base}/${div}/calendar.ics?entrant=e1`],
    [`/shared/${org}/news?page=2`, `/live/${org}/news?page=2`],
    [`/shared/${org}/news/opening-day`, `/live/${org}/news/opening-day`],
    ["/shared", "/live"],
  ];
  let checked = 0;
  for (const [old, expected] of shapes) {
    const hop = await firstHop(request, old);
    expect(hop.status, `${old}: permanent`).toBe(308);
    expect(pathOf(hop.location), old).toBe(expected);
    checked += 1;
  }
  expect(checked, "anti-vacuity: old shapes").toBe(shapes.length);
  // The new tree itself is served, not redirected again.
  const live = await firstHop(request, `/live/${base}/${div}`);
  expect(live.status, "the new division page is served directly").toBe(200);
});

test("the clash, option A: bare /live and /fr/live are the marketing wall; /live/<org>/<comp>/<div> is the spectator page", async ({
  browser,
}) => {
  test.setTimeout(FLOOR_MS);
  const page = await spectator(browser, { width: 1280 });

  const wall = await page.goto("/live");
  expect(wall!.status()).toBe(200);
  expect(new URL(page.url()).pathname, "not redirected anywhere").toBe("/live");
  await expect(page.getByRole("heading", { level: 1, name: marketingH1("en") })).toBeVisible();
  await expect(page.getByRole("heading", { name: COMP_NAME }), "the wall is not a hub page").toHaveCount(0);

  const fr = await page.goto("/fr/live");
  expect(fr!.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByRole("heading", { level: 1, name: marketingH1("fr") })).toBeVisible();

  const spectatorPage = await page.goto(`/live/${org}/${comp}/${div}`);
  expect(spectatorPage!.status()).toBe(200);
  expect(spectatorPage!.request().redirectedFrom(), "served, not redirected").toBeNull();
  await expect(page.getByRole("heading", { name: DIV_NAME })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: marketingH1("en") }), "the spectator page is not the wall").toHaveCount(0);
});

test("screens: the hub under /live and the marketing /live at 320, 768 and 1280 — no sideways scroll", async ({ browser }, testInfo) => {
  test.setTimeout(FLOOR_MS * 2);
  let shots = 0;
  for (const width of [320, 768, 1280]) {
    const page = await spectator(browser, { width });
    await page.goto(`/live/${org}/${comp}`);
    await expect(page.getByRole("heading", { name: COMP_NAME })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`live-hub-${width}.png`), fullPage: false });
    shots += 1;
    await page.goto("/live");
    await expect(page.getByRole("heading", { level: 1, name: marketingH1("en") })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: testInfo.outputPath(`marketing-live-${width}.png`), fullPage: false });
    shots += 1;
  }
  expect(shots, "anti-vacuity: screens").toBe(6);
});
