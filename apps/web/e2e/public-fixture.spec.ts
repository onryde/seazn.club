// R4 sponsors on stream, S10 — clicks on a public match count for THAT match (owner rulings D15 + R8 + R7; spec
// 2026-10-27 §3.7). Run by CI only (e2e.yml, `parallel` project — it joins by the default testMatch; never locally).
//
// Two real-server facts the vitest seams cannot see:
//   1. The match page's sponsor board, TAPPED in a browser at 320 / 768 / 1280 (ruling R17: the widths are looped here,
//      since only the e2e/mobile/ specs run in the width projects): the board renders below the match centre, the page has no
//      horizontal scroll with a 43-character title sponsor, the tap opens the sponsor's own site in a new tab through
//      `/s/…`, and a `sponsor_clicks` row lands with this fixture and `match`.
//   2. A stream short code typed as a viewer types it (`seazn.club/s/<CODE>`, in either case — fix round 1, I2): 302 to
//      the sponsor, and each visit is a `stream` row for the code's fixture. Each visit names its own client IP, so a
//      Redis-backed repeat window (none in e2e today) could not fold them into one.
// The sponsor's site is never reached: no test leaves the box. The expected values are the spec's
// (`?f=<fixture>&src=match`, `stream`), never read off the page under test.
//
// WHY THE TAP ROUTES THE `/s/` HOP, NOT THE SPONSOR'S HOST (fix round 2, CI run 41256296230): Playwright calls a route
// handler "only for the first url if the response is a redirect" (playwright-core types.d.ts, `page.route`), so a
// route on the sponsor's host never fires behind the 302 — the popup went to DNS, which `.example` never answers, and
// died on chrome-error. Probed locally against a redirect stub: same tab or popup, `continue`d or `route.fetch`ed and
// fulfilled, the redirect TARGET is never routed. So the popup's first request — the board's own href — is routed,
// sent to the REAL server unchanged (`route.fetch`, redirects not followed: the server records the click from this
// browser's request), its real answer is asserted exactly, and the popup is handed the sponsor's page in its place.
import { expect, test, type Page } from "@playwright/test";
import { TAG, activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, withDb } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";
import { SPONSOR_SHORT_CODE_ALPHABET, SPONSOR_SHORT_CODE_MAX_LENGTH } from "../src/lib/sponsor-short-code";
import { routes } from "../src/lib/routes";
import publicEn from "../src/dictionaries/en/public.json" with { type: "json" };
import { SEAZN_VIDEO_POLL_FLOOR_MS } from "../src/components/public-site/match-centre/seazn-video-schedule";
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "../src/server/relay/config";
import { finishSeaznMatch, goLive, lockRecordings, forceHlsJs, playsHlsNatively, seedSeaznMatch, signedAddressPattern, STUB_LADDER_HEIGHTS, stubFakePlaybackHost, stubRungWidth } from "./helpers/seazn-video-seed";

const SPONSOR_HOST = "sponsor-s10.example";
/** A realistic long title sponsor (AGENTS.md: a 43-character name is what found the last phone overflow). */
const LONG_TITLE = "Northbank Regional Building Society & Trust";

interface Rig {
  orgId: string;
  fixtureId: string;
  publicPath: string;
  titleId: string;
  goldId: string;
}

/** A public, started division with one fixture, and two competition-scoped sponsors (title + gold) on the shared Pro
 *  org. Other specs' sponsors CAN reach this page — the board also shows the org's org-wide rows — so the test asserts
 *  on its own two sponsors and on every link's tag, never on the exact set. */
async function rig(page: Page): Promise<Rig> {
  const request = page.request;
  const org = await activeOrg(page);
  const suffix = `${TAG}-${Math.random().toString(36).slice(2, 6)}`;
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Sponsor Clicks ${suffix}`,
    visibility: "public",
  });
  expect(comp.status).toBe(201);
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status).toBe(201);
  expect((await addEntrantsViaApi(request, div.data!.id, ["Click One", "Click Two"])).status).toBe(201);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a two-entrant league seats one fixture").toBe(1);
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBeLessThan(300);

  const mk = async (name: string, tier: "title" | "gold") => {
    const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.id}/sponsors`, "POST", {
      name,
      tier,
      url: `https://${SPONSOR_HOST}/${tier}`,
      competition_id: comp.data!.id,
    });
    expect(res.status, JSON.stringify(res.error)).toBe(201);
    return res.data!.id;
  };
  const titleId = await mk(LONG_TITLE, "title");
  const goldId = await mk(`Harbour Motors ${suffix}`, "gold");
  return {
    orgId: org.id,
    fixtureId: fixtureIds[0]!,
    publicPath: routes.publicFixture(org.slug, comp.data!.slug, div.data!.slug, fixtureIds[0]!),
    titleId,
    goldId,
  };
}

const clicksOf = (sponsorId: string) =>
  withDb((sql) => sql<{ fixture_id: string | null; source: string }[]>`
    select fixture_id, source from sponsor_clicks where sponsor_id = ${sponsorId} order by at, id`).then((rows) =>
    rows.map((r) => ({ fixture_id: r.fixture_id, source: r.source })),
  );

