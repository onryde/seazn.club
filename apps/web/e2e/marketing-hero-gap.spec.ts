// The night hero starts at the very top of the window, under the transparent bar, on every page that pulls it up.
//
// Each such page tucks its hero 64px up under the marketing bar (`-mt-16`, or `.mkp-hero{margin-top:-64px}`), so it
// works only while the bar is no taller than that. A 44px help icon in the bar (601d56408c) made it 69px from `md` up,
// and a 5px strip of the page's cream showed above the hero. No unit suite can see it: apps/web vitest has no DOM, and
// the heights come from the cascade.
//
// The pages are read off the source, not typed: a page that draws the night bar (`variant="night-scroll"`) is a page
// with a pulled-up hero, so a new one is measured without anyone adding it here.
// Single-sport reason: the two sport pages here are the route's two page bodies (cricket's own, and the shared one).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { expectNoHorizontalScroll } from "./helpers";
import { dismissCookieBanner } from "./scorepad-a11y-kit";

// The home page redirects signed-in users to /dashboard: run signed out.
test.use({ storageState: { cookies: [], origins: [] } });

const MARKETING = fileURLToPath(new URL("../src/app/[lang]/(marketing)", import.meta.url));
/** A dynamic segment's stand-ins: one per page body the route has. */
const SEGMENTS: Record<string, string[]> = { "[sport]": ["cricket", "football"] };

function nightPageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : nightPageFiles(path);
    return name === "page.tsx" && readFileSync(path, "utf8").includes('variant="night-scroll"') ? [path] : [];
  });
}

/** `(marketing)/product/format/page.tsx` -> `/en/product/format`, each dynamic segment filled from SEGMENTS. */
function urlsOf(file: string): string[] {
  const segments = relative(MARKETING, file).split(sep).slice(0, -1);
  return segments.reduce<string[]>(
    (urls, segment) => {
      const values = segment.startsWith("[") ? SEGMENTS[segment] : [segment];
      if (!values) throw new Error(`no stand-in for the route segment ${segment} (${file})`);
      return urls.flatMap((url) => values.map((v) => `${url}/${v}`));
    },
    ["/en"],
  );
}

const FILES = nightPageFiles(MARKETING);
const PAGES = FILES.flatMap(urlsOf).sort();
// 1280 and 768 draw the whole bar, the help icon included (from `md`); 320 is the phone bar, which never had the strip.
const WIDTHS = [1280, 768, 320] as const;
/** What every one of these heroes pulls itself up by. */
const PULL_UP = 64;

test("premise: the pages under the night bar were found in the source", () => {
  // The count on 2026-11-25: home, start, play, live, the sports index and sport page, and the seven product pages.
  expect(FILES.length, FILES.join("\n")).toBeGreaterThanOrEqual(13);
  expect(PAGES.length).toBeGreaterThanOrEqual(14);
});

for (const width of WIDTHS) {
  test(`${width}: no strip above the hero on any page that pulls it up under the bar`, async ({ page }) => {
    test.setTimeout(Math.max(60_000, PAGES.length * 10_000));
    await page.setViewportSize({ width, height: 800 });
    const measured: string[] = [];
    const strips: string[] = [];
    for (const path of PAGES) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      expect(new URL(page.url()).pathname.replace(/^\/en/, ""), `${path} did not redirect away`).toBe(path.replace(/^\/en/, ""));
      await dismissCookieBanner(page);
      // The sentinel the bar watches is the hero's own first child.
      const hero = page.locator("#mk-hero-sentinel").locator("..");
      await expect(hero, path).toHaveCount(1);
      const m = await hero.evaluate((el) => ({
        pull: parseFloat(getComputedStyle(el).marginTop),
        top: el.getBoundingClientRect().top + window.scrollY,
        bar: document.querySelector("[data-mk-nav]")!.getBoundingClientRect().height,
      }));
      expect(m.pull, `${path}: premise, this element is the pulled-up hero`).toBe(-PULL_UP);
      measured.push(`${path} bar=${m.bar} hero top=${m.top}`);
      if (m.top > 0 || m.bar > PULL_UP) strips.push(`${path}: bar ${m.bar}px, hero starts ${m.top}px down`);
      await expectNoHorizontalScroll(page);
    }
    console.log(`hero gap @${width}: ${measured.length} pages measured\n${measured.join("\n")}`);
    expect(measured.length, "anti-vacuity: pages measured").toBe(PAGES.length);
    expect(strips, `${measured.length} pages measured`).toEqual([]);
  });
}

/** What a tap lands on at the middle and just inside each edge of a box. */
const tapsThatMiss = (link: Locator) =>
  link.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const points = { middle: [r.x + r.width / 2, r.y + r.height / 2], top: [r.x + r.width / 2, r.y + 1], bottom: [r.x + r.width / 2, r.bottom - 1], left: [r.x + 1, r.y + r.height / 2], right: [r.right - 1, r.y + r.height / 2] };
    return Object.entries(points)
      .filter(([, [x, y]]) => {
        const hit = document.elementFromPoint(x!, y!);
        return !(hit && (hit === el || el.contains(hit)));
      })
      .map(([name]) => name);
  });

for (const width of [1280, 768] as const) {
  test(`${width}: the help icon keeps its 44px tap area inside the shorter bar`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/en");
    await dismissCookieBanner(page);
    const bar = page.locator("[data-mk-nav]");
    const help = bar.getByRole("link", { name: "Help", exact: true });
    const box = (await help.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const barBox = (await bar.boundingBox())!;
    expect(box.y, "inside the bar, top").toBeGreaterThanOrEqual(barBox.y);
    expect(box.y + box.height, "inside the bar, bottom").toBeLessThanOrEqual(barBox.y + barBox.height);
    expect(await tapsThatMiss(help)).toEqual([]);
  });
}
