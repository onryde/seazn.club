# Sponsors on stream, the Sponsors hub and the sponsor report: MVP design

Status: **written 2026-10-27 from the owner-approved brainstorm (R4, MVP cut).** Not yet planned.
Repos: web `seazn.club` (most of it) and `seazn.club.compositor` (proof-of-play forwarding, frame grab).
Companion spec: `2026-10-27-operator-console-design.md` (the live controls that sit on top of this).
Captured scenario this fulfils: `2026-09-05-stream-overlay-prompts/_SCENARIO-2026-09-29-sponsor-moments.md`.

## 0. Owner decisions (2026-10-27, brainstorm in the visual companion)

| # | Question | Owner answer |
|---|---|---|
| D1 | What is the value? | "org can choose the sponsor to be played on stream and mostly if we can get the analytics on that then it will be good" — the **report is the product**, the card is how it is earned. |
| D2 | Where does Sponsors live? | "Better to move out the Sponsor tab from the setting and redesign along with that" → **A: top-level Sponsors with tabs** (Overview · Sponsors · On stream · Packages and orders), opens on Overview. |
| D3 | How does a club choose what plays? | **C: rotation by default, a deal only where one was sold.** Tick sponsors into the rotation, one Light / Normal / Busy dial; "Add a deal" on one sponsor for a specific placement (e.g. football half-time, full banner, 20 s). |
| D4 | How does the sponsor get the numbers? | Recommended and accepted: **a shareable link (no login) + a PDF of the same page + an optional monthly email.** |
| D5 | Report contents | Accepted the mock (`overview-report.html`): times shown, time on screen, live viewers when shown, link clicks, a frame from the broadcast per showing with "watch this moment". |
| D6 | Sponsor playback | Accepted: "watch this moment" opens the YouTube VOD at the showing. |
| D7 | Scope | "I need a working MVP" → this cut. Mocks are **layout only**; the build uses the house theme (standing rule). |

Standing rules that bind this spec: the sponsor-moments scenario's seven extensibility requirements (§2 below
carries each one), 4 locales for every string, mobile-first at 320 / 768 / 1280 with no horizontal scroll,
TEST-STRATEGY.md (anti-vacuity, derive expectations from declarations, mutate each guard once), frontend-design skill
in every UI dispatch, show 2+ UI options for any screen not already mocked.

## 1. What exists today (re-pinned on origin/main a8f27bb7cf — re-pin again before building)

- `sponsors` (V283): `org_id, competition_id?, name, url?, logo_path?, tier ∈ title|gold|silver|partner,
  display_order, status ∈ active|pending|inactive, click_count`. **Four tiers** — the mocks' "Gold / Partner /
  Supporter" are illustrative; the build uses the real four.
- `GET /s/[sponsorId]` (`app/s/[sponsorId]/route.ts`): 302 to the sponsor URL, defers `click_count + 1`. **No
  source and no fixture is recorded**, so "clicks from the stream" cannot be told apart today.
- `resolveSponsors(orgId, competitionId?)` (`usecases/sponsors.ts:307`): competition rows first, then org-wide,
  ordered tier → display_order. Pro `sponsors.tiers` collapses every row to `partner` when absent.
- Settings → Sponsors tab (`app/o/[orgSlug]/settings/page.tsx:161-177`) mounts `OrgSponsors` and `SponsorPackages`
  (Pro `sponsors.monetize`, Stripe orders).
- Overlay moments: `lib/overlay-moments.ts` derives moments from score events (`MOMENT_RULES`, keyed by event type
  plus `derived.setWon` / `derived.pointState`); `components/overlay/moment-queue.ts` is a pure FIFO reducer
  (in / hold / out, `seen`, `sync` on undo, `discard` / `flush` for Final). **No priority exists** — every moment
  waits its turn.
- Templates: `components/overlay/template-registry.ts` (`bar`, `bug`; `slabPlacement`, `sceneCardSafeArea`).
- Compositor → web: the page's `console.info` signals (`seazn:ready`, `seazn:alive`, `lib/overlay-compositor.ts`)
  read by the compositor from CEF's console (`crates/adapters/src/cef_graphics.rs`); the heartbeat
  (`RelayHeartbeat`, `api-v1/schemas.ts:2018`, **`.strict()`**, published in `docs/contracts/relay-job.v1.json`).
- Storage: `lib/supabase-storage.ts` (sponsor logos already use it). PDF: `pdfkit` via `server/doc-render.ts`.
  Email: the outbox (`server/email-outbox/`).

**Premises the code proved false (recorded, not blockers):**

