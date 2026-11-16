# Marketing product pages — design

Date: 2026-11-16. Status: DRAFT, awaiting owner approval.
Mocks (source of truth for look and layout): `~/seazn-artifacts/2026-11-16_product-pages_pp16a01/`
served at `http://127.0.0.1:8765/2026-11-16_product-pages_pp16a01/` — `cricket.html` (owner-approved),
`streaming.html`, `matchday.html`, `static.html` (nav menu and `/live` only).

## 1. Intent

The site is being repositioned from a brand site to a product site. A visitor is an organiser who arrived
from search; the one goal of every page is **Start free**. Pages sell what the product does by letting the
visitor *use a small working model of it*, then showing the real screens.

Not a funnel fix: no analytics study gates this work.

## 2. Goals, non-goals, anti-goals

Goals
- One theme and one layout system shared by ALL marketing pages: home, feature, sport, pricing, live.
- Feature pages: Sports (index), Format, Scheduling, Match Day, Streaming, Remote scoring, Sponsoring, Chess External Play.
  Format and Scheduling are REDESIGNED in this template, not only deleted (owner, 2026-11-16).
- One sport page per sport in the catalog, in the cricket pattern.
- A single `/live` page replacing `/discover` and `/discover/{sport}`.
- Every picture is a real product screen. Scoring pictures come from the phone app first.
- Pages make the paid add-ons (match credits, plans) easy to understand and want.

Non-goals
- No redirects for removed URLs. Delete the routes and drop them from sitemap, nav and footer.
- No search or sport/country filters on `/live` for now.
- No per-format pages in this wave (one Format page; per-format pages are a later wave).
- No redesign of the home flow that shipped in #1231 beyond adopting the shared theme tokens and nav.

Anti-goals (a page that does any of these has failed even if it renders)
- An invented illustration standing in for a product screen.
- A claim the product cannot do today. Each claim in §7 has a verification status; unverified = not shipped.
- A real club used as proof. Proof links go only to Seazn Demo Club.
- A phone view that is the desktop page shrunk. Mobile first, 320 / 768 / 1280.
- Hardcoded English. All four dictionaries (en, es, fr, nl).

## 3. Approaches considered

A. **Flat pages**: headline, captured screens, copy. Cheapest; shown as `static.html`. Reads like every
   other SaaS page and does not let the visitor feel the product.
B. **Live product embeds**: mount the real scoring pad and bracket against a demo fixture. Most honest, but
   drags auth, realtime and engine state into public, cached pages, and one page per sport multiplies it.
C. **Working model + real screens** (picked; owner approved the cricket page built this way): a small
   self-contained client model per page ("tap the pad, four screens react") above captured real screens.
   No server state, cacheable, cheap to repeat per sport.

Picked: C. Reason: it is the only one that is both memorable and safe on a statically cached public page.

## 4. The layout system

One template, three shapes. Parts, in order; a shape omits parts, never reorders or restyles them.

| Part | Feature page | Sport page | Home |
|---|---|---|---|
| Nav (Product menu, Sports, Pricing, Live, Log in, Start free) | yes | yes | yes |
| Hero: crumb, short H1, one-paragraph lede, two buttons | yes | yes | existing hero |
| Demo band: the working model, numbered tiles | yes | yes | existing flow |
| "Road": three steps, each with a real screen | yes | yes | no |
| Night band: four phone screens ("what the scorer holds") | optional | yes | no |
| Split band: copy + two screens (offline, phone-as-camera) | optional | yes | no |
| Ticket: the paid thing, as a ticket with a stub | yes | yes | pricing tickets |
| Demo club proof | yes | yes | no |
| Questions | yes | yes | no |
| Closing call + "more of the product" links | yes | yes | yes |

Rules
- H1 is short and plain ("Scores every ball."). The search phrase goes in the lede and `<title>`
  ("Cricket tournament software: …").
- Numbered markers only where the content is a sequence (demo tiles, road steps).
- Phone screens: 9:16 frame, real capture, status bar cropped. Web screens: 2x PNG.
- Sections alternate cream / night / lime ticket; tokens come from the house theme, not new colours.
- Motion only in answer to a tap, plus the demo's own ticking score; honour reduced motion.
- No horizontal scroll at 320. Tap targets ≥ 44px.

## 5. The working models

Each is a small pure state machine in a client component, with its own unit test, no network.

- **Sport page**: the scoring pad for that sport drives a match-centre tile, a standings tile and a stream
  tile. Cricket: a chase (target 49), keys 0–6, wide, out, undo. Scoring rules for each sport's model come
  from the engine's declarations, never typed into the page.
- **Streaming**: pad + stream tile; switches for overlay style (bar / bug) and state (soon / live /
  reconnecting / final).
- **Remote scoring** (owner, 2026-11-16): offline scoring is the HERO of this page, not a section lower down. H1 in
  the shape "No signal? Keep scoring."; the search phrase goes in the lede and `<title>`. The hero demo is a pad plus a
  signal switch: signal off, taps queue with a count; signal on, they send themselves. Below: hand a match to a
  volunteer's phone by code or QR with no account, what the scorer holds, and a link to "your phone is the camera" on
  Streaming. The lede must say this is the Seazn app on a phone: the web pad makes no offline claim.
