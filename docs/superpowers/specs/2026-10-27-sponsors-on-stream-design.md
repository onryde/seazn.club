# Sponsors on stream, the Sponsors hub and the sponsor report: MVP design

Status: **written 2026-10-27 from the owner-approved brainstorm, cut to the owner-approved MVP ("yes").** Not yet planned.
Repos: web `seazn.club` (most of it) and `seazn.club.compositor` (proof-of-play forwarding, frame grab).
Companion spec: `2026-10-27-operator-console-design.md` (the live controls that sit on top of this).
Captured scenario this fulfils: `2026-09-05-stream-overlay-prompts/_SCENARIO-2026-09-29-sponsor-moments.md`.

## 0. Owner decisions (2026-10-27, brainstorm in the visual companion)

| # | Question | Owner answer |
|---|---|---|
| D1 | What is the value? | "org can choose the sponsor to be played on stream and mostly if we can get the analytics on that then it will be good" — the **report is the product**, the card is how it is earned. |
| D2 | Where does Sponsors live? | "Better to move out the Sponsor tab from the setting and redesign along with that" → **A: top-level Sponsors with tabs** (Overview · Sponsors · On stream · Packages and orders), opens on Overview. |
| D3 | How does a club choose what plays? | **C: rotation by default, a per-sponsor deal where one was sold.** The MVP cut ships the **rotation and the dial only**; deals are **Later** (§10), and §2 keeps them additive. |
| D4 | How does the sponsor get the numbers? | A **shareable link (no login)** in the MVP. PDF and the monthly email are **Later**. |
| D5 | Report contents | The mock (`overview-report.html`): times shown, time on screen, live viewers when shown, link clicks, a frame from the broadcast per showing with "watch this moment". |
| D6 | Sponsor playback | "Watch this moment" opens the YouTube VOD at the showing. |
| D7 | Scope | "I need a working MVP" → this cut ("yes"). Mocks are **layout only**; the build uses the house theme. |
| D8 | Gate? | **No new gate** — rotation and the report wherever streaming is (stream credits are the meter). Confirmed. |
| D9 | Tier weights | **title 3 · gold 2 · silver 1 · partner 1.** Confirmed. |
| D10 | OBS streams in the report | **Not counted in the MVP** (an OBS page is public, its beacon forgeable); the report says "composed streams". Confirmed. |
| D11 | Viewer wording | **"Viewer impressions"** (live viewers at each showing, added up) with **peak live viewers** beside it. Confirmed. |
| D12 | Default dial | **Normal** for a newly ticked sponsor. Confirmed. |
| D13 | Ship before YouTube Connect? | **No: build in parallel, release together** with YouTube Connect, so viewers and "watch this moment" are live on day one. |
| D14 | Rotation continuity | **One rotation per org across all its matches** (a per-org cursor), so on Light a T20's single innings break does not always go to the first title sponsor. |
| D15 | Match-page sponsor links | **"a": the sponsor board also shows on the public match page**, links tagged with that fixture (`src=match`), so clicks count per match. |

Pricing (standing owner rule: all scoring and all stages are free, no gate, no upsell; streaming is already metered by
stream credits): **no new gate. Rotation and the report are available wherever streaming is.** The existing Pro
`sponsors.tiers` and `sponsors.monetize` gates on the Sponsors and Packages tabs are unchanged and not extended.

Standing rules that bind this spec: the scenario's seven extensibility requirements (§2), 4 locales for every string,
mobile-first at 320 / 768 / 1280 with no horizontal scroll, TEST-STRATEGY.md (anti-vacuity, derive expectations from
declarations, mutate each guard once), frontend-design skill in every UI dispatch.

## 1. What exists today (re-pinned on origin/main a8f27bb7cf — re-pin again before building)

- `sponsors` (V283): `org_id, competition_id?, name, url?, logo_path?, tier ∈ title|gold|silver|partner,
  display_order, status ∈ active|pending|inactive, click_count`. **Four tiers**; the mocks' "Gold / Partner /
  Supporter" are illustrative.
