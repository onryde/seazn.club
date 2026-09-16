# Chess external play (Lichess) — design

Date: 2026-09-15 (revised 2026-09-16)
Status: revised after PR #788 review — for owner review
Approach: fixture bridge (Seazn owns the competition; Lichess is the board)

## 0. Revision note (2026-09-16)

The first build minted a **direct** Lichess challenge only after both players
clicked Ready, because a direct realtime challenge expires 20 seconds after
creation. Review of PR #788 traced most blockers to that: an accepted game lost
when the lobby cleared an "expired" challenge, a Lichess HTTP call inside a DB
transaction, a lobby realtime token whose claim opened the paid score channel,
and player OAuth tokens stored in plaintext.

Owner decisions 2026-09-16:

1. Use a Lichess **open challenge restricted to the two players**. No 20-second
   countdown, no Ready reset, no stored player tokens.
2. Keep a **check-in**, with realtime so each player sees the other arrive.
   Mint when both have checked in.
3. One **window, T−10 → T+20**, for both check-in and play.
4. Players use a new private **match room** at `/me/fixtures/[fixtureId]`. The
   public fixture page shows read-only status only.
5. Organisers get **no new page**: attention on the Fixture Console row, detail
   and resolve on the organiser fixture page.
6. Check-in **reuses** the existing `fixture_availability.checked_in_at` and
   `checkInToFixture` — one authority for "who showed up".

## 1. Problem

Chess competitions in Seazn already pair fixtures, assign colours, and fold
win/draw/loss into standings via the `boardgame` module. Players who enrol need
somewhere to play online. Seazn should get both players onto the right Lichess
board at the right time, know who turned up, and write the finished result back
into the normal scoring pipeline.

## 2. Goals (v1)

- Organiser runs an **online Lichess** chess division; Seazn pairings and
  standings stay authoritative.
- Players **link a Lichess account**; enrollment into an online-Lichess division
  **requires** that link.
- At **T−15** Seazn emails both players a link to their **match room**. The email
  never contains a Lichess URL.
- From **T−10 to T+20** each player opens the match room and **checks in**. The
  other player's screen updates live. When **both** have checked in, Seazn
  creates the Lichess challenge and each player gets **their own** Play link.
- Before T−10 nothing can be played (no challenge exists). At T+20 Lichess
  expires the challenge.
- Lichess game start → fixture live; clean finish → normal boardgame `result`.
- **No-shows are detected automatically** at the deadline, with who checked in
  and who did not, and land in the organiser's attention (§9).
- No auto-forfeit: the organiser confirms, with the likely outcome pre-filled.
- Chess.com is a later adapter behind the same interface; not built in v1.

## 3. Non-goals (v1)

- Chess.com adapter; team chess / multi-board; KO mini-matches via Lichess
- In-Seazn clock UI
- Auto-forfeit without organiser confirmation
- Rated games; delay/Bronstein clocks; PGN as scoring authority
- Any change to OTB / pad / manual chess scoring when online play is off
- Per-division window/deadline (constants in v1)

## 4. Lichess facts this design rests on

Verified 2026-09-16 against the Lichess API spec (`lichess-org/api`) and the
Lichess server source (`lichess-org/lila`, `modules/challenge`):

1. `POST /api/challenge/open` needs no user token. Parameters include `users`
   ("only these users will be allowed to join"), `clock.limit` /
   `clock.increment` (seconds), `rated`, `name`, `rules`, `expiresAt` (ms epoch,
   default 24h, max 2 weeks). Response: `id`, `url`, `urlWhite`, `urlBlack`.
   There is **no not-before parameter** — early play is prevented only by not
   creating the challenge yet.
2. With `users=a,b`, lila fixes colour by username, not by which URL is opened:
   `openFixedColor = Color.fromWhite(me.is(userIds._1))`. The **first username is
   always White**. Anyone else gets "The challenge is not for you to accept."
3. The game id **equals** the challenge id (`def gameId = id.into(GameId)`).
4. The game is created when the second of the two players joins; the first
   joiner is recorded as the challenger (`repo.setChallenger`).
5. Lichess OAuth is authorization-code **with PKCE (S256)**, public client, no
   client secret; tokens are long-lived and have no refresh.
6. A direct challenge (`POST /api/challenge/{username}`) expires after 20s — the
   reason it is not used.

## 5. End-to-end flow

1. Player links Lichess (OAuth PKCE). Seazn reads `/api/account`, stores Lichess
   id + username, then revokes the token.
