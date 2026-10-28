import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, createStageAndGenerate } from "./helpers";
import { setRigPlan, signInAs } from "./overlay-kit";
import { YOUTUBE_EMBED_ORIGIN, youtubeWatchUrl } from "../src/lib/youtube";

// Screenshot + layout evidence for YouTube Connect T16 (owner layout "B", 2026-10-28): the public match page shows the match's YouTube
// replay as a click-to-play player INSIDE the match card, directly under the scoreline. It is the evidence the owner reviews and the
// spec CI can dispatch; run locally with --no-deps for capture (the sibling `youtube-panel.shots.spec.ts` precedent):
//   PLAYWRIGHT_BASE=http://localhost:<port> E2E_PROD_TARGET=1 DATABASE_URL=... YOUTUBE_SHOTS_DIR=<dir> \
//     npx playwright test e2e/youtube-parts.shots.spec.ts --project=parallel --no-deps
//
// THE DATA IS SEEDED BY DIRECT INSERT, AND THE EMBED IS STUBBED - both on purpose, and both stated:
//   * `youtube_broadcasts` rows in state `complete` (behind a revoked connection row, which the parts view does not look at) stand in
//     for what the end step writes. The seam under test is rows -> public loader -> page -> browser, and the loader and the page are
//     the real ones; the producer of the rows has its own tests (end-step.test.ts).
//   * The network: `https://i.ytimg.com/vi/**` answers a generated picture and `https://www.youtube-nocookie.com/embed/**`
//     answers a stub page that speaks the same postMessage protocol as the real player (it listens for `{"event":"listening"}`, and
//     the "embedding disabled" variant replies `{"event":"onError","info":150}`). That proves OUR side of the protocol - that the
//     facade makes no request until the tap, that the iframe is the right address, that the page handshakes after load and moves to
//     the fallback on an error. It CANNOT prove that Google's real player sends error 150 in this shape; that is a staging check
//     (the runbook), and the one assumption this spec does not discharge.
//
// What it adds over the unit tests (which cannot see layout, paint, real tap area or a real postMessage):
//   * the player box at 1280, 768 and 320: card-inner width, 16:9 with a 200px floor, nothing painted over it, no sideways page scroll;
//   * ONE part: the player alone, no "Part" word anywhere, no tab rail; the facade makes no request to youtube-nocookie.com until
//     the tap, and the tap mounts the privacy-enhanced iframe with autoplay and hands it focus - at MOUNT, before its document has
//     loaded (a held response proves it), not only once it has;
//   * TWO parts, in the state the end step really leaves (stream_url = Part 1's address): the tab rail above the player (44px tabs,
//     arrow keys), NO second "Replay" pill, a tab shows that part's facade (never autoplay), and the part that was playing stops;
//   * TWO parts and a club's own, different link: the pill renders beside the tabbed player (a named capture, not the default);
//   * the fallback: an error from the player puts the "Open on YouTube" link in place of the player;
//   * NO YouTube logo anywhere in the player (the logo only ever sits inside a link to YouTube content).
test.use({ storageState: { cookies: [], origins: [] } });

const SHOTS = process.env.YOUTUBE_SHOTS_DIR ?? resolve(process.cwd(), "../../.superpowers/sdd/shots/youtube-parts");
const WIDTHS = [1280, 768, 320] as const;
const BANNER_WAIT_MS = 5_000;

// Budget - derived, never a flat literal (AGENTS.md class 20).
const NAV_MS = 20_000;
const ACT_MS = 5_000;
const SEED_MS = 60_000;
const budget = (c: { navs: number; acts: number }): number => Math.max(90_000, SEED_MS + c.navs * NAV_MS + c.acts * ACT_MS);

