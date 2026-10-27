# Operator console: live controls for a composed stream — MVP design

Status: **written 2026-10-27, cut to the owner-approved MVP set.** Not yet planned.
Repo: web `seazn.club` only. The compositor needs no change for this MVP: everything renders in the overlay page it
already hosts. The one compositor wish (sound on Break) is in §8 Later.
Companion spec: `2026-10-27-sponsors-on-stream-design.md` (rotation, airings, the scene carousel). Read it first; this
spec reuses its planner, queue priority and `sponsor_airings`.

## 0. What the owner approved (2026-10-27)

"I need a working MVP" → the approved set, and only it:

| # | Control | Names on screen |
|---|---|---|
| A1 | **Health strip in plain words**: live or not, phone signal, YouTube status, and what viewers see during a problem | — |
| A2 | **Scenes** | **Match** · **Break** (card reads "Back shortly") · **Full time** |
| A3 | **Hide graphics** switch | "Hide graphics" |
| A4 | **Sponsor controls** | "Play next at next break" · "Skip this card" |

Who may operate (confirmed 2026-10-27): **org editors only** (as Stop); a device-linked remote scorer gets no Graphics section.

Mocks are layout only; the build uses the house theme. This screen was not mocked, so the builder shows the owner
**2 layout options** (visual companion) before building (standing rule), frontend-design skill in the dispatch.

## 1. Who and where