2. Enrollment into an online-Lichess division fails without a link.
3. Organiser sets the division **online play = Lichess**. Saving requires a
   boardgame clock with `base` and no `delay`.
4. Seazn pairs the round as today (Swiss, colours; home = White).
5. **T−15** (cron): email each player once — link to `/me/fixtures/[id]` and the
   window time.
6. **T−10 → T+20**, match room: the player taps **Check in** →
   `checkInToFixture` stamps `fixture_availability.checked_in_at` → a ping on
   the private channel tells the other screen.
7. When both players have a `checked_in_at` inside the current window, Seazn
   mints the open challenge (`users = whiteUsername, blackUsername`,
   `expiresAt = T+20`, `rated = false`, `rules = noRematch`). Exactly one
   challenge is kept (§8.2). Both screens show their own colour's Play link.
8. Lichess game starts (cron poll, or the signed workflow poke) → fixture `live`,
   `core.start` appended.
9. Clean finish → boardgame `result` through the existing score-event usecase.
10. Deadline passes with no started game, abort, or account mismatch →
    `needs_organiser` with a reason (§9).

## 6. Architecture

```
[Profile OAuth PKCE] ─► lichess id + username on user (no token kept)
[Division cfg]       ─► onlinePlay: lichess | off   (+ clock required)
[Pairing]            ─► fixtures (unchanged)
[Cron T−15]          ─► email match-room link, once per player
[Match room]         ─► Check in ─► checkInToFixture (fixture_availability)
                     ─► ping external-play:{fixtureId}
                     ─► both checked in? claim row ─► adapter.createOpenChallenge
                        (HTTP outside any transaction) ─► urls, status ready
[Cron poll | poke]   ─► adapter.fetchGame(challengeId) ─► live / finished /
                        needs_organiser ─► scoreEvent(result)
[Cron deadline]      ─► no game ─► needs_organiser + no-show reason from check-ins
[Fixture Console]    ─► red attention on the row
[Organiser fixture]  ─► reason, check-in times, pre-filled resolve
```

Every entry point (match room read, check-in, mint, cron sweeps, poke, resolve)
goes through one guard, `loadOnlinePlayFixture`: division `onlinePlay =
lichess`, sport `boardgame`, fixture has `scheduled_at` and both entrants,
fixture not finalized or cancelled. Anything else is refused (page: 404; API:
404/409; cron: skipped).

## 7. Data model

Migrations V405–V407 are unmerged, so they are **amended**, not corrected
forward: V405 is rewritten, V406 folded into it, V407 rewritten.

### 7.1 `user_external_accounts` (V405)

`id, user_id, provider ('lichess'), external_user_id, username, created_at,
updated_at`; unique `(user_id, provider)` and `(provider, external_user_id)`.
**No token columns.** Relink replaces the row.

### 7.2 `fixture_external_play` (V405)

| Field | Purpose |
|---|---|
| `fixture_id` (pk), `org_id`, `provider` | Join key, tenant |
| `status` | `pending` → `ready` → `live` → `finished` \| `needs_organiser` |
| `challenge_id` | Lichess challenge id = game id (unique where not null) |
| `url_white` / `url_black` | Per-colour Play links |
| `white_lichess_id` / `black_lichess_id` | Identities the challenge was built with |
| `expires_at` | Deadline sent to Lichess |
| `mint_claimed_at` | Short claim so only one caller talks to Lichess |
| `white_emailed_at` / `black_emailed_at` | Per-recipient email-once |
| `last_polled_at` | Fair poll ordering |
| `needs_reason` | `no_show_white` \| `no_show_black` \| `no_show_both` \| `not_started` \| `aborted` \| `mismatch` \| `provider_error` |
| `last_error` | Diagnostics |
| `started_at` / `finished_at` | From Lichess |

Check-in is **not** stored here: it is `fixture_availability.checked_in_at`
(existing), read per side through the entrant's claimed person. A check-in
counts only if `checked_in_at >= T−10` for the fixture's current `scheduled_at`,
so a stamp from before a reschedule is ignored without clearing shared data.

The bridge row is created lazily by the first guarded entry point.

### 7.3 Realtime policy (V407)

Private topic `external-play:{fixtureId}`. The subscriber JWT carries its own
claim **`lobby_fixture_id`** — never `fixture_id` — and the policy matches
`'external-play:' || auth.jwt() ->> 'lobby_fixture_id'`. V403's paid-channel
policy reads `fixture_id`, which is absent from this token, so the lobby token
cannot open `fixture:{id}`. Only the fixture's two players are issued a token.
Messages carry no data beyond "changed"; clients re-read through the API.

