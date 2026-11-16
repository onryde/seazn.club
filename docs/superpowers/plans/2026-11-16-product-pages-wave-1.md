# Product Pages — Wave 1 (layout system, nav, Streaming, Cricket) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the shared marketing page parts, the new nav, and the first two pages built from them:
`/product/streaming` (feature shape) and `/sports/cricket` (sport shape).

**Architecture:** Server-rendered page parts in `components/marketing/product/`, styled by one `mkp-*` stylesheet on
the existing `--mk-*` tokens. One client island (`ChaseDemo`) driven by a pure cricket-chase model. Pages are static
per locale under `app/[lang]/(marketing)/`, complete without script.

**Tech Stack:** Next (this repo's version — read `node_modules/next/dist/docs/` before writing any route or CSS import),
React server components, Tailwind + `globals.css` tokens, vitest (`environment: "node"`), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-product-pages-design.md` (owner approved 2026-11-16).
**Mock (look and layout of record):** `~/seazn-artifacts/2026-11-16_product-pages_pp16a01/` — `cricket.html`,
`streaming.html`, `page.css`, `demo.js`, `img/`. Served at `http://127.0.0.1:8765/2026-11-16_product-pages_pp16a01/`.

This is wave 1 of 6 (spec §10, steps 1–2). Route deletions, `/live`, other sports, other feature pages and Match Day
are later plans. Nothing is deleted in this wave.

## Global Constraints

- New branch in a new worktree off `origin/main`; never the main checkout. One PR for the wave. No merge without the
  owner's explicit go.
- Every user-facing string in all four dictionaries (`apps/web/src/dictionaries/{en,fr,es,nl}/marketing.json`); run
  `npm run i18n:gen-keys` and `npm run i18n:check`. Team and player names in the example stay untranslated.
- H1 is short ("Scores every ball."); the search phrase lives in the lede and `<title>`.
- No price figure on any page. No real club. The demo-club block renders without a link until a URL exists.
- Only claims marked Real / VERIFIED / Owner statement in spec §7 may appear. Offline scoring is claimed for the
  phone app only, never the web pad.
- Pictures: the mock's `img/` files, copied into `apps/web/public/marketing/product/`. Phone captures 9:16, web 2x PNG.
  Every `<img>` carries `width`, `height`, `alt`, `loading="lazy"` (hero band excepted).
- Mobile first. No horizontal page scroll at 320, 768, 1280. Tap targets ≥ 44px.
- Motion only in answer to a tap; nothing animates under `prefers-reduced-motion: reduce`.
- ≥ 768 home and pricing pages look the same as today except for the nav.
- Scoped tests only: the vitest paths and specs named in each task. Never the full suite locally.
  Run vitest as `cd apps/web && npx vitest run <paths> --reporter=json --outputFile=<file>` and judge on
  `numPassedTests`/`numTotalTests` and `.testResults[].name`.
- Every task mutates the one guard it adds, once, and records that the test went red.

## Review Focus

1. **Tap after the match is over, or undo with nothing to undo** — the model stays put: no negative runs, no 11th
   wicket, no ball past the target. (Task 2)
2. **Script off or still loading** — both pages read complete; the demo shows its opening state, not empty tiles.
   (Tasks 4, 6, 7)
3. **`/sports/<anything else>`** — 404, never an empty shell page. (Task 7)
4. **Long French and Dutch copy at 320px** — no page overflow, no clipped button label. (Task 8)
5. **Unprefixed URL** — `/product/streaming` serves English without a visible redirect; `/fr/product/streaming` serves
   French; both carry hreflang for all four. (Task 5)

---

### Task 1: Settle the three unverified claims

**Files:**
- Modify: `docs/superpowers/specs/2026-11-16-product-pages-design.md` (§7 table only)

- [ ] **Step 1:** "Credits never expire". Read `apps/web/src/server/usecases/__tests__/credits-tab.test.ts` (the
  never-expire packs case) and the code it drives. Record VERIFIED-in-code or NOT TRUE, with the file and line.
- [ ] **Step 2:** "The stream shows a reconnecting state". Read `apps/web/src/components/overlay/` (scene
  `reconnecting`, `__tests__/overlay-scene.test.ts`). Record what a viewer sees, in one sentence, from the code.
- [ ] **Step 3:** "As many volunteer codes as you need" is not used in this wave. Leave UNVERIFIED.
- [ ] **Step 4:** Any claim found NOT TRUE: delete its copy line from Tasks 6–7 before building. Commit the spec edit.

### Task 2: The cricket chase model

**Files:**
- Create: `apps/web/src/lib/marketing/cricket-chase.ts`
- Test: `apps/web/src/lib/marketing/__tests__/cricket-chase.test.ts`

**Interfaces — Produces:**
```ts
export type ChaseKey = "0" | "1" | "2" | "3" | "4" | "6" | "wide" | "out";
export type ChaseState = { runs: number; wkts: number; balls: number; over: string[]; last: string | null; history: ChaseState[] };
export const CHASE = { target: 49, wicketsToFall: 10, opening: { runs: 27, wkts: 2, balls: 19 } } as const;
export function openingChase(): ChaseState;
export function tap(s: ChaseState, key: ChaseKey): ChaseState;   // returns s unchanged when chaseOver(s)
export function undo(s: ChaseState): ChaseState;                  // returns s unchanged when history is empty
export function chaseOver(s: ChaseState): "won" | "allOut" | null;
export function oversText(balls: number, ballsPerOver: number): string;  // 19, 6 -> "3.1"
export function needText(s: ChaseState): { runs: number };        // max(0, target - runs)
```
`BALLS_PER_OVER` is read from the engine's cricket declaration, not typed here. Re-pin the exact export before use
(`node_modules/@seazn/engine/dist/sports/` — the cricket module's default `ballsPerOver`); if the engine exposes no
such constant, record that as a finding and derive from the default config object the pad itself uses.

- [ ] **Step 1: Write the failing tests** (names are the contract):
  - `opening state is 27/2 after 3.1 overs chasing 49`
  - `a run adds to runs and balls; a wide adds one run and no ball` — assert `tap(s,"wide").balls === s.balls`
  - `out adds a wicket and a ball and no runs`
  - `the over strip resets after the engine's balls-per-over legal balls` — loop bound comes from the engine constant
  - `undo restores the exact previous state, any number of times, and is a no-op at the opening state`
  - `reaching the target ends the chase: further taps return the same object` — `expect(tap(won,"6")).toBe(won)`
  - `ten wickets ends the chase the same way`
  - `a sweep of every key from every reachable state within 12 taps never yields negative runs, wkts > 10 or a tap
    accepted after the end` — count the states visited and `expect(visited).toBeGreaterThan(1000)`
- [ ] **Step 2:** Run `cd apps/web && npx vitest run src/lib/marketing/__tests__/cricket-chase.test.ts`. Expected: fails, module not found.
- [ ] **Step 3:** Implement the functions above. Pure, immutable, no React.
- [ ] **Step 4:** Run again. Expected: all pass, 8 tests.
- [ ] **Step 5:** Mutate: remove the `chaseOver` early return in `tap`. Expected: the two "ends the chase" tests and the
  sweep go red. Restore.
- [ ] **Step 6:** Commit `feat(marketing): cricket chase model for product page demos`.

### Task 3: Stylesheet and static page parts

**Files:**
- Create: `apps/web/src/components/marketing/product/product.css` (port of the mock's `page.css`, every class
  renamed `mkp-*`, colours via `--mk-*`, display face via `--mk-font-display`)
- Create: `apps/web/src/components/marketing/product/parts.tsx`
- Create: `apps/web/public/marketing/product/` (copy from the mock `img/`: `pad.png`, `hub-m.png`, `hub-d.png`,
  `mc-m.png`, `dest-m.png`, `panel-m.png`, `stream-bar.jpg`, `stream-bug.jpg`, `app-pad2.png`, `app-out.png`,
  `app-wide.png`, `app-more.png`, `app-offline.png`, `app-offline-history.png`, `app-stream-armed.png`,
  `app-stream-settings.png`)
- Create: `apps/web/src/lib/marketing/product-images.ts`
- Test: `apps/web/src/components/marketing/product/__tests__/parts.test.tsx`

**Interfaces — Produces:**
```ts
// product-images.ts — one entry per file above, measured from the file, not typed by hand
export const PRODUCT_IMAGES: Record<ProductImageKey, { src: string; width: number; height: number; kind: "phone" | "web" }>;

// parts.tsx — all server components; text arrives already translated
export function PageHero(p: { crumb: string; title: React.ReactNode; lede: string; primary: { label: string; href: string }; secondary: { label: string; href: string }; children?: React.ReactNode }): JSX.Element;
export function Road(p: { title: string; lede: string; steps: { heading: string; who: string; body: string; image: ProductImageKey; caption: string }[] }): JSX.Element;
export function PhoneRow(p: { title: string; lede: string; items: { image: ProductImageKey; heading: string; body: string }[] }): JSX.Element;
export function SplitBand(p: { title: string; lede: string; steps: { heading: string; body: string }[]; figures: { image: ProductImageKey; caption: string }[] }): JSX.Element;
export function Ticket(p: { title: string; body: string; kicker: string; heading: string; rows: { label: string; value: string }[]; stub: { top: string; big: string; bottom: string } }): JSX.Element;
export function DemoClub(p: { text: string; image: ProductImageKey; href?: string; linkLabel?: string }): JSX.Element;
export function Questions(p: { title: string; items: { q: string; a: string }[] }): JSX.Element;   // <details>, no script
export function Closing(p: { line: string; cta: { label: string; href: string }; moreLabel: string; more: { label: string; href: string }[] }): JSX.Element;
```
Section order and markup follow `cricket.html`. `Road` numbers its steps (it is a sequence); nothing else is numbered.

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup`):
  - `every product image file exists and its recorded size matches the file` — read each PNG/JPEG header from
    `public/`; `expect(checked).toBe(Object.keys(PRODUCT_IMAGES).length)` and `> 0`
  - `every img carries width, height and a non-undefined alt` — assert on `width="` and `alt="` (anchor on `="`)
  - `Road renders its steps in order, numbered from 1`
  - `DemoClub without href renders no anchor; with href renders exactly one`
  - `Questions renders one details per item with the answer inside it`
  - `phone images sit in a 9:16 frame class, web images do not`
- [ ] **Step 2:** Run `npx vitest run src/components/marketing/product/__tests__/parts.test.tsx`. Expected: fails, module not found.
- [ ] **Step 3:** Port the stylesheet and write the parts. Check in the Next docs how this version wants a
  component-scoped global stylesheet imported; if it must be imported from a layout, import it in
  `app/[lang]/(marketing)/layout.tsx`.
- [ ] **Step 4:** Run again. Expected: pass.
- [ ] **Step 5:** Commit `feat(marketing): shared product page parts and stylesheet`.

### Task 4: The demo island

**Files:**
- Create: `apps/web/src/components/marketing/product/chase-demo.tsx` (`"use client"`)
- Test: `apps/web/src/components/marketing/product/__tests__/chase-demo.test.tsx`

**Interfaces:**
- Consumes: Task 2's `openingChase`, `tap`, `undo`, `chaseOver`, `oversText`, `needText`, `CHASE`.
- Produces:
```ts
export type ChaseDemoLabels = { /* every visible string, keyed; built by the page from the dictionary */ };
export function ChaseDemo(p: {
  tiles: ("pad" | "matchCentre" | "table" | "stream")[];   // cricket: all four; streaming: ["pad","stream"]
  streamControls: boolean;                                   // style bar|bug, state soon|live|reconnecting|final
  labels: ChaseDemoLabels;
  teams: { batting: string; bowling: string };
}): JSX.Element;
```
Markup carries `data-testid="chase-pad"`, `chase-key-<key>`, `chase-undo`, `chase-score`, `chase-need`,
`chase-tile-<name>`. The pad image-free: real buttons, like the mock.

- [ ] **Step 1: Write the failing tests:**
  - `server render shows the opening state in every tile it was asked for` — "27/2", "3.1", need 22
  - `streaming configuration renders the pad and the stream only`
  - `every key in ChaseKey has a button, and undo has one` — count equals `8 + 1`
- [ ] **Step 2:** Run. Expected: fails.
- [ ] **Step 3:** Implement with one `useState<ChaseState>`. A changed tile gets a flash class only when
  `matchMedia("(prefers-reduced-motion: reduce)")` does not match.
- [ ] **Step 4:** Run. Expected: pass. (Tap wiring is proven in Task 8, not here — this suite has no DOM.)
- [ ] **Step 5:** Commit `feat(marketing): interactive chase demo`.

### Task 5: Nav, routing, sitemap

**Files:**
- Create: `apps/web/src/lib/marketing/product-nav.ts`
- Modify: `apps/web/src/components/marketing-nav.tsx` (the `LINKS` const, lines 8–13)
- Modify: `apps/web/src/components/marketing/mobile-nav.tsx`
- Modify: `apps/web/src/components/marketing-footer.tsx` (Product column, lines 14–18)
- Modify: `apps/web/src/proxy.ts:237` (`MARKETING_PREFIXED`)
- Modify: `apps/web/src/app/sitemap.ts` (static entries, ~line 40)
- Test: `apps/web/src/components/marketing/__tests__/mobile-nav.test.tsx`, `marketing-shell.test.tsx`,
  `apps/web/src/app/__tests__/sitemap.test.ts`, and the existing proxy test that covers `MARKETING_UNPREFIXED`
  (grep `MARKETING_PREFIXED\|/use-cases/` under `src/**/__tests__` to find it)

**Interfaces — Produces:**
```ts
export const PRODUCT_LINKS = [
  { key: "nav.product.streaming", href: "/product/streaming" },
  { key: "nav.formats", href: "/formats" },          // old pages stay listed until their wave replaces them
  { key: "nav.scheduling", href: "/scheduling" },
] as const;
export const SPORT_LINKS = [{ key: "nav.sport.cricket", href: "/sports/cricket" }] as const;
export const TOP_LINKS = [{ key: "nav.pricing", href: "/pricing" }, { key: "nav.live", href: "/live" }] as const;
```
Desktop nav: `Product` and `Sports` are disclosure menus (`<details>`-based or button + `aria-expanded`; keyboard and
Escape work), then Pricing, Live, Log in, Start free. Mobile nav: the same links as two labelled groups. `Use cases`
leaves the top nav and stays in the footer until its wave.

- [ ] **Step 1: Write the failing tests:**
  - `the nav offers Product and Sports menus containing every PRODUCT_LINKS and SPORT_LINKS href, in every locale`
  - `mobile nav lists the same hrefs as desktop` (set equality, count reported)
  - `sitemap contains /product/streaming and /sports/cricket with all four hreflang alternates`
  - `proxy serves /product/streaming and /sports/cricket as English without a redirect, and leaves /fr/product/streaming alone`
- [ ] **Step 2:** Run those four files. Expected: the new cases fail.
- [ ] **Step 3:** Implement. Add `"/product/"` and `"/sports/"` to `MARKETING_PREFIXED`. Add dictionary keys
  `nav.product`, `nav.sports`, `nav.live`, `nav.product.streaming`, `nav.sport.cricket` in four locales; regenerate keys.
- [ ] **Step 4:** Run. Expected: pass. Mutate: drop `"/sports/"` from `MARKETING_PREFIXED`; the proxy case goes red. Restore.
- [ ] **Step 5:** Commit `feat(marketing): product and sports menus, routes in proxy and sitemap`.

### Task 6: `/product/streaming`

**Files:**
- Create: `apps/web/src/app/[lang]/(marketing)/product/streaming/page.tsx`
- Modify: the four `marketing.json` dictionaries (keys `product.streaming.*`, shared `product.demo.*`)
- Test: `apps/web/src/app/[lang]/(marketing)/product/__tests__/streaming-page.test.tsx`

**Interfaces — Consumes:** Task 3 parts, Task 4 `ChaseDemo` (`tiles: ["pad","stream"]`, `streamControls: true`),
`MarketingShell` with `variant="night-scroll"`, `marketingMeta({ lang, path: "/product/streaming", … })`.

Copy and section order are `streaming.html` exactly: hero "The score is already on your stream." · demo "Tap the pad.
Watch the stream." · "Three steps to air" (`dest-m`, `panel-m`, `app-pad2`) · "Your phone is the camera"
(`app-stream-armed`, `app-stream-settings`) · ticket "One match. One credit. About a coffee." (rows: Length / Up to
5 hours; Goes out on / Your YouTube channel; Score on screen / Included; Expires / Never, once bought — the last row
only if Task 1 verified it; stub "1 · 5 · 20", "Bigger packs cost less per match.") · demo club · four questions ·
closing "Put your next match on air."

- [ ] **Step 1: Write the failing tests:**
  - `renders in every locale with one h1 equal to the dictionary's product.streaming.h1` (4 locales checked)
  - `sections appear in the order hero, demo, road, camera, ticket, club, questions, closing` — by `indexOf` of each
    section's `data-section="…"`
  - `no currency symbol or digit-with-currency appears anywhere in the page text` — regex `/[$£€]\s?\d|\d\s?(USD|GBP|EUR)/`
  - `the page text never says offline` (web-pad claim guard)
  - `the armed-camera figure is captioned as illustrated`
- [ ] **Step 2:** Run. Expected: fails.
- [ ] **Step 3:** Build the page from the parts; add the copy in English, then French, Spanish, Dutch.
- [ ] **Step 4:** Run, plus `npm run i18n:check`. Expected: pass, parity clean.
- [ ] **Step 5:** Commit `feat(marketing): streaming product page`.

### Task 7: `/sports/[sport]` with cricket

**Files:**
- Create: `apps/web/src/app/[lang]/(marketing)/sports/[sport]/page.tsx`
- Create: `apps/web/src/lib/marketing/sport-pages.ts`
- Modify: the four `marketing.json` dictionaries (keys `sport.cricket.*`)
- Test: `apps/web/src/app/[lang]/(marketing)/sports/__tests__/sport-page.test.tsx`

**Interfaces — Produces:**
```ts
export const SPORT_PAGES = ["cricket"] as const;          // later waves append; never reorder
export type SportPageKey = (typeof SPORT_PAGES)[number];
export function isSportPage(s: string): s is SportPageKey;
```
`generateStaticParams` returns `LOCALES × SPORT_PAGES`; `dynamicParams = false` (confirm the spelling in the Next
docs) so any other slug is a 404.

Copy and order are `cricket.html` exactly: hero "Scores every ball." with lede "Cricket tournament software: …" and
`<title>` "Cricket tournament software" · demo "One tap. Four screens." (all four tiles) · "Built for how cricket is
actually run" (`hub-m`, `app-pad2`, `mc-m`) · "What the scorer holds" (`app-pad2`, `app-out`, `app-wide`, `app-more`) ·
"No signal at the ground? Keep scoring." (`app-offline`, `app-offline-history`; copy says "in the Seazn app") ·
NRR/DLS ticket with the stream upsell linking `/product/streaming` · demo club · questions · closing.

- [ ] **Step 1: Write the failing tests:**
  - `cricket renders in every locale; h1 is sport.cricket.h1; title contains the search phrase`
  - `isSportPage accepts every SPORT_PAGES entry and rejects "", "Cricket", "cricket/", "tennis"` (count reported)
  - `generateStaticParams yields LOCALES.length × SPORT_PAGES.length entries`
  - `the offline section names the app` — the section's text contains the dictionary's app name string, in each locale
  - `the stream upsell links to /product/streaming`
- [ ] **Step 2:** Run. Expected: fails.
- [ ] **Step 3:** Build the page and copy.
- [ ] **Step 4:** Run, plus `npm run i18n:check`. Expected: pass. Mutate: make `isSportPage` `return true`; the reject
  case goes red. Restore.
- [ ] **Step 5:** Commit `feat(marketing): sport page shape, cricket first`.

### Task 8: Browser proof, smoke, sign-off pictures

**Files:**
- Create: `apps/web/e2e/marketing-product.spec.ts`
- Modify: `scripts/smoke/suites/marketing.ts`
- Modify: `apps/web/e2e/mobile.spec.ts` only if it enumerates marketing URLs (grep `"/pricing"`); add the two routes
  to that list so all seven widths cover them

- [ ] **Step 1: Write the spec** (whole file runs; never a `-g` slice):
  - `cricket: tapping 4 moves the score, the match page tile, and the stream tile; undo puts all three back` — read
    each `data-testid` before and after; hit-test the key with `elementFromPoint` at its centre
  - `cricket: finishing the chase updates the table tile and the keys stop changing the score`
  - `streaming: the style and state switches change the stream tile`
  - `both pages at 320, 768, 1280: document.documentElement.scrollWidth <= innerWidth, zero page errors, zero images
    with naturalWidth 0` — report images checked; zero checked is a failure
  - `both pages in fr and nl at 320: no overflow` (Review Focus 4)
  - `javaScriptEnabled: false — both pages show the opening score and every section heading` (Review Focus 2)
  - `/sports/tennis returns 404` (Review Focus 3)
  - `reduced motion: after a tap no element has the flash class`
  - `Product and Sports menus open by keyboard, close on Escape, and each link lands on a 200`
- [ ] **Step 2:** Build and serve per the `seazn-local-env` skill (`up --server`, never `next start`), then
  `cd apps/web && BASE=http://localhost:<port> npx playwright test e2e/marketing-product.spec.ts`. Expected: all pass;
  re-run three times.
- [ ] **Step 3:** Smoke: add `marketing: /product/streaming 200` + contains "already on your stream";
  `marketing: /sports/cricket 200` + contains "Scores every ball"; `marketing: /sports/tennis 404`. Run only that suite.
- [ ] **Step 4:** Re-run the specs this wave's nav change touches: `marketing-home.spec.ts`, `i18n-marketing.spec.ts`,
  `seo-meta.spec.ts`, `sitemap.spec.ts` (grep for the nav's testids and old link text first; sweep by behaviour).
- [ ] **Step 5:** Capture both pages at 320, 768, 1280 (2x, scripted) into
  `~/seazn-artifacts/2026-11-16_product-pages-build_<id>/` beside the mock's pictures; add the INDEX row; regenerate
  the index. Confirm the six pictures per page exist and differ.
- [ ] **Step 6:** Commit `test(marketing): product pages e2e and smoke`.

### Task 9: Review and PR

- [ ] **Step 1:** Reviewer pass over the whole branch with the three standing lenses; findings written to a file.
- [ ] **Step 2:** Fix, re-run the scoped tests the fixes touch.
- [ ] **Step 3:** Rebase onto `origin/main`, open ONE PR. Body lists: what a visitor sees, the claims register status,
  the pictures' location, and "e2e does not run on PRs — dispatch with `--ref` or rely on the local run above".
- [ ] **Step 4:** Read every check before reporting. Wait for the owner's per-screen verdicts and explicit merge go.
