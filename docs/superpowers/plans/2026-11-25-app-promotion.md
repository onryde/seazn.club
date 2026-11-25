# Android App Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Google Play badge for the Seazn Club app in the marketing footer, the home page and three product pages.

**Architecture:** One constant for the Play URL, one badge component, one band component; pages only choose copy keys. Self-hosted official badge art per locale.

**Tech Stack:** Next.js (read `apps/web/node_modules/next/dist/docs/` first), Tailwind, vitest (`environment: "node"`), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-25-open-in-app-web-design.md` §4

## Global Constraints

- URL, one definition only: `https://play.google.com/store/apps/details?id=com.seazn.capture`, same on staging and production.
- Official Google Play badge artwork for en/es/fr/nl, self-hosted, unaltered, with Google's clear space and trademark line.
- Product name in copy: "Seazn Club Mobile App" (owner, 2026-11-25). Band labels are exactly that; Android is stated in the footer line. No App Store badge, no "coming soon".
- Shown on every device.
- Never on: public competition pages (`(public)/live/[orgSlug]`), signed-in app shell, overlays, embeds, slideshow, scoring pad.
- Copy may only claim what the published app does today.
- Every new string in `apps/web/src/dictionaries/{en,es,fr,nl}/marketing.json`; then regenerate `lib/i18n-keys.ts` with the repo's gen-keys script (see `apps/web/package.json`).
- Verify at 1280, 768, 320 with no horizontal scroll; run Lighthouse on home and streaming, before and after.
- Run only tests covering changed files.

## Review Focus

- Unknown or unprefixed locale (legal pages pass default `en`): badge shows English art, never a broken image.
- 320px footer: badge fits, no horizontal scroll.
- Badge image blocked or slow: link keeps an accessible name and reserved size (no layout shift).
- A page using the footer directly (legal) gets the badge once, not twice.
- Copy claiming a feature the Play version lacks.

---

### Task 1: Mockups and owner pick (no product code)

**Files:** Create: mockup HTML outside the repo (`~/seazn-artifacts/open-in-app/promo.html`), served on :8765.

- [x] **Step 1:** Open the Play listing; write down what it says the app does and under which developer name. If the page is not our app or not installable, stop and report.
- [x] **Step 2:** Mock footer, home band, streaming band, match-day and remote-scoring bands at 1280 and 320, using the real marketing theme tokens, with proposed English lines for the three product pages and home.
- [x] **Step 3:** Owner approves placement and lines. Record the approved lines in this plan under Task 3. **Do not start Task 3 without this.** Tasks 1 and 2 are independent.

### Task 2: Play link and badge in the footer

**Files:**
- Create: `apps/web/src/lib/app-store.ts`, `apps/web/src/components/marketing/play-badge.tsx`, `apps/web/public/badges/google-play-{en,es,fr,nl}.png` (or `.svg`, as Google ships them)
- Modify: `apps/web/src/components/marketing-footer.tsx`, the four `marketing.json`, `lib/i18n-keys.ts` (generated)
- Modify: whatever `apps/web/src/dictionaries/en/ui.json` key says "Seazn Capture app" (about line 7532), in all four locales → "Seazn Club Mobile App"
- Test: `apps/web/src/components/marketing/__tests__/play-badge.test.tsx`

**Interfaces:**
- Produces: `PLAY_STORE_URL: string`; `playBadgeSrc(lang: string): string`; `async function PlayBadge({ lang, size }: { lang: string; size?: "sm" | "md" })` rendering `<a href={PLAY_STORE_URL} data-testid="play-badge">` with localized `alt` (key `app.playBadge.alt`) and explicit width/height.

- [ ] **Step 1: Failing tests**

```ts
it.each(["en", "es", "fr", "nl"])("%s has its own art, and the file exists", (l) => {
  expect(playBadgeSrc(l)).toBe(`/badges/google-play-${l}.png`);
  expect(existsSync(join(PUBLIC_DIR, playBadgeSrc(l)))).toBe(true);
});
it("unknown locale falls back to English art", () => expect(playBadgeSrc("de")).toBe(playBadgeSrc("en")));
it("the store URL is written in exactly one source file", () => {
  expect(filesContaining("play.google.com/store", "apps/web/src")).toEqual(["lib/app-store.ts"]);
});
it("the footer renders one badge and the trademark line", async () => { /* render MarketingFooter({lang:"fr"}) with the repo's server-component test helper: exactly one data-testid="play-badge", href === PLAY_STORE_URL, fr alt, t(fr,"app.playBadge.trademark") present */ });
```

- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/marketing/__tests__/play-badge.test.tsx` → FAIL (module missing).
- [ ] **Step 3:** Implement. Download art from Google's official badge page; do not redraw. Footer: badge in a row above the bottom bar, centred on phones.
- [ ] **Step 4:** Same command → PASS (read counts from the JSON reporter). Run the existing footer and i18n parity tests.
- [ ] **Step 5:** Screenshot `/` and `/legal/privacy` footers at 1280/768/320.
- [ ] **Step 6:** Commit `feat(marketing): Google Play badge in the footer`.

### Task 3: Bands on home and product pages

**Files:**
- Create: `apps/web/src/components/marketing/app-band.tsx`
- Modify: `apps/web/src/app/[lang]/(marketing)/page.tsx` (after `CompetitionFlow`, before the pricing band); `product/streaming/page.tsx` (after `PhoneRow`); `product/match-day/page.tsx` (after `SplitBand`); `product/remote-scoring/page.tsx` (after `DemoBand`'s `PageHero`); four `marketing.json`
- Test: `apps/web/e2e/app-promo.spec.ts`

**Interfaces:**
- Consumes: `PlayBadge`.
- Produces: `AppBand({ lang, title, line }: { lang: string; title: string; line: string })`, root `data-testid="app-band"`. Keys: `home.app.{title,line}`, `product.{streaming,matchday,remoteScoring}.app.{title,line}` (match each page's existing key prefix).

**Owner, 2026-11-25: approved, Option B** (slim "ticket stub" strip). Task 1 is done. Reference screenshots and
the injected CSS/markup: `~/seazn-artifacts/open-in-app-promo/` (`<page>-B-{1280,320}.png`, `footer-*.png`); the
mock script's `.pm-b` rules are: night background, `max-width 72rem` box, `1.5px dashed var(--mk-lime)` border,
radius 14px, padding 14px 20px, strong title 16px cream, 13px `#c9bfee` line, badge right; under 600px
everything centres. Build with the house Tailwind tokens, not that CSS verbatim.

The mock's phone layout crowds the text. Build it as three stacked blocks under `sm`: title; the
"Seazn Club Mobile App" label on its own line; the line; then the badge. No " — " joining on any width below `sm`.

`AppBand` therefore takes `{ lang, title, label, line }` (replaces the signature above), with a `label` key beside
each `title`/`line` pair. Approved English:

| Page | label | title | line |
| --- | --- | --- | --- |
| Home | Seazn Club Mobile App | Your phone is the camera and the scorer | Scan your organiser’s code to stream a match with the score on screen, or to score it. |
| Streaming | Seazn Club Mobile App | Put the camera in your pocket | Scan a match or court code, hold Go live. No laptop, no capture card. |
| Match day | Seazn Club Mobile App | One phone follows the court | Scan a court code once. It goes live when a match starts and stops when it ends. |
| Remote scoring | Seazn Club Mobile App | Score from the app too | Open your organiser’s scoring link and score rally by rally. The browser pad still works. |

Footer: badge centred above the bottom bar, with "Seazn Club Mobile App for Android. Google Play and the Google Play logo
are trademarks of Google LLC." Remote scoring's band goes after the hero section (which holds the live demo).
The Play listing (read 2026-11-25) says Android 12 or later and covers match streaming, court streaming and
scoring; it does not mention Match Day lists.

- [ ] **Step 1: Failing e2e**

```ts
for (const path of ["/", "/product/streaming", "/product/match-day", "/product/remote-scoring"])
  test(`${path}: one app band, two Play links (band + footer), no sideways scroll`, async ({ page }) => {
    for (const width of [1280, 768, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(path);
      await expect(page.getByTestId("app-band")).toHaveCount(1);
      await expect(page.getByTestId("play-badge")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    }
  });
test("fr page uses fr art", ...); // /fr/product/streaming: every play-badge img src ends google-play-fr.png
```

Also assert `play-badge` count 0 on one public competition page, one embed and the scoring pad, reusing existing e2e fixtures for those.

- [ ] **Step 2:** Run that spec (seazn-local-env skill) → FAIL, 0 bands.
- [ ] **Step 3:** Implement with the approved lines.
- [ ] **Step 4:** Spec passes; screenshots at three widths; Lighthouse home and streaming, record before/after.
- [ ] **Step 5:** Commit `feat(marketing): app band on home and product pages`.