for (const width of [320, 768, 1280] as const) {
  test.describe(`the match page sponsor board at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the match page sponsor board counts a click for that match", async ({ page, context }) => {
      const r = await rig(page);

      await page.goto(r.publicPath);
      await dismissCookieBanner(page);
      const board = page.getByTestId("mh-sponsors");
      await expect(board).toBeVisible();
      // Below the match centre (the perimeter of the ground), never above the score.
      const centreBox = await page.getByTestId("mc-root").boundingBox();
      const boardBox = await board.boundingBox();
      expect(centreBox && boardBox && boardBox.y >= centreBox.y + centreBox.height - 1, "the board sits below the match centre").toBe(true);
      // R8: the title sponsor leads the board — the long name WRAPS, so the page never scrolls sideways.
      await expect(page.getByTestId("mh-sponsors-title")).toContainText(LONG_TITLE);
      await expectNoHorizontalScroll(page);

      // Every tracked link on the board is this match's (spec §3.7): `?f=<this fixture>&src=match` — whoever else the
      // shared org sponsors org-wide — and both of this competition's sponsors are among them.
      const hrefs = await board.locator('a[href^="/s/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
      const tagged = new RegExp(`^/s/[0-9a-f-]{36}\\?f=${r.fixtureId}&src=match$`);
      for (const href of hrefs) expect(href, "every board link is this match's").toMatch(tagged);
      for (const id of [r.titleId, r.goldId]) expect(hrefs, id).toContain(`/s/${id}?f=${r.fixtureId}&src=match`);
      expect(hrefs.length, "links checked").toBeGreaterThanOrEqual(2);

      // The tap a spectator makes: the gold panel opens a new tab through the tracked redirect. Its `/s/` hop goes to the
      // real server (see the header for why it is routed): context-level, so the popup's first request is caught.
      let resolveHop!: (hop: { url: string; status: number; location: string | undefined }) => void;
      let rejectHop!: (err: unknown) => void;
      const hop = new Promise<{ url: string; status: number; location: string | undefined }>((res, rej) => {
        resolveHop = res;
        rejectHop = rej;
      });
      await context.route(
        (url) => url.pathname === `/s/${r.goldId}`,
        async (route) => {
          try {
            const real = await route.fetch({ maxRedirects: 0 });
            resolveHop({ url: route.request().url(), status: real.status(), location: real.headers()["location"] });
            await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Sponsor</title><h1>Sponsor</h1>" });
          } catch (err) {
            rejectHop(err);
          }
        },
      );
      const link = board.locator(`a[href^="/s/${r.goldId}?"]`);
      await link.scrollIntoViewIfNeeded();
      const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
      const tapped = await hop;
      // The new tab asked for the board's own href, and the real server sent it to the sponsor's stored url.
      expect(new URL(tapped.url).pathname + new URL(tapped.url).search).toBe(`/s/${r.goldId}?f=${r.fixtureId}&src=match`);
      expect(tapped.status, "the real /s/ hop redirects").toBe(302);
      expect(tapped.location, "to the sponsor's stored url").toBe(`https://${SPONSOR_HOST}/gold`);
      await expect(popup).toHaveTitle("Sponsor");
      await expect.poll(() => clicksOf(r.goldId), { timeout: 15_000 }).toEqual([{ fixture_id: r.fixtureId, source: "match" }]);
      // Only the tapped sponsor counted.
      expect(await clicksOf(r.titleId)).toEqual([]);
    });
  });
}

test("a stream click counts: the short code a viewer types redirects and records a `stream` click for its match", async ({ page }) => {
  const r = await rig(page);
  // The code S5 mints for (sponsor, fixture), written straight to its table here: minting needs a live overlay poll
  // with a planned break (S15's walkthrough drives that). The mint → card → route seam is pinned in vitest
  // (app/s/__tests__/route.test.ts). Drawn from the declared alphabet at the longest length, so no other run collides.
  // The first character is a LETTER, so the lowercase probe below is a different string from the code.
  const letters = [...SPONSOR_SHORT_CODE_ALPHABET].filter((c) => c !== c.toLowerCase());
  const pick = (from: readonly string[]) => from[Math.floor(Math.random() * from.length)]!;
  const code = [pick(letters), ...Array.from({ length: SPONSOR_SHORT_CODE_MAX_LENGTH - 1 }, () => pick([...SPONSOR_SHORT_CODE_ALPHABET]))].join("");
  await withDb((sql) => sql`
    insert into sponsor_short_codes (code, org_id, sponsor_id, fixture_id) values (${code}, ${r.orgId}, ${r.goldId}, ${r.fixtureId})`);

  // Twice as printed (a query on a code is ignored: the code is the whole tag), then as a phone keyboard types it.
  const visits = [`/s/${code}?src=site`, `/s/${code}`, `/s/${code.toLowerCase()}`];
  for (const [i, path] of visits.entries()) {
    const res = await page.request.get(path, { maxRedirects: 0, headers: { "fly-client-ip": `198.51.100.${10 + i}` } });
    expect(res.status(), path).toBe(302);
    expect(res.headers()["location"], path).toBe(`https://${SPONSOR_HOST}/gold`);
  }
  await expect
    .poll(() => clicksOf(r.goldId), { timeout: 15_000 })
    .toEqual(visits.map(() => ({ fixture_id: r.fixtureId, source: "stream" })));
});