- `GET /s/[sponsorId]` (`app/s/[sponsorId]/route.ts`): 302 to the sponsor URL, defers `click_count + 1`. No source and
  no fixture is recorded, so "clicks from the stream" cannot be told apart today.
- `resolveSponsors(orgId, competitionId?)` (`usecases/sponsors.ts:307`): competition rows first, then org-wide,
  ordered tier → display_order.
- Settings → Sponsors tab (`app/o/[orgSlug]/settings/page.tsx:161-177`) mounts `OrgSponsors` and `SponsorPackages`.
- Overlay moments: `lib/overlay-moments.ts` derives moments from score events (`MOMENT_RULES`, keyed by event type plus
  `derived.setWon` / `derived.pointState`); `components/overlay/moment-queue.ts` is a pure FIFO reducer (in / hold /
  out, `seen`, `sync` on undo, `discard` / `flush` for Final). **No priority exists.**
- Templates: `components/overlay/template-registry.ts` (`bar`, `bug`; `slabPlacement`, `sceneCardSafeArea`).
- Compositor → web: the page's `console.info` signals (`seazn:ready`, `seazn:alive`, `lib/overlay-compositor.ts`) read
  from CEF's console (`crates/adapters/src/cef_graphics.rs`); the heartbeat (`RelayHeartbeat`,
  `api-v1/schemas.ts:2018`, **`.strict()`**, published in `docs/contracts/relay-job.v1.json`).
- Storage: `lib/supabase-storage.ts` (sponsor logos use it).

**Premises the code proved false (recorded, not blockers):**

1. *"Triggers come from the engine's declarations"* — **the engine declares no breaks.** Of the **11** built-in sport
   modules (`packages/engine/src/sports/index.ts`: football, cricket, boardgame, carrom, generic, volleyball, badminton,
   tabletennis, tennis, icehockey, hockey), **0** declare a break today; `sport/module.ts` has no break vocabulary.
   §3.1 adds it.
2. *"Viewer counts fall back to match-page views"* (mock caption) — no page-view counter exists. Without YouTube
   Connect the viewers column shows a dash; the MVP builds no counter.
3. *A 4th top-bar link fits* — `components/nav.tsx` (#516) measured 4 icons overflowing below ~340 px. §6.1.

## 2. Extensibility requirements → where each lands

| Scenario requirement | This design |
|---|---|
| 1. A sponsor card is a moment kind in the same queue | `OverlayMoment` gains `graphic: "sponsor"`; same `moment-queue.ts`, plus one priority rule (§3.4). No second pipeline. |
| 2. Triggers from engine declarations | `SportModule.naturalBreaks` (§3.1). The overlay holds no per-sport table. |
| 3. Rules are data | The MVP's rule is one row per scope (§4: on/off + dial). **Deals (Later) are an additive table** of rule rows `{sponsor, sport?, breakKind, competition?, style, duration}` read by the same planner before rotation; nothing in the MVP shape has to change for them. |
| 4. Content is a provider seam, scoped org → competition | `SponsorCardSource` (§3.3), one implementation (the `sponsors` table). Division / fixture scope are additive later. |
| 5. Placement uses slots templates declare | `OverlayTemplateDef.sponsorSlots` (§3.5). |
| 6. Proof of display is a log | `sponsor_airings` (§4), fed by the compositor (§3.6). |
| 7. Composed and OBS render the same moment stream | The plan is derived **server-side** in the overlay data (§3.2), identical for both hosts, and the operator's Hide graphics, Play next and Skip reach both (§3.2). |

## 3. Design

### 3.1 Engine: declared natural breaks

Optional member on `SportModule`. Named `naturalBreaks`, because `breaks` is already a stat key (carrom
`carrom.ts:1176`) and "break" means a service break in tennis:

```ts
interface NaturalBreakDecl {
  kind: string;            // stable id, e.g. "over_end", "innings_break", "half_time", "set_end", "changeover"
  size: "minor" | "major"; // minor = short pause (≤ ~60 s); major = interval (innings break, half-time, set end, intermission)
}
naturalBreaks?: {
  kinds: readonly NaturalBreakDecl[];
  /** Pure: the breaks this event OPENS, given the state before and after it. [] for most events. */
  opensAt(ev: ScoreEvent, before: State, after: State): readonly string[];
};
```

- **The MVP makes 8 of the 11 modules declare breaks**: cricket, football, hockey, icehockey, tennis, badminton,
  tabletennis, volleyball. **3 declare none**: boardgame, carrom, generic (no natural pause the engine can see; they
  get sponsors through the scene carousel, §3.4).
- Starting kinds for the builder to **verify against each sport's own events and laws** (they are a hypothesis, not a
  table to copy into code or tests): cricket `over_end` (minor), `innings_break` (major) · football `half_time`,
  `period_end`, `shootout_break` (major), `after_goal` (minor) · hockey `quarter_end` / `half_time` /
  `shootout_break` (major), `after_goal` (minor) · ice hockey `period_end`, `shootout_break` (major), `after_goal`
  (minor) · tennis `changeover` (minor), `set_end` (major) · badminton `interval` (minor), `game_end` (major) · table
  tennis `timeout` (minor), `game_end` (major) · volleyball `timeout` (minor), `set_end` (major).
