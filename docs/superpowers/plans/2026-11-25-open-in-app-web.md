# Open in App (web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Android phone user can tap **Open in app** beside a stream, scoring or Match Day code and land in the Seazn Club app.

**Architecture:** One pure link builder; two sets of route handlers (`assetlinks.json`, bare-HTML `/app/*` fallbacks); one client button component used at four surfaces; one new scrubber rule. A staging spike gates everything after Task 2.

**Tech Stack:** Next.js route handlers (read `apps/web/node_modules/next/dist/docs/` first), vitest (`environment: "node"`), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-25-open-in-app-web-design.md` §5–§8. If the Promotion plan has landed, reuse its `PLAY_STORE_URL` from `lib/app-store.ts`; otherwise create that file here with only that constant.

## Global Constraints

- Links: `<origin>/app/stream#<unpadded base64url of UTF-8 captureQrV2Text>`, `/app/score#dl_…`, `/app/day#md_…`; origin is `siteOrigin()`; the credential appears only after `#`.
- Staging assetlinks: `com.seazn.capture.dev`, `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`. Public debug keystore: **never on production**.
- Production assetlinks: `com.seazn.capture` + the three Play app-signing SHA-256s of spec §5.2 (supplied 2026-11-25). Other origins: `[]`.
- Nothing else is ever added under `/app/*` (the phone filter owns it).
- Buttons: Android user agent **and** below `md`; plain `<a href>`, no `next/link`, no `target="_blank"` on Open in app, no fetch-then-redirect, `rel="noreferrer"`; wrapper has `ph-no-capture`; no new server call.
- Strings in en/es/fr/nl; regenerate i18n keys.
- No Sentry Replay runs today (`lib/replay-guard.ts` header); `ph-no-capture` is still required and is what a future replay blocks.
- The "Already installed?" line is **not** built (no owner yes).
- Run only tests covering changed files; UI at 1280/768/320.

## Review Focus

- A credential in an outgoing PostHog event after a tap (autocapture href, `$current_url`): must read `[token]` or be absent. (Task 3)
- `/app/stream` opened with no fragment, or a garbled one: same page, no error, no script reads it. (Task 2)
- A court code with `exp` and a non-ASCII-free round trip: bytes after decoding equal the QR text exactly. (Task 1)
- Server render and first client render on Android: no hydration mismatch, button appears after mount. (Task 4)
- Fallback opened directly (in-app browser, typed URL, `history.length === 1`): "Score in browser instead" hidden, Play link still works. (Task 2)

---

### Task 1: Link builder and assetlinks

**Files:**
- Create: `apps/web/src/lib/open-in-app.ts`, `apps/web/src/lib/assetlinks.ts`, `apps/web/src/app/.well-known/assetlinks.json/route.ts`
- Test: `apps/web/src/lib/__tests__/open-in-app.test.ts`, `.../assetlinks.test.ts`

**Interfaces:**
- Produces (client-safe, no server imports):
  - `streamAppLink(origin: string, qrText: string): string`
  - `scoreAppLink(origin: string, secret: string): string`
  - `dayAppLink(origin: string, dayUrl: string): string | null` (takes `MatchDayCode.url`, `<origin>/day/md_…`; null if it has no `md_` token)
- Produces: `assetLinksFor(origin: string): AssetLink[]`. Production origin means hostname exactly `seazn.club`; staging exactly `stg.seazn.club`.

- [ ] **Step 1: Failing tests**