// ===========================================================================
// Seazn-hosted video, Phase 1 Task 15: the Seazn player on the match page (spec §5.1; recommendation 2026-11-21)
// ===========================================================================
// What a node test cannot see (AGENTS.md classes 1 and 2): the page mounting the island, the island reading the REAL route, the route
// signing through the REAL fake-driver signer, and a real `<video>` taking the address, at 320 / 768 / 1280. The session behind the
// page is a seeded row (helpers/seazn-video-seed.ts says why, and what the producer's own proof is); everything after it is real. The
// default e2e job runs these: a Seazn SESSION makes the page Seazn whatever SEAZN_HOSTED_LIVE is. A fake-driver run that really does Go
// live (streaming-destinations.spec.ts case 11) needs SEAZN_HOSTED_LIVE=true AND SEAZN_VIDEO_ORIGINS in the server's env.
//
// The island re-reads on its own timer (30 s at the floor), so the waits that depend on it are DERIVED from the constant (AGENTS.md
// class 20) and the one assertion that waits out a re-read carries it explicitly: ONE_RE_READ_MS = the floor + 15 s slack (45 s).
// The fake playback host never resolves, so the browser's requests to it are answered by a stand-in for Cloudflare's manifest
// (`stubFakePlaybackHost`); the ADDRESS asserted is always the server's own.
const SEAZN_SEED_MS = 60_000;
const SEAZN_NAV_MS = 30_000;
const ONE_RE_READ_MS = SEAZN_VIDEO_POLL_FLOOR_MS + 15_000;
const VIDEO_ROUTE = /\/api\/v1\/public\/fixtures\/[^/]+\/video$/;
const seaznPlayer = (page: Page) => page.locator('[data-testid="seazn-player"] video');
/** Task 33f (owner 'Ok', 2026-11-24): the held box's one line names the video that is coming — a live on its way up, or the replay of a
 *  stream that has stopped. The owner's words, literal (never the dictionary the code reads, T33c review m2), so a swapped or reworded
 *  line reds here. */
const LIVE_COMING = "The live video will start here shortly";
const REPLAY_COMING = "The replay will be ready here in a few minutes";
/** The held box's status line(s) in a page's SERVER HTML, read inside the box's own section: the page's flight payload carries the island's
 *  labels, so BOTH lines are somewhere in the document and a bare `toContain` would pass for either. */
const heldLinesIn = (html: string): string[] => {
  const box = /<section data-testid="seazn-video-starting"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  return box === null ? [] : [...box[1]!.matchAll(/<p [^>]*role="status"[^>]*>(.*?)<\/p>/g)].map((m) => m[1]!);
};

// Phase 1 visual re-capture R1 and R2 (a browser fact a node render cannot see, AGENTS.md class 2: the SSR proxies compare class sets, and
// class sets cannot see UA or global CSS): the player's box and the picker's row are on the page from the SERVER render, and the player
// that takes their place moves nothing. Two readings, both made in the browser: the boxes' document-coordinate geometry, and the
// layout-shift entries of the nodes that matter (the island's own box and the Summary panel under it).
interface Box { top: number; height: number }
interface SeaznGeometry {
  summary: Box | null; frame: Box | null; ghostRow: Box | null; tablist: Box | null; player: Box | null; line: string | null;
  /** Task 33c: the live player's delay line, or the held box's invisible row for it (whichever is on the page). */
  delay: Box | null;
  /** Task 33f: whether the held box's line fits its frame (nothing clipped or spilling: the status element does not overflow, and the
   *  text's own box sits inside the frame); null with no line. Either line must, at every width, or the "same box" claim is false. */
  lineFits: boolean | null;
}
const seaznGeometry = (page: Page): Promise<SeaznGeometry> =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round((r.top + window.scrollY) * 10) / 10, height: Math.round(r.height * 10) / 10 };
    };
    return {
      summary: box('[data-testid="mc-tab-panel-summary"]'),
      frame: box('[data-testid="seazn-video-frame"]'),
      ghostRow: box('[data-testid="seazn-video-picker-reserved"]'),
      tablist: box('[data-testid="seazn-video"] [role="tablist"]'),
      player: box('[data-testid="seazn-player"]'),
      line: document.querySelector('[data-testid="seazn-video-starting"] [role="status"]')?.textContent?.trim() ?? null,
      delay: box('[data-testid="seazn-video-delay"], [data-testid="seazn-video-delay-reserved"]'),
      lineFits: (() => {
        const line = document.querySelector('[data-testid="seazn-video-starting"] [role="status"]');
        const frame = document.querySelector('[data-testid="seazn-video-starting"] [data-testid="seazn-video-frame"]');
        if (!line || !frame) return null;
        const range = document.createRange();
        range.selectNodeContents(line);
        const t = range.getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        const inside = t.width > 0 && t.left >= f.left - 0.5 && t.right <= f.right + 0.5 && t.top >= f.top - 0.5 && t.bottom <= f.bottom + 0.5;
        return inside && line.scrollHeight <= line.clientHeight + 1 && line.scrollWidth <= line.clientWidth + 1;
      })(),
    };
  });