1. *"Triggers come from the engine's declarations"* — **the engine declares no breaks.** `packages/engine/src/sport/module.ts`
   has no break, interval or changeover vocabulary. Break-like facts exist only implicitly (cricket over close in
   `overlay-cricket.ts`, `football.period`, `*.timeout`, `derived.setWon`). §3.1 adds the declaration.
2. *"Viewer counts fall back to match-page views"* (mock caption) — **no page-view counter exists** anywhere in web.
   Without YouTube Connect the viewers column shows a dash and a "Connect YouTube" hint (§5.3); no fallback number.
3. *A 4th top-bar link fits* — `components/nav.tsx` (#516) measured **4 icons overflowing below ~340 px**. 320 is in
   the matrix, so the Sponsors link needs the treatment in §6.1.

## 2. Extensibility requirements → where each lands

| Scenario requirement | This design |
|---|---|
| 1. A sponsor card is a moment kind in the same queue | `OverlayMoment` gains `graphic: "sponsor"`; same `moment-queue.ts`, with a priority rule (§3.4). No second pipeline. |
| 2. Triggers from engine declarations | `SportModule.breaks` (§3.1). The overlay has no per-sport table. |
| 3. Rules are data | Rotation settings and deals are rows (§4); new fields additive. |
| 4. Content is a provider seam, scope org → competition (→ division → fixture later) | `SponsorCardSource` interface (§3.3), one implementation (the `sponsors` table). MVP scopes org and competition; division / fixture are additive columns later. |
| 5. Placement uses slots that templates declare | `OverlayTemplateDef.sponsorSlots` (§3.5). |
| 6. Proof of display is a log | `sponsor_airings` (§4), fed by the compositor (§3.6). |
| 7. Composed and OBS render the same moment stream | Plan derived **server-side** in the overlay data (§3.2), identical for both hosts. |

## 3. Design

### 3.1 Engine: declared breaks

Each sport module may declare its natural breaks. Optional member on `SportModule`:

```ts
interface BreakDecl {
  kind: string;            // stable id, e.g. "over_end", "innings_break", "half_time", "set_end", "changeover", "timeout", "after_goal", "period_end"
  size: "minor" | "major"; // minor = short pause (≤ ~60 s), major = interval (innings break, half-time, set end, intermission)
}
breaks?: {
  kinds: readonly BreakDecl[];
  /** Pure: the breaks this event OPENS, given the state before and after it. [] for most events. */
  breaksAt(ev: ScoreEvent, before: State, after: State): readonly string[];
};
```

- MVP declares breaks for every sport that has them; the list below is a starting point the builder **verifies
  against each sport's own events and laws**, not a table to copy:
  cricket `over_end` (minor), `innings_break` (major) · football `half_time`, `period_end` (major), `after_goal` (minor) ·
  hockey `quarter_end`/`half_time` (major), `after_goal` (minor) · ice hockey `period_end` (major), `after_goal` (minor) ·
  tennis `changeover` (minor, odd-game rule incl. tie-break), `set_end` (major) · badminton `interval` (minor, at 11),
  `game_end` (major) · table tennis `game_end` (major), `timeout` (minor) · volleyball `timeout` (minor), `set_end` (major).
  Board games, carrom, generic: none (they get sponsors through scenes and the operator, §3.4 and the console spec).
- Lives in each sport's own file (no value import from `competition/` — the engine-boundary trap).
- Tests: every declared kind is reachable by at least one real event sequence (a sweep over the registry that reports
  its count; 0 = fail); `breaksAt` returns `[]` on an undo-restored state; a set-winning tennis point opens `set_end`
  and NOT `changeover` twice.

### 3.2 The plan: server-side, in the overlay data

`loadOverlayLiveData` (`server/overlay/load.ts`) adds one field, `sponsorPlan`, computed by a **pure** planner in
`lib/sponsor-plan.ts`:

```ts
sponsorPlan: {
  cards: { id: string; sponsorId: string; name: string; logoUrl: string | null; tier: SponsorTier }[];
  airings: { momentId: string; seq: number; cardId: string; style: "lower_third" | "banner"; holdMs: number;
             source: "rotation" | "deal"; breakKind: string }[];   // for breaks inside the `recent` window only
} | null   // null: rotation off for this fixture, or no sponsor in it
```

Planner inputs: the fixture's break sequence (from `derived.breaks` on each recent event, computed with the engine's
`breaksAt`), the rotation settings, the deals, and the resolved sponsor list for the fixture's competition.

- **Deterministic.** Same events + same settings ⇒ same plan, so OBS and the composed page show the same card at the
  same break, and a re-poll never reshuffles (moment ids are `${seq}:sponsor.${breakKind}`).