- **Match Day**: three courts and a queue. Call → Called → Playing → Finished; an announcement card and a
  per-court stream list react.
- Format, Scheduling, Sponsoring, Chess: model to be designed per page in the same frame; builder proposes,
  owner signs off on the real page (no further mocks — owner decision).

## 6. Routes

Add (under `app/[lang]/(marketing)/`): `/product/streaming`, `/product/match-day`, `/product/format`,
`/product/scheduling`, `/product/remote-scoring`, `/product/sponsoring`, `/product/chess`, `/sports` (index), `/sports/{sport}`.
URL names are the builder's call within that shape; fix them once, in the nav config and the sitemap.

Delete, no redirects: `/formats`, `/scheduling`, `/use-cases/clubs|events|schools`, `/discover`,
`/discover/{sport}`. Remove from `sitemap.ts`, nav, footer, smoke strings, cache-key ledgers and e2e
(lesson from #1231: grep cache keys and smoke strings after deleting, not just imports).

`/live`: in-play matches on top, upcoming public competitions below, same listing rule as today
(`public_discovery_v`). With nothing to show: the existing "Start your own tournament" banner. The demo
club never appears in listings.

Home flow steps link to the matching feature page.

## 7. Claims register

| Claim | Status |
|---|---|
| Ball-by-ball cricket scoring, NRR tables, DLS | Real (owner confirmed DLS) |
| Phone app keeps scoring with no signal, sends when back | VERIFIED on device 2026-11-16. App only — never claim for the web pad |
| Phone is the camera; hold to go live; start/stop automatically per match | VERIFIED in app 2026-11-16 (not taken live) |
| Call a match to a court from web desk and from the app; both update | VERIFIED on staging 2026-11-16 |
| Volunteer joins Match Day by scanning one code, no account | Verified (scan flow used) |
| Second caller told the court is taken | From code (409); not driven |
| Streaming on every plan; one credit = one match up to 5h; packs 1 / 5 / 20; bigger packs cost less per match | Owner statement |
| Bought pack credits never expire (monthly plan grants do lapse at month end) | VERIFIED in code: `components/buy-credits.tsx:16`, `components/v2/fixture-stream-panel.tsx:168`. Copy must say "credits you buy" |
| "As many volunteer codes as you need" | UNVERIFIED against plan limits |
| When the camera drops, viewers see "Camera reconnecting, back shortly" and the broadcast resumes | VERIFIED in code: overlay scene `reconnecting` (`components/overlay`, dictionary `overlay.scene.reconnecting.line`) |
| Court-bound automatic streaming (link court to channel, one phone streams every match) | NOT BUILT. Mocked as shipped by owner decision. The Match Day section that claims it must not go live before the feature does |

No price figure appears on a page until live prices exist (only sandbox prices today).

## 8. Pictures

- Web: scripted Playwright on a local build, `deviceScaleFactor: 2`, PNG, demo org named "Seazn Demo Club".
  Never the Chrome extension (1x JPEG, cursor).
- App: `adb exec-out screencap` from a real device on the dev build against staging. Camera preview is
  replaced by real ground footage or clearly captioned as illustrated.
- Use the public **hub** (competition) page as the public proof picture, not the division page.
- Pictures live in the repo as optimised assets with dimensions set; no layout shift.

## 9. Demo club (separate, gated step)

"Seazn Demo Club" in production: finished matches, full standings, a bracket, a match-day view; undated
competition names; link-only (hidden from listings). Base: `scripts/seed-showcase.ts`. **Creating it in
production needs the owner's explicit go.** Until it exists the proof block links nowhere and pages that
depend on it do not ship.

## 10. Order of work

1. Shared theme + layout parts + nav; home and pricing adopt them.
2. Cricket sport page (approved pattern) and Streaming.
3. Route deletions, sitemap, `/live`.
4. Remaining sport pages (same shape, batched).
5. Format, Scheduling, Remote scoring, Sponsoring, Chess.
6. Match Day — held behind court streaming, or shipped without that section (owner to choose at the time).

One PR per wave. Each ships unit tests for its model, the scoped e2e (all seven widths cover the marketing
pages), smoke strings, and screenshots at 320 / 768 / 1280 for per-screen sign-off.

### Offline scoring: where it lives

Offline is a feature of the phone app, the same for every sport, so its home is the Remote scoring page (hero). Until
that page ships, the cricket page keeps its full "No signal at the ground? Keep scoring." section so the claim stays
promoted. When Remote scoring ships, every sport page's offline section shrinks to a small "Works without signal" tag
under the hero buttons, linking to it. A sport page's hero never carries the offline line: one message per hero.

### Decided after wave 1 was built (owner, 2026-11-16)

- No "More of the product" strip at the foot of a page: the nav menu and the footer already list the same pages. A page
  ends on its closing call. (§4's table row "Closing call + more of the product links" is now "Closing call" only.)
- No back arrow on Pricing or Live: both are top-level nav destinations.

## 11. Left to the builder

Component boundaries; route names within §6; the working models for the four un-mocked feature pages;
dictionary key layout; image pipeline details.

## 12. My calls (not owner decisions — correct any)

- Routes under `/product/*` and `/sports/*`.
- No per-format pages this wave.
- Match Day ships last because of the court-streaming dependency.
- Sport-page models read scoring rules from the engine rather than hand-written tables.