```ts
it.each([
  captureQrV2Text({ v: 2, code: "0123456789ab", slot: 0, tok: "A".repeat(22) }),
  captureQrV2Text({ v: 2, code: "0123456789ab", slot: 3, tok: "_-".repeat(11), exp: 1795600000 }),
])("stream fragment round-trips the QR text byte for byte", (text) => {
  const url = streamAppLink("https://stg.seazn.club", text);
  const [head, frag] = url.split("#");
  expect(head).toBe("https://stg.seazn.club/app/stream");
  expect(frag).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(Buffer.from(frag!, "base64url").toString("utf8")).toBe(text);
});
it("score and day put the token only after #", () => {
  const dl = "dl_" + "a".repeat(43), md = "md_" + "b".repeat(43);
  expect(scoreAppLink("https://seazn.club", dl)).toBe(`https://seazn.club/app/score#${dl}`);
  expect(dayAppLink("https://seazn.club", `https://seazn.club/day/${md}`)).toBe(`https://seazn.club/app/day#${md}`);
  expect(dayAppLink("https://seazn.club", "https://seazn.club/day/")).toBeNull();
});
it("production never lists the debug key or the dev package", () => {
  const s = JSON.stringify(assetLinksFor("https://seazn.club"));
  expect(s).not.toContain("FA:C6:17");
  expect(s).not.toContain("com.seazn.capture.dev");
});
it("staging lists exactly the dev twin", () => expect(assetLinksFor("https://stg.seazn.club")).toEqual([{
  relation: ["delegate_permission/common.handle_all_urls"],
  target: { namespace: "android_app", package_name: "com.seazn.capture.dev", sha256_cert_fingerprints: [DEBUG_SHA] } }]));
it.each(["http://localhost:3000", "https://seazn.club.evil.test", "not a url"])("%s gets []", (o) => expect(assetLinksFor(o)).toEqual([]));
it("route answers 200 json with assetLinksFor(siteOrigin())", ...);
```

`DEBUG_SHA` is the fingerprint in Global Constraints, typed in the test.

- [ ] **Step 2:** `cd apps/web && npx vitest run src/lib/__tests__/open-in-app.test.ts src/lib/__tests__/assetlinks.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Encode with `TextEncoder` + `btoa` (runs in the browser; no `Buffer`). Production entry is built only when `PLAY_SIGNING_SHA256S` (a readonly list in `assetlinks.ts`) is not empty. Route is dynamic.
- [ ] **Step 4:** Tests PASS. **Step 5:** Commit `feat(open-in-app): link builder and assetlinks.json`.

### Task 2: Fallback pages, then the staging spike (GATE)

**Files:**
- Create: `apps/web/src/lib/app-fallback-page.ts`, `apps/web/src/app/app/{stream,score,day}/route.ts`
- Modify: `apps/web/next.config.js` (new rule `source: "/app/:path*"`, `Referrer-Policy: no-referrer`, placed after the catch-all, the way the `MATCH_ROOM_SOURCE` rule replaces a header); four `ui.json`
- Test: `apps/web/src/lib/__tests__/app-fallback-page.test.ts`, `apps/web/e2e/open-in-app.spec.ts`

**Interfaces:**
- Produces: `appFallbackResponse(kind: "stream" | "score" | "day", request: Request): Promise<Response>`. Locale from request header `x-seazn-locale` (fallback `en`); nonce from `x-nonce` (both set by `proxy.ts`). `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`.
- Keys: `openApp.fallback.{title,play,retry,scoreInBrowser}`. English: "Seazn Club isn't on this phone yet" / "Get it on Google Play" / "Then come back and tap Open in app again" / "Score in browser instead".

- [ ] **Step 1: Failing tests.** Unit, for all 3 kinds × 4 locales: contains the localized title and `PLAY_STORE_URL`; no `src=` pointing at another origin; exactly one `<script nonce="N">`; its body does not match `/hash|location\.href|\/score\//`; the score-in-browser element exists only for `score`; no `Set-Cookie`. E2E:

```ts
test("served headers and fragment handling", async ({ page }) => {
  const res = await page.goto("/app/score#dl_" + "a".repeat(43));
  expect(res!.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page).toHaveURL(/\/app\/score$/);
  await expect(page.getByTestId("score-in-browser")).toBeHidden(); // nothing to go back to
});
test("score in browser instead goes back", ...); // visit "/", then /app/score, click it, expect "/"
test("no request carries the fragment and no analytics loads", ...); // collect page.on("request"): only the document (+ favicon)
```