- **Who:** the club's streamer on the day, often on a phone, sometimes the scorer between points. Org editors only
  (the same guard as the stream panel's Stop; reuse it).
- **Where:** a new **Graphics** section at the top of the fixture stream panel
  (`components/v2/fixture-stream-panel.tsx`), shown with its controls only while the fixture has a composed session in
  `warming | live | ending`. Not a new route. The phone composition already exposes a *Stream* control (AGENTS.md); the
  builder re-pins how it reaches the panel and puts Graphics first in whatever it opens.
- **"OBS session" means a passthrough session** (`StreamMode = passthrough | composed`, `server/api-v1/schemas.ts:1652`)
  *(coordinator's call 2026-10-27, not an owner ruling)*. A passthrough session's Graphics section is one plain line saying graphics are controlled in
  OBS, with no controls. The operator state is per fixture, so what is set from a composed session's Graphics section
  also reaches an OBS page showing the same fixture (§3.2, §3.3).
- Not `components/v2/fixture-console.tsx` (R7's scoring console) and not the division page's "Fixture Console". The UI
  name is **Graphics** *(coordinator's call 2026-10-27, not an owner ruling)*: the panel already uses "On air" as its live label (`stream.onAir`,
  `fixture-stream-panel.tsx:2384-2385`), and "console" must not gain a third meaning. The new string is owed in all 4
  locales.

## 2. What exists (re-pin before building)

- The stream panel polls the session view every `STREAM_POLL_MS` = 5 s (`lib/stream-session-view.ts:37`) and renders
  the signal chain (`components/v2/stream-signal-chain.tsx`: phone → Seazn → destination nodes, each with a state word).
- The overlay page at `host=compositor` polls the relay overlay answer every 5 s, `private, no-store`
  (`app/api/v1/public/fixtures/[id]/overlay/route.ts`); OBS polls the public answer (2 s edge window).
- Compositor-driven scenes: Starting soon (`programmePhase = waiting`), Reconnecting, Final (overlay templates spec
  2026-10-15 §4.2). The page renders the phase it is given.

## 3. The controls

### 3.1 Health strip (A1) — read-only, plain words

Four short lines, each a sentence, no jargon. Derived from data the panel already polls, plus the heartbeat:

| Line | Words (examples, 4 locales) | Source |
|---|---|---|
| Live | "You're live" · "Not live yet" · "Stream ended" | session state |
| Phone | "Phone signal good" · "Phone reconnecting" · "Phone signal lost" | the chain's phone node + the heartbeat's `input` |
| YouTube | "Sending to YouTube" (MVP) | the chain's destination node (`sending`); with YouTube Connect, Connect's broadcast stream status |
| Viewers see | "The match with the score" · "The Back shortly screen" · "The Reconnecting screen, with the score" · "The Full time screen" · "Starting soon" · "The match without graphics" | `programmePhase` + the operator state, through the same precedence function the page uses (§3.2) |

- "Viewers see" is the point of the strip: during a phone drop the streamer reads "Phone reconnecting" and
  "Viewers see the Reconnecting screen, with the score", not a status code.
- No new measure is invented: a "weak" phone state appears only if a measured signal for it already exists; otherwise
  the three words above.
- **The YouTube line never claims receipt** *(coordinator's call 2026-10-27, not an owner ruling)*. A composed session's destination is not observed
  (`output` is null for composed, `server/api-v1/schemas.ts:1765-1767`; the chain's neutral `sending` state,
  `lib/stream-chain.ts:19-20`, owner ruling R2006). The MVP line says "Sending to YouTube", worded neutrally like that
  `sending` state, and never "YouTube is receiving". Once YouTube Connect lands, the line reads the broadcast's stream
  status from Connect. No destination probe is added.
- One function maps (session, chain, heartbeat, operator state) → the four lines; it is pure and enumerated in tests.

### 3.2 Scenes (A2): Match · Break · Full time

One segmented control, one active at a time; **Match** is the default.

- **Break** renders the scene layer at `host=compositor` like the compositor's own scenes: opaque house backdrop, the
  score bug still visible, a new **Back shortly** card variant of the match-card component (entrant names, 4 locales),
  and the **sponsor carousel** (sponsor spec §3.4). Score moments still fire (a goal must still reach viewers).
- **Full time** renders the existing **Result** card when the match is decided or void, else a "Full time" card with the
  current score, plus the sponsor carousel. No score moments fire (as Final). The stream keeps running; ending it is
  still Stop.
- **Precedence** (one ordered rule, tested exhaustively): compositor Final > compositor Reconnecting > operator Full
  time > operator Break > compositor Starting soon > Match. The compositor's `frozen` phase (`lib/relay-phase.ts:12`)
  maps to **Match** (no scene), so an operator Break or Full time still shows over it *(coordinator's call 2026-10-27, not an owner ruling)*. A camera
  drop during Break shows Reconnecting; when the camera returns, Break is still in force.
- OBS host: operator **scenes** are not drawn at `host=obs`. The reason is concrete and kept: Break and Full time are
  scene-layer renders, not moments, and the scene layer exists only at `host=compositor` (owner-approved overlay
  templates spec 2026-10-15 §4.1: "OBS users never see it, because they have their own scenes in OBS"). The sponsor
  carousel lives in that layer, so it is compositor-only too. Everything that rides the **moment stream** does reach
  OBS: Hide graphics, Play next and Skip (§3.3, §3.4) *(coordinator's call 2026-10-27, not an owner ruling)*.
- A new session starts at Match with graphics shown.

### 3.3 Hide graphics (A3)

A switch. On ⇒ in the **Match** scene the page draws nothing: no score bug, no moment slabs, no sponsor cards (a clean
camera feed, e.g. for a presentation or an injury).

- Break and Full time still draw their card (the streamer asked for them explicitly). Compositor Reconnecting and
  Final still draw (viewers must know).
- While hidden, score moments are marked seen (so nothing floods out when graphics return). A break that opens while
  hidden **does not count** *(coordinator's call 2026-10-27, not an owner ruling)*: the sponsor whose turn it was keeps its turn and the rotation does
  not advance (sponsor spec §3.2).
- Hide applies on the OBS page too: the moment stream is shared, so composed and OBS render the same moments
  (scenario rule; sponsor spec §2 row 7).
- The health strip says "Viewers see the match without graphics".

### 3.4 Sponsor controls (A4)

- **Play next at next break:** pick a ticked sponsor; the **next eligible break** (by the dial, sponsor spec §3.2) goes
  to that sponsor instead of the rotation, once. The rotation's own next sponsor stays next after it. Choosing again
  before that break replaces the choice; the row shows "Up next: <name>" with a clear option.
- **Skip this card:** shown while the plan's current or next sponsor moment is on air or due; folds it out now (or
  before it starts). **"On air now" comes from the plan** *(coordinator's call 2026-10-27, not an owner ruling)*: the web knows the schedule and the
  overlay's clock, so it does not wait for an open `sponsor_airings` row, which for an 8 s card would land only after
  the card had gone. The web sets `skipped = true` on the airing itself, from the operator log; the compositor's end
  line and the contract are unchanged (`{momentId, at, cutShort}`), so an on-air skip also arrives `cut_short`. A card
  skipped before it starts never airs and leaves no airing row. The rotation does not replay either.
- Both are logged with `source` unchanged (a "played next" card is `source = "operator"`). Both reach the OBS page as
  well as the composed one (shared moment stream).

## 4. How a tap reaches the stream

```
Graphics tap ─PUT─▶ web: operator state + log ──(next overlay poll, ≤ 5 s)──▶ overlay page ──▶ composed frame / OBS
                    └─▶ plan ──▶ "on air now" (Skip)          └─▶ seazn:sponsor:* ──▶ heartbeat ──▶ health strip, sponsor_airings
```

- **State, not commands.** One row per fixture `(fixture_id pk, org_id, scene ∈ match|break|full_time,
  graphics_hidden, next_sponsor_id null, next_set_at null, skip_moment_id null, version, updated_by, updated_at)` plus an
  append-only log `(fixture_id, at, field, value, by)`. The planner reads the log to know which state was in force at
  each break, so the plan stays deterministic for both hosts and across re-polls. RLS org-scoped.
- **Write:** `PUT /api/v1/fixtures/{id}/stream/operator` with `{ version, scene?, graphicsHidden?, nextSponsorId? | null,
  skipMomentId? }`. Optimistic concurrency on `version` (409 on a stale write; the UI refetches). Editor role,
  org-scoped, fixture must have an active session; `nextSponsorId` must be ticked for this fixture; `skipMomentId` must be
  the plan's current or next sponsor moment (§3.4). In `openapi.ts` (CI drift check).
- **Read:** the overlay live answer adds `operator: { scene, graphicsHidden, skipMomentId | null }` for both hosts;
  `graphicsHidden` and `skipMomentId` apply at `host=obs` too, and only `scene` is ignored there (§3.2); "play next" reaches the page already folded into `sponsorPlan`. Nothing in it is private.
- **Latency:** tap → screen ≤ ~6 s (5 s poll + render), shown as "a few seconds". The overlay `delay` (score sync) is
  **not** applied to operator state; the streamer reacts to the real world and the composed video is seconds behind it.
  Recorded choice; a test pins it.

## 5. UI constraints

- Mobile-first 320 / 768 / 1280, no horizontal scroll, 44 px targets; scenes as one segmented control; sponsor names
  `min-w-0` + `truncate`, tested with a realistic long name (AGENTS.md truncate trap).
- Every string in 4 locales (the "Graphics" heading included); disabled states say why (no card on air, OBS
  (passthrough) session, stream not live).
- Graphics reads ride the panel's existing 5 s poll (one extra field on the session view, no second timer).

## 6. Testing (all four types; TEST-STRATEGY.md)

- **Unit (pure):** scene precedence over every (compositor phase, `frozen` included × operator scene × graphics hidden) triple, rendered
  scene and the "Viewers see" line both asserted, count reported (0 = fail); hide skips breaks without reassigning
  (cycle position unchanged across a hidden break); moments marked seen while hidden; play-next takes exactly one break and leaves the
  rotation's next unchanged; skip folds only the named moment; `delay` not applied; operator scene not drawn at
  `host=obs` while hide and skip are; the YouTube line never reads "receiving" for a composed session without Connect. Mutate the precedence order and the hide guard, once each; a test must die.
- **Usecase:** 409 on stale version; non-editor 403; other org's fixture opaque 404; no active session refused;
  play-next of an unticked sponsor refused; skip of a moment that is not the plan's current or next sponsor moment
  refused; a skip of an 8 s card accepted before any airing row exists, and `skipped` lands on the row when it arrives. Sequence: hide → show → hide; play next
  → undo of the break event → choice still pending; Full time → Match.
- **Seam, driven for real (failure class 1):** PUT through the real route, read the real overlay answer, fold it through
  the real page reducer, at `host=compositor` and `host=obs`; then a real heartbeat carrying the page's
  `seazn:sponsor:*` lines updates the health strip and the airing row, with `skipped` set from the operator log.
- **E2E (CI dispatch, never local):** Graphics at all seven widths without clipping (open any phone fold first, AGENTS.md
  rule 22); scene control switches the overlay preview; hide graphics empties the Match preview.
- **Smoke:** the PUT and the overlay field on a seeded live session.
- **Live check (stg, with the owner):** one composed match: Break on and off, Full time, Hide graphics, Play next, Skip;
  read `sponsor_airings` back.

## 7. Open for the owner

None. Who may operate was confirmed 2026-10-27 (§0). Nothing else from the earlier draft is needed in the MVP: Starting soon
already shows automatically until the first camera frame; Hide graphics plus Skip cover what "pause sponsors" was for;
"Show now" is covered by Play next.

## 8. Later

- **Sound on Break:** the MVP is picture-only; the camera's sound stays audible. Follow-up: a compositor volume element on
  the camera branch, driven by a heartbeat-reply field.
- "Show now", "Pause sponsors", a manual "Starting soon" hold (from the earlier draft).
- Manual graphics (free-text lower thirds, player cards), instant replay, multi-camera switching, a desktop producer
  layout with programme preview, keyboard shortcuts, several fixtures from one screen, OBS scene control.
