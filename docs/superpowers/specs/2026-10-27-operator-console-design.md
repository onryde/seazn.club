# Operator console: live controls for a composed stream — MVP design

Status: **written 2026-10-27 from the owner-approved brainstorm (R4, MVP cut).** Not yet planned.
Repo: web `seazn.club` only. The compositor needs no change for this MVP (everything renders in the overlay page it
already hosts); the one compositor-side wish (audio mute on "Be right back") is listed in §8.
Companion spec: `2026-10-27-sponsors-on-stream-design.md` (rotation, airings, the scene carousel). Read it first;
this spec reuses its planner, queue priority and `sponsor_airings`.

## 0. Owner decisions (2026-10-27)

| # | Question | Owner answer |
|---|---|---|
| D1 | Do we build an operator console? | "Brainstorm this … an operator console" → asked for a recommendation ("What you rec"). |
| D2 | How big? | "I need a working MVP" → this cut: see what is on air, steer sponsors, switch a scene. Nothing a producer desk would add (replays, cameras, graphics editing). |
| D3 | Mocks | Layout only; build in the house theme. This screen was **not** mocked in the brainstorm, so the builder shows the owner **2 layout options** (visual companion) before building (standing rule). |

## 1. Who and where

- **Who:** the club's streamer on the day — often the scorer's helper, often on a phone, sometimes the scorer
  themself between points. Org editors only (the same guard as the stream panel's Stop; read it, do not invent one).
- **Where:** a new **On air** section inside the fixture stream panel (`components/v2/fixture-stream-panel.tsx`),
  shown only while that fixture has a composed session in `warming | live | ending`. Not a new route: the panel is
  already where the streamer started the stream, and the phone composition already exposes a *Stream* control
  (AGENTS.md, phone composition: Stream is one of the two duplicated controls). The builder re-pins how the pad's
  Stream control reaches the panel and puts On air at the top of whatever it opens.
- Not this: `components/v2/fixture-console.tsx` is R7's scoring console, and "Fixture Console" in owner vocabulary is
  the division page's fixtures tab. The name in the UI is **On air**, to avoid a third meaning of "console".

## 2. What exists (re-pin before building)

- The stream panel polls the session view every `STREAM_POLL_MS` = 5 s (`lib/stream-session-view.ts:37`) and already
  renders the signal chain (`components/v2/stream-signal-chain.tsx`: phone → relay → Cloudflare → destination).
- The overlay page at `host=compositor` polls the relay overlay answer every 5 s, `Cache-Control: private, no-store`
  (`app/api/v1/public/fixtures/[id]/overlay/route.ts`); OBS polls the public answer (2 s edge window).
- Scenes today are compositor-driven only: Starting soon (`programmePhase = waiting`), Reconnecting, Final
  (overlay templates spec 2026-10-15 §4.2). The page renders the phase it is given.

## 3. The MVP controls

### 3.1 See what is on air (read-only)

One compact block, top of On air:

- **Status line:** the existing signal chain, unchanged (reuse, do not fork).
- **On screen now:** the scene (Live / Starting soon / Be right back / Reconnecting / Final) and, when a sponsor card
  is up, its name. "Now" comes from the latest `sponsor_airings` row with no `ended_at` (sponsor spec §3.6) and the
  session's `programmePhase`, so it shows what the **composed stream reported**, not what the console asked for.
- **Next sponsor:** the planner's next rotation sponsor for this fixture (pure planner, sponsor spec §3.2), or
  "Paused".
- **Aired this match:** the last 10 airings — time, sponsor, break, "cut short" when a score took the screen. This is
  the streamer's proof the cards are playing; it is the same rows the sponsor's report counts.

### 3.2 Steer sponsors

- **Pause / Resume sponsors** for this fixture. Paused ⇒ the planner plans no rotation or deal airings for breaks that
  open while paused; a skipped break is **skipped, not reassigned**, so the rotation does not bunch up on resume.
- **Show now** on any sponsor in this fixture's rotation: one banner card, 10 s, logged `source = "operator"`. It is a
  sponsor-priority moment, so a score change still takes the screen from it (sponsor spec §3.4). At most one per 30 s
  per fixture (server-refused with a clear message, the button shows a countdown).

### 3.3 Switch a scene

Three buttons, one active at a time: **Live** (default) · **Starting soon** · **Be right back**.

- Starting soon / Be right back render the scene layer at `host=compositor` exactly as the compositor's own scenes do:
  opaque house backdrop, the score bug still visible, the scene card, and the **sponsor carousel** (sponsor spec §3.4).
  Be right back is a new card variant of the match-card component ("Back shortly", entrant names), 4 locales.
- **Precedence** (one ordered rule, tested): compositor Final > compositor Reconnecting > operator scene > compositor
  Starting soon (waiting) > Live. A camera drop during Be right back shows Reconnecting; when the camera returns, the
  operator's scene is still in force.
- Moments during an operator scene fire, like Reconnecting (a goal must still reach viewers).
- OBS host: the operator scene is **not** drawn (OBS users run their own scenes — the 2026-10-15 ruling); the console
  says so in one line when the session is OBS.
- Ending the session clears the operator scene; a new session starts at Live.

## 4. How a tap reaches the stream

```
On air tap ─PUT─▶ web: fixture_stream_operator row ──(next overlay poll, ≤ 5 s)──▶ overlay page ──▶ composed frame
                                                                                    └─▶ seazn:sponsor:* ──▶ heartbeat ──▶ "On screen now"
```

- **State, not commands.** One row per fixture: `(fixture_id pk, org_id, scene ∈ live|starting_soon|brb,
  sponsors_paused, paused_changed_at, show_now_sponsor_id null, show_now_nonce null, show_now_at null, version,
  updated_by, updated_at)`. RLS org-scoped. A state row survives a page reload and a compositor restart without
  replaying anything.
- **Write:** `PUT /api/v1/fixtures/{id}/stream/operator` with `{ version, scene?, sponsorsPaused?, showNow?: { sponsorId } }`.
  Optimistic concurrency on `version` (409 on a stale write, the UI refetches). Editor role, org-scoped, fixture must
  have a session in an active state. In `openapi.ts` (the CI drift check covers it).
- **Read:** the overlay live answer adds `operator: { scene, sponsorsPaused, showNow: { nonce, sponsorId, at } | null }`
  for both hosts (the scene is ignored at `host=obs`). Nothing in it is private.
- **Show now identity:** the page turns `showNow` into one moment with id `op:${nonce}`; the queue's `seen` list stops a
  re-poll replaying it, and a `showNow.at` older than 30 s is ignored, so a page that reloads late never plays it.
- **Latency:** tap → on screen ≤ ~6 s (5 s poll + render), stated in the UI as "a few seconds". The overlay `delay`
  (score sync) is **not** applied to operator state: the streamer reacts to the real world, and the composed video is
  only seconds behind it. Recorded choice; a test pins that `delay` does not hold an operator scene.

## 5. UI constraints

- Mobile-first: 320 / 768 / 1280, no horizontal scroll, 44 px targets, the scene buttons as one segmented control,
  sponsor rows as `min-w-0` + `truncate` with a realistic long sponsor name in the test data (AGENTS.md truncate trap).
- Two layout options shown to the owner before building (§0 D3), frontend-design skill loaded in the dispatch.
- Every string in 4 locales. Disabled states say why (paused, rate limit, OBS session).
- The panel already polls every 5 s; On air reads ride the same poll (one extra field on the session view, not a
  second timer).

## 6. Testing (all four types; TEST-STRATEGY.md)

- **Unit (pure):** scene precedence — enumerate every (compositor phase × operator scene) pair, assert the rendered
  scene, report the count (0 = fail); pause skips and does not reassign (cycle position before and after a pause);
  `showNow` older than 30 s ignored; nonce replay ignored; operator scene not drawn at `host=obs`; `delay` not applied.
  Mutate the precedence order and the 30 s guard, once each — a test must die.
- **Usecase:** PUT version conflict → 409; non-editor → 403; other org's fixture → 404 (opaque); no active session →
  refused; show-now inside 30 s refused; session end clears the scene. Sequence: pause → resume → pause; show now →
  undo of the break event → nothing stranded.
- **Seam, driven for real (failure class 1):** PUT through the real route, read the real overlay answer, fold it
  through the real page reducer, and assert the moment / scene; then a real heartbeat with the resulting
  `seazn:sponsor:*` lines updates "On screen now".
- **E2E (CI dispatch; never local):** On air renders at all seven widths without clipping (open any phone fold first —
  AGENTS.md rule 22); scene buttons switch the overlay preview; Show now's countdown.
- **Smoke:** the PUT and the overlay field on a seeded live session.
- **Live check (stg, with the owner):** one composed match — Be right back on and off, Show now, pause and resume;
  read `sponsor_airings` back.

## 7. Open for the owner

1. **Who may operate.** Recommendation: org editors only (as Stop). A device-linked remote scorer gets no On air.
2. **Show now limit** of one per 30 s per fixture — confirm.
3. **Be right back while the camera keeps sending audio.** The MVP covers the picture only; the crowd and any
   talk stay audible. Recommendation: accept for the MVP; a compositor mute is the first follow-up (§8).

## 8. Out of scope (MVP) and the follow-ups it leaves room for

Audio mute on Be right back (compositor: a volume element on the camera branch, driven by a heartbeat-reply field);
manual graphics (lower thirds with free text, player cards); instant replay; multi-camera switching; a desktop
"producer" layout with a programme preview; keyboard shortcuts; operating several fixtures from one screen; OBS scene
control.
