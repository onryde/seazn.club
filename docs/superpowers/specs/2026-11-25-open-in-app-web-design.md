# Seazn Club app on the web: promote it, and "Open in app"

Status: design, approved by the owner on 2026-11-25. The owner handed ownership of the web decisions to this session on
2026-11-25; calls made here are marked **(web call)**. Not scheduled.

Phone side: capture repo PR #73, `docs/specs/2026-11-25-open-in-app-design.md` (owner-approved).
Facts below were read on `origin/main` @ `5a6edaa7b7`.

## 1. Intent

Two separate wants, shippable separately.

- **Part A, promote the app.** People should find the Android app from the website: footer, home page,
  streaming page and the other product pages (owner, 2026-11-25).
- **Part B, Open in app.** A person signed in on the phone they will film or score with has no second screen to
  show a QR to. They tap **Open in app** beside the code and the app opens on it, as if scanned.

## 2. Goals, non-goals, anti-goals

Goals: the Play listing is one tap from the pages in §4; all three code types open in the app from the browser on
Android; nothing changes for a person who does not tap the new things.

Non-goals: iOS (no App Store badge, no "coming soon"); opening the app by itself after install; app login;
new QR formats.

Anti-goals:

- A code's credential reaching a server log, an analytics event, a session replay, an error report, a referrer or
  a third party.
- A button that shows "not installed" to people for whom it can never work (iPhone, laptop).
- App promotion inside stream overlays, embeds, slideshows or the scoring pad.

## 3. Approaches

Link design (decided in the phone spec, owner): **separate `/app/*` links** used only by the button. Rejected:
turning `/score/` and `/day/` into App Links (takes the web pad away), and a custom scheme (chooser, no
fallback).

Chrome check (web): Chrome keeps a same-host navigation in the browser *unless the set of apps able to handle the
new URL differs* (`ExternalNavigationHandler.shouldStayWithinHost`). Our app handles `/app/*` and not the page
holding the button, so a tap on `seazn.club` should leave to the app. The final call site was only confirmed from
a summary: **a real tap on a real phone against staging is a ship gate** (Chrome and Samsung Internet).
If it fails, the fallback to evaluate is a separate host for the links (a different host is never "same host");
that changes the link shapes and goes back to the phone session. `intent://` URLs are not the fallback: it is
undocumented whether their data URL can carry its own `#fragment`.

Fallback pages, how to build:

| Option | Trade-off |
| --- | --- |
| **Bare HTML from a route handler (picked, web call)** | No app bundle, so no PostHog, Sentry or cookie banner can exist on the page. Copy and styling are hand-carried. |
| Next page, excluded from analytics | Reuses theme and i18n, but the root layout still mounts analytics; exclusion is a filter that can regress. PostHog's `$current_url` includes the fragment. |

`assetlinks.json`, how to serve:

| Option | Trade-off |
| --- | --- |
| **Route handler choosing by `siteOrigin()` (picked, web call)** | One source, correct per host, testable. |
| Static file in `public/` | Impossible per host: staging and production are built from the same source. This corrects phone spec §7/§9. |

## 4. Part A: promote the app

- One constant holds the Play URL (`https://play.google.com/store/apps/details?id=com.seazn.capture`; it returned
  HTTP 200 on 2026-11-25, page content not inspected). One shared badge component. No other copies of the URL.
  Same URL on staging and production **(web call)**: the dev twin is not on Play.
- Official Google Play badge artwork, self-hosted, one per locale (en/es/fr/nl), used unaltered with Google's
  clear space and trademark line. Text strings go in the four `marketing.json` dictionaries.
- Shown on every device **(web call)**: a laptop visitor learns the app exists. The line beside it says Android.
- One product name: **Seazn Club app** **(web call)**. `ui.json` today also says "Seazn Capture app"; aligning
  that string is part of this work.

Placement **(web call, to be confirmed on mockups before build)**:

| Surface | What | Where |
| --- | --- | --- |
| `MarketingFooter` (marketing, blog, help, developers, games, legal) | small badge | footer brand area |
| Home | band: one line + badge | after `CompetitionFlow`, before the pricing band |
| Product: streaming | band: "your phone is the camera" + badge | after the phone row |
| Product: match day | same band, match-day line | after the split band |
| Product: remote scoring | same band, scoring line | after the demo band |