Run also with no fragment and `#%%%` on `/app/stream`: 200, same title, no console error. Run under `CSP_MODE=enforce` once and assert no CSP violation.

- [ ] **Step 2:** Run → FAIL (404).
- [ ] **Step 3:** Implement. Inline script: `history.replaceState(null,"",location.pathname)`; if `history.length > 1` unhide the link (rendered `hidden`) and wire `history.back()`. Inline `<style>` only; badge art or a plain button for Play.
- [ ] **Step 4:** Both test files PASS; screenshot the three pages at 320.
- [ ] **Step 5:** Commit `feat(open-in-app): bare fallback pages under /app`.
- [ ] **Step 6: SPIKE GATE (needs the owner and the phone session).** With the owner's go-ahead, get Tasks 1–2 onto staging. Test link: send the owner a one-line HTML anchor to paste on any signed-in staging page via devtools, `<a href="https://stg.seazn.club/app/score#dl_` + 43×`a` + `">test</a>` (this replaces the spec's committed test link, so nothing temporary ships). Phone session installs a dev build; a real tap in Chrome and Samsung Internet must open the app. Also confirm `curl -sI https://stg.seazn.club/.well-known/assetlinks.json` is 200 with no redirect, and the served `/app/score` HTML has no injected script. **If the tap stays in the browser: stop, report; the link host has to change and the spec goes back to both sides.**

## Approved look (owner, 2026-11-25) — binds Task 2b, Task 4 and Task 5

Reference: `~/seazn-artifacts/open-in-app-buttons/th-*.png` (shot at 2x). House theme, compact, with the logo.

- **Button block** (inside the existing light console panel): night (`--mk-night`) block, radius 10, padding 6;
  inside it a `1.5px dashed var(--mk-lime)` box, radius 7, padding 8, gap 6. Top: the Seazn logo
  (`public/brand/seazn-logo-night-tight.png`, 18px high, centred, alt "Seazn Club"). Then **Open in app**: lime
  fill, night text, `mk-display` bold 15px uppercase, tracking .06em, at least 44px tall. Scoring adds **Score in
  browser** below it: 1px `#4a378c` border, cream 13px semibold, at least 44px. Stream hints sit inside the box,
  11.5px, `#c9bfee`; the missing-destination and missing-credit hints in `#ffc66b`.
- **Order:** the block comes **above** the QR, followed by a new line "or scan with another phone"
  (`openApp.orScan`, four locales), shown only when the block is shown. Without the block (not Android, `md` and up,
  flag off) the panel is exactly as today: no line, no reorder.
- **QR:** unchanged `SeaznQrImage` (it already carries the logo).

### Task 2b: Restyle the fallback pages (not gated)

**Files:** Modify: `apps/web/src/lib/app-fallback-page.ts`; its unit test and `e2e/open-in-app.spec.ts`.

Night background; logo (30px high) inlined as a `data:` URI so the page still requests nothing but the document;
one `1.5px dashed` lime box, radius 12, padding 20/16, holding the heading (cream, uppercase, 25px/1.1,
condensed), a lime 44px Play button (night text, condensed bold 16px uppercase) and the retry line (13px
`#c9bfee`); "Score in browser instead" below, cream 13.5px underlined. The condensed face is the marketing
display font **inlined as a `data:` `@font-face`** (latin subset, covering en/es/fr/nl accents) so no font request
is made; fall back to `"Arial Narrow", sans-serif`. Check the served CSP allows `font-src data:` (it does today).
Copy, script, headers and behaviour do not change. Tests: existing ones stay green; add that the HTML contains the
logo `data:` URI and no `url(` pointing anywhere but `data:`. Screenshots at 320 for all three kinds and `fr`.

### Task 3: Telemetry guard

