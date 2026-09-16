# Chess external play (Lichess) — design

Date: 2026-09-15  
Status: draft for owner review  
Approach: fixture bridge (Seazn owns competition; Lichess is the board)

## 1. Problem

Chess competitions in Seazn already pair fixtures, assign colours, and fold
win/draw/loss into standings via the `boardgame` module. Players who enrol on
the platform still need somewhere to actually play online. We want Seazn to
generate an external play path, get both players onto the board at the right
time, and write the finished result back into the normal scoring pipeline.

## 2. Goals (v1)

- Organiser runs an **online Lichess** chess division; Seazn pairings and
  standings stay authoritative.
- Players **link a Lichess account** on their profile; enrollment into an
  online-Lichess division **requires** that link.
- At **T−15 minutes** before each fixture’s scheduled start, Seazn **emails
  both players a Seazn lobby link**. It does not create a Lichess challenge
  then. A direct Lichess challenge expires 20 seconds after creation unless a
  stream is held open, so a link minted at T−15 is already dead.
- Being on the page is not enough. Each player clicks **Ready**. When **both**
  have clicked, Seazn mints the challenge as White and both screens get Play
  plus a **20-second countdown**. If that window passes and the game has not
  started, both Ready clicks are cleared and they click Ready again. A started
  game never returns to Ready.
- When Lichess reports game start → fixture becomes live in Seazn.
- When Lichess reports a clean finish → Seazn appends the normal boardgame
  `result` score event.
- Messy outcomes → organiser **needs-result** queue (no invented auto-forfeit).
- Chess.com is a later adapter behind the same fixture extension; not built in
  v1.

## 3. Non-goals (v1)

- Chess.com adapter implementation
- Team chess / multi-board ties
- KO mini-match chains driven by Lichess
- In-Seazn ticking clock UI for online games (clock is Lichess’s job)
- Auto-forfeit without organiser confirmation
- PGN as scoring authority
- Changing OTB / manual chess scoring when online play is off

## 4. End-to-end flow

1. Player links Lichess on Seazn profile (OAuth).
2. Enrollment into an online-Lichess division fails without a linked account.
3. Organiser sets division **online play = Lichess** and a clock
   (`Cfg.clock` / variant as today — metadata already on boardgame).
4. Seazn pairs the round as today (Swiss, colours; home = White).
5. At **T−15**: job emails both players the **Seazn fixture URL** (not a raw
   Lichess URL). No challenge is created. Enrollment already required a claimed
   profile and a Lichess link; the email does not create either.
6. Each signed-in player opens that page and clicks **Ready**. Realtime on
   `external-play:{fixtureId}` tells the other screen that the click happened.
   Presence alone does not mint.
7. When both Ready clicks are stored, the server mints one direct challenge
   (White’s token, home = White). Both screens show Play and a 20-second
   countdown. If the countdown ends and the fixture is not `live`, both Ready
   flags are cleared and the buttons come back. Clicking Ready again mints a
   new link and restarts the countdown. `live`, `finished`, and
   `needs_organiser` never mint again. Opening the link is not what stops it.
8. Lichess game start (poll, or our workflow’s signed webhook) → Seazn marks
   the fixture `live` and appends `core.start`. That flip is what stops minting.
9. Clean Lichess finish → map to boardgame `result` → existing scoring usecase
   → standings.
10. Abort / no-show / unfinished / account mismatch → `needs_organiser`.

## 5. Architecture

```
[Profile OAuth] ──► linked Lichess identity on person
[Division cfg]  ──► onlinePlay: lichess | off
[Pairing]       ──► fixtures (unchanged)
[T−15 job]      ──► email Seazn lobby link (no Lichess challenge)
[Lobby]         ──► each player clicks Ready (Realtime tells the other screen)
                ──► both Ready → adapter.createChallenge as White
                ──► 20s countdown; miss → clear Ready and ask again
[Webhook/poll]  ──► adapter.mapResult(game) ──► scoring.append(result)
                ──► or mark needs_organiser
[Organiser UI]  ──► manual forfeit / draw / no-result on queued fixtures
```

Seazn remains the competition system. Lichess is an execution backend for a
single game. Chess.com later implements the same adapter interface.

## 6. Data model

### 6.1 Person / profile

- Store Lichess user id + username from OAuth (and token material as required
  by Lichess API policy).
- Profile can relink; enrollment gate reads current link.
- Challenges already created keep the identities they were built with until
  recreated.

### 6.2 Division setting

- `onlinePlay`: `off` (default) | `lichess` (v1) | later `chesscom`.
- When `off`, behaviour is today’s OTB / pad / manual result path.
- Clock continues to live on boardgame config (`base`, optional `increment`,
  optional `delay`). v1 Lichess mapping supports **sudden death** (`base` only)
  and **Fischer** (`base` + `increment`). If `delay` is set, the T−15 job does
  **not** auto-create; fixture stays `needs_organiser` with a clear “delay
  clocks aren’t supported for Lichess sync yet” reason (organiser can still
  enter the result manually or clear delay and reschedule).

### 6.3 Fixture external-play record

Per fixture (when online play is on):

| Field | Purpose |
|---|---|
| `provider` | `lichess` |
| `external_challenge_id` / `external_game_id` | Lichess ids |
| `play_url` | Current challenge/game URL for the Play button |
| `status` | `pending` → `ready` → `live` → `finished` \| `needs_organiser` |
| `last_error` | Optional create/sync failure detail |
| `white_ready_at` / `black_ready_at` | Set when that side clicks Ready; cleared when the 20s window is missed |
| `started_at` / `finished_at` | From provider signals |