const asked = new WeakSet<Page>();
/** The cookie prompt mounts over the page at hydration and would sit on top of every picture and hit-test: decline it like a visitor would. */
async function declineCookies(page: Page): Promise<void> {
  const banner = page.getByTestId("cookie-consent");
  if (!asked.has(page)) {
    asked.add(page);
    await banner.waitFor({ state: "visible", timeout: BANNER_WAIT_MS }).catch(() => {});
  }
  if (await banner.isVisible()) {
    await banner.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(banner, "the cookie banner is gone after Reject").toHaveCount(0);
  }
}
async function shot(page: Page, name: string): Promise<void> {
  await declineCookies(page);
  // The site header is sticky: a full-page capture taken after a scrollIntoView paints it across the middle of the page.
  await page.evaluate(() => window.scrollTo(0, 0));
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: "image/png" });
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout probes
// ---------------------------------------------------------------------------------------------------------------------

/** The page does not scroll sideways: with the html/body clip lifted, nothing is wider than the viewport. Names the offenders. */
async function expectNoPageScroll(page: Page, where: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const vw = html.clientWidth;
    const prev = [html.style.overflowX, body.style.overflowX];
    html.style.overflowX = "visible";
    body.style.overflowX = "visible";
    const overflowPx = Math.max(0, html.scrollWidth - vw);
    [html.style.overflowX, body.style.overflowX] = prev;
    const contained = (el: Element) => {
      for (let n = el.parentElement; n && n !== body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      }
      return false;
    };
    const offenders = Array.from(body.querySelectorAll("*"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > vw + 1 && !contained(el);
      })
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}[${(el as HTMLElement).dataset.testid ?? ""}] right=${Math.round(el.getBoundingClientRect().right)}`);
    return { vw, overflowPx, offenders };
  });
  expect(seen.offenders, `${where}: boxes reach past the ${seen.vw}px viewport`).toEqual([]);
  expect(seen.overflowPx, `${where}: ${seen.overflowPx}px of sideways page scroll at ${seen.vw}px`).toBeLessThanOrEqual(1);
}

/** The control's centre is its own (nothing paints over it - hit-tested, not measured) and it is at least 44px tall. */
async function expectTappable(loc: Locator, label: string): Promise<void> {
  await loc.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const probe = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { own: at !== null && (at === el || el.contains(at)), w: r.width, h: r.height };
  });
  expect(probe.own, `${label}: something else is on top of its centre`).toBe(true);
  expect(probe.h, `${label}: ${Math.round(probe.w)}x${Math.round(probe.h)}px`).toBeGreaterThanOrEqual(43.5);
}

/** The player box: as wide as the card's inner width, 16:9 but never under 200px tall (Google's embedded-player minimum), inside the card. */
async function expectPlayerBox(page: Page, where: string): Promise<{ width: number; height: number }> {
  const box = page.getByTestId("replay-box");
  await expect(box, `${where}: the player box is drawn`).toBeVisible();
  const m = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="replay-box"]') as HTMLElement;
    const card = b.closest('[data-testid="mc-court-card"], [data-testid="mc-fallback-replay"]') as HTMLElement | null;
    const r = b.getBoundingClientRect();
    const cs = card ? getComputedStyle(card) : null;
    const cr = card?.getBoundingClientRect();
    // The card's inner width is its width less its own padding. (The court card pads an inner div, not the slab itself.)
    const padded = card?.querySelector(":scope > div.p-5, :scope > div.sm\\:p-6") as HTMLElement | null;
    const inner = padded ? padded.getBoundingClientRect().width - parseFloat(getComputedStyle(padded).paddingLeft) - parseFloat(getComputedStyle(padded).paddingRight)
      : cr && cs ? cr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : null;
    return { w: r.width, h: r.height, inner, inCard: card !== null, vw: document.documentElement.clientWidth };
  });
  expect(m.inCard, `${where}: the player sits inside the match card`).toBe(true);
  expect(m.inner, `${where}: the card's inner width was measured`).not.toBeNull();
  expect(Math.abs(m.w - m.inner!), `${where}: the box is ${m.w}px, the card's inner width ${m.inner}px`).toBeLessThanOrEqual(1);
  expect(m.h, `${where}: never under 200px tall`).toBeGreaterThanOrEqual(199.5);
  const sixteenNine = (m.w * 9) / 16;
  expect(Math.abs(m.h - Math.max(200, sixteenNine)), `${where}: ${m.w}x${m.h} is 16:9 with a 200px floor`).toBeLessThanOrEqual(1.5);
  expect(m.w, `${where}: inside the viewport`).toBeLessThanOrEqual(m.vw);
  return { width: m.w, height: m.h };
}