**Files:** Modify: `apps/web/src/lib/scrub-score-url.ts`; Test: `apps/web/src/lib/__tests__/scrub-app-link.test.ts`

**Interfaces:** Produces: `scrubScoreUrl` turns any fragment after `/app/(stream|score|day)#` into `[token]`, plain or percent-encoded at any depth; so `holdsCredential` is true for such a URL.

- [ ] **Step 1: Failing tests**

```ts
const stream = streamAppLink("https://seazn.club", captureQrV2Text({ v: 2, code: "0123456789ab", slot: 0, tok: "A".repeat(22) }));
it.each(["stream", "score", "day"])("%s fragment is replaced", (k) =>
  expect(scrubScoreUrl(`https://seazn.club/app/${k}#abcDEF_-123`)).toBe(`https://seazn.club/app/${k}#[token]`));
it("encoded inside another URL", () => { const out = scrubScoreUrl(`/x?next=${encodeURIComponent(stream)}`); expect(out).not.toContain(stream.split("#")[1]); });
it("double encoded", ...);
it("a PostHog autocapture event is clean", () => { /* posthogBeforeSend on {properties:{$current_url: stream, $elements:[{attr__href: stream}], $elements_chain:`a:href="${stream}"`}} : JSON.stringify(result) lacks the fragment */ });
it("leaves /product/streaming#try and /app/stream alone", ...);
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add the two rules **before** `BARE_TOKEN`, and add their trigger strings to `MAYBE_TOKEN` (without that the pre-check returns early and the rules never run).
- [ ] **Step 4:** New test and all `src/lib/__tests__/scrub-*.test.ts` PASS. Delete the new rule once and confirm the new tests fail.
- [ ] **Step 5:** Commit `fix(telemetry): scrub /app link fragments`.

### Task 4: The button, and the two scoring and Match Day surfaces (after the gate)

