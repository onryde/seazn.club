# Stream overlay — the live score inside a club's own broadcast — design

Status: owner-approved in chat 2026-09-05 (design sections, entitlement gate as
recommended). Mockups and the two theme directions the owner picked from:
https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901
(artboards "A · Broadcast bar", "B · Corner bug", "A across sports", "B across
sports", "Moments", "How fans see it on a phone", "What the club sets up",
"Organiser console: Stream this match", "Same panel at 390").

Branch `feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`.
Related programmes: spectator surface
(`docs/superpowers/specs/2026-09-04-spectator-surface-design.md`, W1 match
centre in flight on `feat/spectator-surface`) and competition desk W1
(`feat/fixture-console-redesign`, edits `components/v2/stages-panel.tsx`).

## Goal

A club streams its match to YouTube, Facebook or Twitch with OBS or any
broadcast tool that can layer a web page. seazn serves a transparent overlay
page per fixture that carries the live score in the sport's own colours, and
an organiser panel per fixture that hands the club the overlay link, the setup
steps and a place to save the stream link so fans find it on the public match
page. Video never touches seazn. We serve the overlay page and the score.

Customer value: the score inside the video, in the app's identity, for every
sport the engine scores, with the scorer doing nothing new. Market reference:
CricHeroes sells a per-match "Score Ticker" for OBS or vMix, cricket only.

## Decisions locked (owner, 2026-09-05)