/** Layout shifts from navigation start that moved the island's box or the Summary panel (install BEFORE the first goto). */
async function observeSeaznShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const g = window as unknown as { __seaznShift: number };
    g.__seaznShift = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { hadRecentInput: boolean; value: number; sources?: { node?: Node }[] }[]) {
          if (e.hadRecentInput) continue;
          const ours = (e.sources ?? []).some((s) => s.node instanceof Element && s.node.closest('[data-testid^="seazn-"], [data-testid="mc-tab-panel-summary"]') !== null);
          if (ours) g.__seaznShift += e.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* a browser without layout-shift entries: the geometry assertions still stand */
    }
  });
}
const seaznShift = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __seaznShift: number }).__seaznShift);
/** Holds the island's FIRST read of the route for `ms`, so the page can be measured before any answer is in. */
async function delayFirstRead(page: Page, ms: number): Promise<void> {
  let first = true;
  await page.route(VIDEO_ROUTE, async (route) => {
    if (first) {
      first = false;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.continue();
  });
}
const FIRST_READ_DELAY_MS = 4_000;
/** Two boxes sit in the same place (within a pixel, the layout's own rounding); `height: false` compares only where they start. */
const samePlace = (label: string, a: Box | null, b: Box | null, o: { height: boolean } = { height: true }): void => {
  expect(a, `${label}: the first box exists`).not.toBeNull();
  expect(b, `${label}: the second box exists`).not.toBeNull();
  expect(Math.abs(a!.top - b!.top), `${label}: top ${a!.top} vs ${b!.top}`).toBeLessThanOrEqual(1);
  if (o.height) expect(Math.abs(a!.height - b!.height), `${label}: height ${a!.height} vs ${b!.height}`).toBeLessThanOrEqual(1);
};

for (const width of [320, 768, 1280] as const) {
  test.describe(`the Seazn player on the match page at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a live Seazn match: the player holds the signed address, fits the width, and is kept out of PostHog's recordings", async ({ page }) => {
      test.setTimeout(SEAZN_SEED_MS + SEAZN_NAV_MS + ONE_RE_READ_MS);
      const m = await seedSeaznMatch(page, { name: `Seazn Player ${width} ${TAG}`, live: true });
      try {
        const stub = await stubFakePlaybackHost(page);
        await page.goto(m.publicPath);
        await dismissCookieBanner(page);
        const video = seaznPlayer(page);
        await expect(video, "the island read the route and the player is on the page").toBeVisible({ timeout: ONE_RE_READ_MS });
        // The server's own signed address, on the fake host, in the one attribute the player reads it from.
        const address = await video.getAttribute("data-src");
        expect(address, "the address is the fake driver's, for this input").toMatch(signedAddressPattern(m.programmeUid));
        await expect(video).toHaveAttribute("aria-label", publicEn["seaznVideo.live"]);
        await expect(page.getByTestId("seazn-video"), "the live region is named").toHaveAttribute("aria-label", publicEn["seaznVideo.live"]);
        // The viewer must be able to scrub and see no picker beside a live source.
        await expect(video).toHaveAttribute("controls", "");
        await expect(page.locator('[data-testid="seazn-video"] [role="tab"]'), "a live source has no part picker").toHaveCount(0);
        // PostHog's DOM snapshots must never record a signed address: the section, the wrapper and the element all carry the class.
        for (const target of [page.getByTestId("seazn-video"), page.getByTestId("seazn-player"), video]) await expect(target).toHaveClass(/\bph-no-capture\b/);
        // The player's address reached the browser's player: hls.js asks the stand-in for the manifest at once (no media: loading waits for
        // the first play), a browser that plays HLS itself holds the address as the element's own src.
        if (await playsHlsNatively(page)) await expect(video).toHaveAttribute("src", address!);
        else await expect.poll(() => stub.requests, { message: "hls.js asked the signed address for its manifest" }).toContain(address!);
        // Mobile-first: the page never scrolls sideways, and the player sits inside the viewport at its 16:9 stage (200 px floor).
        await expectNoHorizontalScroll(page);
        const box = await page.getByTestId("seazn-player").boundingBox();
        expect(box, "the player has a box").not.toBeNull();
        expect(box!.x, "inside the left edge").toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, "inside the right edge").toBeLessThanOrEqual(width);
        expect(box!.height, "the stage keeps its 200 px floor").toBeGreaterThanOrEqual(200);
        await expect(page.getByTestId("seazn-player-unavailable"), "a healthy address shows no failure note").toHaveCount(0);
      } finally {
        await finishSeaznMatch(m);
      }
    });

    // Re-capture R1: two recordings mount a picker row (44 px + 12 px) with the island's first answer, and the Summary panel moved 56 px.
    // The page holds that row, invisible, from its SERVER render, and the real tablist and player take the held row's and box's place.
    test("R1: a stopped match with two recordings holds the picker's row and the player's box from the server render; the recordings take their place and the Summary does not move", async ({ page }) => {
      test.setTimeout(SEAZN_SEED_MS + SEAZN_NAV_MS + FIRST_READ_DELAY_MS + ONE_RE_READ_MS);
      const m = await seedSeaznMatch(page, { name: `Seazn Held Row ${width} ${TAG}`, live: true });
      try {
        await finishSeaznMatch(m);
        await lockRecordings(m, 2);
        // The server markup itself (no script has run): the held row with a pill per part, in the page's own words, and the starting box.
        const server = await (await page.request.get(m.publicPath)).text();
        expect(server, "the picker's row is in the server markup").toContain('data-testid="seazn-video-picker-reserved"');
        expect(server, "and the box, with its line").toContain('data-testid="seazn-video-starting"');
        expect(heldLinesIn(server), "T33f: stopped, so the box says the replay is coming, and only that").toEqual([REPLAY_COMING]);
        await stubFakePlaybackHost(page);
        await observeSeaznShifts(page);
        await delayFirstRead(page, FIRST_READ_DELAY_MS);
        const firstRead = page.waitForResponse((r) => VIDEO_ROUTE.test(r.url()));
        await page.goto(m.publicPath);
        // BEFORE any answer is in: the row, the box and the Summary below them.
        const held = await seaznGeometry(page);
        expect(held.line, "the line, in the owner's words: the replay is coming (T33f)").toBe(REPLAY_COMING);
        expect(held.lineFits, `T33f: the replay line fits its frame at ${width}`).toBe(true);
        expect(held.ghostRow, "the held row is laid out").not.toBeNull();
        expect(held.ghostRow!.height, "it is a real row: the pills' own height").toBeGreaterThanOrEqual(44);
        expect(held.frame!.height, "the box keeps its 200 px floor").toBeGreaterThanOrEqual(200);
        await firstRead;
        await expect(page.locator('[data-testid="seazn-video"] [role="tablist"]'), "the answer lists the two parts").toBeVisible();
        await expect(page.locator('[data-testid="seazn-video"] [role="tab"]')).toHaveCount(2);
        const after = await seaznGeometry(page);
        samePlace("the real tablist takes the held row's place", held.ghostRow, after.tablist);
        samePlace("the player takes the held box's place", held.frame, after.player);
        samePlace("the Summary panel does not move (it moved 56 px before)", held.summary, after.summary, { height: false });
        expect(after.line, "the line is gone with the box's arrival").toBeNull();
        expect(await seaznShift(page), "no layout shift reached the island's box or the Summary panel").toBe(0);
        await expectNoHorizontalScroll(page);
      } finally {
        await finishSeaznMatch(m);
      }
    });

    // Re-capture R2: a stop whose recording is not locked yet. The box was collapsed by the first empty answer and re-expanded when the
    // recording arrived, so the page moved twice. The page holds the box through the empty answer, and the recording lands in it. The
    // second half waits out one re-read, so it runs at the two ends of the width range (the held box's geometry differs most there).
    if (width !== 768) {
      test("R2: a match stopped a moment ago keeps the player's box, with its line, through the first empty answer, and the recording lands in it with no shift", async ({ page }) => {
        test.setTimeout(SEAZN_SEED_MS + SEAZN_NAV_MS + FIRST_READ_DELAY_MS + 2 * ONE_RE_READ_MS);
        const m = await seedSeaznMatch(page, { name: `Seazn Held Stop ${width} ${TAG}`, live: true });
        try {
          await finishSeaznMatch(m);
          const server = await (await page.request.get(m.publicPath)).text();
          expect(server, "the box and its line are in the server markup").toContain('data-testid="seazn-video-starting"');
          expect(heldLinesIn(server), "T33f: its line says the replay is coming").toEqual([REPLAY_COMING]);
          expect(server, "no recording yet, so no picker row").not.toContain("seazn-video-picker-reserved");
          await stubFakePlaybackHost(page);
          await observeSeaznShifts(page);
          await delayFirstRead(page, FIRST_READ_DELAY_MS);
          const firstRead = page.waitForResponse((r) => VIDEO_ROUTE.test(r.url()));
          await page.goto(m.publicPath);
          const before = await seaznGeometry(page);
          expect(before.line, "before any answer: the line, the replay's (T33f: the stream has stopped)").toBe(REPLAY_COMING);
          expect(before.lineFits, `T33f: the replay line fits its frame at ${width}`).toBe(true);
          expect(before.frame, "and the box").not.toBeNull();
          const answer = (await (await firstRead).json()) as { data: { live: unknown; replay: unknown[] } };
          expect(answer.data, "premise: the first answer has nothing to play").toEqual({ live: null, replay: [] });
          const read = await seaznGeometry(page);
          expect(read.line, "the empty answer does not collapse the box: the line is still there").toBe(REPLAY_COMING);
          samePlace("the box across the first read", before.frame, read.frame);
          samePlace("the Summary across the first read", before.summary, read.summary, { height: false });
          // The tick locks the recording: the next re-read puts it in the same box.
          await lockRecordings(m, 1);
          await expect(seaznPlayer(page), "the next re-read shows the recording").toBeVisible({ timeout: ONE_RE_READ_MS });
          const arrived = await seaznGeometry(page);
          samePlace("the player takes the held box's place", before.frame, arrived.player);
          samePlace("the Summary after the recording arrives", before.summary, arrived.summary, { height: false });
          expect(arrived.line, "the line goes with the box's arrival").toBeNull();
          expect(arrived.tablist, "one recording: no picker").toBeNull();
          expect(await seaznShift(page), "the box never collapsed and re-expanded: no layout shift reached it or the Summary").toBe(0);
          await expectNoHorizontalScroll(page);
        } finally {
          await finishSeaznMatch(m);
        }
      });
    }
  });
}

// Task 42: the rung hls.js STARTS on is the cap hls.js computes for the player's box, not the lowest. Three boxes (a 320 phone at 3x, a
// 768 tablet at 1x, a 1280 laptop at 3x), the master playlist a five-rung ladder with CODECS; the page is a real server's, the host the
// browser's stand-in. The page is FORCED onto hls.js (`forceHlsJs`: the pinned Chromium says "maybe" to HLS and would take the native
// path, where none of this runs, and a case that took it would pass on nothing). The expected rung is hls.js's documented cap rule
// (cap-level-controller.ts getMaxLevelByMediaSize: the first rung whose width OR height reaches max(box w, h) x dpr, else the top)
// applied to the ladder and the box the browser laid out, never the player's code.
for (const [width, deviceScaleFactor] of [[320, 3], [768, 1], [1280, 3]] as const) {
  test.describe(`the Seazn player's start rung at ${width}px, ${deviceScaleFactor}x`, () => {
    test.use({ viewport: { width, height: 900 }, deviceScaleFactor });

    test("the first rung playlist asked for is the rung hls.js caps the box at", async ({ page }) => {
      test.setTimeout(SEAZN_SEED_MS + SEAZN_NAV_MS + ONE_RE_READ_MS + 20_000);
      const m = await seedSeaznMatch(page, { name: `Seazn Start Rung ${width} ${TAG}`, live: true });
      try {
        await forceHlsJs(page);
        const stub = await stubFakePlaybackHost(page, { ladder: STUB_LADDER_HEIGHTS });
        await page.goto(m.publicPath);
        await dismissCookieBanner(page);
        const video = seaznPlayer(page);
        await expect(video).toBeVisible({ timeout: ONE_RE_READ_MS });
        expect(await playsHlsNatively(page), "premise: the page is on the hls.js path (forceHlsJs took)").toBe(false);
        const address = (await video.getAttribute("data-src"))!;
        // The master is read at once; media (and so a rung) only from the first play.
        await expect.poll(() => stub.requests, { message: "hls.js read the master playlist" }).toContain(address);
        const isRung = (u: string) => /\/rung-\d+\.m3u8$/.test(u);
        expect(stub.requests.filter(isRung), "no rung before play").toEqual([]);
        await video.evaluate((el: HTMLVideoElement) => { el.muted = true; void el.play().catch(() => undefined); });
        const rungs = (): number[] => stub.requests.filter(isRung).map((u) => Number(/rung-(\d+)\.m3u8$/.exec(u)![1]));
        await expect.poll(() => rungs().length, { message: "hls.js asked for a rung playlist after play (the hls.js path ran)", timeout: 20_000 }).toBeGreaterThan(0);
        const { w, h, dpr } = await video.evaluate((el: HTMLVideoElement) => ({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio }));
        expect(dpr, "premise: the page runs at the pixel ratio this case sets").toBe(deviceScaleFactor);
        expect(h, "premise: the box is laid out").toBeGreaterThan(0);
        const square = Math.max(w, h) * dpr;
        const expected = STUB_LADDER_HEIGHTS.find((rung) => stubRungWidth(rung) >= square || rung >= square) ?? STUB_LADDER_HEIGHTS[STUB_LADDER_HEIGHTS.length - 1]!;
        expect(rungs()[0], `box ${w}x${h} at ${dpr}x = ${square} device px: the first rung asked for`).toBe(expected);
      } finally {
        await finishSeaznMatch(m);
      }
    });
  });
}