Not included **(web call)**: public competition pages (their footer is in the `(public)/live/[orgSlug]` layout;
they are the organiser's pages and carry the organiser's sponsors), the signed-in app shell (it gets Part B's
buttons), overlays, embeds, slideshow, scoring pad.

The line on each page may only claim what the published app does today. The builder checks the Play listing before
writing copy.

## 5. Part B: Open in app

### 5.1 Link shapes (agreed with the phone session, 2026-11-25)

| Code | Link | Fragment |
| --- | --- | --- |
| Stream | `<origin>/app/stream#…` | unpadded base64url of the UTF-8 bytes of the exact QR text (`captureQrV2Text`) |
| Scoring | `<origin>/app/score#dl_…` | the device-link token |
| Match Day | `<origin>/app/day#md_…` | the day code token |

`<origin>` is `siteOrigin()`. The credential is only ever in the fragment. One pure module builds all three links.

### 5.2 `/.well-known/assetlinks.json`

Route handler: 200, `application/json`, no redirect, no auth. Relation
`delegate_permission/common.handle_all_urls`.

- Production origin: `com.seazn.capture` with the **Play app-signing** SHA-256 (Play Console → App integrity;
  owner supplies it; the upload key is not it). Until supplied, production returns `[]`.
- Staging origin: `com.seazn.capture.dev`,
  `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`
  (from the phone session, checked there with apksigner). This is the stock React Native debug keystore, which
  anyone can sign with: **staging only**. Accepted risk: someone could build an app that captures staging links.
- Any other origin: `[]`.

A test asserts the debug fingerprint and the `.dev` package can never appear for the production origin.

### 5.3 Fallback pages `/app/stream`, `/app/score`, `/app/day`

Seen only when the app did not take the link.

```
  [Seazn Club]
  Seazn Club isn't on this phone yet
  [ Get it on Google Play ]
  Then come back and tap Open in app again.
  Score in browser instead          <- /app/score only
```

- Bare HTML from route handlers, in en/es/fr/nl, language chosen the same way the proxy picks a locale.
- No external script, no analytics, no cookies set, no request that carries the page URL. `noindex`.
- `Referrer-Policy: no-referrer`. The `next.config.js` catch-all sets `strict-origin-when-cross-origin`, so a
  later `/app/:path*` rule must replace it; test the header as served.
- One inline script under the proxy's CSP nonce, doing two things: `history.replaceState(null, "",
  location.pathname)` to drop the fragment without reading it **(web call)**, and wiring **Score in browser
  instead** to `history.back()`. It never reads `location.hash` and never builds a `/score/` URL. With no history
  to go back to, the link is hidden **(web call)**.
- Known limit: **Score in browser instead** returns to the page the person came from, which may have been
  reloaded and lost the shown secret; they then tap **Show QR** again. It does not open the pad by itself.
- Residual risk, accepted **(web call)**: the phone's own browser history may keep the visited URL, and a synced
  profile may sync it.
- On staging, confirm nothing at the edge injects a script into these pages.

### 5.4 The buttons

| Where | File | Code |
| --- | --- | --- |
| Fixture stream panel, phone tab | `fixture-stream-panel/phone-tab-body.tsx` | stream v2 |
| Court stream sheet | `match-day/court-stream-sheet.tsx` | stream v2 with `exp` |
| Scoring link panel (fixture console, court focus) | `device-link-panel.tsx` | `dl_` |
| Match Day code sheet | `match-day/match-day-code-sheet.tsx` | `md_` |

**One phone streams from the app (web call, on the phone session's answer, 2026-11-25).** Beside each stream
**Open in app** button, a line in four locales: "Then tap Go live in the app." The app has its own **Go live**
(a hold, enabled once camera, mic, network and sideways checks pass); the phone session reports it as the normal
path, verified on device. The web console's **Go live** is unchanged and stays the two-device case. A web or
automatic start while the app is behind the browser on the same phone is **unproven** (phone session's open item
N28; never run), so no web copy may promise it. A single-phone web Go live would need that device test first.
**Missing destination or credit (web call).** The server refuses the app's own Go live without them, and the app
then says "ask the organiser", to a person who may be the organiser (phone session, from its code; not re-run on
one phone). So when the page knows one is missing, the line beside the button names it instead, in four locales:
"Pick a destination here first." or "You need a streaming credit first." The button stays, because pairing works
without either and a refusal leaves the phone paired. It reuses what the panel already uses to gate its own Go
live, with no new server call; a surface that does not hold that state (check the court sheet) shows
"Check a destination is picked and you have a credit." The end-to-end walk after the spike covers this on one
phone.

No button on printed scorer sheets (paper) or the quick-match score redirect (nothing is shown).

- A button exists only where the page already holds the code. No new server call, no minting on tap.
- Scoring: the phone spec calls **Score in browser** existing. It does not exist: the panel has the QR, **Copy
  link** and the URL as text. It is a **new** link **(web call)**: shown with **Open in app** under the same
  Android and below-`md` rule, `href` the same `/score/{token}` the panel already builds, opening in a new tab so
  the panel keeps the token, under the §5.5 guards, in four locales.
- Scoring states **(web call)**: only when the panel holds the secret (`minted`, i.e. after Create or Show QR),
  full and compact. In compact both sit outside **More**. Rows without the secret get no button.
- Shown only on **Android and below `md`** **(web call)**. One small user-agent helper (none exists today),
  decided on the client after mount. An Android phone in desktop-site mode or a wide landscape view gets no
  button; the QR and link still work.
- **A plain `<a href>` with the link already built.** No `next/link` (a client-side route change never reaches
  Android), no `target="_blank"`, no fetch-then-redirect (Chrome needs the user's own tap), `rel="noreferrer"`.

### 5.5 Keeping the credential out of our own telemetry

The anchor's `href` holds a live credential on a page that does run analytics.

- PostHog autocapture records clicked `href`s, and replay records attributes: mark the anchor's wrapper
  `ph-no-capture` (existing convention) and block it from Sentry Replay.
- `scrub-score-url.ts` catches `dl_` and `md_`, but **not** the base64url stream fragment (read from its rule
  list, not run). Add a rule for `/app/(stream|score|day)#…`, plain and percent-encoded, so `holdsCredential`
  covers it too.