- *As built (engine 1.1.0, verified by S5 against `builtinModules`):* the list above is exactly what the eight modules
  declare (21 sport/kind pairs). `shootout_break` is ONE kind shared by football, hockey and ice hockey — the pause
  before a shoot-out, a major (PO ruling, S1/S2). S5's replay sweep over generated streams reached 17 of the 21 pairs;
  hockey's shoot-out break is pinned by a real FIH shoot-out ledger instead.
- Lives in each sport's own file (no value import from `competition/`; gate `engine:boundary`).
- Tests: a sweep over `builtinModules` asserts every declared kind is reachable by a real event sequence and reports
  its counts (modules with breaks, kinds reached; 0 = fail); `opensAt` returns `[]` on an undo-restored state; a
  set-winning tennis point opens `set_end` once and not `changeover` twice.

### 3.2 The plan: server-side, in the overlay data

`loadOverlayLiveData` (`server/overlay/load.ts`) adds `sponsorPlan`, computed by a **pure** planner
(`lib/sponsor-plan.ts`):

```ts
sponsorPlan: {
  cards: { id: string; sponsorId: string; name: string; logoUrl: string | null; tier: SponsorTier }[];
  airings: { momentId: string; seq: number; cardId: string; style: "lower_third" | "banner"; holdMs: number;
             breakKind: string }[];   // breaks inside the `recent` window only
} | null   // null: rotation off for this fixture, or no sponsor ticked
```

Inputs: the fixture's break sequence (`derived.naturalBreaks` on each recent event, from the engine's `opensAt`), the
fixture's rotation setting, the resolved ticked sponsors for its competition, the operator state (console spec), and
the fixture's **already-assigned sponsor moments**.

- **Deterministic.** Same events + same settings + same assigned set ⇒ same plan, so OBS and the composed page show the
  same card at the same break and a re-poll never reshuffles. Moment id `${seq}:sponsor.${breakKind}`.