## 8. Behaviour

### 8.1 Time constants

`EMAIL_LEAD = 15 min`, `WINDOW_OPEN_LEAD = 10 min`, `DEADLINE_AFTER = 20 min`,
relative to `fixtures.scheduled_at`, defined once and imported by code and tests.

### 8.2 Check-in and mint (no transaction around HTTP)

1. Guard passes; `now ∈ [T−10, T+20)`; caller is one of the two players; both
   players linked.
2. `checkInToFixture(userId, fixtureId)`; broadcast ping.
3. If both sides have a valid check-in: claim —
   `update … set mint_claimed_at = now() where fixture_id = $1 and status =
   'pending' and challenge_id is null and (mint_claimed_at is null or
   mint_claimed_at < now() − 30s) returning`. No row → someone else is minting
   or already minted; return the current view.
4. Call Lichess (request timeout 10s).
5. Success: `update … set status='ready', challenge_id, url_white, url_black,
   white/black_lichess_id, expires_at, mint_claimed_at = null where fixture_id =
   $1 and status = 'pending'`; broadcast ping. Failure: clear `mint_claimed_at`,
   record `last_error`; the next match-room read or cron retries the mint (both
   check-ins still stand).

A started game never re-mints: mint requires `status = 'pending'`. Check-ins are
never cleared.

### 8.3 Poll / poke

- Cron selects guarded rows with `status in ('ready','live')`, ordered by
  `last_polled_at nulls first`, limit 50, and stamps `last_polled_at` on every
  row it looks at, whatever the outcome.
- Started is decided from the **Lichess game status** (exists and not
  `created`), not from Seazn's score-event sequence.
- Every status write is conditional on the expected prior status.
- Lichess player ids must equal stored `white/black_lichess_id`, else
  `needs_organiser (mismatch)`. White → home.
- Result goes through the existing score-event usecase; if the fixture already
  has a result the provider result is ignored.
- The workflow poke (`POST /api/webhooks/lichess`, HMAC `x-lichess-signature`)
  only triggers a poll of the named fixture; it never carries a result.

### 8.4 Leaving `needs_organiser`

- Organiser enters a result (existing path, pre-filled per §9) → `finished`.
- Organiser reschedules → bridge reset to `pending` (challenge, urls,
  identities, email stamps, claim, reason cleared). Old check-ins no longer
  count because they predate the new window.

## 9. No-shows — detected automatically

At/after `T+20` the cron takes every guarded `pending` or `ready` row, polls
Lichess once more if a challenge exists, and if no game started sets
`needs_organiser` with a reason from the check-ins:

| Check-ins at deadline | Lichess | `needs_reason` | Pre-filled organiser action |
|---|---|---|---|
| White yes, Black no | no challenge | `no_show_black` | Forfeit win to White |
| Black yes, White no | no challenge | `no_show_white` | Forfeit win to Black |
| Neither | no challenge | `no_show_both` | Double forfeit / no result |
| Both | challenge, never started | `not_started` | None — organiser decides |
| Both | game aborted | `aborted` | None — organiser decides |

What happens automatically:

- The Fixture Console row shows a red attention ("Black didn't show") within one
  cron cycle of T+20 (≤ 5 min).
- The organiser fixture page shows the reason, both check-in times, and a
  one-tap pre-filled resolve. Nothing is written to standings until the
  organiser taps it.
- The checked-in player's match room says the opponent did not show and the
  organiser will confirm.

`live` rows are never escalated by the deadline.

## 10. Jobs & notifications

| When | Action |
|---|---|
| now ≥ T−15, player not yet emailed | Email match-room link; stamp that player only |
| Both checked in, `pending` | Mint (§8.2); cron retries a failed mint |
| `ready` / `live` | Poll (§8.3) |
| now ≥ T+20, not started | No-show / not-started (§9) |

Cron `POST /api/cron/external-play` (`x-cron-secret`) runs every 5 minutes from
the scheduled-workflow repo.

## 11. Scoring integration

- Existing score-event usecase only; no parallel standings writer.
- First result wins; late provider results ignored.
- Organiser void/correct uses existing undo/void.

## 12. UI surfaces

- **Profile:** link / unlink Lichess.
- **Enrollment:** block with a link CTA when the division is online-Lichess and
  the user has no link.
- **Division settings:** online play Off / Lichess; Lichess requires a clock
  without delay.