- Proof is the real outgoing PostHog event and replay payload after a tap on each button, not a unit test of the
  regex alone.

## 6. Constraints

- The phone app's intent filter is `https://<host>/app/*`; no other web page may be added under `/app/`
  **(web call)**, or the app will take it over. `app` is already a reserved org slug.
- Next.js here has breaking changes: read the bundled docs for route handlers and headers before building.
- UI verified at 1280, 768 and 320 with no horizontal scroll; marketing pages also measured with Lighthouse.
- Four locales for every new string.

## 7. Tests the build owes

- Link builder: round-trips the QR text byte for byte (with and without `exp`); credential never before `#`.
- assetlinks: each origin's exact JSON, including the negative in §5.2.
- Fallback pages: served headers; no external script; script never references `hash`.
- Buttons: absent on iPhone and desktop user agents, absent at `md` and up; e2e at phone width with an Android
  user agent, per surface, checking `href`.
- Telemetry: §5.5.
- Badge: each §4 surface renders it in each locale; absent on overlay, embed and pad.
- By hand on staging: tap with the app installed (Chrome, Samsung Internet), without it, and from an in-app
  browser.

## 8. Order

1. Part A can ship at any time.
2. Part B starts with a **spike (web call)**: staging assetlinks, one stub `/app/score` page, one plain test
   link on a signed-in staging page, and a dev build. The real tap in §3 must pass before the rest is built.
3. Then: staging assetlinks and `/app/*` pages (plus telemetry guards) → the phone session verifies a dev build
   against `stg.seazn.club` → buttons → production assetlinks **before** the app release that declares the filter.
   Production buttons ship only once that release is on Play **(web call)**; before it, every tap would say "not
   installed". How the buttons are held back until then is the builder's call.

## 9. Needed from the owner


- The Play app-signing SHA-256 (blocks only production assetlinks).
- In-app browsers may not hand links to apps, so a person who has the app can see "isn't on this phone yet".
  The page copy is the owner-approved phone spec's. Proposal: add one line, "Already installed? Open this page in Chrome." It is left out of the build unless the owner says yes, and does not block it. Note that after the fragment is dropped, they would go back and tap again
  in Chrome from the signed-in page, so the wording must send them there.

## 10. Left to the builder

Component and module names; how the nonce reaches the route handler; badge sizes within Google's rules; exact
marketing lines (shown on mockups first).