- **Eligible breaks by the dial** (sport-agnostic; the engine supplies only `size`):
  Light = every major break; Normal = every major + every 3rd minor; Busy = every major + every minor.
  A global **cooldown of 90 s** between sponsor cards (on the events' timestamps) thins any sport whose minor breaks
  come fast (cricket overs in a short format).
- **Deals first.** A break matching a deal's `(sport, breakKind, competition?)` goes to that deal's sponsor, with the
  deal's style and duration, even if the dial would skip it. Two deals on one break: older deal wins (deterministic).
- **Rotation otherwise:** weighted round robin over the ticked sponsors by tier weight **title 3 · gold 2 · silver 1 ·
  partner 1** (owner to confirm, §8), position in the cycle = count of rotation airings planned before this break, so
  it is stable.
- **Style by break size** (MVP): minor → lower third, 8 s; major → banner, 15 s. A deal sets style and 5–30 s.
- Gating and cost: the plan is computed for every fixture with rotation on; it costs one indexed read per poll. Cache
  with the rest of the live answer (2 s edge window, relay path `no-store` as today).

### 3.3 Content seam

```ts
interface SponsorCardSource {
  cardsFor(orgId: string, fixture: { competitionId: string | null }): Promise<SponsorCard[]>;
}
```

MVP implementation reads `sponsors` (active, `on_stream = true`, via `resolveSponsors` ordering). A future network
provider is another implementation. Division and fixture scope are later columns; the most specific scope wins.

### 3.4 The page: priority, scenes, cut-short

`overlay-moments.ts` turns `sponsorPlan.airings` into moments with `graphic: "sponsor"` and the per-item `holdMs`.
`moment-queue.ts` gains **one rule**: a moment carries `priority: "score" | "sponsor"`.

- A score moment enqueued while a sponsor card is queued jumps ahead of it.
- A score moment enqueued while a sponsor card is **on air** sends that card straight to `out` (it folds away); the
  airing is recorded as `cut_short`. "Never covering a score change" is this rule, and it is a guard with a test.
- A sponsor moment that has waited **> 20 s** in the queue is dropped (its break has passed) and marked seen.
- Final scene: sponsor moments are discarded like every other moment (existing `discard`).
- Starting soon / Reconnecting scenes (compositor-driven) and the operator scenes (console spec): the scene card shows
  a **sponsor carousel** — rotation sponsors, title and gold first, 10 s each, logged as `source = "scene"`.
- Reduced motion keeps the queue's existing `foldMs = 0` path (the `revision` counter already guards it).

### 3.5 Slots

`OverlayTemplateDef` gains `sponsorSlots: { lower_third: CanvasBox; banner: CanvasBox }`, both clear of the scorebug.
`bar` and `bug` declare both. The gallery (`/admin/overlay-gallery`, 1280 only) enumerates template × sport × slot;
the readability sweep (30 px floor at 1080, bar bottom ≥ 150 px) extends to sponsor cards and reports its count.
A test asserts every slot box is disjoint from the template's scorebug box, for every registry entry.

### 3.6 Proof of play (the report's source of truth)

Counted from **composed streams only** in the MVP (§8 asks whether OBS counts):

1. At `host=compositor`, when a sponsor moment enters `hold`, the page logs
   `seazn:sponsor:start {"momentId","cardId","style","source","breakKind","at"}`; when it leaves `out`,
   `seazn:sponsor:end {"momentId","at","cutShort"}` (same channel as `seazn:ready`).
2. **Compositor:** the console reader validates both lines (bounded JSON, ≤ 512 bytes, known keys), buffers them
   (≤ 64; overflow drops oldest and counts `airingsDropped`), and sends them on the next heartbeat as
   `airings: [...]` (additive field, contract bump in `relay-job.v1.json`, vendored to web). Removed from the buffer
   only on a 2xx reply. The final beat flushes them.
3. **Frame grab (compositor):** on a `start` line, 1.5 s later (card fully in), grab one programme frame, JPEG
   640×360 q≈75, off the streaming thread, at most one per 20 s; `POST /api/internal/relay/sessions/[sid]/airings/[momentId]/frame`
   with the session token. Failure logs once and is dropped — it never blocks or slows the pipeline. CPU cost is
   measured on stg (the soak shape) before merge; a measurable p95 rise goes to the owner.
4. **Web:** `heartbeat` upserts `sponsor_airings` on `(session_id, moment_id)` — `start` inserts, `end` sets
   `ended_at` / `cut_short`. Times more than 10 min from server time are refused. An airing with no `end` by session
   end is closed at the last beat's time and flagged `ended_estimated`.
5. **Viewers:** on `start`, if the fixture's broadcast came from YouTube Connect (r2-youtube's table), read
   `videos.list?part=liveStreamingDetails` → `concurrentViewers` once (1 quota unit) and store it on the airing. No
   connection, hidden count, or error ⇒ `viewers = null`. Never retried in a loop.