**Files:**
- Create: `apps/web/src/components/v2/open-in-app.tsx`, `apps/web/src/lib/android-ua.ts`
- Modify: `apps/web/src/components/v2/device-link-panel.tsx` (both `minted` branches, compact and full, outside `more()`), `components/v2/match-day/match-day-code-sheet.tsx` (`shown` state gains the code's url; button under the QR), four `ui.json`, `fly.stg.toml`, `Dockerfile`, `apps/web/.env.example`
- Test: `apps/web/src/lib/__tests__/android-ua.test.ts`, `apps/web/e2e/open-in-app.spec.ts`

**Interfaces:**
- Consumes: Task 1 builders.
- Produces: `isAndroidUa(ua: string): boolean`; `openInAppEnabled(): boolean` = `process.env.NEXT_PUBLIC_OPEN_IN_APP === "1"`; `OpenInAppRow({ href, children }: { href: string | null; children?: ReactNode })`, client component: renders nothing unless enabled, Android (read after mount via `useSyncExternalStore`, server snapshot false) and `href`; wrapper `className="ph-no-capture md:hidden …"`, anchor `data-testid="open-in-app"`; `children` is extra content in the same row.
- Release hold-back: `NEXT_PUBLIC_OPEN_IN_APP = "1"` in `fly.stg.toml`, wired in `Dockerfile` exactly as `NEXT_PUBLIC_REVSHARE_ENABLED` is; absent from `fly.toml` until Task 6.
- Keys: `openApp.button` ("Open in app"), `openApp.scoreInBrowser` ("Score in browser").
- Scoring row: children is `<a data-testid="score-in-browser-link" href={padUrl} target="_blank" rel="noreferrer">`. Client origin for `scoreAppLink` is the same origin `padUrl` is built from.

- [ ] **Step 1: Failing tests.** Unit: `isAndroidUa` true for a Pixel Chrome UA and a Samsung Internet UA; false for iPhone Safari, iPad, macOS Chrome, empty string. E2E (needs a server built with the env flag; skip otherwise, as `affiliates-page.spec.ts` does, and add the flag to the e2e workflow's build env), using the `device-links.spec.ts` fixtures and a Match Day fixture:

```ts
test.use({ userAgent: PIXEL_UA, viewport: { width: 390, height: 844 } });
// after Create/Show QR, compact and full:
await expect(page.getByTestId("open-in-app")).toHaveAttribute("href", new RegExp(`^${origin}/app/score#dl_[A-Za-z0-9_-]{43}$`));
// the token equals the one in device-link-url's text
await expect(page.getByTestId("score-in-browser-link")).toHaveAttribute("href", padUrlText);
await expect(page.getByTestId("open-in-app")).not.toHaveAttribute("target", /.*/);
// match day sheet: href is `${origin}/app/day#md_…`
```

Absent (count 0): before Create; iPhone UA; Android UA at width 768 → `toBeHidden`. No hydration warning in console. Tap with PostHog requests intercepted (consent accepted): no payload contains the token.

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS, plus existing `device-links.spec.ts` and the Match Day spec; screenshots 1280/768/320.
- [ ] **Step 5:** Commit `feat(open-in-app): buttons for scoring links and Match Day codes`.

### Task 5: Stream buttons

**Files:**
- Modify: `components/v2/fixture-stream-panel/phone-tab-body.tsx` (inside `codeInner`, below the QR, when `p.code.status === "ok"`), `components/v2/match-day/court-stream-sheet.tsx` (`QrState` ok and `drawn()` keep `text`), four `ui.json`
- Create: `apps/web/src/lib/open-in-app-hint.ts`; Test: `.../__tests__/open-in-app-hint.test.ts`, e2e spec

**Interfaces:**
- Consumes: `OpenInAppRow`, `streamAppLink`.
- Produces: `streamHintKey(i: { hasDestination: boolean; hasCredit: boolean }): "openApp.stream.thenGoLive" | "openApp.stream.needDestination" | "openApp.stream.needCredit"` — destination checked first.
- Fixture panel: `hasDestination = Boolean(p.selectedTargetId)`; `hasCredit = p.balance >= 1 || Boolean(p.restart?.free)`. No row when `p.planGate`. (A court-linked fixture shows no code, so no row.)
- Court sheet (holds neither): always `openApp.stream.checkFirst`, followed by `thenGoLive`.
- English: "Then hold Go live in the app." / "Pick a destination here first." / "You need a streaming credit first." / "Check a destination is picked and you have a credit."

- [ ] **Step 1: Failing tests**

```ts
it.each([
  [true, true, "openApp.stream.thenGoLive"],
  [false, true, "openApp.stream.needDestination"],
  [false, false, "openApp.stream.needDestination"],
  [true, false, "openApp.stream.needCredit"],
])(...)
```

E2E (Android UA, 390): on the fixture stream panel and the court sheet, decode the `href` fragment and compare to the code the server answered (intercept the stream-code / court-streams response, `JSON.stringify` its `qr` in the `captureQrV2Text` key order); hint text matches state with and without a destination; button still present when the destination is missing; Revoke & reissue changes the `href`.

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus the existing stream panel and court stream specs; screenshots.
- [ ] **Step 5:** Commit `feat(open-in-app): stream code buttons`.
- [ ] **Step 6:** On staging with one phone, walk: pick destination → Open in app → app Go live → stream live. Record what actually happened, including any step the hint failed to name.

### Task 6: Production release (owner-gated, in this order)

- [ ] Owner supplied the Play app-signing SHA-256s (2026-11-25): `PLAY_SIGNING_SHA256S` is set, and a test holds production to exactly `com.seazn.capture` with the three, keeping both negatives. Still owed: deploy; verify with `curl`.
- [ ] Phone release with the intent filter is **on Play** (confirmed by the owner).
- [ ] Add `NEXT_PUBLIC_OPEN_IN_APP = "1"` to `fly.toml`. Deploy. Real tap on production.