test.describe("the Seazn player over time (1280)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("warming turns live with NO reload, and a refreshed address keeps the same element and does not reload the player", async ({ page }) => {
    // Seed + load, then two re-reads: warming -> live, and the live's refresh (its expiry is made to fall due at the floor below).
    test.setTimeout(SEAZN_SEED_MS + SEAZN_NAV_MS + 2 * ONE_RE_READ_MS);
    const m = await seedSeaznMatch(page, { name: `Seazn Over Time ${TAG}` });
    try {
      const stub = await stubFakePlaybackHost(page);
      // The answer is the REAL route's; only its expiry (so the island's own schedule re-reads at the floor, as a token near its end
      // would) and, from the second live read on, the token segment of its address are changed.
      let liveReads = 0;
      await page.route(VIDEO_ROUTE, async (route) => {
        const real = await route.fetch();
        const body = (await real.json()) as { ok: boolean; data: { live: { src: string; expiresAt: string } | null } };
        if (body.data?.live) {
          liveReads += 1;
          body.data.live.expiresAt = new Date(Date.now() + (SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000 + SEAZN_VIDEO_POLL_FLOOR_MS + 1_000)).toISOString();
          if (liveReads >= 2) body.data.live.src = body.data.live.src.replace(/\/fake\.[^/]+\//, `/refreshed-${liveReads}/`);
        }
        await route.fulfill({ response: real, json: body });
      });
      await observeSeaznShifts(page);
      const server = await (await page.request.get(m.publicPath)).text();
      expect(server, "re-capture R2: the warming session's box and line are in the server markup").toContain('data-testid="seazn-video-starting"');
      expect(heldLinesIn(server), "T33f: warming, so the box says the LIVE video is coming, and only that").toEqual([LIVE_COMING]);
      const firstRead = page.waitForResponse((r) => VIDEO_ROUTE.test(r.url()));
      await page.goto(m.publicPath);
      await dismissCookieBanner(page);
      const first = (await (await firstRead).json()) as { data: { live: unknown } };
      expect(first.data.live, "warming: the route answers no live").toBeNull();
      await expect(page.getByTestId("mc-court-card"), "the page itself rendered").toBeVisible();
      // Re-capture R2: the empty answer does not collapse the box. It stays, with its one quiet line, and draws no PLAYER yet.
      await expect(page.getByTestId("seazn-video-starting"), "the island holds the player's box through the empty answer").toBeVisible();
      await expect(page.getByTestId("seazn-video-starting").getByRole("status"), "with its line: the live video is coming (T33f)").toHaveText(LIVE_COMING);
      await expect(page.getByTestId("seazn-video"), "and draws no player yet").toHaveCount(0);
      const held = await seaznGeometry(page);
      expect(held.lineFits, "T33f: the live line fits its frame").toBe(true);
      expect(held.frame, "the held box is laid out").not.toBeNull();
      expect(held.frame!.height, "at its 200 px floor").toBeGreaterThanOrEqual(200);
      // The page must not reload from here on: a marker on the window survives only the same document.
      await page.evaluate(() => { (window as unknown as { __seaznSameDocument: boolean }).__seaznSameDocument = true; });

      await goLive(m);
      const video = seaznPlayer(page);
      await expect(video, "the next re-read (within one) shows the live player").toHaveAttribute("data-src", signedAddressPattern(m.programmeUid), { timeout: ONE_RE_READ_MS });
      const sameElement = await video.elementHandle();
      expect(sameElement, "the live element").not.toBeNull();
      // Re-capture R2: the live player is in the very box the page held, and the Summary below it did not move.
      const arrived = await seaznGeometry(page);
      samePlace("the live player takes the held box's place", held.frame, arrived.player);
      // Task 33c: the live player carries its delay line under it; the warming box held that row (invisible), so the line lands in it.
      await expect(page.getByTestId("seazn-video-delay"), "the live player's delay line").toBeVisible();
      samePlace("the delay line takes the row the box held for it", held.delay, arrived.delay);
      samePlace("the Summary after the player arrives", held.summary, arrived.summary, { height: false });
      await expect(page.getByTestId("seazn-video-starting"), "the line is gone with the box's arrival").toHaveCount(0);
      expect(await seaznShift(page), "warming to live moved nothing: no layout shift reached the box or the Summary").toBe(0);

      // The refreshed address: a new token for the same session. The element is KEPT (a rebuild would detach it) and the new address is
      // the one handed to the player.
      await expect(video, "the next re-read hands over the refreshed address").toHaveAttribute("data-src", /\/refreshed-2\//, { timeout: ONE_RE_READ_MS });
      expect(await sameElement!.evaluate((el) => el.isConnected), "the same <video> is still the one on the page").toBe(true);
      expect(await video.elementHandle().then((h) => h!.evaluate((el, old) => el === old, sameElement)), "and it is that very node").toBe(true);
      const hlsPath = !(await playsHlsNatively(page));
      if (hlsPath) {
        // A refresh is NOT a load on hls.js: handing it another address would detach the media and leave the element paused, so the
        // controller keeps the one loaded manifest and only swaps the token into later requests. No request names a refreshed token yet.
        expect(stub.requests.filter((u) => /\/refreshed-\d+\//.test(u)), "hls.js was not reloaded under the refreshed address").toEqual([]);
      }
      expect(await page.evaluate(() => (window as unknown as { __seaznSameDocument?: boolean }).__seaznSameDocument), "no reload happened between warming and live").toBe(true);
      if (hlsPath) {
        // The first play starts the media fetch. The manifest was loaded under the FIRST token and the segment is resolved against it,
        // yet it is asked for under the newest one: the token swap is in the request, not in a reload. (The stand-in answers the segment
        // with a playlist, which hls.js will not accept: that failure comes after the request this asserts, and nothing here follows it.)
        await video.evaluate((el: HTMLVideoElement) => {
          el.muted = true;
          void el.play().catch(() => undefined);
        });
        await expect
          .poll(() => stub.requests.some((u) => /\/refreshed-\d+\/manifest\/seg0\.ts$/.test(u)), { message: "the segment went out under the refreshed token", timeout: 15_000 })
          .toBe(true);
        expect(stub.requests.filter((u) => /\/seg0\.ts$/.test(u) && !/\/refreshed-\d+\//.test(u)), "and none under the first token").toEqual([]);
      }
    } finally {
      await finishSeaznMatch(m);
    }
  });

  // The T15 seam on the hls.js path, witnessed in CI: the test above takes whichever path this Chromium has, and the pinned build answers
  // "maybe" to HLS (the native path, where a refresh is a `video.src` re-point and hls.js never runs). Forced onto hls.js here, so the
  // per-request token rewrite is what is proved: one manifest load under the first token, then, after a refresh, a segment asked for
  // under the NEWEST token. (The stand-in answers the segment with a playlist, which hls.js will not accept: that failure comes after the
  // request this asserts, and nothing here follows it.)
  test("on hls.js a refreshed address is not a reload: the manifest is loaded once, and the segment goes out under the refreshed token", async ({ page }) => {
    test.setTimeout(SEAZN_SEED_MS + SEAZN_NAV_MS + 2 * ONE_RE_READ_MS);
    const m = await seedSeaznMatch(page, { name: `Seazn Refresh hls.js ${TAG}`, live: true });
    try {
      await forceHlsJs(page);
      const stub = await stubFakePlaybackHost(page);
      // The REAL route's answer; only its expiry (the island's own schedule re-reads at the floor) and, from the second read on, the token
      // segment of its address are changed.
      let liveReads = 0;
      await page.route(VIDEO_ROUTE, async (route) => {
        const real = await route.fetch();
        const body = (await real.json()) as { ok: boolean; data: { live: { src: string; expiresAt: string } | null } };
        if (body.data?.live) {
          liveReads += 1;
          body.data.live.expiresAt = new Date(Date.now() + (SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000 + SEAZN_VIDEO_POLL_FLOOR_MS + 1_000)).toISOString();
          if (liveReads >= 2) body.data.live.src = body.data.live.src.replace(/\/fake\.[^/]+\//, `/refreshed-${liveReads}/`);
        }
        await route.fulfill({ response: real, json: body });
      });
      await page.goto(m.publicPath);
      await dismissCookieBanner(page);
      const video = seaznPlayer(page);
      await expect(video).toBeVisible({ timeout: ONE_RE_READ_MS });
      expect(await playsHlsNatively(page), "premise: the page is on the hls.js path (forceHlsJs took)").toBe(false);
      const first = (await video.getAttribute("data-src"))!;
      expect(first, "premise: the first address is the unrefreshed one").not.toMatch(/\/refreshed-\d+\//);
      await expect.poll(() => stub.requests, { message: "hls.js loaded the manifest under the first token" }).toContain(first);
      const element = await video.elementHandle();
      await expect(video, "the next re-read hands over the refreshed address").toHaveAttribute("data-src", /\/refreshed-2\//, { timeout: ONE_RE_READ_MS });
      expect(await video.elementHandle().then((h) => h!.evaluate((el, old) => el === old, element)), "the same <video> node").toBe(true);
      // A refresh is NOT a load on hls.js: handing it another address would detach the media; nothing asked for the refreshed manifest.
      expect(stub.requests.filter((u) => /\/refreshed-\d+\//.test(u)), "no request yet names the refreshed token").toEqual([]);
      expect(stub.requests.filter((u) => /\/manifest\/video\.m3u8$/.test(u)).every((u) => u === first), "the manifest was only ever asked for under the first token").toBe(true);
      await video.evaluate((el: HTMLVideoElement) => { el.muted = true; void el.play().catch(() => undefined); });
      await expect
        .poll(() => stub.requests.some((u) => /\/refreshed-\d+\/manifest\/seg0\.ts$/.test(u)), { message: "the segment went out under the refreshed token", timeout: 15_000 })
        .toBe(true);
      expect(stub.requests.filter((u) => /\/seg0\.ts$/.test(u) && !/\/refreshed-\d+\//.test(u)), "and none under the first token").toEqual([]);
    } finally {
      await finishSeaznMatch(m);
    }
  });

  test("a player that gave up is rebuilt by the next read: the note shows, then a fresh element takes its place", async ({ page }) => {
    // Seed + load, the failure (hls.js retries a refused manifest once), then one re-read (the island asks at once; it waits out the floor).
    test.setTimeout(SEAZN_SEED_MS + SEAZN_NAV_MS + ONE_RE_READ_MS + 20_000);
    const m = await seedSeaznMatch(page, { name: `Seazn Rebuild ${TAG}`, live: true });
    try {
      const stub = await stubFakePlaybackHost(page, { healthy: false });
      await page.goto(m.publicPath);
      await dismissCookieBanner(page);
      const video = seaznPlayer(page);
      await expect(video).toBeVisible({ timeout: ONE_RE_READ_MS });
      const address = (await video.getAttribute("data-src"))!;
      // A browser that plays HLS itself asks for nothing until play, and hls.js loads its manifest at once: pressing play makes both ask.
      // Not awaited: with nothing to play yet the promise stays pending until the page is done with it.
      await video.evaluate((el: HTMLVideoElement) => { el.muted = true; void el.play().catch(() => undefined); });
      await expect(page.getByTestId("seazn-player-unavailable"), "the address was refused: the player says so").toBeVisible({ timeout: 20_000 });
      expect(stub.requests.length, "the signed address was asked for").toBeGreaterThan(0);
      const dead = await video.elementHandle();
      stub.healthy(true);
      // The route's answer holds the SAME address (its token is still good); the player is rebuilt anyway.
      await expect(page.getByTestId("seazn-player-unavailable"), "the next read rebuilt the player: the note is gone").toHaveCount(0, { timeout: ONE_RE_READ_MS });
      expect(await dead!.evaluate((el) => el.isConnected), "the dead player's element was replaced, not reused").toBe(false);
      await expect(video, "and the fresh element holds the same signed address").toHaveAttribute("data-src", address);
    } finally {
      await finishSeaznMatch(m);
    }
  });
});