/** No YouTube artwork anywhere in the player: the mark only ever sits inside a link to YouTube content, and a player is not one. */
async function expectNoLogo(page: Page, where: string): Promise<void> {
  const player = page.getByTestId("replay-embed");
  await expect(player, `${where}: the player section exists`).toHaveCount(1);
  expect(await player.locator("svg[data-youtube-icon]").count(), `${where}: no official icon in the player`).toBe(0);
  const html = await player.innerHTML();
  expect(html, `${where}: no YouTube red in the player`).not.toMatch(/#FF0000|#ff0000|M27\.9727/);
}

// ---------------------------------------------------------------------------------------------------------------------
// Rig: an org, a public competition with one fixture, and completed broadcasts for it
// ---------------------------------------------------------------------------------------------------------------------
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

interface Rig {
  orgId: string;
  fixtureId: string;
  /** The public match page: what a visitor opens. */
  publicPath: string;
  /** A competition-less sentinel for the entrants' names, so a screenshot reads like a match. */
  sides: [string, string];
}

/** The ids YouTube would give: 11 characters of [A-Za-z0-9_-]. Unique per run - the database outlives it. */
const videoId = (): string => `t16${randomUUID().replace(/-/g, "").slice(0, 8)}`;

async function rig(page: Page, parts: number, streamUrl: "first-part" | "club" | null): Promise<Rig & { ids: string[] }> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+ytparts-${tag}@resend.dev`;
  const orgSlug = `ytparts-org-${tag}`;
  const { orgId, userId } = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${ownerEmail}, ${"YT Parts Owner " + tag}, true) returning id`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by) values (${"Riverside Club " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${orgId}`;
    return { orgId, userId };
  });
  await signInAs(page, ownerEmail);
  await setRigPlan(orgId, "pro");
  const label = `Spring Cup ${tag}`;
  const comp = await apiJson<{ id: string; slug: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: label, visibility: "public" });
  if (comp.status >= 300 || !comp.data) throw new Error(`rig: POST competition -> ${comp.status} ${JSON.stringify(comp.error)}`);
  const div = await apiJson<{ id: string; slug: string }>(page.request, `/api/v1/competitions/${comp.data.id}/divisions`, "POST", {
    name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  if (div.status >= 300 || !div.data) throw new Error(`rig: POST division -> ${div.status} ${JSON.stringify(div.error)}`);
  const sides: [string, string] = [`Falcons ${tag}`, `Hawks ${tag}`];
  const ents = await addEntrantsViaApi(page.request, div.data.id, sides);
  if (ents.status >= 300 || ents.ids.length !== 2) throw new Error(`rig: entrants -> ${ents.status}`);
  await createStageAndGenerate(page.request, div.data.id);
  const ids = Array.from({ length: parts }, videoId);
  const fixtureId = await withDb(async (sql) => {
    const [{ id }] = await sql<{ id: string }[]>`select id from fixtures where division_id = ${div.data!.id} order by fixture_no limit 1`;
    // The division is released and the match is over: the state a replay exists in.
    await sql`update divisions set status = 'active' where id = ${div.data!.id}`;
    const stream = streamUrl === "first-part" && ids[0] ? youtubeWatchUrl(ids[0]) : streamUrl === "club" ? "https://www.twitch.tv/riversideclub" : null;
    await sql`update fixtures set status = 'decided', stream_url = ${stream} where id = ${id}`;
    if (parts > 0) {
      // A broadcast needs a connection to name; a revoked one is a row the parts view does not look at.
      const [{ id: connectionId }] = await sql<{ id: string }[]>`
        insert into org_youtube_connections (org_id, granted_scope, consent_by, consent_at, consent_version, status, revoked_at, created_by)
        values (${orgId}, 'https://www.googleapis.com/auth/youtube', ${userId}, now(), 1, 'revoked', now(), ${userId}) returning id`;
      for (const [i, yt] of ids.entries()) {
        await sql`
          insert into youtube_broadcasts (org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, completed_at)
          values (${orgId}, ${connectionId}, ${id}, ${yt}, ${`Part ${i + 1}`}, 'unlisted', 'complete', ${new Date(Date.UTC(2030, 5, 1, 10 + i, 0, 0))})`;
      }
    }
    return id;
  });
  // The organiser's session has done its job; the visitor is anonymous.
  await page.context().clearCookies();
  return { orgId, fixtureId, publicPath: `/shared/${orgSlug}/${comp.data.slug}/${div.data.slug}/fixtures/${fixtureId}`, sides, ids };
}

// ---------------------------------------------------------------------------------------------------------------------
// The network stubs
// ---------------------------------------------------------------------------------------------------------------------
interface Net { thumbRequests: string[]; embedRequests: string[]; /** player documents answered so far */ answered: number; release: () => void }

/** i.ytimg.com answers a generated picture (the ids are not real videos); youtube-nocookie.com answers a stub that speaks the player's
 *  postMessage protocol. `embeddingDisabled` makes it answer the page's `listening` with error 150, as a video whose owner switched
 *  embedding off does. Returns the requests seen, so "no request before the tap" is a count, not a hope. */
async function stubNetwork(page: Page, opts: { embeddingDisabled: boolean; holdEmbed?: boolean }): Promise<Net> {
  const net: Net = { thumbRequests: [], embedRequests: [], answered: 0, release: () => {} };
  // `holdEmbed`: the player's document is not answered until `net.release()`, so its load event provably has not fired.
  const held = new Promise<void>((resolveHeld) => { net.release = resolveHeld; });
  await page.route("https://i.ytimg.com/vi/**", async (route) => {
    const id = /\/vi\/([^/]+)\//.exec(route.request().url())?.[1] ?? "";
    net.thumbRequests.push(id);
    await route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d7a5a"/><stop offset="1" stop-color="#16342a"/></linearGradient></defs><rect width="480" height="360" fill="url(#g)"/><circle cx="240" cy="150" r="46" fill="#ffffff" fill-opacity=".14"/><text x="240" y="300" font-size="26" text-anchor="middle" fill="#ffffff" font-family="sans-serif">match replay ${id}</text></svg>`,
    });
  });
  await page.route(`${YOUTUBE_EMBED_ORIGIN}/embed/**`, async (route) => {
    net.embedRequests.push(route.request().url());
    if (opts.holdEmbed) await held;
    net.answered++;
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><title>stub player</title>
<body style="margin:0;background:#101418;color:#e8edf2;font:14px sans-serif;display:grid;place-items:center;height:100vh"><p>stub player (a real one plays here)</p>
<script>
window.__got = [];
window.addEventListener("message", function (e) {
  window.__got.push({ origin: e.origin, data: String(e.data) });
  var d; try { d = JSON.parse(e.data); } catch (x) { return; }
  if (d && d.event === "listening" && ${opts.embeddingDisabled}) {
    parent.postMessage(JSON.stringify({ event: "onError", info: 150, id: 1, channel: "widget" }), "*");
  }
});
</script>`,
    });
  });
  return net;
}

const embedFrame = (page: Page) => page.frames().find((f) => f.url().startsWith(YOUTUBE_EMBED_ORIGIN));

async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "load" });
  await declineCookies(page);
  await expect(page.getByTestId("replay-embed"), "the replay player is on the page").toBeVisible({ timeout: NAV_MS });
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. One part
// ---------------------------------------------------------------------------------------------------------------------
test("Match page - ONE part is the player alone: facade, no part label, no request until the tap, then the iframe, at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 2, acts: 6 + WIDTHS.length * 4 }));
  const r = await rig(page, 1, "first-part");
  const net = await stubNetwork(page, { embeddingDisabled: false });
  await visit(page, r.publicPath);
  const player = page.getByTestId("replay-embed");

  // The club's stream_url IS Part 1 (what the end step writes): the player carries it and the pill is not a second link to it.
  await expect(page.getByTestId("public-stream-link"), "the same replay is not offered twice").toHaveCount(0);
  await expect(player.getByTestId("replay-facade"), "a facade, not a player").toBeVisible();
  await expect(player.getByRole("tab"), "one part has no tab rail").toHaveCount(0);
  await expect(player.locator("iframe"), "no iframe before the tap").toHaveCount(0);
  expect(await player.innerText(), "one part shows no 'Part' label anywhere").not.toMatch(/\bPart\b/);
  // The facade's only request is its own picture. (Compared as a SET of ids: page.route turns the browser cache off, and the match centre
  // swaps its server-rendered copy for the client one once at hydration, so the same picture can be asked for twice here.)
  await expect.poll(() => [...new Set(net.thumbRequests)], { message: "the thumbnail is the facade's only request" }).toEqual([r.ids[0]]);
  expect(net.embedRequests, "NOTHING is requested from youtube-nocookie.com before the tap").toEqual([]);
  await expect(player.getByTestId("replay-facade")).toContainText("Play on YouTube");
  await expect(player.getByTestId("replay-open")).toHaveAttribute("href", youtubeWatchUrl(r.ids[0]!));
  await expect(player.getByTestId("replay-open")).toHaveAttribute("target", "_blank");
  await expect(player.getByTestId("replay-open")).toHaveAttribute("rel", /noopener/);

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    const where = `one part at ${w}`;
    await expectPlayerBox(page, where);
    await expectNoLogo(page, where);
    await expectTappable(player.getByTestId("replay-facade"), `${where}: the play button`);
    await expectTappable(player.getByTestId("replay-open"), `${where}: Open on YouTube`);
    await expectNoPageScroll(page, where);
    await shot(page, `one-part-facade-${w}`);
  }

  // The tap: the privacy-enhanced iframe mounts, autoplay on, and it takes focus; the card has not moved.
  await page.setViewportSize({ width: 1280, height: 900 });
  const before = await expectPlayerBox(page, "before the tap");
  await player.getByTestId("replay-facade").click();
  const frameEl = player.locator("iframe");
  await expect(frameEl, "the tap mounts the player").toHaveCount(1);
  const src = new URL((await frameEl.getAttribute("src"))!);
  expect(src.origin).toBe(YOUTUBE_EMBED_ORIGIN);
  expect(src.pathname).toBe(`/embed/${r.ids[0]}`);
  expect(src.searchParams.get("autoplay"), "autoplay only because the person just tapped").toBe("1");
  expect(src.searchParams.get("origin"), "the player is told the page's origin").toBe(new URL(page.url()).origin);
  await expect(frameEl).toHaveAttribute("title", "Match replay");
  await expect(player.getByTestId("replay-facade"), "the facade is gone, nothing over the player").toHaveCount(0);
  await expect.poll(async () => (await embedFrame(page)?.evaluate(() => (window as unknown as { __got: unknown[] }).__got.length)) ?? 0, {
    message: "the page said it is listening, after the player loaded",
  }).toBeGreaterThan(0);
  const got = (await embedFrame(page)!.evaluate(() => (window as unknown as { __got: { origin: string; data: string }[] }).__got))!;
  expect(got.some((g) => g.origin === new URL(page.url()).origin && JSON.parse(g.data).event === "listening"), "a `listening` message from our origin").toBe(true);
  expect(await page.evaluate(() => document.activeElement?.tagName), "focus moved to the player, not dropped on the page").toBe("IFRAME");
  const after = await expectPlayerBox(page, "after the tap");
  expect(after, "the player takes exactly the facade's box: the card does not jump").toEqual(before);
  await expectNoLogo(page, "the playing player");
  await shot(page, "one-part-playing-1280");
  expect(net.embedRequests.length, "one tap, one player").toBe(1);
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Two parts
// ---------------------------------------------------------------------------------------------------------------------
test("Match page - TWO parts: Part 1 / Part 2 tabs above the player, a tab shows that part's facade (never autoplay), the playing part stops, at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 2, acts: 10 + WIDTHS.length * 6 }));
  // stream_url = Part 1's address: what the end step writes on the first completion and never rewrites for Part 2.
  const r = await rig(page, 2, "first-part");
  const net = await stubNetwork(page, { embeddingDisabled: false });
  await visit(page, r.publicPath);
  const player = page.getByTestId("replay-embed");
  const tabs = player.getByRole("tab");

  // The stored link is one of the parts, so the page offers no second "Replay" link beside the tabs.
  await expect(page.getByTestId("public-stream-link"), "the stored link is Part 1's: no second pill").toHaveCount(0);
  await expect(tabs).toHaveText(["Part 1", "Part 2"]);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false");
  await expect(player.getByRole("tablist")).toHaveAttribute("aria-label", "Replay parts");
  await expect(player.locator(`img[src$="/vi/${r.ids[0]}/hqdefault.jpg"]`), "Part 1's picture").toHaveCount(1);
  expect([...new Set(net.thumbRequests)], "Part 2's picture is not fetched until its tab is chosen").toEqual([r.ids[0]]);
  expect(net.embedRequests).toEqual([]);

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    const where = `two parts at ${w}`;
    await expectPlayerBox(page, where);
    await expectNoLogo(page, where);
    for (const i of [0, 1]) await expectTappable(tabs.nth(i), `${where}: tab ${i + 1}`);
    await expectTappable(player.getByTestId("replay-facade"), `${where}: the play button`);
    await expectTappable(player.getByTestId("replay-open"), `${where}: Open on YouTube`);
    // The rail sits ABOVE the player, inside the card.
    const rail = await tabs.first().boundingBox();
    const box = await player.getByTestId("replay-box").boundingBox();
    expect(rail!.y + rail!.height, `${where}: tabs above the player`).toBeLessThanOrEqual(box!.y + 1);
    await expectNoPageScroll(page, where);
    await shot(page, `two-parts-facade-${w}`);
  }

  // Play Part 1, then choose Part 2: Part 1 stops, Part 2 is a FACADE (click-to-play), the link follows the part.
  await page.setViewportSize({ width: 1280, height: 900 });
  await player.getByTestId("replay-facade").click();
  await expect(player.locator("iframe")).toHaveCount(1);
  await tabs.nth(1).click();
  await expect(player.locator("iframe"), "the part that was playing stopped").toHaveCount(0);
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(player.getByTestId("replay-facade"), "Part 2 waits for its own tap").toBeVisible();
  await expect(player.locator(`img[src$="/vi/${r.ids[1]}/hqdefault.jpg"]`)).toHaveCount(1);
  await expect(player.getByTestId("replay-open")).toHaveAttribute("href", youtubeWatchUrl(r.ids[1]!));
  expect(net.embedRequests.length, "choosing a tab loaded no second player").toBe(1);
  await shot(page, "two-parts-part2-facade-1280");

  // Keyboard: ArrowLeft goes back to Part 1 and the focus goes with it (roving tabindex).
  await tabs.nth(1).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute("tabindex", "0");
  await expect(tabs.nth(1)).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("End");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

  // Part 2 plays on its own tap and is titled with its number.
  await player.getByTestId("replay-facade").click();
  await expect(player.locator("iframe")).toHaveAttribute("title", "Match replay, part 2");
  expect(new URL((await player.locator("iframe").getAttribute("src"))!).pathname).toBe(`/embed/${r.ids[1]}`);
  await expectNoLogo(page, "part 2 playing");
  await shot(page, "two-parts-part2-playing-1280");
});

// ---------------------------------------------------------------------------------------------------------------------
// 2b. Two parts, and the club's own different link
// ---------------------------------------------------------------------------------------------------------------------
test("Match page - TWO parts and a club's own DIFFERENT link: the pill renders beside the tabbed player (a named capture, not the default), at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 2, acts: 2 + WIDTHS.length * 5 }));
  const r = await rig(page, 2, "club");
  await stubNetwork(page, { embeddingDisabled: false });
  await visit(page, r.publicPath);
  const player = page.getByTestId("replay-embed");
  const pill = page.getByTestId("public-stream-link");

  await expect(pill, "a link that is none of the parts is the club's own and renders").toHaveAttribute("href", "https://www.twitch.tv/riversideclub");
  await expect(pill).toHaveCount(1);
  await expect(player.getByRole("tab")).toHaveText(["Part 1", "Part 2"]);
  // Above the match card, the player inside it.
  const pillBox = await pill.boundingBox();
  const playerBox = await player.boundingBox();
  expect(pillBox!.y + pillBox!.height, "the pill is above the player").toBeLessThanOrEqual(playerBox!.y + 1);

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    const where = `two parts + club link at ${w}`;
    await expectPlayerBox(page, where);
    await expectNoLogo(page, where);
    await expectTappable(pill, `${where}: the pill`);
    for (const i of [0, 1]) await expectTappable(player.getByRole("tab").nth(i), `${where}: tab ${i + 1}`);
    await expectNoPageScroll(page, where);
    await shot(page, `two-parts-club-link-${w}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 2c. Focus at mount
// ---------------------------------------------------------------------------------------------------------------------
test("Match page - the tap hands focus to the player AT MOUNT, before its document has loaded (a keyboard user is not dropped on the page while it loads)", async ({ page }) => {
  test.setTimeout(budget({ navs: 2, acts: 6 }));
  const r = await rig(page, 1, null);
  // The player's document is held back: its load event cannot fire until the test lets it go.
  const net = await stubNetwork(page, { embeddingDisabled: false, holdEmbed: true });
  await visit(page, r.publicPath);
  const player = page.getByTestId("replay-embed");
  const facade = player.getByTestId("replay-facade");

  await facade.focus();
  await expect(facade, "premise: the button the tap lands on has focus").toBeFocused();
  await facade.click();
  await expect(player.locator("iframe"), "the tap mounts the player").toHaveCount(1);
  await expect(facade, "premise: the focused button is gone").toHaveCount(0);
  expect(net.answered, "premise: the player's document has NOT been answered, so it cannot have loaded").toBe(0);
  expect(await page.evaluate(() => document.activeElement?.tagName), "focus is on the player already, not on <body>").toBe("IFRAME");

  // Let it load: focus stays with the player.
  net.release();
  await expect.poll(() => net.answered, { message: "the player's document was answered" }).toBe(1);
  await expect.poll(async () => (await embedFrame(page)?.evaluate(() => (window as unknown as { __got: unknown[] }).__got.length)) ?? 0, {
    message: "the page handshook after the load",
  }).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.activeElement?.tagName), "and it is still there after the load").toBe("IFRAME");
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. The fallback
// ---------------------------------------------------------------------------------------------------------------------
test("Match page - a video that cannot be embedded: the player's error puts 'Open on YouTube' in its place, at 1280, 768 and 320", async ({ page }) => {
  test.setTimeout(budget({ navs: 2, acts: 6 + WIDTHS.length * 4 }));
  const r = await rig(page, 1, null);
  await stubNetwork(page, { embeddingDisabled: true });
  await visit(page, r.publicPath);
  const player = page.getByTestId("replay-embed");

  // No stream_url at all: the player is the only way to the replay.
  await expect(page.getByTestId("public-stream-link")).toHaveCount(0);
  await player.getByTestId("replay-facade").click();
  // The iframe mounts, the page says it is listening, the (stub) player answers error 150, and the page gives up the player.
  await expect(player.getByTestId("replay-unavailable"), "the fallback note replaces the player").toBeVisible({ timeout: NAV_MS });
  await expect(player.getByTestId("replay-unavailable")).toHaveText("This video can't be played here. Open it on YouTube.");
  await expect(player.locator("iframe"), "the dead player is gone").toHaveCount(0);
  await expect(player.getByTestId("replay-box"), "no empty player box is left behind").toHaveCount(0);
  const open = player.getByTestId("replay-open");
  await expect(open, "the link is the way out").toHaveAttribute("href", youtubeWatchUrl(r.ids[0]!));

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    const where = `fallback at ${w}`;
    await expectTappable(open, `${where}: Open on YouTube`);
    await expectNoLogo(page, where);
    await expectNoPageScroll(page, where);
    await shot(page, `fallback-${w}`);
  }

  // Nothing is remembered across visits: a reload starts over at the facade, and the player is asked again only on a tap.
  await page.reload({ waitUntil: "load" });
  await declineCookies(page);
  await expect(player.getByTestId("replay-facade"), "a reload starts over at the facade").toBeVisible();
});