- **Match room `/me/fixtures/[fixtureId]` (new, private, signed-in, not
  org-scoped like `/me`):** opponent, colour, time; states — *Opens at HH:MM*,
  *Check in*, *You're checked in — waiting for opponent*, *Opponent checked in*,
  *Play as White/Black on Lichess*, *Game in progress*, *Finished*, *Opponent
  didn't show — organiser will confirm*, *Window closed*. Realtime ping plus a
  15s re-read fallback. At least two layout options shown to the owner before
  building; verified at 320 / 768 / 1280.
- **`/me` schedule card:** online fixtures get a "Check in" / "Open match room"
  link into the match room.
- **Public fixture page:** read-only status only (e.g. *Live on Lichess* + watch
  link `lichess.org/{challengeId}` once live). No controls, no Play URLs.
- **Fixture Console (division `?tab=fixtures`):** red attention on rows in
  `needs_organiser`, using the desk's existing attention rule (red attention
  outranks the phase pill). Read the competition-desk `_INDEX.md` / `_RULES.md`
  before touching it. No separate queue banner.
- **Organiser fixture page `/o/…/f/[no]`:** Lichess status, reason, check-in
  times (already rendered from `fixture_availability`), pre-filled resolve,
  resend email.

All strings in en/es/fr/nl; email interpolations HTML-escaped.

## 13. Failure matrix

| Case | Behaviour |
|---|---|
| Unlinked at enrollment | Block |
| Online play on, no clock / delay clock | Settings save refused |
| Match room before T−10 | "Opens at HH:MM"; check-in disabled |
| Non-player opens match room | 404 |
| One checked in, other not yet | "Waiting for opponent"; no challenge |
| Two mints at once | One claim wins; the other returns the stored view |
| Lichess create fails / times out | Stay `pending`, `last_error`; retried on next read/cron |
| Game started, cron slow | Stays `ready` until polled; never re-minted |
| One player no-show | `needs_organiser (no_show_*)`, pre-filled forfeit (§9) |
| Both checked in, never played | `needs_organiser (not_started)` |
| Clean finish | Auto `result` |
| Abort | `needs_organiser (aborted)` |
| Account mismatch | `needs_organiser (mismatch)` |
| Result already present | Ignore provider |
| Online play turned off mid-round | Guard refuses; no further check-in/mint/poll |
| Fixture rescheduled | Bridge reset; old check-ins ignored |
| Lichess outage mid-game | Stays `live` until poll recovers or organiser acts |
| Realtime drops | 15s re-read keeps the room current |

## 14. Testing

- **Unit:** clock mapping (Lichess wants seconds — pin against the boardgame
  schema's declared unit); window maths at T−10/T+20 boundaries; check-in
  validity vs reschedule; adapter request body (`users` order = White first,
  `expiresAt`, `rated=false`); PKCE parameters and verifier round-trip; lobby JWT
  carries `lobby_fixture_id` and not `fixture_id`; email escaping; no-show reason
  table enumerated row by row. Each guard mutated and killed.
- **DB usecase:** mint only after both check-ins; concurrent mint keeps one
  challenge; online play off refuses every entry point; `live` never re-mints;
  poll stamps skipped rows; result through the real score-event usecase; each
  §9 row; reschedule reset.
- **E2E walkthrough:** two signed-in players drive the real match room —
  check-in disabled before window, first check-in shows on the other screen,
  Play appears for both with their own colour, spectator public page shows no
  Play link; organiser sees the attention on the Fixture Console and resolves a
  no-show. Registered in `WALKTHROUGH_SPECS`.
- **Smoke:** cron sweep with a recorded Lichess payload.
- **Regression:** online play off — pairings + manual/pad result unchanged; QR
  venue check-in unchanged; division settings page renders and saves for a
  non-chess sport.
- **CI:** recorded Lichess payloads only; no live network.

## 15. Open follow-ups (not v1)

- Chess.com adapter
- Per-division window / deadline
- Rated games option; delay clock mapping
- Who clicked Play on Lichess when both checked in but the game never started
  (open-challenge `challenger` via challenge show) — would sharpen `not_started`
- Bulk pairing (`pairAt` / `startClocksAt`) for auto-started clocks — needs
  stored player tokens and `challenge:bulk`
- PGN attach via `core.note`

## 16. Success criteria

- A paired fixture in an online-Lichess division gets a playable Lichess game
  with no organiser action, playable only between T−10 and T+20, once both
  players have checked in.
- The only way to a Play link is the player's own match room.
- A decisive Lichess finish appears in standings without manual entry.
- A no-show is flagged to the organiser automatically, naming who did not show,
  within 5 minutes of the deadline, and never changes standings until confirmed.
- Turning online play off leaves today's chess behaviour intact.