1. **Both themes ship.** A "Broadcast bar" (TV lower third) and B "Corner bug"
   (the pad's own stadium-night tile). Style is a query parameter on the
   overlay URL, never a database column. Per-sport default as product owner:
   cricket opens on the bar, every other sport on the bug. The club switches
   in the panel. Owner reverses by naming the other letter.
2. **Per match, from the division fixtures tab** (owner vocabulary "Fixture
   Console" = the division page's `?tab=fixtures`, `stages-panel.tsx`, not
   `fixture-console.tsx`). An inline expander on the fixture row, the same
   pattern the row already uses for schedule edit. No sheet or drawer exists
   there and none is introduced.
3. **All eleven engine sports** render through one shared projection. Bespoke
   detail lines and moments exist only for the sports whose modules declare
   the events: cricket, football, hockey, ice hockey, tennis, badminton, table
   tennis, volleyball. Board game (the chess module), carrom and generic get
   the shared two-row composition and nothing else, by construction.
4. **Moments (SIX, OUT, GOAL, MATCH POINT) are step two**, after spectator W1
   lands its per-event-type template model. Step one ships without them. The
   cricket bar's batter and bowler line is also step two, same dependency.
5. **Hidden behind an entitlement key, not a header.** No feature flag or
   preview header exists in this repo (scout 2026-09-05: the only custom
   request headers are `x-seazn-org` and `x-seazn-locale`, both routing), and
   OBS cannot send custom headers, so a header could never gate the overlay
   page itself. New key `streaming.overlay`, granted by no plan at launch;
   the owner's test org gets it through an `org_entitlement_overrides` row.
   Not entitled means the panel is absent and the overlay route is 404, never
   an upsell.
6. **Destination-agnostic.** YouTube, Facebook, Twitch and Kick all work the
   same way; help copy leads with YouTube and Facebook.
7. **Not in this spec:** video embedded on the seazn match page (Option 2, its
   own spec later, carries the stream-delay problem), phone-only streaming
   with a burned-in score (needs a media relay we host), the paid-tier
   decision (flip the catalogue row when ready).

## Current state, from the tree (2026-09-05, scout-verified `file:line`)

- Public live transport: `components/public-site/live-score.tsx:71-117`.
  Subscribes to a private Supabase channel, event `state_changed`, and on each
  ping refetches `fetchLiveFixture` after a 250 ms debounce; falls back to a
  15 s poll when not subscribed. The ping carries no body and no event type.
- Payload: `components/public-site/live-score-data.ts:7-23`,
  `LiveFixtureData { status, summary: { headline?, perSide?, detail? } | null,
  outcome }`. Aggregated, never a raw event.
- Realtime token: `app/api/v1/public/fixtures/[id]/realtime-token/route.ts`,
  403 unless the org holds `realtime`. Overlay inherits the poll fallback.
- Derivations LiveScore already applies to `summary`: `setBreakdown`,
  `periodBreakdown`, `disciplineList`, `servingSide`, `matchStrength`
  (`live-score.tsx:120-130`). The overlay reuses these; it does not derive a
  second time (one authority per fact).
- Sport identity: `components/v2/scorepad/v3/sport-theme.ts:165`
  `SPORT_PALETTES` (overrides only; cricket = product defaults `--mk-night
  #150b36`, `--mk-night-2 #1d1145`, cream `#f5f0e8`, LED `#9ae600`), applied
  by `sportThemeStyle`. Skins: `registry.ts:85` `V3_SKINS`, eleven keys.
- Public identity: `app/(public)/shared/[orgSlug]/layout.tsx` mounts Barlow
  Condensed as `--ps-font-display`; court `#231738`, court-ink `#f7f5fb`.
- Fixtures table: `db/migration/v2-engine/tables/V214__fixtures.sql:4-25`,
  no media column, no catch-all jsonb. Migration numbering is flat across
  directories; highest today is V391.
- Greenfield rule (`docs/superpowers/RULES.md:32-34`): "Adding new
  tables/columns is fine and expected. Prefer a correct schema over a
  backwards-compatible one."
- Entitlements: resolver `lib/entitlements.ts:66-68` priority
  `org_entitlement_overrides` → competition pass → plan, field by field;
  catalogue rows live in delta migrations (latest matrix `V290`), and the
  memory rule "live plan catalog ≠ migrations" applies: re-read the live rows
  before assuming any tier. UI gate component `components/upgrade-gate.tsx`.
- Fixtures tab row: `components/v2/stages-panel.tsx:1580-1600` `FixtureRow`,
  actions inline (score link `:1739`, schedule-edit toggle `:1748`).
- Chrome-less precedents: `app/embed/layout.tsx` (white background, height
  postMessage script, not transparent), `app/slideshow/layout.tsx` (full
  bleed). Neither is reused; the overlay gets its own layout.
- CSP: `proxy.ts:49` `frame-src` unchanged by this work (no iframe is added).
- i18n: `apps/web/src/dictionaries/{en,es,fr,nl}/`, regenerate with
  `pnpm i18n:gen-keys`; `lib/i18n-keys.ts` is generated.

## Architecture

### 1. Overlay route

`apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx` with a sibling
`layout.tsx`. Query: `style=bar|bug` (default per sport, decision 1),
`lang=<locale>` (default: the org's locale as the public page resolves it).

- Layout: `<html>` and `<body>` with `background: transparent`, no header, no
  footer, no attribution script, `<meta name="robots" content="noindex">`.
  Mounts Barlow Condensed and Geist the way the public layout does.
- Page (server component): resolves the fixture with the same call the public
  fixture page uses (`getPublicFixture`, `server/public-site/data.ts`), so
  visibility rules hold; resolves the fixture's org entitlement
  `streaming.overlay` through the resolver in `lib/entitlements.ts`; either
  failing → `notFound()`. Passes `initial: LiveFixtureData`, `sportKey`,
  entrant display names (already public on the match page), `realtime`
  eligibility and the resolved style to the client stage.
- Stage (client): `useLiveFixture(fixtureId, initial, realtime)` is the
  subscribe-or-poll logic lifted out of `LiveScore` into
  `components/public-site/use-live-fixture.ts`; `LiveScore` is repointed to
  the hook in the same change so there is one transport. The stage renders
  `<OverlayBar>` or `<OverlayBug>` from `overlayModel(...)`.
- Canvas: the overlay is authored at 1920×1080 and scaled to the viewport with
  `transform: scale(min(vw/1920, vh/1080))` from the top-left, so OBS at 1080p
  renders 1:1 and the console preview at 320 px wide renders the same
  component, not a picture.

### 2. Projection (pure)

`apps/web/src/lib/overlay-model.ts`:

```
overlayModel(input: {
  sportKey: string; data: LiveFixtureData; sides: [{ id, name, short }, { id, name, short }];
  msg: MsgFn;
}): OverlayModel

OverlayModel {
  live: boolean; decided: boolean;
  header: { context: string; clock?: string };          // "T20, 2nd innings" | "2nd half" | "Set 3"
  sides: [{ short: string; name: string; big: string; sub?: string; led: boolean; serving: boolean }, ...];
  cells: { key: string; value: string }[];              // sets / games / periods, in order
  detail: string[];                                     // bar's second band; [] in step one for cricket
  chase?: string;                                       // "Need 45 off 45"
  result?: string;                                      // decided line
}
```

`led` marks the side in play (batting side, serving side, or nothing when the
sport has no such notion). `short` is the entrant's short name where the
model has one, else the first three letters of the name upper-cased; the
plan pins the entrant short-name field or records that none exists.

Every string comes from the dictionary through `msg`; cricket notation
(CRR, RRR, overs) stays as notation with localised `title`. No string is
typed into the component.

### 3. Theme

The overlay root receives `sportThemeStyle(sportKey)` exactly as the pad root
does, so a skin with no override (cricket) inherits the product defaults and
the eleven palettes stay one authority. The overlay's own classes read
`var(--sport-board)`, `--sport-board-2`, `--sport-ink`, `--sport-led`,
`--sport-caution`, `--sport-dismissal`; it does not reuse `.pad-*` classes.
Type: Barlow Condensed for names and numerals, Geist for labels; tabular
numerals everywhere a value can change width.

### 4. Data

Migration `db/migration/deltas/V392__fixture_stream_url.sql` (V392 is the
next free number on `main` today; numbering is flat across directories and
other branches are adding migrations, so the implementer takes the next free
number at rebase time and records it in the plan):
`alter table fixtures add column stream_url text null` with
`check (stream_url is null or stream_url like 'https://%')`, and the public
fixtures view (`public_fixtures_v`, the plan pins its defining migration)
gains the column so the public page can read it.

Validation lives in one zod schema `streamUrlSchema` (`lib/stream-url.ts`):
`new URL()` must parse, protocol `https:`, hostname exactly one of
`www.youtube.com`, `youtube.com`, `youtu.be`, `www.facebook.com`,
`facebook.com`, `fb.watch`, `www.twitch.tv`, `twitch.tv`, `kick.com`,
`www.kick.com`. Exact hostname comparison, never a prefix or substring test
(memory: prefix check is not origin validation). Empty string clears the link.

Write path: `PUT /api/v1/fixtures/[id]/stream` (organiser or admin of the
fixture's org, same role gate the schedule-edit uses; the plan pins the
helper), body `{ streamUrl: string | null }`, invalidates the public page
tags through the existing `broadcastRevalidate`. The route is added to the
OpenAPI document in the same change; CI's drift check (a `ci.yml` step)
fails otherwise.

### 5. Entitlement

Delta migration adds catalogue rows for `streaming.overlay`, `false` on every
plan, plus the feature's label in the catalogue table the pricing surfaces
read (the plan confirms whether a false-everywhere key needs copy; if the
pricing page enumerates keys, the row must not surface there while hidden).
The test org is enabled by an `org_entitlement_overrides` row, which the
resolver already ranks first. Both the overlay route and the panel read the
same resolved feature; neither hardcodes a plan.

### 6. Organiser panel

`apps/web/src/components/v2/fixture-stream-panel.tsx` (client), mounted from
`FixtureRow` behind an inline "Stream" toggle beside the schedule-edit
toggle, rendered only when the server passes `streamingEntitled: true`.
Content, per the "Organiser console" artboards:

- Style tabs "Broadcast bar" / "Corner bug" (default per sport), with a live
  preview that is the overlay component itself at reduced scale on the
  fixture's own current data.
- Overlay link (read-only, copy button), built from the fixture id and the
  selected style.
- Three numbered steps (it is a sequence): add a Browser source in OBS with
  the link at 1920×1080; drag it above the camera, background is
  transparent; start streaming and paste the stream link below.
- Stream link input plus "Save link"; inline validation error from
  `streamUrlSchema`; success state "Saved" in the button, not a toast.
- Phone first: at 320 the tabs, inputs and buttons are full width at 44 px;
  at ≥768 the copy button sits inside the link field. Control set identical
  at 320 and 1280.

### 7. Public match page

When `stream_url` is set: a "Watch live" link while the fixture is in play or
scheduled, "Replay" once decided or finalized, `target="_blank"
rel="noopener"`. Placed under the headline block on the current page; when
spectator W1 lands its court header, the link moves into that header's
action row (W1 owns the composition; this spec owns the link's existence).

### 8. Sequencing with in-flight programmes

- `stages-panel.tsx` is being edited by competition desk W1. The panel mount
  is kept to a single import and a single conditional line inside
  `FixtureRow`; PR1 rebases after desk W1 merges rather than racing it.
- Spectator W1 owns the public match page composition and the per-event
  template model. Step two of this spec keys off both; step one touches the
  public page only for the link.

## Data flow

```
scorer pad ─► ledger ─► existing state_changed ping ─► overlay page refetch ─► overlayModel ─► bar | bug
                                                        (poll every 15 s when not entitled to realtime)
organiser panel ─► PUT /fixtures/[id]/stream ─► fixtures.stream_url ─► public match page "Watch live"
OBS ─► renders overlay page as a browser source over the camera ─► YouTube / Facebook / Twitch
```

Latency: OBS composites the overlay at the instant the ledger changes, so the
score and the picture leave the laptop together. There is no spoiler problem
in this design; that problem belongs to Option 2 and is documented there.

## Error and empty states

- Fixture missing or not visible: 404 (same as the public page).
- Org not entitled: 404, deliberately indistinguishable from missing.
- Scheduled, not started: header shows the localised start time in the venue
  zone, sides show their names with "—" as `big`, no live dot.
- Decided or finalized: `result` line replaces `chase`, live dot off, the
  winning side keeps `led`.
- Realtime unavailable: polling; the overlay shows nothing that ticks.
- Sport with no detail declarations (board game, carrom, generic): `detail`
  and `cells` are empty and the bar renders its main band only; this is a
  designed state, not an error.
- Malformed stream link: inline validation message, nothing saved.

## Step two — moments (after spectator W1)

Interface fixed now so step one's components leave room for it:

```
OverlayMoment { kind: string; headline: string; line?: string; tone: "led" | "caution" | "dismissal" }
```

Source: the per-event-type template set W1 derives from each module's event
schemas, filtered by a per-sport allowlist of moment-worthy types (cricket
boundary four and six, wicket; football goal and card; hockey and ice hockey
goal and card; racket sports ace where the module records it, break point,
set point, match point, set won; volleyball set won). The overlay needs the
public payload to carry the last few events with their type and sequence
number (W1's model), diffs the sequence to fire once per event, shows a slab
in the sport's LED colour (dismissal red for wickets, caution yellow for
cards) attached to the bug or under the bar, holds four seconds, queues if
another arrives. Player names on moments pass through the public-site
consent resolver, as W1's Summary tab does. Board game, carrom and generic
have no allowlist entries and render no moments, by construction.

## Copy and i18n

Every visible string in the overlay and the panel comes from the dictionaries
in all four locales, `public.*` for the overlay and `ui.*` for the panel,
with `pnpm i18n:gen-keys` regenerated. Sentence case, plain verbs
("Save link", "Copy"). Sport notation stays notation.

## Security and privacy

- The overlay is public and unauthenticated by design; it exposes nothing the
  public match page does not already show.
- Stream links: exact-host allowlist, https only, stored as text, rendered
  only as an `<a href>` with `rel="noopener"`; never in an iframe here.
- `noindex` on overlay pages. CSP unchanged. No cookies read or set.
- Entitlement checks run server-side on every overlay render and every
  panel render; the client never decides.

## Tests (all four kinds, stated here so the plan cannot drop one)

- **Unit.** `overlayModel` per sport from real engine summaries (fold a short
  ledger through the real module, not a typed table), including the empty
  states and the `led`/`serving` truth table; `streamUrlSchema` positive and
  negative cases including `https://evil.example/www.youtube.com`,
  `https://www.youtube.com.evil.example/`, `javascript:`, `http://`;
  `useLiveFixture` subscribe-or-poll branches. Mutation checks recorded in the
  plan: delete the hostname comparison, delete the entitlement call, swap
  `led` to the other side; each must go red.
- **E2E.** Seed a short match through the API (cricket: `cricket.toss` before
  `core.start`), open the overlay, assert the body is transparent and the
  score is the seeded score; post one more event and assert the overlay
  changed without navigation; assert 404 with the override row absent and 200
  with it present (both directions). Console: open the expander at 320, 768
  and 1280, control-set diff between 320 and 1280, save a valid link and an
  invalid one, and confirm the public page shows "Watch live". Runs from a
  project that actually executes (e2e runs on push to `main` only; use
  `workflow_dispatch` with the `pr` input before merge).
- **Smoke.** Overlay route 200 for an entitled seeded fixture and 404 for a
  non-entitled one; `PUT /stream` accepts a valid link.
- **Regression.** `LiveScore` repointed to the hook keeps its existing tests
  green and its behaviour identical (poll interval, debounce, decided
  templates); the seven-width `mobile.spec.ts` projects on the fixtures tab
  stay green with the new toggle folded in.
- Visual gate: screenshots of bar and bug for cricket, football, tennis and
  volleyball at 1920×1080, and the panel at 320, 768 and 1280, attached to
  the PR; the images must exist and differ per sport.

## Waves, PRs, gates

- **PR1 (step one):** hook extraction, overlay route and layout, projection,
  theme, migration V392 and view, `PUT /stream`, entitlement key and override
  for the test org, panel, public-page link, dictionaries, all four test
  kinds, visual gate. Lands after desk W1 merges (rebase).
- **PR2 (step two):** moments and the cricket batter line, after spectator W1
  merges. Own plan, keyed on W1's shipped model.
- Gates per PR: reviewer pass on the branch before merge (never skip the
  review loop), JSON-reporter vitest counts pasted back, `rtk proxy` lint,
  smoke on the PR, e2e via `workflow_dispatch pr=<n>` before merge, visual
  sign-off per screen by the owner.

## Out of scope

Server-side video, phone-only streaming with a burned-in score, embedding the
stream on the seazn match page, a pricing decision, a standings or fixtures
ticker for OBS, sponsor logos on the overlay, multi-language switching inside
one stream.

## False-premise watch list (re-pin against the tree before building on any)

1. That `getPublicFixture` returns the sport key and entrant names in one
   call; if not, the overlay page composes the same two calls the public page
   does.
2. That `setBreakdown` and siblings live in an importable module rather than
   inside `live-score.tsx`; if inside, move them to
   `components/public-site/live-derive.ts` in the same change.
3. That `public_fixtures_v` is the view the public fixture endpoint selects
   from (`server/usecases/public.ts` `publicFixture()`), so adding
   `stream_url` there is sufficient.
4. That an `org_entitlement_overrides` row can be written for the test org
   by an existing admin path or SQL; if only SQL, the e2e seeds it by SQL
   and thaws it in `afterAll`.
5. That the fixture row's role gate for schedule edit is reusable for
   `PUT /stream`; if it is inline, extract it once.
6. That entrants carry a short name; if not, the three-letter fallback stands
   and the panel copy says so.
7. That mounting `next/font` Barlow Condensed on a second layout does not
   double-load on the public tree (two layouts, two mounts, no shared root).
8. That the eleven `V3_SKINS` keys are the complete set of `sportKey` values
   a fixture can carry today.