- **Assigned cards are frozen** *(coordinator's call 2026-10-27, not an owner ruling)*. Once a sponsor moment is on air or has aired, its sponsor never
  changes. A settings change (tick / untick, the dial, tier weights) applies only to breaks not yet assigned. The
  planner reads the assigned set from a persisted assignment, written when a served plan first hands a break its card
  (keyed `(fixture_id, moment_id)`; a `sponsor_airings` row or an equivalent table, the builder's choice). A
  heartbeat-fed `sponsor_airings` row alone is not enough: it lands only after the card has played, and an OBS-only
  stream writes none. The plan is then a pure re-plan over events + current settings + assigned moments. An undone
  event still removes its not-yet-aired moment (§7).
- **Hidden graphics** *(coordinator's call 2026-10-27, not an owner ruling)*: a break that opens while the operator's Hide graphics is on does not count.
  The sponsor whose turn it was keeps its turn and the rotation does not advance. Because the moment stream is shared
  (requirement 7), Hide graphics, Play next and Skip apply on the OBS page exactly as on the composed one.
- **Eligible breaks by the dial** (sport-agnostic; the engine supplies only `size`): Light = every major; Normal =
  every major + every 3rd minor; Busy = every major + every minor. A **90 s cooldown** between sponsor cards (event
  timestamps) thins fast minor breaks (short-format cricket overs).
- **Rotation:** weighted round robin over ticked sponsors by tier weight **title 3 · gold 2 · silver 1 · partner 1**
  (D9). **One rotation per org across all its matches (D14):** the cycle position of a new break is the count of the
  org's persisted rotation assignments, across all its fixtures, at the moment this break is assigned. The assignment
  write takes a per-org lock (the session code's `lockOrg` pattern), so two fixtures streaming at once never hand out
  the same position. Already-assigned breaks are frozen (above), so a re-plan stays deterministic: it reads the
  positions it was handed rather than recounting. A sponsor unticked mid-cycle is skipped at its position. Test the
  sequence: two matches back to back continue the cycle; two concurrent fixtures get distinct positions; on Light a
  T20's single innings break goes to a different sponsor in match 2 than in match 1.
- **Style by break size:** minor → lower third, 8 s; major → banner, 15 s.
- Cost: one indexed read per poll, cached with the rest of the live answer (2 s edge window; relay path `no-store`).

### 3.3 Content seam

```ts
interface SponsorCardSource {
  cardsFor(orgId: string, fixture: { competitionId: string | null }): Promise<SponsorCard[]>;
}
```

MVP implementation reads `sponsors` (active, `on_stream = true`, `resolveSponsors` order).

### 3.4 The page: priority, scenes, cut-short

`overlay-moments.ts` turns `sponsorPlan.airings` into moments with `graphic: "sponsor"` and per-item `holdMs`.
`moment-queue.ts` gains one rule: a moment carries `priority: "score" | "sponsor"`.

- A score moment enqueued while a sponsor card is queued jumps ahead of it.
- **A score moment at the same event precedes the sponsor card** *(coordinator's call 2026-10-27, not an owner ruling)*. At a cricket over end the existing
  `endOfOver` card (`lib/overlay-moments.ts:48`, held `END_OF_OVER_HOLD_MS`) goes first; the `over_end` sponsor card
  queues after it and never covers it. The same holds for any break-opening event that also derives a score moment
  (a goal's slab before its `after_goal` card, a set-winning point's slab before `set_end`).
- A score moment enqueued while a sponsor card is **on air** sends it straight to `out`; the airing is recorded
  `cut_short`. "Never covering a score change" is this guard, with a test that kills its mutant.
- A sponsor moment waiting **> 20 s** is dropped (its break has passed) and marked seen.
- Final: discarded like every moment (existing `discard`).
- Scene layers (compositor Starting soon / Reconnecting, and the console's Break and Full time) carry a **sponsor
  carousel**: ticked sponsors, title and gold first, 10 s each, logged `source = "scene"`. This is how the three
  break-less sports reach sponsors.

### 3.5 Slots

`OverlayTemplateDef.sponsorSlots: { lower_third: CanvasBox; banner: CanvasBox }`, both clear of the scorebug; `bar`
and `bug` declare both. The staff gallery (1280 only) enumerates template × sport × slot; the readability sweep (30 px
floor at 1080, bar bottom ≥ 150 px) extends to sponsor cards and reports its count. A test asserts every slot box is
disjoint from its template's scorebug box, for every registry entry.

### 3.6 Proof of play

Counted from **composed streams only** in the MVP (D10):

1. At `host=compositor`, a sponsor moment entering `hold` logs
   `seazn:sponsor:start {"momentId","cardId","style","source","breakKind","at"}`; leaving `out` logs
   `seazn:sponsor:end {"momentId","at","cutShort"}` (same channel as `seazn:ready`).
2. **Compositor:** the console reader validates both (bounded JSON ≤ 512 bytes, known keys), buffers ≤ 64 (overflow
   drops oldest, counts `airingsDropped`), sends them on the next heartbeat as `airings: [...]` (additive; contract
   bump in `relay-job.v1.json`, vendored to web). Cleared on a 2xx reply; a 400/422 drops what the beat carried, counted
   in `airingsDropped`; a 5xx, a transport error or a 410 keeps it. The final beat flushes.
3. **Frame grab (compositor):** 1.5 s after a `start` line, grab one programme frame, JPEG 640×360 q≈75, off the
   streaming thread, ≤ 1 per 20 s; `POST /api/internal/relay/sessions/[sid]/airings/[momentId]/frame` with the session
   token. A failure logs once and is dropped; it never blocks the pipeline. CPU cost measured on stg before merge; a
   measurable p95 rise goes to the owner.
4. **Web:** `heartbeat` upserts `sponsor_airings` on `(session_id, moment_id)`. Times > 10 min from server time are
   refused. An airing with no `end` by session end closes at the last beat and is flagged `ended_estimated`.
5. **Viewers:** on `start`, if the broadcast came from YouTube Connect (r2-youtube's table), read
   `videos.list?part=liveStreamingDetails` → `concurrentViewers` once (1 quota unit). No connection, hidden count or
   error ⇒ `viewers = null` (shown as a dash). Never retried in a loop. The YouTube data kept on the airing (`viewers`,
   `video_id`) is bound by the retention rule in §6.3.

### 3.7 Click attribution

`/s/[key]` serves two shapes. A sponsor id accepts `?f=<fixtureId>&src=<match|site>` (the fixture must be in the
sponsor's org — and, for a competition-scoped sponsor, in that competition — and `src` one of the two, else `unknown`).
A short code (owner ruling R7) is its own tag: that sponsor, that fixture, `stream`; it is matched in any case.
**Stream clicks come only through `/s/<code>`** *(owner ruling R7 "a", 2026-10-31)*: a sponsor-id link claiming
`src=stream` is recorded as `unknown` (it still redirects and still counts). Each click still bumps `click_count` and
also inserts a `sponsor_clicks` row (deferred, as today), in one statement. Only a person's GET counts: a HEAD or a
link unfurler / crawler is redirected but not counted, and one IP's repeat tap on one link within 30 s counts once.
Tagged links: the competition page's board (`src=site`), the public match page's sponsor board (`src=match`) and the
short code shown on screen with the card (`stream`). **No sponsor links in the YouTube description** *(coordinator's call 2026-10-27, not an owner ruling)*: the YouTube Connect spec
(§6.5) rules the description to one line plus the match link, so clicks come through the on-screen `/s/` link and
the match page only.

## 4. Data model *(names are the builder's; facts and constraints are not)*

- `sponsors.on_stream boolean not null default false` — ticked into the rotation.
- `sponsor_stream_settings (org_id, competition_id null, enabled, frequency ∈ light|normal|busy)`, unique per
  `(org_id, competition_id)`; a competition row overrides the org row. RLS org-scoped as V283.
- `sponsor_airings (id, org_id, sponsor_id → set null, sponsor_name snapshot, fixture_id, session_id, moment_id,
  source ∈ rotation|scene|operator, break_kind null, style, started_at, ended_at null, cut_short, skipped (operator "Skip this card"), ended_estimated,
  viewers int null, video_id null, youtube_refreshed_at null, frame_path null)`, unique `(session_id, moment_id)`, index
  `(org_id, sponsor_id, started_at)`. The name snapshot keeps a report readable after a sponsor is deleted. `viewers`
  and `video_id` are YouTube API data and follow §6.3 (refreshed daily, purged on disconnect) *(coordinator's call 2026-10-27, not an owner ruling)*.
  `skipped` is set by the web from the operator log (console spec §3.4), not by the compositor. (`source` is text with a check, so a Later `deal`
  value is one check change.)
- `sponsor_clicks (id, org_id, sponsor_id → cascade, fixture_id null, source, at)`, index `(sponsor_id, at)`.
- `sponsor_report_links (id, org_id, sponsor_id, competition_id null, from_date, to_date, token_hash, created_by,
  created_at, revoked_at null)`. Token: 32 random bytes, stored hashed, shown once as a URL. Revoke sets `revoked_at`.
- Migration: next free `V` at build time (V477 is latest on main today). Greenfield: no backfill; existing sponsors
  start with `on_stream = false`.

## 5. Screens

### 5.1 Sponsors hub (`/o/[orgSlug]/sponsors?tab=…`)

- **Overview** (default): period picker (this year / last 30 days / one competition); per sponsor: times shown, on
  screen (Σ `ended_at − started_at`), viewer impressions (Σ `viewers`, dash when none), link clicks (`sponsor_clicks`
  in period), "Share report". Phone: one card per sponsor (mock).
- **Sponsors:** today's `OrgSponsors` list and form, moved, behaviour unchanged.
- **On stream:** the rotation checklist (tier shown), the Light / Normal / Busy dial, "Where" as text (short breaks →
  lower third, intervals → banner), the competition scope picker, and a **preview strip** per sport the org plays (the
  same pure planner over sample events). No "Add a deal" in the MVP.
- **Packages and orders:** today's `SponsorPackages`, moved.
- Settings drops its Sponsors tab; `settings?tab=sponsors` redirects to `sponsors?tab=sponsors`.
- Role: the existing Settings → Sponsors guard, reused.

### 5.2 Report page (`/r/sponsor/[token]`, no login)

Sponsor-branded (their logo and name lead), period and competition in the header, three numbers (on screen · viewer
impressions · visits from the stream), then the showings: frame (neutral placeholder when none), match, break, and
"watch this moment" when a YouTube VOD exists (`https://youtu.be/<videoId>?t=<max(0, started_at − actualStartTime − 3 s)>`).
The offset needs the broadcast's actual start time, which YouTube Connect does not store yet (§9); until it does, no
"watch this moment" link is shown (a link without `?t=` opens the VOD at its start, not at the moment) *(coordinator's call 2026-10-27, not an owner ruling)*.
After a YouTube purge (§6.3) the showing keeps its frame, match, break and time on screen, shows a dash for viewers
and no "watch this moment".
Footnote: "composed streams", "viewer numbers from YouTube". `noindex`, rate-limited like other public reads, opaque
404 on a revoked or unknown token. Mobile bar applies. The browser's print works; a built PDF is Later.

## 6. Constraints the builder must meet

### 6.1 The top bar at 320 *(owner ruling 2026-10-31, "a")*

`nav.tsx` holds Dashboard / Directory / Settings (+ Player home for dual-role); a 4th icon overflows below ~340 px. The
Sponsors link is `hidden min-[350px]:flex` (the Player-home precedent) and the org Dashboard carries a Sponsors entry
at every width. At ≥ 350 the dual-role 5-link case is measured; if it overflows, Player home folds first. Proven by the
seven-width `mobile.spec.ts` scan.

### 6.2 YouTube paid promotion

With rotation on for a Connect broadcast, the broadcast should declare paid product placement. **Unverified** whether
the Data API exposes it (`videos.paidProductPlacementDetails`). If it does, r2-youtube sets it; if not, the On stream
tab shows a one-line reminder linking the channel setting.

### 6.3 YouTube data retention *(coordinator's call 2026-10-27, not an owner ruling)*

YouTube's developer policies (Connect spec `2026-10-27-youtube-connect-design.md` §3, DP III.E.4, on
`feat/youtube-connect`) allow stored YouTube API data (video ids, viewer counts) for **30 days at most unless
refreshed**, and require it deleted **within 7 days** of an in-app disconnect.

- **Daily refresh job:** while the org's channel is connected, re-read the viewer count and video id for airings that
  carry them and set `youtube_refreshed_at`. *Unverified:* `liveStreamingDetails.concurrentViewers` is returned only
  while a broadcast is live, so a post-broadcast re-read may not reproduce a per-showing count; the builder verifies
  what a refresh may lawfully keep before building it, and a negative goes back to the coordinator.
- **Purge:** on a disconnect, `viewers` and `video_id` are cleared from that org's `sponsor_airings` within 7 days (the
  job's next run). A row whose `youtube_refreshed_at` is older than 30 days (a revoke on Google's side, a failed
  refresh) is purged the same way.
- **What the report keeps:** times shown, time on screen, clicks and frames are Seazn's own data and stay. Viewers show
  a dash and "watch this moment" disappears.

## 7. Testing (all four types per task; TEST-STRATEGY.md)

- **Planner (unit, pure):** expectations derived from `naturalBreaks` declarations, never a typed table. Each dial level
  × each declaring sport (counts reported, 0 = fail); cooldown; tier weights over 30 breaks; plan stable across a
  re-poll; an undone event removes its airing; a sponsor unticked mid-match; a break-less sport plans nothing.
  **Sequence (frozen assignments):** change the dial mid-match, then tick / untick and change a weight; every earlier
  assigned moment keeps its sponsor, only later breaks move. A break opened while graphics are hidden leaves the cycle
  position unchanged (the sponsor keeps its turn). Mutate the frozen-set read once; a test must die.
- **Queue (unit):** score pre-empts a queued sponsor; cuts an on-air one with `cutShort`; stale sponsor dropped at
  20 s; Final discards; reduced motion; at a cricket over end the real `endOfOver` card airs before the `over_end`
  sponsor card and the sponsor card never overlaps it. Mutate the pre-empt guard once; a test must die.
- **Seam, driven for real (failure class 1):** the planner's real output through the real page into a real heartbeat
  body, through the real `heartbeat` usecase, then read the `sponsor_airings` row back.
- **Compositor (cargo):** line parser (bad JSON, oversize, unknown key refused); buffer bound and drop count; clear only
  on 2xx; final-beat flush; frame-grab rate limit; a failing upload never stalls the pipeline.
- **E2E (CI dispatch):** hub at 320 / 768 / 1280, no horizontal scroll; report opens without login, 404s after revoke;
  overlay at `host=obs` shows a lower third after a cricket over, cooldown honoured.
- **Retention job (usecase):** a connected channel's refresh sets `youtube_refreshed_at`; after a disconnect the next
  run clears `viewers` and `video_id` (counts reported, 0 = fail) while times shown, time on screen and clicks are
  unchanged; a row refreshed > 30 days ago is purged; the report then shows a dash and no "watch this moment". Sequence:
  disconnect → reconnect → the purged rows stay purged.
- **Smoke:** the report renders a seeded airing; `/s/[id]?f=&src=` records a click row and still redirects.
- **Security:** cross-org on airings, settings, links and clicks; token hashed at rest, never logged; frame endpoint
  refuses another session's token.
- **Live check (stg, with the owner):** one composed match; read the airing rows and frames back.

## 8. Open for the owner

None. Every item was answered on 2026-10-27 (owner: "1 rec, 2 rec, 3–8 ok") and moved to §0 as D8–D14.

## 9. Coordination

- **r2-youtube:** the broadcast table and `videoId` (§3.6, §5.2), the paid-placement flag (§6.2), the disconnect
  signal the retention job reads (§6.3). **No sponsor links in the description** (§3.7). **Request to the YouTube
  Connect session** *(coordinator's call 2026-10-27, not an owner ruling)*: V478 `youtube_broadcasts` has no `actualStartTime`; please store the
  broadcast's actual start time. The "watch this moment" offset needs it (§5.2); until then there is no timestamped
  link.
- **Compositor:** heartbeat contract bump (`airings`, `airingsDropped`) and the frame endpoint; vendored contract updated
  in the same pair of PRs.
- **Operator console spec:** writes the operator state the planner reads; shares `sponsor_airings` and the carousel.

## 10. Later (not in the MVP)

- **Per-sponsor deals** (owner's option C, second half): the additive rule table in §2 row 3, an "Add a deal" editor
  offering only the sport's declared breaks, deal-before-rotation in the planner.
- **PDF** of the report (pdfkit via `server/doc-render.ts`) and the **optional monthly email** (new outbox kind).
- A page-view counter as a viewer fallback; OBS proof of play behind a signed overlay URL; division / fixture sponsor
  scope; a corner-badge slot; sponsor self-serve uploads or a sponsor network; QR codes on cards; caps or guaranteed
  minutes; CF-recording playback without YouTube. HLS fallback: owner, no need.