Exact table vs JSON column is an implementation choice; the fixture remains the
join key.

## 7. Lichess adapter responsibilities

- Create challenge between the two linked accounts with Seazn-assigned colour
  (home = White) and mapped time control.
- **Auth model (v1):** Seazn’s Lichess OAuth app stores each player’s token.
  Mint the challenge **as White** (home) challenging Black, using White’s
  token, only when both players have clicked Ready on the lobby. If White’s
  token is missing/revoked, do not mint and do not flip colours.
- Create games as **unrated/casual** by default (club comps must not surprise
  players’ Lichess ratings).
- Expose current play URL for the fixture page (per side if accept URLs differ).
- Observe start and finish (webhook preferred; poll as backup).
- Map finished game → boardgame result payload (`winner` null for draw;
  method from Lichess termination when available).
- **Reject** auto-apply if Lichess player ids do not match the linked accounts
  for that fixture.
- If the 20-second window passes and the game has not started, clear both
  Ready clicks. The next mint happens only when both click Ready again.
  Do not recreate after `live` (game started), `finished`, or
  `needs_organiser`. Do not treat “opened the link” as started — Lichess does
  not report that click. Do not re-spam email unless the organiser resends.

## 8. Jobs & notifications

| When | Action |
|---|---|
| T−15 before `fixture.scheduled_at` | Email both players the Seazn lobby URL. No challenge yet. Status stays `pending`. |
| Both players click Ready | Mint challenge as White; set `ready`; show Play and a 20-second countdown. |
| Countdown ends, still not `live` | Clear both Ready clicks. Ask them to click Ready again, then mint a new link. |
| Ongoing | Poll, or `POST /api/webhooks/lichess` signed with HMAC `x-lichess-signature` (`LICHESS_WEBHOOK_SECRET`, not a Lichess setting): `ready` → `live` on start; `live` → `finished` or `needs_organiser` |
| Scheduled start + 20 min, still not `live` | Escalate to `needs_organiser` (organiser confirms forfeit / rewrite) |
| Challenge create failure | Stay `pending`; clear Ready so both click again. Email already sent is not repeated |

The cron (`POST /api/cron/external-play`, `x-cron-secret`) is what polls Lichess.
The webhook is our workflow poking the same path, not Lichess calling us.
Emails point at Seazn so expired Lichess URLs are not the durable handle.

## 9. Scoring integration

- Clean finishes call the **existing** append-score-event path for boardgame
  `result`. No parallel standings writer.
- If a result already exists on the fixture, ignore late provider events
  (first authoritative result wins).
- Organiser void/correct uses existing undo/void behaviour.
- Provenance: record that the result was provider-synced (for audit); fold
  semantics unchanged.

## 10. UI surfaces

- Profile: Link / unlink Lichess.
- Enrollment: block with clear CTA if online-Lichess division and no link.
- Fixture (players): **Ready** button for each signed-in player; Play and a
  20-second countdown only after both have clicked; Ready again if that window
  is missed. Lobby token is for the two matched players only and does not use
  the paid `realtime` entitlement.
- Organiser: division toggle for online play; needs-result queue; optional
  resend notification; manual result entry for queued fixtures.
- OTB pad path unchanged when `onlinePlay` is off.

## 11. Failure matrix

| Case | Behaviour |
|---|---|
| Unlinked at enrollment | Block |
| Lichess create fails | Stay `pending`; email may already have gone out; mint again when both are present |
| Challenge expired, not started | Clear both Ready clicks. Remint only after both click Ready again. Never remint if `live` / `finished` / `needs_organiser` |
| One player opens Play, the other does not accept within 20s | Not a lock. Countdown ends, Ready buttons return |
| One no-show past grace | `needs_organiser` |
| Clean finish | Auto `result` |
| Abort / unfinished | `needs_organiser` |
| Account mismatch on game | `needs_organiser` |
| Result already present | Ignore provider |
| Provider outage mid-game | Stay `live` until poll recovers or organiser acts |

## 12. Testing

- **Unit:** clock → Lichess time control; game payload → boardgame `result`;
  mismatch rejection.
- **Integration:** T−15 email without a challenge; mint only when both sides
  are present; a second mint inside 20 seconds returns the same URL; `live`
  refuses mint; webhook/poll through real scoring usecase.
- **E2E:** linked player Play button; unlinked enrollment blocked; organiser
  queue path.
- **Regression:** online play off — pairings + manual/pad result unchanged.
- **CI:** recorded Lichess payloads only; no live network.

## 13. Open follow-ups (not blocking v1)

- Chess.com adapter
- Configurable pre-window / grace (defaults: T−15 create+email; +20 min
  escalate)
- Rated Lichess games as a division option
- Bronstein/delay clock mapping to Lichess
- Optional PGN attach via `core.note` after sync
- Alternate create-as-Black fallback when White’s token is revoked

## 14. Success criteria

- A paired chess fixture in an online-Lichess division gets a playable Lichess
  game without the organiser tapping Start per board.
- Both players are notified via email to a Seazn link at T−15.
- A decisive Lichess finish appears in Seazn standings without manual entry.
- Aborts and no-shows never silently corrupt the Swiss table.
- Turning online play off leaves today’s chess behaviour intact.