### 3.7 Click attribution

`/s/[sponsorId]` accepts `?f=<fixtureId>&src=<match|youtube|site>` (validated: fixture must belong to the sponsor's
org, `src` an enum, else recorded as `unknown`). It still bumps `click_count`, and also inserts a `sponsor_clicks` row
(deferred, as today). Links that carry the tag: the public match page's sponsor strip (`src=match`) and the YouTube
description r2-youtube writes (`src=youtube`, coordination item §9). Other surfaces stay `site`.

## 4. Data model *(names are the builder's; facts and constraints are not)*

- `sponsors.on_stream boolean not null default false` — in the rotation.
- `sponsor_stream_settings (org_id, competition_id null, enabled, frequency ∈ light|normal|busy)`, unique per
  `(org_id, competition_id)`; competition row overrides org row. RLS org-scoped like V283.
- `sponsor_stream_deals (id, org_id, sponsor_id → cascade, sport_key null = any, break_kind, competition_id null,
  style ∈ lower_third|banner, duration_s 5..30, created_at)`. `break_kind` must be one the sport declares (checked
  in the usecase against `SportModule.breaks`, not a DB enum, so a new sport needs no migration).
- `sponsor_airings (id, org_id, sponsor_id → set null, sponsor_name snapshot, fixture_id, session_id, moment_id,
  source ∈ rotation|deal|scene|operator, break_kind null, style, started_at, ended_at null, cut_short,
  ended_estimated, viewers int null, frame_path null)`, unique `(session_id, moment_id)`; index `(org_id, sponsor_id, started_at)`.
  The name snapshot keeps a report readable after a sponsor is deleted.
- `sponsor_clicks (id, org_id, sponsor_id → cascade, fixture_id null, source, at)`; index `(sponsor_id, at)`.
- `sponsor_report_links (id, org_id, sponsor_id, competition_id null, from_date, to_date, token_hash, created_by,
  created_at, revoked_at null, monthly_email_to null)`. Token: 32 random bytes, stored hashed, shown once in the UI
  as a URL. Revoke = set `revoked_at`.
- Migration: next free `V` at build time (V477 is the latest on main today). Greenfield stance: no backfill of
  airings; existing sponsors start with `on_stream = false`.

## 5. Screens

### 5.1 Sponsors hub (`/o/[orgSlug]/sponsors?tab=…`) — owner chose A

- **Overview** (default): period picker (this year / last 30 days / a competition), table per sponsor: times shown,
  on screen (sum of `ended_at − started_at`), viewer impressions (sum of `viewers`, dash when none), link clicks
  (`sponsor_clicks` in period), "Share report". Phone: one card per sponsor (mock `overview-report.html`).
- **Sponsors:** today's `OrgSponsors` list and form, moved, unchanged in behaviour.
- **On stream:** owner's option C — rotation checklist (tier shown), the dial, "Where" shows the style rule as text in
  the MVP (minor → lower third, major → banner), competition scope picker, per-sponsor "Add a deal"
  (sport, break offered by that sport, style, seconds, competition), and a **preview strip** per sport the org plays:
  a sample match with the planner's output drawn on it (the same pure planner, sample events).
- **Packages and orders:** today's `SponsorPackages`, moved.
- Settings keeps no Sponsors tab; `settings?tab=sponsors` redirects to `sponsors?tab=sponsors` (old links and emails).
- Role: same as today's Settings → Sponsors (editors). Read the existing guard; do not invent a new one.

### 5.2 Report page (`/r/sponsor/[token]`, no login)

Sponsor-branded (their logo and name lead, Seazn recedes — mock), period and competition in the header, three big
numbers (on screen · viewer impressions · visits from the stream), then the showings as a grid: frame (or a neutral
placeholder when none), match, break, "watch this moment" when a YouTube VOD exists
(`https://youtu.be/<videoId>?t=<max(0, started_at − actualStartTime − 3 s)>`). Footnote states what is counted
("composed streams", "viewer numbers from YouTube"). `noindex`, rate-limited like other public reads, 404 on a revoked
or unknown token (opaque). Mobile bar applies. **Download PDF** renders the same data through `doc-render.ts` (pdfkit),
frames embedded at thumbnail size.

### 5.3 Monthly email (optional, per link)

Owner of the link may set an address; on the 1st of each month a cron step enqueues one outbox email per link with
an address: three numbers for the previous month + the link. New outbox kind, 4 locales (org's locale). No email ever
sends a token for a revoked link.

## 6. Constraints the builder must meet

### 6.1 The top bar at 320

`nav.tsx` holds Dashboard / Directory / Settings (+ Player home for dual-role). A 4th icon overflows below ~340 px
(#516 measurement). **Recommendation:** the Sponsors link is `hidden min-[350px]:flex` (the Player-home precedent) and
the org Dashboard carries a Sponsors entry visible at every width; at ≥ 350 the dual-role case (5 links) is measured
again and, if it overflows, Player home folds first. Proven by the seven-width `mobile.spec.ts` scan.

### 6.2 YouTube paid promotion

When rotation is on for a fixture with a Connect broadcast, the broadcast must declare paid product placement.
**Unverified:** whether the Data API exposes it (`videos.paidProductPlacementDetails`). If it does, r2-youtube sets
it; if not, the On stream tab shows a one-line reminder with a link to the channel setting.

## 7. Testing (all four types per task; TEST-STRATEGY.md)

- **Planner (unit, pure):** derive expectations from `SportModule.breaks` declarations, never a typed table. Cases:
  each dial level per sport (counts reported, 0 = fail); cooldown; deal beats rotation and beats the dial; two deals,
  older wins; tier weights over 30 breaks (title 3 : gold 2 : partner 1 within one cycle); plan stable across a
  re-poll; an undone event removes its airing; a different sport; a sponsor removed mid-match.
- **Queue (unit):** score moment pre-empts a queued sponsor; cuts an on-air one to `out` with `cutShort`; stale
  sponsor dropped at 20 s; Final discards; reduced motion. Mutate the pre-empt guard once — a test must die.
- **Seam, driven end to end (house failure class 1):** fold the planner's real output through the real page into a
  real heartbeat body, through the real `heartbeat` usecase, and read the `sponsor_airings` row back. A fixture on both
  ends proves nothing.
- **Compositor (cargo):** line parser (bad JSON, oversize, unknown key refused); buffer bound and drop count; removal
  only on 2xx; final-beat flush; frame grab rate limit; a failed upload never stalls the pipeline (pipeline test with
  a failing sink).
- **E2E (CI dispatch):** Sponsors hub at 320 / 768 / 1280 no horizontal scroll; deal editor offers only the sport's
  declared breaks; report link opens without login and 404s after revoke; overlay at `host=obs` shows a sponsor
  lower third after a cricket over (cooldown honoured).
- **Smoke:** report page renders a seeded airing; `/s/[id]?f=&src=` records a click row and still redirects.
- **Security:** cross-org — org B cannot read A's airings, deals, links, or record a click against A's fixture; report
  token is hashed at rest and never logged; frame endpoint refuses a token for another session.
- **Live check (stg, by the owner or with the owner):** one composed match, read the airing rows and frames back.

## 8. Open for the owner

1. **Plan gating.** Recommendation: rotation and the report on every plan that can buy composed-stream credits
   (the credits are the paywall); deals inside Pro `sponsors.tiers`. Your call.
2. **Tier weights** title 3 · gold 2 · silver 1 · partner 1 — confirm or change.
3. **OBS streams in the report.** Recommendation: not counted in the MVP (an OBS page is public, its beacon forgeable);
   the report says "composed streams". Count them later behind a signed overlay URL.
4. **Viewer number wording.** "Viewer impressions" (live viewers at each showing, added up) is honest; "people
   watching" (the mock) overstates — a viewer who saw five cards counts five times. Recommendation: impressions,
   with peak live viewers beside it.
5. **Default dial** for a club that has just ticked its first sponsor: recommendation Normal.

## 9. Coordination

- **r2-youtube:** the broadcast table and `videoId` / `actualStartTime` (§3.6, §5.2), sponsor links with
  `src=youtube` in the description (§3.7), paid-placement flag (§6.2).
- **Compositor:** heartbeat contract bump (`airings`, `airingsDropped`) and the frame endpoint; vendored contract
  updated in the same pair of PRs.
- **Operator console spec:** shares `sponsor_airings` (`source = "operator"`) and the scene carousel.

## 10. Out of scope (MVP)

Division / fixture sponsor scope; corner-badge slot; sponsor self-serve uploads or a sponsor network; QR codes on
cards; video ad breaks; per-sponsor caps or guaranteed minutes; OBS proof of play; CF-recording playback without
YouTube; HLS fallback (owner: no need).
